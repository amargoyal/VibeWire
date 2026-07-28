import Foundation
import Security

/// Where device trust is persisted.
///
/// The Keychain is the right home for this and stays the default. But it has a
/// failure mode that will bite anyone running a self-built host: keychain items
/// carry an ACL bound to the *code identity* that created them, and an ad-hoc
/// signed binary gets a new identity on every rebuild. The first read of an
/// existing item by a new identity then goes through a full authorization
/// round trip in `securityd` — measured here at 5 to 27 seconds — and in the
/// worst case an "allow access?" prompt a UI-less menu-bar agent can never
/// answer. Every read after that one, in that process and in later ones, comes
/// back in microseconds.
///
/// So every Keychain call runs with a deadline, and it is a generous one: the
/// point is to survive a wedged prompt, not to give up on a slow-but-working
/// keychain. Calls are async, so waiting costs latency rather than a blocked
/// thread. `TrustStore.prime()` pays that first-touch cost at launch, off the
/// path of any pairing or auth request.
///
/// A read distinguishes "no such item" (nil) from "could not tell" (throws).
/// Conflating the two is what made a slow keychain look like an empty one.
protocol SecretStore: Sendable {
    /// nil means the item genuinely is not there. A throw means the store
    /// could not answer — callers must not read that as an empty store.
    func read(account: String) async throws -> Data?
    func write(account: String, data: Data) async throws
    func delete(account: String) async
}

// MARK: - Keychain

struct KeychainStore: SecretStore {
    let service: String

    /// Long enough for the worst first-touch authorization observed on a
    /// rebuilt binary, short enough that an unanswerable prompt does not take
    /// the session with it.
    private static let deadline: TimeInterval = 45

    /// Anything past this is worth saying out loud — it means the item was
    /// written by an older build of this binary.
    private static let slowCall: TimeInterval = 2

    func read(account: String) async throws -> Data? {
        let outcome: (OSStatus, Data?)? = await withDeadline("read \(account)") {
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
                kSecReturnData as String: true,
                kSecMatchLimit as String: kSecMatchLimitOne,
            ]
            var result: CFTypeRef?
            let status = SecItemCopyMatching(query as CFDictionary, &result)
            return (status, result as? Data)
        }

        guard let (status, data) = outcome else { throw SecretStoreError.timedOut }
        switch status {
        case errSecSuccess: return data
        case errSecItemNotFound: return nil
        default: throw SecretStoreError.keychain(status)
        }
    }

    func write(account: String, data: Data) async throws {
        let outcome: OSStatus? = await withDeadline("write \(account)") {
            let base: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
            ]
            let attributes: [String: Any] = [
                kSecValueData as String: data,
                kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
            ]

            let status = SecItemUpdate(base as CFDictionary, attributes as CFDictionary)
            guard status == errSecItemNotFound else { return status }

            var insert = base
            insert.merge(attributes) { current, _ in current }
            let added = SecItemAdd(insert as CFDictionary, nil)
            // Someone added it between the update and the add. Update wins.
            guard added == errSecDuplicateItem else { return added }
            return SecItemUpdate(base as CFDictionary, attributes as CFDictionary)
        }

        guard let outcome else { throw SecretStoreError.timedOut }
        guard outcome == errSecSuccess else { throw SecretStoreError.keychain(outcome) }
    }

    func delete(account: String) async {
        _ = await withDeadline("delete \(account)") { () -> Bool in
            let query: [String: Any] = [
                kSecClass as String: kSecClassGenericPassword,
                kSecAttrService as String: service,
                kSecAttrAccount as String: account,
            ]
            SecItemDelete(query as CFDictionary)
            return true
        }
    }

    /// Runs the keychain call on a background thread and gives up if it does
    /// not come back. Returns nil on timeout.
    ///
    /// The blocked thread is abandoned rather than cancelled — there is no way
    /// to cancel a `SecItem*` call in flight — but it holds nothing the rest of
    /// the host needs. The waiting happens off the cooperative pool, so a slow
    /// keychain suspends the caller instead of starving Swift concurrency.
    private func withDeadline<Value: Sendable>(
        _ label: String,
        _ body: @escaping @Sendable () -> Value
    ) async -> Value? {
        let value: Value? = await withCheckedContinuation { continuation in
            DispatchQueue.global(qos: .userInitiated).async {
                let semaphore = DispatchSemaphore(value: 0)
                let box = Guarded<Value?>(nil)

                DispatchQueue.global(qos: .userInitiated).async {
                    let value = body()
                    box.withLock { $0 = value }
                    semaphore.signal()
                }

                let started = Date()
                let arrived = semaphore.wait(timeout: .now() + Self.deadline) == .success
                let elapsed = Date().timeIntervalSince(started)
                if !arrived {
                    Log.warn(.app, "keychain \(label) gave up after \(Int(Self.deadline))s")
                    Log.warn(.app, "  macOS is asking to authorize this build — look for a")
                    Log.warn(.app, "  keychain prompt from SecurityAgent and choose Always Allow.")
                } else if elapsed >= Self.slowCall {
                    let took = String(format: "%.1f", elapsed)
                    Log.warn(.app, "keychain \(label) took \(took)s — item predates this build of the host")
                }
                continuation.resume(returning: arrived ? box.read { $0 } : nil)
            }
        }
        return value
    }
}

// MARK: - File fallback

/// A 0600 file in the host's own config directory. Not as good as the Keychain
/// — it is protected by file permissions and FileVault rather than by the
/// keychain's own ACLs — so the host says so out loud when it lands here.
struct FileStore: SecretStore {
    let directory: URL

    private func url(for account: String) -> URL {
        directory.appendingPathComponent("\(account).secret")
    }

    func read(account: String) async throws -> Data? {
        let target = url(for: account)
        guard FileManager.default.fileExists(atPath: target.path) else { return nil }
        return try Data(contentsOf: target)
    }

    func write(account: String, data: Data) async throws {
        let target = url(for: account)
        try data.write(to: target, options: [.atomic, .completeFileProtection])
        try FileManager.default.setAttributes(
            [.posixPermissions: 0o600],
            ofItemAtPath: target.path
        )
    }

    func delete(account: String) async {
        try? FileManager.default.removeItem(at: url(for: account))
    }
}

// MARK: - Layering

/// Reads fall through to a second store; writes go to the first.
///
/// Without this, changing stores silently orphans every paired device. The
/// probe below can pick the file store on one launch and the keychain on the
/// next, and a host that reads only its chosen store answers `unknown device`
/// to phones whose keys are sitting intact in the other one. Falling through
/// turns a store switch into a migration.
struct LayeredSecretStore: SecretStore {
    let primary: SecretStore
    let secondary: SecretStore

    /// Whether a successful write should drop the secondary's copy.
    ///
    /// True when the keychain is primary: the file copy is a migration
    /// leftover, and leaving it there would let a revoked device come back if
    /// the keychain ever went quiet again. False in the degraded direction —
    /// the file store is usually primary only because a rebuild made the
    /// keychain slow, and that is no reason to destroy the keychain record.
    let clearsSecondaryOnWrite: Bool

    /// A store that could not answer once will not start answering, and every
    /// retry costs a full deadline. Ask it at most once.
    private let secondaryGaveUp = Guarded(false)

    func read(account: String) async throws -> Data? {
        var primaryFailure: Error?
        do {
            if let data = try await primary.read(account: account) { return data }
        } catch {
            primaryFailure = error
            Log.warn(.app, "primary secret store failed for '\(account)': \(error)")
        }

        guard !secondaryGaveUp.read({ $0 }) else {
            if let primaryFailure { throw primaryFailure }
            return nil
        }

        // Deliberately not a do/catch around the whole tail: rethrowing the
        // primary's failure from inside the `do` would be caught by its own
        // `catch` and reported as a fallback failure.
        let recovered: Data?
        do {
            recovered = try await secondary.read(account: account)
        } catch {
            secondaryGaveUp.withLock { $0 = true }
            Log.warn(.app, "fallback secret store failed for '\(account)': \(error)")
            throw primaryFailure ?? error
        }

        guard let data = recovered else {
            if let primaryFailure { throw primaryFailure }
            return nil
        }

        Log.warn(.app, "recovered '\(account)' from the fallback secret store; migrating it back")
        try? await primary.write(account: account, data: data)
        return data
    }

    func write(account: String, data: Data) async throws {
        try await primary.write(account: account, data: data)
        guard clearsSecondaryOnWrite, !secondaryGaveUp.read({ $0 }) else { return }
        await secondary.delete(account: account)
    }

    /// Deletes reach both stores: revoking a device has to destroy the key, not
    /// leave a copy in whichever store the host is not reading today.
    func delete(account: String) async {
        await primary.delete(account: account)
        guard !secondaryGaveUp.read({ $0 }) else { return }
        await secondary.delete(account: account)
    }
}

enum SecretStoreError: Error, CustomStringConvertible {
    case keychain(OSStatus)
    case timedOut

    var description: String {
        switch self {
        case .keychain(let status):
            let message = SecCopyErrorMessageString(status, nil) as String? ?? "unknown"
            return "keychain error \(status): \(message)"
        case .timedOut:
            return "keychain did not respond"
        }
    }
}

// MARK: - Selection

enum SecretStoreFactory {
    /// Probes the Keychain once at startup. If it does not answer — almost
    /// always an unanswerable ACL prompt from a rebuilt binary — the host reads
    /// and writes the file store instead and explains why.
    ///
    /// The probe is deliberately weak evidence: it writes a *new* item, which
    /// the calling binary always owns and can always read quickly, so it proves
    /// the keychain is reachable and nothing more. It cannot tell whether an
    /// item written by an older build will come back fast. That case is handled
    /// by the deadline and by `TrustStore.prime()`, not here.
    static func make(service: String, fallbackDirectory: URL) async -> SecretStore {
        let keychain = KeychainStore(service: service)
        let file = FileStore(directory: fallbackDirectory)
        let probeAccount = "probe"
        let probe = Data("ok".utf8)

        // The probe below only proves the keychain can serve an item this
        // binary just wrote. Reading an item an *older* build wrote puts up a
        // SecurityAgent prompt, and if nobody is at the Mac to answer it the
        // host stalls 45s per attempt and never warms. `VIBEWIRE_SECRET_STORE=file`
        // skips the keychain entirely, which is what makes the host runnable
        // unattended — over SSH, in a test run, or on a Mac nobody is sitting at.
        if ProcessInfo.processInfo.environment["VIBEWIRE_SECRET_STORE"] == "file" {
            Log.warn(.app, "VIBEWIRE_SECRET_STORE=file — device trust stored on disk, keychain untouched")
            return file
        }

        do {
            try await keychain.write(account: probeAccount, data: probe)
            let readBack = try await keychain.read(account: probeAccount)
            await keychain.delete(account: probeAccount)
            if readBack == probe {
                Log.info(.app, "device trust stored in the login keychain")
                return LayeredSecretStore(
                    primary: keychain,
                    secondary: file,
                    clearsSecondaryOnWrite: true
                )
            }
            Log.warn(.app, "keychain probe returned unexpected data; using file store")
        } catch {
            Log.warn(.app, "keychain unavailable (\(error)); using file store")
            Log.warn(.app, "  this usually means a rebuilt, ad-hoc-signed binary lost its keychain ACL.")
            Log.warn(.app, "  to go back to the keychain: security delete-generic-password -s \(service)")
        }

        return LayeredSecretStore(
            primary: file,
            secondary: keychain,
            clearsSecondaryOnWrite: false
        )
    }
}
