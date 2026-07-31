import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins

/// 18 · MENU BAR and 19 · PAIRING WINDOW.
///
/// The Mac side of the handshake: "MENU BAR → VIBEWIRE → PAIR".
///
/// Deliberately small. The Mac is not where this product lives; it just needs
/// to hand over a code, report whether the two permissions are granted, and
/// stay out of the way.
///
/// Nightshift changed the order of it. The menu used to open with a version
/// string and then five items; the reason to open it is almost always to check
/// whether the Mac is still serving, so three measured values now come first —
/// the machine, whether a client is attached, and which path it is on — and the
/// items follow. The pairing window stopped being a system dialog with two QRs
/// in it and became the app's own screen: six digit boxes, a rotation dial, and
/// one card per way in.
@MainActor
final class MenuBarController: NSObject {
    private let statusItem: NSStatusItem
    private let pairing: PairingService
    private let trust: TrustStore
    private let transport: TransportManager
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
    private var pairingWindow: NSWindow?
    /// One field per digit box. The six of them are the code.
    private var digitFields: [NSTextField] = []
    private var listeningField: NSTextField?
    private var rotationDial: RotationDial?
    private var qrView: NSImageView?
    /// The second QR: an ordinary URL, for the phone's own camera.
    private var browserQRView: NSImageView?
    private var browserCaption: NSTextField?
    /// The sentence under the browser QR's caption — which way in this is, and
    /// how far it reaches.
    private var browserBlurb: NSTextField?
    private var countdownField: NSTextField?
    /// The dot beside the listening line. Held because whether this Mac has an
    /// address anything else can reach is measured once a second, not once.
    private var servingDot: NSView?
    private var rotationTimer: Timer?
    private var lastLoggedBrowserURL: String?
    /// The permission notice, when there is one to draw. Held so the one-second
    /// tick can take it away the moment a grant lands without touching anything
    /// else in the window.
    private var permissionNotice: NSView?
    /// The last measured permission pair this window was drawn for. `nil` until
    /// the first probe: not-yet-asked and granted are different facts, and this
    /// window is not allowed to draw the second while it means the first.
    private var lastPermissions: Permissions?

    /// The pairing window's horizontal geometry, in one place because four
    /// separate blocks of this file have to agree on it.
    ///
    /// The digit run sets the width rather than the other way round. Six 92pt
    /// boxes with `sm` between them measure exactly 592, so a `gutter` either
    /// side of that wants a 632pt window — and 592 then divides into two QR
    /// cards of 288 with `lg` between them. Both whole numbers, and the digit
    /// run, the QR row and the permission card all land on the same two vertical
    /// lines, which is the strongest thing this window can do with an edge.
    private enum Pane {
        /// `gutter`, and symmetric — which this window's margins were not. It
        /// was 28 on the left throughout, against 20 to the right of the digit
        /// run, 16 to the right of the QR cards and 28 to the right of the two
        /// right-aligned readouts: four different answers to one question.
        static let margin: CGFloat = 20
        /// A digit box, and `sm` between them. These two are the seed of every
        /// horizontal number below, which is what the paragraph above claims —
        /// so they are declared here and the width is derived, rather than 632
        /// being written down and the claim left to be believed.
        static let digitWidth: CGFloat = 92
        static let digitGap: CGFloat = 8
        /// 592 — the digit run, and so everything between the margins.
        static let band: CGFloat = 6 * digitWidth + 5 * digitGap
        /// 632.
        static let width: CGFloat = band + 2 * margin
        /// 612 — the right-hand line every trailing edge sits on.
        static let right: CGFloat = width - margin
        /// `lg` between the two QR cards, which makes each of them 288.
        static let cardGap: CGFloat = 16
        static let cardWidth: CGFloat = (band - cardGap) / 2
    }

    /// The pairing window's vertical stack, bottom to top.
    ///
    /// These are not five free values, and that is the thing worth knowing
    /// before moving one. `resizePairingWindow` grows the window by the height
    /// of the permission notice, and the two totals it works from — what sits
    /// below the notice band and what sits above it — are sums of everything
    /// here. Change any single value and all three window heights change with
    /// it, which is why they are derived below rather than written down three
    /// times and kept in agreement by hand.
    ///
    /// Only two of them are on the spacing ladder, and the rest are not
    /// mistakes waiting to be corrected:
    ///
    ///  - `titleBarClearance` is fixed by something outside the design system.
    ///  - `gutter` and `titleToDigits` are `gutter` and `card`, on the ladder.
    ///  - `cardsToListening` and `bottomMargin` are simply the values they are.
    ///  - `bandUsable` is a residue, not a choice, and load-bearing.
    private enum Stack {
        /// Clearance for the system title bar, not a design margin.
        ///
        /// `.fullSizeContentView` runs the content view underneath the title
        /// bar, which is 28pt, so this is that 28 plus 2. A `gutter` here would
        /// put the headline inside the title bar and under the traffic lights.
        /// It is off the ladder because it is not answering to the ladder.
        static let titleBarClearance: CGFloat = 30
        static let titleHeight: CGFloat = 30
        /// `card`, and on the ladder — leave it there.
        static let titleToDigits: CGFloat = 18
        static let digitsHeight: CGFloat = 78
        /// `gutter`, on the ladder, held above and below the notice band.
        static let gutter: CGFloat = 20
        /// What the band between the digits and the QR cards has left once both
        /// gutters are taken out of its 112. Not a chosen value — it is what the
        /// rest of the stack leaves over — and the notice needs 134 or 162, so
        /// it never fits and the window grows instead. That is the whole reason
        /// `resizePairingWindow` exists.
        static let bandUsable: CGFloat = 72
        static let cardsHeight: CGFloat = 114
        /// Off the ladder, and not derived from anything: simply the values they
        /// are. Load-bearing all the same, being two of the five terms in
        /// `below`, so moving one moves all three window heights.
        static let cardsToListening: CGFloat = 26
        static let listeningHeight: CGFloat = 16
        static let bottomMargin: CGFloat = 50

        /// 226 — everything under the notice band, and so the notice's own y.
        static let below = bottomMargin + listeningHeight + cardsToListening + cardsHeight + gutter
        /// 176 — everything over it.
        static let above = gutter + digitsHeight + titleToDigits + titleHeight + titleBarClearance
        /// 402 — the window, minus whatever the notice turns out to be.
        static let fixed = below + above
        /// 474 — the height with both permissions granted: the fixed content
        /// plus a band with nothing in it. Also the floor `resizePairingWindow`
        /// clamps to, which is the same statement as "never smaller than the
        /// layout with an empty band".
        static let granted = fixed + bandUsable
    }

    /// The two grants the phone depends on, as measured — never as assumed.
    private struct Permissions: Equatable {
        let screen: Bool
        let accessibility: Bool
        var allGranted: Bool { screen && accessibility }
    }

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
    /// — see `menuWillOpen(_:)`. This has three callers, none of which is
    /// "someone is about to look at it": `init`, `--pair`, and the pairing window
    /// closing. That is why the delegate exists.
    func rebuildMenu() {
        let menu = NSMenu()
        menu.delegate = self
        populate(menu)
        statusItem.menu = menu
        // Warms the two cached readings so the first open has something true to
        // draw. Worth doing from the other two callers as well: the pairing
        // window closing is the one moment a device is most likely to have just
        // been added to the list this menu shows.
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

        menu.addItem(withTitle: "Show pairing code…", action: #selector(openPairing), keyEquivalent: "p")
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
    ///
    /// Both live behind actors, and a menu that blocked the main thread on an
    /// actor hop to say "DIRECT" would be the worse trade — so an open draws the
    /// last known answer and this runs behind it. One open stale is the cost, and
    /// it is the trade this controller already documents for the transport.
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
        //
        // Text Tertiary rather than the Text Disabled DESIGN.md assigns to
        // dormant indicators: on Raised it holds 4.15:1 where Text Disabled
        // reaches 1.75:1, and a dormant mark still has to be a mark. Moving to a
        // ground the host draws did not rescue that ink — Raised is a dark
        // ground too, which is the whole reason the rest of the palette works on
        // it — so the reading taken against the menu material still stands.
        //
        // No edge. The chip is a ground, not a control, so there is nothing to
        // hit and no 3:1 boundary owed. Where it is least visible it is also
        // least needed, and by the same fact: against a dark menu over a black
        // desktop it measures 1.02:1 because #181A1F and the material are the
        // same colour — which is exactly the case where the bare material was
        // already carrying jade at 10.68:1. Where the material is light the chip
        // measures 11.98:1 to 16.11:1 against it, which is where it is for.
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
            // both take `inner`, and this is 46pt. The literal 9 it replaces sat
            // between two rungs and belonged to neither.
            let tile = NSView(
                frame: NSRect(x: 14 + CGFloat(index) * 82, y: 12, width: 78, height: 46)
            )
            tile.fill(Palette.raised2, radius: Palette.Radius.inner)

            let label = NSTextField(labelWithString: value.0)
            label.frame = NSRect(x: 10, y: 27, width: 60, height: 12)
            // 9pt, which is the floor everywhere in this system and the size the
            // `label` token states. 8pt was below both, and on Raised 2 it was
            // also carrying 3.7:1 — under the threshold at a size chosen to be
            // under it.
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

    // MARK: Pairing window

    @objc private func openPairing() {
        Task { @MainActor in
            let code = await pairing.beginPairing()
            present(code: code)
        }
    }

    /// Same window the menu item opens, for a code someone else already began.
    /// `--pair` uses this so the digits and the QR are on screen without having
    /// to find the status item among twenty other menu bar icons.
    func present(code: PairingService.ActiveCode) {
        showPairingWindow(code: code)
        startRotationTimer()
    }

    private func showPairingWindow(code: PairingService.ActiveCode) {
        let isNew = pairingWindow == nil
        if isNew {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: Pane.width, height: Stack.granted),
                styleMask: [.titled, .closable, .fullSizeContentView],
                backing: .buffered,
                defer: false
            )
            window.title = "VibeWire"
            window.titlebarAppearsTransparent = true
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: .darkAqua)
            window.backgroundColor = Palette.screen

            let content = NSView(frame: NSRect(x: 0, y: 0, width: Pane.width, height: Stack.granted))
            content.fill(Palette.screen, radius: 0)

            // The stack, read off `Stack` rather than written as absolute y
            // values, so the three of them cannot drift apart from the totals
            // `resizePairingWindow` works from.
            let titleY = Stack.granted - Stack.titleBarClearance - Stack.titleHeight   // 414
            let digitsY = titleY - Stack.titleToDigits - Stack.digitsHeight            // 318
            let cardsY = Stack.bottomMargin + Stack.listeningHeight + Stack.cardsToListening

            // 474 is the height with both permissions granted. A missing one
            // grows the window downward, so everything above the band between
            // the digits and the QR cards is pinned to the top edge — `.minYMargin`
            // — and everything below it keeps its distance from the bottom, which
            // is what an unset mask already does. Without the pinning the new
            // height would open as a gap under the title bar and leave the six
            // digits sitting in the middle of the window.
            let title = NSTextField(labelWithString: "Pair a device")
            title.frame = NSRect(x: Pane.margin, y: titleY, width: 300, height: Stack.titleHeight)
            title.font = .systemFont(ofSize: 24, weight: .semibold)
            title.textColor = Palette.text
            title.autoresizingMask = .minYMargin
            content.addSubview(title)

            // The dial says at a glance whether there is time to finish typing;
            // the number beside it is the same fact for anyone who wants it
            // exactly.
            //
            // 122 holds the longest thing this field says — "LOCKED 60S · 5
            // WRONG" at 111.27 — and its trailing edge is the window's, so the
            // countdown and the digit run below it end on the same line.
            let countdownWidth: CGFloat = 122
            let countdownX = Pane.right - countdownWidth
            // `xs` from the dial to the field it belongs to.
            // Both ride the title's row, offset into it rather than placed
            // absolutely, so the pair stays put if the row ever moves.
            let dial = RotationDial(frame: NSRect(x: countdownX - 6 - 13, y: titleY + 7, width: 13, height: 13))
            dial.autoresizingMask = .minYMargin
            content.addSubview(dial)
            self.rotationDial = dial

            let countdown = NSTextField(labelWithString: "")
            countdown.frame = NSRect(x: countdownX, y: titleY + 5, width: countdownWidth, height: 16)
            countdown.alignment = .right
            countdown.font = .monospacedSystemFont(ofSize: 9, weight: .regular)
            countdown.textColor = Palette.amber
            countdown.autoresizingMask = .minYMargin
            content.addSubview(countdown)
            self.countdownField = countdown

            // Six boxes rather than one 44pt string: the digits are read one at
            // a time and typed one at a time, and a run of six characters on a
            // Mac is a serial number until it is boxed.
            var boxes: [NSTextField] = []
            let boxWidth = Pane.digitWidth
            let boxGap = Pane.digitGap
            for index in 0..<6 {
                let x = Pane.margin + CGFloat(index) * (boxWidth + boxGap)
                let box = NSView(frame: NSRect(x: x, y: digitsY, width: boxWidth, height: Stack.digitsHeight))
                // A digit box is a control, so it takes the control corner —
                // the same 16 the phone draws its own six boxes with, which is
                // the whole point of the two screens being compared side by
                // side.
                box.fill(Palette.raised, radius: Palette.Radius.control)
                box.autoresizingMask = .minYMargin
                content.addSubview(box)

                let digit = NSTextField(labelWithString: "")
                digit.frame = NSRect(x: 0, y: 16, width: boxWidth, height: 46)
                digit.alignment = .center
                digit.font = .monospacedSystemFont(ofSize: 34, weight: .regular)
                digit.textColor = Palette.text
                box.addSubview(digit)
                boxes.append(digit)
            }
            self.digitFields = boxes

            // Two QRs, because they are read by two different things and only
            // one of them is a scanner. The left is `vibewire://pair?…` for the
            // iOS app — a custom scheme, which a browser can never handle. The
            // right is an ordinary URL, so the phone's own camera opens it in
            // the browser and the web client pairs on load. Same handshake,
            // same code, no typing and no in-app scanner.
            //
            // One card each, with the sentence that says which is which,
            // because a caption under a QR is the thing nobody reads before
            // scanning the wrong one.
            for (index, spec) in [
                ("iPHONE APP", "Scan in VibeWire. Custom scheme — a browser cannot open it.", Palette.accent),
                ("ANY BROWSER", "Scan with the phone's own camera. Pairs on load.", Palette.green),
            ].enumerated() {
                let x = Pane.margin + CGFloat(index) * (Pane.cardWidth + Pane.cardGap)
                let card = NSView(frame: NSRect(x: x, y: cardsY, width: Pane.cardWidth, height: Stack.cardsHeight))
                // These are cards — they contain the plate and its caption —
                // so they take 20, not the 16 of a control. The plate inside
                // stays a step tighter, which is what makes it read as nested.
                card.fill(Palette.raised, radius: Palette.Radius.card)
                content.addSubview(card)

                // 16 padding (`lg`, inside the 16–18 DESIGN.md allows a card),
                // `md` from the plate across to the text, and the 158pt column
                // that leaves is measured against the longest caption this card
                // can hold: "ANY BROWSER · PUBLISHED SITE" at 155.78. Those 2.22
                // are the tightest number in this window, and they are exact
                // rather than estimated — SF Mono advances 5.5635pt at 9pt and
                // the string is 28 characters of it.
                //
                // Spend them and nothing says so. `NSTextField(labelWithString:)`
                // comes with `lineBreakMode` `.byClipping`, not
                // `.byTruncatingTail`, so a caption one character too long is cut
                // mid-glyph with no ellipsis to mark it — the failure looks like
                // a caption that happens to end there. A longer caption needs a
                // wider column, not a smaller size, and whoever writes one has to
                // re-measure it here rather than trust that it looked fine.
                let padding: CGFloat = 16
                let plateSize: CGFloat = 86
                let textX = padding + plateSize + 12
                let textWidth = Pane.cardWidth - textX - padding

                let plate = NSView(
                    frame: NSRect(
                        x: padding,
                        y: (Stack.cardsHeight - plateSize) / 2,
                        width: plateSize,
                        height: plateSize
                    )
                )
                // The one raw colour on any host surface, and it is not an ink:
                // a QR needs a white quiet zone to decode, so this is a value a
                // scanner requires rather than one the palette chose. Naming it
                // in the palette would invite it to be spent somewhere it is
                // only a colour.
                plate.fill(.white, radius: Palette.Radius.small)
                card.addSubview(plate)

                let image = NSImageView(frame: NSRect(x: 6, y: 6, width: 74, height: 74))
                image.imageScaling = .scaleProportionallyUpOrDown
                plate.addSubview(image)

                let caption = NSTextField(labelWithString: spec.0)
                caption.frame = NSRect(x: textX, y: 76, width: textWidth, height: 14)
                caption.font = .monospacedSystemFont(ofSize: 9, weight: .medium)
                caption.textColor = spec.2
                card.addSubview(caption)

                let blurb = NSTextField(wrappingLabelWithString: spec.1)
                blurb.frame = NSRect(x: textX, y: 18, width: textWidth, height: 52)
                blurb.font = .systemFont(ofSize: 12)
                blurb.textColor = Palette.textSecondary
                blurb.isSelectable = false
                card.addSubview(blurb)

                if index == 0 {
                    self.qrView = image
                } else {
                    self.browserQRView = image
                    self.browserCaption = caption
                    self.browserBlurb = blurb
                }
            }

            // What the host is actually doing, in the same words the phone uses
            // for the same facts.
            let servingDot = NSView(frame: NSRect(x: Pane.margin, y: Stack.bottomMargin + 4, width: 7, height: 7))
            servingDot.fill(Palette.green, radius: 3.5)
            content.addSubview(servingDot)
            self.servingDot = servingDot

            // 80 for a string that measures 55.63 today. Sized to the value
            // rather than to a round number, but with room for a version longer
            // than this one: "HOST 10.10.10" is 72.30, which still fits.
            //
            // It used to be 160, which is what had the listening line beside it
            // down to 420 for a reading that measures 411.70 at its longest —
            // and their frames overlapped by 12 into the bargain. Right-aligned
            // text hid it, but the two fields were fighting over the same 12pt.
            let versionWidth: CGFloat = 80
            let versionX = Pane.right - versionWidth

            // `sm` from the dot to the line it belongs to, `md` from that line
            // to the version. 485 for a reading that needs 411.70 at worst.
            let listeningX = Pane.margin + 7 + 8
            let listening = NSTextField(labelWithString: "")
            listening.frame = NSRect(
                x: listeningX,
                y: Stack.bottomMargin,
                width: versionX - 12 - listeningX,
                height: Stack.listeningHeight
            )
            listening.font = .monospacedSystemFont(ofSize: 9, weight: .regular)
            listening.textColor = Palette.textTertiary
            content.addSubview(listening)
            self.listeningField = listening

            let version = NSTextField(labelWithString: "HOST \(Config.hostVersion)")
            version.frame = NSRect(
                x: versionX,
                y: Stack.bottomMargin,
                width: versionWidth,
                height: Stack.listeningHeight
            )
            version.alignment = .right
            version.font = .monospacedSystemFont(ofSize: 9, weight: .regular)
            version.textColor = Palette.textSecondary
            content.addSubview(version)

            window.contentView = content
            pairingWindow = window
        }

        update(for: code)
        // Centred after the first update rather than at construction, because
        // the height is not known until the two permissions have been measured:
        // a missing grant grows the window, and a window centred at 474 and then
        // grown downward is not centred any more.
        if isNew { pairingWindow?.center() }
        pairingWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func update(for code: PairingService.ActiveCode) {
        // Ahead of the digits, because it decides how tall the window is.
        refreshPermissionNotice()

        let digits = Array(code.value)
        for (index, field) in digitFields.enumerated() {
            field.stringValue = index < digits.count ? String(digits[index]) : ""
        }
        // Restated on every tick rather than only at build time, because
        // `codeSpent()` and `lockedOut(secondsRemaining:)` both repaint this
        // field, and a fresh code from the menu bar has to take it back.
        countdownField?.textColor = Palette.amber
        countdownField?.stringValue = "ROTATES IN \(code.secondsRemaining)S"
        rotationDial?.fraction = Double(code.secondsRemaining) / 60

        Task { @MainActor in
            // Re-probe rather than trusting the cache. `status()` returns
            // whatever the last refresh found, and a host launched before
            // Tailscale came up would otherwise put a LAN address in the QR —
            // at the one moment the address matters most.
            await transport.refresh()
            let status = await transport.status()

            // Tailscale first: that address keeps working when the phone leaves
            // the house, and a LAN address pairs a phone to one network.
            //
            // The 100.x address rather than the MagicDNS name — the name
            // endpoint is TLS-terminated and the phone speaks plain HTTP.
            //
            // This only works because SocketForwarder owns the port. An
            // NWListener never sees Tailscale traffic; see that file.
            let reachable = status.tailscaleAddress
                ?? status.lanAddress
                ?? status.tailscaleDNSName
            // Loopback is not a fourth address, it is the absence of one: it is
            // what this Mac calls itself and no phone can act on it. The QR is
            // still drawn with it, because an empty square says less than a
            // scannable one, but the dot and the line below now say the picture
            // will not work rather than leaving it to be found out by scanning.
            let host = reachable ?? "127.0.0.1"
            let port = Config.loadSettings().port
            // The QR carries everything the phone needs to skip typing.
            let payload = "vibewire://pair?host=\(host)&port=\(port)&code=\(code.value)"
            qrView?.image = Self.qrImage(from: payload)

            updateBrowserQR(
                code: code,
                status: status,
                lanHost: host,
                isReachable: reachable != nil,
                port: port
            )
        }
    }

    /// The QR a phone's camera can act on.
    ///
    /// Encodes a URL to the web client the host is already serving, carrying only
    /// the code — the client reads its own origin for the address, which keeps the
    /// payload short enough to scan from across a desk and means there is nothing to
    /// copy by hand.
    ///
    /// The tunnel wins when it is up, because that address works from cellular and a
    /// tailnet address does not. Failing that, whichever local address the app would
    /// have put in the other QR.
    private func updateBrowserQR(
        code: PairingService.ActiveCode,
        status: TransportManager.Status,
        lanHost: String,
        isReachable: Bool,
        port: UInt16
    ) {
        // Stated once, from the same status the QR was built from, so the line
        // under the cards can never disagree with the address inside them.
        // Whichever address of this Mac the phone has the best chance of reaching.
        // The tunnel wins when it is up, because it works from cellular and a tailnet
        // address does not.
        //
        // `reach` is set as a sentence rather than in caps, because it is the
        // tail of a 12pt sans blurb — caps in this system mean a value the
        // machine measured, set in mono, and the Title Case this used to print
        // was neither of those things.
        let origin: String
        let reach: String
        if let tunnel = status.cloudflareHostname, status.cloudflareRunning {
            origin = tunnel.hasSuffix("/") ? String(tunnel.dropLast()) : tunnel
            reach = "Works on cellular."
        } else {
            origin = "http://\(lanHost):\(port)"
            if !isReachable {
                // "Same network only" was the sentence this used to print here,
                // and on a Mac with no address at all it was a claim: a phone on
                // the same Wi-Fi cannot reach a loopback address either.
                reach = "No address to reach it on."
            } else if status.tailscaleAddress == nil {
                reach = "Same network only."
            } else {
                reach = "On the tailnet."
            }
        }

        // The condition this window reports about itself. A host listening on a
        // port with no address anything can route to is a measured degradation
        // — not a failure, the listener is up — which is what sodium is for.
        servingDot?.fill(isReachable ? Palette.green : Palette.amber, radius: 3.5)

        // Written before the browser QR is built, because every failure below
        // returns early and this line is not about the browser QR — it is what
        // the host is doing. A Mac with no web bundle is an ordinary host, the
        // protocol does not depend on one, and it used to leave this line empty
        // for the life of the window: a lit dot with nothing beside it.
        //
        // The precise version of the reach sentence, in mono, where a measured
        // value belongs — the sans blurb beside it says the short form. All four
        // segments together measure 411.70, which used to be 8pt off filling the
        // field; the margin pass gave this line 485 by taking the 160 the version
        // string next to it was never using, so there is room for a fifth
        // segment now if the host ever measures one.
        listeningField?.stringValue = [
            "LISTENING ON :\(port)",
            isReachable ? nil : "NO ADDRESS BUT LOOPBACK",
            status.tailscaleRunning ? "TAILSCALE UP" : "TAILSCALE DOWN",
            status.cloudflareRunning ? "TUNNEL ON" : "TUNNEL OFF",
        ]
        .compactMap { $0 }
        .joined(separator: " · ")

        let url: String
        let caption: String

        if let site = Config.webClientURL {
            // Send the phone to the published copy, carrying this Mac's address —
            // that page was served by GitHub and has no idea where the Mac is, so
            // unlike the host-served copy it cannot read the address off its own
            // origin. `URLComponents` does the percent-encoding; hand-built, the `:`
            // and `//` in the address are exactly what gets mangled.
            let trimmed = site.hasSuffix("/") ? String(site.dropLast()) : site
            guard var components = URLComponents(string: trimmed) else {
                browserQRView?.image = nil
                browserCaption?.stringValue = "ANY BROWSER"
                browserBlurb?.stringValue = "webClientURL is not a URL."
                return
            }
            components.queryItems = [
                URLQueryItem(name: "host", value: origin),
                URLQueryItem(name: "code", value: code.value),
            ]
            // Its two siblings above and below both name their failure; a bare
            // return here left the last good QR on screen for a card that can no
            // longer be built, which is the one outcome worse than an empty one.
            guard let built = components.url?.absoluteString else {
                browserQRView?.image = nil
                browserCaption?.stringValue = "ANY BROWSER"
                browserBlurb?.stringValue = "webClientURL would not build a URL with this Mac's address in it."
                return
            }
            url = built
            caption = "ANY BROWSER · PUBLISHED SITE"
        } else {
            // Nothing to open if this host has no bundle to serve. A QR pointing at a
            // 404 is worse than no QR: it looks like the feature working and failing.
            guard Config.webRoot != nil else {
                browserQRView?.image = nil
                browserCaption?.stringValue = "ANY BROWSER"
                browserBlurb?.stringValue = "No web build on this host — see web/README.md."
                return
            }
            // Only the code: the page comes from this host, so it reads the address
            // off its own origin and the QR stays small.
            url = "\(origin)/?code=\(code.value)"
            caption = "ANY BROWSER"
        }
        browserQRView?.image = Self.qrImage(from: url)
        browserCaption?.stringValue = caption
        browserBlurb?.stringValue = "Scan with the phone's own camera. Pairs on load. \(reach)"

        // Printed as well as drawn: this is the one string worth being able to paste
        // into another machine, and reading it off a QR is not pasting.
        //
        // Once per value, not once per redraw — this runs on a one-second timer while
        // the window is open, and a log that repeats the same line sixty times a
        // minute is a log nobody reads.
        if url != lastLoggedBrowserURL {
            lastLoggedBrowserURL = url
            Log.info(.app, "browser pairing url \(url)")
        }
    }

    /// A device took the code, so there is no longer one to show.
    ///
    /// The digits are cleared rather than left standing, because six digits and
    /// a stopped countdown are exactly what someone reads out to a second phone
    /// — and the host will refuse them, having ended the window on the first
    /// success. Jade, because this is the Mac reporting that the thing worked.
    private func codeSpent() {
        for field in digitFields { field.stringValue = "" }
        rotationDial?.fraction = 0
        countdownField?.textColor = Palette.green
        countdownField?.stringValue = "PAIRED · CODE USED"
    }

    /// Five wrong codes buys a 60 s lockout (PROTOCOL §1.1), during which the
    /// host refuses the very code this window is showing.
    ///
    /// Clay and the count, because the code on screen is still rotating and
    /// still correct — what changed is that the host will not take it, and
    /// "ROTATES IN 43S" through a lockout is the window implying a working
    /// state it has measured the opposite of.
    private func lockedOut(secondsRemaining: Int) {
        countdownField?.textColor = Palette.red
        countdownField?.stringValue = "LOCKED \(secondsRemaining)S · \(Config.maxPairAttempts) WRONG"
    }

    private func startRotationTimer() {
        rotationTimer?.invalidate()
        rotationTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self else { return }
                guard let window = self.pairingWindow, window.isVisible else {
                    self.rotationTimer?.invalidate()
                    self.rotationTimer = nil
                    await self.pairing.endPairing()
                    self.rebuildMenu()
                    return
                }
                await self.pairing.rotateIfNeeded()
                guard let current = await self.pairing.currentCode() else {
                    // No code while the window is still open means `pair()`
                    // consumed it, and `pair()` only does that on a successful
                    // handshake. Until now this branch did nothing at all: the
                    // six digits stayed on screen and the countdown stopped
                    // where it was, so the most common outcome this window has
                    // left a dead code lit and said nothing about it.
                    self.codeSpent()
                    return
                }
                self.update(for: current)
                if let remaining = await self.pairing.lockoutRemaining {
                    self.lockedOut(secondsRemaining: remaining)
                }
            }
        }
    }

    private static func qrImage(from string: String) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        let context = CIContext()
        guard let cgImage = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cgImage, size: NSSize(width: 200, height: 200))
    }

    // MARK: The permission notice

    /// The two permissions, on the one screen where fixing them still costs
    /// nothing.
    ///
    /// A user can pair here, walk away, pick up the phone and find a black
    /// picture or dead input: ScreenCaptureKit needs Screen Recording, CGEvent
    /// posting needs Accessibility, and neither one says a word at the moment it
    /// fails. PRODUCT.md makes both hard constraints and forbids presenting a
    /// missing Accessibility grant as a working connection. This window is the
    /// last moment before that happens, and it used to say nothing at all.
    ///
    /// Measured, never assumed, and through the same two calls the menu items
    /// above are built from — `CGPreflightScreenCaptureAccess()` and
    /// `AXIsProcessTrusted()`. There is no second way of asking in this host.
    ///
    /// Nothing is drawn when both are granted. A standing panel of green ticks
    /// is the decoration this system does not do, and the window's job is the
    /// code and the QR.
    private func refreshPermissionNotice() {
        guard let content = pairingWindow?.contentView else { return }
        let now = Permissions(
            screen: DisplayCatalog.hasScreenRecordingPermission(),
            accessibility: InputInjector.hasAccessibilityPermission()
        )
        // Rebuilt when the answer changes, not on every tick. This runs once a
        // second for the life of the window, and granting a permission is
        // something a person does about twice a year.
        guard now != lastPermissions else { return }
        lastPermissions = now

        permissionNotice?.removeFromSuperview()
        permissionNotice = nil

        guard !now.allGranted else {
            resizePairingWindow(noticeHeight: 0)
            return
        }
        let notice = permissionNoticeView(now)
        resizePairingWindow(noticeHeight: notice.frame.height)
        content.addSubview(notice)
        permissionNotice = notice
    }

    /// The card itself.
    ///
    /// Sodium, because this is a measured degradation and not a failure: the
    /// handshake genuinely completes without either grant, the code on screen is
    /// good, and the phone will pair. What does not survive is the picture, or
    /// the input — two different losses, either of which can be missing on its
    /// own — so the heading names exactly which ones apply and each row names
    /// its own mechanism. One word for "permissions" would be the collapse
    /// PRODUCT.md's second principle says this product has already paid for.
    ///
    /// Ink measured against the ground it actually lands on. The card is `amber`
    /// at 7 % over `screen`, compositing to #1F1D19 — 1.13:1 against the ground
    /// it sits on, which is why DESIGN.md's tinted card also carries a 34 %
    /// outline: #5E4D2E, 2.31:1 on `screen`. That outline is a container's
    /// boundary rather than a control's, so it owes the hairline's job and not
    /// the 3:1 threshold, and it still sits well above the 1.5:1 `stroke` is
    /// already drawn at elsewhere in this system. On the #1F1D19 card face:
    /// `amber` is 10.18:1, `textSecondary` 7.12:1, and `edge` 3.04:1 — which is
    /// the 3:1 the grant button's boundary owes, being the only thing that marks
    /// it. `textTertiary` is 3.99:1 there, under the threshold, so the quiet row
    /// for a permission that *is* granted takes `textSecondary` instead.
    private func permissionNoticeView(_ state: Permissions) -> NSView {
        let rows: [(name: String, granted: Bool, loss: String, grant: Selector)] = [
            (
                "SCREEN RECORDING",
                state.screen,
                "ScreenCaptureKit has no frames to send, so the phone shows an empty picture.",
                #selector(requestScreenPermission)
            ),
            (
                "ACCESSIBILITY",
                state.accessibility,
                "Taps and keystrokes are posted and silently dropped. The pointer never moves.",
                #selector(requestAccessibilityPermission)
            ),
        ]
        // A row with something to do is as tall as the outlined action inside it
        // — 44, the system's own floor for one. A row that is only reporting a
        // permission already granted is one 9pt line and no more.
        let heights: [CGFloat] = rows.map { $0.granted ? 16 : 44 }
        // 18 card padding · 14 heading · 12 · row · 12 · row · 18. Every gap is
        // on the ladder: `card` padding, `md` between blocks.
        let padding: CGFloat = 18
        // 556. Derived from the band rather than written down, because this card
        // spans it: the two of them agreed by hand until now, and a margin pass
        // that moved one would have left the other measuring against a width the
        // card no longer had.
        let inner = Pane.band - 2 * padding
        let height = padding + 14 + 12 + heights[0] + 12 + heights[1] + padding

        // The card fills the band, so its edges are the digit run's and the QR
        // row's — 20 to 612, the strongest vertical line this window has. It
        // sits at 226, a 20pt `gutter` above the QR cards, and the window's
        // height is what absorbs the rest.
        //
        // The band is 592 either side of the margin change, so every string
        // measured inside this card still has exactly the room it was measured
        // against; only the card's origin moved.
        let card = NSView(frame: NSRect(x: Pane.margin, y: Stack.below, width: Pane.band, height: height))
        card.fill(
            Palette.amber.withAlphaComponent(0.07),
            radius: Palette.Radius.card,
            edge: Palette.amber.withAlphaComponent(0.34)
        )

        // Which of the two losses actually apply, derived from the measured pair
        // rather than written once and made to cover both. Stated up front
        // because an amber card under six digits reads as "the code is bad"
        // until something says otherwise, and the code is fine.
        let lost: String
        switch (state.screen, state.accessibility) {
        case (false, false): lost = "THE PICTURE AND THE INPUT WILL NOT"
        case (false, true): lost = "THE PICTURE WILL NOT"
        // Exhaustive over the pair rather than `default`, because the fourth
        // combination is both-granted and a `default` would print "THE INPUT
        // WILL NOT" about a Mac that has everything it needs. It cannot arrive
        // — nothing is drawn at all in that case — and it is not going to
        // arrive silently either.
        case (true, _): lost = "THE INPUT WILL NOT"
        }
        let heading = NSTextField(labelWithString: "PAIRING WILL WORK · \(lost)")
        // 300.43pt at its longest, of the 556 the card's padding leaves.
        heading.frame = NSRect(x: padding, y: height - 32, width: inner, height: 14)
        heading.font = .monospacedSystemFont(ofSize: 9, weight: .medium)
        heading.textColor = Palette.amber
        card.addSubview(heading)

        // "GRANT…" measures 33.38pt at 9pt mono; 16pt of padding each side puts
        // the button at 66 and leaves 478 for the text beside it. The longest
        // label is 166.90 and the longer sentence 450.93, so both hold one line
        // — which they have to, since a 44pt row has room for exactly two.
        let buttonFont = NSFont.monospacedSystemFont(ofSize: 9, weight: .regular)
        let buttonWidth = ("GRANT…" as NSString)
            .size(withAttributes: [.font: buttonFont]).width.rounded(.up) + 32
        let textWidth = inner - buttonWidth - 12

        var y = height - 32 - 12
        for (index, row) in rows.enumerated() {
            y -= heights[index]
            if row.granted {
                // Named, and quiet. It is here so the reader can tell which of
                // the two to go and fix — the absence of a row would leave that
                // ambiguous with nobody having checked — and in neutral ink
                // rather than jade, because nothing is being congratulated.
                let label = NSTextField(labelWithString: "\(row.name) · GRANTED")
                label.frame = NSRect(x: padding, y: y, width: inner, height: 16)
                label.font = .monospacedSystemFont(ofSize: 9, weight: .medium)
                label.textColor = Palette.textSecondary
                card.addSubview(label)
                y -= 12
                continue
            }

            let label = NSTextField(labelWithString: "\(row.name) · NOT GRANTED")
            label.frame = NSRect(x: padding, y: y + 25, width: textWidth, height: 14)
            label.font = .monospacedSystemFont(ofSize: 9, weight: .medium)
            label.textColor = Palette.amber
            card.addSubview(label)

            let loss = NSTextField(labelWithString: row.loss)
            loss.frame = NSRect(x: padding, y: y + 5, width: textWidth, height: 18)
            loss.font = .systemFont(ofSize: 12)
            loss.textColor = Palette.textSecondary
            card.addSubview(loss)

            // The same two actions the menu's own entries call. Nothing about
            // asking for a grant is duplicated here — only where it is asked
            // from, which is now the window that caused the need.
            let button = NSButton(title: "", target: self, action: row.grant)
            button.isBordered = false
            button.frame = NSRect(x: padding + inner - buttonWidth, y: y, width: buttonWidth, height: 44)
            button.attributedTitle = NSAttributedString(
                string: "GRANT…",
                attributes: [.font: buttonFont, .foregroundColor: Palette.textSecondary]
            )
            // The whole 44pt box is the target, not the six characters of ink in
            // it — the Hit Shape Rule, which this codebase has paid for four
            // times. An outlined control's corner is `control`, and at 44 tall
            // the 16 survives being drawn rather than clamping to a capsule.
            button.outline(Palette.edge, radius: Palette.Radius.control)
            // "GRANT…" alone is ambiguous read out of its row.
            button.toolTip = "Grant \(row.name.capitalized)"
            card.addSubview(button)

            y -= 12
        }

        return card
    }

    /// Grow the window rather than crush the notice into the room it has.
    ///
    /// The band the layout already leaves between the digits and the QR cards is
    /// 112pt tall, and the 20pt `gutter` above and below a block makes that 72pt
    /// of usable room. The notice measures 134 with one permission missing and
    /// 162 with both, so it does not fit — and the answer to that is not a
    /// smaller type size or a dropped sentence, both of which would be this
    /// window lying about how much it has to say. Three heights: 474 granted,
    /// 536 with one missing, 564 with both. It shrinks back the moment a grant
    /// lands, which is the clearest thing this window can do to confirm one.
    ///
    /// The top edge is held still and the growth goes downward, because the six
    /// digits are what the reader is looking at and a title bar that jumps under
    /// their eyes is the worse trade.
    private func resizePairingWindow(noticeHeight: CGFloat) {
        guard let window = pairingWindow else { return }
        // Both numbers come off `Stack`, which is where the arithmetic that
        // produces them is written down: `fixed` is everything that is not the
        // notice, and `granted` is that plus an empty band. The floor is not a
        // guard against a small notice — it is the statement that this window
        // never gets shorter than the layout it has when both grants are in.
        let wanted = noticeHeight == 0
            ? Stack.granted
            : max(Stack.granted, noticeHeight + Stack.fixed)
        // With `.fullSizeContentView` these are the same number and this is
        // zero, but deriving it means the window keeps working if that style
        // mask ever changes.
        let chrome = window.frame.height - window.contentRect(forFrameRect: window.frame).height
        let frame = window.frame
        guard abs(frame.height - (wanted + chrome)) > 0.5 else { return }
        window.setFrame(
            NSRect(
                x: frame.minX,
                y: frame.maxY - wanted - chrome,
                width: frame.width,
                height: wanted + chrome
            ),
            display: true
        )
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
    /// This was missing, and without it the whole menu was a photograph. The
    /// header was built once in `init`, before `router` had even been set, and
    /// then drawn unchanged for the life of the process: a Mac that had been
    /// paired and streaming for an hour still read `CLIENT 0 · SCREENS 0` and
    /// whichever path was live at launch. Everything below it was stale the same
    /// way — the two permission rows were probed once, so a grant made from this
    /// very menu still read "Grant Screen Recording…" afterwards, and the device
    /// list never gained a phone that paired while the process was running.
    ///
    /// An open is the only moment any of it is worth taking, and this costs
    /// nothing while the menu is closed. That is the point rather than a
    /// convenience: this app is a menu bar item beside a live video stream, and
    /// a header kept current on a timer is a process woken sixty times a minute
    /// to redraw something nobody is looking at.
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
