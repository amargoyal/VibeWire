/**
 * Claude answers in Markdown, so the panel renders Markdown. Ported from
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

import { useState } from 'preact/hooks'
import type { ComponentChildren, JSX } from 'preact'

import { Caps } from './components'

// MARK: - Blocks

type Block =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: number; text: string }
  | { kind: 'code'; language: string | null; body: string }
  | { kind: 'bullet'; items: string[] }
  | { kind: 'numbered'; items: string[] }
  | { kind: 'quote'; text: string }
  | { kind: 'rule' }

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
  const flushAll = () => {
    flushParagraph()
    flushLists()
    flushQuote()
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
          style={{ fontSize: 'var(--fs-13)', color: 'var(--lg-cyan)' }}
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
            style={{ color: 'var(--lg-cyan)' }}
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
  color = 'var(--lg-text)',
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
        <ul class="stack" style={{ gap: '6px', margin: 0, paddingLeft: 0, listStyle: 'none' }}>
          {block.items.map((item, index) => (
            <li key={index} class="row row--top" style={{ gap: '8px' }}>
              <span
                class="mono"
                aria-hidden="true"
                style={{ color: 'var(--lg-cyan)', opacity: 0.8, lineHeight: 1.45 }}
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
        <ol class="stack" style={{ gap: '6px', margin: 0, paddingLeft: 0, listStyle: 'none' }}>
          {block.items.map((item, index) => (
            <li key={index} class="row row--top" style={{ gap: '8px' }}>
              <span
                class="mono"
                aria-hidden="true"
                style={{
                  color: 'var(--lg-cyan)',
                  opacity: 0.8,
                  fontSize: `calc(${size} - 3px)`,
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
              background: 'color-mix(in srgb, var(--lg-cyan) 35%, transparent)',
            }}
          />
          <span class="wrap" style={{ color: 'var(--lg-text-secondary)', lineHeight: 1.45 }}>
            {inlineNodes(block.text)}
          </span>
        </blockquote>
      )

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

/**
 * Monospace, own ground, scrolls sideways. Copy button, because the reason to
 * look at a command here is usually to run it somewhere else.
 */
function CodeBlock({ language, code }: { language: string | null; code: string }) {
  const [copied, setCopied] = useState(false)

  return (
    <div
      style={{
        background: 'var(--lg-code)',
        border: '1px solid var(--lg-hairline-dim)',
        borderRadius: 'var(--radius-row)',
      }}
    >
      <div class="row" style={{ padding: '4px 10px 0' }}>
        <Caps size="var(--fs-9)">{(language || 'code').toUpperCase()}</Caps>
        <span class="spacer" />
        <button
          onClick={() => {
            void navigator.clipboard
              ?.writeText(code)
              .then(() => setCopied(true))
              .catch(() => undefined)
          }}
          aria-label={copied ? 'Code copied' : 'Copy code'}
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
          <Caps
            size="var(--fs-9)"
            color={copied ? 'var(--lg-green)' : 'var(--lg-text-secondary)'}
          >
            {copied ? 'COPIED' : 'COPY'}
          </Caps>
        </button>
      </div>
      <pre
        class="mono"
        style={{
          margin: 0,
          padding: '2px 10px 10px',
          overflowX: 'auto',
          fontSize: 'var(--fs-12)',
          color: 'var(--lg-code-ink)',
          lineHeight: 1.5,
        }}
      >
        {code}
      </pre>
    </div>
  )
}
