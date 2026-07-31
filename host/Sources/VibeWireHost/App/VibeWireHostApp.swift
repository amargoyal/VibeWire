import AppKit
import Foundation

/// Menu-bar agent. No dock icon, no main window — the Mac side is a service.
@main
struct VibeWireHostApp {
    static func main() {
        let application = NSApplication.shared
        let delegate = AppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.accessory)
        application.run()
    }
}

@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    private var server: HTTPServer?
    private var router: HostRouter?
    private var menuBar: MenuBarController?
    private var transport: TransportManager?
    private var system: SystemServices?
    private var heartbeat: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        let settings = Config.loadSettings()

        let trust = TrustStore()
        let pairing = PairingService(trust: trust)
        let catalog = DisplayCatalog()
        let injector = InputInjector()
        let system = SystemServices()
        let telemetry = Telemetry()
        let claude = ClaudeBridge()
        let transport = TransportManager(port: settings.port)

        let router = HostRouter(
            trust: trust,
            pairing: pairing,
            catalog: catalog,
            injector: injector,
            system: system,
            telemetry: telemetry,
            claude: claude,
            transport: transport,
            settings: settings
        )

        let server = HTTPServer(port: settings.port, router: router)
        router.server = server
        server.onFatal = { detail in
            Task { @MainActor in
                // The host had started — it had been serving, possibly for
                // hours. Headlining that as "could not start" collapses two
                // states with two different answers into one sentence, which is
                // the defect this product has already paid for once.
                self.presentFatal(
                    headline: "VibeWire stopped serving",
                    detail: "The listener on port \(settings.port) closed.\n\n\(detail)"
                )
            }
        }

        do {
            try server.start()
        } catch {
            presentFatal(
                headline: "VibeWire could not start",
                detail: "VibeWire could not open port \(settings.port).\n\n\(error)"
            )
            return
        }

        self.server = server
        self.router = router
        self.transport = transport
        self.system = system
        let menuBar = MenuBarController(pairing: pairing, trust: trust, transport: transport)
        // The three values above the menu items come from the router, and the
        // menu is rebuilt each time it opens, so this is a read rather than a
        // subscription.
        menuBar.router = router
        self.menuBar = menuBar

        observeSleepAndWake(system: system)

        // One second is enough to keep the condition report honest without
        // burning battery on either end.
        heartbeat = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            Task { @MainActor in await router.tick() }
        }

        // The first keychain read after a rebuild can take tens of seconds.
        // Spend that at launch rather than inside the first pairing request.
        Task { await trust.prime() }

        Task {
            await transport.refresh()
            if settings.relayOverInternet {
                await transport.startCloudflareTunnel()
            }
            await Self.logStartupSummary(transport: transport, settings: settings)

            // `--pair` opens the pairing window at launch and prints the code.
            // This is not a bypass: the code still rotates every 60 s and still
            // requires someone at the Mac to read it, whether from the menu bar
            // or from the terminal they started the host in.
            if CommandLine.arguments.contains("--pair") {
                let code = await pairing.beginPairing()
                Log.info(.app, "pairing open — code \(code.value) (rotates in 60s)")
                self.menuBar?.present(code: code)
                self.menuBar?.rebuildMenu()
            }
        }

        warnAboutMissingPermissions()
    }

    func applicationWillTerminate(_ notification: Notification) {
        heartbeat?.invalidate()
        server?.stop()
        system?.preventSleep(false)
        let transport = self.transport
        Task { await transport?.stopCloudflareTunnel() }
    }

    // MARK: Sleep tracking

    /// Feeds the ASLEEP · 1H 12M readout on 02C. The host cannot answer while
    /// the Mac is asleep, so it records the moment it went down and reports the
    /// duration once it is back.
    private func observeSleepAndWake(system: SystemServices) {
        let center = NSWorkspace.shared.notificationCenter
        center.addObserver(
            forName: NSWorkspace.willSleepNotification,
            object: nil,
            queue: .main
        ) { _ in
            system.noteWillSleep()
            Log.info(.app, "mac going to sleep")
        }
        let transport = self.transport
        center.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: nil,
            queue: .main
        ) { _ in
            system.noteDidWake()
            Log.info(.app, "mac woke")
            Task { await transport?.refresh() }
        }
    }

    // MARK: Diagnostics

    private static func logStartupSummary(transport: TransportManager, settings: HostSettings) async {
        let status = await transport.status()
        Log.info(.app, "VibeWire host \(Config.hostVersion) on \(Config.machineName)")
        Log.info(.app, "  port          \(settings.port)")
        Log.info(.app, "  lan           \(status.lanAddress ?? "unavailable")")
        Log.info(.app, "  tailscale     \(status.tailscaleRunning ? (status.tailscaleDNSName ?? status.tailscaleAddress ?? "up") : "not running")")
        Log.info(.app, "  relay         \(settings.relayOverInternet ? "enabled" : "off")")
        Log.info(.app, "  screen rec    \(DisplayCatalog.hasScreenRecordingPermission() ? "granted" : "MISSING")")
        Log.info(.app, "  accessibility \(InputInjector.hasAccessibilityPermission() ? "granted" : "MISSING")")

        if TransportManager.tailscaleBinary() == nil {
            Log.warn(.app, "tailscale not found — remote access will fall back to the relay")
        }
    }

    private func warnAboutMissingPermissions() {
        let screen = DisplayCatalog.hasScreenRecordingPermission()
        let accessibility = InputInjector.hasAccessibilityPermission()
        guard !screen || !accessibility else { return }

        // Ask once at launch rather than failing silently when the phone
        // connects and finds a black picture with dead input.
        if !accessibility { InputInjector.requestAccessibilityPermission() }
        if !screen { DisplayCatalog.requestScreenRecordingPermission() }
    }

    /// The headline is a parameter because the two ways this app dies are not
    /// the same event: a port that would not open at launch, and a listener
    /// that closed after serving. One is answered by finding what holds the
    /// port, the other by reopening the app.
    private func presentFatal(headline: String, detail: String) {
        let alert = NSAlert()
        alert.alertStyle = .critical
        alert.messageText = headline
        alert.informativeText = detail
        alert.runModal()
        NSApp.terminate(nil)
    }
}
