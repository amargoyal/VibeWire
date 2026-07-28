import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins

/// The Mac side of the handshake: "MENU BAR → LONGARM → PAIR".
///
/// Deliberately small. The Mac is not where this product lives; it just needs
/// to hand over a code, report whether the two permissions are granted, and
/// stay out of the way.
@MainActor
final class MenuBarController: NSObject {
    private let statusItem: NSStatusItem
    private let pairing: PairingService
    private let trust: TrustStore
    private let transport: TransportManager
    private var pairingWindow: NSWindow?
    private var codeField: NSTextField?
    private var qrView: NSImageView?
    private var countdownField: NSTextField?
    private var rotationTimer: Timer?

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

        let header = NSMenuItem(title: "VibeWire \(Config.hostVersion)", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        menu.addItem(withTitle: "Pair a device…", action: #selector(openPairing), keyEquivalent: "p")
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
                contentRect: NSRect(x: 0, y: 0, width: 360, height: 460),
                styleMask: [.titled, .closable],
                backing: .buffered,
                defer: false
            )
            window.title = "Pair with VibeWire"
            window.isReleasedWhenClosed = false
            window.center()

            let content = NSView(frame: window.contentLayoutRect)

            let instruction = NSTextField(labelWithString: "Type these six digits into VibeWire on your phone.")
            instruction.frame = NSRect(x: 24, y: 400, width: 312, height: 34)
            instruction.alignment = .center
            instruction.maximumNumberOfLines = 2
            instruction.font = .systemFont(ofSize: 12)
            instruction.textColor = .secondaryLabelColor
            content.addSubview(instruction)

            let codeField = NSTextField(labelWithString: code.value)
            codeField.frame = NSRect(x: 24, y: 340, width: 312, height: 52)
            codeField.alignment = .center
            codeField.font = .monospacedSystemFont(ofSize: 44, weight: .medium)
            content.addSubview(codeField)
            self.codeField = codeField

            let countdown = NSTextField(labelWithString: "")
            countdown.frame = NSRect(x: 24, y: 314, width: 312, height: 18)
            countdown.alignment = .center
            countdown.font = .monospacedSystemFont(ofSize: 10, weight: .regular)
            countdown.textColor = .tertiaryLabelColor
            content.addSubview(countdown)
            self.countdownField = countdown

            let qr = NSImageView(frame: NSRect(x: 80, y: 60, width: 200, height: 200))
            qr.imageScaling = .scaleProportionallyUpOrDown
            content.addSubview(qr)
            self.qrView = qr

            let hint = NSTextField(labelWithString: "Or scan the code with the phone's camera.")
            hint.frame = NSRect(x: 24, y: 28, width: 312, height: 18)
            hint.alignment = .center
            hint.font = .systemFont(ofSize: 11)
            hint.textColor = .tertiaryLabelColor
            content.addSubview(hint)

            window.contentView = content
            pairingWindow = window
        }

        update(for: code)
        pairingWindow?.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func update(for code: PairingService.ActiveCode) {
        codeField?.stringValue = code.value
        countdownField?.stringValue = "ROTATES IN \(code.secondsRemaining)S"

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
            // The QR carries everything the phone needs to skip typing.
            let payload = "vibewire://pair?host=\(host)&port=\(Config.loadSettings().port)&code=\(code.value)"
            qrView?.image = Self.qrImage(from: payload)
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
