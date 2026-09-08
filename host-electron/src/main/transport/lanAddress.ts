import { networkInterfaces } from 'node:os'

/**
 * The address a phone on the same Wi-Fi would dial.
 *
 * First IPv4, not internal, not link-local, on an adapter that is not a
 * virtual one: Hyper-V, WSL, VirtualBox, VMware and Tailscale all present
 * adapters with addresses nothing off this machine can reach. Wired before
 * wireless when both are up, since it answers faster and moves less.
 */
const VIRTUAL = /^(vEthernet|VirtualBox|VMware|Tailscale|Hyper-V|WSL|Loopback|Bluetooth|utun|bridge|awdl|llw|vmnet|docker)/i
const WIRED = /^(en0|Ethernet|eth)/i

export function primaryLANAddress(): string | null {
  const candidates: { name: string; address: string }[] = []
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    if (!entries || VIRTUAL.test(name)) continue
    for (const entry of entries) {
      if (entry.family !== 'IPv4' || entry.internal) continue
      if (entry.address.startsWith('169.254.')) continue
      candidates.push({ name, address: entry.address })
    }
  }
  if (!candidates.length) return null
  candidates.sort((a, b) => Number(WIRED.test(b.name)) - Number(WIRED.test(a.name)))
  return candidates[0].address
}
