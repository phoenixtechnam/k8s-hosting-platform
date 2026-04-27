import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { getTestDb, runMigrations, isDbAvailable } from '../../test-helpers/db.js';
import { users, refreshTokens } from '../../db/schema.js';
import {
  issueRefreshToken,
  validateRefreshToken,
  revokeRefreshTokenById,
  revokeAllUserRefreshTokens,
  pruneExpiredRefreshTokens,
  hashRefreshToken,
  generateRefreshToken,
  REFRESH_TOKEN_TTL_SECONDS,
} from './refresh-token-service.js';

const skipIntegration = !await isDbAvailable();

describe.skipIf(skipIntegration)('refresh-token-service (integration)', () => {
  const userId = `u-${crypto.randomUUID()}`;
  let db: ReturnType<typeof getTestDb>;

  beforeAll(async () => {
    await runMigrations();
    db = getTestDb();
    // Insert the user row this suite operates on.
    await db.insert(users).values({
      id: userId,
      email: `${userId}@test.local`,
      passwordHash: 'unused',
      fullName: 'Test User',
      roleName: 'admin',
      panel: 'admin',
      status: 'active',
    });
  });

  afterAll(async () => {
    // Cascade-deletes refresh_tokens via FK.
    await db.delete(users).where(eq(users.id, userId));
  });

  beforeEach(async () => {
    await db.delete(refreshTokens).where(eq(refreshTokens.userId, userId));
  });

  describe('issueRefreshToken', () => {
    it('returns a plaintext token + stores only the hash', async () => {
      const issued = await issueRefreshToken(db, { userId, panel: 'admin' });
      expect(issued.token).toMatch(/^[A-Za-z0-9_-]+$/); // base64url
      expect(issued.tokenHash).toMatch(/^[a-f0-9]{64}$/); // sha256 hex
      expect(issued.tokenHash).toBe(hashRefreshToken(issued.token));

      const [row] = await db.select().from(refreshTokens).where(eq(refreshTokens.id, issued.id));
      expect(row.tokenHash).toBe(issued.tokenHash);
      // The plaintext token MUST NOT be persisted.
      expect(JSON.stringify(row)).not.toContain(issued.token);
    });

    it('sets expiresAt to ~24h ahead', async () => {
      const issued = await issueRefreshToken(db, { userId, panel: 'admin' });
      const ttl = (issued.expiresAt.getTime() - Date.now()) / 1000;
      expect(ttl).toBeGreaterThan(REFRESH_TOKEN_TTL_SECONDS - 5);
      expect(ttl).toBeLessThanOrEqual(REFRESH_TOKEN_TTL_SECONDS);
    });

    it('starts a new family by default', async () => {
      const a = await issueRefreshToken(db, { userId, panel: 'admin' });
      const b = await issueRefreshToken(db, { userId, panel: 'admin' });
      expect(a.familyId).not.toBe(b.familyId);
    });

    it('keeps family_id when provided (rotation)', async () => {
      const a = await issueRefreshToken(db, { userId, panel: 'admin' });
      const b = await issueRefreshToken(db, { userId, panel: 'admin', familyId: a.familyId });
      expect(b.familyId).toBe(a.familyId);
    });
  });

  describe('validateRefreshToken', () => {
    it('returns ok for a fresh token', async () => {
      const issued = await issueRefreshToken(db, { userId, panel: 'admin' });
      const r = await validateRefreshToken(db, issued.token);
      expect(r.ok).toBe(true);
      if (r.ok) {
        expect(r.userId).toBe(userId);
        expect(r.id).toBe(issued.id);
      }
    });

    it('returns not_found for an unknown token', async () => {
      const r = await validateRefreshToken(db, generateRefreshToken());
      expect(r).toEqual({ ok: false, reason: 'not_found' });
    });

    it('returns expired when expiresAt is in the past', async () => {
      const issued = await issueRefreshToken(db, { userId, panel: 'admin' });
      // Force the row into the past.
      await db.update(refreshTokens)
        .set({ expiresAt: new Date(Date.now() - 1000) })
        .where(eq(refreshTokens.id, issued.id));
      const r = await validateRefreshToken(db, issued.token);
      expect(r).toEqual({ ok: false, reason: 'expired' });
    });

    it('returns revoked for a logged-out token', async () => {
      const issued = await issueRefreshToken(db, { userId, panel: 'admin' });
      await revokeRefreshTokenById(db, issued.id, 'logout');
      const r = await validateRefreshToken(db, issued.token);
      expect(r).toEqual({ ok: false, reason: 'revoked' });
    });

    it('detects reuse of a rotated token and revokes the family', async () => {
      // Two tokens in the same family — simulating a rotation.
      const a = await issueRefreshToken(db, { userId, panel: 'admin' });
      const b = await issueRefreshToken(db, { userId, panel: 'admin', familyId: a.familyId });
      // Mark `a` rotated (the normal /auth/refresh path does this).
      await revokeRefreshTokenById(db, a.id, 'rotated');

      // Attacker presents the now-rotated `a` again.
      const r = await validateRefreshToken(db, a.token);
      expect(r).toEqual({ ok: false, reason: 'reuse_detected' });

      // The whole family must now be revoked — including `b`.
      const [bAfter] = await db.select().from(refreshTokens).where(eq(refreshTokens.id, b.id));
      expect(bAfter.revokedAt).not.toBeNull();
      expect(bAfter.revokedReason).toBe('reuse_detected');
    });
  });

  describe('revokeAllUserRefreshTokens', () => {
    it('revokes all active tokens, leaves already-revoked ones alone', async () => {
      const a = await issueRefreshToken(db, { userId, panel: 'admin' });
      const b = await issueRefreshToken(db, { userId, panel: 'admin' });
      const c = await issueRefreshToken(db, { userId, panel: 'admin' });
      await revokeRefreshTokenById(db, c.id, 'logout'); // Pre-revoked

      await revokeAllUserRefreshTokens(db, userId, 'password_change');

      const [aRow] = await db.select().from(refreshTokens).where(eq(refreshTokens.id, a.id));
      const [bRow] = await db.select().from(refreshTokens).where(eq(refreshTokens.id, b.id));
      const [cRow] = await db.select().from(refreshTokens).where(eq(refreshTokens.id, c.id));
      expect(aRow.revokedReason).toBe('password_change');
      expect(bRow.revokedReason).toBe('password_change');
      // Pre-revoked stays at its original reason.
      expect(cRow.revokedReason).toBe('logout');
    });
  });

  describe('pruneExpiredRefreshTokens', () => {
    it('deletes only rows that expired more than 7 days ago', async () => {
      const old = await issueRefreshToken(db, { userId, panel: 'admin' });
      const recent = await issueRefreshToken(db, { userId, panel: 'admin' });
      const fresh = await issueRefreshToken(db, { userId, panel: 'admin' });

      // old: expired 8 days ago — should be pruned.
      // recent: expired 1 day ago — kept (forensic window).
      // fresh: not expired — kept.
      await db.update(refreshTokens)
        .set({ expiresAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) })
        .where(eq(refreshTokens.id, old.id));
      await db.update(refreshTokens)
        .set({ expiresAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000) })
        .where(eq(refreshTokens.id, recent.id));

      await pruneExpiredRefreshTokens(db);

      const [oldRow] = await db.select().from(refreshTokens).where(eq(refreshTokens.id, old.id));
      const [recentRow] = await db.select().from(refreshTokens).where(eq(refreshTokens.id, recent.id));
      const [freshRow] = await db.select().from(refreshTokens).where(eq(refreshTokens.id, fresh.id));
      expect(oldRow).toBeUndefined();
      expect(recentRow).toBeDefined();
      expect(freshRow).toBeDefined();
    });
  });
});

describe('refresh-token-service (pure)', () => {
  it('hashRefreshToken is deterministic and 64-char hex', () => {
    const hash = hashRefreshToken('test-token');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashRefreshToken('test-token')).toBe(hash);
  });

  it('generateRefreshToken returns base64url-safe 256-bit values', () => {
    const a = generateRefreshToken();
    const b = generateRefreshToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[A-Za-z0-9_-]+$/);
    // 32 bytes → 43 chars base64url (no padding)
    expect(a.length).toBeGreaterThanOrEqual(43);
  });
});
