import AppKit
import WebKit

/// The Mac app's one window.
///
/// VibeWire used to have two Mac surfaces: a status item, and an AppKit pairing
/// window that existed only to hand over six digits and two QRs. Everything else
/// the host knew — which displays were streaming, what the link measured, which
/// devices were trusted, what the log said — was reachable only from the phone,
/// which is a strange place to have to stand to look at the Mac in front of you.
///
/// This is that window, generalised: the same pairing code, in the same house as
/// the readouts it belongs beside, plus a revoke that does not require finding
/// the phone first. The status item stays, because this is still an agent and
/// the menu is still the fastest way to check whether the Mac is serving.
///
/// The content is the built dashboard bundle, drawn by WebKit. Two reasons, and
/// the second is the load-bearing one: the design was drawn as HTML, and the
/// panes it draws are the same panes the web client already draws for the phone,
/// out of the same design system. A second, native implementation of them would
/// be a second thing to keep in agreement with `nightshift.css` — and the last
/// time this project had two implementations of one palette, they drifted.
@MainActor
final class DashboardWindow: NSObject, NSWindowDelegate, WKNavigationDelegate {
    private var window: NSWindow?
    private var webView: WKWebView?
    private let port: UInt16
    /// Where the bundle failed, if it did. Held so a reopen can report the same
    /// thing rather than showing a blank window.
    private var lastFailure: String?

    init(port: UInt16) {
        self.port = port
        super.init()
    }

    /// The URL the window loads. The launch key is a path segment, so the whole
    /// surface — document and assets — is behind it rather than just the API.
    ///
    /// The trailing slash matters. The bundle's asset references are relative,
    /// so without it they resolve one directory up and lose the key. The host
    /// redirects the slashless form for anyone who types it, but this is the
    /// address the window actually opens and it is spelled correctly here.
    private var url: URL? {
        URL(string: "http://127.0.0.1:\(port)/dashboard/\(Config.dashboardKey)/")
    }

    // MARK: Presenting

    /// Brings the window up, optionally on a named pane.
    ///
    /// `pane` is one of the seven the dashboard draws, or `pair` for the pairing
    /// sheet. It is delivered as a fragment on first load and as a call
    /// afterwards, because a reload to change panes would throw away the poll
    /// cursor and the Claude transcript along with it.
    func show(pane: String? = nil) {
        let created = ensureWindow()
        if let pane {
            if created {
                // Nothing has loaded yet; the fragment is read on start-up.
                if let url, let target = URL(string: url.absoluteString + "#" + pane) {
                    webView?.load(URLRequest(url: target))
                }
            } else {
                webView?.evaluateJavaScript(
                    "window.vibewireShowPane && window.vibewireShowPane(\(Self.jsString(pane)))"
                )
            }
        }
        window?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    /// True when the window was built by this call.
    @discardableResult
    private func ensureWindow() -> Bool {
        if window != nil { return false }

        let configuration = WKWebViewConfiguration()
        // The dashboard is served over plain HTTP from this very process, so
        // there is no persistent store worth keeping and nothing to remember
        // between launches: the key changes every launch anyway.
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true

        let webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        // The page draws its own ground; a white flash between launch and first
        // paint is the one moment this app looks like a browser.
        webView.setValue(false, forKey: "drawsBackground")
        webView.allowsBackForwardNavigationGestures = false
        if #available(macOS 13.3, *) {
            webView.isInspectable = ProcessInfo.processInfo.environment["VIBEWIRE_VERBOSE"] == "1"
        }

        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1360, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "VibeWire"
        // The design's own header runs the full width of the window with the
        // traffic lights sitting in it, which is what `fullSizeContentView` plus
        // a transparent, title-less bar gives. The page leaves 78pt clear on the
        // left for them — see the header's padding in the bundle.
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isReleasedWhenClosed = false
        window.appearance = NSAppearance(named: .darkAqua)
        window.backgroundColor = Palette.screen
        window.minSize = NSSize(width: 1040, height: 680)
        window.delegate = self
        window.contentView = webView
        window.setFrameAutosaveName("VibeWireDashboard")
        window.center()

        self.window = window
        self.webView = webView

        if let url {
            webView.load(URLRequest(url: url))
        }
        return true
    }

    /// Closing the window leaves the agent running, which is the whole point of
    /// a menu bar app. The window is kept rather than torn down so reopening it
    /// is instant and the pane you were on is still the pane you are on.
    func windowShouldClose(_ sender: NSWindow) -> Bool { true }

    // MARK: Load failures

    /// A window that cannot reach its own host must say which of the two broke.
    ///
    /// The bundle being absent is answered by the host itself with a page that
    /// explains it — see `DashboardService.noBundlePage`. What lands here is the
    /// other case: the listener is not answering on loopback, which means the
    /// host is not serving and every pane would have been a lie anyway.
    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        lastFailure = error.localizedDescription
        Log.error(.app, "dashboard could not load: \(error.localizedDescription)")
        webView.loadHTMLString(Self.unreachablePage(port: port, detail: error.localizedDescription),
                              baseURL: nil)
    }

    private static func unreachablePage(port: UInt16, detail: String) -> String {
        """
        <!doctype html><meta charset="utf-8"><title>VibeWire</title>
        <style>
          body { margin:0; display:grid; place-items:center; min-height:100vh;
                 background:#0F1114; color:#F2F3F6;
                 font:15px/1.5 -apple-system, system-ui, sans-serif }
          div { max-width:34rem; padding:2rem }
          p { color:#A5A9B1 } code { color:#F7C15F; font:13px ui-monospace, Menlo, monospace }
        </style>
        <div>
          <h1>No answer on 127.0.0.1:\(port)</h1>
          <p>The window loaded, but the host is not answering on its own port. That is the
          host, not this window &mdash; every reading here would have come from it.</p>
          <p><code>\(detail.replacingOccurrences(of: "<", with: "&lt;"))</code></p>
        </div>
        """
    }

    /// JavaScript string literal, quoted and escaped. The pane names are ours
    /// and contain nothing interesting, but building JS by concatenation is a
    /// habit worth not having.
    private static func jsString(_ value: String) -> String {
        let data = (try? JSONSerialization.data(withJSONObject: [value]))
            .flatMap { String(data: $0, encoding: .utf8) }
        guard let data, data.count > 2 else { return "\"\"" }
        return String(data.dropFirst().dropLast())
    }
}
