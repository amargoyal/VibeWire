import { render } from 'preact'
import { App } from '../src/App'
import { facts, pane, reachability, type Facts } from '../src/store'
import '../src/dashboard.css'

const params = new URLSearchParams(location.search)
const complete = params.has('complete')
facts.value = {
  setupCompleted: complete, browserSignIn: true, at: '',
  host: { platform: 'macos', name: 'Test Mac', model: 'MacBook Pro', os: '15', version: 'test', protocol: 1, uptimeSeconds: 10, port: 8787, awake: true, hostKey: 'test', pathWord: 'DIRECT', webBundle: { present: true, bytes: 123 }, dashboardBundle: { present: true, bytes: 123 } },
  permissions: { screenRecording: params.has('permissions'), accessibility: params.has('permissions'), checkedAt: '' },
  devices: [], devicesReadable: 'yes', displays: [], sideBySide: false,
  link: { attached: false, samples: 0, rttHistory: [] }, encoder: { capturing: false, rateHistory: [] },
  transport: {}, addresses: { origin: 'http://127.0.0.1:8787', lanAddresses: ['192.168.1.2'], firewall: { blocksIncoming: false }, publishedSite: 'https://example.com/a-long-published-site-path-for-layout-testing' },
  pairing: { active: false }, log: { entries: [], dropped: 0, areas: [] },
  settings: { port: 8787, quality: 'auto', sensitivity: 4, accountsAvailable: true, requireAccount: true, accountOwnerEmail: 'a-long-account-address-for-layout-testing@example.com', targetFps: 60, cellularCeilingMbps: 3 },
  update: { available: true, current: '0.16.0', latest: '0.17.0', canInstall: true, installable: true },
} as Facts
reachability.value = 'live'
if (complete) pane.value = 'settings'
render(<App />, document.getElementById('root')!)
