import { BrowserWindow } from 'electron'
import { Config } from '../core/config'
import { Log } from '../core/log'

/**
 * The app's one window: the built dashboard bundle, drawn by Chromium, off the
 * host's own port behind the launch key. The panes it draws are the same panes
 * the web client draws for the phone, out of the same design system, which is
 * why this is a page and not a second, native implementation of them.
 */
export class DashboardWindow {
  private window: BrowserWindow | null = null

  constructor(private readonly port: number) {}

  /** The launch key is a path segment, so the whole surface is behind it. The
   *  trailing slash is what keeps the bundle's relative assets under the key. */
  private get url(): string {
    return `http://127.0.0.1:${this.port}/dashboard/${Config.dashboardKey}/`
  }

  /** Brings the window up, optionally on a named pane: one of the seven the
   *  dashboard draws, or `pair` for the pairing sheet. */
  show(pane: string | null = null): void {
    const created = this.ensureWindow()
    const window = this.window
    if (!window) return
    if (pane) {
      if (created) {
        // Nothing has loaded yet; the fragment is read on start-up.
        void window.loadURL(`${this.url}#${pane}`)
      } else {
        void window.webContents.executeJavaScript(
          `window.vibewireShowPane && window.vibewireShowPane(${JSON.stringify(pane)})`,
          true,
        )
      }
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  private ensureWindow(): boolean {
    if (this.window && !this.window.isDestroyed()) return false
    const window = new BrowserWindow({
      width: 1360,
      height: 900,
      minWidth: 1040,
      minHeight: 680,
      title: 'VibeWire',
      show: false,
      // The page draws its own ground; a white flash between launch and
      // first paint is the one moment this app looks like a browser.
      backgroundColor: '#0F1114',
      autoHideMenuBar: true,
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
      webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
    })
    window.on('closed', () => {
      this.window = null
    })
    window.webContents.on('did-fail-load', (_event, code, description) => {
      Log.error('app', `dashboard could not load: ${description} (${code})`)
      void window.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(unreachablePage(this.port, description))}`)
    })
    window.webContents.once('did-finish-load', () => Log.info('app', 'dashboard window loaded'))
    window.once('ready-to-show', () => window.show())
    this.window = window
    void window.loadURL(this.url)
    return true
  }
}

/** A window that cannot reach its own host must say which of the two broke. */
function unreachablePage(port: number, detail: string): string {
  const escaped = detail.replace(/</g, '&lt;')
  return `<!doctype html><meta charset="utf-8"><title>VibeWire</title>
<style>
  body { margin:0; display:grid; place-items:center; min-height:100vh; background:#0F1114; color:#F2F3F6; font:15px/1.5 system-ui, sans-serif }
  div { max-width:34rem; padding:2rem } p { color:#A5A9B1 } code { color:#F7C15F; font:13px ui-monospace, Consolas, monospace }
</style>
<div>
  <h1>No answer on 127.0.0.1:${port}</h1>
  <p>The window loaded, but the host is not answering on its own port. That is the host, not this window &mdash; every reading here would have come from it.</p>
  <p><code>${escaped}</code></p>
</div>`
}
