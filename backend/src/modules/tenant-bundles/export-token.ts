/**
 * Stateless signed token that authorises ONE export download.
 *
 * Why this exists:
 *   The export endpoint takes a password that the caller wants
 *   protected (HTTPS body). For the browser to show its native
 *   save-file dialog we need the actual download to be a `GET`
 *   triggered by `window.location` — which can't carry a request
 *   body or a Bearer header. So:
 *
 *     1. Client POSTs `/admin/tenant-bundles/:id/export-token` with
 *        { format, password? } — server returns a `downloadUrl`
 *        carrying a signed token.
 *     2. Client sets `window.location = downloadUrl`. Browser
 *        opens the save-file dialog the moment the response
 *        starts streaming.
 *
 * Token format:
 *   `<base64url(payload-json)>.<base64url(hmac-sha256-of-payload)>`
 *
 * Payload JSON schema:
 *   {
 *     v: 1,                        // version (bump on schema change)
 *     b: bundleId,
 *     f: 'tar' | 'zip',
 *     p: { iv, tag, ct } | null,   // password ciphertext (AES-256-GCM)
 *     e: expiresAtUnixMs,
 *     n: nonceHex                  // randomness so identical (b,f,e,p)
 *                                   // doesn't produce identical tokens
 *   }
 *
 * Encryption key: the same `OIDC_ENCRYPTION_KEY` the upload-token
 * module uses. Symmetric. The password ciphertext is decrypted
 * server-side at the GET handler — the password never leaves the
 * cluster in plaintext (the URL only carries ciphertext).
 *
 * Why not single-use:
 *   Single-use enforcement requires a DB write (token table) or a
 *   shared in-memory store; both would prevent a 3-replica
 *   platform-api from working without a sticky session. 5-min TTL
 *   is the trade-off — the same operator clicking Download again
 *   gets a fresh token. The token is bound to a single bundleId
 *   so even a leaked one can't access other bundles.
 *
 * Why not JWT:
 *   JWT adds a dependency, header overhead, and the only field we
 *   care about (`b/f/p/e`) wouldn't fit cleanly into stock claim
 *   names. Raw HMAC is shorter and easier to reason about.
 */

import { createHmac, randomBytes, timingSafeEqual, createCipheriv, createDecipheriv } from 'node:crypto';

const VERSION = 1 as const;
const ALGO = 'aes-256-gcm' as const;
const TOKEN_TTL_SECONDS = 5 * 60;

export type ExportTokenFormat = 'tar' | 'zip';

interface PasswordEnvelope {
  readonly iv: string;  // base64url
  readonly tag: string; // base64url
  readonly ct: string;  // base64url ciphertext
}

interface TokenPayload {
  readonly v: typeof VERSION;
  readonly b: string;                  // bundleId
  readonly f: ExportTokenFormat;
  readonly p: PasswordEnvelope | null;
  readonly e: number;                  // expiresAt unix ms
  readonly n: string;                  // nonce hex
}

export interface SignExportTokenInput {
  readonly bundleId: string;
  readonly format: ExportTokenFormat;
  /** Operator-supplied password. `undefined` / empty string = plaintext download. */
  readonly password?: string;
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function keyBufFromHex(keyHex: string): Buffer {
  const k = Buffer.from(keyHex, 'hex');
  if (k.length !== 32) throw new Error(`exportToken: key must be 32 bytes (got ${k.length})`);
  return k;
}

function encryptPassword(password: string, key: Buffer): PasswordEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(password, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { iv: b64url(iv), tag: b64url(tag), ct: b64url(ct) };
}

function decryptPassword(env: PasswordEnvelope, key: Buffer): string {
  const decipher = createDecipheriv(ALGO, key, fromB64url(env.iv));
  decipher.setAuthTag(fromB64url(env.tag));
  return Buffer.concat([
    decipher.update(fromB64url(env.ct)),
    decipher.final(),
  ]).toString('utf8');
}

/**
 * Build a signed export token. Throws on bad key or invalid format.
 * `ttlSeconds` defaults to 5 minutes.
 */
export function signExportToken(
  input: SignExportTokenInput,
  keyHex: string,
  ttlSeconds: number = TOKEN_TTL_SECONDS,
): string {
  const key = keyBufFromHex(keyHex);
  const password = input.password ?? '';
  const payload: TokenPayload = {
    v: VERSION,
    b: input.bundleId,
    f: input.format,
    p: password.length > 0 ? encryptPassword(password, key) : null,
    e: Date.now() + ttlSeconds * 1000,
    n: randomBytes(8).toString('hex'),
  };
  const payloadB64 = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const mac = createHmac('sha256', key).update(payloadB64).digest();
  return `${payloadB64}.${b64url(mac)}`;
}

export type ExportTokenError =
  | { readonly code: 'MALFORMED'; readonly detail: string }
  | { readonly code: 'BAD_MAC' }
  | { readonly code: 'EXPIRED' }
  | { readonly code: 'BAD_VERSION' }
  | { readonly code: 'BAD_BUNDLE' };

export interface VerifiedExportToken {
  readonly bundleId: string;
  readonly format: ExportTokenFormat;
  /** Plaintext password (decrypted on demand), or null when the
   *  token was signed without a password. */
  readonly password: string | null;
  readonly expiresAtMs: number;
}

/**
 * Verify a token. Returns either an error object or a decoded
 * payload with the password decrypted.
 *
 * `expectedBundleId` MUST come from the URL `:id` parameter — this
 * binds the token to one bundle so an operator who copy-pastes a
 * token URL across bundles can't accidentally download a different
 * bundle.
 */
export function verifyExportToken(
  token: string,
  expectedBundleId: string,
  keyHex: string,
  now: number = Date.now(),
): { ok: true; value: VerifiedExportToken } | { ok: false; error: ExportTokenError } {
  const key = keyBufFromHex(keyHex);
  const dot = token.indexOf('.');
  if (dot < 1) return { ok: false, error: { code: 'MALFORMED', detail: 'no separator' } };
  const payloadB64 = token.slice(0, dot);
  const macB64 = token.slice(dot + 1);
  const macActualBuf = createHmac('sha256', key).update(payloadB64).digest();
  let macClaimedBuf: Buffer;
  try {
    macClaimedBuf = fromB64url(macB64);
  } catch {
    return { ok: false, error: { code: 'MALFORMED', detail: 'mac not base64url' } };
  }
  if (macClaimedBuf.length !== macActualBuf.length) {
    return { ok: false, error: { code: 'BAD_MAC' } };
  }
  if (!timingSafeEqual(macClaimedBuf, macActualBuf)) {
    return { ok: false, error: { code: 'BAD_MAC' } };
  }
  let payload: TokenPayload;
  try {
    payload = JSON.parse(fromB64url(payloadB64).toString('utf8')) as TokenPayload;
  } catch {
    return { ok: false, error: { code: 'MALFORMED', detail: 'payload not json' } };
  }
  // Structural validation: the MAC has been verified, so the contents
  // are authentic, but the JSON shape is still untyped at this point.
  // Reject anything that doesn't match the expected schema before
  // handing it to downstream code.
  if (payload.v !== VERSION) return { ok: false, error: { code: 'BAD_VERSION' } };
  if (typeof payload.b !== 'string' || payload.b.length === 0) {
    return { ok: false, error: { code: 'MALFORMED', detail: 'b not string' } };
  }
  if (payload.f !== 'tar' && payload.f !== 'zip') {
    return { ok: false, error: { code: 'MALFORMED', detail: 'f not in {tar,zip}' } };
  }
  if (typeof payload.e !== 'number' || !Number.isFinite(payload.e)) {
    return { ok: false, error: { code: 'MALFORMED', detail: 'e not finite number' } };
  }
  if (payload.b !== expectedBundleId) return { ok: false, error: { code: 'BAD_BUNDLE' } };
  if (payload.e < now) return { ok: false, error: { code: 'EXPIRED' } };
  let password: string | null = null;
  if (payload.p) {
    try {
      password = decryptPassword(payload.p, key);
    } catch {
      return { ok: false, error: { code: 'MALFORMED', detail: 'password decrypt failed' } };
    }
  }
  return {
    ok: true,
    value: {
      bundleId: payload.b,
      format: payload.f,
      password,
      expiresAtMs: payload.e,
    },
  };
}
