import { describe, it, expect, vi } from 'vitest';
import { encrypt, decrypt } from './crypto.js';
import { generatePkce, parseLogoutToken, findOrCreateOidcUser, isLocalAuthDisabled, getOidcSettings } from './service.js';

describe('OIDC crypto', () => {
  const key = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

  it('should encrypt and decrypt a secret', () => {
    const plaintext = 'my-super-secret-client-secret';
    const encrypted = encrypt(plaintext, key);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted).toContain(':');

    const decrypted = decrypt(encrypted, key);
    expect(decrypted).toBe(plaintext);
  });

  it('should produce different ciphertext each time (random IV)', () => {
    const plaintext = 'same-input';
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    expect(a).not.toBe(b);
    expect(decrypt(a, key)).toBe(plaintext);
    expect(decrypt(b, key)).toBe(plaintext);
  });
});

describe('generatePkce', () => {
  it('should return code_verifier and code_challenge', () => {
    const { codeVerifier, codeChallenge } = generatePkce();
    expect(codeVerifier).toBeTruthy();
    expect(codeChallenge).toBeTruthy();
    expect(codeVerifier).not.toBe(codeChallenge);
  });

  it('should generate different values each call', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
  });
});

describe('parseLogoutToken', () => {
  function makeLogoutToken(claims: Record<string, unknown>): string {
    const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
    const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${header}.${payload}.fake-signature`;
  }

  it('should parse a valid backchannel logout token', () => {
    const token = makeLogoutToken({
      sub: 'user-123',
      iss: 'https://dex.example.com',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    });

    const claims = parseLogoutToken(token);
    expect(claims.sub).toBe('user-123');
    expect(claims.iss).toBe('https://dex.example.com');
  });

  it('should reject token without backchannel-logout event', () => {
    const token = makeLogoutToken({ sub: 'user-123', iss: 'https://dex.example.com', events: {} });
    expect(() => parseLogoutToken(token)).toThrow('Not a backchannel logout token');
  });

  it('should reject token without sub or sid', () => {
    const token = makeLogoutToken({
      iss: 'https://dex.example.com',
      events: { 'http://schemas.openid.net/event/backchannel-logout': {} },
    });
    expect(() => parseLogoutToken(token)).toThrow('must contain sub or sid');
  });

  it('should reject malformed tokens', () => {
    expect(() => parseLogoutToken('not.a.valid.token.here')).toThrow();
    expect(() => parseLogoutToken('onlyone')).toThrow('Invalid logout token format');
  });
});

describe('getOidcSettings', () => {
  it('should return null when no settings exist', async () => {
    const whereFn = vi.fn().mockResolvedValue([]);
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const db = { select: selectFn } as unknown as Parameters<typeof getOidcSettings>[0];

    // getOidcSettings does select().from(oidcSettings) with no where — it just returns all rows
    // The mock above won't match because there's no .where() call
    // Let me fix to mock select().from() directly
    const mockDb = {
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue([]),
      }),
    } as unknown as Parameters<typeof getOidcSettings>[0];

    const result = await getOidcSettings(mockDb);
    expect(result).toBeNull();
  });
});

describe('isLocalAuthDisabled', () => {
  it('should return false when no settings', async () => {
    const db = {
      select: vi.fn().mockReturnValue({ from: vi.fn().mockResolvedValue([]) }),
    } as unknown as Parameters<typeof isLocalAuthDisabled>[0];

    const result = await isLocalAuthDisabled(db);
    expect(result).toBe(false);
  });
});

describe('findOrCreateOidcUser', () => {
  it('should return existing user when matched by OIDC subject', async () => {
    const existingUser = { id: 'u1', email: 'test@example.com', oidcIssuer: 'https://dex', oidcSubject: 'sub-1' };
    let callCount = 0;
    const whereFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.resolve([existingUser]); // match by oidc
      return Promise.resolve([]);
    });
    const fromFn = vi.fn().mockReturnValue({ where: whereFn });
    const selectFn = vi.fn().mockReturnValue({ from: fromFn });
    const updateWhere = vi.fn().mockResolvedValue(undefined);
    const updateSet = vi.fn().mockReturnValue({ where: updateWhere });
    const updateFn = vi.fn().mockReturnValue({ set: updateSet });

    const db = { select: selectFn, update: updateFn } as unknown as Parameters<typeof findOrCreateOidcUser>[0];

    const result = await findOrCreateOidcUser(db, {
      sub: 'sub-1',
      iss: 'https://dex',
      email: 'test@example.com',
      aud: 'hosting-platform',
      exp: 9999999999,
      iat: 1000000000,
    });

    expect(result).toEqual(existingUser);
    expect(updateFn).toHaveBeenCalled(); // lastLoginAt updated
  });
});
