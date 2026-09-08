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

Grant Screen Recording and Accessibility when asked. The iPhone app builds from
`ios/VibeWire.xcodeproj`. Details: `HANDOFF.md`, `web/README.md`.

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
