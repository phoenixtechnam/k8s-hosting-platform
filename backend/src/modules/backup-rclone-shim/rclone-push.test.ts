/**
 * Unit tests for backup-rclone-shim rclone-push.ts (R-X9).
 */

import { describe, expect, it, vi } from 'vitest';

import {
  buildShimStreamingStoreConfig,
  isShimModeActive,
  shimClassFor,
  SHIM_REGION,
  SHIM_S3_ENDPOINT_URL,
} from './rclone-push.js';
import type { Database } from '../../db/index.js';

// ─── shimClassFor ────────────────────────────────────────────────────

describe('shimClassFor', () => {
  it('maps tenant_snapshot + tenant_bundle → tenant', () => {
    expect(shimClassFor('tenant_snapshot')).toBe('tenant');
    expect(shimClassFor('tenant_bundle')).toBe('tenant');
  });
  it('maps system_backup → system', () => {
    expect(shimClassFor('system_backup')).toBe('system');
  });
  it('returns null for system_mail (R-X8 owns that path)', () => {
    expect(shimClassFor('system_mail')).toBeNull();
  });
});

// ─── buildShimStreamingStoreConfig ───────────────────────────────────

describe('buildShimStreamingStoreConfig', () => {
  it('emits a deterministic config for a fixed key + class', () => {
    const cfg = buildShimStreamingStoreConfig(Buffer.alloc(32, 1), 'tenant_snapshot');
    expect(cfg).not.toBeNull();
    expect(cfg!.bucket).toBe('tenant');
    expect(cfg!.region).toBe(SHIM_REGION);
    expect(cfg!.endpoint).toBe(SHIM_S3_ENDPOINT_URL);
    expect(cfg!.pathPrefix).toBe('snapshots/tenant_snapshot');
    expect(cfg!.accessKeyId.length).toBeGreaterThan(0);
    expect(cfg!.secretAccessKey.length).toBeGreaterThan(0);
  });

  it('system_backup → bucket = system', () => {
    const cfg = buildShimStreamingStoreConfig(Buffer.alloc(32, 1), 'system_backup');
    expect(cfg!.bucket).toBe('system');
    expect(cfg!.pathPrefix).toBe('snapshots/system_backup');
  });

  it('tenant_bundle → bucket = tenant (different prefix)', () => {
    const cfg = buildShimStreamingStoreConfig(Buffer.alloc(32, 1), 'tenant_bundle');
    expect(cfg!.bucket).toBe('tenant');
    expect(cfg!.pathPrefix).toBe('snapshots/tenant_bundle');
  });

  it('system_mail → null (R-X8 owns)', () => {
    const cfg = buildShimStreamingStoreConfig(Buffer.alloc(32, 1), 'system_mail');
    expect(cfg).toBeNull();
  });

  it('same key produces deterministic creds across calls', () => {
    const k = Buffer.alloc(32, 9);
    const a = buildShimStreamingStoreConfig(k, 'tenant_snapshot');
    const b = buildShimStreamingStoreConfig(k, 'tenant_snapshot');
    expect(a).toEqual(b);
  });

  it('different keys produce different creds', () => {
    const a = buildShimStreamingStoreConfig(Buffer.alloc(32, 1), 'tenant_snapshot');
    const b = buildShimStreamingStoreConfig(Buffer.alloc(32, 2), 'tenant_snapshot');
    expect(a!.accessKeyId).not.toBe(b!.accessKeyId);
    expect(a!.secretAccessKey).not.toBe(b!.secretAccessKey);
  });
});

// ─── isShimModeActive ────────────────────────────────────────────────

function fakeDb(rows: { enabled: number }[]): Database {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: (rows: { enabled: number }[]) => unknown) =>
    Promise.resolve(rows).then(resolve);
  return {
    select: vi.fn(() => chain),
  } as unknown as Database;
}

describe('isShimModeActive', () => {
  it('returns true when shim class is bound + enabled', async () => {
    const db = fakeDb([{ enabled: 1 }]);
    expect(await isShimModeActive(db, 'tenant_snapshot')).toBe(true);
    expect(await isShimModeActive(db, 'system_backup')).toBe(true);
  });

  it('returns false when shim class unbound', async () => {
    const db = fakeDb([]);
    expect(await isShimModeActive(db, 'tenant_snapshot')).toBe(false);
  });

  it('returns false when shim class bound but target disabled', async () => {
    const db = fakeDb([{ enabled: 0 }]);
    expect(await isShimModeActive(db, 'tenant_snapshot')).toBe(false);
  });

  it('returns false for system_mail (never shim-mode at this layer)', async () => {
    const db = fakeDb([{ enabled: 1 }]);
    // Even with a "bound" row, system_mail maps to null → shim-mode off.
    expect(await isShimModeActive(db, 'system_mail')).toBe(false);
  });
});
