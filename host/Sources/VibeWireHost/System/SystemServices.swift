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
    ///
    /// `maxWidth` exists for the dashboard's hero panel, which asks once a
    /// second and draws the answer at about 900 px. Sending a 5120 px Studio
    /// Display PNG for that would be several megabytes a second of loopback
    /// traffic and a PNG encode per frame, to be scaled down by the browser
    /// anyway. Unset, the full display is returned — which is what the phone's
    /// SHOT wants, since that one is meant to be pinched into.
    func screenshot(display: CGDirectDisplayID, maxWidth: Int? = nil) -> Data? {
        guard let image = CGDisplayCreateImage(display) else {
            Log.warn(.app, "screenshot failed for display \(display)")
            return nil
        }
        guard let maxWidth, image.width > maxWidth else {
            return NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
        }

        let scale = Double(maxWidth) / Double(image.width)
        let width = maxWidth
        let height = max(1, Int((Double(image.height) * scale).rounded()))

        guard let context = CGContext(
            data: nil,
            width: width,
            height: height,
            bitsPerComponent: 8,
            bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(),
            bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
        ) else {
            return NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
        }
        context.interpolationQuality = .medium
        context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
        guard let scaled = context.makeImage() else { return nil }
        return NSBitmapImageRep(cgImage: scaled).representation(using: .png, properties: [:])
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
        /// The panels are off while the machine itself is running. A locked Mac
        /// is in this state within a second, and it is the state 02C's "Its
        /// display is off" card was written for.
        var displaysAsleep: Bool
    }

    private var sleepStartedAt: Date?

    /// `isAwake` is a claim about the picture, not about the CPU.
    ///
    /// It used to read `sleepStartedAt == nil`, which is only ever false while
    /// the whole machine is asleep — and a machine that is asleep is not
    /// answering a socket, so no connected phone could ever see it false. A
    /// locked Mac turns its displays off within a second, ScreenCaptureKit then
    /// reports no capturable displays, and the phone drew the one card that
    /// fits an empty display list: a Screen Recording permission diagnosis for
    /// a permission that was granted. The display being off is the fact, so the
    /// display being off is what this reports.
    func powerState() -> PowerState {
        let displaysAsleep = Self.displaysAreAsleep()
        return PowerState(
            isAwake: sleepStartedAt == nil && !displaysAsleep,
            isOnPower: Self.isOnACPower(),
            lidOpen: Self.isLidOpen(),
            asleepFor: sleepStartedAt.map { Date().timeIntervalSince($0) },
            displaysAsleep: displaysAsleep
        )
    }

    /// Whether the panels are dark while the displays are still attached.
    ///
    /// Measured as "online but not active", with the main display's own sleep
    /// flag as the fast path. `CGGetActiveDisplayList` drops to zero when the
    /// panels sleep and `CGGetOnlineDisplayList` does not, so the two together
    /// separate "the screen is off" from "the screen is gone".
    static func displaysAreAsleep() -> Bool {
        var online: UInt32 = 0
        var active: UInt32 = 0
        guard CGGetOnlineDisplayList(0, nil, &online) == .success,
              CGGetActiveDisplayList(0, nil, &active) == .success
        else { return false }
        guard online > 0 else { return false }
        return active == 0 || CGDisplayIsAsleep(CGMainDisplayID()) != 0
    }

    /// Turns the panels back on, without unlocking anything.
    ///
    /// `IOPMAssertionDeclareUserActivity` is the only thing measured to do it:
    /// posting a synthetic mouse move — which is what WAKE used to do — leaves
    /// a slept display asleep, so the phone's "Wake it" reported success and
    /// nothing came on. The lock screen stays up; this is a nudge to the
    /// backlight, not a login.
    @discardableResult
    func wakeDisplays() -> Bool {
        var assertion: IOPMAssertionID = 0
        let result = IOPMAssertionDeclareUserActivity(
            "VibeWire wake" as CFString,
            kIOPMUserActiveLocal,
            &assertion
        )
        Log.info(.app, "wake displays: \(result == kIOReturnSuccess ? "ok" : "failed (\(result))")")
        return result == kIOReturnSuccess
    }

    /// Waits for the window server to hand the panels back, so a caller can
    /// wake and then capture in one breath rather than racing the backlight.
    /// Returns whether a capturable display arrived before the deadline.
    func waitForDisplaysAwake(timeout: TimeInterval = 6) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if !Self.displaysAreAsleep() { return true }
            try? await Task.sleep(for: .milliseconds(250))
        }
        return !Self.displaysAreAsleep()
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
        // A closed lid with no external display means no *online* displays.
        // Active was the wrong list: it empties whenever the panels sleep, so a
        // locked laptop sitting open reported its lid shut.
        var online: UInt32 = 0
        guard CGGetOnlineDisplayList(0, nil, &online) == .success else { return true }
        return online > 0
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
