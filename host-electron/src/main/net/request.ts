import type { IncomingMessage } from 'node:http'

/** A parsed request, the shape the router dispatches on. */
export interface HTTPRequest {
  method: string
  path: string
  query: Record<string, string>
  /** Lowercased keys. */
  headers: Record<string, string>
  body: Buffer
}

export function header(request: HTTPRequest, name: string): string | undefined {
  return request.headers[name.toLowerCase()]
}

/** Pairing payloads are a few hundred bytes; nothing legitimate is bigger than this. */
export const MAX_BODY_BYTES = 64 * 1024

/**
 * Splits the request target into a path and a query.
 *
 * Percent-decoding only. A `+` stays a `+`: the socket credentials are standard
 * base64 in the query string, and a parser that turned `+` into a space would
 * corrupt one signature in four and fail authentication with no error anyone
 * could read. A pair that will not decode is dropped, not guessed at.
 */
export function parseTarget(target: string): { path: string; query: Record<string, string> } {
  const questionMark = target.indexOf('?')
  if (questionMark < 0) return { path: target, query: {} }
  const path = target.slice(0, questionMark)
  const query: Record<string, string> = {}
  for (const pair of target.slice(questionMark + 1).split('&')) {
    if (!pair) continue
    const equals = pair.indexOf('=')
    const rawKey = equals < 0 ? pair : pair.slice(0, equals)
    const rawValue = equals < 0 ? '' : pair.slice(equals + 1)
    const key = percentDecode(rawKey)
    if (key === null) continue
    query[key] = percentDecode(rawValue) ?? ''
  }
  return { path, query }
}

export function percentDecode(text: string): string | null {
  try {
    return decodeURIComponent(text)
  } catch {
    return null
  }
}

/** Reads the whole body, or resolves null when it exceeds the cap. */
export function readBody(message: IncomingMessage, cap = MAX_BODY_BYTES): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    let overflowed = false
    message.on('data', (chunk: Buffer) => {
      if (overflowed) return
      total += chunk.length
      if (total > cap) {
        overflowed = true
        chunks.length = 0
        return
      }
      chunks.push(chunk)
    })
    message.on('end', () => resolve(overflowed ? null : Buffer.concat(chunks)))
    message.on('error', reject)
  })
}

// MARK: - Response

export interface HTTPResponse {
  status: number
  headers: Record<string, string>
  body: Buffer
}

export const Response = {
  json(status: number, object: Record<string, unknown>): HTTPResponse {
    return {
      status,
      headers: { 'Content-Type': 'application/json' },
      body: Buffer.from(JSON.stringify(object), 'utf8'),
    }
  },

  error(status: number, code: string, extra: Record<string, unknown> = {}): HTTPResponse {
    return Response.json(status, { ...extra, error: code })
  },

  empty(status: number, headers: Record<string, string> = {}): HTTPResponse {
    return { status, headers, body: Buffer.alloc(0) }
  },

  /** What every response carries, whatever asked for it. */
  finalHeaders(response: HTTPResponse): Record<string, string> {
    return {
      ...response.headers,
      'Content-Length': String(response.body.length),
      Connection: 'keep-alive',
      // A browser hitting the pairing endpoint from another origin must not be
      // silently blocked; the device handshake is the check, not CORS.
      'Access-Control-Allow-Origin': '*',
    }
  },
}
