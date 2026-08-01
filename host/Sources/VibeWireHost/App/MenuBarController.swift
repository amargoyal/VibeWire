import AppKit

/// 18 · MENU BAR.
///
/// The Mac side used to be two things: this status item, and a separate AppKit
/// pairing window that existed only to hand over six digits and two QR codes.
/// Everything else the host measured was reachable from the phone and nowhere
/// else, which is a strange place to have to stand to read the Mac in front of
/// you — and pairing meant a window that could say nothing about what happened
/// after the handshake.
///
/// Both are now one window. `DashboardWindow` draws the code, the QRs, the
/// handshake steps and the six panes behind them, so this file is back to what
/// a menu bar item should be: three measured facts, two ways into the window,
/// the two permissions, and quit.
///
/// The header order is deliberate and unchanged. The reason to open this menu is
/// almost always to check whether the Mac is still serving, so the machine,
/// whether a client is attached, and which path it is on come before any item.
@MainActor
final class MenuBarController: NSObject {
    private let statusItem: NSStatusItem
    private let pairing: PairingService
    private let trust: TrustStore
    private let transport: TransportManager
    /// The window this menu opens. Owned by the app delegate, not by the menu —
    /// a status item is a way in, not the thing itself.
    weak var dashboard: DashboardWindow?
    /// Read only for the three values above the menu items. Weak because the
    /// router outlives nothing here and the menu must never keep it alive.
    weak var router: HostRouter?
    /// The last transport status this controller was told about.
    ///
    /// `TransportManager` is an actor and the menu is built on the main actor,
    /// so the header draws from the last known answer and asks for a fresh one
    /// behind it — the same shape the paired-device list already uses. A menu
    /// that blocked the main thread on an actor hop to say "DIRECT" would be a
    /// worse trade than a header that is occasionally one second stale.
    private var lastStatus: TransportManager.Status?
    /// The last answer the keychain gave about paired devices.
    ///
    /// Same shape as `lastStatus` and held for the same reason: the store is an
    /// actor, the menu is built on the main actor, and the first keychain read
    /// after a rebuild can take tens of seconds — which is what `prime()` is
    /// for. An open draws this and asks for a fresh one behind it.
    ///
    /// Three states rather than two. `nil` is "never asked", `.failure` is "the
    /// keychain did not answer", and an empty array is "no devices paired". The
    /// middle one is the fact this menu used to print as the last one.
    private var lastDevices: Result<[TrustedDevice], Error>?

    init(pairing: PairingService, trust: TrustStore, transport: TransportManager) {
        self.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        self.pairing = pairing
        self.trust = trust
        self.transport = transport
        super.init()
        configureButton()
        rebuildMenu()
    }

    private func configureButton() {
        guard let button = statusItem.button else { return }
        // The mark from the design header: a small square with a crosshair.
        let image = NSImage(
            systemSymbolName: "rectangle.connected.to.line.below",
            accessibilityDescription: "VibeWire"
        )
        image?.isTemplate = true
        button.image = image
        button.toolTip = "VibeWire"
    }

    /// Builds the menu object and hands it to the status item.
    ///
    /// The contents are filled by `populate(_:)`, which runs again on every open
    /// — see `menuWillOpen(_:)`. That delegate is why this has few callers: it
    /// is not "someone is about to look at it", it is construction.
    func rebuildMenu() {
        let menu = NSMenu()
        menu.delegate = self
        populate(menu)
        statusItem.menu = menu
        // Warms the two cached readings so the first open has something true to
        // draw.
        refreshCachedReadings()
    }

    /// Fills a menu with the answers as they stand right now.
    ///
    /// Called on every open, so nothing here may block. The two readings that
    /// would have to cross an actor to be taken are drawn from cache and asked
    /// for again behind the open; everything else is either a live in-process
    /// probe or a lock read, and cheap enough to pay for each time.
    private func populate(_ menu: NSMenu) {
        let header = NSMenuItem()
        header.view = readoutHeader()
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        menu.addItem(withTitle: "Open VibeWire", action: #selector(openDashboard), keyEquivalent: "d")
            .target = self
        menu.addItem(withTitle: "Pair a device…", action: #selector(openPairing), keyEquivalent: "p")
            .target = self

        menu.addItem(.separator())

        // Permission state, because a missing grant is the single most likely
        // reason the phone shows a black screen or dead input.
        //
        // Probed on every open rather than once at launch. Both calls are
        // in-process and neither prompts, and granting a permission is something
        // the user does *from this menu* and then comes straight back to: read
        // once, it answered "Grant Screen Recording…" for the rest of the
        // process to someone who had just granted it.
        let screen = DisplayCatalog.hasScreenRecordingPermission()
        let accessibility = InputInjector.hasAccessibilityPermission()

        let screenItem = NSMenuItem(
            title: screen ? "Screen Recording ✓" : "Grant Screen Recording…",
            action: screen ? nil : #selector(requestScreenPermission),
            keyEquivalent: ""
        )
        screenItem.target = self
        screenItem.isEnabled = !screen
        menu.addItem(screenItem)

        let accessibilityItem = NSMenuItem(
            title: accessibility ? "Accessibility ✓" : "Grant Accessibility…",
            action: accessibility ? nil : #selector(requestAccessibilityPermission),
            keyEquivalent: ""
        )
        accessibilityItem.target = self
        accessibilityItem.isEnabled = !accessibility
        menu.addItem(accessibilityItem)

        menu.addItem(.separator())

        let devicesHeader = NSMenuItem(title: "Paired devices", action: nil, keyEquivalent: "")
        devicesHeader.isEnabled = false
        menu.addItem(devicesHeader)

        for title in deviceLines() {
            let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
            item.isEnabled = false
            menu.addItem(item)
        }

        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit VibeWire", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    }

    /// The paired-device rows, from the last answer the keychain gave.
    ///
    /// A keychain that could not be read and a Mac with nothing paired to it are
    /// different facts. `TrustStore` is careful to keep them apart — its own note
    /// explains that caching a failed read as an empty set once made every paired
    /// phone come back `unknown device` for the rest of the process — so this
    /// keeps them apart too, and adds the third state the cache introduces: an
    /// em dash while nothing has been asked yet, because not-yet-read is not the
    /// same as read-and-empty either.
    private func deviceLines() -> [String] {
        switch lastDevices {
        case .none:
            return ["   —"]
        case .some(.failure):
            return ["   Keychain did not answer"]
        case .some(.success(let list)):
            return list.isEmpty ? ["   None yet"] : list.map { "   \($0.name)" }
        }
    }

    /// Re-asks for the two readings the main thread cannot take itself, and
    /// leaves them where the next open will find them.
    private func refreshCachedReadings() {
        Task { [weak self] in
            guard let self else { return }
            let status = await transport.status()
            let devices: Result<[TrustedDevice], Error>
            do {
                devices = .success(try await trust.all())
            } catch {
                devices = .failure(error)
            }
            self.lastStatus = status
            self.lastDevices = devices
        }
    }

    // MARK: The readout header

    /// The machine, whether anything is attached, and which path it is on.
    ///
    /// A menu item with a view rather than three disabled title items: these
    /// are readings, not commands, and drawing them as greyed-out menu entries
    /// said the opposite. Nothing here is measured on the way in — the router
    /// already knows all of it.
    private func readoutHeader() -> NSView {
        let serving = router?.serving

        let container = NSView(frame: NSRect(x: 0, y: 0, width: 268, height: 106))

        let name = NSTextField(labelWithString: Host.current().localizedName ?? "This Mac")
        // The one mark left sitting directly on the system's menu material, and
        // correctly so: `labelWithString:` leaves this at `labelColor`, the
        // platform's own adaptive ink, which is legible in both appearances by
        // construction. It is also the machine's name rather than a condition,
        // so it was never the palette's to colour.
        name.frame = NSRect(x: 14, y: 74, width: 150, height: 18)
        name.font = .systemFont(ofSize: 13, weight: .semibold)
        container.addSubview(name)

        // The state chip.
        //
        // The dot and the word used to be painted from the palette straight onto
        // the menu's material, and the palette is defined against grounds this
        // app draws. The material is not one of those: the menu follows the
        // system appearance, this app never sets `NSApp.appearance`, and on a
        // light menu jade measured 1.10:1 to 1.47:1 — a host that does not
        // report its state at all to anyone who has not chosen Dark.
        //
        // Filling a chip puts the ink back on a ground the palette was measured
        // against, and the readings stop depending on the desktop behind them:
        // jade on Raised is 10.93:1 and Text Tertiary on Raised is 4.15:1, in
        // both appearances, over any wallpaper.
        let stateWord = serving == nil ? "STARTING" : "SERVING"
        let stateFont = NSFont.monospacedSystemFont(ofSize: 9, weight: .medium)
        // Sized to the longer of the two words, so the chip holds still when the
        // state changes rather than resizing under a reader's eye.
        let wordWidth = ("STARTING" as NSString)
            .size(withAttributes: [.font: stateFont]).width.rounded(.up)
        // 34pt tall because a declared corner has to survive being drawn:
        // CALayer clamps `cornerRadius` to half the shorter side, so at 32pt or
        // under this would come out a capsule — and a capsule in this system
        // marks something transient, which a standing condition readout is not.
        let chipWidth = 12 + 7 + 7 + wordWidth + 12
        let chip = NSView(frame: NSRect(x: 256 - chipWidth, y: 66, width: chipWidth, height: 34))
        chip.fill(Palette.raised, radius: Palette.Radius.control)
        container.addSubview(chip)

        let dot = NSView(frame: NSRect(x: 12, y: 13.5, width: 7, height: 7))
        dot.fill(serving == nil ? Palette.textTertiary : Palette.green, radius: 3.5)
        chip.addSubview(dot)

        let state = NSTextField(labelWithString: stateWord)
        state.frame = NSRect(x: 26, y: 10, width: wordWidth, height: 14)
        state.font = stateFont
        state.textColor = serving == nil ? Palette.textTertiary : Palette.green
        chip.addSubview(state)

        // An unmeasured value and a measured zero are different facts, and the
        // interface is not allowed to blur them. Until the router has answered
        // these print the em dash the rest of the instrument uses for "not
        // reported" — `pathWord` already did, one line below, and a `0` beside
        // it claimed a reading nobody had taken.
        let values: [(String, String)] = [
            ("CLIENT", serving.map { $0.clientAttached ? "1" : "0" } ?? "—"),
            ("SCREENS", serving.map { "\($0.streams)" } ?? "—"),
            ("PATH", pathWord(lastStatus)),
        ]

        for (index, value) in values.enumerated() {
            // A 46pt Raised 2 box takes the inner corner. The ladder is read
            // off the system's own Raised 2 components rather than guessed: the
            // 70pt tile takes `control`, the 46pt key cap and the 44pt field
            // both take `inner`, and this is 46pt.
            let tile = NSView(
                frame: NSRect(x: 14 + CGFloat(index) * 82, y: 12, width: 78, height: 46)
            )
            tile.fill(Palette.raised2, radius: Palette.Radius.inner)

            let label = NSTextField(labelWithString: value.0)
            label.frame = NSRect(x: 10, y: 27, width: 60, height: 12)
            // 9pt, which is the floor everywhere in this system and the size the
            // `label` token states.
            label.font = .monospacedSystemFont(ofSize: 9, weight: .regular)
            label.textColor = Palette.textTertiary
            tile.addSubview(label)

            let reading = NSTextField(labelWithString: value.1)
            reading.frame = NSRect(x: 10, y: 7, width: 60, height: 18)
            reading.font = .monospacedSystemFont(
                ofSize: value.1.count > 3 ? 11 : 14,
                weight: .regular
            )
            // An em dash standing in for a value the host has not reported is
            // set in Text Tertiary, so it reads as a held space rather than as
            // a reading.
            reading.textColor = value.1 == "—" ? Palette.textTertiary : Palette.text
            tile.addSubview(reading)

            container.addSubview(tile)
        }

        return container
    }

    private func pathWord(_ status: TransportManager.Status?) -> String {
        guard let status else { return "—" }
        if status.cloudflareRunning, status.cloudflareHostname != nil { return "TUNNEL" }
        if status.tailscaleRunning { return "DIRECT" }
        return "LAN"
    }

    // MARK: Ways into the window

    @objc private func openDashboard() {
        dashboard?.show()
    }

    /// Opens a code and the window that shows it, in that order.
    ///
    /// The order matters: the window polls for state, and a window that opened
    /// first would draw one frame of "no code" before the first poll landed.
    @objc private func openPairing() {
        Task { @MainActor in
            await beginPairing()
        }
    }

    /// Shared with `--pair`, which wants exactly this and nothing else.
    func beginPairing() async {
        let code = await pairing.beginPairing()
        Log.info(.app, "pairing open — code \(code.value) (rotates in \(Int(Config.pairingCodeLifetime))s)")
        dashboard?.show(pane: "pair")
        rebuildMenu()
    }

    // MARK: Permissions

    @objc private func requestScreenPermission() {
        DisplayCatalog.requestScreenRecordingPermission()
        // The grant only takes effect after a relaunch; say so rather than
        // letting the user wonder why the checkmark did not appear.
        let alert = NSAlert()
        alert.messageText = "Screen Recording"
        alert.informativeText = """
        Enable VibeWire in System Settings → Privacy & Security → Screen Recording, \
        then quit and reopen VibeWire.
        """
        alert.runModal()
    }

    @objc private func requestAccessibilityPermission() {
        InputInjector.requestAccessibilityPermission()
    }
}

extension MenuBarController: NSMenuDelegate {
    /// Retakes every reading in the menu just before it is shown.
    ///
    /// Without it the whole menu is a photograph: the header was built once in
    /// `init`, before `router` had even been set, and then drawn unchanged for
    /// the life of the process. An open is the only moment any of it is worth
    /// taking, and this costs nothing while the menu is closed.
    func menuWillOpen(_ menu: NSMenu) {
        menu.removeAllItems()
        populate(menu)
        refreshCachedReadings()
    }
}

private extension NSMenu {
    @discardableResult
    func addItem(withTitle title: String, action: Selector?, keyEquivalent: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: keyEquivalent)
        addItem(item)
        return item
    }
}
