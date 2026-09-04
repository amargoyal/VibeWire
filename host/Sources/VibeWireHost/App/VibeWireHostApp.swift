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
    private var dashboard: DashboardWindow?
    private var transport: TransportManager?
    private var system: SystemServices?
    private var heartbeat: Timer?

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Touched here so the uptime readout counts from launch rather than
        // from whenever something first asked. `static let` is lazy.
        _ = Config.launchedAt
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
        let menuBar = MenuBarController(
            pairing: pairing,
            trust: trust,
            transport: transport,
            telemetry: telemetry
        )
        // The three values above the menu items come from the router, and the
        // menu refills itself every time it opens — `MenuBarController` is its
        // own `NSMenuDelegate` — so this is a read rather than a subscription.
        //
        // That delegate was the missing half of this sentence until recently:
        // the comment described the intent, nothing implemented it, and the
        // header sat frozen at whatever it read a moment after launch.
        menuBar.router = router

        // The Mac app's one window. Built now rather than on first open so the
        // menu item has something to hand to; nothing loads until it is shown.
        let dashboard = DashboardWindow(port: settings.port)
        menuBar.dashboard = dashboard
        self.dashboard = dashboard
        self.menuBar = menuBar

        observeSleepAndWake(system: system)

        // One second is enough to keep the condition report honest without
        // burning battery on either end.
        //
        // The code rotation rides this timer now. It used to ride a second timer
        // owned by the pairing window, which meant the code only rotated while
        // that window was on screen — reasonable when the window was the only
        // thing that could show a code, and wrong now that the code is one pane
        // of a window that may be sitting on the Log. `rotateIfNeeded` is a
        // no-op when no pairing is open, so this costs a lock read a second.
        heartbeat = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
            Task { @MainActor in
                await router.tick()
                await pairing.rotateIfNeeded()
                // Not inside `tick()`: that returns early with no phone
                // connected, and the addresses the QR hands out have to be
                // current precisely when nothing is connected yet. Rate-limited
                // to once every ten seconds by the manager itself.
                await transport.refreshIfStale()
            }
        }

        // Claude's output goes to both surfaces from here on: the attached
        // phone, and the dashboard's poll. Set once, rather than per socket.
        Task { await router.activateClaudeFanOut() }

        // The first keychain read after a rebuild can take tens of seconds.
        // Spend that at launch rather than inside the first pairing request.
        Task { await trust.prime() }

        Task {
            await transport.refresh()
            if settings.relayOverInternet {
                await transport.startCloudflareTunnel()
            }
            await Self.logStartupSummary(transport: transport, settings: settings)

            // `--pair` opens the window on the pairing pane at launch and prints
            // the code. This is not a bypass: the code still rotates every 60 s
            // and still requires someone at the Mac to read it, whether from the
            // window or from the terminal they started the host in.
            if CommandLine.arguments.contains("--pair") {
                await self.menuBar?.beginPairing()
            }

            // `--dashboard` is the same window with no code showing, for when
            // the reason to open it is to look rather than to pair.
            if CommandLine.arguments.contains("--dashboard") {
                self.dashboard?.show()
            }

            // `--dashboard-url` prints the address, key and all, for opening the
            // dashboard in a browser instead of the app's own window.
            //
            // Opt-in and nothing else. The key is the whole control surface of
            // this Mac, so it is never logged as a matter of course — printing it
            // on every launch would put it in every terminal scrollback and every
            // redirected log file for the sake of a case that comes up rarely.
            if CommandLine.arguments.contains("--dashboard-url") {
                FileHandle.standardOutput.write(
                    Data("http://127.0.0.1:\(settings.port)/dashboard/\(Config.dashboardKey)/\n".utf8)
                )
            }
        }

        warnAboutMissingPermissions()
    }

    func applicationWillTerminate(_ notification: Notification) {
        heartbeat?.invalidate()
        server?.stop()
        system?.preventSleep(false)
        // Synchronously, here, on the way out. This used to be a `Task` that
        // awaited the actor, and the process exited before it ran — so every
        // quit left cloudflared alive with a public hostname pointing at a port
        // this host no longer served, and the next launch found its metrics port
        // taken by the ghost of the last one.
        transport?.terminateTunnelNow()
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
