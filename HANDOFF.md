# VibeWire — Handoff

## Repo

`/Users/amargoyal/Github/VibeWire` (branch `main`, one commit `11fac3c`, **everything still uncommitted**).

```
PROTOCOL.md                    wire protocol spec (read first)
HANDOFF.md                     this file
host/                          macOS menu-bar host, Swift Package — BUILDS CLEAN
ios/                           SwiftUI app, iOS 17+ — BUILDS CLEAN
```

## Build

```
export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer   # xcode-select points at CLT; do not sudo
cd host && swift build
cd ios  && xcodebuild -scheme VibeWire \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro' -derivedDataPath /tmp/vw_dd build
```

Run host — **absolute path, and `nohup`, or it dies with the terminal**:

```
VIBEWIRE_VERBOSE=1 nohup /Users/amargoyal/Github/VibeWire/host/.build/arm64-apple-macosx/debug/VibeWireHost --pair \
  > /tmp/vibewire.log 2>&1 &
```

`--pair` now opens the pairing window itself (code + QR), not just the log line. Verbose is required or stderr stays empty.

Install it as a real app — Spotlight, Finder, Login Items:

```
cd host && ./package-app.sh
```

Wraps the release binary in `VibeWire.app`, signs it with the Apple Development
certificate, and installs to `/Applications`. `--no-install` leaves the bundle in
`host/build/` instead. The bundle is `LSUIElement`, so it stays a menu-bar app with
no Dock icon; that does not hide it from Spotlight. Signing with a real certificate
is what makes the Screen Recording and Accessibility grants survive a rebuild — an
ad-hoc signature changes every time and TCC treats each build as a new app.

---

# THE BUG YOU ARE ON

**The iOS app cannot reach the host over Tailscale. Safari on the same phone can.**

Facts, all verified tonight — do not re-derive:

- Phone Safari → `http://100.67.248.30:8787/v1/challenge?deviceId=phonetest` returns the nonce JSON.
- While that happened, a connection watcher saw **44 samples from `100.113.25.3`** (the phone) hitting port 8787.
- During an app pairing attempt in the same window: **zero** samples from the phone. The app's request never puts a packet on the wire.
- App shows `No answer from that address.` — that is `PairFailure.unreachable`, which is thrown for *every* `URLSession` error (`HostClient.swift:117`). The real error is discarded.
- iOS **Local Network permission for VibeWire is ON** (user confirmed). Not the cause.
- `NSAllowsArbitraryLoads` + `NSAllowsLocalNetworking` were added to `ios/Info.plist` and are confirmed present in the device build. Did not fix it. (ATS mostly does not apply to raw IP literals anyway — this was probably a wrong theory, kept because it's harmless and needed for the relay path.)
- Both devices are Connected in the Tailscale app, same account, Mac `100.67.248.30`, phone `100.113.25.3`. `tailscale ping` Mac→phone is 16–150ms.
- Phone is **not** on home Wi-Fi (status bar shows SOS, no cellular; `tailscale ping` routes to it over public IPv6). LAN pairing is therefore not an option for it right now.

### Do this first

**Surface the real error.** `HostClient.pair()` catches every `URLSession` failure and rethrows `PairFailure.unreachable`, so a timeout, a DNS failure, an ATS rejection and a refused connection are all one message. Change the catch at `ios/VibeWire/Net/HostClient.swift:116` to carry `(error as NSError).code` and `localizedDescription` through to the banner. The code names the cause immediately:

```
-1003 host not found   -1004 could not connect   -1009 offline
-1022 ATS blocked      -1200 TLS                 -1001 timeout
```

Also time it: instant failure means iOS rejected it locally; ~8s means it went out and nothing answered (`timeoutInterval = 8`).

Second, add a log line to failed pairs on the host — `handlePair` in `HostRouter.swift` returns 401/409/429 **silently**, so an absent log does not mean an absent request. That cost real time tonight.

### Watcher

```
/private/tmp/claude-501/.../scratchpad/watch.sh    # samples lsof -iTCP:8787 every 0.4s for 4 min
```
Run it, have the user pair, then `grep 100.113.25.3` the output. Loopback noise is the simulator.

---

## Fixed today — do not redo

**Host**

1. **Trust store returned "unknown device" for every paired phone.** First keychain read of a *pre-existing* item by a *rebuilt* binary takes 5–45s (macOS puts up a SecurityAgent prompt); the old 3s deadline turned that into `nil`, and `loadDevices()` cached `nil` as `[:]` for the process lifetime. Now: `read` is `async throws -> Data?` (nil = absent, throw = could not tell), 45s deadline off the cooperative pool, failures never cached, mutating paths throw rather than clobber, `hostIdentity()` only mints a key on genuine absence, and `prime()` warms at launch with 6 retries. `TrustStore.swift`, `SecretStore.swift`.
2. **`LayeredSecretStore`** — reads keychain then file, migrates what it recovers, writes to the chosen store, deletes reach both. A store switch migrates instead of orphaning every paired device.
3. **Actor reentrancy** in `TrustStore` let concurrent callers each run `SecretStoreFactory.make`; two keychain probes collided (`-25299`) and one host silently wrote trust records as plaintext to `~/.config/vibewire/devices.secret`. Resolution and load are now memoized tasks.
4. **`NWListener` never accepts on Tailscale's `utun`.** Proven by elimination: wildcard listener, `requiredLocalEndpoint` wildcard, and `requiredInterface = utun5` (the exact interface holding the 100.x address, state `.ready`) all receive nothing, while `python3 -m http.server` on the same machine is reachable on LAN, loopback and Tailscale. Fix: `Net/SocketForwarder.swift` — a POSIX dual-stack socket owns `:8787` and splices to the `NWListener` now bound to `127.0.0.1:8788`. **Verified working**: phone reached it over Tailscale.
5. **Zombie listener.** `start()` succeeded, then `stateUpdateHandler` logged `listener failed: Address already in use` and the process kept running with nothing on the port. Now `HTTPServer.onFatal` raises the fatal alert, and the forwarder binds last so a taken port throws before the host claims to be up.
6. Claude panel: host acks `claude/open` immediately (the CLI stays silent until first prompt), and pushes **transcript history** from the on-disk JSONL on resume — `ClaudeSessionIndex.transcript(sessionId:)`, since `--resume` restores context but prints nothing.
7. **Changed files + live diff**: `Claude/GitWorkingTree.swift` reads `git status`/`--numstat`, pushed after every tool result; `claude/diff` watches one path and re-sends the patch as Claude edits. Filters build output (this repo has no `.gitignore` — unfiltered it reported **2857** files; filtered, 48) and caps at 200.
8. Pairing QR re-probes the transport instead of using the launch-time cache, and prefers `tailscaleAddress` over the MagicDNS name (the name endpoint is TLS-terminated, the phone speaks plain HTTP).

**iOS**

9. **Both monitors glitched green in side-by-side.** One `VideoRenderer` for all streams: monitor 2's slices decoded against monitor 1's reference frames. Also both panes shared one `AVSampleBufferDisplayLayer`, so one pane went black. Fix: `RendererPool` keyed by `streamId`, `renderer(forDisplay:)`, `updateUIView` re-attaches. **Verified**: both panes clean.
10. **Hub button inflated the whole screen.** `ControlHubView`'s 660pt scrim and 420pt ring were ZStack children, so the stack sized to 660pt and dragged every sibling off-screen, putting the arc where no thumb could reach. Moved into `.background(alignment:)`. Note `.frame(maxWidth: .infinity)` does **not** fix this — it expands, it cannot shrink an oversized child.
11. **Three-dots menu was untappable** (the only route to Settings and unpair). Hit testing follows drawn shapes, not the 44pt frame — the target was three 3pt dots with gaps. Added `.contentShape(Rectangle())`.
12. **MODS spoke did nothing** — its action was a literal `break`, and the tray only rendered once a modifier was already held.
13. Markdown rendering in the Claude transcript (`Design/Markdown.swift`) — blocks split locally, inline spans via `AttributedString`, fenced code in monospace with horizontal scroll and a copy button.
14. `Screens/DiffView.swift` — coloured live diff, refreshes as Claude edits.
15. Two `.sheet` modifiers on one view: SwiftUI honours only the first. The diff sheet had to move onto a child view.

## Known-good verification

E2E harness (`scratchpad/e2e.swift`, run with the pairing code as argv[1]) passes end to end through the forwarder: 401 on wrong code, pair, Ed25519, WS upgrade, pong, 25 Claude sessions, 608 KB of H.264 in 4s.

## Gotchas

- Every host rebuild is a new code identity → SecurityAgent keychain prompt → first trust-store read can take 45s. Click **Always Allow**. Wait for `trust store warmed` before pairing. A stable self-signed identity would end this.
- Screen Recording permission is **MISSING** again after recent rebuilds (TCC is per-binary). Re-grant or streaming returns black.
- A successful pair **closes the pairing window**. The stale QR stays on screen and looks valid.
- `tailscale serve --tcp 8787` **binds 8787 on the Mac as root** and blocks the host from binding. It is currently **off**; leave it off.
- Internal listener is `port + 1` (8788). Must be free.
- All client addresses now read `127.0.0.1` host-side, since everything arrives via the forwarder.
- `osascript` lost assistive access mid-session, so simulator tap automation (`scratchpad/tap.sh`) is dead until re-granted in System Settings → Privacy → Accessibility.

## Not yet done

- Task #11 open. Screens 03A–03D, 04A–04C, 05, 06A–06C, 07A/07B compile; only 01A, 02A/02B/02D, the remote view, hub, Claude panel and diff have been seen working.
- Pinch-anchor zoom and two-finger pan (`RemoteView`) are written and compile but were never exercised — System Events cannot synthesize multitouch.
- `cloudflared` not installed; relay path unexercised.
- SHOT copies a PNG to the phone clipboard and shows no confirmation — `lastScreenshot` is stored and never rendered.
- No Bonjour/mDNS. `Identity.PairedHost` stores one address, so a Mac that changes IP is unreachable until re-pairing.
- `wakeOnLan` is reported in capabilities but no magic packet is ever sent.
- README.md still does not exist. Needs: Screen Recording + Accessibility, Tailscale, `claude login`, and the `ANTHROPIC_API_KEY`-must-be-unset warning.

## Facts worth not rediscovering

- Claude CLI control protocol: `control_request`/`control_response`, subtype `can_use_tool`, reply `{"behavior":"allow"}` or `{"behavior":"deny","message":…}`. Also `interrupt`, `set_permission_mode`.
- Never pass `--bare` — forces API-key auth. Host strips `ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN` from the child env. `apiKeySource: "none"` confirms subscription auth.
- Host serves plain HTTP/WS, no TLS: Tailscale is WireGuard already, cloudflared terminates TLS at the edge, Ed25519 defends the Cloudflare path.
- Swift 6 strict concurrency: `NSLock.lock()` is unavailable in async contexts. Use `Guarded` (`Core/Guarded.swift`), not `OSAllocatedUnfairLock`.
- Simulator geometry: device 402×874pt, screenshots 1206×2622 (÷3 for points).

## Web client

`web/` is a full second client, ported screen for screen from `ios/VibeWire`. Preact + TypeScript, Vite, 50 KB gzipped. `npm run build` runs `tsc --noEmit` first, so a type error cannot ship.

Two host changes were needed and both are additive — still `protocolVersion = 1`:

- **Query-string socket auth.** A browser cannot set headers on a WebSocket handshake, so `device` / `nonce` / `sig` are accepted from the query string as well (`HostRouter.credentials(in:)`). Headers win where both are present. Standard base64, not URL-safe: `Data(base64Encoded:)` rejects `-` and `_`. Percent-encoding survives `HTTPRequest.parse`, which calls `removingPercentEncoding` on query values — verified, and it is the one thing in the change that would silently break everything if it did not.
- **`GET /v1/verify`.** Same challenge-response over plain HTTP. Exists because a browser cannot see the status line of a refused upgrade: HTTP 401 and an unplugged cable both arrive as close code 1006. Without it a revoked browser retries for 30 s and then blames the network.

Plus `WebAssets.swift`, which serves `web/dist` for anything outside `/v1/`. Root resolves from `VIBEWIRE_WEB_ROOT`, then `~/.config/vibewire/web` (filled by `web/deploy-to-host.sh`), then `<checkout>/web/dist` via `#filePath`. **The `#filePath` walk needs five `deletingLastPathComponent()` calls, not four** — four lands on `host/`, which silently 404s everything.

### The constraint that shaped the whole thing

A page on `https://` may not open `http://` or `ws://`. The host serves plain HTTP by design, so GitHub Pages can only reach the Mac through the Cloudflare tunnel, and the tailnet needs the host to serve its own copy of the bundle. Hence two homes for one build. `vite.config.ts` sets `base: './'` so the same `dist/` works at a user site, a project site, a custom domain, and `http://<mac>:8787/` — which is why picking the Pages name needs no code change.

Chromium treats loopback as trustworthy and Safari does not, so `http://localhost` from an HTTPS page is reported as a warning rather than blocked or fine. `net/endpoint.ts` owns all three verdicts.

### Verifying

`node web/e2e.mjs <code>` against a host started with `--pair`. Speaks the browser spelling without a browser. Traversal attempts go over a raw socket on purpose — `fetch` normalises `/../x` to `/x` before the request leaves, so going through it tests the client and not the host.

Verified this session: static serving, cache headers, CSP, hashed-asset fetch, six traversal attempts refused (403/404, nothing leaked), `/v1/verify` 401 on a forged nonce. **Not** verified: pairing and the socket, because the trust store would not open — see below.

### Gotchas found

- The trust store is unreadable from a sandboxed shell: keychain reads time out after 45 s and `~/.config/vibewire/devices.secret` gives `EPERM` despite mode 600 and correct ownership. Both stores failing surfaces as `pair rejected 401 bad_code` with the real cause only in the host log — the `default:` catch in `handlePair` swallows a store failure into a wrong-code answer, which is a mislabel worth fixing.
- `VIBEWIRE_SECRET_STORE=file` does not escape it: `homeDirectoryForCurrentUser` reads `getpwuid`, not `$HOME`, so overriding `HOME` does not move the file store.
- `Log` output is block-buffered when stdout is not a tty. Run the host under `script -q /dev/null` to read it live from a pipe.
- The host answers every request with `Connection: keep-alive` regardless of what was asked, so a raw HTTP client waiting for `end` waits forever.
- `--pair`'s rotation timer calls `endPairing()` as soon as the pairing window is not visible. Read the code from the log immediately; it is good for 60 s.

### Answered here, still open on the phone

- SHOT: the phone stores `lastScreenshot` and renders it nowhere. The web client shows it with Save PNG and Copy Image, because a browser cannot put an image on the clipboard silently.
- `drag`: the protocol carries it and `RemoteView.isDragging` is never set true, so the phone cannot start one. The web client does — mouse button down and move, or press-and-hold then move on touch.
