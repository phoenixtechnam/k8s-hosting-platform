import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ApiError } from '../../shared/errors.js';
import { loadPasskeyConfig } from './passkey-service.js';

describe('loadPasskeyConfig', () => {
  it('throws when RP_ID is unset', () => {
    expect(() => loadPasskeyConfig({})).toThrow(/PLATFORM_PASSKEY_RP_ID/);
  });

  it('throws when ORIGINS is unset', () => {
    expect(() => loadPasskeyConfig({ PLATFORM_PASSKEY_RP_ID: 'phoenix-host.net' }))
      .toThrow(/PLATFORM_PASSKEY_ORIGINS/);
  });

  it('throws when an origin is not a registrable suffix of RP_ID', () => {
    expect(() => loadPasskeyConfig({
      PLATFORM_PASSKEY_RP_ID: 'phoenix-host.net',
      PLATFORM_PASSKEY_ORIGINS: 'https://admin.example.com',
    })).toThrow(/registrable suffix/);
  });

  it('accepts subdomain origins of RP_ID', () => {
    const cfg = loadPasskeyConfig({
      PLATFORM_PASSKEY_RP_ID: 'phoenix-host.net',
      PLATFORM_PASSKEY_ORIGINS: 'https://admin.phoenix-host.net,https://client.phoenix-host.net',
    });
    expect(cfg.rpId).toBe('phoenix-host.net');
    expect(cfg.origins).toEqual([
      'https://admin.phoenix-host.net',
      'https://client.phoenix-host.net',
    ]);
  });

  it('accepts the bare RP_ID as origin host', () => {
    const cfg = loadPasskeyConfig({
      PLATFORM_PASSKEY_RP_ID: 'phoenix-host.net',
      PLATFORM_PASSKEY_ORIGINS: 'https://phoenix-host.net',
    });
    expect(cfg.rpId).toBe('phoenix-host.net');
  });

  it('rejects malformed URLs in ORIGINS', () => {
    expect(() => loadPasskeyConfig({
      PLATFORM_PASSKEY_RP_ID: 'phoenix-host.net',
      PLATFORM_PASSKEY_ORIGINS: 'admin.phoenix-host.net',
    })).toThrow(/not a valid URL/);
  });

  it('uses PLATFORM_PASSKEY_RP_NAME when provided', () => {
    const cfg = loadPasskeyConfig({
      PLATFORM_PASSKEY_RP_ID: 'phoenix-host.net',
      PLATFORM_PASSKEY_ORIGINS: 'https://admin.phoenix-host.net',
      PLATFORM_PASSKEY_RP_NAME: 'My Platform',
    });
    expect(cfg.rpName).toBe('My Platform');
  });
});

// ─── deletePasskey safety check ──────────────────────────────────────
// We test the lockout guard at a higher level — when the user is in
// 'second_factor' mode and removing the LAST passkey would lock them
// out, the service must reject with LAST_PASSKEY_IN_2FA_MODE. The
// integration test (E2E) exercises the full DB path; here we verify
// the decision logic directly with a chainable mock db.

describe('deletePasskey lockout guard', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  function makeDb(opts: {
    passkey: { id: string; userId: string } | null;
    allPasskeys: { id: string }[];
    user: { passkeyMode: string | null };
  }) {
    let selectCall = 0;
    const limit = vi.fn(() => Promise.resolve(opts.passkey ? [opts.passkey] : []));
    const where = vi.fn(() => {
      selectCall++;
      // 1st select(): the passkey by (id, userId) → .limit(1)
      // 2nd select(): all passkeys for the user
      // 3rd select(): the user row
      if (selectCall === 1) return { limit };
      if (selectCall === 2) return Promise.resolve(opts.allPasskeys);
      if (selectCall === 3) return { limit: vi.fn(() => Promise.resolve([opts.user])) };
      return Promise.resolve([]);
    });
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const updateWhere = vi.fn(() => Promise.resolve());
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set: updateSet }));
    const deleteWhere = vi.fn(() => Promise.resolve());
    const del = vi.fn(() => ({ where: deleteWhere }));
    const txDb = { select, update, delete: del };
    // deletePasskey wraps everything in db.transaction(tx => …); the
    // tx adapter exposes the same select/update/delete API as db.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const transaction = vi.fn((fn: (tx: any) => Promise<unknown>) => fn(txDb));
    return { ...txDb, transaction, _deleteWhere: deleteWhere, _updateSet: updateSet };
  }

  it('rejects last-passkey delete when user is in second_factor mode', async () => {
    const { deletePasskey } = await import('./passkey-service.js');
    const db = makeDb({
      passkey: { id: 'pk1', userId: 'u1' },
      allPasskeys: [{ id: 'pk1' }],
      user: { passkeyMode: 'second_factor' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(deletePasskey(db as any, 'u1', 'pk1')).rejects.toMatchObject({
      code: 'LAST_PASSKEY_IN_2FA_MODE',
      status: 409,
    });
    expect(db._deleteWhere).not.toHaveBeenCalled();
  });

  it('downgrades alternative→null when the last passkey is removed', async () => {
    const { deletePasskey } = await import('./passkey-service.js');
    const db = makeDb({
      passkey: { id: 'pk1', userId: 'u1' },
      allPasskeys: [{ id: 'pk1' }],
      user: { passkeyMode: 'alternative' },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deletePasskey(db as any, 'u1', 'pk1');
    expect(db._updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ passkeyMode: null }),
    );
    expect(db._deleteWhere).toHaveBeenCalled();
  });

  it('allows last-passkey delete when mode is NULL', async () => {
    const { deletePasskey } = await import('./passkey-service.js');
    const db = makeDb({
      passkey: { id: 'pk1', userId: 'u1' },
      allPasskeys: [{ id: 'pk1' }],
      user: { passkeyMode: null },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await deletePasskey(db as any, 'u1', 'pk1');
    expect(db._deleteWhere).toHaveBeenCalled();
  });

  it('throws PASSKEY_NOT_FOUND when the credential does not exist', async () => {
    const { deletePasskey } = await import('./passkey-service.js');
    const db = makeDb({
      passkey: null,
      allPasskeys: [],
      user: { passkeyMode: null },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(deletePasskey(db as any, 'u1', 'pk1')).rejects.toMatchObject({
      code: 'PASSKEY_NOT_FOUND',
    });
  });
});

// ─── setPasskeyMode guard ────────────────────────────────────────────

describe('setPasskeyMode guard', () => {
  it('rejects second_factor when user has zero passkeys', async () => {
    const { setPasskeyMode } = await import('./passkey-service.js');
    const limit = vi.fn(() => Promise.resolve([])); // no passkeys
    const where = vi.fn(() => ({ limit }));
    const from = vi.fn(() => ({ where }));
    const select = vi.fn(() => ({ from }));
    const updateWhere = vi.fn(() => Promise.resolve());
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set: updateSet }));
    const db = { select, update };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await expect(setPasskeyMode(db as any, 'u1', 'second_factor')).rejects.toMatchObject({
      code: 'PASSKEY_REQUIRED_FIRST',
    });
    expect(updateSet).not.toHaveBeenCalled();
  });

  it('accepts null mode without checking passkeys', async () => {
    const { setPasskeyMode } = await import('./passkey-service.js');
    const updateWhere = vi.fn(() => Promise.resolve());
    const updateSet = vi.fn(() => ({ where: updateWhere }));
    const update = vi.fn(() => ({ set: updateSet }));
    const db = { update };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await setPasskeyMode(db as any, 'u1', null);
    expect(updateSet).toHaveBeenCalledWith(expect.objectContaining({ passkeyMode: null }));
  });
});
