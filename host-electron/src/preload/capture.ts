import { ipcRenderer } from 'electron'

// The one job of this preload: hand the MessagePort the main process sends
// with `capture:open` across the context-isolation boundary to the page. The
// page then talks to main over that port and never touches IPC again.
ipcRenderer.on('capture:open', (event, data) => {
  window.postMessage({ kind: 'capture:open', data }, '*', event.ports)
})
