import { app, Menu, nativeImage, Tray, type MenuItemConstructorOptions } from 'electron'
import { join } from 'node:path'
import type { HostRouter } from './hostRouter'
import type { DashboardWindow } from './dashboardWindow'
import type { PairingService } from '../pairing/pairingService'
import type { TransportManager } from '../transport/transportManager'
import type { Telemetry } from '../system/telemetry'
import type { HostPlatform } from '../platform/hostPlatform'

/**
 * The tray item: three measured facts and the way to the window. The Mac host
 * draws its own panel under the status item; here the platform's menu is the
 * honest surface, and it carries the same readings as rows.
 */
export interface TrayDeps {
  router: HostRouter
  pairing: PairingService
  transport: TransportManager
  telemetry: Telemetry
  platform: HostPlatform
  dashboard: DashboardWindow
  resourcesDir: string
}

export class TrayController {
  private tray: Tray | null = null
  private readonly launchedAt = Date.now()

  constructor(private readonly deps: TrayDeps) {}

  install(): void {
    const iconPath = join(this.deps.resourcesDir, process.platform === 'darwin' ? 'tray.png' : 'icon.png')
    let icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) icon = nativeImage.createEmpty()
    else if (process.platform === 'win32') icon = icon.resize({ width: 16, height: 16 })
    const tray = new Tray(icon)
    tray.setToolTip('VibeWire')
    tray.on('click', () => this.refresh())
    tray.on('right-click', () => this.refresh())
    tray.on('double-click', () => this.deps.dashboard.show())
    this.tray = tray
    this.refresh()
  }

  /** Rebuilds the menu from current readings. Cheap, so it runs on every open
   *  and on the heartbeat. */
  refresh(): void {
    if (!this.tray) return
    const { router, pairing, transport, telemetry, platform, dashboard } = this.deps
    const serving = router.serving
    const attached = router.attached
    const status = transport.status()
    const link = telemetry.snapshot()
    const code = pairing.currentCode()
    const conditions = Object.keys(platform.conditions())
    const path = status.cloudflareRunning && status.cloudflareHostname ? 'TUNNEL' : status.tailscaleRunning ? 'TAILSCALE' : status.lanAddress ? 'LAN' : 'NO ADDRESS'
    const uptime = formatUptime(Date.now() - this.launchedAt)

    const readings: MenuItemConstructorOptions[] = [
      { label: platform.machine.hostName(), enabled: false },
      { label: attached ? `ATTACHED · ${attached.deviceName}` : 'IDLE · NOTHING ATTACHED', enabled: false },
      {
        label: `${path} · ${link.rttMillis !== null ? `${Math.round(link.rttMillis)} MS` : '—'} · ${serving.streams} STREAM${serving.streams === 1 ? '' : 'S'}`,
        enabled: false,
      },
      { label: `UP ${uptime} · PORT ${status.port}`, enabled: false },
    ]
    if (conditions.length) readings.push({ label: `CONDITION · ${conditions.join(', ')}`, enabled: false })
    if (code) readings.push({ label: `PAIRING CODE ${code.value} · ${pairing.secondsRemaining(code)}S`, enabled: false })

    const menu = Menu.buildFromTemplate([
      ...readings,
      { type: 'separator' },
      { label: 'Open VibeWire', click: () => dashboard.show() },
      { label: 'Pair a device…', click: () => this.beginPairing() },
      { type: 'separator' },
      {
        label: process.platform === 'win32' ? 'Start with Windows' : 'Start at login',
        type: 'checkbox',
        checked: app.getLoginItemSettings().openAtLogin,
        click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked, args: ['--tray'] }),
      },
      { type: 'separator' },
      { label: 'Quit VibeWire', click: () => app.quit() },
    ])
    this.tray.setContextMenu(menu)
    this.tray.setToolTip(attached ? `VibeWire · ${attached.deviceName} attached` : 'VibeWire · idle')
  }

  beginPairing(): void {
    if (!this.deps.pairing.currentCode()) this.deps.pairing.beginPairing()
    this.deps.dashboard.show('pair')
    this.refresh()
  }
}

function formatUptime(millis: number): string {
  const seconds = Math.floor(millis / 1000)
  const days = Math.floor(seconds / 86400)
  const hours = Math.floor((seconds % 86400) / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  if (days > 0) return `${days}D ${pad(hours)}H`
  if (hours > 0) return `${hours}H ${pad(minutes)}M`
  return `${minutes}M ${pad(seconds % 60)}S`
}

function pad(value: number): string {
  return String(value).padStart(2, '0')
}
