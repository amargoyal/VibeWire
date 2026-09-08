# VibeWire web client

The same instrument as the iPhone app, in a browser. Same Longarm design system,
same seven screens, same wire protocol — `PROTOCOL.md` is authoritative for both,
and this client speaks version 1 of it unchanged.

Preact + TypeScript, built by Vite, no runtime dependency on anything it does not
ship: 50 KB gzipped, one script, one stylesheet, nothing fetched from a CDN.

**Two hosts serve this client.** The Mac host and the Windows host
(`host-electron/`) both serve the same `dist/`, and the client tells them apart
by `hello.platform` — the chip labels, the host noun and the named conditions
follow it, and nothing else changes. `PROTOCOL.md` §3.1 lists the fields.

**There are two builds in this directory.** `npm run build` is this client, the one
the phone and any browser use. `npm run build:dashboard` is the Mac app's window —
same `node_modules`, same design system, its own `dist-dashboard`. It is not a
second copy of this client: it is the host's own surface, and it lives here so the
two cannot drift apart in the palette. See `dashboard/README.md` and `PROTOCOL.md`
§8. `npm run build:all` builds both.

---

## When you have picked the GitHub Pages name

**Nothing in this repository needs to change.** `vite.config.ts` sets `base: './'`,
so every asset reference is relative to the document. The same `dist/` is correct at

- a user site — `https://<you>.github.io/`
- a project site — `https://<you>.github.io/<repo>/`
- a custom domain — `https://vibewire.example/`

Two steps, once, on GitHub:

1. **Settings → Pages → Build and deployment → Source → GitHub Actions.**
   Until this is set, `.github/workflows/pages.yml` builds and then fails at the
   deploy step with "Pages site not found".
2. Push to `main`. Any change under `web/` publishes; so does running the **Pages**
   workflow by hand from the Actions tab.

For a custom domain, add the hostname in Settings → Pages, and put the same hostname
in a file at `web/public/CNAME` — Vite copies `public/` into `dist/` verbatim, so the
file survives every build. Nothing else moves.

---

## The one constraint worth understanding first

A page served over **HTTPS may not open `http://` or `ws://`.** The browser blocks it
as mixed content before a packet leaves, and no amount of code here can talk it
round. The Mac host serves plain HTTP on purpose (`PRODUCT.md`, hard constraints), so
that rule decides which address each copy of this client can reach:

| Where the page is served from | What it can reach | Use it for |
|---|---|---|
| `https://<you>.github.io/…` | `https://` and `wss://` only — in practice the Cloudflare Tunnel | away from home, on any machine |
| `http://<mac>:8787/` (the host serves it) | anything, same origin as the API | Tailscale, the LAN, no tunnel needed |
| `http://localhost:5273` (`npm run dev`) | anything | development |

So there are two homes for one build, and both are wanted:

```sh
npm ci
npm run build          # tsc --noEmit, then vite build → dist/
./deploy-to-host.sh    # → ~/.config/vibewire/web, served at http://<mac>:8787/
```

Running the host straight out of this checkout needs no install step — it finds
`web/dist` on its own (`Config.webRoot`).

When the address is unreachable *because of this rule* rather than because the Mac is
down, the pairing screen says so in as many words, with both ways round it. Naming
the failure precisely is the product principle this whole client is built on; a
timeout where a scheme mismatch belongs would be the exact defect it exists to avoid.

---

## Pairing

Same handshake as the phone: six digits from the Mac's menu bar, an Ed25519 key
exchange, and no stored bearer token.

Five ways in, fastest first:

- **Scan the BROWSER QR.** The Mac's pairing window shows two. The left is
  `vibewire://pair?…` for the iOS app — a custom scheme, which no browser can
  handle. The right is an ordinary URL, so the phone's **own camera** opens it in
  the browser and it pairs on load. Nothing to type, no in-app scanner, works on
  every phone. It carries only the code; the address comes from the page's own
  origin, which keeps the QR small enough to scan across a desk.

  The right-hand QR points at the Cloudflare tunnel when the relay is up — the
  caption reads `WORKS ON CELLULAR` — and at the tailnet or LAN address otherwise.
  It redraws every second, so the code in it is never the stale one.

  The same URL is printed in the host log as `browser pairing url …`, for when
  pasting beats pointing.
- **Scan it from this client.** Where the engine has a `BarcodeDetector` — Chromium
  today — the pairing screen opens the camera and reads either QR itself. It is
  the row under OTHER WAYS IN, and where the engine cannot scan, that row is a
  statement rather than a dead button: seven different sentences for seven
  different reasons, including the one that cannot be worked around — a page on
  plain `http://` has no camera to ask for, so the copy the Mac serves over the
  tailnet says so instead of failing silently.
- **Type the code.** Enter the Mac's address, then the six digits.
- **Paste the pairing link.** Reads either QR's payload off the clipboard.
- **A link with the fields in it.** `…/?host=<mac>&port=8787&code=<code>`. `host`
  and `port` are optional — left out, the page's own origin is used. That is the
  form to bookmark. `origin=<full origin>` outranks `host` where a link carries
  one, and `alt=<origin>,<origin>` names the Mac's other addresses.

**One Mac, several addresses.** The pairing record keeps the address that answered
*and* the others the Mac named, so leaving the network the pairing was made on
costs a reconnect rather than a re-pair. The list is learned rather than typed: the
host reports every address it believes in once a second over the socket, which is
the only place a Cloudflare quick tunnel's hostname exists at all — it is minted on
each host launch and written down nowhere.

When a socket fails without ever being accepted, the next address is dialled and the
backoff carries on; the address that carries a working socket becomes the one dialled
first next time. A connected socket that stops answering pings for eight seconds is
treated the same way, because a radio that changes under a live TCP connection does
not always close it, and a socket nobody can hear would otherwise hold the rotation
on an address that is already dead.

The one thing a browser cannot copy from the phone: **a page on `https` may dial only
`https` addresses.** The Mac's plain-HTTP addresses are dropped from the rotation
there rather than dialled and failed, and Settings → THIS BROWSER says how many were
dropped and what to do about it. From the copy the Mac serves over `http` there is no
such rule, so all three are in play — which is why a tab opened at
`http://<mac>:8787/` survives the walk from Wi-Fi to cellular.

**Browser storage is per-origin.** A key made on `https://you.github.io` is a
different device from one made on `http://mac:8787`, so each address you use pairs
once and shows up as its own entry in Settings → PAIRED. That is the browser's rule,
not a choice.

---

## What the browser does better than the phone

- **Pointer capture.** On a machine with a mouse or trackpad, clicking the picture
  takes a Pointer Lock; the Mac's cursor then tracks the real one one-to-one at the
  device's own rate. Escape gives it back. This is the reason a laptop is a better
  VibeWire client than a phone.
- **A real drag.** Button down, move, button up. On touch it is press-and-hold then
  move, since a finger sliding on a trackpad has always meant "move the pointer".
  The hold is drawn: a ring fills beside the press — above the finger, which would
  otherwise be standing on it — and once full it stays, riding along, for as long as
  the Mac's button is down.
- **A double click, and a double click that held on.** Two taps land a real double
  click; hold the second one and the button stays down, so the move that follows is
  the drag that selects a word and stretches it. The one-finger double tap that used
  to snap the picture back to fit gave the gesture up to the Mac — two fingers,
  tapped twice, do that now.
- **A real keyboard.** Captured keydown goes straight through, modifiers included, so
  ⌘⇧Z arrives as ⌘⇧Z.
- **Wheel and ⌃wheel.** Scroll wheel scrolls the Mac; the pinch a trackpad reports as
  ⌃wheel zooms.

## What the browser cannot do, stated rather than hidden

| | Phone | Browser | How it is handled |
|---|---|---|---|
| Key storage | Secure Enclave-backed keychain | non-extractable `CryptoKey`, or a raw seed where WebCrypto has no Ed25519 | Settings → THIS BROWSER states which, and what it costs |
| Video decode | `AVSampleBufferDisplayLayer` | WebCodecs `VideoDecoder` | a browser without it gets a banner saying the picture will not appear, and everything else still works |
| Which radio | `NWPathMonitor`, definitive | Network Information API, Chromium only | reported as `UNKNOWN LINK` rather than guessed, and the cellular-cap row says so |
| ⌘W, ⌘T, ⌘N, ⌘Q | reach the Mac | the browser keeps them | named in the keyboard bar; Keyboard Lock takes them in Chromium in fullscreen |
| QR scan | camera + system scanner | `BarcodeDetector` where the engine has one, and never on a plain-`http://` origin | scanned in-page in Chromium; elsewhere the row states why it cannot, and the phone's own camera opens the browser QR anyway |
| Keys of its own | no keyboard to shortcut with | eleven bare keys, listed under `?` | off entirely on a touch device, and every key gives way to a pointer capture, the keyboard bar and any text field |
| Face ID each session | honoured | no equivalent | the Settings row says it governs the iPhone app |
| Screenshot | straight to the pasteboard | clipboard image writes are usually refused | shown, with Save PNG and Copy Image |

---

## Verifying it

```sh
npm run typecheck                       # strict, no implicit any, no unused
npm run build                           # typecheck + bundle

cd ../host && swift build
./.build/debug/VibeWireHost --pair      # prints a six-digit code
node ../web/e2e.mjs <code>              # the whole path, without a browser
```

`e2e.mjs` speaks the protocol the way a browser has to — raw Ed25519 keys,
credentials in the query string, one WebSocket — and checks the static server's
refusals too: path traversal, a forged signature, a reused nonce. Run without a code
it covers everything that needs no pairing.

The first run after `swift build` raises a keychain prompt, because a rebuilt binary
has a new signature. Choose **Always Allow**, or the pairing half fails with
`bad_code` while the host log says `keychain did not respond`.

`host/package-app.sh` builds the same host as `/Applications/VibeWire.app`, signed
with a stable certificate — so the prompt comes once rather than after every build,
and the app is findable from Spotlight. The bundled copy serves the client from
`Contents/Resources/web`, which `package-app.sh` fills from `dist/`. That copy is the
last place `Config.webRoot` looks, after this checkout, so a host run out of the tree
still picks up `npm run build` with no copy step.

---

## Layout

```
src/
  main.tsx              mount
  app/
    App.tsx             three routes, two sheets, the banner
    store.ts            port of AppModel — every state transition lives here
    keymap.ts           KeyboardEvent.code → the host's key names
  net/
    identity.ts         Ed25519, IndexedDB, the paired-host record
    hostClient.ts       pair, challenge, socket, backoff, input queue, ping
    endpoint.ts         address parsing and the mixed-content verdict
    linkMonitor.ts      which radio, when the browser will say
  video/
    frame.ts            the binary header from PROTOCOL.md §2.1, Annex-B, SPS
    renderer.ts         WebCodecs → canvas, one decoder per stream
  design/
    longarm.css         the design system as custom properties
    components.tsx      Caps, Readout, Panel, KeyCap, PrimaryAction, …
    markdown.tsx        Claude's answers, no innerHTML anywhere
  screens/
    Pairing · Home · Remote · ControlHub · KeyboardBar · Settings ·
    ClaudePanel · Diff · VideoSurface
```

Each file names the iOS file it was ported from. Where a comment explains why a value
is what it is, it came across verbatim — the reason is the part that would otherwise
be lost.
