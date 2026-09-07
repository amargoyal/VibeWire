import { execFile, execFileSync } from 'node:child_process'
import { hostname, homedir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { HostPlatform } from '../hostPlatform'

const run = promisify(execFile)

/**
 * The Mac, for development only. The Swift host is the Mac product; this just
 * has to be enough for the server, capture and Claude paths to run here.
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
    conditions() {
      return {}
    },
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
