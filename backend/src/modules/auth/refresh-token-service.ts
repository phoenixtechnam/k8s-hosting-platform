import crypto from 'node:crypto';
import { and, eq, gt, isNull, lt } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import { refreshTokens } from '../../db/schema.js';

/**
 * Refresh token service. Backs the Phase 3 split-token auth model:
 *
 *   access JWT (30 min) — stateless, signed, verified per-request
 *   refresh token (24 h) — opaque random secret, stored hashed, this module
 *
 * The DB stores sha256(refresh_token); the plaintext only exists in memory
 * during issuance and on the wire. A leak of the DB does NOT leak working
 * refresh tokens (sha256 of 256 random bits is preimage-resistant).
 *
 * Rotation: every successful `/auth/refresh` revokes the presented token
 * AND issues a new one in the same family. If a previously-rotated token
 * is seen again, the whole family is revoked (`reuse_detected`).
 */

export const REFRESH_TOKEN_TTL_SECONDS = 24 * 60 * 60; // 24h
export const ACCESS_TOKEN_TTL_SECONDS = 30 * 60;       // 30m

export type RevokedReason =
  | 'logout'
  | 'rotated'
  | 'reuse_detected'
  | 'password_change'
  | 'admin_revoke';

export interface IssueRefreshTokenInput {
  readonly userId: string;
  readonly panel: 'admin' | 'client';
  readonly clientId?: string | null;
  readonly familyId?: string;
  readonly userAgent?: string;
  readonly ipAddress?: string;
}

export interface IssuedRefreshToken {
  readonly token: string;          // plaintext — return to client, never store
  readonly tokenHash: string;
  readonly familyId: string;
  readonly id: string;
  readonly expiresAt: Date;
}

export function generateRefreshToken(): string {
  // 32 bytes = 256 bits, base64url for URL/cookie safety.
  return crypto.randomBytes(32).toString('base64url');
}

export function hashRefreshToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function issueRefreshToken(
  db: Database,
  input: IssueRefreshTokenInput,
): Promise<IssuedRefreshToken> {
  const token = generateRefreshToken();
  const tokenHash = hashRefreshToken(token);
  const id = crypto.randomUUID();
  const familyId = input.familyId ?? crypto.randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_SECONDS * 1000);

  await db.insert(refreshTokens).values({
    id,
    userId: input.userId,
    familyId,
    tokenHash,
    panel: input.panel,
    clientId: input.clientId ?? null,
    userAgent: input.userAgent?.slice(0, 500) ?? null,
    ipAddress: input.ipAddress?.slice(0, 64) ?? null,
    expiresAt,
  });

  return { token, tokenHash, familyId, id, expiresAt };
}

export interface ValidationSuccess {
  readonly ok: true;
  readonly id: string;
  readonly userId: string;
  readonly familyId: string;
  readonly panel: 'admin' | 'client';
  readonly clientId: string | null;
}
export interface ValidationFailure {
  readonly ok: false;
  readonly reason: 'not_found' | 'expired' | 'revoked' | 'reuse_detected';
}
export type ValidationResult = ValidationSuccess | ValidationFailure;

/**
 * Look up a refresh token by hash. If the token is found AND already
 * revoked with reason='rotated', this is a reuse attack (someone is
 * presenting an old token that was already replaced). Revoke the whole
 * family before refusing.
 */
export async function validateRefreshToken(
  db: Database,
  presentedToken: string,
): Promise<ValidationResult> {
  const tokenHash = hashRefreshToken(presentedToken);
  const [row] = await db
    .select()
    .from(refreshTokens)
    .where(eq(refreshTokens.tokenHash, tokenHash))
    .limit(1);

  if (!row) return { ok: false, reason: 'not_found' };

  if (row.revokedAt) {
    if (row.revokedReason === 'rotated') {
      // Reuse detection: a rotated token is being replayed. Revoke
      // every still-active token in the family — assume the leaked
      // token is being used somewhere.
      await db.update(refreshTokens).set({
        revokedAt: new Date(),
        revokedReason: 'reuse_detected',
      }).where(and(
        eq(refreshTokens.familyId, row.familyId),
        isNull(refreshTokens.revokedAt),
      ));
      return { ok: false, reason: 'reuse_detected' };
    }
    return { ok: false, reason: 'revoked' };
  }

  if (row.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: 'expired' };
  }

  return {
    ok: true,
    id: row.id,
    userId: row.userId,
    familyId: row.familyId,
    panel: row.panel,
    clientId: row.clientId,
  };
}

export async function revokeRefreshTokenById(
  db: Database,
  id: string,
  reason: RevokedReason,
): Promise<void> {
  await db.update(refreshTokens).set({
    revokedAt: new Date(),
    revokedReason: reason,
  }).where(and(
    eq(refreshTokens.id, id),
    isNull(refreshTokens.revokedAt),
  ));
}

/**
 * Revoke every active refresh token for a user. Called on password
 * change and admin-disable.
 */
export async function revokeAllUserRefreshTokens(
  db: Database,
  userId: string,
  reason: RevokedReason,
): Promise<void> {
  await db.update(refreshTokens).set({
    revokedAt: new Date(),
    revokedReason: reason,
  }).where(and(
    eq(refreshTokens.userId, userId),
    isNull(refreshTokens.revokedAt),
  ));
}

/**
 * Daily cleanup job: hard-delete tokens that expired more than 7 days
 * ago. Keeps a short forensic window after expiry for audit.
 */
export async function pruneExpiredRefreshTokens(db: Database): Promise<number> {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const result = await db.delete(refreshTokens)
    .where(lt(refreshTokens.expiresAt, cutoff));
  // Drizzle returns rowsAffected on pg via raw — keep it simple: 0 if
  // unknown, otherwise the driver-reported count. Used for log only.
  return (result as unknown as { rowCount?: number }).rowCount ?? 0;
}

/**
 * Mark a token as used (for last-used analytics / dormancy detection).
 * Non-critical: failure is silently ignored.
 */
export async function touchLastUsed(db: Database, id: string): Promise<void> {
  await db.update(refreshTokens)
    .set({ lastUsedAt: new Date() })
    .where(and(eq(refreshTokens.id, id), isNull(refreshTokens.revokedAt)))
    .catch(() => { /* best-effort */ });
}

// Re-export so tests can stub time.
export const __unsafe = { gt };
