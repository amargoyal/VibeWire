import { Caps, Card, Display, FilledAction, Group, OutlinedAction } from '../../../src/design/components'
import { Kv, PaneHeading, RuledLabel } from '../parts'
import { ago, duration, measured } from '../format'
import { send, type Facts } from '../store'

/**
 * 04 · TRANSPORT.
 *
 * Four rows, each with its own verdict, because "offline" is four different
 * conditions with four different answers. Loopback is listed as the absence of
 * an address rather than as a fourth one: it is what this Mac calls itself and
 * no phone can act on it.
 */
export function Transport({ state }: { state: Facts }) {
  const transport = state.transport
  const relayOn = state.settings?.relayOverInternet ?? false

  const rows: {
    label: string
    value: string | null
    verdict: string
    tint: string
    note: string
  }[] = [
    {
      label: 'TAILSCALE',
      value: transport.tailscaleRunning
        ? [transport.tailscaleAddress, transport.tailscaleDNSName].filter(Boolean).join(' · ')
        : null,
      verdict: transport.tailscaleRunning ? 'UP' : 'DOWN',
      tint: transport.tailscaleRunning ? 'var(--ns-green)' : 'var(--ns-text-tertiary)',
      note: 'The fast path. Direct, no relay in the middle, and it keeps working when the phone leaves the house.',
    },
    {
      label: 'CLOUDFLARE TUNNEL',
      value: transport.cloudflareRunning
        ? (transport.cloudflareHostname ?? 'STARTING')
        : relayOn
          ? 'ENABLED BUT NOT RUNNING'
          : null,
      verdict: transport.cloudflareRunning ? 'UP' : relayOn ? 'WAIT' : 'OFF',
      tint: transport.cloudflareRunning
        ? 'var(--ns-green)'
        : relayOn
          ? 'var(--ns-amber)'
          : 'var(--ns-text-tertiary)',
      note: 'The fallback, and the only path a page on https:// can take. Also the only one that works from cellular.',
    },
    {
      label: 'LOCAL NETWORK',
      value: transport.lanAddress ?? null,
      verdict: transport.lanAddress ? 'UP' : 'DOWN',
      tint: transport.lanAddress ? 'var(--ns-green)' : 'var(--ns-text-tertiary)',
      note: 'Same Wi-Fi only. Pairs a phone to one network, which is why the QR prefers a tailnet address.',
    },
    {
      label: 'LOOPBACK',
      value: '127.0.0.1',
      verdict: 'N/A',
      tint: 'var(--ns-text-disabled)',
      note: 'What this Mac calls itself. This window uses it; no phone can act on it.',
    },
  ]

  return (
    <div class="pane pane--split" data-screen-label="Transport">
      <div class="pane__col pane__col--main">
        <PaneHeading
          title="Transport"
          caption="A POSIX DUAL-STACK SOCKET OWNS :8787 · NWLISTENER DOES NOT ACCEPT ON UTUN"
        />

        <Group>
          {rows.map((row) => (
            <div
              key={row.label}
              class="group-row"
              style={{ gap: 16, minHeight: 76, alignItems: 'center' }}
            >
              <span class="stack" style={{ gap: 5, width: 260, flex: '0 0 auto', minWidth: 0 }}>
                <Caps size="var(--fs-10)" color="var(--ns-text)">
                  {row.label}
                </Caps>
                <Caps size="var(--fs-9)" class="ellipsis">
                  {row.value ?? '—'}
                </Caps>
              </span>
              <span
                style={{
                  fontSize: 'var(--fs-13)',
                  lineHeight: 1.45,
                  color: 'var(--ns-text-secondary)',
                  flex: '1 1 auto',
                  minWidth: 0,
                  textWrap: 'pretty',
                }}
              >
                {row.note}
              </span>
              <Caps
                size="var(--fs-9)"
                color={row.tint}
                style={{ flex: '0 0 auto', width: 48, textAlign: 'right' }}
              >
                {row.verdict}
              </Caps>
            </div>
          ))}
        </Group>

        <RuledLabel>THE ADDRESS A BROWSER GETS</RuledLabel>

        <Card style={{ padding: 18 }}>
          <div class="stack" style={{ gap: 13 }}>
            <pre class="code" style={{ wordBreak: 'break-all' }}>
              {state.pairing.code
                ? `${state.addresses.origin}/?code=${state.pairing.code}`
                : `${state.addresses.origin}/`}
            </pre>
            <span style={{ fontSize: 'var(--fs-13)', lineHeight: 1.5, color: 'var(--ns-text-secondary)', textWrap: 'pretty' }}>
              A page served over <span class="mono">https://</span> may not open{' '}
              <span class="mono">ws://</span>. The published copy on GitHub Pages therefore reaches
              this Mac only through the tunnel; the copy this host serves reaches it over the
              tailnet. Storage is per-origin, so each address pairs once and appears as its own
              device.
            </span>
            {!state.addresses.webBundlePresent && (
              <Caps size="var(--fs-9)" color="var(--ns-amber)">
                NO WEB BUILD ON THIS HOST · THAT ADDRESS WOULD 404 · SEE web/README.md
              </Caps>
            )}
          </div>
        </Card>
      </div>

      <div class="pane__col pane__col--rail-narrow">
        <Card style={{ padding: 16 }}>
          <div class="stack" style={{ gap: 12 }}>
            <Caps size="var(--fs-9)" tracking="var(--caps-tracking-wide)" color="var(--ns-text-faint)">
              RIGHT NOW
            </Caps>
            <div class="stack" style={{ gap: 6 }}>
              <Caps size="var(--fs-9)">PATH</Caps>
              <Display
                level={26}
                color={
                  state.host.pathWord === 'NONE'
                    ? 'var(--ns-red)'
                    : state.host.pathWord === 'TUNNEL'
                      ? 'var(--ns-amber)'
                      : 'var(--ns-green)'
                }
              >
                {state.host.pathWord}
              </Display>
            </div>
            <span class="dashed-rule" />
            <div class="stack" style={{ gap: 4 }}>
              <Kv label="PEER LATENCY" value={measured(transport.peerLatencyMillis, (value) => `${value} MS`)} />
              <Kv label="RELAY" value={transport.relayName ?? null} />
              <Kv label="LAST CONTACT" value={transport.lastContact ? ago(transport.lastContact) : null} />
              <Kv label="UPTIME" value={duration(state.host.uptimeSeconds)} />
              <Kv label="LISTENING" value={`:${state.host.port}`} />
            </div>
          </div>
        </Card>

        {relayOn ? (
          <OutlinedAction
            title="Stop the tunnel"
            height={56}
            onClick={() => void send({ do: 'transport.tunnel', on: false })}
          />
        ) : (
          <FilledAction
            title="Start the tunnel"
            tint="var(--ns-raised-2)"
            ink="var(--ns-text)"
            height={56}
            onClick={() => void send({ do: 'transport.tunnel', on: true })}
          />
        )}
        <Caps size="var(--fs-9)" style={{ lineHeight: 1.6 }}>
          OFF BY DEFAULT · SENDS THIS MAC&apos;S PICTURE THROUGH CLOUDFLARE · THE ONLY PATH THAT
          WORKS ON CELLULAR
        </Caps>

        <OutlinedAction
          title="RE-PROBE NOW"
          onClick={() => void send({ do: 'transport.refresh' })}
        />
        <Caps size="var(--fs-9)" style={{ lineHeight: 1.6 }}>
          {state.addresses.listening}
        </Caps>
      </div>
    </div>
  )
}
