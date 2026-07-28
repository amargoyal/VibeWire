import Foundation
import AppKit
import CoreGraphics
import IOKit
import IOKit.ps
import IOKit.pwr_mgt

/// Clipboard, screenshot, lock, sleep state, frontmost app. Everything the hub
/// on 04A and the status cards on 02A–02D need from the Mac itself.
final class SystemServices: @unchecked Sendable {
    private var lastClipboardChangeCount = NSPasteboard.general.changeCount

    // MARK: Clipboard

    /// COPY ← MAC on the hub arc.
    func readClipboard() -> String? {
        NSPasteboard.general.string(forType: .string)
    }

    /// PASTE → MAC. Writing to the pasteboard is not enough on its own; the
    /// hub's paste action follows it with ⌘V via the injector.
    func writeClipboard(_ text: String) {
        let pasteboard = NSPasteboard.general
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)
        lastClipboardChangeCount = pasteboard.changeCount
    }

    /// Polled so the phone can mirror a copy the user made on the Mac.
    func clipboardChangedSinceLastCheck() -> String? {
        let pasteboard = NSPasteboard.general
        guard pasteboard.changeCount != lastClipboardChangeCount else { return nil }
        lastClipboardChangeCount = pasteboard.changeCount
        return pasteboard.string(forType: .string)
    }

    // MARK: Screenshot

    /// SHOT on the hub arc. Returns PNG bytes for the selected display.
    func screenshot(display: CGDirectDisplayID) -> Data? {
        guard let image = CGDisplayCreateImage(display) else {
            Log.warn(.app, "screenshot failed for display \(display)")
            return nil
        }
        let bitmap = NSBitmapImageRep(cgImage: image)
        return bitmap.representation(using: .png, properties: [:])
    }

    // MARK: Lock

    /// LOCK on the hub arc. Uses the same private entry point the keyboard
    /// shortcut drives; falls back to the screen saver if it is unavailable.
    func lockScreen() {
        let handle = dlopen(
            "/System/Library/PrivateFrameworks/login.framework/Versions/Current/login",
            RTLD_NOW
        )
        defer { if let handle { dlclose(handle) } }

        if let handle, let symbol = dlsym(handle, "SACLockScreenImmediate") {
            typealias LockFunction = @convention(c) () -> Int32
            let lock = unsafeBitCast(symbol, to: LockFunction.self)
            _ = lock()
            Log.info(.app, "screen locked")
            return
        }

        // Fallback that works everywhere, just less immediately.
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        task.arguments = ["-a", "ScreenSaverEngine"]
        try? task.run()
        Log.info(.app, "screen saver started (lock fallback)")
    }

    // MARK: Power state

    struct PowerState: Sendable {
        var isAwake: Bool
        var isOnPower: Bool
        var lidOpen: Bool
        var asleepFor: TimeInterval?
    }

    private var sleepStartedAt: Date?

    func powerState() -> PowerState {
        PowerState(
            isAwake: sleepStartedAt == nil,
            isOnPower: Self.isOnACPower(),
            lidOpen: Self.isLidOpen(),
            asleepFor: sleepStartedAt.map { Date().timeIntervalSince($0) }
        )
    }

    func noteWillSleep() { sleepStartedAt = Date() }
    func noteDidWake() { sleepStartedAt = nil }

    private static func isOnACPower() -> Bool {
        guard let blob = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let sources = IOPSCopyPowerSourcesList(blob)?.takeRetainedValue() as? [CFTypeRef]
        else { return true }

        for source in sources {
            guard let description = IOPSGetPowerSourceDescription(blob, source)?
                .takeUnretainedValue() as? [String: Any] else { continue }
            if let state = description[kIOPSPowerSourceStateKey] as? String {
                return state == kIOPSACPowerValue
            }
        }
        // No battery at all means a desktop, which is always on power.
        return true
    }

    private static func isLidOpen() -> Bool {
        // A closed lid with no external display means no active displays.
        CGGetActiveDisplayList(0, nil, nil) == .success && CGDisplayIsActive(CGMainDisplayID()) != 0
    }

    /// 02C says wake fails on battery. Rather than promise and disappoint, the
    /// host reports whether the preconditions hold before the phone offers it.
    func canWakeOverNetwork() -> Bool {
        Self.isOnACPower()
    }

    // MARK: Keep-awake

    private var sleepAssertion: IOPMAssertionID = 0

    /// Held while a session is live, so the Mac does not doze mid-stream. It is
    /// released on disconnect: the design's promise is "nothing is left running
    /// on the Mac" after the session closes.
    func preventSleep(_ prevent: Bool) {
        if prevent {
            guard sleepAssertion == 0 else { return }
            var assertion: IOPMAssertionID = 0
            let result = IOPMAssertionCreateWithName(
                kIOPMAssertionTypeNoDisplaySleep as CFString,
                IOPMAssertionLevel(kIOPMAssertionLevelOn),
                "VibeWire session active" as CFString,
                &assertion
            )
            if result == kIOReturnSuccess {
                sleepAssertion = assertion
                Log.debug(.app, "sleep assertion held")
            }
        } else {
            guard sleepAssertion != 0 else { return }
            IOPMAssertionRelease(sleepAssertion)
            sleepAssertion = 0
            Log.debug(.app, "sleep assertion released")
        }
    }

    // MARK: Frontmost app

    /// Feeds the "TYPING INTO · Terminal — zsh" banner on screen 05. Typing
    /// blind into the wrong window is the expensive mistake there.
    func frontmostApplication() -> (name: String, bundleId: String?) {
        guard let app = NSWorkspace.shared.frontmostApplication else {
            return ("Unknown", nil)
        }
        return (app.localizedName ?? "Unknown", app.bundleIdentifier)
    }
}
