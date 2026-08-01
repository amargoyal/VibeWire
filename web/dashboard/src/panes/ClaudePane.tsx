import { useState } from 'preact/hooks'
import {
  Caps,
  Card,
  FilledAction,
  Group,
  OutlinedAction,
  Spinner,
  TimelineMark,
} from '../../../src/design/components'
import { MarkdownText } from '../../../src/design/markdown'
import { Kv, RowButton, RuledLabel } from '../parts'
import { ago, DASH, duration } from '../format'
import { answerPermission, claude, clock, selectedSessionId, send, type Facts } from '../store'

/**
 * 07 · CLAUDE.
 *
 * The same session the phone sees, not a second one. The host runs one
 * `claude` process and fans its output to both surfaces, so opening a session
 * here opens it there too — which is the point: an agent run started at the desk
 * stays reachable from the phone, and one started from the phone can be answered
 * at the desk.
 *
 * The permission card is the reason this pane earns its place in a Mac window.
 * A tool call that stops to ask is the one moment the run is blocked on a human,
 * and the human is usually at this Mac.
 */
export function ClaudePane({ state }: { state: Facts }) {
  const view = claude.value
  const [draft, setDraft] = useState('')

  const waiting = view.permission
    ? Math.round(view.permission.waitingMs / 1000 + (Date.now() - view.permission.arrivedAt) / 1000)
    : 0
  // Depending on the clock signal is what makes the count above tick between
  // polls rather than jumping a second at a time.
  void clock.value

  async function submit() {
    const text = draft.trim()
    if (!text || !view.openSessionId) return
    setDraft('')
    await send({ do: 'claude', sub: 'send', text })
  }

  return (
    <div class="pane pane--split" data-screen-label="Claude">
      <div class="pane__col pane__col--rail-narrow">
        <div class="stack" style={{ gap: 6, flex: '0 0 auto' }}>
          <h2
            style={{
              margin: 0,
              fontSize: 'var(--fs-26)',
              fontWeight: 600,
              letterSpacing: 'var(--title-tracking)',
            }}
          >
            Claude Code
          </h2>
          <Caps size="var(--fs-9)">~/.CLAUDE/PROJECTS · SUBSCRIPTION CREDENTIALS · NO API KEY</Caps>
        </div>

        <Group>
          {view.sessions.map((session) => {
            const open = session.id === view.openSessionId
            return (
              <RowButton
                key={session.id}
                selected={open || session.id === selectedSessionId.value}
                onClick={() => {
                  selectedSessionId.value = session.id
                  void send({ do: 'claude', sub: 'open', sessionId: session.id, cwd: session.cwd })
                }}
                style={{ minHeight: 64, alignItems: 'flex-start', paddingBlock: 11 }}
              >
                <span class="stack" style={{ gap: 5, minWidth: 0, width: '100%' }}>
                  <span class="row" style={{ gap: 9, width: '100%' }}>
                    <span
                      class="dot"
                      style={{
                        width: 7,
                        height: 7,
                        background: open ? 'var(--ns-accent)' : 'var(--ns-text-tertiary)',
                      }}
                    />
                    <span class="ellipsis" style={{ fontSize: 'var(--fs-14)', fontWeight: 500 }}>
                      {session.summary || session.cwd || session.id}
                    </span>
                    <span class="spacer" />
                    <Caps
                      size="var(--fs-9)"
                      color={open ? 'var(--ns-accent)' : 'var(--ns-text-tertiary)'}
                    >
                      {open ? (view.pending ? 'OPENING' : 'OPEN') : ago(session.modifiedAt)}
                    </Caps>
                  </span>
                  <Caps size="var(--fs-9)" class="ellipsis" color="var(--ns-text-faint)">
                    {[session.cwd, session.gitBranch].filter(Boolean).join(' · ') || '—'}
                  </Caps>
                </span>
              </RowButton>
            )
          })}
          {view.sessions.length === 0 && (
            <div class="group-row">
              <Caps size="var(--fs-9)">NO SESSIONS ON DISK</Caps>
            </div>
          )}
        </Group>

        <OutlinedAction
          title="REFRESH THE LIST"
          onClick={() => void send({ do: 'claude', sub: 'listSessions' })}
        />

        <span class="spacer" />

        <Card style={{ padding: 16, flex: '0 0 auto' }}>
          <div class="stack" style={{ gap: 11 }}>
            <Caps size="var(--fs-9)" tracking="var(--caps-tracking-wide)" color="var(--ns-text-faint)">
              USAGE
            </Caps>
            <Kv
              label="TOKENS"
              value={
                view.usage
                  ? `${view.usage.inputTokens.toLocaleString()} IN · ${view.usage.outputTokens.toLocaleString()} OUT`
                  : null
              }
            />
            <Kv
              label="LAST TURN"
              value={view.usage ? duration(view.usage.durationMs / 1000) : null}
            />
            <Kv
              label="RATE LIMIT"
              value={
                view.rateLimit
                  ? `${view.rateLimit.status.toUpperCase()}${view.rateLimit.resetsAt ? ` · RESETS ${view.rateLimit.resetsAt}` : ''}`
                  : null
              }
              color="var(--ns-green)"
            />
            <Kv label="BILLING" value="SUBSCRIPTION · NO API KEY" color="var(--ns-text-secondary)" />
          </div>
        </Card>
      </div>

      <div class="pane__col pane__col--main">
        {!view.openSessionId ? (
          <Card style={{ padding: 18, maxWidth: 620 }}>
            <Caps size="var(--fs-9)">NOTHING OPEN</Caps>
            <p
              style={{
                margin: '10px 0 0',
                fontSize: 'var(--fs-13)',
                lineHeight: 1.45,
                color: 'var(--ns-text-secondary)',
                textWrap: 'pretty',
              }}
            >
              Pick a session on the left. It opens on this Mac and on the phone at the same time —
              the host runs one Claude process and both surfaces read it.
            </p>
          </Card>
        ) : (
          <>
            {view.error && (
              <Card tint="var(--ns-red)" style={{ padding: 16, maxWidth: 620 }}>
                <Caps size="var(--fs-9)" color="var(--ns-red)">
                  CLAUDE REPORTED AN ERROR
                </Caps>
                <p style={{ margin: '8px 0 0', fontSize: 'var(--fs-13)', color: 'var(--ns-text-secondary)' }}>
                  {view.error}
                </p>
              </Card>
            )}

            <div class="stack" style={{ gap: 16, maxWidth: 620 }}>
              {view.turns.slice(-6).map((turn, index) => (
                <div key={index} class="stack" style={{ gap: 9 }}>
                  <div class="row" style={{ gap: 10 }}>
                    <Caps
                      size="var(--fs-9)"
                      tracking="var(--caps-tracking-wide)"
                      color={turn.role === 'assistant' ? 'var(--ns-accent)' : 'var(--ns-text-tertiary)'}
                    >
                      {turn.role === 'assistant' ? 'CLAUDE' : 'YOU'}
                    </Caps>
                    <span class="hairline spacer" />
                  </div>
                  <MarkdownText text={turn.text} color={turn.role === 'assistant' ? 'var(--ns-text)' : 'var(--ns-you)'} />
                </div>
              ))}

              {view.streaming && (
                <div class="stack" style={{ gap: 9 }}>
                  <div class="row" style={{ gap: 10 }}>
                    <Caps size="var(--fs-9)" tracking="var(--caps-tracking-wide)" color="var(--ns-accent)">
                      CLAUDE
                    </Caps>
                    <span class="hairline spacer" />
                  </div>
                  <MarkdownText text={view.streaming} />
                </div>
              )}

              {view.pending && (
                <div class="row" style={{ gap: 10 }}>
                  <Spinner />
                  <Caps size="var(--fs-9)">WAITING FOR THE CLI TO ANSWER</Caps>
                </div>
              )}
            </div>

            {view.tools.length > 0 && (
              <div class="timeline" style={{ maxWidth: 620 }}>
                {view.tools.map((tool) => (
                  <div
                    key={tool.id}
                    class={`timeline__row${tool.state === 'running' ? ' timeline__row--running' : ''}`}
                  >
                    <TimelineMark
                      state={
                        tool.state === 'ok' ? 'done' : tool.state === 'error' ? 'failed' : 'running'
                      }
                    />
                    <span class="mono" style={{ fontSize: 'var(--fs-12)', flex: '0 0 auto' }}>
                      {tool.name}
                    </span>
                    <span
                      class="mono ellipsis"
                      style={{ fontSize: 'var(--fs-12)', color: 'var(--ns-text-secondary)' }}
                      title={tool.target}
                    >
                      {tool.target}
                    </span>
                    <span class="spacer" />
                    <Caps size="var(--fs-9)">
                      {tool.ms === undefined ? DASH : `${(tool.ms / 1000).toFixed(1)}S`}
                    </Caps>
                  </div>
                ))}
              </div>
            )}

            {view.files.length > 0 && (
              <>
                <RuledLabel>CHANGED FILES</RuledLabel>
                <Group style={{ maxWidth: 620 }}>
                  {view.files.map((file) => (
                    <div key={file.path} class="group-row" style={{ minHeight: 40 }}>
                      <Caps size="var(--fs-9)" color="var(--ns-accent)" style={{ width: 16 }}>
                        {file.status}
                      </Caps>
                      <span
                        class="mono ellipsis ellipsis--head"
                        style={{ fontSize: 'var(--fs-12)' }}
                      >
                        <span>{file.path}</span>
                      </span>
                      <span class="spacer" />
                      <Caps size="var(--fs-9)" color="var(--ns-green)">
                        {`+${file.added}`}
                      </Caps>
                      <Caps size="var(--fs-9)" color="var(--ns-red)">
                        {`−${file.removed}`}
                      </Caps>
                    </div>
                  ))}
                </Group>
              </>
            )}

            {view.permission && (
              <Card tint="var(--ns-amber)" style={{ padding: 18, maxWidth: 620 }}>
                <div class="stack" style={{ gap: 14 }}>
                  <div class="row" style={{ gap: 10 }}>
                    <span
                      class="dot dot--pulse-fast"
                      style={{ width: 7, height: 7, background: 'var(--ns-amber)' }}
                    />
                    <Caps size="var(--fs-9)" tracking="0.18em" color="var(--ns-amber)">
                      {`PERMISSION · WAITING ${waiting}S`}
                    </Caps>
                  </div>
                  <pre class="code">{view.permission.command || view.permission.toolName}</pre>
                  {view.permission.explanation && (
                    <p
                      style={{
                        margin: 0,
                        fontSize: 'var(--fs-13)',
                        lineHeight: 1.45,
                        color: 'var(--ns-on-amber-wash)',
                        textWrap: 'pretty',
                      }}
                    >
                      {view.permission.explanation}
                    </p>
                  )}
                  <FilledAction
                    title="Allow once"
                    tint="var(--ns-accent)"
                    ink="var(--ns-on-accent)"
                    height={56}
                    onClick={() =>
                      void answerPermission(view.permission!.requestId, 'allow', 'once')
                    }
                  />
                  <OutlinedAction
                    title={`ALWAYS ALLOW ${view.permission.toolName.toUpperCase()} HERE`}
                    onClick={() =>
                      void answerPermission(view.permission!.requestId, 'allow', 'always')
                    }
                  />
                  <OutlinedAction
                    title="DENY"
                    tint="var(--ns-red)"
                    edge="var(--ns-red)"
                    onClick={() => void answerPermission(view.permission!.requestId, 'deny', 'once')}
                  />
                </div>
              </Card>
            )}

            <div class="row" style={{ gap: 10, alignItems: 'flex-end', maxWidth: 620 }}>
              <textarea
                value={draft}
                rows={1}
                placeholder={view.permission ? 'Answer the question first…' : 'Say something…'}
                disabled={Boolean(view.permission)}
                onInput={(event) => setDraft((event.target as HTMLTextAreaElement).value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !event.shiftKey) {
                    event.preventDefault()
                    void submit()
                  }
                }}
                aria-label="Message Claude"
                style={{
                  flex: '1 1 auto',
                  minHeight: 56,
                  resize: 'vertical',
                  borderRadius: 'var(--radius-card)',
                  background: 'var(--ns-raised)',
                  padding: '17px 18px',
                  fontSize: 'var(--fs-15)',
                }}
              />
              <button
                type="button"
                disabled={!draft.trim() || Boolean(view.permission)}
                onClick={() => void submit()}
                aria-label="Send"
                style={{
                  width: 52,
                  height: 52,
                  flex: '0 0 auto',
                  borderRadius: 'var(--radius-control)',
                  background: 'var(--ns-accent)',
                  color: 'var(--ns-on-accent)',
                  opacity: !draft.trim() || view.permission ? 0.45 : 1,
                  display: 'grid',
                  placeItems: 'center',
                  fontFamily: 'var(--ns-mono)',
                  fontSize: 'var(--fs-17)',
                }}
              >
                ↑
              </button>
            </div>

            <div class="row" style={{ gap: 10, maxWidth: 620 }}>
              <OutlinedAction
                title="INTERRUPT"
                onClick={() => void send({ do: 'claude', sub: 'interrupt' })}
              />
              <OutlinedAction
                title="CLOSE THE SESSION"
                onClick={() => void send({ do: 'claude', sub: 'close' })}
              />
            </div>
            <Caps size="var(--fs-9)" style={{ lineHeight: 1.6, maxWidth: 620 }}>
              {`OPEN IN ${view.cwd || state.host.name} · THE PHONE IS LOOKING AT THIS SAME SESSION`}
            </Caps>
          </>
        )}
      </div>
    </div>
  )
}
