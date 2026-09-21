import AppKit
import Foundation

/// Whether macOS would let a phone reach this host at all.
///
/// The application firewall is off on most Macs and decisive on the ones where
/// it is on: the host listens, the QR carries a correct address, the phone
/// opens it, and nothing answers. From the phone that is indistinguishable
/// from a Mac that is asleep, and from the Mac it is invisible, so it is read
/// here and said out loud in the pairing window. The Windows host has reported
/// its own firewall as a condition since it shipped; this is the same fact on
/// the other platform.
///
/// Read only. Changing the firewall needs an administrator, and an app that
/// asks for one to open a port is an app nobody should trust; the window says
/// which setting to open instead.
enum FirewallStatus {
    struct Verdict: Sendable, Equatable {
        /// False when `socketfilterfw` could not be asked. Nothing is claimed
        /// in that case: "unknown" and "fine" are different answers.
        var known = false
        var enabled = false
        /// The firewall is on *and* it would refuse this host's incoming
        /// connections.
        var blocksIncoming = false
        /// One sentence naming what to change, or nil when there is nothing
        /// to change.
        var detail: String?
    }

    private static let tool = "/usr/libexec/ApplicationFirewall/socketfilterfw"

    /// Asks the firewall about this app. Three short calls, each with its own
    /// timeout, and the second and third are skipped when the first says the
    /// firewall is off.
    static func read(appPath: String) async -> Verdict {
        guard let global = await Shell.captureText(tool, ["--getglobalstate"], timeout: 2) else {
            return Verdict()
        }
        // "Firewall is enabled. (State = 1)" / "(State = 2)" for block-all.
        let enabled = !global.contains("State = 0")
        guard enabled else { return Verdict(known: true, enabled: false) }

        if let blockAll = await Shell.captureText(tool, ["--getblockall"], timeout: 2),
           blockAll.contains("set to enabled") {
            return Verdict(
                known: true,
                enabled: true,
                blocksIncoming: true,
                detail: "macOS Firewall is set to block all incoming connections, "
                    + "so nothing on your network can reach this Mac. "
                    + "System Settings, Network, Firewall, Options."
            )
        }

        guard let app = await Shell.captureText(
            tool, ["--getappblocked", appPath], timeout: 2
        ) else {
            return Verdict(known: true, enabled: true)
        }

        guard app.contains("is blocked") else {
            return Verdict(known: true, enabled: true)
        }
        return Verdict(
            known: true,
            enabled: true,
            blocksIncoming: true,
            detail: "macOS Firewall is blocking incoming connections to VibeWire, "
                + "so your phone cannot reach it on this network. "
                + "System Settings, Network, Firewall, Options, and allow VibeWire."
        )
    }

    /// Opens the pane that holds the switch. macOS 13 and later answer this
    /// URL with System Settings, Network, Firewall.
    static func openSettings() {
        guard let url = URL(
            string: "x-apple.systempreferences:com.apple.preference.security?Firewall"
        ) else { return }
        NSWorkspace.shared.open(url)
    }

    /// The path to ask about: the bundle when there is one, since that is what
    /// the firewall lists, and the executable when the host is run from a
    /// build directory.
    static var appPath: String {
        let bundle = Bundle.main.bundlePath
        return bundle.hasSuffix(".app") ? bundle : CommandLine.arguments.first ?? bundle
    }
}
