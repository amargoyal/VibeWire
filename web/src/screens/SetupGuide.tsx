import { useState } from 'preact/hooks'

const KEY = 'vibewire.client-setup.v1'
function hasSeenGuide() {
  try { return localStorage.getItem(KEY) === 'seen' } catch { return false }
}
export function SetupGuide({ initiallyClosed = false }: { initiallyClosed?: boolean }) {
  const [open, setOpen] = useState(() => !initiallyClosed && !hasSeenGuide())
  function close() {
    try { localStorage.setItem(KEY, 'seen') } catch { /* Help still works without storage. */ }
    setOpen(false)
  }
  if (!open) return <button class="setup__button setup__button--quiet" onClick={() => setOpen(true)}>How to connect</button>
  return <section class="client-setup" aria-label="Connect this browser">
    <div class="row" style={{ justifyContent: 'space-between', gap: 12 }}><span class="setup__eyebrow">CONNECT THIS DEVICE</span><button class="setup__button setup__button--quiet" onClick={close}>Skip</button></div>
    <h2>Your computer stays put.<br />Your work comes with you.</h2>
    <p>This is the viewer. Run VibeWire on the computer you want to control, then connect here. No account needed.</p>
    <ol>
      <li><strong>Start on your computer.</strong> Open VibeWire from the menu bar or Windows tray. On a Mac, follow Setup guide to allow Screen Recording and Accessibility.</li>
      <li><strong>Bring your phone alongside.</strong> Start on the same Wi-Fi. Choose Pair a device on the computer and scan its browser QR with your phone’s Camera. Or enter the computer’s address and six-digit code below.</li>
      <li><strong>Open View after pairing.</strong> Move a finger to move the pointer; tap to click. Use Keyboard to type. Check the picture and controls before leaving.</li>
    </ol>
    <details><summary>Browser permissions and connection help</summary>
      <p>Camera access is only for scanning inside this page. You can type the code instead. Allow local network access if your browser asks when connecting to your computer.</p>
      <p>On a local HTTP page, the browser may block the camera or clipboard. Use your phone’s Camera to scan the browser QR, or type the address and code. An HTTPS page cannot connect directly to an HTTP computer: open the browser link shown by the host.</p>
      <p>Pairing belongs to this browser and this site address. Changing browsers, clearing site data, or using a new relay address may require pairing again.</p>
    </details>
    <details><summary>Connecting away from home</summary><p>Set up Tailscale on both devices, or enable Relay over the internet on your computer. Test with your phone on cellular before leaving. The computer must stay awake with VibeWire running.</p></details>
    <button class="setup__button" onClick={close}>Continue to pairing</button>
    <button class="setup__button setup__button--quiet" onClick={close}>Skip guide</button>
  </section>
}
