import { describe, it, expect, vi } from 'vitest';
import { verifyPassword, hashNewPassword, authenticateUser } from './service.js';
import { ApiError } from '../../shared/errors.js';

describe('verifyPassword', () => {
  it('should return true for matching password and hash', () => {
    const password = 'my-secret-password';
    const hash = hashNewPassword(password);
    expect(verifyPassword(password, hash)).toBe(true);
  });

  it('should return false for wrong password', () => {
    const hash = hashNewPassword('correct-password');
    expect(verifyPassword('wrong-password', hash)).toBe(false);
  });

  it('should return false for empty password against valid hash', () => {
    const hash = hashNewPassword('some-password');
    expect(verifyPassword('', hash)).toBe(false);
  });
});

describe('hashNewPassword', () => {
  it('should produce a hex string', () => {
    const hash = hashNewPassword('test');
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('should produce the same hash for the same input', () => {
    const hash1 = hashNewPassword('deterministic');
    const hash2 = hashNewPassword('deterministic');
    expect(hash1).toBe(hash2);
  });

  it('should produce different hashes for different inputs', () => {
    const hash1 = hashNewPassword('password-a');
    const hash2 = hashNewPassword('password-b');
    expect(hash1).not.toBe(hash2);
  });
});

describe('authenticateUser', () => {
  function createMockDb(users: Array<Record<string, unknown>>) {
    const updateSet = vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    });
    const updateFn = vi.fn().mockReturnValue({ set: updateSet });

    return {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(users),
          }),
        }),
      }),
      update: updateFn,
    } as unknown as Parameters<typeof authenticateUser>[0];
  }

  it('should throw INVALID_TOKEN when user not found', async () => {
    const db = createMockDb([]);

    await expect(authenticateUser(db, 'unknown@example.com', 'pass'))
      .rejects.toThrow(ApiError);
    await expect(authenticateUser(db, 'unknown@example.com', 'pass'))
      .rejects.toMatchObject({ code: 'INVALID_TOKEN', status: 401 });
  });

  it('should throw INVALID_TOKEN when user has no password hash', async () => {
    const db = createMockDb([{
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
    const db = createMockDb([{
      id: 'u1',
      email: 'user@example.com',
      passwordHash: hashNewPassword('correct-password'),
      fullName: 'Test User',
      roleName: 'admin',
      status: 'active',
    }]);

    await expect(authenticateUser(db, 'user@example.com', 'wrong-password'))
      .rejects.toMatchObject({ code: 'INVALID_TOKEN' });
  });

  it('should throw INVALID_TOKEN when user is not active', async () => {
    const password = 'my-password';
    const db = createMockDb([{
      id: 'u1',
      email: 'user@example.com',
      passwordHash: hashNewPassword(password),
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
              passwordHash: hashNewPassword(password),
              fullName: 'Test User',
              roleName: 'admin',
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
      role: 'admin',
    });
    expect(updateFn).toHaveBeenCalled();
  });
});
