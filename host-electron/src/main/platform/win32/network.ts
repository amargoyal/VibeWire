import { execFile } from 'node:child_process'
import type { NetworkInfo } from '../hostPlatform'

/** The rule the installer writes; the runtime only looks for it by name. */
export const FIREWALL_RULE_NAME = 'VibeWire'

function run(file: string, args: string[], timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, windowsHide: true, encoding: 'utf8' }, (error, stdout) => {
      resolve(error ? null : stdout)
    })
  })
}

/**
 * Two facts a phone on the LAN depends on. Each is asked at most once a
 * minute: both fork a process, and neither changes faster than that.
 */
export function createWin32Network(): NetworkInfo {
  let rule: { at: number; value: boolean | null } | null = null
  let profile: { at: number; value: string | null } | null = null

  return {
    async firewallRulePresent() {
      if (rule && Date.now() - rule.at < 60_000) return rule.value
      const output = await run('netsh', ['advfirewall', 'firewall', 'show', 'rule', `name=${FIREWALL_RULE_NAME}`], 5000)
      const value = output === null ? null : /Rule Name:/i.test(output) || /Enabled:/i.test(output)
      rule = { at: Date.now(), value }
      return value
    },
    async networkProfile() {
      if (profile && Date.now() - profile.at < 60_000) return profile.value
      const output = await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', '(Get-NetConnectionProfile | Select-Object -First 1).NetworkCategory'],
        8000,
      )
      const value = output ? output.trim().split(/\r?\n/)[0]?.trim() || null : null
      profile = { at: Date.now(), value: value && /^(Public|Private|DomainAuthenticated)$/i.test(value) ? (value === 'DomainAuthenticated' ? 'Domain' : value) : null }
      return profile.value
    },
  }
}
