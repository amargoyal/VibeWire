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
        var host: String
        var port: Int
        var pairedAt: Date

        var baseURL: URL? {
            URL(string: "http://\(host):\(port)")
        }

        var socketURL: URL? {
            URL(string: "ws://\(host):\(port)/v1/socket")
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
