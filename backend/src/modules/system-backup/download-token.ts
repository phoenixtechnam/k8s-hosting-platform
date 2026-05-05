/**
 * One-shot HMAC tokens for secrets-bundle download.
 *
 * Format:  `<runId>.<expiresAtMs>.<hex-sha256-mac>`
 *   runId         — uuid of the system_backup_runs row
 *   expiresAtMs   — milliseconds since epoch
 *   mac           — HMAC-SHA256(`<runId>|<expiresAtMs>`) keyed by JWT_SECRET
 *
 * Single-use enforcement is at the DB layer: the route looks up the
 * row by sha256(token), verifies expiry + null downloaded_at + the
 * stored sha256(token) matches, then atomically sets
 * downloaded_at=now() AND payload=NULL in the same UPDATE. A second
 * GET against the same token sees downloaded_at IS NOT NULL and 410s.
 *
 * Why JWT_SECRET as the HMAC key:
 *   - Already 32+ bytes of entropy in the bundle by bootstrap.
 *   - Already loaded into platform-api at process start.
 *   - Rotating JWT_SECRET invalidates old tokens AND old JWTs in
 *     lock-step — desired behaviour.
 *
 * Verification is constant-time (timingSafeEqual).
 */

import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

export interface DownloadTokenInput {
  readonly runId: string;
  readonly ttlSeconds: number;
}

export interface SignedDownloadToken {
  readonly token: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
}

function canonical(runId: string, expiresAtMs: number): string {
  return `${runId}|${expiresAtMs}`;
}

/** Sign a download token. Returns the bearer token + sha256(token) for storage. */
export function signDownloadToken(input: DownloadTokenInput, jwtSecret: string): SignedDownloadToken {
  if (!jwtSecret || jwtSecret.length < 32) {
    throw new Error('signDownloadToken: jwtSecret too short (need 32+ bytes)');
  }
  const expiresAtMs = Date.now() + input.ttlSeconds * 1000;
  const mac = createHmac('sha256', jwtSecret)
    .update(canonical(input.runId, expiresAtMs))
    .digest('hex');
  const token = `${input.runId}.${expiresAtMs}.${mac}`;
  const tokenHash = sha256Hex(token);
  return { token, tokenHash, expiresAt: new Date(expiresAtMs) };
}

export type DownloadTokenError =
  | { code: 'MALFORMED'; detail: string }
  | { code: 'EXPIRED'; detail: string }
  | { code: 'BAD_MAC'; detail: string };

export interface VerifiedDownloadToken {
  readonly runId: string;
  readonly expiresAtMs: number;
}

/**
 * Verify a token's MAC and expiry. Does NOT check the database for
 * single-use semantics — callers must combine this with a DB lookup
 * by sha256(token) and atomic mark-as-used UPDATE.
 *
 * Returns either { ok: VerifiedDownloadToken } or { err: DownloadTokenError }.
 */
export function verifyDownloadToken(
  token: string,
  jwtSecret: string,
  now: number = Date.now(),
): { ok: VerifiedDownloadToken } | { err: DownloadTokenError } {
  // Format check.
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { err: { code: 'MALFORMED', detail: 'expected 3 dot-separated parts' } };
  }
  const [runId, expiresStr, macHex] = parts;
  if (!runId || !expiresStr || !macHex) {
    return { err: { code: 'MALFORMED', detail: 'empty part' } };
  }
  const expiresAtMs = Number(expiresStr);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= 0) {
    return { err: { code: 'MALFORMED', detail: 'expires not a positive number' } };
  }
  if (!/^[0-9a-f]{64}$/.test(macHex)) {
    return { err: { code: 'MALFORMED', detail: 'mac not 64-char hex' } };
  }

  // Expiry FIRST — cheap and avoids constant-time MAC compare on stale tokens.
  if (now >= expiresAtMs) {
    return { err: { code: 'EXPIRED', detail: `expired ${now - expiresAtMs}ms ago` } };
  }

  // MAC compare in constant time.
  const expectedMac = createHmac('sha256', jwtSecret)
    .update(canonical(runId, expiresAtMs))
    .digest();
  const providedMac = Buffer.from(macHex, 'hex');
  if (providedMac.length !== expectedMac.length) {
    return { err: { code: 'BAD_MAC', detail: 'mac length mismatch' } };
  }
  if (!timingSafeEqual(providedMac, expectedMac)) {
    return { err: { code: 'BAD_MAC', detail: 'mac mismatch' } };
  }

  return { ok: { runId, expiresAtMs } };
}

/** Public: sha256(text) hex. Used by callers persisting token hashes. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
