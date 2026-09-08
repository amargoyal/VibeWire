import { hostname, homedir } from 'node:os'
import { join } from 'node:path'
import { Log, describeError } from '../../core/log'
import type { InputSink } from '../../input/inputRouter'
import type { HostPlatform } from '../hostPlatform'
import { createWin32Desktop } from './desktop'
import { createWin32Network } from './network'
import { createWin32Power } from './power'
import { resolveWindowsModel } from './machine'
import { loadUser32, type User32 } from './user32'

/**
 * Windows. Input, lock and wake go through user32 via koffi; the firewall and
 * the network profile through the tools Windows ships; everything else through
 * Electron. Config lives in `~/.config/vibewire` on Windows too: it is where
 * the Mac host, the docs and the MCP channel already look, and `~/.claude` is
 * the local precedent for a dot-directory in the profile.
 */
export function createWin32Platform(env: NodeJS.ProcessEnv): HostPlatform {
  const home = homedir()
  const configDir = env.VIBEWIRE_CONFIG_DIR || join(home, '.config', 'vibewire')
  const programFiles = env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
  const appData = env.APPDATA || join(home, 'AppData', 'Roaming')

  let user32Handle: User32 | null = null
  let user32Failure: string | null = null
  const user32 = (): User32 | null => {
    if (user32Handle || user32Failure) return user32Handle
    try {
      user32Handle = loadUser32()
    } catch (error) {
      user32Failure = describeError(error)
      Log.error('input', `Win32 input unavailable: ${user32Failure}`)
    }
    return user32Handle
  }

  let input: InputSink | null = null
  const api = user32()
  if (api) {
    // Required lazily so the module graph stays loadable off Windows.
    const { Win32InputSink } = require('./input') as typeof import('./input')
    input = new Win32InputSink(api)
  }

  const desktop = createWin32Desktop(user32)
  const network = createWin32Network()
  let modelPromise: Promise<string> | null = null
  let firewallRule: boolean | null = null
  void network.firewallRulePresent().then((present) => {
    firewallRule = present
  })

  return {
    name: 'windows',
    paths: {
      configDir,
      channelToken: join(home, '.config', 'vibewire', 'channel.token'),
      claudeProjects: join(home, '.claude', 'projects'),
      claudeCandidates: [join(home, '.local', 'bin', 'claude.exe'), join(appData, 'npm', 'claude.cmd')],
      tailscaleCandidates: [join(programFiles, 'Tailscale', 'tailscale.exe')],
      cloudflaredCandidates: [
        join(programFilesX86, 'cloudflared', 'cloudflared.exe'),
        join(programFiles, 'cloudflared', 'cloudflared.exe'),
        join(localAppData, 'VibeWire', 'bin', 'cloudflared.exe'),
      ],
      cloudflaredDownload: join(localAppData, 'VibeWire', 'bin', 'cloudflared.exe'),
    },
    machine: {
      hostName() {
        return hostname()
      },
      model() {
        modelPromise ??= resolveWindowsModel()
        return modelPromise
      },
      osVersion() {
        const build = buildNumber()
        // Windows 11 kept the 10.0 major; the build number is what tells them apart.
        if (build === null) return 'Windows'
        return build >= 22000 ? '11' : '10'
      },
      osBuild() {
        const build = buildNumber()
        return build === null ? null : String(build)
      },
    },
    input,
    desktop,
    power: createWin32Power(user32),
    network: {
      async firewallRulePresent() {
        firewallRule = await network.firewallRulePresent()
        return firewallRule
      },
      networkProfile: () => network.networkProfile(),
    },
    conditions() {
      const conditions: Record<string, boolean> = {}
      if (!input) conditions.inputUnavailable = true
      if (desktop.secureDesktopActive()) conditions.inputBlockedBySecureDesktop = true
      else if (input && desktop.foregroundWindow().elevated) conditions.inputBlockedByElevatedWindow = true
      if (firewallRule === false) conditions.firewallRuleMissing = true
      return conditions
    },
  }
}

function buildNumber(): number | null {
  const getter = (process as unknown as { getSystemVersion?: () => string }).getSystemVersion
  const version = getter ? getter() : ''
  const build = Number(version.split('.')[2])
  return Number.isFinite(build) && build > 0 ? build : null
}
