/**
 * The frame codec lives in `shared/frame.ts` now, beside the host that encodes
 * it, so the two ends of the socket cannot disagree by a byte. This module keeps
 * the import path the rest of the client already uses.
 */
export * from '../../../shared/frame'
