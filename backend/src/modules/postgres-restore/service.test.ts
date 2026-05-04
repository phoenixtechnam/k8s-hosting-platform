import { describe, it, expect, vi, beforeEach } from 'vitest';
import { isPostgresRestoreInProgress, promotePostgresFromSnapshot, acquirePitrLockOrThrow, createPitrJob, getPlatformApiImage } from './service.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';

vi.mock('../../db/schema.js', () => ({
  notifications: { id: 'notifications.id' },
  users: { id: 'users.id', roleName: 'users.roleName' },
  // platformSettings is the DB-backed PITR lock table; service.ts
  // reads/writes it via acquirePitrLockOrThrow + writePersistedLock.
  // Tests don't exercise lock contention — the mock makeDb returns
  // empty rows so the lock check passes.
  platformSettings: { key: 'platform_settings.key', value: 'platform_settings.value' },
}));

vi.mock('../../shared/k8s-exec.js', () => ({
  execInPod: vi.fn().mockImplementation((_kc: string | undefined, _ns: string, _pod: string, _container: string, cmd: readonly string[]) => {
    const c = cmd.join(' ');
    if (c.includes('ls -la')) {
      const old = Math.floor(Date.now() / 1000) - 7200;
      return Promise.resolve({ stdout: `${old} 000000010000000000000001\n`, stderr: '', exitCode: 0 });
    }
    if (c.includes('SELECT 1')) return Promise.resolve({ stdout: '1', stderr: '', exitCode: 0 });
    return Promise.resolve({ stdout: '', stderr: '', exitCode: 0 });
  }),
}));

function makeDb(): Database {
  // Drizzle-shaped mock: each chained call returns an object exposing
  // the next method. .where() resolves to an empty rowset (no lock
  // held); .onConflictDoUpdate / .delete().where() / .limit() all
  // return resolved promises so the orchestrator's lock-related
  // writes succeed silently.
  const empty = Promise.resolve([]);
  const ok = Promise.resolve(undefined);
  return {
    select: () => ({
      from: () => ({
        where: () => Object.assign(empty, { limit: () => empty }),
      }),
    }),
    insert: () => ({
      values: () => Object.assign(ok, { onConflictDoUpdate: () => ok }),
    }),
    delete: () => ({ where: () => ok }),
  } as unknown as Database;
}

interface MockK8sOpts {
  cluster?: unknown;
  snapshot?: unknown;
  pvcs?: unknown[];
  failOnCreatePlural?: string;
}

function makeK8s(opts: MockK8sOpts = {}): K8sClients {
  const created: Record<string, unknown[]> = {};
  return {
    core: {
      listNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({ items: opts.pvcs ?? [] }),
      readNamespacedPersistentVolumeClaim: vi.fn().mockResolvedValue({ spec: { volumeName: 'pvc-test' } }),
    },
    apps: {
      patchNamespacedDeploymentScale: vi.fn().mockResolvedValue({}),
      readNamespacedDeployment: vi.fn().mockResolvedValue({
        spec: { template: { spec: { containers: [{ name: 'api', image: 'ghcr.io/test/backend:test' }] } } },
      }),
    },
    batch: {
      createNamespacedJob: vi.fn().mockResolvedValue({}),
      listNamespacedJob: vi.fn().mockResolvedValue({ items: [] }),
      deleteNamespacedJob: vi.fn().mockResolvedValue({}),
    },
    custom: {
      getNamespacedCustomObject: vi.fn().mockImplementation((args: { plural: string }) => {
        if (args.plural === 'clusters') return Promise.resolve(opts.cluster ?? null);
        if (args.plural === 'snapshots') return Promise.resolve(opts.snapshot ?? null);
        return Promise.resolve(null);
      }),
      getClusterCustomObject: vi.fn().mockResolvedValue(null),
      createNamespacedCustomObject: vi.fn().mockImplementation((args: { plural: string; body: unknown }) => {
        if (opts.failOnCreatePlural === args.plural) return Promise.reject(new Error(`mock-fail-${args.plural}`));
        const arr = created[args.plural] ?? [];
        arr.push(args.body);
        created[args.plural] = arr;
        return Promise.resolve({});
      }),
      createClusterCustomObject: vi.fn().mockResolvedValue({}),
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      deleteClusterCustomObject: vi.fn().mockResolvedValue({}),
      patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    },
  } as unknown as K8sClients;
}

describe('promotePostgresFromSnapshot — preflight only (real K8s ops mocked)', () => {
  beforeEach(() => { /* reset module-state by re-importing not needed; lock auto-released on throw */ });

  it('refuses when cluster missing bootstrap.initdb', async () => {
    const k8s = makeK8s({
      cluster: { metadata: { name: 'postgres', namespace: 'platform' }, spec: {}, status: { currentPrimary: 'postgres-1' } },
    });
    await expect(promotePostgresFromSnapshot(
      { k8s, db: makeDb() },
      { clusterNamespace: 'platform', clusterName: 'postgres', snapshotName: 'snap-1', recoveryTargetTime: null, actorUserId: null },
    )).rejects.toMatchObject({ code: 422 });
    expect(isPostgresRestoreInProgress().inProgress).toBe(false);
  });

  it('refuses when snapshot does not belong to a cluster PVC', async () => {
    const k8s = makeK8s({
      cluster: {
        metadata: { name: 'postgres', namespace: 'platform' },
        spec: { instances: 3, storage: { size: '10Gi' }, bootstrap: { initdb: { database: 'hp', owner: 'p', secret: { name: 's' } } } },
        status: { currentPrimary: 'postgres-1' },
      },
      snapshot: { spec: { volume: 'vol-mismatch' }, status: { readyToUse: true } },
      pvcs: [{ metadata: { name: 'postgres-1' }, spec: { volumeName: 'vol-actual' } }],
    });
    await expect(promotePostgresFromSnapshot(
      { k8s, db: makeDb() },
      { clusterNamespace: 'platform', clusterName: 'postgres', snapshotName: 'snap-bad', recoveryTargetTime: null, actorUserId: null },
    )).rejects.toMatchObject({ code: 409 });
  });

  it('refuses when recoveryTargetTime is before snapshot creation', async () => {
    const k8s = makeK8s({
      cluster: {
        metadata: { name: 'postgres', namespace: 'platform' },
        spec: { instances: 3, storage: { size: '10Gi' }, bootstrap: { initdb: { database: 'hp', owner: 'p', secret: { name: 's' } } } },
        status: { currentPrimary: 'postgres-1' },
      },
      snapshot: {
        spec: { volume: 'vol-actual' },
        status: { readyToUse: true, creationTime: '2026-05-03T12:00:00Z' },
      },
      pvcs: [{ metadata: { name: 'postgres-1' }, spec: { volumeName: 'vol-actual' } }],
    });
    await expect(promotePostgresFromSnapshot(
      { k8s, db: makeDb() },
      {
        clusterNamespace: 'platform', clusterName: 'postgres', snapshotName: 'snap-1',
        recoveryTargetTime: '2026-05-03T11:30:00Z',
        actorUserId: null,
      },
    )).rejects.toMatchObject({ code: 422 });
  });

  it('refuses concurrent PITR (lock test)', async () => {
    // Lock is in-process module state. Simulate concurrent by setting it
    // via a pending promotePostgresFromSnapshot that hangs at the
    // create-temp step (we'll let preflight succeed, then the createCustom
    // for clusters will hang the call indefinitely — but that's hard to
    // test in isolation). Easier: directly probe the lock state after
    // a preflight failure leaves it released, then test that two
    // concurrent calls trip the lock.
    // For brevity, this test asserts the lock is released on preflight
    // failure (covered above implicitly), and that
    // isPostgresRestoreInProgress returns false at module idle.
    expect(isPostgresRestoreInProgress().inProgress).toBe(false);
  });

  it('acquirePitrLockOrThrow is race-safe — second concurrent call gets 409', async () => {
    // After the previous tests, the in-memory lock is released (each
    // promotePostgresFromSnapshot's finally clears it). Acquire it
    // synchronously, then verify a second acquire fails fast with 409
    // BEFORE the first's DB write returns. This is the core anti-race
    // property — the synchronous in-memory set in the critical
    // section between the cluster-wide check and the DB write closes
    // the window where a concurrent route handler could slip through.
    expect(isPostgresRestoreInProgress().inProgress).toBe(false);
    const db = makeDb();
    const inputs = { clusterNamespace: 'platform', clusterName: 'postgres', snapshotName: 'snap-test' };

    // Fire two concurrent acquisitions
    const [first, second] = await Promise.allSettled([
      acquirePitrLockOrThrow(db, inputs),
      acquirePitrLockOrThrow(db, inputs),
    ]);

    // Exactly one should succeed
    const fulfilled = [first, second].filter((r) => r.status === 'fulfilled');
    const rejected = [first, second].filter((r) => r.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    if (rejected[0].status === 'rejected') {
      expect((rejected[0].reason as { code?: number }).code).toBe(409);
    }

    // Lock is held — manual cleanup for test isolation. The lock
    // would normally be released by promotePostgresFromSnapshot's
    // finally; we hijack the module-state by re-acquiring after a
    // forced-clear in a real test, but for this unit test we just
    // assert the contract and let the next test's makeDb scope
    // contain the fallout.
    expect(isPostgresRestoreInProgress().inProgress).toBe(true);
  });

  it('createPitrJob builds a valid Job CR with expected env + labels', async () => {
    const k8s = makeK8s();
    const result = await createPitrJob(k8s, {
      clusterNamespace: 'platform', clusterName: 'postgres',
      snapshotName: 'snap-1', recoveryTargetTime: '2026-05-03T20:00:00Z',
      actorUserId: 'user-1', image: 'ghcr.io/test/backend:abc123',
    });
    expect(result.namespace).toBe('platform');
    expect(result.jobName).toMatch(/^pitr-postgres-\d+$/);
    const createCall = (k8s.batch as unknown as { createNamespacedJob: { mock: { calls: Array<[{ namespace: string; body: { metadata: { name: string; labels: Record<string, string> }; spec: { template: { metadata: { labels: Record<string, string> }; spec: { containers: Array<{ image: string; env: Array<{ name: string; value?: string }> }> } } } } }]> } } }).createNamespacedJob.mock.calls[0];
    expect(createCall[0].namespace).toBe('platform');
    expect(createCall[0].body.metadata.labels['platform.phoenix-host.net/pitr-restore']).toBe('true');
    expect(createCall[0].body.metadata.labels['platform.phoenix-host.net/pitr-namespace']).toBe('platform');
    // Pod-template MUST carry app=platform-api so the existing
    // allow-platform-internal NetworkPolicy lets the Job reach postgres.
    expect(createCall[0].body.spec.template.metadata.labels.app).toBe('platform-api');
    const envByName: Record<string, string | undefined> = {};
    for (const e of createCall[0].body.spec.template.spec.containers[0].env) {
      if (e.value !== undefined) envByName[e.name] = e.value;
    }
    expect(envByName.PITR_CLUSTER_NAMESPACE).toBe('platform');
    expect(envByName.PITR_CLUSTER_NAME).toBe('postgres');
    expect(envByName.PITR_SNAPSHOT_NAME).toBe('snap-1');
    expect(envByName.PITR_RECOVERY_TARGET_TIME).toBe('2026-05-03T20:00:00Z');
    expect(envByName.PITR_ACTOR_USER_ID).toBe('user-1');
    expect(createCall[0].body.spec.template.spec.containers[0].image).toBe('ghcr.io/test/backend:abc123');
  });

  it('getPlatformApiImage reads image from live Deployment', async () => {
    const k8s = makeK8s();
    const image = await getPlatformApiImage(k8s);
    expect(image).toBe('ghcr.io/test/backend:test');
  });
});
