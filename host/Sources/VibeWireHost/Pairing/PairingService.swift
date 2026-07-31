import Foundation
import CryptoKit

/// Owns the six-digit code shown in the menu bar and the challenge/response the
/// phone uses on every reconnect.
///
/// Design notes that matter for security:
/// - The code only exists while the Pair sheet is open. There is no ambient
///   always-valid code sitting on the port.
/// - Code comparison is constant time; a timing oracle on six digits is worth
///   closing when the endpoint may be Cloudflare-facing.
/// - Nonces are single-use. Replaying a captured signature does not reconnect.
actor PairingService {
    struct ActiveCode {
        let value: String
        let issuedAt: Date
        var expiresAt: Date { issuedAt.addingTimeInterval(Config.pairingCodeLifetime) }
        var isValid: Bool { Date() < expiresAt }
        var secondsRemaining: Int { max(0, Int(expiresAt.timeIntervalSinceNow.rounded())) }
    }

    private var active: ActiveCode?
    private var failedAttempts = 0
    private var lockedUntil: Date?
    private var nonces: [String: Date] = [:]
    private let trust: TrustStore

    /// Fired whenever the code rotates so the menu bar can redraw.
    var onCodeChange: (@Sendable (ActiveCode?) -> Void)?

    init(trust: TrustStore) {
        self.trust = trust
    }

    func setCodeChangeHandler(_ handler: @escaping @Sendable (ActiveCode?) -> Void) {
        onCodeChange = handler
    }

    // MARK: Code lifecycle

    @discardableResult
    func beginPairing() -> ActiveCode {
        let code = Self.generateCode()
        let active = ActiveCode(value: code, issuedAt: Date())
        self.active = active
        failedAttempts = 0
        lockedUntil = nil
        onCodeChange?(active)
        Log.info(.net, "pairing window open, code rotates in \(Int(Config.pairingCodeLifetime))s")
        return active
    }

    func endPairing() {
        active = nil
        onCodeChange?(nil)
        Log.info(.net, "pairing window closed")
    }

    func currentCode() -> ActiveCode? {
        guard let active, active.isValid else { return nil }
        return active
    }

    /// Seconds until the host will accept a code again, or nil if it accepts
    /// them now.
    ///
    /// Exposed so the pairing window can say so. The lockout does not stop the
    /// code rotating, so without this the Mac keeps counting down to a rotation
    /// while refusing every attempt for a minute — which is the one reading a
    /// user in that state would act on, and the only one not on screen.
    var lockoutRemaining: Int? {
        guard let lockedUntil, Date() < lockedUntil else { return nil }
        return max(0, Int(lockedUntil.timeIntervalSinceNow.rounded()))
    }

    /// Called on a timer while the sheet is open.
    func rotateIfNeeded() {
        guard let active else { return }
        guard !active.isValid else { return }
        beginPairing()
    }

    private static func generateCode() -> String {
        // Uniform over 000000…999999 without modulo bias.
        var value: UInt32 = 0
        repeat {
            var bytes = [UInt8](repeating: 0, count: 4)
            _ = SecRandomCopyBytes(kSecRandomDefault, 4, &bytes)
            value = bytes.withUnsafeBytes { $0.load(as: UInt32.self) }
        } while value >= (UInt32.max - (UInt32.max % 1_000_000))
        return String(format: "%06u", value % 1_000_000)
    }

    // MARK: Pair request

    enum PairError: Error {
        case notPairing
        case codeExpired
        case badCode
        case lockedOut(retryAfter: Int)
        case badPublicKey
    }

    struct PairResult {
        let device: TrustedDevice
        let hostPublicKey: Data
        let hostId: String
        let hostName: String
    }

    func pair(
        code: String,
        deviceName: String,
        deviceKind: String,
        publicKey: Data
    ) async throws -> PairResult {
        if let lockedUntil, Date() < lockedUntil {
            throw PairError.lockedOut(retryAfter: Int(lockedUntil.timeIntervalSinceNow.rounded()))
        }

        guard let active else { throw PairError.notPairing }
        guard active.isValid else { throw PairError.codeExpired }

        guard Self.constantTimeEqual(code, active.value) else {
            failedAttempts += 1
            if failedAttempts >= Config.maxPairAttempts {
                lockedUntil = Date().addingTimeInterval(Config.pairLockout)
                failedAttempts = 0
                Log.warn(.net, "pairing locked out after \(Config.maxPairAttempts) bad codes")
                throw PairError.lockedOut(retryAfter: Int(Config.pairLockout))
            }
            throw PairError.badCode
        }

        guard publicKey.count == 32,
              (try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey)) != nil
        else { throw PairError.badPublicKey }

        let device = TrustedDevice(
            id: UUID().uuidString,
            name: deviceName.isEmpty ? "iPhone" : deviceName,
            kind: deviceKind,
            publicKey: publicKey,
            pairedAt: Date(),
            lastSeenAt: Date()
        )
        try await trust.add(device)

        let identity = try await trust.hostIdentity()
        let hostId = try await trust.hostId()

        // A successful pair consumes the window; the next device needs a fresh
        // code from the menu bar.
        endPairing()

        return PairResult(
            device: device,
            hostPublicKey: identity.publicKey.rawRepresentation,
            hostId: hostId,
            hostName: Config.machineName
        )
    }

    private static func constantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
        let a = Array(lhs.utf8), b = Array(rhs.utf8)
        guard a.count == b.count else { return false }
        var diff: UInt8 = 0
        for i in 0..<a.count { diff |= a[i] ^ b[i] }
        return diff == 0
    }

    // MARK: Challenge / response

    func issueNonce() -> String {
        pruneNonces()
        var bytes = [UInt8](repeating: 0, count: 32)
        _ = SecRandomCopyBytes(kSecRandomDefault, 32, &bytes)
        let nonce = Data(bytes).base64EncodedString()
        nonces[nonce] = Date()
        return nonce
    }

    /// Verifies an Ed25519 signature over `"vibewire-auth-v1" || nonce` and
    /// burns the nonce so the same signature cannot be replayed.
    func verify(deviceId: String, nonce: String, signature: Data) async -> TrustedDevice? {
        pruneNonces()
        guard let issued = nonces[nonce] else {
            Log.warn(.net, "auth rejected: unknown or reused nonce")
            return nil
        }
        guard Date().timeIntervalSince(issued) <= Config.nonceLifetime else {
            nonces[nonce] = nil
            Log.warn(.net, "auth rejected: expired nonce")
            return nil
        }
        let known: TrustedDevice?
        do {
            known = try await trust.device(id: deviceId)
        } catch {
            // Not the same thing as an untrusted phone, and it must not read
            // like one in the log: the store could not answer at all.
            Log.error(.net, "auth deferred: trust store unavailable (\(error))")
            return nil
        }
        guard let device = known else {
            Log.warn(.net, "auth rejected: unknown device \(deviceId)")
            return nil
        }
        guard let key = try? Curve25519.Signing.PublicKey(rawRepresentation: device.publicKey),
              let nonceData = Data(base64Encoded: nonce)
        else { return nil }

        var payload = Data("vibewire-auth-v1".utf8)
        payload.append(nonceData)

        guard key.isValidSignature(signature, for: payload) else {
            Log.warn(.net, "auth rejected: bad signature from \(deviceId)")
            return nil
        }

        nonces[nonce] = nil
        await trust.touch(id: deviceId)
        return device
    }

    private func pruneNonces() {
        let cutoff = Date().addingTimeInterval(-Config.nonceLifetime)
        nonces = nonces.filter { $0.value > cutoff }
    }
}
