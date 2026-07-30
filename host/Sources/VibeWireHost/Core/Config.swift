import Foundation

/// Host configuration. Reads `~/.config/vibewire/config.json` if present,
/// otherwise uses defaults. Settings changed from the phone (07A) are written
/// back here so they survive a restart.
struct HostSettings: Codable, Sendable {
    /// `auto` lets the encoder pick from the ladder based on measured link.
    enum QualityLadder: String, Codable, Sendable {
        case auto, p1080 = "1080", p720 = "720", p540 = "540"

        var maxHeight: Int? {
            switch self {
            case .auto: return nil
            case .p1080: return 1080
            case .p720: return 720
            case .p540: return 540
            }
        }
    }

    var quality: QualityLadder = .auto
    /// 07A "Cap on cellular · CEILING 3 MB/S"
    var capOnCellular: Bool = true
    var cellularCeilingMbps: Double = 3.0
    /// 07A trackpad, 8 discrete ticks so a thumb can hit one.
    var sensitivity: Int = 5
    var naturalScrolling: Bool = true
    /// 07A "Face ID each session · ADDS ~0.4S TO OPEN"
    var requireBiometricEachSession: Bool = true
    /// 07A "Relay over internet". Off means Tailscale only, and the host will
    /// not start cloudflared.
    var relayOverInternet: Bool = false
    var targetFps: Int = 60
    var port: UInt16 = 8787

    /// Where the public copy of the web client lives, e.g.
    /// `https://you.github.io/VibeWire`.
    ///
    /// Only affects the BROWSER QR in the pairing window. Set, the QR sends a phone
    /// to that page carrying this Mac's address; unset, it sends the phone to the
    /// copy this host serves itself, which is the same build at a different address.
    ///
    /// Unset by default, and the default is the better one for daily use: a
    /// host-served page is same-origin with the protocol, so it needs no address at
    /// all and cannot go stale. Pointing at the public site is for when the address
    /// bar matters — showing someone the thing, or a bookmark you want to keep.
    var webClientURL: String?

    static let `default` = HostSettings()
}

enum Config {
    /// Read once at launch. Never mutated, so it needs no isolation.
    static let verbose: Bool = ProcessInfo.processInfo.environment["VIBEWIRE_VERBOSE"] == "1"

    static let hostVersion = "0.9.4"

    /// Bumped when the wire protocol changes incompatibly. The phone refuses to
    /// connect on mismatch rather than half-working.
    static let protocolVersion = 1

    static let keychainService = "com.vibewire.host.trust"
    static let pairingCodeLifetime: TimeInterval = 60
    static let nonceLifetime: TimeInterval = 30
    static let maxPairAttempts = 5
    static let pairLockout: TimeInterval = 60

    static var configDirectory: URL {
        let base = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config", isDirectory: true)
            .appendingPathComponent("vibewire", isDirectory: true)
        try? FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        return base
    }

    static var settingsURL: URL {
        configDirectory.appendingPathComponent("config.json")
    }

    /// The public web client to send a scanned QR to, or nil to use the copy this
    /// host serves. `VIBEWIRE_WEB_CLIENT` wins over the stored setting, so it can be
    /// tried for one launch without editing anything.
    static var webClientURL: String? {
        if let override = ProcessInfo.processInfo.environment["VIBEWIRE_WEB_CLIENT"],
           !override.isEmpty {
            return override
        }
        guard let stored = loadSettings().webClientURL, !stored.isEmpty else { return nil }
        return stored
    }

    /// Where the built web client lives, or nil if it was never built.
    ///
    /// Three places, in order of how deliberate they are:
    ///
    ///  1. `VIBEWIRE_WEB_ROOT`, for anyone who wants to point the host at a bundle
    ///     somewhere else entirely.
    ///  2. `~/.config/vibewire/web`, which is where `web/deploy-to-host.sh` copies a
    ///     release build. This is the one an installed host uses.
    ///  3. `<repo>/web/dist`, found by walking up from this file's own compile-time
    ///     path. Only ever true for a host built from the checkout, which is exactly
    ///     when it is wanted: `npm run build` in `web/` and the running host serves
    ///     the new client with no copy step.
    static var webRoot: URL? {
        let manager = FileManager.default

        if let override = ProcessInfo.processInfo.environment["VIBEWIRE_WEB_ROOT"], !override.isEmpty {
            return URL(fileURLWithPath: (override as NSString).expandingTildeInPath, isDirectory: true)
        }

        let installed = configDirectory.appendingPathComponent("web", isDirectory: true)
        if manager.fileExists(atPath: installed.appendingPathComponent("index.html").path) {
            return installed
        }

        // .../host/Sources/VibeWireHost/Core/Config.swift → .../web/dist
        let checkout = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()   // Core/
            .deletingLastPathComponent()   // VibeWireHost/
            .deletingLastPathComponent()   // Sources/
            .deletingLastPathComponent()   // host/
            .deletingLastPathComponent()   // the checkout root
            .appendingPathComponent("web/dist", isDirectory: true)
        if manager.fileExists(atPath: checkout.appendingPathComponent("index.html").path) {
            return checkout
        }

        return nil
    }

    static func loadSettings() -> HostSettings {
        guard let data = try? Data(contentsOf: settingsURL),
              let decoded = try? JSONDecoder().decode(HostSettings.self, from: data)
        else { return .default }
        return decoded
    }

    static func saveSettings(_ settings: HostSettings) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(settings) else { return }
        try? data.write(to: settingsURL, options: .atomic)
    }

    /// Human name for this Mac, e.g. "MacBook Pro 14"".
    static var machineName: String {
        if let name = Host.current().localizedName, !name.isEmpty { return name }
        return "Mac"
    }

    static var machineModel: String {
        var size = 0
        sysctlbyname("hw.model", nil, &size, nil, 0)
        guard size > 0 else { return "Mac" }
        var bytes = [CChar](repeating: 0, count: size)
        sysctlbyname("hw.model", &bytes, &size, nil, 0)
        return String(cString: bytes)
    }

    static var osVersion: String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "\(v.majorVersion).\(v.minorVersion)"
    }
}
