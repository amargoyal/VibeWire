# VibeWire

Your whole computer on your phone: its screen, its pointer, its keyboard, its
clipboard, and the Claude Code session running on it. Two pieces pair once and
then behave as one machine — a host on the computer and a client on the phone.

- **Mac host** — `host/`, a Swift menu-bar app. Pairs with the iPhone app
  (`ios/`) or the browser client.
- **Windows host** — `host-electron/`, an Electron tray app. Pairs with the
  browser client; there is no phone app for it and none is needed.
- **Browser client** — `web/`, served by the host itself and published to
  GitHub Pages. Same seven screens as the iPhone app.

`PROTOCOL.md` is the wire protocol both hosts speak. `PRODUCT.md` is what the
product is and is not.

## Download

Get the installers from the [latest GitHub release](https://github.com/amargoyal/VibeWire/releases/latest).

- **Mac (Apple silicon or Intel, macOS 14+):** download the universal `.dmg`, open it,
  and drag **VibeWire** onto **Applications**. Eject the image and open the installed app.
- **Windows:** download the `x64.exe` installer, or `arm64.exe` for an ARM PC.

The current Mac release is not notarized and the Windows installers are not
code-signed. First-launch security prompts and setup instructions are documented
on the release page. The iPhone app is a development target, not a release download;
use the browser on your phone.

## Windows

1. Download `VibeWire-Setup-<version>-x64.exe` from the latest release
   (`-arm64` on an ARM PC) and run it. The installer is not code-signed yet, so
   SmartScreen will say "Windows protected your PC": click **More info → Run
   anyway**. It adds an inbound firewall rule for port 8787; that is the only
   thing it does beyond copying files.
2. VibeWire appears in the tray. Open it → **Pair a device…**. The window shows
   a six-digit code and a QR.
3. On the phone, point the camera at the QR. It opens the browser client and
   pairs. Tap **View** for the picture.

Where the phone has to be:

| Situation | What happens | Needs |
|---|---|---|
| Same Wi-Fi | The QR carries `http://<pc-ip>:8787/`. Works with nothing installed. | Nothing. If the phone gets no answer, Windows may have marked the Wi-Fi *Public* — the tray shows the network profile — or the network isolates clients (hotel and guest Wi-Fi do). |
| Away, Tailscale on both | The host lists its tailnet address first. | [Tailscale](https://tailscale.com) on the PC and the phone. |
| Away, no Tailscale | Settings → **Relay over internet**. The host fetches `cloudflared`, opens a quick tunnel, and the QR points at an `https://…trycloudflare.com` address. The address changes each time the host starts; re-scan the QR. | Nothing on the phone. |

What the phone cannot do on Windows: unlock a locked PC. The lock screen owns
input, and the client says so instead of showing dead controls.

The Claude panel drives the `claude` CLI installed on the PC, on the
subscription from `claude login`. `ANTHROPIC_API_KEY` is stripped from its
environment, so nothing is billed to an API key.

Size: about 80 MB to download, 200 MB installed. Chromium does the screen
capture and the H.264 encoding; that is what it costs.

## Mac

```
cd host && swift build && ./package-app.sh      # installs /Applications/VibeWire.app
```

Follow Setup guide to grant Screen Recording and Accessibility. The iPhone app builds from
`ios/VibeWire.xcodeproj`. Details: `HANDOFF.md`, `web/README.md`.

Where the phone has to be, same as on Windows:

| Situation | What happens | Needs |
|---|---|---|
| Same Wi-Fi | The QR carries `http://<mac-ip>:8787/`. Works with nothing installed. | Nothing, as long as the two devices can see each other. |
| Away, Tailscale on both | The host lists its tailnet address first. | [Tailscale](https://tailscale.com) on the Mac and the phone. |
| Away, or a network that isolates its clients | Setup guide → **Turn on relay over internet**, or Settings → **Relay over internet**. The host fetches `cloudflared`, opens a quick tunnel, and the QR points at an `https://…trycloudflare.com` address. The address changes each time the host starts; re-scan the QR. | Nothing on the phone. |

## Which address the QR carries

The browser QR points at whichever of these the phone can actually use:

- **Relay or tailnet up:** the published client at
  `https://amargoyal.github.io/VibeWire`, carrying the host's `https` address in
  the query string. The domain on the phone is this project's, not the quick
  tunnel's four random words, and the page survives the tunnel being reissued.
- **LAN only:** the copy the host serves itself, at `http://<host-ip>:8787/`. A
  page on `https` may not open a plain `http` origin, so the published client
  cannot be used here.

`webClientURL` in `config.json` overrides the published address, and
`VIBEWIRE_WEB_CLIENT` overrides that for one launch.

## Updates

The host asks GitHub whether a newer release exists, at launch and every six
hours, and says so in its window.

On a Mac, **Update and restart** does the whole thing: it downloads the disk
image from the release, checks it against the `SHA256SUMS.txt` published beside
it, checks that the application inside carries the same code-signing identity,
team and bundle identifier as the copy running, copies it next to the installed
app, quits, swaps the two, and opens the new one. If the second move fails the
first is undone, so the worst case is the version you already had, still
installed. Nothing is replaced until both checks pass.

Two checks rather than Gatekeeper, because the Mac build is signed with a
development certificate and is not notarized. A download that does not match
the release's own checksum is refused, and so is one signed by anybody else.
Whoever could pass both already holds the signing key, and a reader in that
position was never protected by being sent to a web page instead.

The button says **Open release** instead where the host cannot replace itself:
a build running from a checkout, from a read-only volume, or from anywhere its
user cannot write. Windows still points at the release page; its installer is
the thing that replaces it.

Settings → **Check for a newer VibeWire** turns the check off. It is one
request to `api.github.com`, carrying nothing but the version in the user
agent.

## Accounts

Nothing on the path to a first picture needs one. Pairing is a key exchange, and
the browser client asks about an account only at the end of setup, once the
pointer has already moved. Skipping is an answer and is remembered.

What an account carries is a directory: the computers you have paired with, the
browsers you have signed in from, and the keyboard bar you built. It never
carries a key, a pairing code, a frame, a clipboard or a Claude transcript, so a
phone restored from it still has six digits to type.

Signing in is a six-digit code by email. The same email holds a link, and Google
and Apple appear where the project has them enabled, in the browser client and in
Mac setup.

The host has one related setting, off by default: **Require a signed-in
browser**, in the pairing sheet and in Settings. On, this computer answers only
browsers signed into the account that owns it — the first account to sign in
claims it, and turning the setting off releases it. The iPhone app is
unaffected: its key lives in the Secure Enclave and it has no account to
present.

`docs/accounts.md` covers what the Supabase project still needs configured, and
the `VITE_SUPABASE_*` and `VIBEWIRE_ACCOUNT_*` overrides for pointing a build at
a different one.

## Scanned the QR and nothing loaded

The address on the QR is a private one, and a phone that cannot reach it shows
a page that will not load while the Mac shows a code nobody is reading. Three
causes, in the order they happen:

1. **The phone is on another network.** School, hotel, office and guest Wi-Fi
   also stop devices on the same network from reaching each other, which looks
   identical. Turn on the relay and scan the new code.
2. **A VPN on the phone is routing past the network.** Cloudflare WARP and most
   always-on VPNs send the phone's traffic out through their own tunnel, so a
   private address on the Wi-Fi it is sitting on is never reached. Pause it,
   set it to allow local addresses, or turn on the relay, which works with WARP
   on because the address is then a public one.
3. **The firewall on the computer is refusing incoming connections.** macOS:
   the pairing window and Setup guide say so and open System Settings → Network
   → Firewall → Options, where VibeWire has to be allowed. Windows: the
   installer adds the inbound rule, and the tray says when it is missing.
4. **The Mac has more than one network and the QR named the other one.** The
   pairing window lists every address this machine is on; the phone has to be
   on one of them.

## Building the Windows host

On any machine with Node 22:

```
cd web && npm ci && npm run build:all           # the client and the dashboard
cd ../host-electron && npm ci && npm run build   # typecheck + bundle
npm test                                          # unit tests, no display needed
```

On the PC, from an interactive desktop session (not over SSH, which has no
desktop to capture or type into):

```
npm start -- --pair --print-code
```

`npm run dist` on Windows produces the installers in `host-electron/release/`;
the `Electron host` workflow does the same on a tag named `electron-v<version>`
and attaches them to a GitHub Release.

On a Mac the same host runs for development — capture, encode, pairing, the
dashboard and Claude all work; input, lock and wake are Windows-only. Point it
at another port so it can sit beside the Swift host:

```
npm start -- --port 8797 --pair --print-code
VIBEWIRE_ORIGIN=http://127.0.0.1:8797 node ../web/e2e.mjs <code>      # the protocol
VIBEWIRE_ORIGIN=http://127.0.0.1:8797 node scripts/stream-check.mjs <code>   # the picture
```

`VIBEWIRE_SYNTHETIC_CAPTURE=1` draws a moving test pattern instead of capturing
a display, for a machine with no screen to capture.

## Flags

| Flag | Meaning |
|---|---|
| `--port <n>` | Serve somewhere other than the stored port. Not written back. |
| `--pair` | Open on the pairing pane at launch. |
| `--print-code` | Print the pairing code to stdout as it rotates. |
| `--dashboard` | Open the window at launch. |
| `--dashboard-url` | Print the window's address, key and all, for a browser. |
| `--no-tray` | Headless: no tray, no windows. |

Configuration lives in `~/.config/vibewire/` on both platforms
(`C:\Users\<you>\.config\vibewire\` on Windows): `config.json`, the paired
devices, and the host's own key — sealed with DPAPI on Windows.

## Packaging a Mac release

Run `host/package-dmg.sh` on a Mac with Xcode, Node/npm and Python 3.9+. It builds
both web surfaces, compiles the host for Apple silicon and Intel, verifies the
bundle and produces `host/build/VibeWire-<version>-mac-universal.dmg`. Packaging
does not install or launch the app.

The window the DMG opens is drawn, not exported: `host/Tools/DMGBackground.swift`
is compiled against the app's own `WaveMark` and `Palette` and renders the
background at 1x and 2x, which `tiffutil` combines into the multi-resolution TIFF
Finder reads. The mark on the installer and the mark in the menu bar are one
path, so neither can drift from the other, and a checked-in PNG cannot go stale
the next time either changes. The volume carries the app's icon too.

The window is light while the app is dark, and that is not an oversight. Finder
draws the label under each icon in the reader's own system appearance, and
nothing inside a disk image can change that colour; on a near-black ground, a
Light Mode reader sees two invisible words where VibeWire and Applications
should be.

    host/Tools/DMGBackground.swift --preview out.png /Applications/VibeWire.app

renders the background with the icons and labels composited at the positions
`dmg-settings.py` hands Finder, which is how to look at a change to the artwork
without mounting anything. Developer ID signing and notarization are required
separately for a distribution that passes Gatekeeper by default.
