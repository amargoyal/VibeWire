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
        let expensive: Bool
        let constrained: Bool

        init(_ path: NWPath) {
            satisfied = path.status == .satisfied
            interfaces = path.availableInterfaces.map(\.name)
            expensive = path.isExpensive
            constrained = path.isConstrained
        }
    }

    private var signature: PathSignature?

    var onChange: ((_ expensive: Bool, _ constrained: Bool) -> Void)?

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
