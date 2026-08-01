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
/// handshake steps and the seven panes behind them.
///
/// What the status item opens is no longer an `NSMenu` either. It is
/// `StatusPanel`, a window drawn in the app's own colours, because a menu can
/// only be a list of titles and the reason to open this is almost always to read
/// something — is it serving, is a phone on it, what is the link doing. This
/// file is what stands between the two: it owns the status item, gathers the
/// readings the panel draws, and turns a row the user clicked into the call that
/// answers it.
///
/// The header order is deliberate and unchanged. The machine, whether a client
/// is attached, and which path it is on come before any action.
@MainActor
final class MenuBarController: NSObject {
    private let statusItem: NSStatusItem
    private let pairing: PairingService
    private let trust: TrustStore
    private let transport: TransportManager
    private let telemetry: Telemetry
    private let panel = StatusPanel()
    /// Ticks the panel's readings while it is on screen, and nothing at all
    /// while it is not.
    private var refresh: Timer?

    /// The window this opens. Owned by the app delegate, not by the status item —
    /// a menu bar item is a way in, not the thing itself.
    weak var dashboard: DashboardWindow?
    /// Read only for the values the panel draws. Weak because the router
    /// outlives nothing here and the status item must never keep it alive.
    weak var router: HostRouter?

    /// The last transport status this controller was told about.
    ///
    /// `TransportManager` is an actor and the panel is built on the main actor,
    /// so it draws from the last known answer and asks for a fresh one behind
    /// it. A panel that blocked the main thread on an actor hop to say "DIRECT"
    /// would be a worse trade than one that is occasionally a second stale.
    private var lastStatus: TransportManager.Status?
    /// The last link measurement, held for the same reason and refreshed on the
    /// same tick.
    private var lastLink: Telemetry.Snapshot?
    /// The last answer the keychain gave about paired devices.
    ///
    /// Three states rather than two. `nil` is "never asked", `.failure` is "the
    /// keychain did not answer", and an empty array is "no devices paired". The
    /// middle one is the fact this used to print as the last one — `TrustStore`
    /// is careful to keep them apart, its own note explains that caching a failed
    /// read as an empty set once made every paired phone come back `unknown
    /// device` for the rest of the process, and this keeps them apart too.
    private var lastDevices: Result<[TrustedDevice], Error>?

    init(pairing: PairingService, trust: TrustStore, transport: TransportManager, telemetry: Telemetry) {
        self.statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        self.pairing = pairing
        self.trust = trust
        self.transport = transport
        self.telemetry = telemetry
        super.init()
        configureButton()
        panel.onAction = { [weak self] action in self?.handle(action) }
        panel.onClose = { [weak self] in
            self?.statusItem.button?.highlight(false)
            self?.refresh?.invalidate()
            self?.refresh = nil
        }
        // Warms the readings that have to cross an actor, so the first open has
        // something true to draw rather than a panel of dashes.
        refreshCachedReadings()
    }

    private func configureButton() {
        guard let button = statusItem.button else { return }
        // The app's own mark rather than a borrowed SF Symbol. A status item is
        // found by shape at a glance across a crowded bar, and a stock symbol is
        // the one shape that cannot be recognised — some other app is already
        // wearing it.
        button.image = WaveMark.statusItemImage()
        button.toolTip = "VibeWire"
        button.target = self
        button.action = #selector(toggle)
    }

    @objc private func toggle() {
        guard let button = statusItem.button else { return }
        panel.toggle(from: button, readings: readings())
        // Held open, the panel is an instrument and has to tick. Closed, it costs
        // nothing: the timer only exists while there is something to redraw.
        refresh?.invalidate()
        refresh = nil
        guard panel.isOpen else { return }
        // Highlighted for as long as it is showing, the way a menu bar item that
        // has a menu down does it for free.
        //
        // A tick late, because opening the panel activates the app and the
        // status item redraws itself as part of that — set inline, the highlight
        // is painted and then immediately painted over.
        DispatchQueue.main.async { button.highlight(true) }
        refresh = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self else { return }
                // Reached through `self` rather than through the timer the block
                // was handed: that one is task-isolated here, and invalidating it
                // from the main actor is the race the compiler is describing.
                guard self.panel.isOpen else {
                    self.refresh?.invalidate()
                    self.refresh = nil
                    self.statusItem.button?.highlight(false)
                    return
                }
                self.panel.refresh(self.readings())
                self.refreshCachedReadings()
            }
        }
        refreshCachedReadings()
    }

    // MARK: What the panel draws

    /// Everything on the panel, as it stands right now.
    ///
    /// Nothing here may block. The three values that would have to cross an
    /// actor to be taken are read from cache and asked for again behind the
    /// open; the rest is either a live in-process probe or a lock read, and
    /// cheap enough to pay for each time.
    private func readings() -> StatusPanel.Readings {
        let serving = router?.serving
        let facts = router?.facts

        // Permission state, because a missing grant is the single most likely
        // reason the phone shows a black picture or dead input.
        //
        // Probed on every open rather than once at launch. Both calls are
        // in-process and neither prompts, and granting a permission is something
        // the user does *from this panel* and then comes straight back to: read
        // once, it would go on answering "Grant Screen Recording" for the rest
        // of the process to someone who had just granted it.
        let screen = DisplayCatalog.hasScreenRecordingPermission()
        let accessibility = InputInjector.hasAccessibilityPermission()

        let pairedCount: Int?
        switch lastDevices {
        case .some(.success(let list)): pairedCount = list.count
        // A keychain that did not answer and a Mac with nothing paired to it are
        // different facts, and only one of them is a number.
        case .some(.failure), .none: pairedCount = nil
        }

        // The cap is a ceiling only when it is actually being applied — the
        // setting is on *and* the phone said it is on a metered radio. A LAN
        // session drawn against a cellular preference would be a bar measuring
        // something nobody is enforcing.
        let ceiling: Double? = {
            guard let facts, facts.settings.capOnCellular, facts.phoneOnExpensiveLink else { return nil }
            return facts.settings.cellularCeilingMbps
        }()

        return StatusPanel.Readings(
            machine: Config.machineName,
            serving: serving != nil,
            screenRecording: screen,
            accessibility: accessibility,
            clientAttached: serving?.clientAttached ?? false,
            attachedName: facts?.attachedDeviceName,
            attachedSince: facts?.attachedSince,
            streams: serving?.streams ?? 0,
            path: Self.pathWord(lastStatus),
            rttMillis: lastLink?.rttMillis,
            rttHistory: lastLink?.rttHistory ?? [],
            outMbps: lastLink?.downMbps ?? 0,
            ceilingMbps: ceiling,
            pairedCount: pairedCount,
            uptime: Date().timeIntervalSince(Config.launchedAt)
        )
    }

    /// Re-asks for the readings the main thread cannot take itself, and leaves
    /// them where the next draw will find them.
    private func refreshCachedReadings() {
        Task { [weak self] in
            guard let self else { return }
            let status = await transport.status()
            let link = await telemetry.snapshot()
            let devices: Result<[TrustedDevice], Error>
            do {
                devices = .success(try await trust.all())
            } catch {
                devices = .failure(error)
            }
            self.lastStatus = status
            self.lastLink = link
            self.lastDevices = devices
        }
    }

    private static func pathWord(_ status: TransportManager.Status?) -> String {
        guard let status else { return "—" }
        if status.cloudflareRunning, status.cloudflareHostname != nil { return "TUNNEL" }
        if status.tailscaleRunning { return "DIRECT" }
        return "LAN"
    }

    // MARK: Answering a row

    private func handle(_ action: StatusPanel.Action) {
        statusItem.button?.highlight(false)
        switch action {
        case .openDashboard:
            dashboard?.show()
        case .openPane(let pane):
            dashboard?.show(pane: pane)
        case .pair:
            Task { @MainActor in await beginPairing() }
        case .grantScreenRecording:
            requestScreenPermission()
        case .grantAccessibility:
            InputInjector.requestAccessibilityPermission()
        case .quit:
            NSApp.terminate(nil)
        }
    }

    /// Opens a code and the window that shows it, in that order.
    ///
    /// The order matters: the window polls for state, and a window that opened
    /// first would draw one frame of "no code" before the first poll landed.
    ///
    /// Shared with `--pair`, which wants exactly this and nothing else.
    func beginPairing() async {
        let code = await pairing.beginPairing()
        Log.info(.app, "pairing open — code \(code.value) (rotates in \(Int(Config.pairingCodeLifetime))s)")
        dashboard?.show(pane: "pair")
    }

    private func requestScreenPermission() {
        DisplayCatalog.requestScreenRecordingPermission()
        // The grant only takes effect after a relaunch; say so rather than
        // letting the user wonder why the warning did not clear.
        let alert = NSAlert()
        alert.messageText = "Screen Recording"
        alert.informativeText = """
        Enable VibeWire in System Settings → Privacy & Security → Screen Recording, \
        then quit and reopen VibeWire.
        """
        alert.runModal()
    }
}
