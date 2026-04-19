import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getSettings, updateSettings, getSetting } from './service.js';
import type { Database } from '../../db/index.js';
import type { SystemSettings } from '../../db/schema.js';

/**
 * Round-trip tests: every field on the System Settings form must persist
 * through updateSettings + re-read as getSettings.
 *
 * We mock the DB thinly — drizzle's fluent chain is reproduced just enough
 * to store one row, then return it for subsequent reads. This catches the
 * class of bug where a field is in the Zod schema + UI but dropped in the
 * service layer's update path.
 */

interface DbState {
  row: Partial<SystemSettings>;
}

function buildMockDb(state: DbState): Database {
  // Flush the module-level cache between tests by directly invalidating
  // via a cache-busting update — simpler than exporting a cache-reset.
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn().mockResolvedValue(state.row.id ? [state.row] : []),
          then: (resolve: (rows: unknown[]) => unknown) => resolve(state.row.id ? [state.row] : []),
        })),
      })),
    })),
    update: vi.fn(() => ({
      set: vi.fn((patch: Partial<SystemSettings>) => ({
        where: vi.fn(async () => {
          state.row = { ...state.row, ...patch };
        }),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn((row: Partial<SystemSettings>) => ({
        onConflictDoNothing: vi.fn(async () => {
          if (!state.row.id) state.row = { ...row };
        }),
        onConflictDoUpdate: vi.fn(async () => {
          // For platform_settings mirror writes — state tracked separately if needed
        }),
      })),
    })),
  } as unknown as Database;
}

describe('system-settings service: round-trip', () => {
  let state: DbState;
  let db: Database;

  beforeEach(async () => {
    state = { row: {} };
    db = buildMockDb(state);
    // Prime the defaults row once and reset the module cache by waiting
    // for TTL. Faster: the cache is invalidated by updateSettings.
    await getSettings(db);
    // Ensure no residual cache from previous tests — mutate via update.
    await updateSettings(db, { platformName: 'reset-marker' });
  });

  it('persists platformName through update + read', async () => {
    await updateSettings(db, { platformName: 'Acme Host' });
    const settings = await getSettings(db);
    expect(settings.platformName).toBe('Acme Host');
  });

  it('persists adminPanelUrl', async () => {
    await updateSettings(db, { adminPanelUrl: 'https://admin.acme.test' });
    const settings = await getSettings(db);
    expect(settings.adminPanelUrl).toBe('https://admin.acme.test');
  });

  it('persists clientPanelUrl', async () => {
    await updateSettings(db, { clientPanelUrl: 'https://my.acme.test' });
    const settings = await getSettings(db);
    expect(settings.clientPanelUrl).toBe('https://my.acme.test');
  });

  it('persists supportEmail', async () => {
    await updateSettings(db, { supportEmail: 'help@acme.test' });
    const settings = await getSettings(db);
    expect(settings.supportEmail).toBe('help@acme.test');
  });

  it('persists supportUrl', async () => {
    await updateSettings(db, { supportUrl: 'https://docs.acme.test' });
    const settings = await getSettings(db);
    expect(settings.supportUrl).toBe('https://docs.acme.test');
  });

  it('persists ingressBaseDomain', async () => {
    await updateSettings(db, { ingressBaseDomain: 'routing.acme.test' });
    const settings = await getSettings(db);
    expect(settings.ingressBaseDomain).toBe('routing.acme.test');
  });

  it('persists apiRateLimit', async () => {
    await updateSettings(db, { apiRateLimit: 250 });
    const settings = await getSettings(db);
    expect(settings.apiRateLimit).toBe(250);
  });

  it('persists timezone', async () => {
    await updateSettings(db, { timezone: 'Europe/Berlin' });
    const settings = await getSettings(db);
    expect(settings.timezone).toBe('Europe/Berlin');
  });

  it('getSetting falls back to provided env value when DB is empty', async () => {
    // Clear the value
    await updateSettings(db, { supportEmail: null });
    const value = await getSetting(db, 'supportEmail', 'env-fallback@example.com');
    expect(value).toBe('env-fallback@example.com');
  });

  it('getSetting returns DB value when present, ignoring env fallback', async () => {
    await updateSettings(db, { supportEmail: 'help@acme.test' });
    const value = await getSetting(db, 'supportEmail', 'env-fallback@example.com');
    expect(value).toBe('help@acme.test');
  });
});
