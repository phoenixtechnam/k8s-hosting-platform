import { describe, it, expect, vi } from 'vitest';
import { verifyPassword, hashNewPassword, authenticateUser } from './service.js';
import { ApiError } from '../../shared/errors.js';

describe('verifyPassword', () => {
  it('should return true for matching password and hash', async () => {
    const password = 'my-secret-password';
    const hash = await hashNewPassword(password);
    expect(await verifyPassword(password, hash)).toBe(true);
  });

  it('should return false for wrong password', async () => {
    const hash = await hashNewPassword('correct-password');
    expect(await verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('should return false for empty password against valid hash', async () => {
    const hash = await hashNewPassword('some-password');
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('should verify legacy SHA-256 hashes for migration', async () => {
    const { createHash } = await import('crypto');
    const legacyHash = createHash('sha256').update('legacy-pass').digest('hex');
    expect(await verifyPassword('legacy-pass', legacyHash)).toBe(true);
    expect(await verifyPassword('wrong-pass', legacyHash)).toBe(false);
  });
});

describe('hashNewPassword', () => {
  it('should produce a bcrypt hash string', async () => {
    const hash = await hashNewPassword('test');
    expect(hash).toMatch(/^\$2[aby]\$/);
  });

  it('should produce different hashes for the same input (salted)', async () => {
    const hash1 = await hashNewPassword('deterministic');
    const hash2 = await hashNewPassword('deterministic');
    expect(hash1).not.toBe(hash2);
  });

  it('should produce different hashes for different inputs', async () => {
    const hash1 = await hashNewPassword('password-a');
    const hash2 = await hashNewPassword('password-b');
    expect(hash1).not.toBe(hash2);
  });
});

describe('authenticateUser', () => {
  async function createMockDb(usersList: Array<Record<string, unknown>>) {
    const updateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    const updateFn = vi.fn().mockReturnValue({ set: updateSet });

    return {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(usersList),
          }),
        }),
      }),
      update: updateFn,
    } as unknown as Parameters<typeof authenticateUser>[0];
  }

  it('should throw INVALID_TOKEN when user not found', async () => {
    const db = await createMockDb([]);

    await expect(authenticateUser(db, 'unknown@example.com', 'pass'))
      .rejects.toThrow(ApiError);
    await expect(authenticateUser(db, 'unknown@example.com', 'pass'))
      .rejects.toMatchObject({ code: 'INVALID_TOKEN', status: 401 });
  });

  it('should throw INVALID_TOKEN when user has no password hash', async () => {
    const db = await createMockDb([{
      id: 'u1',
      email: 'user@example.com',
      passwordHash: null,
      fullName: 'Test User',
      roleName: 'admin',
      status: 'active',
    }]);

    await expect(authenticateUser(db, 'user@example.com', 'pass'))
      .rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('should throw INVALID_TOKEN when password is wrong', async () => {
    const db = await createMockDb([{
      id: 'u1',
      email: 'user@example.com',
      passwordHash: await hashNewPassword('correct-password'),
      fullName: 'Test User',
      roleName: 'admin',
      status: 'active',
    }]);

    await expect(authenticateUser(db, 'user@example.com', 'wrong-password'))
      .rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('should throw INVALID_TOKEN when user is not active', async () => {
    const password = 'my-password';
    const db = await createMockDb([{
      id: 'u1',
      email: 'user@example.com',
      passwordHash: await hashNewPassword(password),
      fullName: 'Test User',
      roleName: 'admin',
      status: 'disabled',
    }]);

    await expect(authenticateUser(db, 'user@example.com', password))
      .rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('should return user data and update last login on success', async () => {
    const password = 'my-password';
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const updateFn = vi.fn().mockReturnValue({ set: updateSet });

    const db = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([{
              id: 'u1',
              email: 'user@example.com',
              passwordHash: await hashNewPassword(password),
              fullName: 'Test User',
              roleName: 'super_admin',
              panel: 'admin',
              clientId: null,
              status: 'active',
            }]),
          }),
        }),
      }),
      update: updateFn,
    } as unknown as Parameters<typeof authenticateUser>[0];

    const result = await authenticateUser(db, 'user@example.com', password);

    expect(result).toEqual({
      id: 'u1',
      email: 'user@example.com',
      fullName: 'Test User',
      role: 'super_admin',
      panel: 'admin',
      clientId: undefined,
    });
    expect(updateFn).toHaveBeenCalled();
  });
});
