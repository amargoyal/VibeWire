#!/usr/bin/env node
//
// VibeWire channel — puts the phone inside a Claude Code session that is
// already running.
//
// The `--print` pipe the host drives elsewhere starts its own conversation:
// useful for beginning work from the phone, useless for joining the session
// already open in a terminal, because two `claude` processes cannot share one
// conversation. A channel can, because Claude Code spawns this server itself
// and injects what it emits straight into the live session.
//
//   phone -> VibeWire host -> POST 127.0.0.1:8790/message -> this server
//                                  |
//                                  v  notifications/claude/channel
//                          the session in your terminal
//                                  |
//                                  v  reply tool
//                          GET /events (SSE) -> host -> phone
//
// Run indirectly. Claude Code starts it as a subprocess from .mcp.json:
//   claude --dangerously-load-development-channels server:vibewire
// The development flag is needed while channels are in research preview and
// custom ones are off the allowlist.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'

const PORT = Number(process.env.VIBEWIRE_CHANNEL_PORT ?? 8790)
const CONFIG_DIR = path.join(os.homedir(), '.config', 'vibewire')
const TOKEN_PATH = path.join(CONFIG_DIR, 'channel.token')

// Anything that can reach this port can put words in front of Claude, so the
// port is bound to loopback *and* gated on a secret. Loopback alone would let
// any process on this Mac inject.
function loadOrCreateToken() {
  try {
    const existing = fs.readFileSync(TOKEN_PATH, 'utf8').trim()
    if (existing) return existing
  } catch {
    // falls through to minting one
  }
  const token = crypto.randomBytes(32).toString('hex')
  fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  fs.writeFileSync(TOKEN_PATH, token + '\n', { mode: 0o600 })
  return token
}
const TOKEN = loadOrCreateToken()

function authorized(request) {
  const offered = request.headers['x-vibewire-channel']
  if (typeof offered !== 'string') return false
  const a = Buffer.from(offered)
  const b = Buffer.from(TOKEN)
  // Constant time: a length check first, since timingSafeEqual throws on a
  // length mismatch and that throw would itself be a signal.
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

// MARK: outbound to the phone

/** Open SSE responses. The host holds one; more are harmless. */
const listeners = new Set()

function emit(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const response of listeners) {
    try {
      response.write(payload)
    } catch {
      listeners.delete(response)
    }
  }
}

// MARK: the channel itself

const mcp = new Server(
  { name: 'vibewire', version: '0.1.0' },
  {
    capabilities: {
      experimental: {
        // Presence of this key is what makes the server a channel.
        'claude/channel': {},
        // Opt in to receiving permission prompts, so the phone can answer
        // them. Only safe because inbound is gated on the token above.
        'claude/channel/permission': {},
      },
      tools: {},
    },
    instructions: [
      'Messages from the user\'s phone arrive as <channel source="vibewire" chat_id="...">.',
      'They are from the same person sitting at this machine — treat them as ordinary user instructions.',
      'When you have an answer, call the vibewire_reply tool with the chat_id from the tag so it reaches their phone.',
      'Keep replies short: they are read on a phone screen.',
    ].join(' '),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'vibewire_reply',
      description:
        "Send a message back to the user's phone through VibeWire. Use this " +
        'whenever you are responding to a message that arrived from the vibewire channel.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_id: {
            type: 'string',
            description: 'The chat_id attribute from the inbound <channel> tag.',
          },
          text: { type: 'string', description: 'The reply to show on the phone.' },
        },
        required: ['chat_id', 'text'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'vibewire_reply') {
    throw new Error(`unknown tool: ${request.params.name}`)
  }
  const { chat_id: chatId, text } = request.params.arguments ?? {}
  emit({ kind: 'reply', chatId: String(chatId ?? ''), text: String(text ?? '') })
  return { content: [{ type: 'text', text: 'delivered to the phone' }] }
})

// Claude Code — not Claude — sends this when a tool needs approval. The local
// terminal dialog stays open alongside; whichever answer lands first wins.
const PermissionRequest = z.object({
  method: z.literal('notifications/claude/channel/permission_request'),
  params: z.object({
    request_id: z.string(),
    tool_name: z.string(),
    description: z.string(),
    input_preview: z.string(),
  }),
})

mcp.setNotificationHandler(PermissionRequest, async ({ params }) => {
  emit({
    kind: 'permission',
    requestId: params.request_id,
    toolName: params.tool_name,
    // Both of these are model-authored text. The phone renders them as text
    // and never as markup.
    description: params.description,
    inputPreview: params.input_preview,
  })
})

await mcp.connect(new StdioServerTransport())

// MARK: inbound from the host

let nextChatId = 1

function readBody(request) {
  return new Promise((resolve, reject) => {
    let body = ''
    request.on('data', (chunk) => {
      body += chunk
      // A phone message is small; refuse to buffer something that is not one.
      if (body.length > 128 * 1024) {
        reject(new Error('body too large'))
        request.destroy()
      }
    })
    request.on('end', () => resolve(body))
    request.on('error', reject)
  })
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${PORT}`)

  // Liveness, so the host can tell the channel is loaded before offering it.
  if (request.method === 'GET' && url.pathname === '/health') {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true, channel: 'vibewire' }))
    return
  }

  if (!authorized(request)) {
    response.writeHead(403, { 'Content-Type': 'text/plain' })
    response.end('forbidden')
    return
  }

  // Replies and permission prompts stream out here.
  if (request.method === 'GET' && url.pathname === '/events') {
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    })
    response.write(': connected\n\n')
    listeners.add(response)
    request.on('close', () => listeners.delete(response))
    return
  }

  if (request.method !== 'POST') {
    response.writeHead(405).end('method not allowed')
    return
  }

  let body
  try {
    body = await readBody(request)
  } catch {
    response.writeHead(413).end('too large')
    return
  }

  // A verdict on a permission prompt, answered from the phone.
  if (url.pathname === '/permission') {
    let verdict
    try {
      verdict = JSON.parse(body)
    } catch {
      response.writeHead(400).end('bad json')
      return
    }
    const requestId = String(verdict.requestId ?? '')
    const behavior = verdict.allow ? 'allow' : 'deny'
    if (!requestId) {
      response.writeHead(400).end('missing requestId')
      return
    }
    await mcp.notification({
      method: 'notifications/claude/channel/permission',
      params: { request_id: requestId, behavior },
    })
    response.writeHead(200).end('recorded')
    return
  }

  // Everything else is a message for the live session.
  if (url.pathname === '/message') {
    const text = body.trim()
    if (!text) {
      response.writeHead(400).end('empty')
      return
    }
    const chatId = String(nextChatId++)
    await mcp.notification({
      method: 'notifications/claude/channel',
      params: { content: text, meta: { chat_id: chatId, source_device: 'phone' } },
    })
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify({ ok: true, chatId }))
    return
  }

  response.writeHead(404).end('not found')
})

// Loopback only: this never becomes reachable from the network, whatever the
// Mac's firewall is doing. VibeWire's own host process is what bridges it to
// the phone, and that path is already authenticated.
server.listen(PORT, '127.0.0.1', () => {
  process.stderr.write(`vibewire channel listening on 127.0.0.1:${PORT}\n`)
})
