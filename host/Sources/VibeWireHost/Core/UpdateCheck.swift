import AppKit
import Foundation

/// Whether a newer VibeWire has been published, asked of GitHub.
///
/// An app that people install by dragging it out of a disk image has no other
/// way of telling them a fix exists: the copy in Applications is the copy they
/// keep, and the release that fixes the thing they hit sits on a page they
/// have no reason to visit. So the host asks once at launch and every six
/// hours after, and the window says so.
///
/// It does not install anything. This build is signed with a development
/// certificate and is not notarized, so a downloader that replaced the
/// application with whatever it fetched would be asking for trust that nothing
/// here can check. The prompt opens the release page and the reader drags the
/// new copy over the old one, which is the same act they already performed
/// once and the one macOS is able to verify.
actor UpdateCheck {
    struct Verdict: Sendable, Equatable {
        var current: String
        var latest: String?
        var url: String?
        var available: Bool = false
        var checkedAt: Date?
        /// Why the last check did not produce an answer, or nil.
        var problem: String?
        var enabled: Bool = true

        var wire: [String: Any] {
            var payload: [String: Any] = [
                "current": current,
                "available": available,
                "enabled": enabled,
            ]
            payload["latest"] = latest
            payload["url"] = url
            payload["problem"] = problem
            payload["checkedAt"] = checkedAt.map(ISO8601DateFormatter().string(from:))
            return payload
        }
    }

    static let shared = UpdateCheck()

    /// The repository releases are published from, and the page the prompt
    /// opens when there is no release URL to open.
    static let repository = "amargoyal/VibeWire"
    static var releasesPage: String { "https://github.com/\(Self.repository)/releases/latest" }

    private var cached = Verdict(current: Config.hostVersion)
    private var checking = false

    func verdict() -> Verdict { cached }

    /// Asks GitHub unless it was asked in the last six hours, or unless the
    /// reader turned the check off.
    func refreshIfStale(after interval: TimeInterval = 6 * 3600) async {
        guard Config.loadSettings().checkForUpdates else {
            cached = Verdict(current: Config.hostVersion, enabled: false)
            return
        }
        cached.enabled = true
        if let checkedAt = cached.checkedAt, Date().timeIntervalSince(checkedAt) < interval {
            return
        }
        await refresh()
    }

    func refresh() async {
        guard !checking else { return }
        checking = true
        defer { checking = false }

        guard let url = URL(
            string: "https://api.github.com/repos/\(Self.repository)/releases/latest"
        ) else { return }

        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("VibeWire/\(Config.hostVersion)", forHTTPHeaderField: "User-Agent")
        request.cachePolicy = .reloadIgnoringLocalCacheData

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                throw Failure.status((response as? HTTPURLResponse)?.statusCode ?? 0)
            }
            guard let body = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let tag = body["tag_name"] as? String
            else { throw Failure.malformed }

            let latest = tag.hasPrefix("v") ? String(tag.dropFirst()) : tag
            let page = body["html_url"] as? String ?? Self.releasesPage
            cached = Verdict(
                current: Config.hostVersion,
                latest: latest,
                url: page,
                available: Self.isNewer(latest, than: Config.hostVersion),
                checkedAt: Date(),
                problem: nil,
                enabled: true
            )
            if cached.available {
                Log.info(.app, "update available: \(latest) (running \(Config.hostVersion))")
            }
        } catch {
            // A failed check is not a condition worth shouting about: no
            // network, a rate limit, or a repository with no releases yet all
            // land here, and none of them are the reader's problem.
            cached.checkedAt = Date()
            cached.problem = error.localizedDescription
        }
    }

    private enum Failure: Error, LocalizedError {
        case status(Int)
        case malformed

        var errorDescription: String? {
            switch self {
            case .status(let code): return "GitHub answered \(code)."
            case .malformed: return "GitHub's answer had no release in it."
            }
        }
    }

    /// Numeric, part by part, with anything after a dash ignored: `0.13.0`
    /// beats `0.12.0`, `0.12.1` beats `0.12.0`, and `0.12.0-rc1` is not newer
    /// than `0.12.0`.
    static func isNewer(_ candidate: String, than current: String) -> Bool {
        func parts(_ version: String) -> [Int] {
            version
                .split(separator: "-", maxSplits: 1)[0]
                .split(separator: ".")
                .map { Int($0) ?? 0 }
        }
        let left = parts(candidate)
        let right = parts(current)
        for index in 0..<max(left.count, right.count) {
            let a = index < left.count ? left[index] : 0
            let b = index < right.count ? right[index] : 0
            if a != b { return a > b }
        }
        return false
    }

    /// Opens the release page. Downloading and replacing the app is the
    /// reader's act, deliberately.
    @MainActor
    static func openReleasePage(_ url: String?) {
        guard let target = URL(string: url ?? releasesPage) else { return }
        NSWorkspace.shared.open(target)
    }
}
