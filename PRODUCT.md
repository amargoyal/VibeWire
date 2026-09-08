# Product

<!-- impeccable:product-schema 1 -->

## Platform

ios, web

The iPhone app (`ios/VibeWire`, SwiftUI, iOS 17+) is the primary design surface and follows iOS conventions. The web client (`web/`, Preact + TypeScript, built by Vite) is a full second client, not a companion: same seven screens, same Longarm system, same `protocolVersion = 1`, ported screen for screen. It is served from two places at once — GitHub Pages for the internet, and the Mac host itself at `http://<mac>:8787/` for the tailnet, because a page on `https://` may not open `ws://` and the host speaks plain HTTP by design. The Mac host (`host/`, Swift Package) carries a third surface that follows macOS conventions, not iOS ones: a menu bar item for the three readings worth checking at a glance, and one window. That window is the Mac app — pairing, paired devices with revoke and sever, displays and the encoder, the Claude session, transport, the event log and settings. It is the same Nightshift system drawn by WebKit out of `web/dashboard`, reached from the menu bar over a per-launch key (`PROTOCOL.md` §8), and it replaces the separate AppKit pairing window and the `--pair` terminal dance both. There is a fourth surface for people without a Mac: the Windows host (`host-electron/`, Electron + TypeScript), which speaks the same version 1 and serves the same web client, so a Windows user downloads one installer and uses the browser client on their phone — there is no Android or Windows phone app and the iOS app needs an Apple developer account this project does not have. It runs on a Mac for development only; the Swift host is the Mac product. The dashboard bundle is its window too, unchanged. There is still no marketing page.

Where the browser cannot do what the phone does, the web client states the difference on screen rather than degrading quietly: Settings → THIS BROWSER names where the signing key actually lives (a non-extractable `CryptoKey`, or a raw seed where WebCrypto lacks Ed25519 — never a Secure Enclave, and never implied to be one), whether this engine has a WebCodecs decoder at all, and which origin the pairing belongs to. `web/README.md` carries the full table.

## Users

One user today: the author, a developer who runs Claude Code and other work on a Mac and wants that Mac in hand while away from the desk — on a couch, in bed, in transit, on a phone that may be on cellular or on a Tailscale path with no Wi-Fi at all.

A public iOS release is possible later but is not committed. The consequence for design is a quality bar, not an audience change: every surface is built to look and behave like a shipping product, so a later App Store decision needs no rework. Do not design for a hypothetical stranger's onboarding until that decision is made — but do not leave anything raw, unlabeled, or diagnostic-only either.

## Product Purpose

VibeWire puts the whole Mac on the phone: its screen, its pointer, its keyboard, its clipboard. Two pieces pair once and then behave as one machine — a menu-bar host on the Mac and an iPhone app.

Success is that reaching for the phone is a real substitute for walking to the desk: the picture is live enough to work against, the pointer lands where the thumb aimed, a typed key arrives, and the connection either works or says precisely why it does not.

## Positioning

The general remote-desktop category treats the Mac as a picture to poke at. VibeWire is built by someone who knows exactly which Mac is on the other end, and spends that knowledge on things a generic client cannot do:

- **Ed25519 device identity, no stored bearer token.** Pairing exchanges public keys; every socket signs a fresh 30-second nonce. The phone holds a private key in the Secure Enclave-backed keychain and nothing that can be replayed.
- **Two transports, honestly labeled.** Tailscale direct is the fast path; a Cloudflare Tunnel is the fallback. The app names which one is live, and its measured latency, rather than showing one undifferentiated "connected".
- **A first-class Claude Code panel.** The host drives the real `claude` CLI and can also inject into a session already open in a terminal, so an agent run started at the desk stays reachable from the phone — including its permission prompts, changed files, and live diff.
- **Condition, not decoration.** Link quality, stream state, and Mac wake state are surfaced as measured values, so the interface never claims health it has not observed.

## Operating Context

- **Two devices, one pairing.** Mac shows a 6-digit code (rotating every 60 s) plus a QR; the phone scans or types it. Trust is stored on the Mac in the login keychain and can be revoked per device, which severs any live socket within 1 s.
- **The network is hostile and changes underfoot.** Direct Tailscale, NAT-traversed, DERP relay, Cloudflare Tunnel, cellular, or nothing. Reconnect is exponential backoff 0.5 s → 8 s for 30 s total; input generated while disconnected is queued (cap 64 events) and replayed in order.
- **One hand, in motion.** The phone is often held one-handed, thumb-only, screen dim, while the picture on it is moving video. This is the reason for the 44 pt floor, the reachable control hub, and the rule that nothing decorative animates beside a live feed.
- **The Mac may be asleep, locked, or missing permissions.** These are ordinary states, not errors, and each has its own screen (wake it, retry, show last frame).
- **Wire protocol is fixed and versioned.** `PROTOCOL.md` is authoritative: HTTP for pairing/discovery, one WebSocket for control (JSON text frames) and video (binary H.264 Annex-B frames). `protocolVersion = 1`; the phone refuses to connect on mismatch rather than half-working. Design must not invent state the protocol does not carry.

## Capabilities and Constraints

**Shipping today (Mac host `0.10.0`, Windows host `0.10.0`, phone `0.9.4`, web `0.10.0`)**

- Screen: up to two displays, single or side-by-side; H.264 with a 1080/720/540 ladder plus `auto`; 60 fps target; per-display renderer.
- Input: relative trackpad with 8 sensitivity ticks, click, double click, scroll with natural-scroll toggle, hold-to-drag behind a ring that fills beside the press, double-tap-and-hold for the drag that stretches a selection, pinch zoom, modifier keys (held and latched), key rows, combos, and batched text from the system keyboard.
- Utilities: clipboard both directions, screenshot to the phone, lock the Mac, wake the Mac, frontmost app/window readout.
- Claude Code panel: session list from `~/.claude/projects`, open or resume, streaming assistant deltas, tool call states, permission allow/deny with once/always scope, changed files, live per-file diff, usage and rate-limit readouts.
- Settings: quality, cellular cap (default on, 3 MB/s ceiling), sensitivity, natural scrolling, Face ID each session (default on), relay-over-internet toggle (default off), paired device list with revoke-one and revoke-all.
- Mac window: pairing with the code, both QRs and the four handshake steps as the host observes them; paired devices with rename, sever and revoke; displays and encoder readouts with the quality ladder and side-by-side; the live Claude session including its permission prompts; transport with the tunnel toggle; the event log since launch; and the same settings the phone writes. Its picture is a one-frame-a-second screenshot, labelled as one — the H.264 stream is addressed to the phone and is not decoded twice.

**Hard constraints**

- macOS host needs **Screen Recording** (ScreenCaptureKit) and **Accessibility** (CGEvent posting) permission. Without Accessibility, input is silently dropped — the UI must never present that as a working connection.
- iOS needs camera (QR scan) and local network. The host serves plain HTTP/WS deliberately; `NSAllowsArbitraryLoads` is required and `NSAllowsLocalNetworking` must never be re-added alongside it (it makes iOS ignore the former).
- The web client inherits three browser rules that cannot be coded around, only named. A page on `https://` may not open `http://` or `ws://`, so the Pages copy reaches the Mac only over the Cloudflare Tunnel and the host serves its own copy for the tailnet. A WebSocket handshake carries no custom headers, so the socket challenge-response has a query-string spelling (`PROTOCOL.md` §1.2) — additive, still version 1. And storage is per-origin, so each address the client is opened from pairs once and appears as its own device on the Mac.
- `NWListener` does not accept on Tailscale's `utun`; a POSIX dual-stack socket owns `:8787` and splices to a loopback listener. Port conflicts are fatal and surfaced, not swallowed.
- Claude Code runs on subscription credentials — API key env vars are stripped from the child process. No API billing is in play and nothing may imply otherwise.
- The MCP channel that injects into a running terminal session depends on a research-preview flag (`--dangerously-load-development-channels`) and may break.

**Explicitly undecided**

- Public release, pricing, and licensing. None chosen; nothing may claim any of them.
- iPad and landscape support beyond what the current layouts happen to do.
- Whether the incumbent Longarm visual system is preserved, extended, or replaced.

## Brand Commitments

- Name: **VibeWire**. Bundle `com.vibewire.phone`; host keychain service `com.vibewire.host.trust`. No logo or wordmark asset exists yet.
- An incumbent design system exists and is named **Longarm** (`ios/VibeWire/Design/Longarm.swift`): dark only with no light mode, color reserved for condition (green reachable / amber degraded / red lost) with cyan reserved for the user's own input, monospace for anything measured and sans for prose, hairlines instead of cards, no shadows, motion limited to 120–180 ms state changes. This is recorded as the incumbent visual truth, not yet declared binding.
- Voice in the existing UI is flat, measured, and specific — it states values and conditions rather than reassuring. `No answer from that address.` is the house tone.

## Evidence on Hand

- `PROTOCOL.md` — complete wire protocol, authoritative for message names and payloads.
- `HANDOFF.md` — engineering log of fixed defects and known gotchas. Historical; some entries are already superseded.
- E2E harness (`scratchpad/e2e.swift`) verified the full path end to end: wrong-code rejection, pairing, Ed25519 handshake, WebSocket upgrade, 25 Claude sessions, 608 KB of H.264 in 4 s.
- `web/e2e.mjs` — the browser spelling of the same path, checked into the repo and runnable against any host that is showing a code: query-string credentials, pairing, nonce reuse, forged signatures, and the static server's traversal refusals.
- **No** customers, testimonials, reviews, install counts, benchmarks against competitors, press, pricing, or App Store presence exist. None may be invented on any surface, including the future landing page.

## Product Principles

1. **Report the condition, never imply one.** Every health signal on screen is derived from a measured value. If it was not measured, it is not shown.
2. **Name the failure precisely.** A timeout, a refused connection, a missing Accessibility permission, and a sleeping Mac are four different states with four different answers. Collapsing them into one message is the defect this product has already paid for once.
3. **Machine state and user state never look alike.** What the Mac is doing and what the user is holding down are distinguishable at a glance, always.
4. **The picture outranks the interface.** When live video is on screen, chrome recedes and nothing decorative moves.
5. **One thumb, in the dark, on a bad link.** Reach, target size, and legibility are judged against that scene, not against a screenshot.

## Accessibility & Inclusion

- 44 pt minimum touch target is already a system rule and holds everywhere; hit areas must match the drawn control's frame, not its ink.
- Dark-only is a product decision, so contrast is carried entirely by the dark palette and must be verified there — against the ground each mark actually lands on, not against the app's base ground. Text is held to WCAG AA and the boundary of a control that has no fill to the 3:1 non-text threshold, which is why the design system carries two line inks rather than one.
- Reduce Motion is honoured in both clients: travel and scale go, arrival stays, and the activity spinner is the stated exception, since freezing one would claim the host had stopped answering.
- VoiceOver and its browser equivalent are established rather than complete. Both clients name every control, both derive a spoken form for a measured value rather than reading three fragments, and the browser announces the states that arrive unasked for — the picture stalling, a tool stopping to ask permission, a handshake step failing. Sheets behave as dialogs in both.
- Dynamic Type is honoured in both clients, and the phone's one stated exception now binds. The browser scales its whole type ramp off the reader's root size and its rows grow rather than crop. On the phone, `NS.Font` takes the reader's size from the view environment rather than reading the application's content size category, which is what makes the remote screen's documented clamp at `accessibility1` mean anything — for most of this app's life it clamped the standard text styles and let every mono readout scale straight past it. The landscape dock and the command drawer are measured against the real glass at the top of the range, and both scroll rather than overflow it.
