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

    /// How far a handshake has actually got.
    ///
    /// The dashboard draws four steps while a device is pairing, and every one
    /// of them is a thing this service observes rather than a stage in an
    /// animation: the code was accepted, the key was a well-formed Ed25519
    /// public key, the trust record was written, and a socket authenticated
    /// with that device's key. The fourth arrives seconds after the other
    /// three and from a different caller, which is exactly why it is worth
    /// drawing separately.
    struct Progress: Sendable {
        var codeAcceptedAt: Date?
        var keysExchangedAt: Date?
        var trustStoredAt: Date?
        var socketOpenedAt: Date?
        var deviceId: String?
        var deviceName: String?
        /// Why the handshake stopped, when it stopped after the code was taken.
        ///
        /// A stalled step list is not self-explanatory: three ticks and a fourth
        /// that never arrives reads as "still working" forever. This is what the
        /// window prints instead, and it is only ever set for a failure that
        /// happened *after* the digits were accepted — a wrong code is not a
        /// failed handshake, it is a handshake that never started.
        var failure: String?

        /// 0…4, for the step list.
        var step: Int {
            var reached = 0
            if codeAcceptedAt != nil { reached = 1 }
            if keysExchangedAt != nil { reached = 2 }
            if trustStoredAt != nil { reached = 3 }
            if socketOpenedAt != nil { reached = 4 }
            return reached
        }

        var wire: [String: Any] {
            var payload: [String: Any] = ["step": step]
            payload["deviceId"] = deviceId
            payload["deviceName"] = deviceName
            payload["failure"] = failure
            return payload
        }
    }

    private var active: ActiveCode?
    private var failedAttempts = 0
    private var lockedUntil: Date?
    private var nonces: [String: Date] = [:]
    private let trust: TrustStore
    private var progress = Progress()
    /// A name the person at the Mac typed before showing the code.
    ///
    /// It wins over the name the device reports about itself, because the point
    /// of typing "iPhone — bedside" here is to tell two identical iPhones apart
    /// in the list, and both of them call themselves "iPhone".
    private var assignedName: String?
    /// Whether a successful pair consumes the window.
    ///
    /// Off by default and off in every path but the dashboard's explicit
    /// REUSABLE choice: a code that survives being used is a code that can pair
    /// a second device nobody asked for, and the default has to be the safe one.
    /// It still rotates every 60 s and still dies with the window either way.
    private var reusable = false

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
    func beginPairing(name: String? = nil, reusable: Bool = false) -> ActiveCode {
        let code = Self.generateCode()
        let active = ActiveCode(value: code, issuedAt: Date())
        self.active = active
        failedAttempts = 0
        lockedUntil = nil
        progress = Progress()
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines)
        assignedName = (trimmed?.isEmpty ?? true) ? nil : trimmed
        self.reusable = reusable
        onCodeChange?(active)
        Log.info(
            .net,
            "pairing window open, code rotates in \(Int(Config.pairingCodeLifetime))s"
                + (reusable ? " (reusable)" : "")
        )
        return active
    }

    func endPairing() {
        guard active != nil || progress.step > 0 else { return }
        active = nil
        progress = Progress()
        assignedName = nil
        reusable = false
        onCodeChange?(nil)
        Log.info(.net, "pairing window closed")
    }

    /// The handshake as it stands, for the dashboard's step list.
    func currentProgress() -> Progress { progress }

    /// Whether a code is on screen right now, which is the same question as
    /// "would a `POST /v1/pair` be entertained at all".
    var isPairing: Bool { active != nil }

    var isReusable: Bool { reusable }

    var pendingName: String? { assignedName }

    /// Called by the router when a socket authenticates. Completes the fourth
    /// step, and only for the device this window just paired — a reconnect from
    /// a phone paired last week is not this handshake finishing.
    func noteSocketOpened(deviceId: String) {
        guard progress.deviceId == deviceId, progress.socketOpenedAt == nil else { return }
        progress.socketOpenedAt = Date()
        Log.info(.net, "handshake complete for \(deviceId): socket open")
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
    ///
    /// The mode and the typed name are carried across, because a rotation is
    /// the same pairing attempt with fresh digits — not a new one. Rotating
    /// through the plain `beginPairing()` would quietly turn a reusable code
    /// into a one-shot and drop the name the operator typed, sixty seconds
    /// after they typed it.
    func rotateIfNeeded() {
        guard let active else { return }
        guard !active.isValid else { return }
        beginPairing(name: assignedName, reusable: reusable)
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
        progress.codeAcceptedAt = Date()

        guard publicKey.count == 32,
              (try? Curve25519.Signing.PublicKey(rawRepresentation: publicKey)) != nil
        else { throw PairError.badPublicKey }
        progress.keysExchangedAt = Date()

        // The name typed at the Mac wins, then the one the device reports about
        // itself, then a last resort that is at least not empty.
        let resolvedName = assignedName
            ?? (deviceName.isEmpty ? nil : deviceName)
            ?? "Device"

        let device = TrustedDevice(
            id: UUID().uuidString,
            name: resolvedName,
            kind: deviceKind,
            publicKey: publicKey,
            pairedAt: Date(),
            lastSeenAt: Date()
        )
        do {
            try await trust.add(device)
        } catch {
            // Named on the way past rather than swallowed. The step list is the
            // only place this is visible: the phone gets a 503 and a code, and
            // the person holding it is usually not the person at the Mac.
            progress.failure = "The login keychain would not store the trust record."
            Log.error(.net, "pairing accepted the code but could not store trust: \(error)")
            throw error
        }
        progress.trustStoredAt = Date()
        progress.deviceId = device.id
        progress.deviceName = device.name

        let identity = try await trust.hostIdentity()
        let hostId = try await trust.hostId()

        // A successful pair consumes the window unless the operator asked for a
        // reusable one; the next device otherwise needs a fresh code. The
        // progress record survives either way — it is what the step list draws,
        // and clearing it here would blank the window at the moment it finally
        // had something to report.
        if !reusable {
            self.active = nil
            onCodeChange?(nil)
            Log.info(.net, "pairing window closed (code spent)")
        } else {
            // A reusable code has to forget the name it was given, or the second
            // device to take it inherits the first one's label.
            assignedName = nil
        }

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
