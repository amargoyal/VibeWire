import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto'
import {
  AUTH_CONTEXT,
  MAX_PAIR_ATTEMPTS,
  NONCE_LIFETIME_S,
  PAIR_CODE_LIFETIME_S,
  PAIR_LOCKOUT_S,
} from '../../../../shared/protocol'
import { Log, describeError } from '../core/log'
import { isValidPublicKey, strictBase64, verifySignature } from './ed25519'
import { TrustStore, type TrustedDevice } from './trustStore'

export interface ActiveCode {
  value: string
  issuedAt: number
  expiresAt: number
}

/**
 * How far a handshake has actually got: the code was accepted, the key was a
 * well-formed Ed25519 public key, the trust record was written, and a socket
 * authenticated with that device's key. The dashboard draws these as steps.
 */
export interface PairingProgress {
  codeAcceptedAt: number | null
  keysExchangedAt: number | null
  trustStoredAt: number | null
  socketOpenedAt: number | null
  deviceId: string | null
  deviceName: string | null
  /** Why the handshake stopped, when it stopped after the code was taken. */
  failure: string | null
}

function freshProgress(): PairingProgress {
  return {
    codeAcceptedAt: null,
    keysExchangedAt: null,
    trustStoredAt: null,
    socketOpenedAt: null,
    deviceId: null,
    deviceName: null,
    failure: null,
  }
}

export function progressStep(progress: PairingProgress): number {
  let reached = 0
  if (progress.codeAcceptedAt !== null) reached = 1
  if (progress.keysExchangedAt !== null) reached = 2
  if (progress.trustStoredAt !== null) reached = 3
  if (progress.socketOpenedAt !== null) reached = 4
  return reached
}

export function progressWire(progress: PairingProgress): Record<string, unknown> {
  const payload: Record<string, unknown> = { step: progressStep(progress) }
  if (progress.deviceId) payload.deviceId = progress.deviceId
  if (progress.deviceName) payload.deviceName = progress.deviceName
  if (progress.failure) payload.failure = progress.failure
  return payload
}

export type PairFailure = 'notPairing' | 'codeExpired' | 'badCode' | 'lockedOut' | 'badPublicKey'

export class PairError extends Error {
  constructor(
    readonly reason: PairFailure,
    readonly retryAfter = 0,
  ) {
    super(reason)
  }
}

export interface PairResult {
  device: TrustedDevice
  hostPublicKey: Buffer
  hostId: string
  hostName: string
}

export interface PairingOptions {
  /** The name this host reports in the pair response. */
  hostName: () => string
  /** Injectable for tests; wall-clock milliseconds. */
  now?: () => number
}

/**
 * Owns the six-digit code shown at the host and the challenge/response the
 * phone uses on every reconnect.
 *
 * - The code only exists while the pairing window is open. There is no
 *   ambient always-valid code sitting on the port.
 * - Code comparison is constant time; a timing oracle on six digits is worth
 *   closing when the endpoint may be tunnel-facing.
 * - Nonces are single-use. Replaying a captured signature does not reconnect.
 */
export class PairingService {
  private active: ActiveCode | null = null
  private failedAttempts = 0
  private lockedUntil: number | null = null
  private nonces = new Map<string, number>()
  private progress = freshProgress()
  /** A name typed at the host before showing the code; wins over the name the
   *  device reports about itself. */
  private assignedName: string | null = null
  /** Whether a successful pair consumes the window. Off by default: a code
   *  that survives being used can pair a second device nobody asked for. */
  private reusable = false
  private readonly now: () => number

  onCodeChange: ((code: ActiveCode | null) => void) | null = null

  constructor(
    private readonly trust: TrustStore,
    private readonly options: PairingOptions,
  ) {
    this.now = options.now ?? (() => Date.now())
  }

  // MARK: Code lifecycle

  beginPairing(name: string | null = null, reusable = false): ActiveCode {
    const issuedAt = this.now()
    const active: ActiveCode = {
      value: PairingService.generateCode(),
      issuedAt,
      expiresAt: issuedAt + PAIR_CODE_LIFETIME_S * 1000,
    }
    this.active = active
    this.failedAttempts = 0
    this.lockedUntil = null
    this.progress = freshProgress()
    const trimmed = name?.trim() ?? ''
    this.assignedName = trimmed ? trimmed : null
    this.reusable = reusable
    this.onCodeChange?.(active)
    Log.info('net', `pairing window open, code rotates in ${PAIR_CODE_LIFETIME_S}s${reusable ? ' (reusable)' : ''}`)
    return active
  }

  endPairing(): void {
    if (this.active === null && progressStep(this.progress) === 0) return
    this.active = null
    this.progress = freshProgress()
    this.assignedName = null
    this.reusable = false
    this.onCodeChange?.(null)
    Log.info('net', 'pairing window closed')
  }

  currentProgress(): PairingProgress {
    return { ...this.progress }
  }

  /** Whether a code is on screen right now — the same question as "would a
   *  `POST /v1/pair` be entertained at all". */
  get isPairing(): boolean {
    return this.active !== null
  }

  get isReusable(): boolean {
    return this.reusable
  }

  get pendingName(): string | null {
    return this.assignedName
  }

  /** The fourth step, and only for the device this window just paired. */
  noteSocketOpened(deviceId: string): void {
    if (this.progress.deviceId !== deviceId || this.progress.socketOpenedAt !== null) return
    this.progress.socketOpenedAt = this.now()
    Log.info('net', `handshake complete for ${deviceId}: socket open`)
  }

  currentCode(): ActiveCode | null {
    if (!this.active || this.now() >= this.active.expiresAt) return null
    return this.active
  }

  secondsRemaining(code: ActiveCode): number {
    return Math.max(0, Math.round((code.expiresAt - this.now()) / 1000))
  }

  /** Seconds until the host will accept a code again, or null if it does now. */
  get lockoutRemaining(): number | null {
    if (this.lockedUntil === null || this.now() >= this.lockedUntil) return null
    return Math.max(0, Math.round((this.lockedUntil - this.now()) / 1000))
  }

  /** Called on a timer while the window is open. The mode and the typed name
   *  carry across, because a rotation is the same pairing attempt with fresh
   *  digits, not a new one. */
  rotateIfNeeded(): void {
    if (!this.active) return
    if (this.now() < this.active.expiresAt) return
    this.beginPairing(this.assignedName, this.reusable)
  }

  private static generateCode(): string {
    // `randomInt` is uniform over the range, so no modulo bias to correct.
    return String(randomInt(0, 1_000_000)).padStart(6, '0')
  }

  // MARK: Pair request

  async pair(code: string, deviceName: string, deviceKind: string, publicKey: Buffer): Promise<PairResult> {
    if (this.lockedUntil !== null && this.now() < this.lockedUntil) {
      throw new PairError('lockedOut', Math.round((this.lockedUntil - this.now()) / 1000))
    }
    const active = this.active
    if (!active) throw new PairError('notPairing')
    if (this.now() >= active.expiresAt) throw new PairError('codeExpired')

    if (!PairingService.constantTimeEqual(code, active.value)) {
      this.failedAttempts += 1
      if (this.failedAttempts >= MAX_PAIR_ATTEMPTS) {
        this.lockedUntil = this.now() + PAIR_LOCKOUT_S * 1000
        this.failedAttempts = 0
        Log.warn('net', `pairing locked out after ${MAX_PAIR_ATTEMPTS} bad codes`)
        throw new PairError('lockedOut', PAIR_LOCKOUT_S)
      }
      throw new PairError('badCode')
    }
    this.progress.codeAcceptedAt = this.now()

    if (!isValidPublicKey(publicKey)) throw new PairError('badPublicKey')
    this.progress.keysExchangedAt = this.now()

    // The name typed at the host wins, then the one the device reports about
    // itself, then a last resort that is at least not empty.
    const resolvedName = this.assignedName ?? (deviceName ? deviceName : null) ?? 'Device'
    const device: TrustedDevice = {
      id: TrustStore.newDeviceId(),
      name: resolvedName,
      kind: deviceKind,
      publicKey: Buffer.from(publicKey),
      pairedAt: new Date(this.now()),
      lastSeenAt: new Date(this.now()),
    }
    try {
      await this.trust.add(device)
    } catch (error) {
      // Named on the way past rather than swallowed. The step list is the only
      // place this is visible: the phone gets a 503, and the person holding it
      // is usually not the person at the host.
      this.progress.failure = 'The secret store would not hold the trust record.'
      Log.error('net', `pairing accepted the code but could not store trust: ${describeError(error)}`)
      throw error
    }
    this.progress.trustStoredAt = this.now()
    this.progress.deviceId = device.id
    this.progress.deviceName = device.name

    const identity = await this.trust.hostIdentity()
    const hostId = await this.trust.hostId()

    // A successful pair consumes the window unless the operator asked for a
    // reusable one. The progress record survives either way — it is what the
    // step list draws.
    if (!this.reusable) {
      this.active = null
      this.onCodeChange?.(null)
      Log.info('net', 'pairing window closed (code spent)')
    } else {
      // A reusable code has to forget the name it was given, or the second
      // device to take it inherits the first one's label.
      this.assignedName = null
    }

    return { device, hostPublicKey: identity.publicKey, hostId, hostName: this.options.hostName() }
  }

  private static constantTimeEqual(lhs: string, rhs: string): boolean {
    const a = Buffer.from(lhs, 'utf8')
    const b = Buffer.from(rhs, 'utf8')
    if (a.length !== b.length) return false
    return timingSafeEqual(a, b)
  }

  // MARK: Challenge / response

  issueNonce(): string {
    this.pruneNonces()
    const nonce = randomBytes(32).toString('base64')
    this.nonces.set(nonce, this.now())
    return nonce
  }

  /** Verifies an Ed25519 signature over `"vibewire-auth-v1" || nonce` and burns
   *  the nonce so the same signature cannot be replayed. */
  async verify(deviceId: string, nonce: string, signature: Buffer): Promise<TrustedDevice | null> {
    this.pruneNonces()
    const issued = this.nonces.get(nonce)
    if (issued === undefined) {
      Log.warn('net', 'auth rejected: unknown or reused nonce')
      return null
    }
    if (this.now() - issued > NONCE_LIFETIME_S * 1000) {
      this.nonces.delete(nonce)
      Log.warn('net', 'auth rejected: expired nonce')
      return null
    }
    let known: TrustedDevice | null
    try {
      known = await this.trust.device(deviceId)
    } catch (error) {
      // Not the same thing as an untrusted phone, and it must not read like one
      // in the log: the store could not answer at all.
      Log.error('net', `auth deferred: trust store unavailable (${describeError(error)})`)
      return null
    }
    if (!known) {
      Log.warn('net', `auth rejected: unknown device ${deviceId}`)
      return null
    }
    const nonceBytes = strictBase64(nonce)
    if (!nonceBytes) return null

    const payload = Buffer.concat([Buffer.from(AUTH_CONTEXT, 'utf8'), nonceBytes])
    if (!verifySignature(known.publicKey, payload, signature)) {
      Log.warn('net', `auth rejected: bad signature from ${deviceId}`)
      return null
    }

    this.nonces.delete(nonce)
    await this.trust.touch(deviceId)
    return known
  }

  private pruneNonces(): void {
    const cutoff = this.now() - NONCE_LIFETIME_S * 1000
    for (const [nonce, issued] of this.nonces) {
      if (issued <= cutoff) this.nonces.delete(nonce)
    }
  }
}
