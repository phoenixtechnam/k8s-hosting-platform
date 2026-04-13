import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateSecurePassword } from './service.js';

// Mock bcrypt
vi.mock('bcrypt', () => ({
  default: {
    hash: vi.fn().mockResolvedValue('$2b$10$mockhashedpassword'),
    compare: vi.fn().mockResolvedValue(true),
  },
}));

describe('generateSecurePassword', () => {
  it('should generate password of default length 24', () => {
    const pwd = generateSecurePassword();
    expect(pwd).toHaveLength(24);
  });

  it('should generate password of custom length', () => {
    const pwd = generateSecurePassword(16);
    expect(pwd).toHaveLength(16);
  });

  it('should generate different passwords on each call', () => {
    const pwd1 = generateSecurePassword();
    const pwd2 = generateSecurePassword();
    expect(pwd1).not.toBe(pwd2);
  });

  it('should only contain base64url characters', () => {
    const pwd = generateSecurePassword(100);
    expect(pwd).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

// ─── Service CRUD tests ────────────────────────────────────────────────────

describe('listSftpUsers', () => {
  const mockRow = {
    id: 'sftp-1',
    clientId: 'c1',
    username: 'testuser',
    passwordHash: '$2b$10$hash',
    description: 'Test user',
    enabled: 1,
    homePath: '/',
    allowWrite: 1,
    allowDelete: 0,
    ipWhitelist: null,
    maxConcurrentSessions: 3,
    lastLoginAt: new Date('2026-01-01'),
    lastLoginIp: '10.0.0.1',
    expiresAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  };

  let listSftpUsers: typeof import('./service.js').listSftpUsers;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./service.js');
    listSftpUsers = mod.listSftpUsers;
  });

  it('should return mapped users for a client', async () => {
    const mockLimit = vi.fn().mockResolvedValue([mockRow]);
    const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockDb = { select: vi.fn().mockReturnValue({ from: mockFrom }) };

    const result = await listSftpUsers(mockDb as any, 'c1');

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: 'sftp-1',
      clientId: 'c1',
      username: 'testuser',
      description: 'Test user',
      enabled: true,
      homePath: '/',
      allowWrite: true,
      allowDelete: false,
      ipWhitelist: null,
      maxConcurrentSessions: 3,
      lastLoginAt: '2026-01-01T00:00:00.000Z',
      lastLoginIp: '10.0.0.1',
      expiresAt: null,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
  });

  it('should return empty array when no users exist', async () => {
    const mockLimit = vi.fn().mockResolvedValue([]);
    const mockOrderBy = vi.fn().mockReturnValue({ limit: mockLimit });
    const mockWhere = vi.fn().mockReturnValue({ orderBy: mockOrderBy });
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockDb = { select: vi.fn().mockReturnValue({ from: mockFrom }) };

    const result = await listSftpUsers(mockDb as any, 'c1');
    expect(result).toEqual([]);
  });
});

describe('getSftpUser', () => {
  let getSftpUser: typeof import('./service.js').getSftpUser;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./service.js');
    getSftpUser = mod.getSftpUser;
  });

  it('should throw SFTP_USER_NOT_FOUND when user does not exist', async () => {
    const mockWhere = vi.fn().mockResolvedValue([]);
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockDb = { select: vi.fn().mockReturnValue({ from: mockFrom }) };

    await expect(getSftpUser(mockDb as any, 'c1', 'nonexistent'))
      .rejects.toThrow('SFTP user');
  });
});

describe('createSftpUser', () => {
  let createSftpUser: typeof import('./service.js').createSftpUser;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./service.js');
    createSftpUser = mod.createSftpUser;
  });

  it('should auto-generate username and return password', async () => {
    const createdRow = {
      id: 'new-id', clientId: 'c1', username: 'a3f7c2e1',
      passwordHash: '$2b$10$hash', description: null, enabled: 1,
      homePath: '/', allowWrite: 1, allowDelete: 0, ipWhitelist: null,
      maxConcurrentSessions: 3, lastLoginAt: null, lastLoginIp: null,
      expiresAt: null, createdAt: new Date(), updatedAt: new Date(),
    };
    // First select (duplicate check) returns empty (no collision)
    const mockWhere = vi.fn()
      .mockResolvedValueOnce([]) // uniqueness check
      .mockResolvedValueOnce([createdRow]); // fetch after insert
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockValues = vi.fn().mockResolvedValue(undefined);
    const mockDb = {
      select: vi.fn().mockReturnValue({ from: mockFrom }),
      insert: vi.fn().mockReturnValue({ values: mockValues }),
    };

    const result = await createSftpUser(mockDb as any, 'c1', { auth_method: 'password' });
    expect(result.username).toMatch(/^[0-9a-f]{8}$/);
    expect((result as any).password).toBeDefined();
    expect((result as any).password.length).toBe(24);
  });
});

describe('rotateSftpPassword', () => {
  let rotateSftpPassword: typeof import('./service.js').rotateSftpPassword;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('./service.js');
    rotateSftpPassword = mod.rotateSftpPassword;
  });

  it('should throw when user does not exist', async () => {
    const mockWhere = vi.fn().mockResolvedValue([]);
    const mockFrom = vi.fn().mockReturnValue({ where: mockWhere });
    const mockDb = { select: vi.fn().mockReturnValue({ from: mockFrom }) };

    await expect(rotateSftpPassword(mockDb as any, 'c1', 'nonexistent'))
      .rejects.toThrow('SFTP user');
  });
});
