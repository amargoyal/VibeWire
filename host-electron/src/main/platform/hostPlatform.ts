/**
 * The seam between the router and the operating system. One implementation
 * per platform; the router never sees which. Grows a section per phase — this
 * is the part that phase 1 needs.
 */
export type PlatformName = 'macos' | 'windows'

export interface PlatformPaths {
  /** Where `config.json`, the secrets and the deployed bundles live. */
  configDir: string
  /** The MCP channel's token file, wherever `channel/vibewire-channel.mjs` writes it. */
  channelToken: string
  /** `~/.claude/projects` on both platforms. */
  claudeProjects: string
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

export interface HostPlatform {
  readonly name: PlatformName
  readonly paths: PlatformPaths
  readonly machine: MachineInfo
  /** Measured facts the client names as conditions. Empty where none apply. */
  conditions(): Record<string, boolean>
}
