# VibeWire wire protocol

One TCP port on the Mac serves both HTTP and WebSocket, so a single Cloudflare
Tunnel origin covers everything. Default port `8787`.

Transport is assumed already private: over Tailscale the tunnel is WireGuard,
over Cloudflare it is TLS to the edge. VibeWire adds its own device
authentication on top so the Cloudflare path is not defended by obscurity.

```
iPhone ──┬── Tailscale (direct LAN path, or NAT-traversed, or DERP relay)
Browser ─┘   Cloudflare Tunnel (fallback, and the only path a page
         └──   served over HTTPS is allowed to take)
                     │
                     ▼
              Mac host :8787
              ├── HTTP  /v1/…      pairing, discovery, verify
              ├── WS    /v1/socket authenticated session
              └── HTTP  /          the web client itself (web/dist)
```

Two clients, one protocol. The iPhone app and the browser client speak the same
version 1 and are interchangeable; where a browser cannot do something the way
the phone does, this document says so at that point rather than forking.

## 1. Authentication

### 1.1 Pairing (screens 01A, 01B)

The Mac shows a 6-digit code in the menu bar. It rotates every 60 s and is only
valid while the Pair sheet is open.

```
POST /v1/pair
{
  "code":        "482917",
  "deviceName":  "iPhone 15 Pro",
  "deviceKind":  "phone",
  "publicKey":   "<base64 Ed25519 raw public key, 32 bytes>"
}
```

Host verifies the code in constant time, then responds:

```
200 {
  "hostId":      "<uuid>",
  "hostName":    "MacBook Pro 14\"",
  "hostKey":     "<base64 Ed25519 raw public key>",
  "deviceId":    "<uuid assigned to this phone>",
  "pairedAt":    "2026-03-14T20:41:02Z"
}
409 { "error": "code_expired" }      // rotated out from under you
429 { "error": "too_many_attempts" } // 5 wrong codes → 60 s lockout
```

The host stores `deviceId → publicKey` in the login Keychain
(`com.vibewire.host.trust`). Revoking a device (07B) deletes that entry and
severs any live socket for it within 1 s.

### 1.2 Session challenge

Every socket connection proves possession of the device private key. No bearer
token is ever stored on the phone.

```
GET /v1/challenge?deviceId=<uuid>
200 { "nonce": "<base64, 32 random bytes>", "expiresIn": 30 }
```

The client signs `"vibewire-auth-v1" || nonce` and opens the socket with:

```
GET /v1/socket
  Upgrade: websocket
  X-VibeWire-Device: <deviceId>
  X-VibeWire-Nonce: <base64 nonce>
  X-VibeWire-Signature: <base64 Ed25519 signature>
```

A bad signature, unknown device, reused nonce, or expired nonce gets `401` and
the TCP connection is closed without an upgrade. Nonces are single-use and held
for 30 s.

**Query-string spelling.** A browser cannot set headers on a WebSocket handshake
— `new WebSocket(url)` takes a URL and a subprotocol list and nothing else — so
the same three values are accepted from the query string, percent-encoded:

```
GET /v1/socket?device=<deviceId>&nonce=<base64 nonce>&sig=<base64 signature>
  Upgrade: websocket
```

Headers win where both are present. Standard base64, not the URL-safe alphabet:
the host decodes with `Data(base64Encoded:)`, which rejects `-` and `_`.

This is not a weakening. The nonce is single-use and dead in 30 s, and the
signature covers that nonce, so a URL that lands in a log cannot be replayed.
Nor can a hostile page produce one: signing needs the private key, which the
browser holds non-extractably and scopes to its own origin. Possession of the
key is the check, which is why the host validates no `Origin` header.

### 1.3 Verify (browser only)

```
GET /v1/verify?device=<deviceId>&nonce=<base64>&sig=<base64>
200 { "ok": true, "deviceId": "<uuid>" }
401 { "error": "unauthorized" }
```

The same challenge-response over plain HTTP. It exists because a browser cannot
see the status line of a refused upgrade: an HTTP `401` and an unplugged cable
both arrive as WebSocket close code `1006`. Without it a revoked browser would
retry for the full 30 s and then report "unreachable" about a Mac that was
answering perfectly. Asked once, on the first failure of a spell.

It grants nothing — a caller who can sign the nonce could have opened the socket
instead — and it burns the nonce like any other use.

## 2. Socket framing

**Text frames** are JSON control messages, both directions.
**Binary frames** are video, host → phone only.

### 2.1 Binary video frame

```
 0        1        2        4                 8                 12
 +--------+--------+--------+-----------------+-----------------+----------
 | magic  | flags  | stream |  sequence (u32) |  ptsMicros(u64) | payload
 | 0xV1   |        |  (u16) |                 |                 | (Annex-B)
 +--------+--------+--------+-----------------+-----------------+----------
```

- `magic` — `0xB1`, guards against desync.
- `flags` — bit 0 `keyframe`, bit 1 `parameterSetsIncluded` (SPS/PPS prepended),
  bit 2 `resolutionChanged`.
- `stream` — display index, matches `displays[].streamId`. Side-by-side (03C)
  runs two streams on one socket.
- `payload` — H.264 Annex-B. Parameter sets are re-sent on every keyframe so a
  phone that joins late or drops frames can always recover.

### 2.2 Control messages

Envelope:

```json
{ "t": "<type>", "id": "<optional request id>", "…": "type-specific fields" }
```

Requests carrying `id` get exactly one reply with the same `id`.

## 3. Host → phone

| `t` | Meaning | Feeds screen |
|---|---|---|
| `hello` | host name, version, capabilities, permission status | 02A header |
| `status` | awake/asleep, rtt, loss, downMbps, jitter, 60 s rtt history | 02A–02D condition card |
| `displays` | id, name, width, height, hz, isBuiltIn, selected | 02A–02D display list, 03A tabs |
| `transport` | `direct`/`relay`, path detail, peer latency, relay name | 02A, 02D, 07A toggle |
| `streamState` | `starting`/`live`/`stalled`/`reconnecting`/`stopped`, attempt, nextRetryMs, queuedInput, stalledMs | 03D |
| `videoConfig` | streamId, width, height, fps, bitrate, ladderStep (`1080`/`720`/`540`) | 03A/03B readouts |
| `clipboard` | text or image descriptor pulled from the Mac | 04A COPY ← MAC |
| `screenshot` | png bytes as base64 + dimensions | 04A SHOT |
| `lastFrame` | `{ ageSeconds }`, answering a `lastFrame` request | 02A hero age chip |
| `frontmost` | app name, window title, display | 05 "TYPING INTO" |
| `claude` | see §5 | 06A/06B/06C |
| `devices` | paired devices with lastSeen | 07A |
| `error` | code, message, retriable | any |

## 4. Phone → host

| `t` | Payload | Origin |
|---|---|---|
| `selectDisplay` | `{ displayIds: [..], mode: "single"\|"sideBySide" }` | 02A list, 03A tabs |
| `startStream` | `{ displayIds, maxHeight, targetFps }` | View screen |
| `stopStream` | `{}` | ✕ |
| `setQuality` | `{ ladder: "auto"\|"1080"\|"720"\|"540", cellularCapMbps }` | 07A |
| `pointer` | `{ phase, dx, dy, display, sensitivity }` relative trackpad delta | 03A pad |
| `click` | `{ button, count, display }` | tap |
| `drag` | `{ phase: "begin"\|"move"\|"end", dx, dy }` | drag |
| `scroll` | `{ dx, dy, momentum, natural }` | two-finger |
| `zoom` | `{ scale, anchorX, anchorY, locked }` | pinch (03B) |
| `modifiers` | `{ held: ["cmd","shift"], latched: true }` | 04B caps |
| `key` | `{ code, chars, down }` | 05 rows |
| `combo` | `{ keys: ["cmd","s"] }` | 05 row two |
| `text` | `{ value }` | system keyboard batch |
| `hubAction` | `{ action: "keys"\|"shot"\|"copy"\|"paste"\|"lock"\|"mods" }` | 04A |
| `clipboardPush` | `{ text }` | PASTE → MAC |
| `wake` | `{}` | 02C Wake it |
| `retry` | `{}` | 02D Try again |
| `lastFrame` | `{}` | 02D SHOW LAST FRAME |
| `claude` | see §5 | 06A/06B/06C |
| `revoke` | `{ deviceId }` or `{ all: true }` | 07A/07B |
| `setting` | `{ key, value }` | 07A |
| `ping` | `{ tMicros }` | rtt sampling |

## 5. Claude sub-protocol

The host drives the real `claude` CLI:

```
claude --print
       --input-format stream-json
       --output-format stream-json
       --include-partial-messages
       --replay-user-messages
       --permission-mode manual
       --verbose
       [--resume <sessionId> | --session-id <uuid>]
```

`ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` are **stripped from the child
environment**. Claude Code then authenticates with the subscription credentials
from `claude login` — the init message reports `apiKeySource: "none"`, which is
the signal that no API billing is in play. `--bare` is never passed, because it
forces API-key auth.

Phone → host:

| `sub` | Payload |
|---|---|
| `listSessions` | `{ cwd }` → recent sessions from `~/.claude/projects` |
| `open` | `{ sessionId }` resume, or `{ cwd, mode: "chat"\|"code" }` for new |
| `send` | `{ text }` |
| `interrupt` | `{}` → `control_request` `interrupt` |
| `permission` | `{ requestId, behavior: "allow"\|"deny", scope: "once"\|"always", message }` |
| `close` | `{}` |

Host → phone:

| `sub` | Payload |
|---|---|
| `sessions` | `[{ id, summary, cwd, gitBranch, modifiedAt }]` |
| `opened` | `{ sessionId, cwd, gitBranch, ahead, model, pid, tools }` |
| `delta` | `{ text }` streaming assistant text |
| `message` | `{ role, blocks }` completed turn |
| `tool` | `{ id, name, target, state: "running"\|"ok"\|"error", ms, preview }` |
| `files` | `[{ path, status: "M"\|"A"\|"D", added, removed }]` |
| `diff` | `{ path, hunks: [{ oldStart, lines: [{ kind, no, text }] }] }` |
| `permission` | `{ requestId, toolName, command, explanation, waitingMs }` |
| `usage` | `{ tokensPerSecond, inputTokens, outputTokens, durationMs }` |
| `rateLimit` | `{ status, resetsAt, type }` |
| `ended` | `{ reason, durationMs }` |

Permission replies map to the CLI's documented contract:

```
allow → { "behavior": "allow" }
deny  → { "behavior": "deny", "message": "<why>" }
```

## 6. Reconnection

The phone reconnects with exponential backoff (0.5 s → 8 s, capped) for 30 s
total, matching the "GIVING UP AT 30S" readout on 03D. Input generated while
disconnected is queued locally, capped at 64 events, and replayed in order once
`streamState` returns to `live`. The count is surfaced as `QUEUED INPUT`.

The browser client uses the same policy, with two differences the platform
forces. Success is `onopen` rather than the first frame — a refused upgrade never
opens, so the browser learns sooner than the phone does. And a revoked device is
identified by asking `/v1/verify` (§1.3), because close code `1006` says nothing.

## 7. Static surface

Anything that is not `/v1/…` is served from the built web client, so the browser
sees one origin for the page and the protocol both — which is what makes the
client usable over Tailscale, where the host speaks plain HTTP and a page on
`https://` would be forbidden from reaching it.

```
GET /                → index.html   Cache-Control: no-store
GET /assets/<hash>.*  → the bundle   Cache-Control: immutable, 1 year
GET /<no extension>   → index.html   so ?host=…&code=… links resolve
```

Served from the first of `VIBEWIRE_WEB_ROOT`, `~/.config/vibewire/web`, or
`<checkout>/web/dist`. A host with none of those simply 404s; the protocol does
not depend on it.

`index.html` carries a CSP that allows only its own script and stylesheet, with
`connect-src *` because the client may be pointed at a different address than the
one that served it. Path traversal is refused before the filesystem is touched
and again after resolution, and `/v1/` is never served from disk.
