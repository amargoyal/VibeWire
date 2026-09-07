import { monotonicMicros } from '../core/clock'
import { parseLadder, type QualityLadder } from '../core/config'
import { isModifierName, normalizeModifier, type ModifierName } from '../../../../shared/keyNames'

/**
 * Every control message is a JSON object with a `t` discriminator. Requests
 * that expect a reply carry `id`; the reply echoes it. PROTOCOL.md §3–§5 is
 * the prose; this file is the shape.
 */

export type MouseButton = 'left' | 'right' | 'middle'
export type GesturePhase = 'begin' | 'move' | 'end'
export type HubAction = 'keys' | 'shot' | 'copy' | 'paste' | 'lock' | 'mods'
export type ClaudeMode = 'chat' | 'code'
export type PermissionScope = 'once' | 'always'

export type SettingValue =
  | { kind: 'bool'; value: boolean }
  | { kind: 'int'; value: number }
  | { kind: 'double'; value: number }
  | { kind: 'string'; value: string }

export interface PointerEvent {
  phase: GesturePhase
  dx: number
  dy: number
  display: number | null
  /** 1…8 from the 07A tick slider; the host converts to a gain curve. */
  sensitivity: number | null
}

export type ClaudeInbound =
  | { sub: 'listSessions'; cwd: string | null }
  | { sub: 'open'; sessionId: string | null; cwd: string | null; mode: ClaudeMode }
  | { sub: 'send'; text: string }
  | { sub: 'interrupt' }
  | { sub: 'permission'; requestId: string; allow: boolean; scope: PermissionScope; message: string | null }
  /** A null path closes the live diff rather than opening one. */
  | { sub: 'diff'; path: string | null }
  | { sub: 'close' }

export type Inbound =
  | { t: 'selectDisplay'; displayIds: number[]; sideBySide: boolean }
  | { t: 'startStream'; displayIds: number[]; maxHeight: number | null; targetFps: number | null }
  | { t: 'stopStream' }
  | { t: 'setQuality'; ladder: QualityLadder; cellularCapMbps: number | null }
  | { t: 'pointer'; event: PointerEvent }
  | { t: 'click'; button: MouseButton; count: number; display: number | null }
  | { t: 'drag'; phase: GesturePhase; dx: number; dy: number; count: number }
  | { t: 'scroll'; dx: number; dy: number; momentum: boolean }
  | { t: 'zoom'; scale: number; anchorX: number; anchorY: number; locked: boolean }
  | { t: 'modifiers'; held: ModifierName[]; latched: boolean }
  | { t: 'key'; code: string; chars: string | null; down: boolean }
  | { t: 'combo'; keys: string[] }
  | { t: 'text'; value: string }
  | { t: 'hubAction'; action: HubAction }
  | { t: 'clipboardPush'; text: string }
  | { t: 'wake' }
  | { t: 'retry' }
  | { t: 'lastFrame' }
  | { t: 'claude'; claude: ClaudeInbound }
  | { t: 'revoke'; deviceId: string | null; all: boolean }
  | { t: 'setting'; key: string; value: SettingValue }
  | { t: 'ping'; tMicros: number; sequence: number; rttMillis: number | null }
  /** The phone reporting its own radio, so the cellular cap applies only when
   *  it is actually on cellular. */
  | { t: 'link'; expensive: boolean; constrained: boolean }

export class DecodeError extends Error {}

type Root = Record<string, unknown>

function str(root: Root, key: string): string | null {
  const value = root[key]
  return typeof value === 'string' ? value : null
}
function num(root: Root, key: string, fallback = 0): number {
  const value = root[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}
function optNum(root: Root, key: string): number | null {
  const value = root[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}
function bool(root: Root, key: string, fallback = false): boolean {
  const value = root[key]
  return typeof value === 'boolean' ? value : fallback
}
function requireString(root: Root, type: string, key: string): string {
  const value = str(root, key)
  if (value === null) throw new DecodeError(`${type}: missing string ${key}`)
  return value
}
function displayIds(root: Root): number[] {
  const raw = root.displayIds
  if (!Array.isArray(raw)) return []
  return raw.filter((value): value is number => typeof value === 'number').map((value) => value >>> 0)
}
function phase(root: Root): GesturePhase {
  const raw = root.phase
  return raw === 'begin' || raw === 'end' ? raw : 'move'
}

export function decodeInbound(text: string): { id: string | null; message: Inbound } {
  let root: unknown
  try {
    root = JSON.parse(text)
  } catch {
    throw new DecodeError('not JSON')
  }
  if (!root || typeof root !== 'object' || Array.isArray(root)) throw new DecodeError('missing discriminator')
  const record = root as Root
  const type = str(record, 't')
  if (type === null) throw new DecodeError('missing discriminator')
  const id = str(record, 'id')

  let message: Inbound
  switch (type) {
    case 'selectDisplay':
      message = { t: type, displayIds: displayIds(record), sideBySide: record.mode === 'sideBySide' }
      break
    case 'startStream':
      message = {
        t: type,
        displayIds: displayIds(record),
        maxHeight: optNum(record, 'maxHeight'),
        targetFps: optNum(record, 'targetFps'),
      }
      break
    case 'stopStream':
      message = { t: type }
      break
    case 'setQuality':
      message = { t: type, ladder: parseLadder(record.ladder), cellularCapMbps: optNum(record, 'cellularCapMbps') }
      break
    case 'pointer':
      message = {
        t: type,
        event: {
          phase: phase(record),
          dx: num(record, 'dx'),
          dy: num(record, 'dy'),
          display: optNum(record, 'display'),
          sensitivity: optNum(record, 'sensitivity'),
        },
      }
      break
    case 'click': {
      const raw = record.button
      const button: MouseButton = raw === 'right' || raw === 'middle' ? raw : 'left'
      message = { t: type, button, count: optNum(record, 'count') ?? 1, display: optNum(record, 'display') }
      break
    }
    case 'drag':
      // `count` is additive and optional: a client that never sends it drags
      // on a single click, which is what every version-1 client did.
      message = { t: type, phase: phase(record), dx: num(record, 'dx'), dy: num(record, 'dy'), count: optNum(record, 'count') ?? 1 }
      break
    case 'scroll':
      message = { t: type, dx: num(record, 'dx'), dy: num(record, 'dy'), momentum: bool(record, 'momentum') }
      break
    case 'zoom':
      message = {
        t: type,
        scale: num(record, 'scale', 1),
        anchorX: num(record, 'anchorX', 0.5),
        anchorY: num(record, 'anchorY', 0.5),
        locked: bool(record, 'locked'),
      }
      break
    case 'modifiers': {
      const raw = Array.isArray(record.held) ? record.held : []
      const held = raw
        .filter((value): value is string => typeof value === 'string')
        .map(normalizeModifier)
        .filter(isModifierName)
      message = { t: type, held: [...new Set(held)], latched: bool(record, 'latched', true) }
      break
    }
    case 'key':
      message = { t: type, code: requireString(record, type, 'code'), chars: str(record, 'chars'), down: bool(record, 'down', true) }
      break
    case 'combo': {
      const keys = record.keys
      if (!Array.isArray(keys)) throw new DecodeError('combo: missing keys')
      message = { t: type, keys: keys.filter((value): value is string => typeof value === 'string') }
      break
    }
    case 'text':
      message = { t: type, value: requireString(record, type, 'value') }
      break
    case 'hubAction': {
      const raw = record.action
      if (raw !== 'keys' && raw !== 'shot' && raw !== 'copy' && raw !== 'paste' && raw !== 'lock' && raw !== 'mods') {
        throw new DecodeError('hubAction: bad action')
      }
      message = { t: type, action: raw }
      break
    }
    case 'clipboardPush':
      message = { t: type, text: requireString(record, type, 'text') }
      break
    case 'wake':
    case 'retry':
    case 'lastFrame':
      message = { t: type }
      break
    case 'claude':
      message = { t: type, claude: decodeClaude(record) }
      break
    case 'revoke':
      message = { t: type, deviceId: str(record, 'deviceId'), all: bool(record, 'all') }
      break
    case 'setting': {
      const key = requireString(record, type, 'key')
      const raw = record.value
      let value: SettingValue
      if (typeof raw === 'boolean') value = { kind: 'bool', value: raw }
      else if (typeof raw === 'number' && Number.isFinite(raw)) {
        // Ints and doubles arrive indistinguishably from JSON; keep both.
        value = Number.isInteger(raw) ? { kind: 'int', value: raw } : { kind: 'double', value: raw }
      } else if (typeof raw === 'string') value = { kind: 'string', value: raw }
      else throw new DecodeError('setting: unsupported value')
      message = { t: type, key, value }
      break
    }
    case 'ping':
      message = {
        t: type,
        tMicros: num(record, 'tMicros'),
        sequence: num(record, 'seq'),
        // The phone reports the round trip it measured on its own clock for
        // the previous ping; the host cannot compute it.
        rttMillis: optNum(record, 'rttMillis'),
      }
      break
    case 'link':
      message = { t: type, expensive: bool(record, 'expensive'), constrained: bool(record, 'constrained') }
      break
    default:
      throw new DecodeError(`unknown type ${type}`)
  }
  return { id, message }
}

function decodeClaude(root: Root): ClaudeInbound {
  const sub = str(root, 'sub')
  if (sub === null) throw new DecodeError('claude: missing sub')
  switch (sub) {
    case 'listSessions':
      return { sub, cwd: str(root, 'cwd') }
    case 'open':
      return { sub, sessionId: str(root, 'sessionId'), cwd: str(root, 'cwd'), mode: root.mode === 'chat' ? 'chat' : 'code' }
    case 'send':
      return { sub, text: requireString(root, 'claude.send', 'text') }
    case 'interrupt':
      return { sub }
    case 'permission': {
      const requestId = str(root, 'requestId')
      const behavior = str(root, 'behavior')
      if (requestId === null || behavior === null) throw new DecodeError('claude.permission: missing fields')
      return {
        sub,
        requestId,
        allow: behavior === 'allow',
        scope: root.scope === 'always' ? 'always' : 'once',
        message: str(root, 'message'),
      }
    }
    case 'diff':
      return { sub, path: str(root, 'path') }
    case 'close':
      return { sub }
    default:
      throw new DecodeError(`unknown type claude.${sub}`)
  }
}

// MARK: - Host → phone

export type Payload = Record<string, unknown>

export interface HelloFields {
  hostId: string
  hostName: string
  model: string
  os: string
  osBuild: string | null
  platform: 'macos' | 'windows'
  version: string
  protocol: number
  capabilities: Record<string, boolean>
  conditions: Record<string, boolean>
}

/**
 * Outbound messages are loose objects rather than a giant tagged type. The
 * shapes are documented in PROTOCOL.md and every construction site goes
 * through one of these factories, so the wire stays consistent.
 */
export const Outbound = {
  hello(fields: HelloFields): Payload {
    const payload: Payload = {
      t: 'hello',
      hostId: fields.hostId,
      hostName: fields.hostName,
      model: fields.model,
      os: fields.os,
      version: fields.version,
      protocol: fields.protocol,
      capabilities: fields.capabilities,
      // Additive, still protocol 1: a client that never reads these behaves as
      // it did against a Mac host that never sent them.
      platform: fields.platform,
      conditions: fields.conditions,
    }
    if (fields.osBuild) payload.osBuild = fields.osBuild
    return payload
  },

  error(code: string, message: string, retriable = false, id: string | null = null): Payload {
    const payload: Payload = { t: 'error', code, message, retriable }
    if (id) payload.id = id
    return payload
  },

  ack(id: string): Payload {
    return { t: 'ack', id }
  },

  pong(tMicros: number): Payload {
    return { t: 'pong', tMicros, hostMicros: monotonicMicros() }
  },
}
