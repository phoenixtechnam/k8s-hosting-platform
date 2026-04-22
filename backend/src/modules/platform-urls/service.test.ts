import { describe, it, expect, vi } from 'vitest';

// The service walks the key-value platformSettings table. The mock below
// stores key→value in a plain Map and wires drizzle-like chain methods
// onto it so tests can call the real service code without a DB.
function createMockDb(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const db = {
    select: () => ({
      from: () => ({
        where: (cond: { _key?: string }) => {
          const key = cond?._key ?? '';
          const val = store.get(key);
          return Promise.resolve(val === undefined ? [] : [{ key, value: val }]);
        },
      }),
    }),
    insert: () => ({
      values: (row: { key: string; value: string }) => ({
        onConflictDoUpdate: (args: { set: { value: string } }) => {
          store.set(row.key, args.set.value);
          return Promise.resolve();
        },
      }),
    }),
    delete: () => ({
      where: (cond: { _key?: string }) => {
        const key = cond?._key ?? '';
        store.delete(key);
        return Promise.resolve();
      },
    }),
  } as unknown as import('../../db/index.js').Database;
  return { db, store };
}

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, value: string) => ({ _key: value })),
}));

vi.mock('../../db/schema.js', () => ({
  platformSettings: { key: 'platformSettings.key' },
  systemSettings: { id: 'systemSettings.id' },
}));

const { getPlatformUrls, updatePlatformUrls, computeDefaults } = await import('./service.js');

describe('computeDefaults', () => {
  it('derives standard subdomains from an apex', () => {
    expect(computeDefaults('staging.phoenix-host.net')).toEqual({
      longhornUrl: 'https://longhorn.staging.phoenix-host.net/',
      stalwartAdminUrl: 'https://mail-admin.staging.phoenix-host.net/',
      webmailUrl: 'https://webmail.staging.phoenix-host.net/',
      mailServerHostname: 'mail.staging.phoenix-host.net',
    });
  });

  it('returns empty-string defaults when apex is empty', () => {
    expect(computeDefaults('')).toEqual({
      longhornUrl: '',
      stalwartAdminUrl: '',
      webmailUrl: '',
      mailServerHostname: '',
    });
  });

  it('strips trailing dots from the apex', () => {
    // ingressBaseDomain.Seed.ts sometimes produces a trailing dot depending
    // on the source — normalise here so consumers don't see a double-dot.
    expect(computeDefaults('example.com.')).toEqual({
      longhornUrl: 'https://longhorn.example.com/',
      stalwartAdminUrl: 'https://mail-admin.example.com/',
      webmailUrl: 'https://webmail.example.com/',
      mailServerHostname: 'mail.example.com',
    });
  });
});

describe('getPlatformUrls', () => {
  it('returns stored values when set', async () => {
    const { db } = createMockDb({
      ingress_base_domain: 'staging.phoenix-host.net',
      longhorn_url: 'https://longhorn.custom.example/',
      stalwart_admin_url: 'https://mail.custom.example/',
      default_webmail_url: 'https://rc.custom.example/',
      mail_server_hostname: 'mx.custom.example',
    });
    const result = await getPlatformUrls(db);
    expect(result.longhornUrl.value).toBe('https://longhorn.custom.example/');
    expect(result.longhornUrl.source).toBe('db');
    expect(result.stalwartAdminUrl.value).toBe('https://mail.custom.example/');
    expect(result.webmailUrl.value).toBe('https://rc.custom.example/');
    expect(result.mailServerHostname.value).toBe('mx.custom.example');
  });

  it('falls back to apex-derived defaults when DB rows are missing', async () => {
    const { db } = createMockDb({ ingress_base_domain: 'staging.phoenix-host.net' });
    const result = await getPlatformUrls(db);
    expect(result.longhornUrl.value).toBe('https://longhorn.staging.phoenix-host.net/');
    expect(result.longhornUrl.source).toBe('default');
    expect(result.stalwartAdminUrl.value).toBe('https://mail-admin.staging.phoenix-host.net/');
    expect(result.webmailUrl.value).toBe('https://webmail.staging.phoenix-host.net/');
    expect(result.mailServerHostname.value).toBe('mail.staging.phoenix-host.net');
  });

  it('surfaces the apex-derived default separately from the value', async () => {
    // Even when a DB row is set, the UI wants to show "Default: <x>" as a
    // hint — the `default` field on each URL is the computed apex-based
    // value regardless of whether the DB has an override.
    const { db } = createMockDb({
      ingress_base_domain: 'staging.phoenix-host.net',
      longhorn_url: 'https://longhorn.custom/',
    });
    const result = await getPlatformUrls(db);
    expect(result.longhornUrl.value).toBe('https://longhorn.custom/');
    expect(result.longhornUrl.default).toBe('https://longhorn.staging.phoenix-host.net/');
  });

  it('returns empty defaults when apex is missing', async () => {
    const { db } = createMockDb({});
    const result = await getPlatformUrls(db);
    expect(result.longhornUrl.value).toBe('');
    expect(result.longhornUrl.source).toBe('default');
    expect(result.longhornUrl.default).toBe('');
  });
});

describe('updatePlatformUrls', () => {
  it('writes the four keys to the DB', async () => {
    const { db, store } = createMockDb({ ingress_base_domain: 'staging.phoenix-host.net' });
    await updatePlatformUrls(db, {
      longhornUrl: 'https://longhorn.custom/',
      stalwartAdminUrl: 'https://admin.custom/',
      webmailUrl: 'https://rc.custom/',
      mailServerHostname: 'mx.custom',
    });
    expect(store.get('longhorn_url')).toBe('https://longhorn.custom/');
    expect(store.get('stalwart_admin_url')).toBe('https://admin.custom/');
    expect(store.get('default_webmail_url')).toBe('https://rc.custom/');
    expect(store.get('mail_server_hostname')).toBe('mx.custom');
  });

  it('deletes the row when a value is explicitly null (reset to default)', async () => {
    const { db, store } = createMockDb({
      ingress_base_domain: 'staging.phoenix-host.net',
      longhorn_url: 'https://longhorn.custom/',
    });
    await updatePlatformUrls(db, { longhornUrl: null });
    expect(store.has('longhorn_url')).toBe(false);
  });

  it('ignores undefined fields (partial update semantics)', async () => {
    const { db, store } = createMockDb({
      ingress_base_domain: 'staging.phoenix-host.net',
      longhorn_url: 'https://longhorn.custom/',
      stalwart_admin_url: 'https://admin.custom/',
    });
    await updatePlatformUrls(db, { longhornUrl: 'https://longhorn.updated/' });
    expect(store.get('longhorn_url')).toBe('https://longhorn.updated/');
    expect(store.get('stalwart_admin_url')).toBe('https://admin.custom/');
  });
});
