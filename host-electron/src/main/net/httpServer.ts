import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { WebSocketServer, type WebSocket } from 'ws'
import { Log, describeError } from '../core/log'
import type { TrustedDevice } from '../pairing/trustStore'
import { parseTarget, readBody, Response, type HTTPRequest, type HTTPResponse } from './request'
import { SocketConnection } from './socketConnection'
import type { Payload } from './wireProtocol'

/**
 * Routes HTTP requests and owns what happens after a socket upgrade.
 * Implemented by `HostRouter`; kept as an interface so the networking layer
 * has no opinion about pairing, capture, or Claude.
 */
export interface Router {
  handle(request: HTTPRequest): Promise<HTTPResponse>
  /** The authenticated device, or null to reject the upgrade. */
  authenticateUpgrade(request: HTTPRequest): Promise<TrustedDevice | null>
  socketOpened(socket: SocketConnection, device: TrustedDevice): Promise<void>
  socketClosed(socket: SocketConnection): Promise<void>
  socketReceived(socket: SocketConnection, text: string): Promise<void>
}

export class HostError extends Error {}

/**
 * Serves HTTP and WebSocket on one port so a single tunnel origin covers the
 * whole protocol. Bound to every interface: on Windows the Tailscale adapter
 * is an ordinary adapter, so none of the Mac host's forwarder is needed.
 */
export class HTTPServer {
  private server: Server | null = null
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false })
  private readonly sockets = new Set<SocketConnection>()

  /** Called when the listener dies after a successful `start()`. */
  onFatal: ((detail: string) => void) | null = null

  constructor(
    readonly port: number,
    private readonly router: Router,
  ) {}

  async start(): Promise<void> {
    const server = createServer({ keepAliveTimeout: 15_000 }, (request, response) => {
      void this.handleRequest(request, response)
    })
    server.on('upgrade', (request, socket, head) => {
      void this.handleUpgrade(request, socket, head)
    })
    server.on('error', (error) => {
      Log.error('net', `listener failed: ${describeError(error)}`)
      this.onFatal?.(describeError(error))
    })
    this.server = server

    try {
      await this.listen(server, '::')
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'EAFNOSUPPORT' && code !== 'EADDRNOTAVAIL') throw error
      await this.listen(server, '0.0.0.0')
    }
    Log.info('net', `listening on port ${this.port}`)
  }

  private listen(server: Server, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException) => {
        server.off('listening', onListening)
        if (error.code === 'EADDRINUSE') {
          reject(new HostError(`port ${this.port} is already in use`))
        } else {
          reject(error)
        }
      }
      const onListening = () => {
        server.off('error', onError)
        resolve()
      }
      server.once('error', onError)
      server.once('listening', onListening)
      server.listen({ host, port: this.port, ipv6Only: false })
    })
  }

  stop(): void {
    for (const socket of this.sockets) socket.close(1001, 'host shutting down')
    this.sockets.clear()
    this.wss.close()
    this.server?.close()
    this.server = null
  }

  // MARK: HTTP

  private async handleRequest(incoming: IncomingMessage, response: ServerResponse): Promise<void> {
    const request = await this.parse(incoming)
    let reply: HTTPResponse
    if (request === null) {
      reply = Response.error(413, 'body_too_large')
    } else {
      try {
        reply = await this.router.handle(request)
      } catch (error) {
        Log.error('net', `handler threw: ${describeError(error)}`)
        reply = Response.error(500, 'internal')
      }
    }
    response.writeHead(reply.status, Response.finalHeaders(reply))
    response.end(reply.body)
  }

  private async parse(incoming: IncomingMessage, withBody = true): Promise<HTTPRequest | null> {
    const { path, query } = parseTarget(incoming.url ?? '/')
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries(incoming.headers)) {
      if (value === undefined) continue
      headers[key.toLowerCase()] = Array.isArray(value) ? value.join(', ') : value
    }
    const body = withBody ? await readBody(incoming) : Buffer.alloc(0)
    if (body === null) return null
    return { method: incoming.method ?? 'GET', path, query, headers, body }
  }

  // MARK: WebSocket

  private async handleUpgrade(incoming: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const request = await this.parse(incoming, false)
    const upgrade = (request?.headers.upgrade ?? '').toLowerCase()
    if (!request || request.path !== '/v1/socket' || upgrade !== 'websocket') {
      this.refuse(socket, 404, 'not_found')
      return
    }

    const device = await this.router.authenticateUpgrade(request)
    if (!device) {
      // Fail closed, and do not hint at which part was wrong. Close only once
      // the response has gone out, otherwise the phone sees a dropped
      // connection instead of a 401 and cannot tell "not trusted" from
      // "host unreachable".
      this.refuse(socket, 401, 'unauthorized')
      return
    }

    this.wss.handleUpgrade(incoming, socket, head, (ws) => {
      void this.accept(ws, device)
    })
  }

  private refuse(socket: Duplex, status: number, code: string): void {
    const body = JSON.stringify({ error: code })
    const reason = status === 401 ? 'Unauthorized' : 'Not Found'
    socket.end(
      `HTTP/1.1 ${status} ${reason}\r\n` +
        'Content-Type: application/json\r\n' +
        `Content-Length: ${Buffer.byteLength(body)}\r\n` +
        'Access-Control-Allow-Origin: *\r\n' +
        'Connection: close\r\n\r\n' +
        body,
    )
  }

  private async accept(ws: WebSocket, device: TrustedDevice): Promise<void> {
    const connection = new SocketConnection(ws, device.id, device.name)
    this.sockets.add(connection)

    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        // The phone has no reason to send binary; ignore rather than drop the
        // connection, so a future protocol addition is additive.
        Log.debug('net', 'ignoring unexpected binary frame')
        return
      }
      void this.router.socketReceived(connection, data.toString())
    })
    ws.on('pong', () => connection.notePong())
    ws.on('error', (error) => Log.debug('net', `socket error: ${error.message}`))
    ws.on('close', () => {
      connection.markClosed()
      this.sockets.delete(connection)
      void this.router.socketClosed(connection)
    })

    await this.router.socketOpened(connection, device)
    Log.info('net', `socket open: ${device.name}`)
  }

  // MARK: Broadcast helpers

  broadcast(message: Payload): void {
    for (const socket of this.sockets) socket.sendJSON(message)
  }

  broadcastBinary(data: Uint8Array): void {
    for (const socket of this.sockets) socket.sendBinary(data)
  }

  /** Used by revoke (07B): "Any live session from that iPad ends inside 1s." */
  severSockets(deviceIds: Set<string>): void {
    for (const socket of this.sockets) {
      if (deviceIds.has(socket.deviceId)) socket.close(4003, 'device revoked')
    }
  }

  get connectedDeviceIds(): Set<string> {
    return new Set([...this.sockets].map((socket) => socket.deviceId))
  }
}
