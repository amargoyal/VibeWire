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
    private var rotationTimer: Timer?
    private var lastLoggedBrowserURL: String?

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

    func rebuildMenu() {
        let menu = NSMenu()

        let header = NSMenuItem()
        header.view = readoutHeader()
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        Task { [weak self] in
            guard let self else { return }
            let status = await transport.status()
            await MainActor.run {
                self.lastStatus = status
                header.view = self.readoutHeader()
            }
        }

        menu.addItem(withTitle: "Show pairing code…", action: #selector(openPairing), keyEquivalent: "p")
            .target = self

        menu.addItem(.separator())

        // Permission state, because a missing grant is the single most likely
        // reason the phone shows a black screen or dead input.
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

        Task { [weak self] in
            guard let self else { return }
            let devices = (try? await trust.all()) ?? []
            await MainActor.run {
                if devices.isEmpty {
                    let none = NSMenuItem(title: "   None yet", action: nil, keyEquivalent: "")
                    none.isEnabled = false
                    menu.insertItem(none, at: menu.index(of: devicesHeader) + 1)
                } else {
                    for (offset, device) in devices.enumerated() {
                        let item = NSMenuItem(title: "   \(device.name)", action: nil, keyEquivalent: "")
                        item.isEnabled = false
                        menu.insertItem(item, at: menu.index(of: devicesHeader) + 1 + offset)
                    }
                }
            }
        }

        menu.addItem(.separator())
        menu.addItem(withTitle: "Quit VibeWire", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")

        statusItem.menu = menu
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

        let container = NSView(frame: NSRect(x: 0, y: 0, width: 268, height: 96))

        let name = NSTextField(labelWithString: Host.current().localizedName ?? "This Mac")
        name.frame = NSRect(x: 34, y: 66, width: 150, height: 18)
        name.font = .systemFont(ofSize: 13, weight: .semibold)
        container.addSubview(name)

        let dot = NSView(frame: NSRect(x: 16, y: 71, width: 7, height: 7))
        dot.wantsLayer = true
        dot.layer?.cornerRadius = 3.5
        dot.layer?.backgroundColor = (serving == nil ? Palette.textTertiary : Palette.green).cgColor
        container.addSubview(dot)

        let state = NSTextField(labelWithString: serving == nil ? "STARTING" : "SERVING")
        state.frame = NSRect(x: 168, y: 68, width: 86, height: 14)
        state.alignment = .right
        state.font = .monospacedSystemFont(ofSize: 9, weight: .medium)
        state.textColor = serving == nil ? Palette.textTertiary : Palette.green
        container.addSubview(state)

        let values: [(String, String)] = [
            ("CLIENT", (serving?.clientAttached ?? false) ? "1" : "0"),
            ("SCREENS", "\(serving?.streams ?? 0)"),
            ("PATH", pathWord(lastStatus)),
        ]

        for (index, value) in values.enumerated() {
            let tile = NSView(
                frame: NSRect(x: 14 + CGFloat(index) * 82, y: 12, width: 78, height: 46)
            )
            tile.wantsLayer = true
            tile.layer?.cornerRadius = 9
            tile.layer?.backgroundColor = Palette.raised2.cgColor

            let label = NSTextField(labelWithString: value.0)
            label.frame = NSRect(x: 10, y: 27, width: 60, height: 12)
            label.font = .monospacedSystemFont(ofSize: 8, weight: .regular)
            label.textColor = Palette.textTertiary
            tile.addSubview(label)

            let reading = NSTextField(labelWithString: value.1)
            reading.frame = NSRect(x: 10, y: 7, width: 60, height: 18)
            reading.font = .monospacedSystemFont(
                ofSize: value.1.count > 3 ? 11 : 14,
                weight: .regular
            )
            reading.textColor = Palette.text
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
        if pairingWindow == nil {
            let window = NSWindow(
                contentRect: NSRect(x: 0, y: 0, width: 640, height: 474),
                styleMask: [.titled, .closable, .fullSizeContentView],
                backing: .buffered,
                defer: false
            )
            window.title = "VibeWire"
            window.titlebarAppearsTransparent = true
            window.isReleasedWhenClosed = false
            window.appearance = NSAppearance(named: .darkAqua)
            window.backgroundColor = Palette.screen
            window.center()

            let content = NSView(frame: NSRect(x: 0, y: 0, width: 640, height: 474))
            content.fill(Palette.screen, radius: 0)

            let title = NSTextField(labelWithString: "Pair a device")
            title.frame = NSRect(x: 28, y: 414, width: 300, height: 30)
            title.font = .systemFont(ofSize: 24, weight: .semibold)
            title.textColor = Palette.text
            content.addSubview(title)

            // The dial says at a glance whether there is time to finish typing;
            // the number beside it is the same fact for anyone who wants it
            // exactly.
            let dial = RotationDial(frame: NSRect(x: 470, y: 421, width: 13, height: 13))
            content.addSubview(dial)
            self.rotationDial = dial

            let countdown = NSTextField(labelWithString: "")
            countdown.frame = NSRect(x: 490, y: 419, width: 122, height: 16)
            countdown.alignment = .right
            countdown.font = .monospacedSystemFont(ofSize: 9, weight: .regular)
            countdown.textColor = Palette.amber
            content.addSubview(countdown)
            self.countdownField = countdown

            // Six boxes rather than one 44pt string: the digits are read one at
            // a time and typed one at a time, and a run of six characters on a
            // Mac is a serial number until it is boxed.
            var boxes: [NSTextField] = []
            let boxWidth: CGFloat = 92
            let boxGap: CGFloat = 8
            for index in 0..<6 {
                let x = 28 + CGFloat(index) * (boxWidth + boxGap)
                let box = NSView(frame: NSRect(x: x, y: 318, width: boxWidth, height: 78))
                box.fill(Palette.raised, radius: 14)
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
            let cardWidth: CGFloat = 291
            for (index, spec) in [
                ("iPHONE APP", "Scan in VibeWire. Custom scheme — a browser cannot open it.", Palette.accent),
                ("ANY BROWSER", "Scan with the phone's own camera. Pairs on load.", Palette.green),
            ].enumerated() {
                let x = 28 + CGFloat(index) * (cardWidth + 14)
                let card = NSView(frame: NSRect(x: x, y: 92, width: cardWidth, height: 114))
                card.fill(Palette.raised, radius: Palette.Radius.control)
                content.addSubview(card)

                let plate = NSView(frame: NSRect(x: 14, y: 14, width: 86, height: 86))
                plate.fill(.white, radius: Palette.Radius.small)
                card.addSubview(plate)

                let image = NSImageView(frame: NSRect(x: 6, y: 6, width: 74, height: 74))
                image.imageScaling = .scaleProportionallyUpOrDown
                plate.addSubview(image)

                let caption = NSTextField(labelWithString: spec.0)
                caption.frame = NSRect(x: 112, y: 76, width: 166, height: 14)
                caption.font = .monospacedSystemFont(ofSize: 9, weight: .medium)
                caption.textColor = spec.2
                card.addSubview(caption)

                let blurb = NSTextField(wrappingLabelWithString: spec.1)
                blurb.frame = NSRect(x: 112, y: 18, width: 166, height: 52)
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
            let servingDot = NSView(frame: NSRect(x: 28, y: 54, width: 7, height: 7))
            servingDot.fill(Palette.green, radius: 3.5)
            content.addSubview(servingDot)

            let listening = NSTextField(labelWithString: "")
            listening.frame = NSRect(x: 44, y: 50, width: 420, height: 16)
            listening.font = .monospacedSystemFont(ofSize: 9, weight: .regular)
            listening.textColor = Palette.textTertiary
            content.addSubview(listening)
            self.listeningField = listening

            let version = NSTextField(labelWithString: "HOST \(Config.hostVersion)")
            version.frame = NSRect(x: 452, y: 50, width: 160, height: 16)
            version.alignment = .right
            version.font = .monospacedSystemFont(ofSize: 9, weight: .regular)
            version.textColor = Palette.textSecondary
            content.addSubview(version)

            window.contentView = content
            pairingWindow = window
        }

        update(for: code)
        pairingWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func update(for code: PairingService.ActiveCode) {
        let digits = Array(code.value)
        for (index, field) in digitFields.enumerated() {
            field.stringValue = index < digits.count ? String(digits[index]) : ""
        }
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
            let host = status.tailscaleAddress
                ?? status.lanAddress
                ?? status.tailscaleDNSName
                ?? "127.0.0.1"
            let port = Config.loadSettings().port
            // The QR carries everything the phone needs to skip typing.
            let payload = "vibewire://pair?host=\(host)&port=\(port)&code=\(code.value)"
            qrView?.image = Self.qrImage(from: payload)

            updateBrowserQR(code: code, status: status, lanHost: host, port: port)
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
        port: UInt16
    ) {
        // Stated once, from the same status the QR was built from, so the line
        // under the cards can never disagree with the address inside them.
        // Whichever address of this Mac the phone has the best chance of reaching.
        // The tunnel wins when it is up, because it works from cellular and a tailnet
        // address does not.
        let origin: String
        let reach: String
        if let tunnel = status.cloudflareHostname, status.cloudflareRunning {
            origin = tunnel.hasSuffix("/") ? String(tunnel.dropLast()) : tunnel
            reach = "WORKS ON CELLULAR"
        } else {
            origin = "http://\(lanHost):\(port)"
            reach = status.tailscaleAddress == nil ? "SAME NETWORK ONLY" : "ON THE TAILNET"
        }

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
            guard let built = components.url?.absoluteString else { return }
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
        browserBlurb?.stringValue = "Scan with the phone's own camera. Pairs on load. \(reach.capitalized)."

        listeningField?.stringValue = [
            "LISTENING ON :\(port)",
            status.tailscaleRunning ? "TAILSCALE UP" : "TAILSCALE DOWN",
            status.cloudflareRunning ? "TUNNEL ON" : "TUNNEL OFF",
        ]
        .joined(separator: " · ")
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
                if let current = await self.pairing.currentCode() {
                    self.update(for: current)
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

private extension NSMenu {
    @discardableResult
    func addItem(withTitle title: String, action: Selector?, keyEquivalent: String) -> NSMenuItem {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: keyEquivalent)
        addItem(item)
        return item
    }
}
