import CryptoKit
import Foundation

/// Where `cloudflared` comes from on a Mac that has never heard of it.
///
/// The relay is the answer to every network that will not carry a LAN
/// connection: another Wi-Fi, cellular, and the school, hotel and office
/// networks that stop their own clients reaching each other. It was also, on a
/// Mac, an answer only a machine with Homebrew could give. The switch turned
/// on, two paths were checked, neither existed, one line went into the log,
/// and the pairing window carried on offering an address that did not work.
///
/// The Windows host has fetched its own copy since it shipped, pinned to one
/// build and refusing anything whose hash is not the pinned one. This is the
/// same, for the same reason, with the same refusal.
enum Cloudflared {
    struct Build {
        let url: String
        let sha256: String
    }

    /// The one build this host will fetch, and the hash it must have. Updating
    /// means bumping the version and both hashes, on purpose.
    static let version = "2026.8.3"
    static let arm64 = Build(
        url: "https://github.com/cloudflare/cloudflared/releases/download/2026.8.3/cloudflared-darwin-arm64.tgz",
        sha256: "40c9144d86df8937c5b43293a1f7d2d2107029aa74725023dd46b1b27154352f"
    )
    static let amd64 = Build(
        url: "https://github.com/cloudflare/cloudflared/releases/download/2026.8.3/cloudflared-darwin-amd64.tgz",
        sha256: "61e1316266a00fd70ce40da011d612badc805367fb65293dd1925f938f704c99"
    )

    static var build: Build {
        #if arch(arm64)
        return arm64
        #else
        return amd64
        #endif
    }

    /// Where a fetched copy lives. Beside the rest of this host's state, not in
    /// `/usr/local/bin`: nothing here asks for an administrator, and a binary
    /// this app manages should be removable by deleting this app's folder.
    static var managedPath: String {
        Config.configDirectory.appendingPathComponent("bin/cloudflared").path
    }

    /// An installed copy: Homebrew's, a manual install, or the one this host
    /// fetched the last time the relay was turned on.
    static func installed() -> String? {
        let candidates = [
            "/opt/homebrew/bin/cloudflared",
            "/usr/local/bin/cloudflared",
            managedPath,
        ]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    enum InstallFailure: Error, LocalizedError {
        case download(String)
        case verification(String)
        case extraction(String)

        var errorDescription: String? {
            switch self {
            case .download(let detail): return "Could not download cloudflared: \(detail)"
            case .verification(let digest):
                return "The cloudflared download did not match the expected build (sha256 \(digest))."
            case .extraction(let detail): return "Could not unpack cloudflared: \(detail)"
            }
        }
    }

    /// Fetches the pinned build and returns the path to it.
    ///
    /// The archive is verified before anything is unpacked, and unpacked to a
    /// temporary directory before it is moved into place, so a half-downloaded
    /// or substituted file never becomes the binary this host runs.
    static func install() async throws -> String {
        let pinned = build
        guard let url = URL(string: pinned.url) else {
            throw InstallFailure.download("bad url")
        }
        Log.info(.transport, "fetching cloudflared \(version)")

        let data: Data
        do {
            var request = URLRequest(url: url)
            request.timeoutInterval = 120
            let (payload, response) = try await URLSession.shared.data(for: request)
            guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
                throw InstallFailure.download(
                    "HTTP \((response as? HTTPURLResponse)?.statusCode ?? 0)"
                )
            }
            data = payload
        } catch let failure as InstallFailure {
            throw failure
        } catch {
            throw InstallFailure.download(error.localizedDescription)
        }

        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard digest == pinned.sha256 else { throw InstallFailure.verification(digest) }

        let staging = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("vibewire-cloudflared-\(UUID().uuidString)")
        let archive = staging.appendingPathComponent("cloudflared.tgz")
        let destination = URL(fileURLWithPath: managedPath)
        do {
            try FileManager.default.createDirectory(
                at: staging, withIntermediateDirectories: true
            )
            defer { try? FileManager.default.removeItem(at: staging) }
            try data.write(to: archive)

            // tar says nothing on success, so the file it was asked for is the
            // only answer worth reading.
            _ = await Shell.capture(
                "/usr/bin/tar",
                ["-xzf", archive.path, "-C", staging.path, "cloudflared"],
                timeout: 60
            )

            let unpacked = staging.appendingPathComponent("cloudflared")
            guard FileManager.default.fileExists(atPath: unpacked.path) else {
                throw InstallFailure.extraction("the archive held no cloudflared")
            }
            try FileManager.default.createDirectory(
                at: destination.deletingLastPathComponent(),
                withIntermediateDirectories: true
            )
            if FileManager.default.fileExists(atPath: destination.path) {
                try FileManager.default.removeItem(at: destination)
            }
            try FileManager.default.moveItem(at: unpacked, to: destination)
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o755], ofItemAtPath: destination.path
            )
        } catch let failure as InstallFailure {
            throw failure
        } catch {
            throw InstallFailure.extraction(error.localizedDescription)
        }

        Log.info(.transport, "cloudflared \(version) installed at \(destination.path)")
        return destination.path
    }
}
