import { describe, it, expect, vi, beforeEach } from 'vitest';

const { resolveSpy, openSpy, deleteSpy } = vi.hoisted(() => ({
  resolveSpy: vi.fn(),
  openSpy: vi.fn(async (_id: string) => ({ stub: true })),
  deleteSpy: vi.fn(async (_handle: unknown) => undefined),
}));

vi.mock('drizzle-orm', async () => {
  const actual = await vi.importActual<typeof import('drizzle-orm')>('drizzle-orm');
  return {
    ...actual,
    eq: (col: { name?: string }, val: unknown) => ({ __testEq: true, col, val }),
  };
});

vi.mock('../../backups-v2/resolve-store.js', () => ({
  resolveBackupStore: resolveSpy,
  ResolveStoreError: class ResolveStoreError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = 'ResolveStoreError';
    }
  },
}));

import { backupsV2BundleCleanupHook } from './backups-v2-cleanup.js';
import type { HookCtx } from '../registry/index.js';

function makeCtx(jobs: Array<{ id: string; targetConfigId: string | null }>): HookCtx {
  return {
    db: {
      select: () => ({
        from: () => ({
          where: async () => jobs,
        }),
      }),
    } as never,
    k8s: {} as never,
    clientId: 'c1',
    namespace: 'client-test',
    transitionId: 't1',
    transition: 'deleted',
    attempt: 1,
  };
}

describe('backups-v2-bundle-cleanup hook', () => {
  beforeEach(() => {
    resolveSpy.mockReset();
    openSpy.mockReset().mockResolvedValue({ stub: true });
    deleteSpy.mockReset().mockResolvedValue(undefined);
    resolveSpy.mockResolvedValue({ kind: 's3', open: openSpy, delete: deleteSpy });
  });

  it('noop on non-deleted transitions', async () => {
    const ctx = { ...makeCtx([]), transition: 'suspended' as const };
    const r = await backupsV2BundleCleanupHook.run(ctx);
    expect(r.status).toBe('noop');
  });

  it('noop when client has no bundles', async () => {
    const r = await backupsV2BundleCleanupHook.run(makeCtx([]));
    expect(r.status).toBe('noop');
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('noop (with detail) when bundles all have null targetConfigId', async () => {
    const r = await backupsV2BundleCleanupHook.run(makeCtx([
      { id: 'b1', targetConfigId: null },
      { id: 'b2', targetConfigId: null },
    ]));
    expect(r.status).toBe('noop');
    expect(r.detail).toContain('FK cascade');
  });

  it('resolves stores once per target and deletes every bundle', async () => {
    const r = await backupsV2BundleCleanupHook.run(makeCtx([
      { id: 'b1', targetConfigId: 'tgt-a' },
      { id: 'b2', targetConfigId: 'tgt-a' },
      { id: 'b3', targetConfigId: 'tgt-b' },
    ]));
    expect(r.status).toBe('ok');
    expect(resolveSpy).toHaveBeenCalledTimes(2); // dedup'd targets
    expect(deleteSpy).toHaveBeenCalledTimes(3);
  });

  it('retry envelope with per-bundle failures when one delete throws', async () => {
    // The hook iterates remoteJobs in array insertion order, so
    // mockImplementationOnce affects the FIRST bundle (b-bad).
    deleteSpy.mockImplementationOnce(async () => { throw new Error('S3_500'); });
    const r = await backupsV2BundleCleanupHook.run(makeCtx([
      { id: 'b-bad', targetConfigId: 't' },
      { id: 'b-good', targetConfigId: 't' },
    ]));
    expect(r.status).toBe('retry');
    expect(r.envelope?.title).toBe('Backup bundle cleanup partial');
    expect(r.envelope?.raw).toContain('S3_500');
    // Failure entry names the failing bundle.
    expect(r.envelope?.raw).toContain('b-bad');
  });

  it('records every bundle on a target whose resolve fails', async () => {
    resolveSpy.mockRejectedValue(new Error('credentials_invalid'));
    const r = await backupsV2BundleCleanupHook.run(makeCtx([
      { id: 'b1', targetConfigId: 'tgt-bad' },
      { id: 'b2', targetConfigId: 'tgt-bad' },
    ]));
    expect(r.status).toBe('retry');
    expect(r.envelope?.raw).toContain('b1');
    expect(r.envelope?.raw).toContain('b2');
    expect(r.envelope?.raw).toContain('credentials_invalid');
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('treats null open() handle as already-deleted (counts as ok)', async () => {
    openSpy.mockResolvedValue(null);
    const r = await backupsV2BundleCleanupHook.run(makeCtx([
      { id: 'b1', targetConfigId: 't' },
    ]));
    expect(r.status).toBe('ok');
    expect(deleteSpy).not.toHaveBeenCalled();
  });
});
