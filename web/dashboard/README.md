# The Mac dashboard

The host's own window. Same repository, same `node_modules`, same design system
as the phone client — a second Vite build out of `web/`, not a second project.

```
npm ci
npm run build:dashboard      # → web/dist-dashboard
npm run dev:dashboard        # vite on :5274, against a host you point it at
```

A host run out of the checkout finds `web/dist-dashboard` by itself. An installed
one wants `./deploy-dashboard-to-host.sh`, which copies the build to
`~/.config/vibewire/dashboard`.

## Why it is here and not in its own project

It imports `../src/design/nightshift.css` and `../src/design/components.tsx`
directly. That is the whole reason it lives beside the client rather than in a
directory of its own: the two surfaces draw the same instrument, and the last
time this codebase had two implementations of one palette they drifted a step
apart. One design system, two `dist`s.

The Swift side is `host/Sources/VibeWireHost/App/DashboardWindow.swift` (a
`WKWebView` in an `NSWindow`) and `Net/DashboardService.swift` (the API).
`PROTOCOL.md` §8 is authoritative for the wire.

## Opening it

From the menu bar: **VibeWire → Open VibeWire**, or **Pair a device…** to open it
straight onto the pairing sheet. `--pair` and `--dashboard` do the same at launch.

The bundle and the API both sit behind a key minted at launch and held only in
memory. The window is opened with it; `--dashboard-url` prints it if you would
rather use a browser. It is not written to the settings file, the keychain or the
log, and it changes every time the host starts — a window left open across a host
restart will say so rather than silently showing stale numbers.

## What it does not do

- **No live video.** The hero panel is a screenshot at one frame a second and the
  chip says so. The encoder's H.264 is addressed to the phone; decoding it again
  on the machine that encoded it would buy a smoother thumbnail and nothing else.
- **No start-capture.** Selecting a display records the choice; a stream needs
  something attached to send frames to. Stop is offered only while one is running.
- **No second Claude session.** The host runs one `claude` process and fans its
  output to both surfaces, so opening a session here opens it on the phone too.
  That is the point — an agent run started at the desk stays reachable from the
  phone, and one that stops to ask permission can be answered from either.

## Reading it

Values come from `GET /v1/dashboard/state` once a second — the same cadence the
host measures at. Anything it has not measured prints as an em dash, never as a
zero: `0 MS` is a claim about a round trip and `—` is the absence of one. The
device list has three states rather than two, because a keychain that did not
answer and a Mac with nothing paired are different facts.
