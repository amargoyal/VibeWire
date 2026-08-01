import AppKit

/// The panel the status item opens.
///
/// This used to be an `NSMenu`, and an `NSMenu` can only ever be a list of
/// titles in the system's own dress. Everything the host actually measures — the
/// link it is holding, the phone on the other end, how long it has been up — had
/// to be either flattened into a greyed-out row or left out entirely, and what
/// was left was a menu whose most eye-catching item was "Quit".
///
/// So it is a window now: a borderless panel under the status item, drawn in the
/// app's own colours from the same Nightshift palette as the pairing window. That
/// is the second and last place this app departs from "follow the platform", and
/// it earns it the same way the first one does — the readings are the reason to
/// open it, and readings want a surface that can draw a bar and a sparkline, not
/// a list of strings.
///
/// Being drawn rather than described also settles a contrast problem the menu
/// header had to work around. The palette is defined against grounds this app
/// paints, the system's menu material was not one of them, and the old header
/// had to put every reading inside a filled chip so the ink landed on something
/// measured. This panel paints its own ground, in Dark regardless of the system
/// appearance, so the palette's numbers hold everywhere by construction.
@MainActor
final class StatusPanel: NSObject, NSWindowDelegate {
    /// What the panel draws. Gathered by the controller — everything here is
    /// either a live in-process probe or a value it already had cached, because
    /// a panel that awaited an actor on the way up would open blank.
    struct Readings {
        var machine: String
        var serving: Bool
        var screenRecording: Bool
        var accessibility: Bool
        var clientAttached: Bool
        var attachedName: String?
        var attachedSince: Date?
        var streams: Int
        var path: String
        var rttMillis: Double?
        var rttHistory: [Double]
        var outMbps: Double
        /// The ceiling the throughput bar is drawn against, or nil when this
        /// host agreed to none. Off the cellular cap there is no number anybody
        /// set, and a bar against one would be a picture of nothing.
        var ceilingMbps: Double?
        var pairedCount: Int?
        var uptime: TimeInterval

        var degraded: Bool { !screenRecording || !accessibility }
    }

    /// What a row asked for. The controller owns every one of these; the panel
    /// draws and forwards, and knows nothing about pairing or the dashboard.
    enum Action {
        case openDashboard
        case openPane(String)
        case pair
        case grantScreenRecording
        case grantAccessibility
        case quit
    }

    var onAction: ((Action) -> Void)?
    /// Fired however the panel went away — a row, ⌘Q, Escape, or a click on
    /// another app. The status item stays lit while this is up, and only
    /// something that sees every one of those closings can put it out.
    var onClose: (() -> Void)?

    private var panel: NSPanel?
    /// When the panel last closed, so a click on the status item that dismissed
    /// it is not also read as a click that opens it again.
    ///
    /// Clicking the button while the panel is key resigns key first — which
    /// closes it — and only then fires the button's action. Without this the
    /// panel would shut and reopen on every second click and never appear to
    /// close at all.
    private var closedAt: Date?

    var isOpen: Bool { panel?.isVisible == true }

    // MARK: Presenting

    /// Opens under `button`, or closes if the click was the one that dismissed
    /// it. Returns nothing: the caller's job is to say a click happened, not to
    /// decide which way it goes.
    func toggle(from button: NSStatusBarButton, readings: Readings) {
        if isOpen {
            close()
            return
        }
        if let closedAt, Date().timeIntervalSince(closedAt) < 0.2 { return }
        show(from: button, readings: readings)
    }

    func show(from button: NSStatusBarButton, readings: Readings) {
        let content = PanelContent(readings: readings) { [weak self] action in
            // Dismiss first. Every action either opens a window in front of this
            // one or ends the process, and a panel still hanging under the menu
            // bar over the window it just opened is the wrong answer to all of
            // them.
            self?.close()
            self?.onAction?(action)
        }

        let panel = self.panel ?? makePanel()
        self.panel = panel
        panel.setContentSize(content.frame.size)
        panel.contentView = wrap(content)

        // Right-aligned under the button, and never off the edge of the screen —
        // a status item near the right corner would otherwise put half the panel
        // past it.
        guard let buttonWindow = button.window else { return }
        let onScreen = buttonWindow.convertToScreen(button.convert(button.bounds, to: nil))
        let screen = buttonWindow.screen ?? NSScreen.main
        var x = onScreen.maxX - content.frame.width
        if let visible = screen?.visibleFrame {
            x = min(x, visible.maxX - content.frame.width - 8)
            x = max(x, visible.minX + 8)
        }
        panel.setFrameTopLeftPoint(NSPoint(x: x, y: onScreen.minY - 6))

        // The app has to be active for a borderless panel to hold key, and this
        // one closes when it stops being key — without this it opened and shut
        // in the same frame. An accessory app activating shows no Dock icon and
        // no menu bar of its own; it is what every panel hanging off a status
        // item does, and it is also what makes ⌘D and ⌘Q reach this window.
        NSApp.activate(ignoringOtherApps: true)
        panel.makeKeyAndOrderFront(nil)
    }

    func close() {
        guard let panel, panel.isVisible else { return }
        closedAt = Date()
        panel.orderOut(nil)
        onClose?()
    }

    /// Redraws in place while the panel is up, so the readings tick rather than
    /// standing at whatever they were when it opened.
    func refresh(_ readings: Readings) {
        guard isOpen, let panel else { return }
        let content = PanelContent(readings: readings) { [weak self] action in
            self?.close()
            self?.onAction?(action)
        }
        // Only resize when the shape actually changed — a permission row
        // appearing or a device count arriving. Setting the frame every second
        // would fight the window server for no reason.
        if panel.frame.size != content.frame.size {
            let top = NSPoint(x: panel.frame.minX, y: panel.frame.maxY)
            panel.setContentSize(content.frame.size)
            panel.setFrameTopLeftPoint(top)
        }
        panel.contentView = wrap(content)
    }

    private func makePanel() -> NSPanel {
        let panel = KeyablePanel(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        panel.isFloatingPanel = true
        // Above the windows of every app, including a full-screen one, because
        // the thing it hangs from is above them too.
        panel.level = .popUpMenu
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.hidesOnDeactivate = false
        panel.animationBehavior = .utilityWindow
        // The palette is measured in one appearance. Following the system's
        // would put jade ink at 1.1:1 on a light ground, which is the defect
        // this panel exists partly to fix.
        panel.appearance = NSAppearance(named: .darkAqua)
        panel.delegate = self
        return panel
    }

    /// The ground: the system's own blur, the app's dark over it, and one corner.
    ///
    /// The blur alone is too light and too neutral to be this app's surface, and
    /// a flat fill alone would sit on the desktop like a sticker. Both is what
    /// every panel hanging off the menu bar actually is.
    private func wrap(_ content: NSView) -> NSView {
        let container = NSView(frame: content.frame)
        container.wantsLayer = true
        container.layer?.cornerRadius = Palette.Radius.card
        container.layer?.masksToBounds = true

        let blur = NSVisualEffectView(frame: container.bounds)
        blur.material = .popover
        blur.blendingMode = .behindWindow
        blur.state = .active
        blur.autoresizingMask = [.width, .height]
        container.addSubview(blur)

        let tint = NSView(frame: container.bounds)
        tint.wantsLayer = true
        tint.layer?.backgroundColor = Palette.screen.withAlphaComponent(0.82).cgColor
        tint.autoresizingMask = [.width, .height]
        container.addSubview(tint)

        // A hairline inside the corner, so the panel has an edge over a bright
        // wallpaper instead of bleeding into it.
        let edge = NSView(frame: container.bounds)
        edge.wantsLayer = true
        edge.layer?.cornerRadius = Palette.Radius.card
        edge.layer?.borderWidth = 1
        edge.layer?.borderColor = Palette.hairline.cgColor
        edge.autoresizingMask = [.width, .height]

        container.addSubview(content)
        container.addSubview(edge)
        return container
    }

    // MARK: NSWindowDelegate

    /// Clicking anywhere else closes it, which is what a panel hanging off the
    /// menu bar is expected to do and is one behaviour rather than the two event
    /// monitors it would otherwise take.
    func windowDidResignKey(_ notification: Notification) {
        close()
    }
}

/// A borderless window is not key-eligible by default, and this one has to be:
/// it carries ⌘D, ⌘P and ⌘Q, and it closes when it stops being key.
private final class KeyablePanel: NSPanel {
    override var canBecomeKey: Bool { true }

    /// Escape goes back through the owner rather than straight to `orderOut`.
    /// Ordering out from here would resign key, reach `windowDidResignKey`, and
    /// find the window already hidden — so the close would be real and every
    /// bookkeeping step that hangs off it would be skipped.
    override func cancelOperation(_ sender: Any?) {
        MainActor.assumeIsolated { (delegate as? StatusPanel)?.close() }
    }
}
