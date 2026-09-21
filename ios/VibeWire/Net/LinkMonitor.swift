import Foundation
import Network

/// Watches what the phone is actually connected over.
///
/// The Mac cannot see the phone's radio, so "Cap on cellular" is only honest if
/// the phone says which one it is on. Without this the cap throttles LAN
/// sessions too, which is the opposite of what the setting promises.
///
/// `isExpensive` is the system's own answer for cellular and personal hotspot;
/// `isConstrained` additionally covers Low Data Mode.
@MainActor
final class LinkMonitor {
    private let monitor = NWPathMonitor()
    private var started = false

    private(set) var isExpensive = false
    private(set) var isConstrained = false
    /// Whether the phone has a usable route to anywhere at all.
    private(set) var isSatisfied = false

    /// What the current path is, as far as reaching the Mac is concerned.
    ///
    /// The two booleans above answer a different question: how much the link
    /// costs. Wi-Fi to cellular changes them, but Wi-Fi to a different Wi-Fi
    /// does not, and neither does a path dropping and coming back. All three
    /// invalidate everything the phone believes about which of the Mac's
    /// addresses answers, so the interfaces and the status are watched too.
    struct PathSignature: Equatable {
        let satisfied: Bool
        let interfaces: [String]
        /// The routers on the way out. One Wi-Fi network to another keeps the
        /// interface name, the cost and the status, and changes nothing else
        /// this framework reports — except these. Without them the walk from
        /// home Wi-Fi to café Wi-Fi is a move the phone cannot see.
        let gateways: [String]
        let expensive: Bool
        let constrained: Bool

        init(_ path: NWPath) {
            satisfied = path.status == .satisfied
            interfaces = path.availableInterfaces.map(\.name)
            gateways = path.gateways.map { "\($0)" }
            expensive = path.isExpensive
            constrained = path.isConstrained
        }
    }

    private var signature: PathSignature?

    var onChange: ((_ expensive: Bool, _ constrained: Bool) -> Void)?

    /// Fired when the route itself changed, satisfied or not.
    ///
    /// This is the one event that says "everything you knew about how to reach
    /// the Mac may have just become wrong". Walking out of the house and back
    /// in is exactly this event, twice, and until it had a listener the phone
    /// sat out both of them: the socket had already given up, and nothing asked
    /// it to try again until the app was backgrounded and opened.
    var onPathChange: ((_ satisfied: Bool) -> Void)?

    func start() {
        guard !started else { return }
        started = true

        monitor.pathUpdateHandler = { [weak self] path in
            let expensive = path.isExpensive
            let constrained = path.isConstrained
            let signature = PathSignature(path)
            Task { @MainActor [weak self] in
                guard let self else { return }
                let changed = expensive != self.isExpensive || constrained != self.isConstrained
                // The first update is what the phone started on, not a move. It
                // reports the link, so the cellular cap is right from the
                // outset, and it does not claim the network changed.
                let moved = self.signature != nil && self.signature != signature
                self.isExpensive = expensive
                self.isConstrained = constrained
                self.isSatisfied = signature.satisfied
                self.signature = signature
                // Always fire on the first update so the host learns the state
                // even when it happens to match the default.
                if changed || !self.hasReported {
                    self.hasReported = true
                    self.onChange?(expensive, constrained)
                }
                if moved { self.onPathChange?(signature.satisfied) }
            }
        }
        monitor.start(queue: DispatchQueue(label: "com.vibewire.phone.path"))
    }

    private var hasReported = false

    func stop() {
        monitor.cancel()
        started = false
    }

    /// Shown on the home screen so the transport line is specific rather than
    /// a vague "connected".
    var description: String {
        if isExpensive { return "CELLULAR" }
        if isConstrained { return "LOW DATA" }
        return "WI-FI"
    }
}
