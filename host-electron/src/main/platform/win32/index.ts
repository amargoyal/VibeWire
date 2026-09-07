import { hostname, homedir } from 'node:os'
import { join } from 'node:path'
import type { HostPlatform } from '../hostPlatform'

/**
 * Windows. Phase 1 knows only where things live and what to call the machine;
 * input, capture, power and the firewall arrive with the platform phase.
 */
export function createWin32Platform(env: NodeJS.ProcessEnv): HostPlatform {
  const home = homedir()
  // `~/.config/vibewire` on Windows too: it is where the Mac host, the docs and
  // the MCP channel all already look, and `~/.claude` is the local precedent for
  // a dot-directory in the profile.
  const configDir = env.VIBEWIRE_CONFIG_DIR || join(home, '.config', 'vibewire')

  return {
    name: 'windows',
    paths: {
      configDir,
      channelToken: join(home, '.config', 'vibewire', 'channel.token'),
      claudeProjects: join(home, '.claude', 'projects'),
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
