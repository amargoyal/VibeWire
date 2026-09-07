import { execFile, execFileSync } from 'node:child_process'
import { hostname, homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { HostPlatform } from '../hostPlatform'

const run = promisify(execFile)

/**
 * The Mac, for development only. The Swift host is the Mac product; this just
 * has to be enough for the server, capture, transport and Claude paths to run
 * here. Input, lock and wake are deliberately absent.
 *
 * Its config directory is deliberately not the Swift host's: sharing
 * `config.json` would make each host clobber the other's settings, and the
 * Swift host's layered secret store deletes a file record once it has migrated
 * it to the keychain.
 */
export function createDarwinPlatform(env: NodeJS.ProcessEnv): HostPlatform {
  const home = homedir()
  const configDir = env.VIBEWIRE_CONFIG_DIR || join(home, '.config', 'vibewire-dev')
  let modelPromise: Promise<string> | null = null
  // "Amar's MacBook Pro", the name System Settings shows, rather than the
  // hostname's "Amars-MacBook-Pro" — the same string the Swift host reports.
  let computerName: string | null = null
  try {
    computerName = execFileSync('/usr/sbin/scutil', ['--get', 'ComputerName'], { encoding: 'utf8' }).trim() || null
  } catch {
    computerName = null
  }

  return {
    name: 'macos',
    paths: {
      configDir,
      channelToken: join(home, '.config', 'vibewire', 'channel.token'),
      claudeProjects: join(home, '.claude', 'projects'),
      claudeCandidates: [join(home, '.local', 'bin', 'claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'],
      tailscaleCandidates: ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/usr/local/bin/tailscale', '/opt/homebrew/bin/tailscale'],
      cloudflaredCandidates: ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'],
      cloudflaredDownload: null,
    },
    machine: {
      hostName() {
        return computerName ?? hostname().replace(/\.local$/, '')
      },
      model() {
        modelPromise ??= (async () => {
          try {
            const { stdout } = await run('/usr/sbin/system_profiler', ['SPHardwareDataType', '-json'])
            const name = JSON.parse(stdout)?.SPHardwareDataType?.[0]?.machine_name
            if (typeof name === 'string' && name.trim()) return name.trim()
          } catch {
            // fall through
          }
          try {
            const { stdout } = await run('/usr/sbin/sysctl', ['-n', 'hw.model'])
            return stdout.trim() || 'Mac'
          } catch {
            return 'Mac'
          }
        })()
        return modelPromise
      },
      osVersion() {
        return systemVersion()
      },
      osBuild() {
        return null
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
      // macOS gates capture on a per-binary grant. Absent, `getDisplayMedia`
      // yields nothing, so it is named rather than left to look like a black
      // screen. `systemPreferences` is Electron's; under plain Node it is absent.
      const status = screenRecordingStatus()
      const conditions: Record<string, boolean> = {}
      if (status !== null && status !== 'granted') conditions.screenRecordingDenied = true
      return conditions
    },
  }
}

export function screenRecordingStatus(): string | null {
  try {
    // Required lazily so this module stays importable from a test without Electron.
    const { systemPreferences } = require('electron') as typeof import('electron')
    return systemPreferences.getMediaAccessStatus('screen')
  } catch {
    return null
  }
}

/** Electron adds `process.getSystemVersion`; plain Node under test does not. */
function systemVersion(): string {
  const getter = (process as unknown as { getSystemVersion?: () => string }).getSystemVersion
  if (getter) {
    const version = getter()
    return version.split('.').slice(0, 2).join('.')
  }
  return 'unknown'
}
