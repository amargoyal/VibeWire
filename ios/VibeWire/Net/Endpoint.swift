import Foundation

/// Where the Mac is, parsed once so every caller agrees about it.
///
/// This phone used to store an address and a port and build `http://…` and
/// `ws://…` from them by hand, which quietly decided that the Mac is always
/// reachable over plain HTTP on a numbered port. That is true of the LAN address
/// and of the tailnet one. It is not true of the Cloudflare Tunnel, which is
/// `https` on 443 and is the only address that works from cellular when the
/// phone is not on the tailnet — so the app could not use the one path that was
/// built for being away from the Mac.
///
/// The web client already had this type (`web/src/net/endpoint.ts`) and this is
/// deliberately the same shape, down to the defaulting rules: a bare `mac:8787`
/// means HTTP, an explicit `https://…` means 443 unless it says otherwise, and
/// the canonical origin never carries a port that its scheme already implies.
struct Endpoint: Equatable, Sendable {
    /// Canonical origin, no trailing slash: `http://192.168.1.24:8787`.
    let origin: String
    /// Hostname alone, for display and for the "the Mac moved" field.
    let host: String
    /// The port actually in play, including the 443 a bare `https://` implies.
    let port: Int
    let secure: Bool

    var baseURL: URL? { URL(string: origin) }

    /// `ws://` or `wss://` for the same origin. A `wss` socket is what makes the
    /// tunnel usable: an `https` endpoint refuses a plain `ws` upgrade.
    var socketURL: URL? {
        guard let scheme = origin.range(of: "://") else { return nil }
        return URL(string: "ws" + (secure ? "s" : "") + origin[scheme.lowerBound...] + "/v1/socket")
    }

    /// What to show a reader. The scheme and the default port are noise on the
    /// common case and load-bearing on the tunnel, so they are printed only when
    /// they are not the ordinary answer.
    var display: String {
        secure || port != 8787 ? origin : host
    }
}

enum EndpointError: Error, LocalizedError {
    case unusable(String)
    case unsupportedScheme(String)

    var errorDescription: String? {
        switch self {
        case .unusable(let input): return "Not a usable address: \(input)"
        case .unsupportedScheme(let scheme):
            return "VibeWire speaks HTTP, not \(scheme)."
        }
    }
}

extension Endpoint {
    /// Parses what was typed, scanned, or stored. Accepts a bare address, an
    /// address with a port, or a full URL — the tunnel hostname is something
    /// that gets pasted, and demanding it be split into a host and a port is a
    /// trap with no upside.
    static func parse(_ input: String, fallbackPort: Int = 8787) throws -> Endpoint {
        var trimmed = input.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard !trimmed.isEmpty else { throw EndpointError.unusable(input) }

        // A bare `mac:8787` is not a URL — `URLComponents` reads `mac:` as the
        // scheme — so anything without one is given a scheme it cannot mistake.
        let hasScheme = trimmed.range(
            of: "^[a-zA-Z][a-zA-Z0-9+.-]*://",
            options: .regularExpression
        ) != nil
        let candidate = hasScheme ? trimmed : "http://\(trimmed)"

        guard let components = URLComponents(string: candidate),
              let host = components.host, !host.isEmpty
        else { throw EndpointError.unusable(input) }

        let scheme = (components.scheme ?? "http").lowercased()
        guard scheme == "http" || scheme == "https" else {
            throw EndpointError.unsupportedScheme(scheme)
        }

        let secure = scheme == "https"
        // An explicit port wins. A bare `https://tunnel` means 443 and must not
        // have 8787 bolted onto it; a bare `192.168.1.24` with no scheme at all
        // means the port the pairing screen is showing.
        let port = components.port ?? (hasScheme ? (secure ? 443 : 80) : fallbackPort)
        let implied = secure ? 443 : 80
        let origin = "\(scheme)://\(host)" + (port == implied ? "" : ":\(port)")

        return Endpoint(origin: origin, host: host, port: port, secure: secure)
    }

    /// The same parse, for strings that came off the wire rather than off a
    /// keyboard — a candidate list is not worth failing a connection over.
    static func lenient(_ input: String) -> Endpoint? {
        try? parse(input)
    }

    /// Candidate origins in the order they should be dialled, with duplicates
    /// and unparseable entries dropped.
    ///
    /// Order is the whole point: the tunnel is put first by the host because it
    /// is the one address that answers from anywhere, and the LAN address last
    /// because it is the one that answers fastest when it answers at all. What
    /// this function guarantees is only that the list stays in the order it was
    /// given and that nothing is tried twice.
    static func normalise(_ origins: [String]) -> [String] {
        var seen = Set<String>()
        var ordered: [String] = []
        for entry in origins {
            guard let endpoint = lenient(entry), !seen.contains(endpoint.origin) else { continue }
            seen.insert(endpoint.origin)
            ordered.append(endpoint.origin)
        }
        return ordered
    }
}

/// What the pairing QR carries, from either generation of host.
///
/// A current host writes `origin` and `alt` — full origins, the one that works
/// from anywhere first. Every host before this one wrote `host` and `port`, an
/// address on a numbered port and nothing else. Both are read here, in one
/// place, so the scanner and the cold-launch URL handler cannot disagree about
/// what a link means.
struct PairingLink {
    let origin: String?
    let alternatesField: String?
    let host: String?
    let portField: String?

    init(origin: String?, alternates: String?, host: String?, port: String?) {
        self.origin = origin.flatMap { $0.isEmpty ? nil : $0 }
        self.alternatesField = alternates
        self.host = host.flatMap { $0.isEmpty ? nil : $0 }
        self.portField = port
    }

    var port: Int { portField.flatMap(Int.init) ?? 8787 }

    /// The address to try first.
    var address: String? { origin ?? host }

    /// Everything else worth trying, in the order the Mac gave them, with the
    /// legacy `host`/`port` pair kept on the end — it is usually the tailnet or
    /// LAN address, and it is the fastest of the three when the phone is on it.
    var alternates: [String] {
        var offered = (alternatesField ?? "")
            .split(separator: ",")
            .map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty }
        if let host, origin != nil {
            offered.append("http://\(host):\(port)")
        }
        return Endpoint.normalise(offered)
    }
}
