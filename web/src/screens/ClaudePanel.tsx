/**
 * 06A · CLAUDE · CHAT, 06B · CLAUDE CODE · RUNNING, 06C · DIFF + PERMISSION.
 * Ported from ios/VibeWire/Screens/ClaudePanelView.swift.
 *
 * A sheet over the picture, because it acts on the Mac being looked at. No bubbles:
 * prose is prose, machine output is monospace in a gutter, and everything the agent
 * touched is a row that can be opened.
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
  Caps,
  Caret,
  PrimaryAction,
  ScreenBody,
  SecondaryAction,
  Segmented,
  SheetDismiss,
  Spinner,
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
  }, [turns.length, toolCalls.length])

  // The sheet is a bottom overlay, so with the keyboard up it arrives underneath
  // it: a tool sits waiting on an answer the user cannot see or reach. Typing gives
  // way to the question.
  useEffect(() => {
    if (permission) composer.current?.blur()
  }, [permission?.id])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !store.diffPath.value && !store.showSessionPicker.value) {
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // A brand new session counts as ready even though it has no id yet: the CLI stays
  // silent until the first prompt, so the header asks for one, and gating on the id
  // alone would block the very thing it asks for.
  const hasSomewhereToSend = store.claudeSessionId.value != null || store.claudeOpening.value
  const canSend = hasSomewhereToSend && draft.trim().length > 0
  const composerPrompt = !hasSomewhereToSend
    ? 'Pick a session first…'
    : mode === 'chat'
      ? 'Ask about this Mac…'
      : 'Steer the session…'

  const emptyTranscript = !turns.length && !toolCalls.length && !store.claudeStreaming.value

  const suggestions =
    mode === 'chat' && !store.claudeStreaming.value && turns[turns.length - 1]?.role === 'assistant'
      ? ['What’s eating my battery', 'Show me the top processes']
      : []

  return (
    <div class={half ? 'sheet sheet--half' : 'sheet'} role="dialog" aria-label="Claude">
      <ScreenBody>
        {/* The one thing the system does not know: which Mac this is talking to, and
            how far away it is. */}
        <div class="row" style={{ paddingTop: '6px', flex: '0 0 auto' }}>
          <Caps class="ellipsis" size="var(--fs-9)" color="var(--lg-green)">
            {`● ${store.selectedDisplay.value?.name.toUpperCase() ?? 'MAC'} · ${
              store.link.value.rttMillis == null
                ? '—'
                : `${Math.round(store.link.value.rttMillis)}MS`
            }`}
          </Caps>
          <span class="spacer" style={{ minWidth: '8px' }} />
          <SheetDismiss onClick={onClose} id="closePanel" />
        </div>

        <div style={{ marginTop: '4px', flex: '0 0 auto' }}>
          <Segmented<ClaudeMode>
            label="Claude mode"
            options={[
              { value: 'chat', label: 'CHAT', badge: null },
              {
                value: 'code',
                label: 'CODE',
                badge: store.claudeSessionId.value ? 'var(--lg-green)' : null,
              },
            ]}
            selection={mode}
            onSelect={(next) => {
              // Re-opening tears down the running CLI and starts another, which is
              // what put two `claude` processes 400ms apart in the host log and left
              // the session unusable.
              if (next === mode) return
              // The terminal owns the mode of a live session, and re-opening here
              // would quietly detach from it and start a private conversation
              // instead — messages would stop reaching the terminal with nothing to
              // say they had.
              if (store.claudeIsLive.value) return
              store.openClaude(next)
            }}
          />
        </div>

        {mode === 'code' ? (
          <div style={{ marginTop: '12px', flex: '0 0 auto' }}>
            <SessionHeader onPick={() => (store.showSessionPicker.value = true)} />
          </div>
        ) : null}

        <div
          ref={transcript}
          style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', paddingTop: '22px' }}
        >
          <div class="stack" style={{ gap: '20px' }}>
            {emptyTranscript && !hasSomewhereToSend ? <EmptyState mode={mode} /> : null}

            {turns.map((turn) => (
              <TurnView key={turn.id} turn={turn} />
            ))}

            {/* Tool calls collapse to one 44px line each — verb, target, duration —
                so twenty stay skimmable at arm's length. */}
            {toolCalls.length ? (
              <div
                class="stack"
                style={{
                  gap: '1px',
                  background: 'var(--lg-chrome)',
                  border: '1px solid var(--lg-chrome)',
                  borderRadius: 'var(--radius-row)',
                  overflow: 'hidden',
                }}
              >
                {toolCalls.map((call) => (
                  <ToolRow key={call.id} call={call} />
                ))}
              </div>
            ) : null}

            {changedFiles.length ? (
              <FileList
                files={changedFiles}
                expanded={filesExpanded}
                onToggle={() => setFilesExpanded((current) => !current)}
              />
            ) : null}

            {store.claudeStreaming.value ? (
              <div class="row" style={{ gap: '8px' }}>
                <Caret height={16} />
                <Caps size="var(--fs-9)" tracking="0.16em">
                  {store.claudeTokensPerSecond.value > 0
                    ? `STREAMING · ${store.claudeTokensPerSecond.value} TOK/S`
                    : 'WORKING'}
                </Caps>
              </div>
            ) : null}

            {store.claudeRateLimitNote.value ? (
              <Caps size="var(--fs-9)" tracking="0.16em" color="var(--lg-amber)">
                {store.claudeRateLimitNote.value}
              </Caps>
            ) : null}
          </div>
        </div>

        {/* Follow-ups as two thumb chips rather than another typing session. */}
        {suggestions.length ? (
          <div class="row" style={{ gap: '8px', marginTop: '12px', flex: '0 0 auto' }}>
            {suggestions.map((suggestion) => (
              <button
                key={suggestion}
                onClick={() => store.sendToClaude(suggestion)}
                style={{
                  minHeight: 'var(--target)',
                  paddingInline: '14px',
                  borderRadius: 'var(--radius-pill)',
                  border: '1px solid var(--lg-hairline)',
                }}
              >
                <Caps size="var(--fs-10)" tracking="0.1em" color="var(--lg-text-secondary)">
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
            paddingBottom: 'calc(8px + var(--safe-bottom))',
          }}
        >
          <textarea
            ref={composer}
            value={draft}
            placeholder={composerPrompt}
            aria-label={composerPrompt}
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
              resize: 'none',
              fontSize: 'var(--fs-15)',
              lineHeight: 1.4,
              padding: '16px',
              borderRadius: 'var(--radius-large)',
              background: 'var(--lg-panel)',
              border: '1px solid var(--lg-hairline)',
              fontFamily: 'var(--lg-sans)',
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
                width: '56px',
                height: '56px',
                flex: '0 0 auto',
                alignItems: 'center',
                justifyContent: 'center',
                gap: '2px',
              }}
            >
              <span
                aria-hidden="true"
                style={{ width: '12px', height: '12px', background: 'var(--lg-red)' }}
              />
              <Caps size="var(--fs-9)" tracking="0.1em" color="var(--lg-red)">
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
                width: '56px',
                height: '56px',
                flex: '0 0 auto',
                borderRadius: 'var(--radius-large)',
                background: 'var(--lg-cyan)',
                color: 'var(--lg-on-cyan)',
                opacity: canSend ? 1 : 0.4,
              }}
            >
              <span class="mono" style={{ fontSize: 'var(--fs-19)' }}>
                ↑
              </span>
            </button>
          )}
        </div>
      </ScreenBody>

      {permission ? <PermissionSheet /> : null}
      {store.showSessionPicker.value ? (
        <SessionPicker onClose={() => (store.showSessionPicker.value = false)} />
      ) : null}
      {store.diffPath.value != null ? <DiffView /> : null}
    </div>
  )
}

/** The session's real working directory and branch, straight from the CLI. */
function SessionHeader({ onPick }: { onPick: () => void }) {
  const left = (() => {
    // Which conversation this is, is the one thing worth stating plainly: a private
    // session and the terminal's session look identical here otherwise, and only one
    // of them shows up on the Mac.
    if (store.claudeIsLive.value) return 'LIVE · SHARED WITH YOUR TERMINAL'
    if (store.claudeOpening.value) return 'STARTING · SEND A MESSAGE TO BEGIN'
    if (store.claudeSessionId.value == null) return 'NO SESSION · TAP TO PICK'
    // The subscription flag is the load-bearing fact: it is what proves this is not
    // quietly billing per token.
    return store.claudeUsingSubscription.value === true
      ? 'SUBSCRIPTION · NO API KEY'
      : 'SESSION OPEN'
  })()

  const right = (() => {
    const running = store.toolCalls.value.filter((call) => call.state === 'running').length
    if (running > 0) return `${store.changedFiles.value.length} FILES · ${running} TOOLS RUNNING`
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
        padding: '11px 13px',
        borderRadius: 'var(--radius-row)',
        background: 'var(--lg-raised)',
        border: '1px solid var(--lg-hairline-dim)',
      }}
    >
      <span class="row" style={{ gap: '8px' }}>
        <span class="mono ellipsis ellipsis--head" style={{ fontSize: 'var(--fs-10)' }}>
          <span>{shortPath(store.claudeCwd.value)}</span>
        </span>
        <span class="spacer" style={{ minWidth: '8px' }} />
        {store.claudeBranch.value ? (
          <Caps size="var(--fs-10)" tracking="0.08em" color="var(--lg-green)">
            {store.claudeBranch.value}
          </Caps>
        ) : null}
      </span>
      <span class="row" style={{ gap: '8px', marginTop: '7px' }}>
        <Caps size="var(--fs-9)" tracking="0.12em">
          {left}
        </Caps>
        <span class="spacer" style={{ minWidth: '8px' }} />
        <Caps size="var(--fs-9)" tracking="0.12em">
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
      style={{ gap: '14px', alignItems: 'center', padding: '60px 32px 0', textAlign: 'center' }}
    >
      <Caps size="var(--fs-10)" tracking="0.18em" color="var(--lg-cyan)">
        {mode === 'chat' ? 'CHAT' : 'CODE'}
      </Caps>
      <p
        class="wrap"
        style={{
          margin: 0,
          fontSize: 'var(--fs-19)',
          color: 'var(--lg-text-secondary)',
          lineHeight: 1.4,
        }}
      >
        {mode === 'chat'
          ? 'Ask about this Mac. Nothing is edited.'
          : 'Run Claude Code in a folder on the Mac.'}
      </p>
      {store.claudeSessionId.value == null ? (
        <button
          onClick={() => (store.showSessionPicker.value = true)}
          style={{
            minHeight: '46px',
            paddingInline: '20px',
            borderRadius: '10px',
            border: '1px solid color-mix(in srgb, var(--lg-cyan) 45%, transparent)',
          }}
        >
          <Caps size="var(--fs-11)" color="var(--lg-cyan)">
            PICK A SESSION
          </Caps>
        </button>
      ) : null}
    </div>
  )
}

const CLOCK = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', hour12: false })

function TurnView({ turn }: { turn: ClaudeTurn }) {
  if (turn.role === 'user') {
    return (
      <div class="stack" style={{ gap: '7px' }}>
        <Caps size="var(--fs-9)" tracking="0.2em">
          {`YOU · ${CLOCK.format(new Date(turn.at))}`}
        </Caps>
        <MarkdownText text={turn.text} color="var(--lg-you)" />
      </div>
    )
  }
  return (
    <div class="stack" style={{ gap: '9px' }}>
      <div class="row" style={{ gap: '8px' }}>
        <Caps size="var(--fs-9)" tracking="0.2em" color="var(--lg-cyan)">
          CLAUDE
        </Caps>
        <span
          class="spacer"
          aria-hidden="true"
          style={{
            height: '1px',
            background: 'color-mix(in srgb, var(--lg-cyan) 20%, transparent)',
          }}
        />
      </div>
      {/* Full measure width — no bubble tax. */}
      <MarkdownText text={turn.text} />
    </div>
  )
}

function ToolRow({ call }: { call: ToolCall }) {
  const marker =
    call.state === 'ok' ? (
      <span class="mono" style={{ fontSize: 'var(--fs-11)', color: 'var(--lg-green)' }}>
        ✓
      </span>
    ) : call.state === 'error' ? (
      <span class="mono" style={{ fontSize: 'var(--fs-11)', color: 'var(--lg-red)' }}>
        ✕
      </span>
    ) : (
      <Spinner size={12} />
    )

  const duration =
    call.milliseconds == null
      ? ''
      : call.milliseconds < 1000
        ? `${call.milliseconds}MS`
        : `${(call.milliseconds / 1000).toFixed(1)}S`

  return (
    <div
      class="stack"
      style={{ background: call.state === 'running' ? 'var(--lg-screen)' : 'var(--lg-raised)' }}
    >
      <div class="row" style={{ gap: '10px', minHeight: 'var(--target)', paddingInline: '12px' }}>
        {marker}
        <span class="mono" style={{ fontSize: 'var(--fs-11)', flex: '0 0 auto' }}>
          {call.name}
        </span>
        <span
          class="mono ellipsis"
          style={{
            fontSize: 'var(--fs-11)',
            color: call.state === 'running' ? 'var(--lg-text-secondary)' : 'var(--lg-text)',
          }}
        >
          {call.target}
        </span>
        <span class="spacer" style={{ minWidth: '8px' }} />
        <Caps
          size="var(--fs-9)"
          tracking="0"
          color={call.state === 'running' ? 'var(--lg-cyan)' : 'var(--lg-text-tertiary)'}
        >
          {duration}
        </Caps>
      </div>
      {/* Only the running one shows output. */}
      {call.state === 'running' && call.preview ? (
        <pre
          class="mono wrap"
          style={{
            margin: 0,
            padding: '0 12px 11px',
            fontSize: 'var(--fs-10)',
            color: 'var(--lg-text-tertiary)',
            lineHeight: 1.6,
            whiteSpace: 'pre-wrap',
          }}
        >
          {call.preview}
        </pre>
      ) : null}
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
    <div class="stack" style={{ gap: '6px' }}>
      <button
        onClick={onToggle}
        aria-expanded={expanded}
        aria-label={`${files.length} changed files`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          minHeight: 'var(--target)',
        }}
      >
        <Caps size="var(--fs-9)" tracking="0.16em">
          {`${files.length} CHANGED FILE${files.length === 1 ? '' : 'S'}`}
        </Caps>
        <Caps size="var(--fs-9)" tracking="0.16em" color="var(--lg-cyan)">
          {expanded ? 'HIDE' : 'SHOW · TAP FOR THE DIFF'}
        </Caps>
      </button>

      {expanded ? (
        <div
          class="stack"
          style={{
            gap: '1px',
            background: 'var(--lg-chrome)',
            borderRadius: 'var(--radius-row)',
            overflow: 'hidden',
          }}
        >
          {files.map((file) => (
            <button
              key={file.path}
              onClick={() => store.openDiff(file.path)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '10px',
                padding: '12px',
                background: 'var(--lg-raised)',
                textAlign: 'left',
              }}
            >
              <span
                class="mono"
                style={{
                  fontSize: 'var(--fs-10)',
                  flex: '0 0 auto',
                  color: file.status === 'A' ? 'var(--lg-green)' : 'var(--lg-amber)',
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
                  style={{ fontSize: 'var(--fs-10)', color: 'var(--lg-green)', flex: '0 0 auto' }}
                >
                  {`+${file.added}`}
                </span>
              ) : null}
              {file.removed > 0 ? (
                <span
                  class="mono"
                  style={{ fontSize: 'var(--fs-10)', color: 'var(--lg-red)', flex: '0 0 auto' }}
                >
                  {`−${file.removed}`}
                </span>
              ) : null}
              <RatioBars added={file.added} removed={file.removed} />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** File changes get counts and a four-bar ratio. */
function RatioBars({ added, removed }: { added: number; removed: number }) {
  const total = Math.max(1, added + removed)
  const green = Math.round((added / total) * 4)
  return (
    <span class="row" style={{ gap: '2px', flex: '0 0 auto' }} aria-hidden="true">
      {[0, 1, 2, 3].map((index) => (
        <span
          key={index}
          style={{
            width: '3px',
            height: '12px',
            background: index < green ? 'var(--lg-green)' : 'var(--lg-red)',
          }}
        />
      ))}
    </span>
  )
}

// MARK: - 06C permission

/**
 * The one thing only the user can do. States the command verbatim, what it will
 * destroy in plain units, and how long it has been waiting.
 */
function PermissionSheet() {
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
      class="sheet--bottom"
      role="dialog"
      aria-modal="true"
      aria-label={`Claude is asking to run ${request.command}`}
      style={{
        left: '18px',
        right: '18px',
        bottom: 'calc(20px + var(--safe-bottom))',
        maxWidth: 'var(--measure)',
        marginInline: 'auto',
        background: 'var(--lg-raised)',
        border: '1px solid color-mix(in srgb, var(--lg-amber) 40%, transparent)',
        borderRadius: 'var(--radius-large)',
      }}
    >
      <div class="row" style={{ gap: '9px', padding: '14px 16px 0' }}>
        <span
          aria-hidden="true"
          style={{ width: '7px', height: '7px', background: 'var(--lg-amber)', flex: '0 0 auto' }}
        />
        <Caps size="var(--fs-10)" tracking="0.16em" color="var(--lg-amber)">
          {`WANTS TO RUN · PAUSED ${waited}S`}
        </Caps>
      </div>

      <pre
        class="mono wrap"
        style={{
          margin: '12px 16px 0',
          padding: '13px',
          fontSize: 'var(--fs-12)',
          lineHeight: 1.5,
          whiteSpace: 'pre-wrap',
          userSelect: 'text',
          background: 'var(--lg-deep)',
          border: '1px solid var(--lg-hairline-dim)',
          borderRadius: '6px',
          maxHeight: '30dvh',
          overflowY: 'auto',
        }}
      >
        {request.command}
      </pre>

      {request.explanation ? (
        <p
          class="wrap"
          style={{
            margin: '12px 16px 0',
            fontSize: 'var(--fs-13)',
            lineHeight: 1.45,
            color: 'var(--lg-text-secondary)',
          }}
        >
          {request.explanation}
        </p>
      ) : null}

      <div class="stack" style={{ gap: '8px', padding: '16px' }}>
        <button
          onClick={() => store.answerPermission(true, 'once')}
          title="Runs this command once. You will be asked again next time."
          style={{
            minHeight: '56px',
            borderRadius: '10px',
            background: 'var(--lg-cyan)',
            color: 'var(--lg-on-cyan)',
            fontSize: 'var(--fs-16)',
            fontWeight: 500,
          }}
        >
          Allow once
        </button>

        {/* Deny gets its own full-width row, and the standing grant is moved away
            from it. These two used to sit side by side, the same size, differing
            only in colour — so the tap that stops a tool was one thumb's width from
            the tap that permanently allows it, and only one of those can be taken
            back. */}
        <SecondaryAction
          title="DENY"
          tint="var(--lg-red)"
          border="color-mix(in srgb, var(--lg-red) 50%, transparent)"
          onClick={() => store.answerPermission(false, 'once', 'Denied from the browser.')}
        />

        <button
          onClick={() => store.answerPermission(true, 'always')}
          // Visually demoted on purpose, and this is the one that cannot be taken
          // back — so the title has to carry what the size does not.
          aria-label="Always allow this here"
          title="Grants this command in this folder permanently. Cannot be undone from here."
          style={{ minHeight: 'var(--target)', marginTop: '2px' }}
        >
          <Caps size="var(--fs-9)" tracking="0.12em">
            ALWAYS ALLOW THIS HERE
          </Caps>
        </button>
      </div>
    </div>
  )
}

// MARK: - Session picker

/** Real sessions from ~/.claude/projects, resumable by id. */
function SessionPicker({ onClose }: { onClose: () => void }) {
  useEffect(() => {
    store.listClaudeSessions()
  }, [])

  const sessions = store.claudeSessions.value

  return (
    <div class="sheet" role="dialog" aria-label="Resume a session">
      <ScreenBody>
        <div class="row" style={{ marginTop: '24px', flex: '0 0 auto' }}>
          <Caps size="var(--fs-10)" tracking="0.2em">
            RESUME A SESSION
          </Caps>
          <span class="spacer" />
          <SheetDismiss title="CLOSE" onClick={onClose} />
        </div>

        {/* The picker could only resume, so a Mac with no sessions on it was a dead
            end: the empty state said so and offered nothing. The host already
            accepts an open without a session id. */}
        <button
          onClick={() => {
            store.openClaude(store.claudeMode.value)
            onClose()
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '10px',
            minHeight: '52px',
            paddingInline: '16px',
            marginTop: '18px',
            flex: '0 0 auto',
            borderRadius: 'var(--radius-row)',
            border: '1px solid color-mix(in srgb, var(--lg-cyan) 40%, transparent)',
          }}
        >
          <span class="mono" style={{ fontSize: 'var(--fs-15)', color: 'var(--lg-cyan)' }}>
            +
          </span>
          <Caps size="var(--fs-11)" color="var(--lg-cyan)">
            START A NEW SESSION
          </Caps>
        </button>

        {sessions.length === 0 ? (
          <Caps size="var(--fs-11)" tracking="0.12em" style={{ marginTop: '24px' }}>
            NO SESSIONS FOUND ON THE MAC
          </Caps>
        ) : null}

        <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto', paddingTop: '16px' }}>
          <div class="stack" style={{ gap: '8px' }}>
            {sessions.map((session) => (
              <button
                key={session.id}
                onClick={() => {
                  store.openClaude('code', session.id, session.cwd)
                  onClose()
                }}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  padding: '14px',
                  borderRadius: 'var(--radius-row)',
                  background: 'var(--lg-raised)',
                  border: '1px solid var(--lg-hairline-dim)',
                }}
              >
                <span
                  class="wrap"
                  style={{
                    display: 'block',
                    fontSize: 'var(--fs-14)',
                    lineHeight: 1.35,
                    // Two lines, then clipped: a summary is a label, not the
                    // conversation.
                    maxHeight: '2.7em',
                    overflow: 'hidden',
                  }}
                >
                  {session.summary}
                </span>
                <span class="row" style={{ gap: '8px', marginTop: '6px' }}>
                  <Caps
                    class="ellipsis ellipsis--head"
                    size="var(--fs-9)"
                    tracking="0.08em"
                  >
                    <span>{shortPath(session.cwd)}</span>
                  </Caps>
                  <span class="spacer" style={{ minWidth: '4px' }} />
                  {session.gitBranch ? (
                    <Caps size="var(--fs-9)" tracking="0.08em" color="var(--lg-green)">
                      {session.gitBranch}
                    </Caps>
                  ) : null}
                  <Caps size="var(--fs-9)" tracking="0.08em">
                    {`${session.messageCount} MSG`}
                  </Caps>
                </span>
              </button>
            ))}
          </div>
        </div>

        <div style={{ paddingBottom: 'calc(24px + var(--safe-bottom))', flex: '0 0 auto' }}>
          <PrimaryAction
            title="New session"
            detail="STARTS IN THE LAST PROJECT"
            glyph="＋"
            tint="var(--lg-cyan)"
            ink="var(--lg-on-cyan)"
            onClick={() => {
              store.openClaude('code')
              onClose()
            }}
          />
        </div>
      </ScreenBody>
    </div>
  )
}
