import { createDarwinPlatform } from './darwin'
import type { HostPlatform } from './hostPlatform'
import { createWin32Platform } from './win32'

export type { HostPlatform } from './hostPlatform'

export function createPlatform(env: NodeJS.ProcessEnv = process.env): HostPlatform {
  switch (process.platform) {
    case 'win32':
      return createWin32Platform(env)
    case 'darwin':
      return createDarwinPlatform(env)
    default:
      throw new Error(`VibeWire has no host for ${process.platform}`)
  }
}
