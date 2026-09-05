import Foundation
import ScreenCaptureKit
import CoreGraphics
import AppKit

/// One entry in the DISPLAYS list on 02A–02D and the MON 1 / MON 2 / BOTH
/// segmented control on 03A.
struct DisplayInfo: Sendable, Equatable {
    let id: CGDirectDisplayID
    let name: String
    let width: Int
    let height: Int
    let refreshHz: Int
    let isBuiltIn: Bool
    let isMain: Bool

    var wire: [String: Any] {
        [
            "id": Int(id),
            "name": name,
            "width": width,
            "height": height,
            "hz": refreshHz,
            "isBuiltIn": isBuiltIn,
            "isMain": isMain,
        ]
    }

    /// "Monitor 1 · built-in", "Monitor 2 · Studio"
    static func label(index: Int, isBuiltIn: Bool, modelName: String?) -> String {
        let suffix: String
        if isBuiltIn {
            suffix = "built-in"
        } else if let modelName, !modelName.isEmpty {
            suffix = modelName
        } else {
            suffix = "external"
        }
        return "Monitor \(index) · \(suffix)"
    }
}

/// Enumerates displays and tracks hot-plug. ScreenCaptureKit is the source of
/// truth for what is capturable; CoreGraphics fills in refresh rate and the
/// built-in flag, which SCDisplay does not expose.
actor DisplayCatalog {
    private(set) var displays: [DisplayInfo] = []
    private var lastRefresh: Date?
    /// Once per spell of sleep, not once per 2 s poll.
    private var warnedAsleep = false

    /// Refreshes at most every 2 s unless forced. The home screen polls this
    /// while visible and we do not want to hammer the window server.
    func refresh(force: Bool = false) async -> [DisplayInfo] {
        if !force, let lastRefresh, Date().timeIntervalSince(lastRefresh) < 2 {
            return displays
        }

        do {
            let content = try await SCShareableContent.excludingDesktopWindows(
                false, onScreenWindowsOnly: true
            )
            var result: [DisplayInfo] = []
            for (index, display) in content.displays.enumerated() {
                let id = display.displayID
                let isBuiltIn = CGDisplayIsBuiltin(id) != 0
                let mode = CGDisplayCopyDisplayMode(id)
                let hz = Int((mode?.refreshRate ?? 0).rounded())
                let screen = NSScreen.screens.first {
                    ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?
                        .uint32Value == id
                }
                result.append(DisplayInfo(
                    id: id,
                    name: DisplayInfo.label(
                        index: index + 1,
                        isBuiltIn: isBuiltIn,
                        modelName: screen?.localizedName
                    ),
                    width: display.width,
                    height: display.height,
                    // A 0 from CoreGraphics means "unknown", which in practice
                    // is a 60 Hz external panel.
                    refreshHz: hz > 0 ? hz : 60,
                    isBuiltIn: isBuiltIn,
                    isMain: CGDisplayIsMain(id) != 0
                ))
            }
            // An empty answer from ScreenCaptureKit means one of two very
            // different things, and overwriting the list conflated them. With
            // no display online it means the displays are gone, and an empty
            // list is the truth. With displays online but asleep — a locked
            // Mac, one second in — it means the panels are off, and wiping the
            // list is what put "the Mac reports no displays, check Screen
            // Recording permission" on the phone over a permission that was
            // granted. Hold what was last seen; `displaysAsleep` on the status
            // payload is what says the picture is off.
            if result.isEmpty, !displays.isEmpty, SystemServices.displaysAreAsleep() {
                if !warnedAsleep {
                    warnedAsleep = true
                    Log.info(.capture, "displays are asleep; holding the last known list")
                }
                lastRefresh = Date()
                return displays
            }
            warnedAsleep = false
            displays = result
            lastRefresh = Date()
        } catch {
            Log.warn(.capture, "display enumeration failed: \(error)")
        }
        return displays
    }

    func display(id: CGDirectDisplayID) -> DisplayInfo? {
        displays.first { $0.id == id }
    }

    func defaultDisplay() -> DisplayInfo? {
        displays.first(where: \.isMain) ?? displays.first
    }

    /// Screen-recording permission, checked without prompting. The menu bar
    /// uses this to explain why the picture is missing rather than showing a
    /// black rectangle.
    nonisolated static func hasScreenRecordingPermission() -> Bool {
        CGPreflightScreenCaptureAccess()
    }

    nonisolated static func requestScreenRecordingPermission() {
        CGRequestScreenCaptureAccess()
    }
}
