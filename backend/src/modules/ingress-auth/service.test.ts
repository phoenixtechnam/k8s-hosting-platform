import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildCallbackUrl } from './service.js';

describe('buildCallbackUrl', () => {
  it('builds the standard /oauth2/callback URL on the ingress hostname', () => {
    expect(buildCallbackUrl('app.example.com')).toBe(
      'https://app.example.com/oauth2/callback',
    );
  });
});

// We focus the rest of the unit tests on pure shape transformation —
// the DB-touching parts are covered in service.integration.test.ts
// which spins up a real postgres via test-helpers/db.ts.
//
// vi.mock the encryption module so we don't need a real key:
vi.mock('../oidc/crypto.js', () => ({
  encrypt: vi.fn((p: string) => `enc:${p}`),
  decrypt: vi.fn((c: string) => c.replace(/^enc:/, '')),
}));

import { encrypt, decrypt } from '../oidc/crypto.js';
import {
  upsertAuthConfig,
  getAuthConfig,
  decryptClientSecret,
  getOrCreateClientCookieSecret,
} from './service.js';

const ROUTE_ID = 'route-1';
const HOSTNAME = 'app.example.com';

const VALID_INPUT = {
  enabled: true,
  issuerUrl: 'https://idp.example.com/',
  clientId: 'app-client',
  clientSecret: 'super-secret',
  authMethod: 'client_secret_basic' as const,
  responseType: 'code' as const,
  usePkce: true,
  scopes: 'openid profile email',
  allowedEmails: null,
  allowedEmailDomains: null,
  allowedGroups: null,
  claimRules: null,
  passAuthorizationHeader: true,
  passAccessToken: true,
  passIdToken: true,
  passUserHeaders: true,
  setXauthrequest: true,
  cookieDomain: null,
  cookieRefreshSeconds: 3600,
  cookieExpireSeconds: 86400,
};

function makeMockDb(opts: {
  routeRow?: { hostname: string } | undefined;
  existingConfig?: Record<string, unknown> | undefined;
  cookieSecretRow?: Record<string, unknown> | undefined;
}) {
  const inserted: Record<string, unknown>[] = [];
  const updated: Record<string, unknown>[] = [];
  const deleted: string[] = [];

  // Drizzle's chained select() is mocked to return different shapes
  // based on the .from(table) call. We track call ordering so each
  // top-level select() returns the right fixture.
  let selectCallNo = 0;
  const select = vi.fn(() => {
    selectCallNo += 1;
    const callIndex = selectCallNo;
    return {
      from: vi.fn((_table: unknown) => ({
        where: vi.fn().mockResolvedValue(
          callIndex === 1
            ? opts.existingConfig
              ? [opts.existingConfig]
              : []
            : callIndex === 2
              ? opts.routeRow
                ? [opts.routeRow]
                : []
              : opts.cookieSecretRow
                ? [opts.cookieSecretRow]
                : [],
        ),
      })),
    };
  });

  const insert = vi.fn((_table: unknown) => ({
    values: vi.fn((row: Record<string, unknown>) => {
      inserted.push(row);
      return {
        onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
      };
    }),
  }));

  const update = vi.fn(() => ({
    set: vi.fn((row: Record<string, unknown>) => {
      updated.push(row);
      return {
        where: vi.fn().mockResolvedValue(undefined),
      };
    }),
  }));

  const del = vi.fn(() => ({
    where: vi.fn(async () => {
      deleted.push('called');
    }),
  }));

  return { select, insert, update, delete: del, inserted, updated, deleted };
}

describe('upsertAuthConfig — first write', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('encrypts the client secret and inserts a new row', async () => {
    // Order of selects in upsertAuthConfig:
    //   1. ingressRoutes (hostname check) - return route
    //   2. ingressAuthConfigs (existing) - return empty
    //   3. ingressRoutes again (in getAuthConfig) - return route
    //   4. ingressAuthConfigs (return inserted)
    let calls = 0;
    const mockDb = {
      select: vi.fn(() => {
        calls += 1;
        return {
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue(
              calls === 1
                ? [{ hostname: HOSTNAME }]
                : calls === 2
                  ? []
                  : calls === 3
                    ? [
                        {
                          id: 'cfg-1',
                          ingressRouteId: ROUTE_ID,
                          enabled: true,
                          issuerUrl: VALID_INPUT.issuerUrl,
                          clientId: VALID_INPUT.clientId,
                          clientSecretEncrypted: 'enc:super-secret',
                          authMethod: 'client_secret_basic',
                          responseType: 'code',
                          usePkce: true,
                          scopes: VALID_INPUT.scopes,
                          allowedEmails: null,
                          allowedEmailDomains: null,
                          allowedGroups: null,
                          claimRules: null,
                          passAuthorizationHeader: true,
                          passAccessToken: true,
                          passIdToken: true,
                          passUserHeaders: true,
                          setXauthrequest: true,
                          cookieDomain: null,
                          cookieRefreshSeconds: 3600,
                          cookieExpireSeconds: 86400,
                          lastError: null,
                          lastReconciledAt: null,
                          createdAt: new Date(),
                          updatedAt: new Date(),
                        },
                      ]
                    : [{ hostname: HOSTNAME }],
            ),
          })),
        };
      }),
      insert: vi.fn(() => ({
        values: vi.fn().mockResolvedValue(undefined),
      })),
      update: vi.fn(() => ({
        set: vi.fn(() => ({
          where: vi.fn().mockResolvedValue(undefined),
        })),
      })),
    } as never;

    const result = await upsertAuthConfig(
      mockDb,
      { encryptionKey: 'test-key' },
      ROUTE_ID,
      VALID_INPUT,
    );
    expect(encrypt).toHaveBeenCalledWith('super-secret', 'test-key');
    expect(result.clientSecretSet).toBe(true);
    expect(result.callbackUrl).toBe(`https://${HOSTNAME}/oauth2/callback`);
  });

  it('rejects creation without clientSecret', async () => {
    let calls = 0;
    const mockDb = {
      select: vi.fn(() => {
        calls += 1;
        return {
          from: vi.fn(() => ({
            where: vi
              .fn()
              .mockResolvedValue(calls === 1 ? [{ hostname: HOSTNAME }] : []),
          })),
        };
      }),
    } as never;
    const inputWithoutSecret = { ...VALID_INPUT, clientSecret: undefined };
    await expect(
      upsertAuthConfig(
        mockDb,
        { encryptionKey: 'test-key' },
        ROUTE_ID,
        inputWithoutSecret,
      ),
    ).rejects.toThrow(/clientSecret is required/);
  });

  it('rejects unknown ingress route', async () => {
    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
    } as never;
    await expect(
      upsertAuthConfig(
        mockDb,
        { encryptionKey: 'test-key' },
        'non-existent',
        VALID_INPUT,
      ),
    ).rejects.toThrow(/not found/);
  });
});

describe('getAuthConfig', () => {
  it('returns null when no row exists', async () => {
    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
    } as never;
    const result = await getAuthConfig(mockDb, ROUTE_ID);
    expect(result).toBeNull();
  });

  it('hides client_secret in the response (only flag exposed)', async () => {
    let calls = 0;
    const mockDb = {
      select: vi.fn(() => {
        calls += 1;
        return {
          from: vi.fn(() => ({
            where: vi.fn().mockResolvedValue(
              calls === 1
                ? [
                    {
                      id: 'cfg-1',
                      ingressRouteId: ROUTE_ID,
                      enabled: true,
                      issuerUrl: 'https://idp/',
                      clientId: 'c1',
                      clientSecretEncrypted: 'enc:x',
                      authMethod: 'client_secret_post',
                      responseType: 'code',
                      usePkce: true,
                      scopes: 'openid',
                      allowedEmails: null,
                      allowedEmailDomains: null,
                      allowedGroups: null,
                      claimRules: [
                        { claim: 'membership', operator: 'contains', value: 'paid' },
                      ],
                      passAuthorizationHeader: true,
                      passAccessToken: true,
                      passIdToken: true,
                      passUserHeaders: true,
                      setXauthrequest: true,
                      cookieDomain: null,
                      cookieRefreshSeconds: 3600,
                      cookieExpireSeconds: 86400,
                      lastError: null,
                      lastReconciledAt: null,
                      createdAt: new Date(),
                      updatedAt: new Date(),
                    },
                  ]
                : [{ hostname: HOSTNAME }],
            ),
          })),
        };
      }),
    } as never;
    const result = await getAuthConfig(mockDb, ROUTE_ID);
    expect(result).not.toBeNull();
    expect((result as Record<string, unknown>).clientSecret).toBeUndefined();
    expect(result?.clientSecretSet).toBe(true);
    expect(result?.claimRules).toEqual([
      { claim: 'membership', operator: 'contains', value: 'paid' },
    ]);
  });
});

describe('decryptClientSecret', () => {
  it('decrypts and returns the plaintext', () => {
    const row = { clientSecretEncrypted: 'enc:plaintext' } as never;
    expect(decryptClientSecret(row, 'k')).toBe('plaintext');
    expect(decrypt).toHaveBeenCalledWith('enc:plaintext', 'k');
  });

  it('returns empty string when no secret', () => {
    const row = { clientSecretEncrypted: '' } as never;
    expect(decryptClientSecret(row, 'k')).toBe('');
  });
});

describe('getOrCreateClientCookieSecret', () => {
  it('returns the existing secret when one is stored', async () => {
    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi
            .fn()
            .mockResolvedValue([
              { clientId: 'c1', cookieSecretEncrypted: 'enc:cookie123' },
            ]),
        })),
      })),
    } as never;
    const secret = await getOrCreateClientCookieSecret(mockDb, 'k', 'c1');
    expect(secret).toBe('cookie123');
  });

  it('generates and persists a new 32-byte URL-safe base64 secret on first call', async () => {
    const inserts: Record<string, unknown>[] = [];
    const mockDb = {
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          where: vi.fn().mockResolvedValue([]),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((row: Record<string, unknown>) => {
          inserts.push(row);
          return {
            onConflictDoNothing: vi.fn().mockResolvedValue(undefined),
          };
        }),
      })),
    } as never;
    const secret = await getOrCreateClientCookieSecret(mockDb, 'k', 'c1');
    // 32 bytes → 43 chars base64 (URL-safe, no padding)
    expect(secret).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(inserts).toHaveLength(1);
    expect(inserts[0]?.cookieSecretEncrypted).toMatch(/^enc:/);
  });
});
