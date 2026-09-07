import { app, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { Config } from './core/config'
import { Log, describeError } from './core/log'
import { RendererCaptureHost } from './capture/rendererCaptureHost'
import { NoClaude } from './claude/claudeService'
import { NoInput } from './input/inputRouter'
import { HTTPServer } from './net/httpServer'
import { PairingService } from './pairing/pairingService'
import { FileStore, type SecretStore } from './pairing/secretStore'
import { TrustStore } from './pairing/trustStore'
import { createPlatform } from './platform'
import { HostRouter } from './app/hostRouter'
import { SystemServices } from './system/systemServices'
import { Telemetry } from './system/telemetry'
import { TransportManager } from './transport/transportManager'

/**
 * The host's `@main`. Wires every service, starts the server, and drives the
 * one-second heartbeat that measures, pushes and rotates. Flags:
 *
 *   --port <n>      serve somewhere other than the stored port (not written back)
 *   --pair          open the pairing window at launch
 *   --print-code    print the pairing code to stdout as it rotates
 *   --no-tray       headless: no tray, no windows; a fatal error goes to stderr
 */
const argv = process.argv.slice(1)
const flags = new Set(argv.filter((arg) => arg.startsWith('--')))
const headless = flags.has('--no-tray')

// A hidden window is otherwise a background window: throttled timers and a
// capture pipeline that starves. And monitor capture goes through DXGI Desktop
// Duplication rather than WGC, which draws a yellow border around the screen.
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-features', 'WebRtcAllowWgcScreenCapturer')
app.setName('VibeWire')

/** The repository root when running out of a checkout, so `web/dist` is found
 *  with no copy step; null when packaged. */
function checkoutRoot(): string | null {
  if (app.isPackaged) return null
  // dist/main.js → host-electron → the checkout
  const candidate = resolve(dirname(__dirname), '..')
  return existsSync(join(candidate, 'web', 'package.json')) ? candidate : null
}

function fatal(headline: string, detail: string): never {
  Log.error('app', `${headline}: ${detail}`)
  if (!headless && app.isReady()) dialog.showErrorBox(headline, detail)
  app.exit(1)
  throw new Error(headline)
}

async function main(): Promise<void> {
  const platform = createPlatform()
  Config.init({
    configDir: platform.paths.configDir,
    checkoutRoot: checkoutRoot(),
    resourcesPath: app.isPackaged ? process.resourcesPath : null,
    argv,
    env: process.env,
    version: app.getVersion(),
  })
  Log.info('app', `VibeWire host ${Config.hostVersion} on ${platform.name}, config in ${Config.configDir}`)
  const conditions = platform.conditions()
  if (Object.keys(conditions).length) Log.warn('app', `conditions at launch: ${Object.keys(conditions).join(', ')}`)

  const settings = Config.loadSettings()

  // DPAPI on Windows never prompts, so the sealed store is the default there.
  // On the Mac the keychain does prompt, and the Swift host already paid for
  // learning what that costs: plain files, 0600, in the dev directory.
  let store: SecretStore = new FileStore(Config.configDir)
  if (platform.name === 'windows' && process.env.VIBEWIRE_SECRET_STORE !== 'file') {
    const { SafeStorageStore } = await import('./pairing/safeStorageStore')
    store = new SafeStorageStore(store)
  }
  const trust = new TrustStore(store)
  Log.info('app', `trust store: ${trust.storeKind}`)
  await trust.prime()

  const pairing = new PairingService(trust, { hostName: () => platform.machine.hostName() })
  const telemetry = new Telemetry()
  const transport = new TransportManager(settings.port)
  const system = new SystemServices()
  const capture = new RendererCaptureHost(telemetry, join(__dirname, 'capture'))
  const router = new HostRouter({
    platform,
    trust,
    pairing,
    capture,
    input: new NoInput(),
    system,
    telemetry,
    claude: new NoClaude(),
    transport,
    settings,
  })

  capture.bindLadder(() => router.ladder)

  const server = new HTTPServer(settings.port, router)
  router.server = server
  server.onFatal = (detail) => fatal('VibeWire stopped serving', detail)
  try {
    await server.start()
  } catch (error) {
    fatal(
      `VibeWire could not open port ${settings.port}`,
      `${describeError(error)}\n\nQuit whatever is using it, or start VibeWire with --port <n>.`,
    )
  }
  await transport.refresh()

  if (flags.has('--print-code')) {
    pairing.onCodeChange = (code) => {
      if (code) process.stdout.write(`pairing code: ${code.value}\n`)
      else process.stdout.write('pairing window closed\n')
    }
  }
  if (flags.has('--pair')) pairing.beginPairing()

  setInterval(() => {
    void router.tick()
    pairing.rotateIfNeeded()
    void transport.refreshIfStale()
  }, 1000)

  app.on('before-quit', () => {
    server.stop()
    transport.terminateTunnelNow()
  })
}

// No windows by design: closing the last one must not quit the host.
app.on('window-all-closed', () => {})

app.whenReady().then(main).catch((error) => fatal('VibeWire failed to start', describeError(error)))
