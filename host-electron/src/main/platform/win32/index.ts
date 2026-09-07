import { hostname, homedir } from 'node:os'
import { join } from 'node:path'
import type { HostPlatform } from '../hostPlatform'

/**
 * Windows. Phase 3 knows where things live and what to call the machine;
 * input, capture conditions, power and the firewall arrive with the platform
 * phase, through koffi.
 */
export function createWin32Platform(env: NodeJS.ProcessEnv): HostPlatform {
  const home = homedir()
  // `~/.config/vibewire` on Windows too: it is where the Mac host, the docs and
  // the MCP channel all already look, and `~/.claude` is the local precedent for
  // a dot-directory in the profile.
  const configDir = env.VIBEWIRE_CONFIG_DIR || join(home, '.config', 'vibewire')
  const programFiles = env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const localAppData = env.LOCALAPPDATA || join(home, 'AppData', 'Local')
  const appData = env.APPDATA || join(home, 'AppData', 'Roaming')

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
      async model() {
        return 'PC'
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
    desktop: {
      secureDesktopActive() {
        return false
      },
      foregroundWindow() {
        return { app: 'Unknown', title: '', path: '', elevated: false }
      },
    },
    power: {
      lock() {
        return false
      },
      wakeDisplays() {
        return false
      },
      displaysAsleep() {
        return false
      },
    },
    network: {
      async firewallRulePresent() {
        return null
      },
      async networkProfile() {
        return null
      },
    },
    conditions() {
      return {}
    },
  }
}

function buildNumber(): number | null {
  const getter = (process as unknown as { getSystemVersion?: () => string }).getSystemVersion
  const version = getter ? getter() : ''
  const build = Number(version.split('.')[2])
  return Number.isFinite(build) && build > 0 ? build : null
}
