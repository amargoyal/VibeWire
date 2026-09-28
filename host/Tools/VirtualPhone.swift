// Stands in for the person holding the phone.
//
// Pairing is the one flow nothing here could check without a human: someone
// points a camera at the Mac, the phone opens the link in its browser, and the
// person at the Mac watches four steps tick. This does all three. It asks a host
// for a pairing code through the dashboard API, reads the browser QR out of the
// PNG the Mac draws with CoreImage's detector (a camera's job), opens what it
// read in WebKit (the engine behind Safari on the phone) with storage that
// persists between scans, and reads the Mac's step list and device list back.
//
// It then does what people do after the first scan: scans again, reloads, taps
// an old link from history, and scans after the Mac revoked the phone. Every
// check prints PASS or FAIL, and the exit status is the number that failed.
//
// Point it at a host you can afford to pair test devices with, never the one in
// daily use. `host/Tools/pairing-check.sh` starts a throwaway one and runs this.
//
//     swiftc -O host/Tools/VirtualPhone.swift -o /tmp/VirtualPhone
//     /tmp/VirtualPhone http://127.0.0.1:8899/dashboard/<key>/

import AppKit
import CoreImage
import WebKit

// MARK: - The Mac, through its dashboard API

struct Host {
    let origin: URL
    let key: String

    init?(dashboardURL: String) {
        guard let url = URL(string: dashboardURL),
              let scheme = url.scheme, let host = url.host,
              url.pathComponents.count >= 3, url.pathComponents[1] == "dashboard"
        else { return nil }
        let port = url.port.map { ":\($0)" } ?? ""
        guard let origin = URL(string: "\(scheme)://\(host)\(port)") else { return nil }
        self.origin = origin
        self.key = url.pathComponents[2]
    }

    private func request(_ path: String) -> URLRequest {
        var request = URLRequest(url: origin.appendingPathComponent(path))
        request.setValue(key, forHTTPHeaderField: "X-VibeWire-Dashboard")
        request.timeoutInterval = 10
        return request
    }

    func state() async throws -> [String: Any] {
        let (data, _) = try await URLSession.shared.data(for: request("v1/dashboard/state"))
        return (try JSONSerialization.jsonObject(with: data) as? [String: Any]) ?? [:]
    }

    func command(_ body: [String: Any]) async throws {
        var request = request("v1/dashboard/command")
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else {
            throw Failure("\(body["do"] ?? "command") refused: \(String(decoding: data, as: UTF8.self))")
        }
    }

    /// A pairing QR as the Mac draws it, and the payload the Mac says it holds.
    /// `kind` is `browser` or `app`, the two codes side by side on the Mac.
    func qr(_ kind: String) async throws -> (png: Data, payload: String?) {
        var components = URLComponents(
            url: origin.appendingPathComponent("v1/dashboard/qr"),
            resolvingAgainstBaseURL: false
        )!
        components.queryItems = [
            URLQueryItem(name: "kind", value: kind),
            URLQueryItem(name: "at", value: String(Date().timeIntervalSince1970)),
            URLQueryItem(name: "k", value: key),
        ]
        let (data, response) = try await URLSession.shared.data(from: components.url!)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw Failure("no QR: \(String(decoding: data, as: UTF8.self))")
        }
        return (data, http.value(forHTTPHeaderField: "X-VibeWire-Payload"))
    }
}

struct Failure: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

// MARK: - The camera

enum Camera {
    /// Reads a QR code out of an image the way the phone's camera app does.
    static func read(_ png: Data) -> String? {
        guard let image = CIImage(data: png),
              let detector = CIDetector(
                ofType: CIDetectorTypeQRCode,
                context: nil,
                options: [CIDetectorAccuracy: CIDetectorAccuracyHigh]
              )
        else { return nil }
        return detector.features(in: image)
            .compactMap { ($0 as? CIQRCodeFeature)?.messageString }
            .first
    }
}

// MARK: - The phone's browser

/// One tab. Tabs made with the same `store` share storage, as tabs in one
/// browser on one phone do, so a second scan finds what the first one saved.
@MainActor
final class Tab: NSObject, WKNavigationDelegate {
    let view: WKWebView
    private let window: NSWindow
    private var loaded: CheckedContinuation<Void, Error>?

    init(store: WKWebsiteDataStore) {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = store
        // Without this WebKit throttles a view nobody is looking at, and the page
        // would behave like a phone in a pocket rather than one in a hand.
        configuration.preferences.inactiveSchedulingPolicy = .none
        view = WKWebView(frame: NSRect(x: 0, y: 0, width: 390, height: 844), configuration: configuration)
        window = NSWindow(
            contentRect: NSRect(x: -4000, y: -4000, width: 390, height: 844),
            styleMask: [.borderless],
            backing: .buffered,
            defer: false
        )
        super.init()
        window.contentView = view
        window.orderBack(nil)
        view.navigationDelegate = self
    }

    func open(_ url: URL) async throws {
        try await withCheckedThrowingContinuation { continuation in
            loaded = continuation
            view.load(URLRequest(url: url))
        }
    }

    func reload() async throws {
        try await withCheckedThrowingContinuation { continuation in
            loaded = continuation
            view.reload()
        }
    }

    func text() async -> String {
        (try? await view.evaluateJavaScript("document.body ? document.body.innerText : ''") as? String) ?? ""
    }

    var address: String { view.url?.absoluteString ?? "" }

    func close() {
        view.navigationDelegate = nil
        view.loadHTMLString("", baseURL: nil)
        window.orderOut(nil)
    }

    nonisolated func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        MainActor.assumeIsolated { finish(nil) }
    }

    nonisolated func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        MainActor.assumeIsolated { finish(error) }
    }

    nonisolated func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        MainActor.assumeIsolated { finish(error) }
    }

    private func finish(_ error: Error?) {
        guard let loaded else { return }
        self.loaded = nil
        if let error { loaded.resume(throwing: error) } else { loaded.resume() }
    }
}

// MARK: - Checks

@MainActor
final class Run {
    let host: Host
    private(set) var failures = 0

    init(host: Host) { self.host = host }

    func check(_ passed: Bool, _ what: String, _ detail: @autoclosure () -> String = "") {
        if passed {
            print("  PASS  \(what)")
        } else {
            failures += 1
            let extra = detail()
            print("  FAIL  \(what)\(extra.isEmpty ? "" : " (\(extra))")")
        }
    }

    /// Polls until `condition` holds or `seconds` pass.
    func eventually(_ seconds: Double, _ condition: () async -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if await condition() { return true }
            try? await Task.sleep(nanoseconds: 250_000_000)
        }
        return await condition()
    }

    func pairing() async -> [String: Any] {
        ((try? await host.state())?["pairing"] as? [String: Any]) ?? [:]
    }

    func devices() async -> [[String: Any]] {
        ((try? await host.state())?["devices"] as? [[String: Any]]) ?? []
    }

    func isConnected(_ id: String) async -> Bool {
        await devices().contains { $0["id"] as? String == id && $0["connected"] as? Bool == true }
    }

    /// Opens a pairing window, reads its QR like a camera would, and returns
    /// what the phone would open.
    func scan(_ kind: String = "browser") async throws -> URL {
        try await host.command(["do": "pair.end"])
        try await host.command(["do": "pair.begin", "reusable": false])
        let qr = try await host.qr(kind)
        guard let read = Camera.read(qr.png) else { throw Failure("the camera could not read the QR") }
        check(read == qr.payload, "the camera reads what the Mac says it drew", "read \(read)")
        guard let url = URL(string: read) else { throw Failure("the QR is not a URL: \(read)") }
        return url
    }

    /// Waits for the Mac's step list to reach its last step and returns the
    /// device it names.
    func handshake(_ what: String, on tab: Tab) async -> String? {
        let reached = await eventually(20) { (await pairing()["step"] as? Int ?? 0) >= 4 }
        let state = await pairing()
        check(reached, "\(what): the Mac ticks all four steps", "stopped at \(state["step"] ?? 0)")
        if !reached {
            // What the person holding the phone would be looking at.
            let text = await tab.text().split(whereSeparator: \.isNewline).prefix(12).joined(separator: " | ")
            print("        phone at \(tab.address)")
            print("        phone shows: \(text.isEmpty ? "nothing" : text)")
        }
        return state["deviceId"] as? String
    }

    static let failureWords = [
        "did not match", "not showing a code", "rotated", "Pair again",
        "no longer recognises", "Too many tries",
    ]

    func shownFailure(_ tab: Tab) async -> String? {
        let text = await tab.text()
        return Self.failureWords.first { text.contains($0) }
    }
}

@MainActor
func main(dashboard: String) async -> Int32 {
    guard let host = Host(dashboardURL: dashboard) else {
        print("usage: VirtualPhone http://127.0.0.1:<port>/dashboard/<key>/")
        return 64
    }
    let run = Run(host: host)
    let phone = WKWebsiteDataStore(forIdentifier: UUID())
    let other = WKWebsiteDataStore(forIdentifier: UUID())

    do {
        let before = await run.devices().count

        print("first scan")
        let firstURL = try await run.scan()
        let first = Tab(store: phone)
        try await first.open(firstURL)
        guard let deviceId = await run.handshake("first scan", on: first) else {
            print("  the first pairing never finished; nothing after it would mean anything")
            return Int32(run.failures + 1)
        }
        run.check(!first.address.contains("code="), "the code is gone from the address bar", first.address)
        run.check(await run.eventually(10) { await run.isConnected(deviceId) }, "the phone is connected")
        run.check(await run.devices().count == before + 1, "the Mac lists one new device")
        first.close()

        print("second scan, same phone")
        let secondURL = try await run.scan()
        let second = Tab(store: phone)
        try await second.open(secondURL)
        let again = await run.handshake("second scan", on: second)
        run.check(again == deviceId, "the Mac keeps the same device", "was \(deviceId), now \(again ?? "none")")
        let rows = await run.devices().count - before
        run.check(rows == 1, "the Mac still lists one device for this phone", "\(rows) rows")
        run.check(await run.eventually(10) { await run.isConnected(deviceId) }, "the phone is connected")
        try await host.command(["do": "pair.end"])

        print("reload")
        try await second.reload()
        try? await Task.sleep(nanoseconds: 3_000_000_000)
        let reloadFailure = await run.shownFailure(second)
        run.check(reloadFailure == nil, "a reload shows no pairing failure", reloadFailure ?? "")
        run.check((await run.pairing()["step"] as? Int ?? 0) == 0, "a reload sends the Mac nothing to pair")
        run.check(await run.eventually(10) { await run.isConnected(deviceId) }, "the phone is connected")
        second.close()

        print("old link from history")
        let stale = Tab(store: phone)
        try await stale.open(secondURL)
        try? await Task.sleep(nanoseconds: 2_000_000_000)
        run.check((await run.pairing()["step"] as? Int ?? 0) == 0, "the Mac pairs nothing from an old code")
        run.check(await run.eventually(10) { await run.isConnected(deviceId) },
                  "the phone falls back to its pairing and connects")
        run.check(await run.devices().count == before + 1, "the Mac still lists one device for this phone")
        stale.close()

        print("scan after the Mac revoked this phone")
        try await host.command(["do": "device.revoke", "deviceId": deviceId])
        run.check(await run.eventually(5) { await run.devices().count == before }, "the Mac forgets the phone")
        let revokedURL = try await run.scan()
        let revoked = Tab(store: phone)
        try await revoked.open(revokedURL)
        let fresh = await run.handshake("scan after revoke", on: revoked)
        let revokedFailure = await run.shownFailure(revoked)
        run.check(revokedFailure == nil, "the page shows no failure", revokedFailure ?? "")
        run.check(await run.devices().count == before + 1, "the Mac lists the phone once")
        if let fresh {
            run.check(await run.eventually(10) { await run.isConnected(fresh) }, "the phone is connected")
        }
        revoked.close()

        print("a different phone")
        let otherURL = try await run.scan()
        let otherTab = Tab(store: other)
        try await otherTab.open(otherURL)
        let otherDevice = await run.handshake("a different phone", on: otherTab)
        run.check(otherDevice != nil && otherDevice != fresh, "the Mac gives it its own device")
        run.check(await run.devices().count == before + 2, "the Mac lists both phones")
        otherTab.close()

        try await host.command(["do": "pair.end"])
    } catch {
        print("  FAIL  \(error)")
        return Int32(run.failures + 1)
    }

    print(run.failures == 0 ? "all passed" : "\(run.failures) failed")
    return Int32(run.failures)
}

let arguments = CommandLine.arguments
NSApplication.shared.setActivationPolicy(.prohibited)
Task { @MainActor in
    let status = await main(dashboard: arguments.count > 1 ? arguments[1] : "")
    // Every phone this run made, and any an interrupted run left behind: the
    // stores belong to this tool, and a key left in one would still be trusted
    // by the host it paired with. The pause lets the closed tabs let go of
    // theirs, since a store still in use is not removed.
    try? await Task.sleep(nanoseconds: 1_000_000_000)
    for identifier in await WKWebsiteDataStore.allDataStoreIdentifiers {
        try? await WKWebsiteDataStore.remove(forIdentifier: identifier)
    }
    exit(status)
}
NSApplication.shared.run()
