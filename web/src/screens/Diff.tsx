/**
 * The live diff for one file Claude is editing.
 * Ported from ios/VibeWire/Screens/DiffView.swift.
 *
 * The host re-sends the patch after every tool result while this is open, so the
 * view is a window onto the working tree rather than a snapshot: an edit lands here
 * as Claude makes it. What is shown is `git diff HEAD` — the same thing the user
 * would see at the terminal, not a reconstruction from tool arguments, which drifts
 * the moment a `Bash` step writes a file.
 */

import { useEffect } from 'preact/hooks'

import { store } from '../app/store'
import { Caps, ScreenBody, SheetDismiss, Spinner } from '../design/components'

type LineKind = 'added' | 'removed' | 'hunk' | 'meta' | 'context'

/** Colour carries the meaning; the leading +/− stays so a copied diff is still a
 *  diff. */
function kindOf(line: string): LineKind {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta'
  if (line.startsWith('@@')) return 'hunk'
  if (line.startsWith('+')) return 'added'
  if (line.startsWith('-')) return 'removed'
  if (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('new file') ||
    line.startsWith('deleted file')
  ) {
    return 'meta'
  }
  return 'context'
}

const FOREGROUND: Record<LineKind, string> = {
  added: 'var(--lg-green)',
  removed: 'var(--lg-red)',
  hunk: 'var(--lg-cyan)',
  meta: 'var(--lg-text-tertiary)',
  context: 'var(--lg-context)',
}

const BACKGROUND: Record<LineKind, string> = {
  added: 'color-mix(in srgb, var(--lg-green) 8%, transparent)',
  removed: 'color-mix(in srgb, var(--lg-red) 8%, transparent)',
  hunk: 'transparent',
  meta: 'transparent',
  context: 'transparent',
}

export function DiffView() {
  const patch = store.diffPatch.value
  const path = store.diffPath.value

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') store.closeDiff()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // One pass over the patch: the rows and the two counts the footer states. As
  // separate computed values this split the whole patch three times per render, on a
  // view the host re-sends after every tool result while Claude is editing.
  const lines = patch.length ? patch.split('\n') : []
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1
  }

  return (
    <div class="sheet" role="dialog" aria-label={`Live diff for ${path ?? ''}`}>
      <ScreenBody>
        <div class="stack" style={{ gap: '8px', marginTop: '24px', flex: '0 0 auto' }}>
          <div class="row">
            <Caps size="var(--fs-10)" tracking="0.2em" color="var(--lg-cyan)">
              LIVE DIFF
            </Caps>
            <span class="spacer" />
            <SheetDismiss title="CLOSE" onClick={() => store.closeDiff()} />
          </div>
          <span class="mono ellipsis ellipsis--head" style={{ fontSize: 'var(--fs-12)' }}>
            <span>{path ?? ''}</span>
          </span>
        </div>

        {patch.length === 0 ? (
          <div
            class="stack"
            style={{
              flex: '1 1 auto',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '10px',
            }}
          >
            <Spinner size={20} />
            <Caps size="var(--fs-10)" tracking="0.14em">
              READING THE WORKING TREE
            </Caps>
          </div>
        ) : (
          // Sideways too: wrapped code lies about indentation, and a diff is mostly
          // indentation. `min-content` on the inner column is what lets the tinted
          // rows run the full width of the longest line instead of stopping raggedly
          // at each line's own last character.
          <div
            style={{
              flex: '1 1 auto',
              minHeight: 0,
              marginTop: '14px',
              overflow: 'auto',
              background: 'var(--lg-code)',
              border: '1px solid var(--lg-hairline-dim)',
              borderRadius: 'var(--radius-row)',
            }}
          >
            <div style={{ minWidth: 'min-content', paddingBlock: '10px' }}>
              {lines.map((line, index) => {
                const kind = kindOf(line)
                return (
                  <div
                    key={index}
                    class="mono"
                    style={{
                      fontSize: 'var(--fs-11)',
                      lineHeight: 1.5,
                      padding: '1px 10px',
                      whiteSpace: 'pre',
                      color: FOREGROUND[kind],
                      background: BACKGROUND[kind],
                    }}
                  >
                    {line || ' '}
                  </div>
                )
              })}
            </div>
          </div>
        )}

        <div
          class="row"
          style={{
            gap: '14px',
            paddingBlock: '16px',
            paddingBottom: 'calc(16px + var(--safe-bottom))',
            flex: '0 0 auto',
          }}
        >
          <Caps size="var(--fs-10)" tracking="0.12em" color="var(--lg-green)">
            {`+${added}`}
          </Caps>
          <Caps size="var(--fs-10)" tracking="0.12em" color="var(--lg-red)">
            {`−${removed}`}
          </Caps>
          <span class="spacer" />
          <Caps size="var(--fs-9)" tracking="0.14em">
            UPDATES AS CLAUDE EDITS
          </Caps>
        </div>
      </ScreenBody>
    </div>
  )
}
