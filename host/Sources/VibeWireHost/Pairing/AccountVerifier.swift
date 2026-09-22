import Foundation
import CryptoKit

/// Who a browser says it is, once this host has checked rather than believed it.
struct VerifiedAccount: Sendable, Equatable {
    let id: String
    let email: String?
}

/// Checks an account token with the account server that issued it.
///
/// The token is verified by asking the issuer, not by reading it. A host could
/// fetch the project's public keys and check the signature itself, and that
/// would save a round trip — but it would also keep answering a browser whose
/// session was revoked ten minutes ago, for as long as the unexpired token said
/// it could. Asking is the answer that can change.
///
/// The result is cached for a minute, keyed by a hash of the token rather than
/// by the token: a crash log or a memory dump of this process should not be a
/// list of live sessions. A minute is short enough that a revoked session stops
/// working while someone is still looking at the phone, and long enough that a
/// browser reconnecting through a flaky tunnel does not make a request per
/// attempt.
actor AccountVerifier {
    private struct Entry {
        let account: VerifiedAccount
        let checkedAt: Date
    }

    private var cache: [String: Entry] = [:]
    private let lifetime: TimeInterval = 60
    private let session: URLSession

    init() {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 8
        configuration.waitsForConnectivity = false
        session = URLSession(configuration: configuration)
    }

    /// The account behind this token, or nil for anything this host cannot
    /// confirm — a refused token, an unreachable account server, or a build
    /// with no account server configured.
    ///
    /// Nil on an outage is deliberate and is the strict direction: the setting
    /// says a browser must be signed in, and "the check could not be made" is
    /// not "the check passed". The host says which of the two happened, so the
    /// phone does not report a refusal for what is actually a dropped uplink.
    func verify(token: String) async -> VerifiedAccount? {
        guard !token.isEmpty, let url = URL(string: "\(Config.accountServerURL)/auth/v1/user")
        else { return nil }

        let key = digest(of: token)
        if let entry = cache[key], Date().timeIntervalSince(entry.checkedAt) < lifetime {
            return entry.account
        }

        var request = URLRequest(url: url)
        request.httpMethod = "GET"
        request.setValue(Config.accountServerKey, forHTTPHeaderField: "apikey")
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        request.setValue("VibeWire/\(Config.hostVersion)", forHTTPHeaderField: "User-Agent")

        do {
            let (data, response) = try await session.data(for: request)
            guard let http = response as? HTTPURLResponse else { return nil }
            guard http.statusCode == 200 else {
                // A refusal is a fact worth remembering for a moment too: a
                // client with a stale token reconnects on a backoff, and every
                // attempt would otherwise be another request to the issuer.
                if http.statusCode == 401 || http.statusCode == 403 { cache[key] = nil }
                return nil
            }
            guard
                let root = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                let id = root["id"] as? String, !id.isEmpty
            else { return nil }

            let account = VerifiedAccount(id: id, email: root["email"] as? String)
            cache[key] = Entry(account: account, checkedAt: Date())
            prune()
            return account
        } catch {
            Log.debug(.net, "account check failed: \(error)")
            return nil
        }
    }

    /// Forgets every cached answer. Called when the requirement is turned off
    /// and again when the owner is cleared, so nothing decided under the old
    /// rule survives the change.
    func forgetEverything() {
        cache.removeAll()
    }

    private func prune() {
        guard cache.count > 32 else { return }
        let cutoff = Date().addingTimeInterval(-lifetime)
        cache = cache.filter { $0.value.checkedAt > cutoff }
    }

    private func digest(of token: String) -> String {
        SHA256.hash(data: Data(token.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}
