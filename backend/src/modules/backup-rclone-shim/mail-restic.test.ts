/**
 * Unit tests for backup-rclone-shim mail-restic.ts (R-X8).
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('./service.js', async () => {
  const actual = await vi.importActual<typeof import('./service.js')>('./service.js');
  return {
    ...actual,
    loadBackupTargetKey: vi.fn(async () => ({
      rawKey: Buffer.alloc(32, 7),
      fingerprint: '07'.repeat(8),
      generatedAt: '2026-05-20T00:00:00Z',
    })),
  };
});

import {
  buildMailResticShimEnv,
  reconcileMailResticShim,
  MAIL_NAMESPACE,
  MAIL_RESTIC_SECRET_NAME,
  MAIL_SHIM_BUCKET,
  SHIM_S3_ENDPOINT_URL,
} from './mail-restic.js';
import { ShimKeyMissingError } from './service.js';
import * as service from './service.js';
import type { Database } from '../../db/index.js';

// ---------------------------------------------------------------------------
// Pure builder
// ---------------------------------------------------------------------------

describe('buildMailResticShimEnv', () => {
  it('emits a deterministic env map for a fixed key', () => {
    const env = buildMailResticShimEnv(Buffer.alloc(32, 1));
    expect(env.RESTIC_REPOSITORY).toBe(
      `s3:${SHIM_S3_ENDPOINT_URL}/${MAIL_SHIM_BUCKET}/mail-snapshots`,
    );
    expect(env.RESTIC_PASSWORD).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(env.AWS_ACCESS_KEY_ID.length).toBeGreaterThan(0);
    expect(env.AWS_SECRET_ACCESS_KEY.length).toBeGreaterThan(0);
  });

  it('returns the same output across calls (deterministic)', () => {
    const k = Buffer.alloc(32, 9);
    expect(buildMailResticShimEnv(k)).toEqual(buildMailResticShimEnv(k));
  });

  it('routes through the raw bucket (no rclone-crypt — restic encrypts)', () => {
    const env = buildMailResticShimEnv(Buffer.alloc(32, 1));
    expect(env.RESTIC_REPOSITORY).toContain('mail-raw');
    expect(env.RESTIC_REPOSITORY).not.toMatch(/mail-snapshots[^/]/);
  });

  it('points at the shim ClusterIP, not raw upstream', () => {
    const env = buildMailResticShimEnv(Buffer.alloc(32, 1));
    expect(env.RESTIC_REPOSITORY).toContain(
      'backup-rclone-shim.platform.svc.cluster.local:9000',
    );
  });
});

// ---------------------------------------------------------------------------
// Reconcile
// ---------------------------------------------------------------------------

function fakeDb(rows: { mail: boolean; legacy: boolean; mailEnabled?: boolean; legacyEnabled?: boolean }): Database {
  const mailEnabled = rows.mailEnabled ?? rows.mail;
  const legacyEnabled = rows.legacyEnabled ?? rows.legacy;
  const chain: Record<string, unknown> = {};
  let nextRows: { enabled: number }[] = [];
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'limit']) {
    chain[m] = vi.fn((arg?: unknown) => {
      // The where() call's argument is the drizzle SQL expression. We
      // distinguish 'mail' vs 'system_mail' by inspecting the call's
      // string form — but since we can't easily do that, the test
      // instead relies on call sequencing: each await maps to one
      // call sequence. We use the queueing semantics below.
      void arg;
      return chain;
    });
  }
  let callCount = 0;
  chain.then = (resolve: (rows: { enabled: number }[]) => unknown) => {
    callCount += 1;
    if (callCount === 1) {
      nextRows = rows.mail ? [{ enabled: mailEnabled ? 1 : 0 }] : [];
    } else {
      nextRows = rows.legacy ? [{ enabled: legacyEnabled ? 1 : 0 }] : [];
    }
    return Promise.resolve(nextRows).then(resolve);
  };
  return {
    select: vi.fn(() => chain),
  } as unknown as Database;
}

function fakeCore(opts: { existing?: boolean } = {}) {
  return {
    readNamespacedSecret: vi.fn().mockRejectedValue({ statusCode: 404 }),
    createNamespacedSecret: vi.fn().mockResolvedValue({}),
    replaceNamespacedSecret: opts.existing
      ? vi.fn().mockResolvedValue({})
      : vi.fn().mockRejectedValue({ statusCode: 404 }),
  };
}

function silentLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('reconcileMailResticShim', () => {
  it('only mail bound → applies shim env (creates Secret on 404)', async () => {
    const db = fakeDb({ mail: true, legacy: false });
    const core = fakeCore();
    const r = await reconcileMailResticShim(db, { core } as never, silentLog());

    expect(r.state).toBe('STATE_OK');
    expect(r.secretApplied).toBe(true);
    // replaceNamespacedSecret → 404 → falls through to createNamespacedSecret.
    expect(core.replaceNamespacedSecret).toHaveBeenCalledTimes(1);
    expect(core.createNamespacedSecret).toHaveBeenCalledTimes(1);
    const body = (core.createNamespacedSecret.mock.calls[0][0] as { body: Record<string, unknown> }).body;
    expect((body.metadata as Record<string, unknown>).name).toBe(MAIL_RESTIC_SECRET_NAME);
    expect((body.metadata as Record<string, unknown>).namespace).toBe(MAIL_NAMESPACE);
  });

  it('only legacy bound → STATE_LEGACY_TAKING_OVER (no Secret touch)', async () => {
    const db = fakeDb({ mail: false, legacy: true });
    const core = fakeCore();
    const r = await reconcileMailResticShim(db, { core } as never, silentLog());

    expect(r.state).toBe('STATE_LEGACY_TAKING_OVER');
    expect(r.secretApplied).toBe(false);
    expect(core.replaceNamespacedSecret).not.toHaveBeenCalled();
    expect(core.createNamespacedSecret).not.toHaveBeenCalled();
  });

  it('both bound → defers to legacy + warns (no Secret touch)', async () => {
    const db = fakeDb({ mail: true, legacy: true });
    const core = fakeCore();
    const log = silentLog();
    const r = await reconcileMailResticShim(db, { core } as never, log);

    expect(r.state).toBe('STATE_LEGACY_TAKING_OVER');
    expect(r.secretApplied).toBe(false);
    expect(log.warn).toHaveBeenCalled();
  });

  it('neither bound → STATE_NO_MAIL_TARGET (no Secret touch)', async () => {
    const db = fakeDb({ mail: false, legacy: false });
    const core = fakeCore();
    const r = await reconcileMailResticShim(db, { core } as never, silentLog());

    expect(r.state).toBe('STATE_NO_MAIL_TARGET');
    expect(r.secretApplied).toBe(false);
  });

  it('STATE_MISSING_KEY when BACKUP_TARGET_KEY absent', async () => {
    const db = fakeDb({ mail: true, legacy: false });
    const core = fakeCore();
    vi.mocked(service.loadBackupTargetKey).mockRejectedValueOnce(
      new ShimKeyMissingError('Secret not found'),
    );
    const r = await reconcileMailResticShim(db, { core } as never, silentLog());

    expect(r.state).toBe('STATE_MISSING_KEY');
    expect(r.secretApplied).toBe(false);
  });

  it('disabled mail target → treated as no target', async () => {
    const db = fakeDb({ mail: true, legacy: false, mailEnabled: false });
    const core = fakeCore();
    const r = await reconcileMailResticShim(db, { core } as never, silentLog());

    expect(r.state).toBe('STATE_NO_MAIL_TARGET');
    expect(r.secretApplied).toBe(false);
  });

  it('replaces existing Secret on 200 (idempotent)', async () => {
    const db = fakeDb({ mail: true, legacy: false });
    const core = fakeCore({ existing: true });
    const r = await reconcileMailResticShim(db, { core } as never, silentLog());

    expect(r.state).toBe('STATE_OK');
    expect(core.replaceNamespacedSecret).toHaveBeenCalledTimes(1);
    expect(core.createNamespacedSecret).not.toHaveBeenCalled();
  });
});
