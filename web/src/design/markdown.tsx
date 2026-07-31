/**
 * Claude answers in Markdown, so the panel renders Markdown. Mirrored by
 * ios/VibeWire/Design/Markdown.swift.
 *
 * Not a full CommonMark implementation and not trying to be. Blocks are split
 * here and inline spans are handled by a small scanner, because the one treatment
 * code actually needs is structural: monospace, its own ground, and horizontal
 * scrolling instead of wrapping. Wrapped code is unreadable and truncated code is
 * a lie.
 *
 * Everything here builds nodes rather than HTML strings. There is no
 * `innerHTML` anywhere in this file, deliberately: the text being rendered is
 * whatever a model wrote about whatever it read on the Mac, and that is not
 * input to hand to a parser that can execute.
 */

import { useEffect, useRef, useState } from 'preact/hooks'
import type { ComponentChildren, JSX } from 'preact'

import { Announce, Caps } from './components'

// MARK: - Blocks

type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; language: string | null; body: string }
  | { kind: 'bullet'; items: string[] }
  | { kind: 'numbered'; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'table'; header: string[]; rows: string[][] }
  | { kind: 'rule' }

/**
 * A GitHub-style pipe table, or null if this run is not one.
 *
 * The separator row is the whole test: `| --- | :--: |`. Without it a line
 * starting with a pipe is just a line starting with a pipe, and a table that is
 * still streaming in has a header and no separator yet — both have to come back
 * as prose rather than as a half-built grid.
 */
function parseTable(lines: string[]): { kind: 'table'; header: string[]; rows: string[][] } | null {
  if (lines.length < 2) return null
  const cells = (line: string) =>
    line
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((cell) => cell.trim())

  const separator = cells(lines[1] ?? '')
  const isSeparator =
    separator.length > 0 && separator.every((cell) => /^:?-{1,}:?$/.test(cell))
  if (!isSeparator) return null

  const header = cells(lines[0] ?? '')
  const rows = lines.slice(2).map(cells)
  return { kind: 'table', header, rows }
}

/**
 * One pass, line by line. Fences win over everything: while a fence is open
 * nothing inside it is interpreted, which is what makes it safe to show a code
 * sample that itself contains Markdown.
 */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = []
  let paragraph: string[] = []
  let bullets: string[] = []
  let numbers: string[] = []
  let quote: string[] = []
  let table: string[] = []

  let fenceLanguage: string | null = null
  let fenceBody: string[] = []
  let inFence = false

  const flushParagraph = () => {
    if (!paragraph.length) return
    blocks.push({ kind: 'paragraph', text: paragraph.join('\n') })
    paragraph = []
  }
  const flushLists = () => {
    if (bullets.length) {
      blocks.push({ kind: 'bullet', items: bullets })
      bullets = []
    }
    if (numbers.length) {
      blocks.push({ kind: 'numbered', items: numbers })
      numbers = []
    }
  }
  const flushQuote = () => {
    if (!quote.length) return
    blocks.push({ kind: 'quote', text: quote.join('\n') })
    quote = []
  }
  /**
   * A run of pipe rows is a table only if the second one is the separator that
   * says so. Anything else — one pipe in a sentence, a fragment cut off by the
   * end of a streaming delta — goes back to being a paragraph, which is what it
   * was before this existed.
   */
  const flushTable = () => {
    if (!table.length) return
    const parsed = parseTable(table)
    if (parsed) blocks.push(parsed)
    else blocks.push({ kind: 'paragraph', text: table.join('\n') })
    table = []
  }
  const flushAll = () => {
    flushParagraph()
    flushLists()
    flushQuote()
    flushTable()
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()

    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      if (inFence) {
        blocks.push({ kind: 'code', language: fenceLanguage, body: fenceBody.join('\n') })
        fenceBody = []
        fenceLanguage = null
        inFence = false
      } else {
        flushAll()
        const tag = trimmed.slice(3).trim()
        fenceLanguage = tag || null
        inFence = true
      }
      continue
    }

    if (inFence) {
      fenceBody.push(line)
      continue
    }

    if (!trimmed) {
      flushAll()
      continue
    }

    if (trimmed === '---' || trimmed === '***' || trimmed === '___') {
      flushAll()
      blocks.push({ kind: 'rule' })
      continue
    }

    if (trimmed.startsWith('#')) {
      flushAll()
      const hashes = /^#+/.exec(trimmed)?.[0].length ?? 1
      blocks.push({
        kind: 'heading',
        level: Math.min(hashes, 3),
        text: trimmed.slice(hashes).trim(),
      })
      continue
    }

    if (trimmed.startsWith('> ') || trimmed === '>') {
      flushParagraph()
      flushLists()
      quote.push(trimmed.slice(trimmed.length > 1 ? 2 : 1))
      continue
    }

    // A row of a pipe table. Claude writes these constantly and they used to
    // fall through to a paragraph, which renders the pipes and the dashes
    // verbatim — a table drawn as the ASCII it was typed as.
    if (trimmed.startsWith('|')) {
      flushParagraph()
      flushLists()
      flushQuote()
      table.push(trimmed)
      continue
    }
    flushTable()

    const bullet = bulletItem(trimmed)
    if (bullet != null) {
      flushParagraph()
      flushQuote()
      if (numbers.length) {
        blocks.push({ kind: 'numbered', items: numbers })
        numbers = []
      }
      bullets.push(bullet)
      continue
    }

    const numbered = numberedItem(trimmed)
    if (numbered != null) {
      flushParagraph()
      flushQuote()
      if (bullets.length) {
        blocks.push({ kind: 'bullet', items: bullets })
        bullets = []
      }
      numbers.push(numbered)
      continue
    }

    flushLists()
    flushQuote()
    paragraph.push(line)
  }

  if (inFence && fenceBody.length) {
    // Streaming: the closing fence has not arrived yet. Show what there is rather
    // than nothing — this is the common case mid-answer.
    blocks.push({ kind: 'code', language: fenceLanguage, body: fenceBody.join('\n') })
  }
  flushAll()
  return blocks
}

function bulletItem(line: string): string | null {
  for (const marker of ['- ', '* ', '+ ']) {
    if (line.startsWith(marker)) return line.slice(marker.length)
  }
  return null
}

function numberedItem(line: string): string | null {
  const match = /^(\d+)[.)] (.*)$/.exec(line)
  return match ? match[2] : null
}

// MARK: - Inline spans

/**
 * Bold, italic, inline code and links, scanned in one pass.
 *
 * Code wins over everything else, the way a fence does at block level: backticks
 * are opaque, so `**not bold**` inside them stays literal.
 */
export function inlineNodes(text: string): ComponentChildren[] {
  const nodes: ComponentChildren[] = []
  let buffer = ''
  let index = 0
  let key = 0

  const flush = () => {
    if (buffer) nodes.push(buffer)
    buffer = ''
  }

  while (index < text.length) {
    const rest = text.slice(index)

    const code = /^`([^`]+)`/.exec(rest)
    if (code) {
      flush()
      nodes.push(
        <code
          key={key++}
          class="mono"
          style={{ fontSize: 'var(--fs-13)', color: 'var(--ns-accent)' }}
        >
          {code[1]}
        </code>,
      )
      index += code[0].length
      continue
    }

    const link = /^\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/.exec(rest)
    if (link) {
      flush()
      const href = safeHref(link[2])
      nodes.push(
        href ? (
          <a
            key={key++}
            href={href}
            target="_blank"
            rel="noreferrer noopener"
            style={{ color: 'var(--ns-accent)' }}
          >
            {link[1] || href}
          </a>
        ) : (
          // A `javascript:` or `data:` URL in model output is not a link this app
          // will make clickable. The text stays so nothing is silently dropped.
          <span key={key++}>{link[1] || link[2]}</span>
        ),
      )
      index += link[0].length
      continue
    }

    const strong = /^(\*\*|__)(.+?)\1/.exec(rest)
    if (strong) {
      flush()
      nodes.push(
        <strong key={key++} style={{ fontWeight: 600 }}>
          {inlineNodes(strong[2])}
        </strong>,
      )
      index += strong[0].length
      continue
    }

    const emphasis = /^(\*|_)([^*_]+?)\1/.exec(rest)
    if (emphasis) {
      flush()
      nodes.push(<em key={key++}>{inlineNodes(emphasis[2])}</em>)
      index += emphasis[0].length
      continue
    }

    buffer += text[index]
    index += 1
  }

  flush()
  return nodes
}

/** Only schemes a link can safely carry. Everything else renders as plain text. */
function safeHref(raw: string): string | null {
  try {
    const url = new URL(raw, location.href)
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null
  } catch {
    return null
  }
}

// MARK: - View

export function MarkdownText({
  text,
  color = 'var(--ns-text)',
  size = 'var(--fs-15)',
}: {
  text: string
  color?: string
  size?: string
}) {
  const blocks = parseBlocks(text)

  return (
    <div class="stack" style={{ gap: '10px', color, fontSize: size }}>
      {blocks.map((block, index) => (
        <BlockView key={index} block={block} size={size} />
      ))}
    </div>
  )
}

function BlockView({ block, size }: { block: Block; size: string }) {
  switch (block.kind) {
    case 'paragraph':
      return (
        <p class="wrap" style={{ margin: 0, lineHeight: 1.45, whiteSpace: 'pre-wrap' }}>
          {inlineNodes(block.text)}
        </p>
      )

    case 'heading': {
      const Tag = (`h${Math.min(block.level, 3) + 2}` as keyof JSX.IntrinsicElements) as 'h3'
      return (
        <Tag
          class="wrap"
          style={{
            margin: '2px 0 0',
            fontWeight: 600,
            lineHeight: 1.3,
            fontSize: headingSize(block.level),
          }}
        >
          {inlineNodes(block.text)}
        </Tag>
      )
    }

    case 'code':
      return <CodeBlock language={block.language} code={block.body} />

    case 'bullet':
      return (
        // `role="list"` is not redundant here. Safari drops the list semantics of
        // any `ul` whose `list-style` is `none` — the assumption being that a list
        // without markers was never meant to be heard as one — and VoiceOver then
        // reads these items as loose text with no count and no boundaries. The
        // marker below is drawn rather than generated precisely so it can take the
        // accent and hold the baseline, so the role has to be put back by hand.
        <ul
          class="stack"
          role="list"
          style={{ gap: '6px', margin: 0, paddingLeft: 0, listStyle: 'none' }}
        >
          {block.items.map((item, index) => (
            <li key={index} class="row row--top" style={{ gap: '8px' }}>
              <span
                class="mono"
                aria-hidden="true"
                style={{ color: 'var(--ns-accent)', opacity: 0.8, lineHeight: 1.45 }}
              >
                •
              </span>
              <span class="wrap" style={{ lineHeight: 1.45 }}>
                {inlineNodes(item)}
              </span>
            </li>
          ))}
        </ul>
      )

    case 'numbered':
      return (
        // Same restoration as the bullet list above, and it matters more here: the
        // drawn number is hidden, so with the role gone there is nothing left that
        // says which item of how many this is.
        <ol
          class="stack"
          role="list"
          style={{ gap: '6px', margin: 0, paddingLeft: 0, listStyle: 'none' }}
        >
          {block.items.map((item, index) => (
            <li key={index} class="row row--top" style={{ gap: '8px' }}>
              <span
                class="mono"
                aria-hidden="true"
                style={{
                  color: 'var(--ns-accent)',
                  opacity: 0.8,
                  // The 9px floor is a rule about what renders, not about the
                  // tokens: subtracting from a size that scales with the reader's
                  // text setting can cross the floor from above.
                  fontSize: `max(9px, calc(${size} - 3px))`,
                  lineHeight: 1.6,
                }}
              >
                {index + 1}.
              </span>
              <span class="wrap" style={{ lineHeight: 1.45 }}>
                {inlineNodes(item)}
              </span>
            </li>
          ))}
        </ol>
      )

    case 'quote':
      return (
        <blockquote class="row row--top" style={{ gap: '10px', margin: 0 }}>
          <span
            aria-hidden="true"
            style={{
              width: '2px',
              alignSelf: 'stretch',
              background: 'color-mix(in srgb, var(--ns-accent) 35%, transparent)',
            }}
          />
          <span class="wrap" style={{ color: 'var(--ns-text-secondary)', lineHeight: 1.45 }}>
            {inlineNodes(block.text)}
          </span>
        </blockquote>
      )

    case 'table': {
      // Mono throughout, because a table in an answer is a table of values, and
      // this system sets anything measured in mono. It scrolls sideways rather
      // than wrapping cells: a four-column table does not fit a phone at any font
      // size, and a wrapped cell stops lining up with its heading, which is the
      // only thing a table is for.
      const columns = Math.max(block.header.length, ...block.rows.map((row) => row.length))
      const template = `repeat(${Math.max(columns, 1)}, minmax(max-content, 1fr))`
      return (
        <div
          role="region"
          aria-label="Table"
          tabIndex={0}
          style={{
            overflowX: 'auto',
            background: 'var(--ns-deep)',
            borderRadius: 'var(--radius-inner)',
            padding: '10px 12px',
          }}
        >
          <div role="table" style={{ display: 'grid', gridTemplateColumns: template, columnGap: '18px' }}>
            <div role="row" style={{ display: 'contents' }}>
              {Array.from({ length: columns }, (_, index) => (
                <span
                  key={`h${index}`}
                  role="columnheader"
                  class="caps"
                  style={{
                    fontSize: 'var(--fs-9)',
                    paddingBottom: '7px',
                    whiteSpace: 'nowrap',
                    borderBottom: '1px solid var(--ns-hairline)',
                  }}
                >
                  {block.header[index] ?? ''}
                </span>
              ))}
            </div>
            {block.rows.map((row, rowIndex) => (
              <div key={rowIndex} role="row" style={{ display: 'contents' }}>
                {Array.from({ length: columns }, (_, index) => (
                  <span
                    key={index}
                    role="cell"
                    class="mono"
                    style={{
                      fontSize: 'var(--fs-12)',
                      lineHeight: 1.9,
                      whiteSpace: 'nowrap',
                      color: index === 0 ? 'var(--ns-text)' : 'var(--ns-context)',
                    }}
                  >
                    {inlineNodes(row[index] ?? '')}
                  </span>
                ))}
              </div>
            ))}
          </div>
        </div>
      )
    }

    case 'rule':
      return <div class="hairline" style={{ margin: '2px 0' }} />
  }
}

function headingSize(level: number): string {
  switch (level) {
    case 1:
      return 'var(--fs-22)'
    case 2:
      return 'var(--fs-17)'
    default:
      return 'var(--fs-16)'
  }
}

/** What the last tap on the copy chip actually did. */
type CopyState = 'idle' | 'copied' | 'refused'

/**
 * How long the chip states its answer before going back to offering the copy.
 * Long enough to be read after the thumb has moved, short enough that it is
 * plainly about the tap that just happened.
 */
const COPY_ANSWER_MS = 2400

/**
 * Monospace, own ground, scrolls sideways. Copy button, because the reason to
 * look at a command here is usually to run it somewhere else.
 */
function CodeBlock({ language, code }: { language: string | null; code: string }) {
  const [copy, setCopy] = useState<CopyState>('idle')
  const answering = useRef<ReturnType<typeof setTimeout> | null>(null)

  // The answer to a tap is an event, not a condition. Latched on, the chip reads
  // COPIED for the rest of the session — reporting the last tap anyone made
  // rather than what this control would do now, which is the one thing a label
  // on a button is for.
  useEffect(
    () => () => {
      if (answering.current) clearTimeout(answering.current)
    },
    [],
  )

  const answer = (state: CopyState) => {
    if (answering.current) clearTimeout(answering.current)
    setCopy(state)
    answering.current = setTimeout(() => setCopy('idle'), COPY_ANSWER_MS)
  }

  const onCopy = () => {
    // The Mac serves this page over plain HTTP on the tailnet, and a page that is
    // not a secure context has no `navigator.clipboard` at all — so on the path
    // this client is most often opened from, the chain below yields nothing and
    // nothing is written. A control that does nothing and says nothing is the
    // defect the clipboard sheet already exists to answer; this says it instead.
    const written = navigator.clipboard?.writeText(code)
    if (!written) {
      answer('refused')
      return
    }
    void written.then(() => answer('copied')).catch(() => answer('refused'))
  }

  const chip =
    copy === 'copied'
      ? { label: 'COPIED', ink: 'var(--ns-green)', spoken: 'Copied' }
      : copy === 'refused'
        ? { label: 'REFUSED', ink: 'var(--ns-red)', spoken: 'Copy refused' }
        : { label: 'COPY', ink: 'var(--ns-text-secondary)', spoken: 'Copy code' }

  return (
    <div
      // Nightshift draws a code block as its own ground rather than as a
      // bordered box: the two greys are the separation, and a border around a
      // block that already has a fill is one line doing nothing.
      style={{
        background: 'var(--ns-deep)',
        borderRadius: 'var(--radius-inner)',
      }}
    >
      <div class="row" style={{ padding: '4px 10px 0' }}>
        <Caps size="var(--fs-9)">{(language || 'code').toUpperCase()}</Caps>
        <span class="spacer" />
        <button
          onClick={onCopy}
          // The name follows the word on the chip, so a reader driving this by
          // voice asks for the label that is actually there. It is not where the
          // confirmation lives, though: a name that changes under a control
          // nobody is on is never spoken again, which is what the live region
          // below is for.
          aria-label={chip.spoken}
          style={{
            // 28px was below the floor for a target, and the ink is four small
            // letters. The chip looks the same; the area that answers a thumb is a
            // full one.
            minHeight: 'var(--target)',
            paddingInline: '12px',
            display: 'flex',
            alignItems: 'center',
          }}
        >
          <Caps size="var(--fs-9)" color={chip.ink}>
            {chip.label}
          </Caps>
        </button>
        {/*
          Rendered whatever the state, deliberately. A live region that arrives on
          the page with its sentence already in it is not reliably read — the
          region has to be there first and the text has to land in it — so this
          holds an empty one open and fills it when there is something to say.
        */}
        <Announce>
          {copy === 'copied'
            ? 'Code copied.'
            : copy === 'refused'
              ? 'This browser would not put the code on the clipboard. Select it and copy it by hand.'
              : ''}
        </Announce>
      </div>
      <pre
        class="mono"
        // A block that scrolls sideways and holds nothing focusable cannot be
        // scrolled by a keyboard at all: the rest of the line is on the page and
        // there is no key that brings it into view. Making the listing itself the
        // stop is what the arrow keys then scroll.
        tabIndex={0}
        style={{
          margin: 0,
          padding: '2px 10px 10px',
          overflowX: 'auto',
          fontSize: 'var(--fs-12)',
          color: 'var(--ns-code-ink)',
          lineHeight: 1.5,
        }}
      >
        {code}
      </pre>
    </div>
  )
}
