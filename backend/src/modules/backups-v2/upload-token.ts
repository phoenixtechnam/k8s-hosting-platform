/**
 * Short-lived HMAC tokens that authorise a tenant-namespace Job to
 * upload exactly ONE component artifact for ONE bundle to the
 * internal upload endpoint on platform-api.
 *
 * Why HMAC instead of mTLS or JWT:
 *   - mTLS would need a per-Job cert + a CA — overkill for a token
 *     that lives for 30 minutes against a known server.
 *   - JWT works but requires the Job to ship a JWT verification
 *     library; HMAC-SHA256 is `openssl dgst` in the Job script.
 *   - Tokens are bound to (bundleId, component, artifactName) so
 *     they cannot be replayed against a different bundle.
 *
 * Format:  `<expiresAtUnixMs>.<hex-sha256-mac>`
 *   - expiresAtUnixMs: integer milliseconds since epoch
 *   - mac: HMAC-SHA256 over `<bundleId>|<component>|<artifactName>|<expiresAtUnixMs>`
 *     keyed by `OIDC_ENCRYPTION_KEY` (the same secret the secrets
 *     component uses; this isn't the OIDC use case but the platform
 *     already has the key).
 *
 * Verification is constant-time (crypto.timingSafeEqual).
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface UploadTokenInput {
  readonly bundleId: string;
  readonly component: 'files' | 'mailboxes' | 'config' | 'secrets';
  readonly artifactName: string;
  readonly ttlSeconds: number;
}

/** Construct the canonical message string we MAC. */
function canonical(parts: { bundleId: string; component: string; artifactName: string; expiresAtMs: number }): string {
  return `${parts.bundleId}|${parts.component}|${parts.artifactName}|${parts.expiresAtMs}`;
}

/**
 * Sign an upload token. Throws if the key is malformed.
 *
 * @param input — bundle/component/artifact + TTL
 * @param keyHex — 64-char hex (32 bytes) of HMAC key material
 */
export function signUploadToken(input: UploadTokenInput, keyHex: string): string {
  const keyBuf = Buffer.from(keyHex, 'hex');
  if (keyBuf.length !== 32) {
    throw new Error(`signUploadToken: key must be 32 bytes (got ${keyBuf.length})`);
  }
  const expiresAtMs = Date.now() + input.ttlSeconds * 1000;
  const mac = createHmac('sha256', keyBuf)
    .update(canonical({ ...input, expiresAtMs }))
    .digest('hex');
  return `${expiresAtMs}.${mac}`;
}

export interface UploadTokenError {
  readonly code: 'MALFORMED' | 'EXPIRED' | 'BAD_MAC';
  readonly detail: string;
}

/**
 * Verify an upload token against the expected (bundleId, component,
 * artifactName) tuple. Returns null on success, or a structured
 * error on failure. Uses constant-time MAC comparison.
 *
 * The caller MUST pass the bundleId/component/artifactName from the
 * URL — if the verifier accepted any tuple the token would be
 * trivially replayable. Binding to URL params is the whole point.
 */
export function verifyUploadToken(
  token: string,
  expected: { bundleId: string; component: 'files' | 'mailboxes' | 'config' | 'secrets'; artifactName: string },
  keyHex: string,
  now: number = Date.now(),
): UploadTokenError | null {
  const dot = token.indexOf('.');
  if (dot < 1) return { code: 'MALFORMED', detail: 'token missing separator' };
  const expiresStr = token.slice(0, dot);
  const macHex = token.slice(dot + 1);
  const expiresAtMs = Number(expiresStr);
  if (!Number.isFinite(expiresAtMs) || expiresAtMs < 0) {
    return { code: 'MALFORMED', detail: 'expiresAt is not a finite number' };
  }
  if (now >= expiresAtMs) {
    return { code: 'EXPIRED', detail: `token expired ${Math.floor((now - expiresAtMs) / 1000)}s ago` };
  }

  const keyBuf = Buffer.from(keyHex, 'hex');
  if (keyBuf.length !== 32) {
    return { code: 'MALFORMED', detail: 'key length mismatch (server config bug)' };
  }
  const expectedMac = createHmac('sha256', keyBuf)
    .update(canonical({
      bundleId: expected.bundleId,
      component: expected.component,
      artifactName: expected.artifactName,
      expiresAtMs,
    }))
    .digest('hex');

  // Constant-time compare. Both buffers must be the same length or
  // timingSafeEqual throws — guard with a length check first to
  // produce a stable error code instead of a 500.
  if (macHex.length !== expectedMac.length) return { code: 'BAD_MAC', detail: 'mac length mismatch' };
  const a = Buffer.from(macHex, 'hex');
  const b = Buffer.from(expectedMac, 'hex');
  if (a.length !== b.length) return { code: 'BAD_MAC', detail: 'mac decode length mismatch' };
  if (!timingSafeEqual(a, b)) return { code: 'BAD_MAC', detail: 'mac mismatch' };
  return null;
}
