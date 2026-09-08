import type { InputSink } from '../input/inputRouter'

/**
 * The seam between the router and the operating system. One implementation
 * per platform; the router never sees which.
 */
export type PlatformName = 'macos' | 'windows'

export interface PlatformPaths {
  /** Where `config.json`, the secrets and the deployed bundles live. */
  configDir: string
  /** The MCP channel's token file, wherever `channel/vibewire-channel.mjs` writes it. */
  channelToken: string
  /** `~/.claude/projects` on both platforms. */
  claudeProjects: string
  /** Where the `claude` CLI is looked for, in order, before the PATH. */
  claudeCandidates: string[]
  tailscaleCandidates: string[]
  cloudflaredCandidates: string[]
  /** Where to put a fetched cloudflared when none is installed, or null where
   *  the host never fetches one. */
  cloudflaredDownload: string | null
}

export interface MachineInfo {
  /** "Amar's MacBook Pro", "DESKTOP-4F2K1" */
  hostName(): string
  /** "MacBook Pro", "ThinkPad X1 Carbon" — the marketing name, resolved once. */
  model(): Promise<string>
  /** "15.3", "11" */
  osVersion(): string
  /** "24D60", "22631" — the build, where the platform has a useful one. */
  osBuild(): string | null
}

export interface DesktopInfo {
  /** The lock screen or a UAC prompt owns input; nothing this host sends lands. */
  secureDesktopActive(): boolean
  foregroundWindow(): { app: string; title: string; path: string; elevated: boolean }
}

export interface PowerControl {
  lock(): boolean
  wakeDisplays(): boolean
  displaysAsleep(): boolean
}

export interface NetworkInfo {
  /** Whether the inbound rule for the host exists; null where not applicable. */
  firewallRulePresent(): Promise<boolean | null>
  /** 'Private' | 'Public' | 'Domain' on Windows; null elsewhere or unknown. */
  networkProfile(): Promise<string | null>
}

export interface HostPlatform {
  readonly name: PlatformName
  readonly paths: PlatformPaths
  readonly machine: MachineInfo
  /** The injector, or null where this platform has none (the dev Mac). */
  readonly input: InputSink | null
  readonly desktop: DesktopInfo
  readonly power: PowerControl
  readonly network: NetworkInfo
  /** Measured facts the client names as conditions. Empty where none apply. */
  conditions(): Record<string, boolean>
}
