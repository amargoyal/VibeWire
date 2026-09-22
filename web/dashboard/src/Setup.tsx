import { useState } from 'preact/hooks'
import { pairOpen, pane, reachability, send, type Facts } from './store'

/**
 * What the address on the QR requires of the phone, in one sentence.
 *
 * A private address on screen looks correct from both ends when it is
 * unreachable, so the difference between "works from anywhere" and "works in
 * this building" is said rather than left to be discovered on a phone that
 * shows a page failing to load.
 */
function reachLine(state: Facts): string {
  const { lanAddresses, tunnelRunning } = state.addresses
  if (tunnelRunning) return 'The relay is on, so that address answers from anywhere, cellular included.'
  if (state.transport.tailscaleAddress) return 'That is the tailnet address; it answers wherever Tailscale is running on both devices.'
  if (lanAddresses.length === 0) return 'This computer has no address but its own loopback, so nothing else can reach it yet.'
  return `It answers only on this computer’s own network (${lanAddresses.join(', ')}), so the phone has to be on it.`
}

/** Progress is observed host state, never a remembered sequence of clicks. */
export function Setup({ state }: { state: Facts }) {
  const [pending, setPending] = useState<string | null>(null)
  const [requested, setRequested] = useState<string | null>(null)
  const windows = state.host.platform === 'windows'
  const permissions = state.permissions.screenRecording && state.permissions.accessibility
  const paired = state.devicesReadable === 'yes' && state.devices.length > 0
  const live = reachability.value === 'live'
  const relayOn = state.addresses.tunnelRunning
  async function request(which: string) {
    setPending(which)
    if (await send({ do: 'permission.request', which })) setRequested(which)
    setPending(null)
  }
  return <div class="pane setup" data-screen-label="Setup guide">
    <header class="setup__header">
      <div class="row" style={{ justifyContent: 'space-between', gap: 12 }}><span class="setup__eyebrow">ON THIS COMPUTER</span><button class="setup__button setup__button--quiet" onClick={() => { pane.value = 'overview' }}>Skip setup</button></div>
      <h1>Your computer.<br />Within reach.</h1>
      <p>Keep your work here. See and control it from your phone.</p>
      <div class="setup__route" aria-label="This computer shares its screen with your phone">
        <span>▱ &nbsp; {state.host.name}</span><span aria-hidden="true">→</span><span>▯ &nbsp; Your phone</span>
      </div>
    </header>
    <ol class="setup__steps">
      <li><span class="setup__number">1</span><div>
        <h2>{permissions ? 'Computer access is ready' : 'Allow the access you need'}</h2>
        <p>{windows ? 'Windows provides screen capture and input without the macOS permission prompts. Keep this computer unlocked for remote control.' : 'These permissions belong on your Mac. Your phone does not need permission to record its own screen.'}</p>
        {!windows && <div class="setup__permissions">
          {([['screen', 'Screen Recording', 'Lets VibeWire send your Mac’s screen to your phone.', state.permissions.screenRecording], ['accessibility', 'Accessibility', 'Lets your phone move the pointer, click, and type on this Mac.', state.permissions.accessibility]] as const).map(([key, label, why, granted]) => <div class="setup__permission" key={key}>
            <div><h3>{label}</h3><p>{why}</p></div>
            {granted ? <span class="setup__done">Allowed</span> : <button class="setup__button" disabled={!live || pending !== null} onClick={() => void request(key)}>{pending === key ? 'Opening…' : `Allow ${label}`}</button>}
          </div>)}
        </div>}
        {requested && !permissions && <p role="status">In System Settings → Privacy &amp; Security, enable VibeWire for {requested === 'screen' ? 'Screen Recording (or Screen & System Audio Recording)' : 'Accessibility'}. Return here afterward. If macOS asks you to quit and reopen VibeWire, do so. This checklist checks again automatically.</p>}
        {!permissions && <details><summary>Permission still missing?</summary><p>Open System Settings → Privacy &amp; Security and select the permission above. Enable VibeWire; use the + button to add it from Applications if needed. You can change access here at any time.</p></details>}
      </div></li>
      <li><span class="setup__number">2</span><div>
        <h2>{paired ? 'A device is paired' : 'Pair your phone'}</h2>
        <p>Keep both devices awake and start on the same Wi-Fi. Open the pairing code here, then scan the browser QR with your phone’s Camera. In the iPhone app, use its scanner and the app QR instead.</p>
        <p class="setup__hint">Your phone opens {state.addresses.origin}. {reachLine(state)}</p>
        {state.addresses.firewall.blocksIncoming && <div class="setup__blocked" role="alert">
          <h3>This computer is refusing the connection</h3>
          <p>{state.addresses.firewall.detail} A phone on the same Wi-Fi gets the same nothing as a phone on the other side of the world until that changes.</p>
          <button class="setup__button" onClick={() => void send({ do: 'settings.open', which: 'firewall' })}>Open Firewall settings</button>
        </div>}
        <button class="setup__button" disabled={!live} onClick={() => { pairOpen.value = true }}>Open pairing code</button>
        <details><summary>Scanned it and nothing loaded?</summary>
          <p>That address answers only on this computer’s own network, and school, hotel and guest Wi-Fi usually stop devices from reaching each other even when both are on it. A VPN on the phone has the same effect from the other end: Cloudflare WARP and most always-on VPNs route the phone past the network it is sitting on, so a private address never reaches anything. Turn on the relay: the pairing QR changes to an https address that works from anywhere, including cellular and WARP. Scan the new code, because the old one points at the old address.</p>
          <button class="setup__button" disabled={!live || relayOn} onClick={() => void send({ do: 'transport.tunnel', on: true })}>{relayOn ? 'Relay is on' : 'Turn on relay over internet'}</button>
          {state.transport.relayProblem && <p role="status">{state.transport.relayProblem}</p>}
        </details>
        <p class="setup__hint">Only pair a device you trust: it can control this computer. Remove its access later in Devices.</p>
      </div></li>
      <li><span class="setup__number">3</span><div>
        <h2>Try it before you leave</h2>
        <p>On your phone, open View. Check that you can see the desktop, move the pointer, and click. Keep VibeWire running on this computer.</p>
        <p style={{ color: live && state.encoder.capturing && state.link.attached ? 'var(--ns-green)' : 'var(--ns-text-secondary)' }} role="status">{!live ? 'Waiting for the host to answer.' : state.encoder.capturing && state.link.attached ? 'A device is connected and the host is sending video.' : paired ? 'Paired. Open View on your phone to test the picture and controls.' : 'Waiting for your first paired device.'}</p>
        <details><summary>Using your phone away from home</summary><p>Same Wi-Fi is the simplest first connection. For another network, configure Tailscale on both devices, or enable Relay over the internet in Transport. A relay address can change; scan a fresh pairing QR when needed. Test on cellular before leaving the computer.</p><button class="setup__button" onClick={() => { pane.value = 'transport' }}>Open Transport</button></details>
      </div></li>
      {state.settings?.accountsAvailable && <li><span class="setup__number">4</span><div>
        <h2>{state.settings.requireAccount ? 'A sign-in is required here' : 'Decide who may use this computer'}</h2>
        <p>Pairing is enough by default: a browser holding a key this computer agreed to is answered. You can ask for more — that the browser also be signed into a VibeWire account, which is worth doing when this computer is reachable over the relay and the phone it was paired with can be lost or lent.</p>
        <p class="setup__hint">{state.settings.requireAccount
          ? state.settings.accountOwnerEmail
            ? `Only browsers signed in as ${state.settings.accountOwnerEmail} are answered. The iPhone app is unaffected.`
            : 'The first account to sign in claims this computer. Every other browser is then refused. The iPhone app is unaffected.'
          : 'No account is asked for. Turning this on does not unpair anything.'}</p>
        <button class="setup__button" disabled={!live} onClick={() => void send({ do: 'setting.set', key: 'requireAccount', value: !state.settings?.requireAccount })}>{state.settings.requireAccount ? 'Stop requiring a sign-in' : 'Require a signed-in browser'}</button>
      </div></li>}
    </ol>
    <button class="setup__button setup__button--quiet" onClick={() => { pane.value = 'overview' }}>Go to overview</button>
    <p class="setup__hint">You can return to Setup guide at any time.</p>
  </div>
}
