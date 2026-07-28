import Foundation
import CryptoKit
import Security

/// A phone that has completed the handshake. Screens 07A/07B render this list.
struct TrustedDevice: Codable, Sendable, Identifiable {
    let id: String
    var name: String
    var kind: String          // "phone" | "tablet"
    var publicKey: Data       // raw Ed25519, 32 bytes
    var pairedAt: Date
    var lastSeenAt: Date?

    var isStale: Bool {
        guard let lastSeenAt else { return true }
        return Date().timeIntervalSince(lastSeenAt) > 60 * 60 * 24 * 7
    }
}

/// Device trust lives in the login Keychain, not a plist, so revoking really
/// destroys the key rather than leaving it recoverable on disk.
///
/// The whole set is stored as one generic-password item. There are at most a
/// handful of devices, and a single item makes revoke-all atomic.
///
/// The cache holds *successful* loads only. Caching a failed read as an empty
/// set is what made a slow keychain look like a wiped one — every phone came
/// back `unknown device` for the rest of the process. A read that could not be
/// answered throws; nothing here treats it as "no devices".
actor TrustStore {
    private var cache: [String: TrustedDevice]?
    private let hostIdentityAccount = "host-identity"
    private let devicesAccount = "devices"

    /// Resolved on first use rather than in `init`, because choosing a store
    /// probes the keychain and that must not happen on the main thread at
    /// launch. See SecretStore for why this is not always the keychain.
    private let injectedStore: SecretStore?
    private var resolvedStore: SecretStore?
    /// Resolution and loading both suspend, and an actor lets other calls in
    /// while they do. Without a shared in-flight task, every caller that
    /// arrives during the first (slow) keychain read starts its own — which
    /// probed the keychain twice concurrently and made the two probes collide.
    private var storeResolution: Task<SecretStore, Never>?
    private var inflightLoad: Task<[String: TrustedDevice], Error>?

    init(store: SecretStore? = nil) {
        self.injectedStore = store
    }

    /// Pays the slow first-touch keychain cost at launch instead of during a
    /// pairing or auth request. Safe to call more than once.
    ///
    /// It retries, because the first read after a rebuild can outlast even a
    /// generous deadline: macOS puts up a SecurityAgent authorization prompt,
    /// and the read only comes back once that has been settled. Once it has,
    /// every later read is instant — so a retry that lands after the grant
    /// costs milliseconds, and giving up after one attempt would leave the host
    /// rejecting known phones until someone restarted it.
    func prime() async {
        let started = Date()
        for attempt in 1...6 {
            do {
                _ = try await loadDevices()
                _ = try await hostIdentity()
                let elapsed = Date().timeIntervalSince(started)
                if elapsed >= 1 {
                    Log.info(.app, "trust store warmed in \(String(format: "%.1f", elapsed))s")
                }
                return
            } catch {
                Log.warn(.app, "trust store unreadable (attempt \(attempt)): \(error)")
                try? await Task.sleep(nanoseconds: 2_000_000_000)
            }
        }
        Log.error(.app, "trust store still unreadable — paired phones will be rejected until it answers")
    }

    // MARK: Host identity

    /// The Mac's own Ed25519 key. Generated once and reused, so a phone can pin
    /// it and notice if it ever changes.
    ///
    /// A new key is minted only when the store says the item is genuinely
    /// absent. On a read failure this throws instead: silently rotating the
    /// host identity because the keychain was slow would break every phone that
    /// pinned the old one.
    func hostIdentity() async throws -> Curve25519.Signing.PrivateKey {
        if let raw = try await store().read(account: hostIdentityAccount) {
            return try Curve25519.Signing.PrivateKey(rawRepresentation: raw)
        }
        let key = Curve25519.Signing.PrivateKey()
        try await store().write(account: hostIdentityAccount, data: key.rawRepresentation)
        Log.info(.net, "generated new host identity key")
        return key
    }

    func hostId() async throws -> String {
        let key = try await hostIdentity()
        // Stable, derived, and not the raw key: a short fingerprint of the
        // public key formatted as a UUID-ish string.
        let digest = SHA256.hash(data: key.publicKey.rawRepresentation)
        return digest.prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: Devices

    func all() async throws -> [TrustedDevice] {
        try await loadDevices().values.sorted { $0.pairedAt < $1.pairedAt }
    }

    func device(id: String) async throws -> TrustedDevice? {
        try await loadDevices()[id]
    }

    func add(_ device: TrustedDevice) async throws {
        var devices = try await loadDevices()
        devices[device.id] = device
        try await persist(devices)
        Log.info(.net, "paired device \(device.name) (\(device.id))")
    }

    func touch(id: String) async {
        guard var devices = try? await loadDevices(), var device = devices[id] else { return }
        device.lastSeenAt = Date()
        devices[id] = device
        try? await persist(devices)
    }

    /// Returns true when something was actually removed, so callers can decide
    /// whether to sever a live socket.
    @discardableResult
    func revoke(id: String) async throws -> Bool {
        var devices = try await loadDevices()
        guard devices.removeValue(forKey: id) != nil else { return false }
        try await persist(devices)
        Log.info(.net, "revoked device \(id)")
        return true
    }

    func revokeAll() async throws -> [String] {
        let devices = try await loadDevices()
        try await persist([:])
        Log.info(.net, "revoked all devices (\(devices.count))")
        return Array(devices.keys)
    }

    // MARK: Storage

    private func store() async -> SecretStore {
        if let resolvedStore { return resolvedStore }
        if let injectedStore {
            resolvedStore = injectedStore
            return injectedStore
        }
        if let storeResolution { return await storeResolution.value }

        let resolution = Task {
            await SecretStoreFactory.make(
                service: Config.keychainService,
                fallbackDirectory: Config.configDirectory
            )
        }
        storeResolution = resolution
        let store = await resolution.value
        resolvedStore = store
        return store
    }

    /// Throws when the store could not be read. Every mutating path goes
    /// through here first, so a failed read can never be mistaken for an empty
    /// set and then written back over the real one.
    private func loadDevices() async throws -> [String: TrustedDevice] {
        if let cache { return cache }
        if let inflightLoad { return try await inflightLoad.value }

        let load = Task { () throws -> [String: TrustedDevice] in
            guard let data = try await store().read(account: devicesAccount) else { return [:] }
            guard let decoded = try? JSONDecoder().decode([String: TrustedDevice].self, from: data) else {
                // Present but unreadable. Never cached: pretending the set is
                // empty would let the next pairing overwrite it.
                Log.error(.app, "device trust record is corrupt (\(data.count) bytes); refusing to overwrite it")
                throw SecretStoreError.keychain(errSecDecode)
            }
            return decoded
        }
        inflightLoad = load

        defer { inflightLoad = nil }
        let devices = try await load.value
        cache = devices
        return devices
    }

    private func persist(_ devices: [String: TrustedDevice]) async throws {
        let data = try JSONEncoder().encode(devices)
        try await store().write(account: devicesAccount, data: data)
        cache = devices
    }
}

// Errors from persistence surface as `SecretStoreError`; see SecretStore.swift.
