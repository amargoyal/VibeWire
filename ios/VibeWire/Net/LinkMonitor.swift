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

    var onChange: ((_ expensive: Bool, _ constrained: Bool) -> Void)?

    func start() {
        guard !started else { return }
        started = true

        monitor.pathUpdateHandler = { [weak self] path in
            let expensive = path.isExpensive
            let constrained = path.isConstrained
            Task { @MainActor [weak self] in
                guard let self else { return }
                let changed = expensive != self.isExpensive || constrained != self.isConstrained
                self.isExpensive = expensive
                self.isConstrained = constrained
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
