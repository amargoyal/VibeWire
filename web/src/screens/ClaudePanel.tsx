/**
 * 09 · CLAUDE — RUNNING, 10 · ASKING PERMISSION, 11 · RESUME A SESSION.
 * Mirrored by ios/VibeWire/Screens/ClaudePanelView.swift.
 *
 * A sheet over the picture, because it acts on the Mac being looked at. No
 * bubbles: prose is prose, machine output is monospace, and everything the agent
 * touched is a row that can be opened.
 *
 * Nightshift changed two things here, and both are about not hiding the thing
 * being explained.
 *
 *  - **Tool calls are a timeline.** They used to be a boxed list of equal rows,
 *    which said nothing about order and made twenty calls look like a table. A
 *    rail down the left says these happened in sequence, and lets the running one
 *    be a different shape — a card with its output in it — without breaking the
 *    run.
 *  - **The permission prompt is inline.** It used to be a sheet pinned to the
 *    bottom of the screen, which covered the last thing Claude said — usually the
 *    sentence explaining why it wants to run the command being approved. It is now
 *    a card at the end of the transcript, in sequence, where the reasoning above it
 *    stays readable. The composer dims and says why, and the transcript above dims
 *    with it, so there is exactly one thing to answer.
 */

import { useEffect, useRef, useState } from 'preact/hooks'

import {
  store,
  type ChangedFile,
  type ClaudeMode,
  type ClaudeTurn,
  type ToolCall,
} from '../app/store'
import {
  Announce,
  Caps,
  Caret,
  ConditionDot,
  Display,
  FilledAction,
  Group,
  OutlinedAction,
  PrimaryAction,
  ScreenBody,
  Segmented,
  SheetDismiss,
  SectionLabel,
  tapVerb,
  TimelineMark,
  type TimelineState,
  useSheet,
} from '../design/components'
import { MarkdownText } from '../design/markdown'
import { DiffView } from './Diff'

export function ClaudePanel({ onClose, half }: { onClose: () => void; half: boolean }) {
  const [draft, setDraft] = useState('')
  const [filesExpanded, setFilesExpanded] = useState(false)
  const transcript = useRef<HTMLDivElement | null>(null)
  const composer = useRef<HTMLTextAreaElement | null>(null)

  const turns = store.claudeTurns.value
  const toolCalls = store.toolCalls.value
  const changedFiles = store.changedFiles.value
  const permission = store.permission.value
  const mode = store.claudeMode.value

  useEffect(() => {
    store.listClaudeSessions()
  }, [])

  useEffect(() => {
    const node = transcript.current
    if (node) node.scrollTop = node.scrollHeight
  }, [turns.length, toolCalls.length, permission?.id])

  // The composer gives way to the question. With the keyboard up, a prompt at the
  // end of the transcript would arrive underneath it: a tool waiting on an answer
  // the user cannot see or reach.
  useEffect(() => {
    if (permission) composer.current?.blur()
  }, [permission?.id])

  // Escape goes to whichever sheet is on top: the diff and the session picker open
  // over this one and answer for themselves.
  const sheet = useSheet<HTMLDivElement>(onClose)

  // A brand new session counts as ready even though it has no id yet: the CLI stays
  // silent until the first prompt, so the header asks for one, and gating on the id
  // alone would block the very thing it asks for.
  const hasSomewhereToSend = store.claudeSessionId.value != null || store.claudeOpening.value
  const canSend = hasSomewhereToSend && draft.trim().length > 0 && !permission
  const composerPrompt = permission
    ? 'Answer the question first…'
    : !hasSomewhereToSend
      ? 'Pick a session first…'
      : mode === 'chat'
        ? 'Ask about this Mac…'
        : 'Steer the session…'

  const emptyTranscript = !turns.length && !toolCalls.length && !store.claudeStreaming.value

  const suggestions =
    mode === 'chat' &&
    !store.claudeStreaming.value &&
    !permission &&
    turns[turns.length - 1]?.role === 'assistant'
      ? ['What’s eating my battery', 'Show me the top processes']
      : []

  return (
    <div
      ref={sheet}
      class={half ? 'sheet sheet--half' : 'sheet'}
      role="dialog"
      aria-modal="true"
      aria-label="Claude"
    >
      <div class="wide-shell">
        <div class="column wide-column claude" style={{ paddingBottom: 0 }}>
          <div class="claude__head">
        {/* The one thing the system does not know: which Mac this is talking to,
            and how far away it is. */}
        <div class="row" style={{ minHeight: '40px', paddingTop: '6px', flex: '0 0 auto' }}>
          {/* Green whatever the link was doing, which made this the one caption in
              the app that could report a healthy Mac while the socket was gone.
              The reading beside it — the round trip — was already honest. */}
          <ConditionDot condition={store.condition.value} size={6} />
          <Caps class="ellipsis" size="var(--fs-9)" tracking="0.14em">
            {`${store.selectedDisplay.value?.name.toUpperCase() ?? 'MAC'} · ${
              store.link.value.rttMillis == null
                ? '—'
                : `${Math.round(store.link.value.rttMillis)}MS`
            }`}
          </Caps>
          <span class="spacer" style={{ minWidth: '8px' }} />
          <SheetDismiss onClick={onClose} id="closePanel" />
        </div>

        <div class="row" style={{ gap: '12px', paddingTop: '6px', flex: '0 0 auto' }}>
          <Display level={26} rank={2}>Claude</Display>
          <span class="spacer" />
          {permission ? (
            // While something is waiting, the header states that instead of
            // offering a mode switch nobody should be making mid-question.
            <span
              class="pill"
              style={{
                minHeight: '32px',
                background: 'color-mix(in srgb, var(--ns-amber) 14%, transparent)',
                flex: '0 0 auto',
              }}
            >
              <span
                class="dot dot--square"
                aria-hidden="true"
                style={{ width: '6px', height: '6px', background: 'var(--ns-amber)' }}
              />
              <Caps size="var(--fs-9)" tracking="0.12em" color="var(--ns-amber)">
                1 WAITING
              </Caps>
            </span>
          ) : (
            <span style={{ flex: '0 0 auto' }}>
              <Segmented<ClaudeMode>
                label="Claude mode"
                options={[
                  { value: 'chat', label: 'CHAT', badge: null },
                  {
                    value: 'code',
                    label: 'CODE',
                    badge: store.claudeSessionId.value ? 'var(--ns-green)' : null,
                  },
                ]}
                selection={mode}
                onSelect={(next) => {
                  // Re-opening tears down the running CLI and starts another, which
                  // is what put two `claude` processes 400ms apart in the host log
                  // and left the session unusable.
                  if (next === mode) return
                  // The terminal owns the mode of a live session, and re-opening
                  // here would quietly detach from it and start a private
                  // conversation instead — messages would stop reaching the terminal
                  // with nothing to say they had.
                  if (store.claudeIsLive.value) return
                  store.openClaude(next)
                }}
              />
            </span>
          )}
        </div>

        {mode === 'code' ? (
          <div style={{ marginTop: '14px', flex: '0 0 auto' }}>
            <SessionHeader onPick={() => (store.showSessionPicker.value = true)} />
          </div>
        ) : null}
          </div>

          {/* What the session is doing, as opposed to what was said. On a laptop it
              moves to a rail of its own; on a phone it stays where it was, under the
              conversation, because there is only one column to put it in. */}
          <div class="claude__rail wide-only">
            <SessionWork
              toolCalls={toolCalls}
              changedFiles={changedFiles}
              expanded={filesExpanded}
              onToggleFiles={() => setFilesExpanded((current) => !current)}
              dimmed={permission != null}
            />
          </div>

        <div ref={transcript} class="claude__talk">
          <div class="stack" style={{ gap: '20px' }}>
            {/* Everything that is not the question dims while one is pending. */}
            <div
              class="stack"
              style={{
                gap: '20px',
                opacity: permission ? 0.5 : 1,
                transition: 'opacity var(--state-change) ease-out',
              }}
              // Deliberately not aria-hidden. The dim says "answer the question
              // first"; removing the transcript from the accessibility tree says
              // "you may not read it", which is further than the visual design
              // goes — half-opacity text is still text, and the sentence
              // explaining why Claude wants to run this command is usually the
              // one directly above the card asking.
            >
              {emptyTranscript && !hasSomewhereToSend ? <EmptyState mode={mode} /> : null}

              {turns.map((turn) => (
                <TurnView key={turn.id} turn={turn} />
              ))}

              <div class="narrow-only stack" style={{ gap: '20px' }}>
                <SessionWork
                  toolCalls={toolCalls}
                  changedFiles={changedFiles}
                  expanded={filesExpanded}
                  onToggleFiles={() => setFilesExpanded((current) => !current)}
                />
              </div>

              {store.claudeStreaming.value ? (
                <div class="row" style={{ gap: '9px' }}>
                  <Caret height={14} />
                  <Caps size="var(--fs-9)" tracking="0.16em">
                    {store.claudeTokensPerSecond.value > 0
                      ? `STREAMING · ${store.claudeTokensPerSecond.value} TOK/S`
                      : 'WORKING'}
                  </Caps>
                </div>
              ) : null}

              {store.claudeRateLimitNote.value ? (
                <Caps size="var(--fs-9)" tracking="0.16em" color="var(--ns-amber)">
                  {store.claudeRateLimitNote.value}
                </Caps>
              ) : null}
            </div>

            {permission ? <PermissionCard /> : null}
          </div>
        </div>

        {/* A tool has stopped and is waiting to be answered. Everything on screen
            dims to say so, which says nothing at all to a reader who is not
            looking at it.

            Held open with an empty string rather than mounted with the sentence
            already inside it: a live region that arrives carrying its own text is
            not reliably spoken, because there was no change for the reader to be
            told about — the element simply appeared. */}
        <Announce>
          {permission ? `${permission.toolName} is waiting for permission to run.` : ''}
        </Announce>

        <div class="claude__ask">
        {/* Follow-ups as two thumb chips rather than another typing session. */}
        {suggestions.length ? (
          <div class="row" style={{ gap: '8px', marginTop: '12px', flex: '0 0 auto' }}>
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                class="pill"
                onClick={() => store.sendToClaude(suggestion)}
                style={{ minHeight: 'var(--target)' }}
              >
                <Caps size="var(--fs-9)" tracking="0.1em" color="var(--ns-text-secondary)">
                  {suggestion}
                </Caps>
              </button>
            ))}
          </div>
        ) : null}

        <div
          class="row"
          style={{
            gap: '10px',
            marginTop: '12px',
            alignItems: 'flex-end',
            flex: '0 0 auto',
            paddingBottom: 'calc(10px + var(--safe-bottom))',
            opacity: permission ? 0.4 : 1,
            transition: 'opacity var(--state-change) ease-out',
          }}
        >
          <textarea
            ref={composer}
            value={draft}
            placeholder={composerPrompt}
            aria-label={composerPrompt}
            disabled={permission != null}
            rows={1}
            onInput={(event) => {
              setDraft(event.currentTarget.value)
              // Grows to four lines and then scrolls, the way the phone's composer
              // does. Measured rather than guessed, so a pasted paragraph does not
              // hide its own first line.
              const node = event.currentTarget
              node.style.height = 'auto'
              node.style.height = `${Math.min(node.scrollHeight, 132)}px`
            }}
            onKeyDown={(event) => {
              // Enter sends, Shift+Enter is a newline. On a machine with a real
              // keyboard that is the whole composer.
              if (event.key !== 'Enter' || event.shiftKey) return
              event.preventDefault()
              if (!canSend) return
              store.sendToClaude(draft)
              setDraft('')
              if (composer.current) composer.current.style.height = 'auto'
            }}
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              minHeight: '52px',
              resize: 'none',
              fontSize: 'var(--fs-15)',
              lineHeight: 1.4,
              padding: '16px 18px',
              borderRadius: 'var(--radius-card)',
              background: 'var(--ns-raised)',
              fontFamily: 'var(--ns-sans)',
            }}
          />

          {/* Stop is a permanent red target while running: runaway agents are the
              reason the phone came out. */}
          {store.claudeStreaming.value ? (
            <button
              onClick={() => store.interruptClaude()}
              aria-label="Stop Claude"
              title="Interrupts the run in progress."
              class="stack"
              style={{
                width: '52px',
                height: '52px',
                flex: '0 0 auto',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '3px',
                borderRadius: 'var(--radius-control)',
                background: 'var(--ns-red)',
              }}
            >
              <span
                aria-hidden="true"
                style={{ width: '11px', height: '11px', background: 'var(--ns-on-red)' }}
              />
              <Caps size="var(--fs-8)" tracking="0.08em" color="var(--ns-on-red)">
                STOP
              </Caps>
            </button>
          ) : (
            <button
              onClick={() => {
                store.sendToClaude(draft)
                setDraft('')
                if (composer.current) composer.current.style.height = 'auto'
              }}
              disabled={!canSend}
              aria-label="Send"
              style={{
                width: '52px',
                height: '52px',
                flex: '0 0 auto',
                borderRadius: 'var(--radius-control)',
                background: 'var(--ns-accent)',
                color: 'var(--ns-on-accent)',
                opacity: canSend ? 1 : 0.4,
              }}
            >
              <span class="mono" style={{ fontSize: 'var(--fs-19)' }}>
                ↑
              </span>
            </button>
          )}
        </div>
        </div>
        </div>
      </div>

      {store.showSessionPicker.value ? (
        <SessionPicker onClose={() => (store.showSessionPicker.value = false)} />
      ) : null}
      {store.diffPath.value != null ? <DiffView /> : null}
    </div>
  )
}

/**
 * `claude-opus-4-20250514` in a 9 pt caps line is a serial number. The family and
 * its version answer "what is on the other end of this"; the date stamp is not
 * something anyone reads from a phone.
 *
 * The id spells a minor version with a dash — `claude-sonnet-4-5-20250929` is
 * 4.5, not 4 — so the two numbers are joined rather than the second dropped, or
 * this names a model that does not exist. The date stamp is a dashed run of
 * digits too, which is why the minor is bounded at two and refuses to be followed
 * by a third.
 */
function shortModel(model: string): string {
  const found = /(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(model)
  if (!found) return model.toUpperCase()
  const version = found[3] ? `${found[2]}.${found[3]}` : found[2]
  return `${found[1].toUpperCase()} ${version}`
}

/** The session's real working directory and branch, straight from the CLI. */
function SessionHeader({ onPick }: { onPick: () => void }) {
  const left = (() => {
    // Which conversation this is, is the one thing worth stating plainly: a private
    // session and the terminal's session look identical here otherwise, and only one
    // of them shows up on the Mac.
    if (store.claudeIsLive.value) return 'LIVE · SHARED WITH YOUR TERMINAL'
    if (store.claudeOpening.value) return 'STARTING · SEND A MESSAGE TO BEGIN'
    if (store.claudeSessionId.value == null) return `NO SESSION · ${tapVerb()} TO PICK`
    // The subscription flag is the load-bearing fact: it is what proves this is not
    // quietly billing per token.
    // The model, where the host named one. Two facts about a session that are
    // worth stating and cannot be inferred from anything else on screen: what is
    // answering, and that it is not billing per token.
    // NO API KEY is what SUBSCRIPTION already means, and the two together plus a
    // model name wrap this row onto a second line on a phone. Where the model is
    // known it takes that space, because it is the fact the reader does not have.
    const model = store.claudeModel.value ? shortModel(store.claudeModel.value) : ''
    if (store.claudeUsingSubscription.value !== true) {
      return model ? `${model} · SESSION OPEN` : 'SESSION OPEN'
    }
    return model ? `${model} · SUBSCRIPTION` : 'SUBSCRIPTION · NO API KEY'
  })()

  const right = (() => {
    const running = store.toolCalls.value.filter((call) => call.state === 'running').length
    if (running > 0) return `${store.changedFiles.value.length} FILES · ${running} RUNNING`
    if (store.changedFiles.value.length > 0) {
      return `${store.changedFiles.value.length} FILE${
        store.changedFiles.value.length === 1 ? '' : 'S'
      }`
    }
    const opened = store.claudeOpenedAt.value
    if (opened == null) return ''
    // Follows the store's one-second tick rather than a timer of its own.
    void store.tick.value
    const elapsed = Math.floor((Date.now() - opened) / 1000)
    return `${Math.floor(elapsed / 60)}M ${elapsed % 60}S`
  })()

  return (
    <button
      onClick={onPick}
      style={{
        width: '100%',
        display: 'block',
        textAlign: 'left',
        padding: '12px 14px',
        borderRadius: 'var(--radius-control)',
        background: 'var(--ns-raised)',
      }}
    >
      <span class="row" style={{ gap: '10px' }}>
        <span class="mono ellipsis ellipsis--head" style={{ fontSize: 'var(--fs-11)' }}>
          <span>{shortPath(store.claudeCwd.value)}</span>
        </span>
        <span class="spacer" style={{ minWidth: '8px' }} />
        {store.claudeBranch.value ? (
          <Caps size="var(--fs-10)" tracking="0.08em" color="var(--ns-green)">
            {store.claudeBranch.value}
          </Caps>
        ) : null}
      </span>
      <span class="row" style={{ gap: '10px', marginTop: '8px' }}>
        <Caps
          size="var(--fs-9)"
          tracking="0.12em"
          color={store.claudeIsLive.value ? 'var(--ns-accent)' : 'var(--ns-text-tertiary)'}
        >
          {left}
        </Caps>
        <span class="spacer" style={{ minWidth: '8px' }} />
        <Caps size="var(--fs-9)" tracking="0.1em">
          {right}
        </Caps>
      </span>
    </button>
  )
}

/**
 * A browser has no `NSHomeDirectory` to compare against, so the tilde is recovered
 * from the shape of the path the Mac reported: `/Users/<name>/…`. Anything else is
 * shown in full rather than half-abbreviated into something that looks wrong.
 */
function shortPath(path: string): string {
  return path.replace(/^\/Users\/[^/]+/, '~')
}

/**
 * The panel opened to a full screen of nothing, with the only explanation a
 * nine-point caption at the very top. This says what the two modes are for and
 * gives the one tap that starts either.
 */
function EmptyState({ mode }: { mode: ClaudeMode }) {
  return (
    <div
      class="stack"
      style={{ gap: '16px', alignItems: 'center', padding: '48px 24px 0', textAlign: 'center' }}
    >
      <Caps size="var(--fs-9)" tracking="0.18em" color="var(--ns-accent)">
        {mode === 'chat' ? 'CHAT' : 'CODE'}
      </Caps>
      <p
        class="wrap"
        style={{
          margin: 0,
          fontSize: 'var(--fs-19)',
          fontWeight: 500,
          letterSpacing: '-0.02em',
          color: 'var(--ns-text-secondary)',
          lineHeight: 1.4,
        }}
      >
        {mode === 'chat'
          ? 'Ask about this Mac. Nothing is edited.'
          : 'Run Claude Code in a folder on the Mac.'}
      </p>
      {store.claudeSessionId.value == null ? (
        <button
          class="outlined"
          onClick={() => (store.showSessionPicker.value = true)}
          style={
            {
              width: 'auto',
              minHeight: '46px',
              paddingInline: '20px',
              '--edge': 'color-mix(in srgb, var(--ns-accent) 45%, transparent)',
            } as Record<string, string>
          }
        >
          <Caps size="var(--fs-10)" color="var(--ns-accent)">
            PICK A SESSION
          </Caps>
        </button>
      ) : null}
    </div>
  )
}

const CLOCK = new Intl.DateTimeFormat(undefined, {
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
})

function TurnView({ turn }: { turn: ClaudeTurn }) {
  if (turn.role === 'user') {
    return (
      <div class="stack" style={{ gap: '7px' }}>
        <Caps size="var(--fs-9)" tracking="0.2em">
          {`YOU · ${CLOCK.format(new Date(turn.at))}`}
        </Caps>
        <MarkdownText text={turn.text} color="var(--ns-you)" />
      </div>
    )
  }
  return (
    <div class="stack" style={{ gap: '9px' }}>
      <div class="row" style={{ gap: '9px' }}>
        <Caps size="var(--fs-9)" tracking="0.2em" color="var(--ns-accent)">
          CLAUDE
        </Caps>
        <span
          class="spacer"
          aria-hidden="true"
          style={{
            height: '1px',
            background: 'color-mix(in srgb, var(--ns-accent) 22%, transparent)',
          }}
        />
      </div>
      {/* Full measure width — no bubble tax. */}
      <MarkdownText text={turn.text} />
    </div>
  )
}

function toolState(call: ToolCall): TimelineState {
  if (call.state === 'ok') return 'done'
  if (call.state === 'error') return 'failed'
  return 'running'
}

/**
 * One tool call on the timeline: verb, target, how long it took.
 *
 * A finished call is one 40px line, so twenty stay skimmable at arm's length. The
 * running one becomes a card and shows its output, because that is the only one
 * whose output is still news.
 */
function ToolRow({ call }: { call: ToolCall }) {
  const state = toolState(call)
  const running = state === 'running'

  const duration =
    call.milliseconds == null
      ? ''
      : call.milliseconds < 1000
        ? `${call.milliseconds}MS`
        : `${(call.milliseconds / 1000).toFixed(1)}S`

  return (
    <div class={running ? 'timeline__row timeline__row--running' : 'timeline__row'}>
      <TimelineMark state={state} />
      <div class="timeline__body">
        <div class="row" style={{ gap: '10px', minHeight: running ? '22px' : undefined }}>
          <span class="mono" style={{ fontSize: 'var(--fs-11)', flex: '0 0 auto' }}>
            {call.name}
          </span>
          <span
            class="mono ellipsis"
            style={{
              fontSize: 'var(--fs-11)',
              color: running ? 'var(--ns-text-secondary)' : 'var(--ns-text-secondary)',
            }}
          >
            {call.target}
          </span>
          <span class="spacer" style={{ minWidth: '8px' }} />
          <Caps
            size="var(--fs-9)"
            tracking="0"
            color={
              state === 'failed'
                ? 'var(--ns-red)'
                : running
                  ? 'var(--ns-accent)'
                  : 'var(--ns-text-tertiary)'
            }
          >
            {duration}
          </Caps>
        </div>
        {running && call.preview ? (
          <span
            class="mono ellipsis"
            style={{
              fontSize: 'var(--fs-10)',
              lineHeight: 1.6,
              color: 'var(--ns-text-tertiary)',
            }}
          >
            {call.preview}
          </span>
        ) : null}
      </div>
    </div>
  )
}

/**
 * Collapsed by default.
 *
 * This list lives inside the transcript, after the turns, and a branch with a dozen
 * changed files is taller than the panel. The transcript scrolls to its bottom on
 * every new turn, so the bottom was always this list — the conversation was pushed
 * out of sight and sending a message appeared to do nothing.
 */
/**
 * What the session is doing, as opposed to what it said: the tool timeline and the
 * files it has changed.
 *
 * On a phone this is one column, so it stays under the conversation where it has
 * always been. Past 900 px it moves to a rail beside it — the same move Home makes
 * with its readings — and the two stop competing for one strip of screen.
 */
function SessionWork({
  toolCalls,
  changedFiles,
  expanded,
  onToggleFiles,
  dimmed = false,
}: {
  toolCalls: ToolCall[]
  changedFiles: ChangedFile[]
  expanded: boolean
  onToggleFiles: () => void
  dimmed?: boolean
}) {
  if (!toolCalls.length && !changedFiles.length) return null
  return (
    <div
      class="stack"
      style={{
        gap: '20px',
        opacity: dimmed ? 0.5 : 1,
        transition: 'opacity var(--state-change) ease-out',
      }}
    >
      {toolCalls.length ? (
        <div class="timeline">
          {toolCalls.map((call) => (
            <ToolRow key={call.id} call={call} />
          ))}
        </div>
      ) : null}

      {changedFiles.length ? (
        <FileList files={changedFiles} expanded={expanded} onToggle={onToggleFiles} />
      ) : null}
    </div>
  )
}

function FileList({
  files,
  expanded,
  onToggle,
}: {
  files: ChangedFile[]
  expanded: boolean
  onToggle: () => void
}) {
  return (
    <div class="stack" style={{ gap: '8px' }}>
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${files.length} changed files`}
        style={{ display: 'flex', alignItems: 'center', gap: '8px', minHeight: 'var(--target)' }}
      >
        <Caps size="var(--fs-9)" tracking="0.16em">
          {`${files.length} CHANGED FILE${files.length === 1 ? '' : 'S'}`}
        </Caps>
        <Caps size="var(--fs-9)" tracking="0.16em" color="var(--ns-accent)">
          {expanded ? 'HIDE' : `SHOW · ${tapVerb()} FOR THE DIFF`}
        </Caps>
      </button>

      {expanded ? (
        <Group>
          {files.map((file) => (
            <button
              key={file.path}
              class="group-row"
              onClick={() => store.openDiff(file.path)}
              style={{ minHeight: '48px', gap: '10px', paddingInline: '12px' }}
            >
              <span
                class="mono"
                style={{
                  fontSize: 'var(--fs-10)',
                  flex: '0 0 auto',
                  color: file.status === 'A' ? 'var(--ns-green)' : 'var(--ns-amber)',
                }}
              >
                {file.status}
              </span>
              <span class="mono ellipsis ellipsis--head" style={{ fontSize: 'var(--fs-11)' }}>
                <span>{file.path}</span>
              </span>
              <span class="spacer" style={{ minWidth: '8px' }} />
              {file.added > 0 ? (
                <span
                  class="mono"
                  style={{ fontSize: 'var(--fs-10)', color: 'var(--ns-green)', flex: '0 0 auto' }}
                >
                  {`+${file.added}`}
                </span>
              ) : null}
              {file.removed > 0 ? (
                <span
                  class="mono"
                  style={{ fontSize: 'var(--fs-10)', color: 'var(--ns-red)', flex: '0 0 auto' }}
                >
                  {`−${file.removed}`}
                </span>
              ) : null}
              <RatioBars added={file.added} removed={file.removed} />
            </button>
          ))}
        </Group>
      ) : null}
    </div>
  )
}

/**
 * File changes get counts and a four-bar ratio.
 *
 * Nothing to divide is not a ratio. With no lines either way the maths gave zero
 * green bars of four, which draws a file with every line removed — a picture of a
 * deletion, for a file that has not been touched or has not been counted yet.
 * Four dormant bars say the same thing the em dash says elsewhere.
 */
export function RatioBars({ added, removed }: { added: number; removed: number }) {
  const counted = added + removed
  const green = counted === 0 ? 0 : Math.round((added / counted) * 4)
  return (
    <span class="row" style={{ gap: '2px', flex: '0 0 auto' }} aria-hidden="true">
      {[0, 1, 2, 3].map((index) => (
        <span
          key={index}
          style={{
            width: '3px',
            height: '12px',
            background:
              counted === 0
                ? 'var(--ns-text-disabled)'
                : index < green
                  ? 'var(--ns-green)'
                  : 'var(--ns-red)',
          }}
        />
      ))}
    </span>
  )
}

// MARK: - 10 · permission

/**
 * The one thing only the user can do.
 *
 * States the command verbatim, what it will destroy in plain units, and how long
 * it has been waiting. It sits at the end of the transcript rather than over it,
 * so the sentence in which Claude explained why it wants to run this is still on
 * screen while the question is being answered.
 */
function PermissionCard() {
  const request = store.permission.value
  if (!request) return null
  // Follows the store's tick. A permission request is the only thing that shows
  // this, and one is pending for a few seconds of a long session — the phone once
  // rebuilt the whole transcript every second for the entire time the panel was
  // open, to write the same number over itself.
  void store.tick.value
  const waited = Math.max(0, Math.floor((Date.now() - request.arrivedAt) / 1000))

  return (
    <div
      class="card card--tinted"
      role="dialog"
      aria-modal="true"
      aria-label={`Claude is asking to run ${request.command}`}
      style={
        {
          '--tint': 'var(--ns-amber)',
          borderRadius: 'var(--radius-card-large)',
          padding: '16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '13px',
        } as Record<string, string>
      }
    >
      <div class="row" style={{ gap: '9px' }}>
        <span
          class="dot dot--square"
          aria-hidden="true"
          style={{ width: '7px', height: '7px', background: 'var(--ns-amber)' }}
        />
        <Caps size="var(--fs-10)" tracking="0.16em" color="var(--ns-amber)" weight={500}>
          {`WANTS TO RUN · PAUSED ${waited}S`}
        </Caps>
      </div>

      <pre
        class="code"
        style={{ userSelect: 'text', maxHeight: '30dvh', overflowY: 'auto' }}
      >
        {request.command}
      </pre>

      {request.explanation ? (
        <p
          class="wrap"
          style={{
            margin: 0,
            fontSize: 'var(--fs-13)',
            lineHeight: 1.45,
            color: 'var(--ns-text-secondary)',
          }}
        >
          {request.explanation}
        </p>
      ) : null}

      <div class="stack" style={{ gap: '8px' }}>
        <FilledAction
          title="Allow once"
          hint="Runs this command once. You will be asked again next time."
          onClick={() => store.answerPermission(true, 'once')}
        />

        {/* Deny gets its own full-width row, and the standing grant is moved away
            from it. These two used to sit side by side, the same size, differing
            only in colour — so the tap that stops a tool was one thumb's width from
            the tap that permanently allows it, and only one of those can be taken
            back. */}
        <OutlinedAction
          title="DENY"
          tint="var(--ns-red)"
          edge="color-mix(in srgb, var(--ns-red) 50%, transparent)"
          height={48}
          onClick={() => store.answerPermission(false, 'once', 'Denied from the browser.')}
        />

        <button
          class="quiet"
          onClick={() => store.answerPermission(true, 'always')}
          // Visually demoted on purpose, and this is the one that cannot be taken
          // back — so the title has to carry what the size does not.
          aria-label="Always allow this here"
          title="Grants this command in this folder permanently. Cannot be undone from here."
          style={{ minHeight: '40px' }}
        >
          <Caps size="var(--fs-9)" tracking="0.12em">
            ALWAYS ALLOW THIS HERE
          </Caps>
        </button>
      </div>
    </div>
  )
}

// MARK: - 11 · session picker

/** Real sessions from ~/.claude/projects, resumable by id. */
function SessionPicker({ onClose }: { onClose: () => void }) {
  const sheet = useSheet<HTMLDivElement>(onClose)

  useEffect(() => {
    store.listClaudeSessions()
  }, [])

  const sessions = store.claudeSessions.value
  const current = store.claudeSessionId.value

  return (
    <div ref={sheet} class="sheet" role="dialog" aria-modal="true" aria-label="Resume a session">
      <ScreenBody>
        <div class="row" style={{ minHeight: '40px', marginTop: '16px', flex: '0 0 auto' }}>
          <SectionLabel>SESSIONS ON THE MAC</SectionLabel>
          <span class="spacer" />
          <SheetDismiss title="CLOSE" onClick={onClose} />
        </div>

        {/* The heading is a promise about what is below it, so it cannot be made
            where there is nothing to resume. */}
        <Display level={30} rank={2} style={{ marginTop: '14px', flex: '0 0 auto' }}>
          {sessions.length ? (
            <>
              Pick up where
              <br />
              you left off.
            </>
          ) : (
            <>
              Nothing to pick
              <br />
              up yet.
            </>
          )}
        </Display>

        <div
          style={{
            flex: '1 1 auto',
            minHeight: 0,
            overflowY: 'auto',
            marginTop: '22px',
          }}
        >
          {sessions.length === 0 ? (
            <Caps size="var(--fs-10)" tracking="0.12em">
              NO SESSIONS FOUND ON THE MAC
            </Caps>
          ) : (
            <div class="stack" style={{ gap: '8px' }}>
              {sessions.map((session) => {
                const selected = session.id === current
                return (
                  <button
                    key={session.id}
                    onClick={() => {
                      store.openClaude('code', session.id, session.cwd)
                      onClose()
                    }}
                    aria-current={selected ? 'true' : undefined}
                    style={{
                      display: 'block',
                      width: '100%',
                      textAlign: 'left',
                      padding: '15px 16px',
                      borderRadius: 'var(--radius-control)',
                      background: 'var(--ns-raised)',
                      boxShadow: selected
                        ? 'inset 0 0 0 1px color-mix(in srgb, var(--ns-accent) 35%, transparent)'
                        : undefined,
                    }}
                  >
                    <span
                      class="wrap"
                      style={{
                        display: 'block',
                        fontSize: 'var(--fs-14)',
                        lineHeight: 1.4,
                        // Two lines, then clipped: a summary is a label, not the
                        // conversation.
                        maxHeight: '2.8em',
                        overflow: 'hidden',
                      }}
                    >
                      {session.summary}
                    </span>
                    <span class="row" style={{ gap: '9px', marginTop: '9px' }}>
                      <Caps class="ellipsis ellipsis--head" size="var(--fs-9)" tracking="0.08em">
                        <span>{shortPath(session.cwd)}</span>
                      </Caps>
                      <span class="spacer" style={{ minWidth: '4px' }} />
                      {session.gitBranch ? (
                        <Caps size="var(--fs-9)" tracking="0.08em" color="var(--ns-green)">
                          {session.gitBranch}
                        </Caps>
                      ) : null}
                      <Caps size="var(--fs-9)" tracking="0.08em">
                        {`${session.messageCount} MSG`}
                      </Caps>
                    </span>
                  </button>
                )
              })}
            </div>
          )}
        </div>

        <div
          style={{ paddingBlock: '12px calc(24px + var(--safe-bottom))', flex: '0 0 auto' }}
        >
          {/* The picker could only resume, so a Mac with no sessions on it was a
              dead end: the empty state said so and offered nothing. The host already
              accepts an open without a session id. */}
          <PrimaryAction
            title="New session"
            detail={
              store.claudeCwd.value
                ? `STARTS IN ${shortPath(store.claudeCwd.value).toUpperCase()}`
                : // No folder has been named, by this client or by the Mac, so
                  // "the last project" would be describing one that may not exist.
                  'THE MAC PICKS THE FOLDER'
            }
            glyph="＋"
            tint="var(--ns-accent)"
            ink="var(--ns-on-accent)"
            onClick={() => {
              store.openClaude(store.claudeMode.value)
              onClose()
            }}
          />
        </div>
      </ScreenBody>
    </div>
  )
}
