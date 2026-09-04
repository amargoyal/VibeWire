import Foundation
import CryptoKit
import Security
import UIKit

/// This phone's identity to the Mac.
///
/// The private key never leaves the device and is generated once. Pairing sends
/// only the public half; every later connection proves possession by signing a
/// server nonce. There is no token to steal off disk, which is what lets the
/// Cloudflare path be publicly reachable without being a liability.
enum Identity {
    private static let service = "com.vibewire.phone"
    private static let keyAccount = "device-signing-key"
    private static let hostAccount = "paired-host"

    // MARK: Signing key

    static func signingKey() throws -> Curve25519.Signing.PrivateKey {
        if let raw = read(account: keyAccount) {
            return try Curve25519.Signing.PrivateKey(rawRepresentation: raw)
        }
        let key = Curve25519.Signing.PrivateKey()
        try write(account: keyAccount, data: key.rawRepresentation)
        return key
    }

    static func publicKeyBase64() throws -> String {
        try signingKey().publicKey.rawRepresentation.base64EncodedString()
    }

    /// Signs `"vibewire-auth-v1" || nonce`, matching the host's verifier.
    static func sign(nonce: Data) throws -> Data {
        var payload = Data("vibewire-auth-v1".utf8)
        payload.append(nonce)
        return try signingKey().signature(for: payload)
    }

    static var deviceName: String {
        UIDevice.current.name
    }

    static var deviceKind: String {
        UIDevice.current.userInterfaceIdiom == .pad ? "tablet" : "phone"
    }

    // MARK: Paired host

    struct PairedHost: Codable, Equatable {
        var hostId: String
        var hostName: String
        var hostKey: String
        var deviceId: String
        /// The origin that answered last, e.g. `http://192.168.1.24:8787` or
        /// `https://four-words.trycloudflare.com`.
        var origin: String
        /// The Mac's other addresses, in the order to try them when `origin`
        /// stops answering.
        ///
        /// One Mac has up to three: the tunnel, which answers from anywhere; the
        /// tailnet address, which answers wherever Tailscale is up; and the LAN
        /// address, which answers at home and nowhere else. Storing one of them
        /// meant the phone worked on exactly the network it was paired on — it
        /// was paired at home over Wi-Fi, so it worked at home over Wi-Fi.
        var alternates: [String]
        var pairedAt: Date

        init(
            hostId: String,
            hostName: String,
            hostKey: String,
            deviceId: String,
            origin: String,
            alternates: [String] = [],
            pairedAt: Date
        ) {
            self.hostId = hostId
            self.hostName = hostName
            self.hostKey = hostKey
            self.deviceId = deviceId
            self.origin = origin
            self.alternates = alternates
            self.pairedAt = pairedAt
        }

        var endpoint: Endpoint {
            Endpoint.lenient(origin)
                ?? Endpoint(origin: "http://127.0.0.1:8787", host: "127.0.0.1", port: 8787, secure: false)
        }

        /// Every origin worth dialling for this Mac, best first.
        var candidates: [String] {
            Endpoint.normalise([origin] + alternates)
        }

        var host: String { endpoint.host }
        var port: Int { endpoint.port }
        var baseURL: URL? { endpoint.baseURL }
        var socketURL: URL? { endpoint.socketURL }

        // MARK: Codable

        /// Written with the legacy `host` and `port` beside the origin, and read
        /// back from either. A record stored by a build that predates the origin
        /// is not a reason to make someone pair again — and leaving the two old
        /// keys populated means downgrading the app does not either.
        private enum CodingKeys: String, CodingKey {
            case hostId, hostName, hostKey, deviceId, origin, alternates, pairedAt
            case legacyHost = "host"
            case legacyPort = "port"
        }

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            hostId = try container.decode(String.self, forKey: .hostId)
            hostName = try container.decode(String.self, forKey: .hostName)
            hostKey = try container.decode(String.self, forKey: .hostKey)
            deviceId = try container.decode(String.self, forKey: .deviceId)
            pairedAt = try container.decode(Date.self, forKey: .pairedAt)
            alternates = try container.decodeIfPresent([String].self, forKey: .alternates) ?? []

            if let stored = try container.decodeIfPresent(String.self, forKey: .origin),
               !stored.isEmpty {
                origin = stored
            } else {
                let host = try container.decodeIfPresent(String.self, forKey: .legacyHost)
                    ?? "127.0.0.1"
                let port = try container.decodeIfPresent(Int.self, forKey: .legacyPort) ?? 8787
                origin = "http://\(host):\(port)"
            }
        }

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(hostId, forKey: .hostId)
            try container.encode(hostName, forKey: .hostName)
            try container.encode(hostKey, forKey: .hostKey)
            try container.encode(deviceId, forKey: .deviceId)
            try container.encode(origin, forKey: .origin)
            try container.encode(alternates, forKey: .alternates)
            try container.encode(pairedAt, forKey: .pairedAt)
            try container.encode(endpoint.host, forKey: .legacyHost)
            try container.encode(endpoint.port, forKey: .legacyPort)
        }
    }

    static func loadPairedHost() -> PairedHost? {
        guard let data = read(account: hostAccount) else { return nil }
        return try? JSONDecoder().decode(PairedHost.self, from: data)
    }

    static func save(_ host: PairedHost) throws {
        try write(account: hostAccount, data: JSONEncoder().encode(host))
    }

    /// Called when the Mac revokes this device, or the user unpairs. The
    /// signing key is kept so a re-pair does not churn identity unnecessarily.
    static func forgetHost() {
        delete(account: hostAccount)
    }

    // MARK: Keychain

    private static func read(account: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var result: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess else {
            return nil
        }
        return result as? Data
    }

    private static func write(account: String, data: Data) throws {
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        let attributes: [String: Any] = [
            kSecValueData as String: data,
            // Never syncs to iCloud and never leaves this device.
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]

        let status = SecItemUpdate(base as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insert = base
            insert.merge(attributes) { current, _ in current }
            let addStatus = SecItemAdd(insert as CFDictionary, nil)
            guard addStatus == errSecSuccess else { throw IdentityError.keychain(addStatus) }
        } else if status != errSecSuccess {
            throw IdentityError.keychain(status)
        }
    }

    private static func delete(account: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: account,
        ]
        SecItemDelete(query as CFDictionary)
    }
}

enum IdentityError: Error, LocalizedError {
    case keychain(OSStatus)

    var errorDescription: String? {
        switch self {
        case .keychain(let status): return "Keychain error \(status)"
        }
    }
}
