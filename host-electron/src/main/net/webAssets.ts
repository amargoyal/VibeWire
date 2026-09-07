import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { extname, basename, join, resolve, sep } from 'node:path'
import { percentDecode, Response, type HTTPResponse } from './request'

/**
 * Serves the built web client off the same port as the protocol.
 *
 * This exists because of one browser rule: a page served over HTTPS may not
 * open `http://` or `ws://`. The client hosted on GitHub Pages is therefore
 * reachable only over an HTTPS address, and over Tailscale or the LAN, where
 * the host speaks plain HTTP, there would be no way to use it at all. Serving
 * the identical bundle from here answers that: `http://<host>:8787/` is the
 * same origin as the API, so there is no scheme mismatch, no CORS, no tunnel.
 *
 * Deliberately not a general-purpose file server. It serves one directory,
 * refuses anything that escapes it, and knows eight content types.
 */
export class WebAssets {
  private constructor(readonly root: string) {}

  /** Resolved once at launch, so a missing bundle is one log line rather than a
   *  404 per request. The root is realpath'd so the containment check below
   *  means something on a symlinked directory. */
  static open(root: string | null): WebAssets | null {
    if (!root || !existsSync(join(root, 'index.html'))) return null
    return new WebAssets(realpathSync(root))
  }

  /** The response for a GET, or null if this path is not ours to answer. */
  response(rawPath: string): HTTPResponse | null {
    // Everything under /v1 belongs to the protocol.
    if (rawPath.startsWith('/v1/')) return null

    const decoded = percentDecode(rawPath)
    if (decoded === null) return Response.error(400, 'bad_path')
    const requested = decoded === '/' ? 'index.html' : decoded.replace(/^\/+/, '')

    // Reject traversal before touching the filesystem. `..` cannot appear in a
    // legitimate asset path. A backslash is a separator on Windows and a colon
    // opens an NTFS alternate data stream (`index.html::$DATA`), so neither is
    // a character an asset name may contain either.
    if (
      requested.includes('\\') ||
      requested.includes(':') ||
      requested.includes('\0') ||
      requested.split('/').some((component) => component === '..')
    ) {
      return Response.error(403, 'forbidden')
    }

    let candidate = resolve(this.root, requested)
    try {
      candidate = realpathSync(candidate)
    } catch {
      // Not on disk; the containment check still runs on the resolved name.
    }

    // Belt as well as braces: whatever the path did on the way through, the
    // file that is about to be read has to be inside the root.
    if (!this.contains(candidate)) return Response.error(403, 'forbidden')

    try {
      if (statSync(candidate).isFile()) {
        return this.asset(readFileSync(candidate), basename(candidate))
      }
    } catch {
      // fall through
    }

    // A path with no extension is a client route, not a missing file. The
    // client navigates by state, but `?host=…&code=…` links land here, and
    // answering `index.html` is what makes them work instead of 404ing.
    if (extname(candidate) === '') {
      try {
        return this.asset(readFileSync(join(this.root, 'index.html')), 'index.html')
      } catch {
        // fall through
      }
    }

    return Response.error(404, 'not_found')
  }

  private contains(candidate: string): boolean {
    const root = process.platform === 'win32' ? this.root.toLowerCase() : this.root
    const target = process.platform === 'win32' ? candidate.toLowerCase() : candidate
    return target === root || target.startsWith(root + sep)
  }

  private asset(data: Buffer, name: string): HTTPResponse {
    const headers: Record<string, string> = { 'Content-Type': contentType(name) }

    // Vite fingerprints every asset filename, so those can be cached hard and
    // the document must never be — otherwise a client update ships and nobody
    // gets it until they clear the cache.
    headers['Cache-Control'] = name === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable'

    if (name === 'index.html') {
      // The bundle is self-contained: its own script and stylesheet, inline
      // styles for the instrument's own values, and nothing fetched from
      // anywhere else. `connect-src` stays open because the client may be
      // pointed at a different address than the one that served it — a tunnel
      // hostname — and `data:` is there for the screenshot the host sends.
      headers['Content-Security-Policy'] = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        'connect-src *',
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "object-src 'none'",
      ].join('; ')
      headers['X-Content-Type-Options'] = 'nosniff'
      headers['Referrer-Policy'] = 'no-referrer'
    }

    return { status: 200, headers, body: data }
  }
}

function contentType(name: string): string {
  switch (extname(name).toLowerCase()) {
    case '.html':
      return 'text/html; charset=utf-8'
    case '.js':
    case '.mjs':
      return 'text/javascript; charset=utf-8'
    case '.css':
      return 'text/css; charset=utf-8'
    case '.json':
      return 'application/json'
    case '.svg':
      return 'image/svg+xml'
    case '.png':
      return 'image/png'
    case '.woff2':
      return 'font/woff2'
    case '.ico':
      return 'image/x-icon'
    default:
      return 'application/octet-stream'
  }
}
