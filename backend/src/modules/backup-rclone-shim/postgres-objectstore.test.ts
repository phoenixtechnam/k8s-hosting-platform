/**
 * Unit tests for backup-rclone-shim postgres-objectstore.ts (R-X6).
 *
 * Covers:
 *   - Constants match RFC §12 + the database.yaml plugin block
 *   - buildObjectStoreSpec emits the documented shape (endpointURL,
 *     Secret refs, retention)
 *   - buildScheduledBackupSpec includes pluginConfiguration +
 *     suspend toggle
 *   - reconcilePostgresObjectStore happy path: applies 3 resources
 *     in dependency order (Secret → ObjectStore → ScheduledBackup)
 *   - reconcilePostgresObjectStore key-missing path: short-circuits
 *     without calling the apiserver
 *   - reconcilePostgresObjectStore suspend path: when SYSTEM target
 *     unassigned, ScheduledBackup is created with suspend=true
 *
 * The DB is fakeDb-style (returning canned rows); the k8s SDK is
 * vi.fn() mocked. We exercise the orchestration logic, not the
 * apiserver round-trip.
 */

import { describe, expect, it, vi } from 'vitest';

// ─── Mock the BACKUP_TARGET_KEY loader ───────────────────────────
// The reconciler imports loadBackupTargetKey from ./service.js.
// We mock the WHOLE service module so the test doesn't try to read
// a real k8s Secret.

vi.mock('./service.js', async () => {
  const actual = await vi.importActual<typeof import('./service.js')>('./service.js');
  return {
    ...actual,
    loadBackupTargetKey: vi.fn(async () => ({
      rawKey: Buffer.alloc(32, 1),
      fingerprint: '11'.repeat(8),
      generatedAt: '2026-05-20T00:00:00Z',
    })),
  };
});

import {
  DEFAULT_BACKUP_SCHEDULE,
  DEFAULT_RETENTION_POLICY,
  POSTGRES_NAMESPACE,
  POSTGRES_CLUSTER_NAME,
  POSTGRES_OBJECT_STORE_NAME,
  POSTGRES_SCHEDULED_BACKUP_NAME,
  SHIM_S3_CREDS_SECRET_NAME,
  SHIM_S3_ENDPOINT_URL,
  BARMAN_PLUGIN_NAME,
  reconcilePostgresObjectStore,
} from './postgres-objectstore.js';
import { ShimKeyMissingError } from './service.js';
import * as service from './service.js';
import type { Database } from '../../db/index.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe('postgres-objectstore constants', () => {
  it('binds resources to the platform namespace (where system-db lives)', () => {
    expect(POSTGRES_NAMESPACE).toBe('platform');
    expect(POSTGRES_CLUSTER_NAME).toBe('system-db');
  });

  it('uses the documented CR names per RFC §12', () => {
    expect(POSTGRES_OBJECT_STORE_NAME).toBe('system-postgres-objectstore');
    expect(POSTGRES_SCHEDULED_BACKUP_NAME).toBe('system-db-scheduled-backup');
    expect(SHIM_S3_CREDS_SECRET_NAME).toBe('backup-rclone-shim-creds');
  });

  it('points the shim endpoint at the platform-ns ClusterIP on port 9000', () => {
    expect(SHIM_S3_ENDPOINT_URL).toBe(
      'http://backup-rclone-shim.platform.svc.cluster.local:9000',
    );
  });

  it('plugin name matches what the vendored manifest registers', () => {
    expect(BARMAN_PLUGIN_NAME).toBe('barman-cloud.cloudnative-pg.io');
  });

  it('default schedule is 03:00 UTC + 30-day retention', () => {
    expect(DEFAULT_BACKUP_SCHEDULE).toBe('0 0 3 * * *');
    expect(DEFAULT_RETENTION_POLICY).toBe('30d');
  });
});

// ---------------------------------------------------------------------------
// Test fakes
// ---------------------------------------------------------------------------

interface FakeRow {
  targetId: string;
  storageType: string;
  enabled: number;
}

function fakeDb(rows: FakeRow[]): Database {
  const chain: Record<string, unknown> = {};
  for (const m of ['from', 'where', 'innerJoin', 'leftJoin', 'orderBy', 'limit']) {
    chain[m] = vi.fn(() => chain);
  }
  chain.then = (resolve: (rows: FakeRow[]) => unknown) => Promise.resolve(rows).then(resolve);
  return {
    select: vi.fn(() => chain),
  } as unknown as Database;
}

function fakeClients() {
  return {
    core: {
      readNamespacedSecret: vi.fn().mockRejectedValue({ statusCode: 404 }),
      createNamespacedSecret: vi.fn().mockResolvedValue({}),
      patchNamespacedSecret: vi.fn().mockResolvedValue({}),
    },
    custom: {
      // Default: ObjectStore + ScheduledBackup not present (404 → create).
      // The reconciler ALSO calls getNamespacedCustomObject for the
      // Cluster CR in patchClusterWalArchiver. Caller can override
      // this default via mockResolvedValueOnce ordering.
      getNamespacedCustomObject: vi.fn().mockImplementation(async (args: { plural?: string }) => {
        if (args.plural === 'clusters') {
          return {
            spec: {
              plugins: [
                {
                  name: 'barman-cloud.cloudnative-pg.io',
                  parameters: { barmanObjectName: 'system-postgres-objectstore' },
                },
              ],
            },
          };
        }
        const err: { statusCode: number } = { statusCode: 404 };
        throw err;
      }),
      createNamespacedCustomObject: vi.fn().mockResolvedValue({}),
      patchNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    },
  };
}

function silentLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

// ---------------------------------------------------------------------------
// reconcilePostgresObjectStore — happy path
// ---------------------------------------------------------------------------

describe('reconcilePostgresObjectStore — happy path', () => {
  it('creates Secret + ObjectStore + ScheduledBackup when SYSTEM is bound', async () => {
    const db = fakeDb([
      { targetId: 't-1', storageType: 's3', enabled: 1 },
    ]);
    const clients = fakeClients();
    const r = await reconcilePostgresObjectStore(db, clients as never, silentLog());

    expect(r.state).toBe('STATE_OK');
    expect(r.credentialsSecretApplied).toBe(true);
    expect(r.objectStoreApplied).toBe(true);
    expect(r.scheduledBackupApplied).toBe(true);
    expect(r.scheduledBackupSuspended).toBe(false);
    expect(r.walArchiverEnabled).toBe(true);
    expect(clients.core.createNamespacedSecret).toHaveBeenCalledTimes(1);
    expect(clients.custom.createNamespacedCustomObject).toHaveBeenCalledTimes(2);
  });

  it('patches Cluster CR isWALArchiver to true when SYSTEM is bound', async () => {
    const db = fakeDb([{ targetId: 't-1', storageType: 's3', enabled: 1 }]);
    const clients = fakeClients();
    await reconcilePostgresObjectStore(db, clients as never, silentLog());

    const clusterPatchCall = clients.custom.patchNamespacedCustomObject.mock.calls.find(
      (c) => (c[0] as { plural?: string }).plural === 'clusters',
    );
    expect(clusterPatchCall).toBeDefined();
    const body = (clusterPatchCall![0] as { body: Array<{ op: string; path: string; value: unknown }> }).body;
    // Reconciler tries `replace` first; mock returns 200 so no fallback
    // to `add` happens here. The 422-fallback path is covered by the
    // explicit test below.
    expect(body[0]).toMatchObject({
      op: 'replace',
      path: '/spec/plugins/0/isWALArchiver',
      value: true,
    });
  });

  it('falls back to `add` op when Cluster patch returns 422 (path missing)', async () => {
    const db = fakeDb([{ targetId: 't-1', storageType: 's3', enabled: 1 }]);
    const clients = fakeClients();
    let callIdx = 0;
    clients.custom.patchNamespacedCustomObject.mockImplementation(async (args: { plural?: string }) => {
      if (args.plural === 'clusters') {
        callIdx += 1;
        if (callIdx === 1) throw { statusCode: 422 };
        return {};
      }
      return {};
    });
    await reconcilePostgresObjectStore(db, clients as never, silentLog());

    const clusterCalls = clients.custom.patchNamespacedCustomObject.mock.calls.filter(
      (c) => (c[0] as { plural?: string }).plural === 'clusters',
    );
    expect(clusterCalls).toHaveLength(2);
    // Second call: `add` retry.
    const retryBody = (clusterCalls[1][0] as { body: Array<{ op: string; value: unknown }> }).body;
    expect(retryBody[0].op).toBe('add');
    expect(retryBody[0].value).toBe(true);
  });

  it('renders the ObjectStore CR with shim endpoint + secret refs', async () => {
    const db = fakeDb([
      { targetId: 't-1', storageType: 's3', enabled: 1 },
    ]);
    const clients = fakeClients();
    await reconcilePostgresObjectStore(db, clients as never, silentLog());

    const objectStoreCall = clients.custom.createNamespacedCustomObject.mock.calls.find(
      (c) => (c[0] as { plural?: string }).plural === 'objectstores',
    );
    expect(objectStoreCall).toBeDefined();
    const body = (objectStoreCall![0] as { body: Record<string, unknown> }).body;
    expect((body.spec as Record<string, unknown>).configuration).toMatchObject({
      destinationPath: 's3://system/postgres',
      endpointURL: SHIM_S3_ENDPOINT_URL,
      s3Credentials: {
        accessKeyId: { name: SHIM_S3_CREDS_SECRET_NAME, key: 'access_key' },
        secretAccessKey: { name: SHIM_S3_CREDS_SECRET_NAME, key: 'secret_key' },
      },
      wal: { compression: 'gzip', maxParallel: 8 },
      data: { compression: 'gzip' },
    });
    expect((body.spec as Record<string, unknown>).retentionPolicy).toBe('30d');
  });

  it('renders the ScheduledBackup CR with plugin method + cluster ref', async () => {
    const db = fakeDb([
      { targetId: 't-1', storageType: 's3', enabled: 1 },
    ]);
    const clients = fakeClients();
    await reconcilePostgresObjectStore(db, clients as never, silentLog());

    const sbCall = clients.custom.createNamespacedCustomObject.mock.calls.find(
      (c) => (c[0] as { plural?: string }).plural === 'scheduledbackups',
    );
    expect(sbCall).toBeDefined();
    const body = (sbCall![0] as { body: Record<string, unknown> }).body;
    expect((body.spec as Record<string, unknown>).method).toBe('plugin');
    expect((body.spec as Record<string, unknown>).pluginConfiguration).toMatchObject({
      name: BARMAN_PLUGIN_NAME,
      parameters: { barmanObjectName: POSTGRES_OBJECT_STORE_NAME },
    });
    expect((body.spec as Record<string, unknown>).cluster).toMatchObject({
      name: POSTGRES_CLUSTER_NAME,
    });
    expect((body.spec as Record<string, unknown>).suspend).toBe(false);
  });

  it('writes Secret data fields access_key + secret_key (base64)', async () => {
    const db = fakeDb([{ targetId: 't-1', storageType: 's3', enabled: 1 }]);
    const clients = fakeClients();
    await reconcilePostgresObjectStore(db, clients as never, silentLog());

    const secretCall = clients.core.createNamespacedSecret.mock.calls[0];
    expect(secretCall).toBeDefined();
    const body = (secretCall[0] as { body: { data: Record<string, string> } }).body;
    expect(body.data).toHaveProperty('access_key');
    expect(body.data).toHaveProperty('secret_key');
    expect(body.data.access_key).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(body.data.secret_key).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });
});

// ---------------------------------------------------------------------------
// reconcilePostgresObjectStore — suspend path
// ---------------------------------------------------------------------------

describe('reconcilePostgresObjectStore — no SYSTEM target', () => {
  it('still applies Secret + ObjectStore but marks ScheduledBackup suspended', async () => {
    const db = fakeDb([]);
    const clients = fakeClients();
    const r = await reconcilePostgresObjectStore(db, clients as never, silentLog());

    expect(r.state).toBe('STATE_NO_SYSTEM_TARGET');
    expect(r.credentialsSecretApplied).toBe(true);
    expect(r.scheduledBackupSuspended).toBe(true);
    expect(r.walArchiverEnabled).toBe(false);

    const sbCall = clients.custom.createNamespacedCustomObject.mock.calls.find(
      (c) => (c[0] as { plural?: string }).plural === 'scheduledbackups',
    );
    const body = (sbCall![0] as { body: Record<string, unknown> }).body;
    expect((body.spec as Record<string, unknown>).suspend).toBe(true);
  });

  it('flips Cluster isWALArchiver to false when SYSTEM unassigned', async () => {
    const db = fakeDb([]);
    const clients = fakeClients();
    // Pretend the Cluster CR already has isWALArchiver=true (from a
    // previous reconcile when SYSTEM was bound). Reconciler must
    // patch it back to false.
    clients.custom.getNamespacedCustomObject.mockImplementation(async (args: { plural?: string }) => {
      if (args.plural === 'clusters') {
        return {
          spec: {
            plugins: [
              {
                name: 'barman-cloud.cloudnative-pg.io',
                isWALArchiver: true,
                parameters: { barmanObjectName: 'system-postgres-objectstore' },
              },
            ],
          },
        };
      }
      throw { statusCode: 404 };
    });
    await reconcilePostgresObjectStore(db, clients as never, silentLog());

    const clusterPatchCall = clients.custom.patchNamespacedCustomObject.mock.calls.find(
      (c) => (c[0] as { plural?: string }).plural === 'clusters',
    );
    expect(clusterPatchCall).toBeDefined();
    const body = (clusterPatchCall![0] as { body: Array<{ op: string; value: unknown }> }).body;
    expect(body[0].op).toBe('replace');
    expect(body[0].value).toBe(false);
  });

  it('skips Cluster patch when value is already at desired state (idempotent)', async () => {
    const db = fakeDb([]);
    const clients = fakeClients();
    // Cluster CR already shows isWALArchiver=false — should be a no-op.
    clients.custom.getNamespacedCustomObject.mockImplementation(async (args: { plural?: string }) => {
      if (args.plural === 'clusters') {
        return {
          spec: {
            plugins: [
              {
                name: 'barman-cloud.cloudnative-pg.io',
                isWALArchiver: false,
                parameters: { barmanObjectName: 'system-postgres-objectstore' },
              },
            ],
          },
        };
      }
      throw { statusCode: 404 };
    });
    await reconcilePostgresObjectStore(db, clients as never, silentLog());

    const clusterPatchCall = clients.custom.patchNamespacedCustomObject.mock.calls.find(
      (c) => (c[0] as { plural?: string }).plural === 'clusters',
    );
    expect(clusterPatchCall).toBeUndefined();
  });

  it('skips Cluster patch when Cluster CR is 404 (Flux not yet synced)', async () => {
    const db = fakeDb([{ targetId: 't-1', storageType: 's3', enabled: 1 }]);
    const clients = fakeClients();
    clients.custom.getNamespacedCustomObject.mockImplementation(async (args: { plural?: string }) => {
      if (args.plural === 'clusters') throw { statusCode: 404 };
      throw { statusCode: 404 };
    });
    const r = await reconcilePostgresObjectStore(db, clients as never, silentLog());

    // ObjectStore + ScheduledBackup still get created (their plurals
    // returned 404 = "not yet exists, please create"), but the Cluster
    // patch is a no-op. State stays STATE_OK — the next tick converges.
    expect(r.state).toBe('STATE_OK');
    // walArchiverEnabled returns `true` (it's the INTENT — Flux just
    // hasn't applied the Cluster manifest yet; on next tick the patch
    // succeeds).
    expect(r.walArchiverEnabled).toBe(true);
  });

  it('ignores disabled target rows (treats them as unassigned)', async () => {
    const db = fakeDb([
      { targetId: 't-disabled', storageType: 's3', enabled: 0 },
    ]);
    const clients = fakeClients();
    const r = await reconcilePostgresObjectStore(db, clients as never, silentLog());
    expect(r.state).toBe('STATE_NO_SYSTEM_TARGET');
    expect(r.scheduledBackupSuspended).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// reconcilePostgresObjectStore — failure paths
// ---------------------------------------------------------------------------

describe('reconcilePostgresObjectStore — failure paths', () => {
  it('STATE_MISSING_KEY when BACKUP_TARGET_KEY is absent', async () => {
    const db = fakeDb([{ targetId: 't-1', storageType: 's3', enabled: 1 }]);
    const clients = fakeClients();
    // Force the mocked loader to throw ShimKeyMissingError.
    vi.mocked(service.loadBackupTargetKey).mockRejectedValueOnce(
      new ShimKeyMissingError('Secret backup-target-key not found'),
    );
    const r = await reconcilePostgresObjectStore(db, clients as never, silentLog());
    expect(r.state).toBe('STATE_MISSING_KEY');
    expect(r.objectStoreApplied).toBe(false);
    expect(r.scheduledBackupApplied).toBe(false);
    expect(clients.core.createNamespacedSecret).not.toHaveBeenCalled();
  });

  it('STATE_ERROR + early return when Secret create fails', async () => {
    const db = fakeDb([{ targetId: 't-1', storageType: 's3', enabled: 1 }]);
    const clients = fakeClients();
    clients.core.createNamespacedSecret.mockRejectedValueOnce(
      new Error('apiserver overload'),
    );
    const r = await reconcilePostgresObjectStore(db, clients as never, silentLog());
    expect(r.state).toBe('STATE_ERROR');
    expect(r.errorMessage).toContain('apiserver overload');
    expect(r.credentialsSecretApplied).toBe(false);
    expect(clients.custom.createNamespacedCustomObject).not.toHaveBeenCalled();
  });

  it('STATE_ERROR + early return when ObjectStore create fails', async () => {
    const db = fakeDb([{ targetId: 't-1', storageType: 's3', enabled: 1 }]);
    const clients = fakeClients();
    clients.custom.createNamespacedCustomObject.mockImplementationOnce(async () => {
      throw new Error('CRD not registered');
    });
    const r = await reconcilePostgresObjectStore(db, clients as never, silentLog());
    expect(r.state).toBe('STATE_ERROR');
    expect(r.errorMessage).toContain('CRD not registered');
    expect(r.credentialsSecretApplied).toBe(true);
    expect(r.objectStoreApplied).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Idempotency
// ---------------------------------------------------------------------------

describe('reconcilePostgresObjectStore — idempotency', () => {
  it('patches when the ObjectStore already exists', async () => {
    const db = fakeDb([{ targetId: 't-1', storageType: 's3', enabled: 1 }]);
    const clients = fakeClients();
    // Pretend the Secret + ObjectStore + ScheduledBackup all exist
    // already (404 → existing flip).
    clients.core.readNamespacedSecret.mockResolvedValueOnce({});
    clients.custom.getNamespacedCustomObject
      .mockResolvedValueOnce({}) // ObjectStore exists
      .mockResolvedValueOnce({}); // ScheduledBackup exists

    const r = await reconcilePostgresObjectStore(db, clients as never, silentLog());
    expect(r.state).toBe('STATE_OK');
    expect(clients.core.createNamespacedSecret).not.toHaveBeenCalled();
    expect(clients.core.patchNamespacedSecret).toHaveBeenCalled();
    expect(clients.custom.createNamespacedCustomObject).not.toHaveBeenCalled();
    // 3 patches: ObjectStore + ScheduledBackup + Cluster (the
    // isWALArchiver toggle from absent → true).
    expect(clients.custom.patchNamespacedCustomObject).toHaveBeenCalledTimes(3);
  });
});
