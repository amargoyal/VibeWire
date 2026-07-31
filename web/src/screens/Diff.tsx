/**
 * 12 · LIVE DIFF — one file Claude is editing.
 * Mirrored by ios/VibeWire/Screens/DiffView.swift.
 *
 * The host re-sends the patch after every tool result while this is open, so the
 * view is a window onto the working tree rather than a snapshot: an edit lands here
 * as Claude makes it. What is shown is `git diff HEAD` — the same thing the user
 * would see at the terminal, not a reconstruction from tool arguments, which drifts
 * the moment a `Bash` step writes a file.
 */

import { useEffect, useRef, useState } from 'preact/hooks'

import { store } from '../app/store'
import {
  Caps,
  ScreenBody,
  SectionLabel,
  SheetDismiss,
  Spinner,
  useSheet,
} from '../design/components'
import { RatioBars } from './ClaudePanel'

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
  added: 'var(--ns-green)',
  removed: 'var(--ns-red)',
  hunk: 'var(--ns-accent)',
  meta: 'var(--ns-text-tertiary)',
  context: 'var(--ns-context)',
}

const BACKGROUND: Record<LineKind, string> = {
  added: 'color-mix(in srgb, var(--ns-green) 10%, transparent)',
  removed: 'color-mix(in srgb, var(--ns-red) 10%, transparent)',
  hunk: 'transparent',
  meta: 'transparent',
  context: 'transparent',
}

export function DiffView() {
  const patch = store.diffPatch.value
  const path = store.diffPath.value

  const sheet = useSheet<HTMLDivElement>(() => store.closeDiff())

  // One pass over the patch: the rows and the two counts the footer states. As
  // separate computed values this split the whole patch three times per render, on a
  // view the host re-sends after every tool result while Claude is editing.
  // `git diff` ends with a newline, and splitting on it leaves an empty final
  // element — drawn as a blank row at the foot of every patch and counted in the
  // total, so a 40-line diff reported 41.
  const lines = patch.length ? patch.replace(/\n$/, '').split('\n') : []
  let added = 0
  let removed = 0
  for (const line of lines) {
    if (line.startsWith('+') && !line.startsWith('+++')) added += 1
    else if (line.startsWith('-') && !line.startsWith('---')) removed += 1
  }
  /** Whether the host has answered at all yet. Not the same as "no changes". */
  const read = patch.length > 0

  /**
   * How much of the widest line is on the glass, and where in it the view sits.
   *
   * The listing is drawn without wrapping and that stays: a diff is mostly
   * indentation, and a wrapped line either lies about its indent or needs a
   * hanging one, which is a second thing on screen that has to be learnt before
   * the first can be read. What was wrong is that the decision had no cost stated
   * anywhere — on a phone a long line was simply cut, and an overlay scrollbar
   * that appears once you have already guessed to swipe is not a way to find out.
   *
   * So the cut is drawn, as the one mark this system already uses for "there is
   * more here than you can see": a measured bar. Its width is the fraction of the
   * widest line on screen and its offset is where in that line the view is, which
   * says at a glance both that the listing continues and by how much. Only the
   * picture is cut — the whole of every line is in the DOM, so a screen reader
   * was never missing anything and there is nothing here to announce.
   */
  const listing = useRef<HTMLDivElement | null>(null)
  const [reach, setReach] = useState({ shown: 1, from: 0 })

  useEffect(() => {
    const node = listing.current
    if (!node) return
    const measure = () => {
      const total = node.scrollWidth || 1
      const shown = Math.min(1, node.clientWidth / total)
      const from = Math.max(0, Math.min(1 - shown, node.scrollLeft / total))
      // Only when it has actually moved. This runs on every scroll event of a
      // view the host is already re-rendering after each tool result.
      setReach((current) =>
        Math.abs(current.shown - shown) < 0.002 && Math.abs(current.from - from) < 0.002
          ? current
          : { shown, from },
      )
    }
    measure()
    node.addEventListener('scroll', measure, { passive: true })
    // The port changes size with the window and with the keyboard; the content
    // changes width with every patch, which is what the dependency below catches.
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => {
      node.removeEventListener('scroll', measure)
      observer.disconnect()
    }
  }, [patch])

  return (
    <div
      ref={sheet}
      class="sheet"
      role="dialog"
      aria-modal="true"
      // Named for the file when there is one. `Live diff for ` with nothing after
      // it is a sentence that stops mid-word.
      aria-label={path ? `Live diff for ${path}` : 'Live diff'}
    >
      <ScreenBody>
        <div class="row" style={{ minHeight: '40px', marginTop: '16px', flex: '0 0 auto' }}>
          <SectionLabel style={{ color: 'var(--ns-accent)' }}>LIVE DIFF</SectionLabel>
          <span class="spacer" />
          <SheetDismiss title="CLOSE" onClick={() => store.closeDiff()} />
        </div>

        <div class="row" style={{ gap: '10px', marginTop: '10px', flex: '0 0 auto' }}>
          <span class="mono ellipsis ellipsis--head" style={{ fontSize: 'var(--fs-13)' }}>
            <span>{path ?? ''}</span>
          </span>
          <span class="spacer" style={{ minWidth: '8px' }} />
          {/*
            Withheld until the host has answered. Four bars split nought to four is
            a picture of a file with every line removed, and that is what an unread
            patch drew: both counts are zero before the first `git diff` comes back,
            and a measured zero is not the same fact as an unmeasured value.
          */}
          {read ? <RatioBars added={added} removed={removed} /> : null}
        </div>

        {!read ? (
          <div
            class="stack"
            style={{ flex: '1 1 auto', alignItems: 'center', justifyContent: 'center', gap: '12px' }}
          >
            <Spinner size={20} />
            <Caps size="var(--fs-10)" tracking="0.14em">
              READING THE WORKING TREE
            </Caps>
          </div>
        ) : (
          // The panel is the ground and the corner; the listing inside it is what
          // scrolls, so the reach bar can sit on the same ground at the bottom
          // edge without being carried away by the scroll it is describing. The
          // clipping stays on the listing rather than moving up here, because a
          // focus ring is drawn at 2px outside the box it belongs to and this is
          // the box that now takes focus.
          <div
            style={{
              flex: '1 1 auto',
              minHeight: 0,
              marginTop: '14px',
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--ns-deep)',
              borderRadius: 'var(--radius-control)',
            }}
          >
            {/*
              Sideways too: wrapped code lies about indentation, and a diff is mostly
              indentation. `min-content` on the inner column is what lets the tinted
              rows run the full width of the longest line instead of stopping raggedly
              at each line's own last character.

              The listing takes the tab stop itself. Nothing inside it is focusable,
              so without one there is no key that scrolls it — the rest of a long
              line is on the page and unreachable by anything but a finger.
            */}
            <div
              ref={listing}
              role="region"
              aria-label="Patch"
              tabIndex={0}
              style={{
                flex: '1 1 auto',
                minHeight: 0,
                overflow: 'auto',
                // A tinted row runs the full width of the widest line, so without
                // a corner of its own the first and last of them square off the
                // panel's.
                borderRadius: 'var(--radius-control)',
              }}
            >
              <div style={{ minWidth: 'min-content', paddingBlock: '12px' }}>
                {lines.map((line, index) => {
                  const kind = kindOf(line)
                  return (
                    <div
                      key={index}
                      class="mono"
                      style={{
                        fontSize: 'var(--fs-11)',
                        lineHeight: 1.6,
                        padding: '1px 12px',
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

            {/*
              Drawn only while there is line off the glass, and gone the moment the
              whole of the widest one fits — a bar that is always there says nothing,
              and one that is there when nothing is hidden says something false.
            */}
            {reach.shown < 0.995 ? (
              <div aria-hidden="true" style={{ flex: '0 0 auto', padding: '0 12px 9px' }}>
                <div
                  style={{
                    position: 'relative',
                    height: '3px',
                    borderRadius: 'var(--radius-bar)',
                    background: 'var(--ns-stroke)',
                  }}
                >
                  <span
                    style={{
                      position: 'absolute',
                      top: 0,
                      bottom: 0,
                      left: `${reach.from * 100}%`,
                      width: `${reach.shown * 100}%`,
                      borderRadius: 'var(--radius-bar)',
                      background: 'var(--ns-text-tertiary)',
                    }}
                  />
                </div>
              </div>
            ) : null}
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
          {read ? (
            <>
              <Caps size="var(--fs-10)" tracking="0.12em" color="var(--ns-green)">
                {`+${added}`}
              </Caps>
              <Caps size="var(--fs-10)" tracking="0.12em" color="var(--ns-red)">
                {`−${removed}`}
              </Caps>
            </>
          ) : (
            // A dash at the size the real counts will take, in tertiary ink. The
            // host has not answered yet, and `+0 −0` states a measurement nobody
            // made — the one thing the panel is not allowed to do.
            <>
              <Caps size="var(--fs-10)" tracking="0.12em">
                +—
              </Caps>
              <Caps size="var(--fs-10)" tracking="0.12em">
                −—
              </Caps>
            </>
          )}
          <span class="spacer" />
          {/*
            The two counts say what changed; they say nothing about how much there
            is to get through, so a three-line patch and a two-thousand-line one
            arrive looking the same and only the scroll tells them apart. The
            length of the listing is the fact that was missing, and it goes on the
            line that is already here rather than in a row of its own.
          */}
          <Caps size="var(--fs-9)" tracking="0.14em" style={{ textAlign: 'right' }}>
            {read
              ? `${lines.length} LINES · UPDATES AS CLAUDE EDITS`
              : 'UPDATES AS CLAUDE EDITS'}
          </Caps>
        </div>
      </ScreenBody>
    </div>
  )
}
