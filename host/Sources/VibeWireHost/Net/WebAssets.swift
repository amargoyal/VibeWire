import Foundation

/// Serves the built web client (`web/dist`) off the same port as the protocol.
///
/// This exists because of one browser rule: a page served over HTTPS may not open
/// `http://` or `ws://`. The client hosted on GitHub Pages is therefore reachable
/// only over an HTTPS address, which in practice means the Cloudflare Tunnel — and
/// over Tailscale or the LAN, where the host speaks plain HTTP, there would be no
/// way to use it at all.
///
/// Serving the identical bundle from here answers that: `http://<mac>:8787/` is the
/// same origin as the API, so there is no scheme mismatch, no CORS, and no tunnel
/// required. Same build, two homes — the Pages copy for the internet, this one for
/// the tailnet.
///
/// Deliberately not a general-purpose file server. It serves one directory, refuses
/// anything that escapes it, and knows eight content types.
struct WebAssets: Sendable {
    let root: URL

    /// Resolved once at launch, so a missing bundle is one log line rather than a
    /// 404 per request.
    init?(root: URL?) {
        guard let root, FileManager.default.fileExists(atPath: root.appendingPathComponent("index.html").path)
        else { return nil }
        // Resolving symlinks here is what makes the containment check below mean
        // something: `/tmp` on macOS is a symlink to `/private/tmp`, so comparing an
        // unresolved root against a resolved candidate would reject every request.
        self.root = root.resolvingSymlinksInPath()
    }

    /// The response for a GET, or nil if this path is not ours to answer.
    func response(for path: String) -> HTTPResponse? {
        // Everything under /v1 belongs to the protocol.
        guard !path.hasPrefix("/v1/") else { return nil }

        let requested = path == "/" ? "index.html" : String(path.dropFirst())

        // Reject traversal before touching the filesystem. `..` cannot appear in a
        // legitimate asset path, and a percent-encoded one has already been decoded
        // by the request parser.
        let components = requested.split(separator: "/", omittingEmptySubsequences: true)
        guard !components.contains("..") , !requested.hasPrefix("/") else {
            return .error(403, "forbidden")
        }

        let candidate = root.appendingPathComponent(requested).resolvingSymlinksInPath()

        // Belt as well as braces: whatever the path did on the way through, the file
        // that is about to be read has to be inside the root.
        guard candidate.path == root.path || candidate.path.hasPrefix(root.path + "/") else {
            return .error(403, "forbidden")
        }

        if let data = try? Data(contentsOf: candidate),
           (try? candidate.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) != true {
            return asset(data, name: candidate.lastPathComponent)
        }

        // A path with no extension is a client route, not a missing file. The client
        // has none today — it navigates by state, not by URL — but `?host=…&code=…`
        // links and a future route both land here, and answering `index.html` is what
        // makes them work instead of 404ing.
        if candidate.pathExtension.isEmpty,
           let index = try? Data(contentsOf: root.appendingPathComponent("index.html")) {
            return asset(index, name: "index.html")
        }

        return .error(404, "not_found")
    }

    private func asset(_ data: Data, name: String) -> HTTPResponse {
        var headers = ["Content-Type": contentType(for: name)]

        // Vite fingerprints every asset filename, so those can be cached hard and
        // the document must never be — otherwise a client update ships and nobody
        // gets it until they clear the cache.
        headers["Cache-Control"] = name == "index.html"
            ? "no-store"
            : "public, max-age=31536000, immutable"

        if name == "index.html" {
            // The bundle is self-contained: its own script and stylesheet, inline
            // styles for the instrument's own values, and nothing fetched from
            // anywhere else. `connect-src` stays open because the client may be
            // pointed at a different address than the one that served it — a tunnel
            // hostname — and `data:` is there for the screenshot the Mac sends.
            headers["Content-Security-Policy"] = [
                "default-src 'self'",
                "script-src 'self'",
                "style-src 'self' 'unsafe-inline'",
                "img-src 'self' data:",
                "connect-src *",
                "frame-ancestors 'none'",
                "base-uri 'none'",
                "object-src 'none'",
            ].joined(separator: "; ")
            headers["X-Content-Type-Options"] = "nosniff"
            headers["Referrer-Policy"] = "no-referrer"
        }

        return HTTPResponse(status: 200, headers: headers, body: data)
    }

    private func contentType(for name: String) -> String {
        switch (name as NSString).pathExtension.lowercased() {
        case "html": return "text/html; charset=utf-8"
        case "js", "mjs": return "text/javascript; charset=utf-8"
        case "css": return "text/css; charset=utf-8"
        case "json": return "application/json"
        case "svg": return "image/svg+xml"
        case "png": return "image/png"
        case "woff2": return "font/woff2"
        case "ico": return "image/x-icon"
        default: return "application/octet-stream"
        }
    }
}
