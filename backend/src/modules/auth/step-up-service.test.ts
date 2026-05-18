import { describe, it, expect, vi } from 'vitest';
import {
  getStepUpStatus,
  verifyStepUpPassword,
  DEFAULT_STEP_UP_MAX_AGE_MS,
} from './step-up-service.js';
import { hashNewPassword } from './service.js';
import { ApiError } from '../../shared/errors.js';

function mockDbWithUser(userRow: Record<string, unknown> | null) {
  const updateSet = vi.fn().mockReturnValue({
    where: vi.fn().mockResolvedValue(undefined),
  });
  const updateFn = vi.fn().mockReturnValue({ set: updateSet });
  return {
    db: {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(userRow ? [userRow] : []),
          }),
        }),
      }),
      update: updateFn,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
    updateFn,
    updateSet,
  };
}

describe('getStepUpStatus', () => {
  it('returns required=true with no methods when user does not exist', async () => {
    const { db } = mockDbWithUser(null);
    const status = await getStepUpStatus(db, 'missing-id');
    expect(status.required).toBe(true);
    expect(status.methods).toEqual([]);
    expect(status.lastCredentialCheckAt).toBeNull();
  });

  it('returns required=true with no methods when user is not active', async () => {
    const { db } = mockDbWithUser({
      passwordHash: 'h',
      passkeyMode: null,
      status: 'disabled',
      lastCredentialCheckAt: new Date(),
    });
    const status = await getStepUpStatus(db, 'u1');
    expect(status.required).toBe(true);
    expect(status.methods).toEqual([]);
  });

  it('reports password method when passwordHash present, no passkey', async () => {
    const { db } = mockDbWithUser({
      passwordHash: 'h',
      passkeyMode: null,
      status: 'active',
      lastCredentialCheckAt: new Date(),
    });
    const status = await getStepUpStatus(db, 'u1');
    expect(status.methods).toEqual(['password']);
    expect(status.required).toBe(false);
  });

  it('reports passkey method when passkeyMode=alternative, no password', async () => {
    const { db } = mockDbWithUser({
      passwordHash: null,
      passkeyMode: 'alternative',
      status: 'active',
      lastCredentialCheckAt: new Date(),
    });
    const status = await getStepUpStatus(db, 'u1');
    expect(status.methods).toEqual(['passkey']);
    expect(status.required).toBe(false);
  });

  it('reports both methods for password + passkey users', async () => {
    const { db } = mockDbWithUser({
      passwordHash: 'h',
      passkeyMode: 'second_factor',
      status: 'active',
      lastCredentialCheckAt: new Date(),
    });
    const status = await getStepUpStatus(db, 'u1');
    expect(status.methods).toEqual(['password', 'passkey']);
  });

  it('reports empty methods for OIDC-only users (no password, no passkey)', async () => {
    const { db } = mockDbWithUser({
      passwordHash: null,
      passkeyMode: null,
      status: 'active',
      lastCredentialCheckAt: new Date(),
    });
    const status = await getStepUpStatus(db, 'u1');
    // OIDC-only users CANNOT step up; the caller must surface this as
    // STEP_UP_UNAVAILABLE rather than asking the user for something
    // they cannot provide.
    expect(status.methods).toEqual([]);
    expect(status.required).toBe(false);
  });

  it('required=true when lastCredentialCheckAt is NULL', async () => {
    const { db } = mockDbWithUser({
      passwordHash: 'h',
      passkeyMode: null,
      status: 'active',
      lastCredentialCheckAt: null,
    });
    const status = await getStepUpStatus(db, 'u1');
    expect(status.required).toBe(true);
    expect(status.lastCredentialCheckAt).toBeNull();
  });

  it('required=false at boundary - 1ms inside the window', async () => {
    const ageMs = DEFAULT_STEP_UP_MAX_AGE_MS - 1;
    const lastAt = new Date(Date.now() - ageMs);
    const { db } = mockDbWithUser({
      passwordHash: 'h',
      passkeyMode: null,
      status: 'active',
      lastCredentialCheckAt: lastAt,
    });
    const status = await getStepUpStatus(db, 'u1');
    expect(status.required).toBe(false);
  });

  it('required=true at boundary + 1ms outside the window', async () => {
    const ageMs = DEFAULT_STEP_UP_MAX_AGE_MS + 1;
    const lastAt = new Date(Date.now() - ageMs);
    const { db } = mockDbWithUser({
      passwordHash: 'h',
      passkeyMode: null,
      status: 'active',
      lastCredentialCheckAt: lastAt,
    });
    const status = await getStepUpStatus(db, 'u1');
    expect(status.required).toBe(true);
  });

  it('respects a custom maxAgeMs override', async () => {
    // 1-minute window, last check was 90s ago -> stale
    const lastAt = new Date(Date.now() - 90_000);
    const { db } = mockDbWithUser({
      passwordHash: 'h',
      passkeyMode: null,
      status: 'active',
      lastCredentialCheckAt: lastAt,
    });
    const status = await getStepUpStatus(db, 'u1', 60_000);
    expect(status.required).toBe(true);
    expect(status.maxAgeMs).toBe(60_000);
  });
});

describe('verifyStepUpPassword', () => {
  it('throws VALIDATION_ERROR on empty password', async () => {
    const { db } = mockDbWithUser({
      id: 'u1',
      passwordHash: await hashNewPassword('correct'),
      status: 'active',
    });
    await expect(verifyStepUpPassword(db, 'u1', '')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      status: 400,
    });
  });

  it('throws STEP_UP_FAILED when user is missing', async () => {
    const { db } = mockDbWithUser(null);
    await expect(verifyStepUpPassword(db, 'missing', 'pw')).rejects.toMatchObject({
      code: 'STEP_UP_FAILED',
      status: 401,
    });
  });

  it('throws STEP_UP_FAILED when user is inactive', async () => {
    const { db } = mockDbWithUser({
      id: 'u1',
      passwordHash: await hashNewPassword('correct'),
      status: 'disabled',
    });
    await expect(verifyStepUpPassword(db, 'u1', 'correct')).rejects.toMatchObject({
      code: 'STEP_UP_FAILED',
    });
  });

  it('throws STEP_UP_METHOD_UNAVAILABLE when user has no password', async () => {
    const { db } = mockDbWithUser({
      id: 'u1',
      passwordHash: null,
      status: 'active',
    });
    await expect(verifyStepUpPassword(db, 'u1', 'anything')).rejects.toMatchObject({
      code: 'STEP_UP_METHOD_UNAVAILABLE',
      status: 409,
    });
  });

  it('throws STEP_UP_FAILED on wrong password', async () => {
    const { db } = mockDbWithUser({
      id: 'u1',
      passwordHash: await hashNewPassword('correct'),
      status: 'active',
    });
    await expect(verifyStepUpPassword(db, 'u1', 'wrong')).rejects.toMatchObject({
      code: 'STEP_UP_FAILED',
    });
  });

  it('bumps lastCredentialCheckAt on success and returns the timestamp', async () => {
    const { db, updateFn, updateSet } = mockDbWithUser({
      id: 'u1',
      passwordHash: await hashNewPassword('correct'),
      status: 'active',
    });
    const before = Date.now();
    const at = await verifyStepUpPassword(db, 'u1', 'correct');
    const after = Date.now();
    expect(at).toBeInstanceOf(Date);
    expect(at.getTime()).toBeGreaterThanOrEqual(before);
    expect(at.getTime()).toBeLessThanOrEqual(after);
    expect(updateFn).toHaveBeenCalled();
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ lastCredentialCheckAt: expect.any(Date) }),
    );
  });

  it('returns ApiError instances (so HTTP status surfaces correctly)', async () => {
    const { db } = mockDbWithUser(null);
    await expect(verifyStepUpPassword(db, 'missing', 'pw')).rejects.toBeInstanceOf(ApiError);
  });
});
