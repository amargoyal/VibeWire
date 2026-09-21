import Foundation
import SystemConfiguration

/// Which of this Mac's addresses a phone could dial, best first.
///
/// The pairing QR carries one of these, and getting it wrong is not a cosmetic
/// failure: the phone opens the address, nothing answers, and the screen it is
/// looking at cannot tell a wrong address from a Mac that is switched off. So
/// the order is decided here rather than left to whatever `getifaddrs`
/// enumerates first.
enum NetworkAddresses {
    /// Every IPv4 address a device on one of this Mac's networks could reach,
    /// the one macOS is actually routing through first.
    ///
    /// Three kinds of address are dropped rather than ranked. A `169.254`
    /// address is what an interface assigns itself when nothing answered DHCP,
    /// so it names a network of one. A point-to-point interface is a VPN or a
    /// tunnel, which Tailscale and the relay are reported as in their own
    /// right. And anything that is not `en` is an Apple internal: `awdl` is
    /// AirDrop, `llw` is low-latency Wi-Fi, `anpi` is the internal bridge to
    /// the phone-like coprocessor, `bridge` is Internet Sharing. A phone can
    /// reach none of them.
    static func lan() -> [String] {
        var found: [(interface: String, address: String)] = []
        var pointer: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&pointer) == 0, let first = pointer else { return [] }
        defer { freeifaddrs(pointer) }

        var current: UnsafeMutablePointer<ifaddrs>? = first
        while let interface = current {
            defer { current = interface.pointee.ifa_next }
            let flags = Int32(interface.pointee.ifa_flags)
            guard flags & IFF_UP == IFF_UP,
                  flags & IFF_RUNNING == IFF_RUNNING,
                  flags & IFF_LOOPBACK == 0,
                  flags & IFF_POINTOPOINT == 0
            else { continue }
            guard let addr = interface.pointee.ifa_addr,
                  addr.pointee.sa_family == UInt8(AF_INET) else { continue }

            let name = String(cString: interface.pointee.ifa_name)
            guard name.hasPrefix("en") else { continue }

            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(
                addr, socklen_t(addr.pointee.sa_len),
                &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST
            ) == 0 else { continue }

            let address = String(cString: host)
            guard !address.hasPrefix("169.254."), !address.isEmpty else { continue }
            guard !found.contains(where: { $0.address == address }) else { continue }
            found.append((interface: name, address: address))
        }

        // The interface carrying the default route is the one this Mac is on;
        // the rest are a second Wi-Fi, a USB-tethered phone, or a dock that is
        // plugged in and connected to nothing. They stay on the list, because a
        // phone may be on one of them, and they stay behind the primary.
        let primary = primaryInterface()
        return found
            .sorted { left, right in
                if (left.interface == primary) != (right.interface == primary) {
                    return left.interface == primary
                }
                return left.interface < right.interface
            }
            .map(\.address)
    }

    /// The interface macOS is routing off this Mac through, as the system
    /// itself reports it. No subprocess, no parsing of `route` output.
    static func primaryInterface() -> String? {
        guard let store = SCDynamicStoreCreate(nil, "com.vibewire.host" as CFString, nil, nil),
              let global = SCDynamicStoreCopyValue(
                  store, "State:/Network/Global/IPv4" as CFString
              ) as? [String: Any]
        else { return nil }
        return global["PrimaryInterface"] as? String
    }
}
