/**
 * Unit tests for wal-archive.ts (Barman Cloud Plugin path).
 *
 * Strategy: pass a fake K8sClients with vitest-spy custom client methods
 * + a fake Database that captures inserts. Asserts the EXACT API calls
 * (group/version/plural/name/body) the module makes — that's what
 * could regress and break the live cluster wiring.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  enableWalArchive,
  disableWalArchive,
  buildDestinationPath,
  extractStatus,
  BARMAN_GROUP,
  BARMAN_VERSION,
  BARMAN_PLUGIN_NAME,
  CNPG_GROUP,
  CNPG_VERSION,
} from './wal-archive.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

interface CapturedCall {
  readonly verb: 'get' | 'create' | 'patch' | 'delete';
  readonly group: string;
  readonly version: string;
  readonly namespace: string;
  readonly plural: string;
  readonly name?: string;
  readonly body?: unknown;
}

function makeK8sStub(opts: {
  clusterExists?: boolean;
  objectStoreExists?: boolean;
  scheduledBackupExists?: boolean;
  // Pre-existing plugins on the cluster (to test merge-not-clobber).
  existingPlugins?: ReadonlyArray<{ name?: string; isWALArchiver?: boolean; parameters?: Record<string, string> }>;
  // Pre-existing Postgres parameters (to test merge-not-clobber).
  existingPgParameters?: Readonly<Record<string, string>>;
}): { k8s: K8sClients; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];

  // Notes:
  //  - The first GET (cluster) drives readClusterCR. We always return a
  //    valid CR so enableWalArchive doesn't bail.
  //  - upsertObjectStore + upsertScheduledBackup do GET → 404 → CREATE
  //    OR GET → ok → PATCH. Driven by opts.
  const customStub = {
    getNamespacedCustomObject: vi.fn(async (a: { group: string; version: string; namespace: string; plural: string; name: string }) => {
      calls.push({ verb: 'get', group: a.group, version: a.version, namespace: a.namespace, plural: a.plural, name: a.name });
      // Cluster reads: always succeed (the cluster exists in our scenarios)
      if (a.group === CNPG_GROUP && a.plural === 'clusters') {
        if (opts.clusterExists === false) {
          throw Object.assign(new Error('not found'), { code: 404, response: { statusCode: 404 } });
        }
        return {
          spec: {
            ...(opts.existingPlugins ? { plugins: opts.existingPlugins } : {}),
            ...(opts.existingPgParameters ? { postgresql: { parameters: opts.existingPgParameters } } : {}),
          },
          status: { conditions: [] },
        };
      }
      // ObjectStore exists?
      if (a.group === BARMAN_GROUP && a.plural === 'objectstores') {
        if (opts.objectStoreExists) return { spec: {} };
        throw Object.assign(new Error('not found'), { code: 404, response: { statusCode: 404 } });
      }
      // ScheduledBackup exists?
      if (a.group === CNPG_GROUP && a.plural === 'scheduledbackups') {
        if (opts.scheduledBackupExists) return { spec: {} };
        throw Object.assign(new Error('not found'), { code: 404, response: { statusCode: 404 } });
      }
      throw Object.assign(new Error('not found'), { code: 404, response: { statusCode: 404 } });
    }),
    createNamespacedCustomObject: vi.fn(async (a: { group: string; version: string; namespace: string; plural: string; body: unknown }) => {
      calls.push({ verb: 'create', group: a.group, version: a.version, namespace: a.namespace, plural: a.plural, body: a.body });
      return {};
    }),
    patchNamespacedCustomObject: vi.fn(async (a: { group: string; version: string; namespace: string; plural: string; name: string; body: unknown }) => {
      calls.push({ verb: 'patch', group: a.group, version: a.version, namespace: a.namespace, plural: a.plural, name: a.name, body: a.body });
      return {};
    }),
    deleteNamespacedCustomObject: vi.fn(async (a: { group: string; version: string; namespace: string; plural: string; name: string }) => {
      calls.push({ verb: 'delete', group: a.group, version: a.version, namespace: a.namespace, plural: a.plural, name: a.name });
      return {};
    }),
  };

  const k8s = {
    custom: customStub,
  } as unknown as K8sClients;

  return { k8s, calls };
}

function makeDbStub(opts: {
  activeS3Target?: {
    id: string; storageType: string; s3Bucket: string | null; s3Prefix: string | null;
    s3Endpoint: string | null; s3Region: string | null; active: boolean | null; name: string | null;
  };
  // Pre-existing systemWalArchiveState row to simulate a re-enable.
  priorState?: { targetConfigId: string; destinationPath: string; retentionDays: number };
} = {}): {
  db: Parameters<typeof enableWalArchive>[0]['db'];
  inserts: { values: unknown }[];
  deletes: { count: number }[];
  // Counter is a getter so the test sees the updated value after
  // enableWalArchive runs (destructuring captures values, not refs).
  readonly state: { advisoryLocks: number };
} {
  const inserts: { values: unknown }[] = [];
  const deletes: { count: number }[] = [];
  const state = { advisoryLocks: 0 };
  const activeS3Target = opts.activeS3Target ?? {
    id: 'cfg-1', storageType: 's3', s3Bucket: 'staging-bucket',
    s3Prefix: 'platform', s3Endpoint: 'https://s3.example.com',
    s3Region: 'eu-west-1', active: true, name: 'primary-s3',
  };

  // Drizzle's chainable builders return objects with a known set of
  // methods at each step. We don't need the table identity here —
  // assertions check that *some* row was inserted/deleted, not which
  // table got it. Keeps the stub simple + decoupled from drizzle internals.
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => [activeS3Target],
        }),
      }),
    }),
    transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn({
      execute: async () => { state.advisoryLocks++; },
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => opts.priorState ? [opts.priorState] : [],
          }),
        }),
      }),
      insert: () => ({
        values: (vals: unknown) => ({
          // Some call sites use .values(...).onConflictDoUpdate(...);
          // others just await the values() promise.
          onConflictDoUpdate: async () => { inserts.push({ values: vals }); },
          async then(resolve: (v: unknown) => unknown) {
            inserts.push({ values: vals });
            resolve(undefined);
          },
        }),
      }),
      delete: () => ({
        where: async () => { deletes.push({ count: 1 }); },
      }),
    }),
  } as unknown as Parameters<typeof enableWalArchive>[0]['db'];

  return { db, inserts, deletes, state };
}

describe('buildDestinationPath', () => {
  it('joins prefix + ns-cluster suffix', () => {
    expect(buildDestinationPath(
      { id: '1', storageType: 's3', s3Bucket: 'b', s3Prefix: 'top', s3Endpoint: null, s3Region: null, active: true, name: null },
      'platform', 'system-db',
    )).toBe('s3://b/top/wal-archive/platform-system-db');
  });
  it('handles null prefix', () => {
    expect(buildDestinationPath(
      { id: '1', storageType: 's3', s3Bucket: 'b', s3Prefix: null, s3Endpoint: null, s3Region: null, active: true, name: null },
      'mail', 'mail-db',
    )).toBe('s3://b/wal-archive/mail-mail-db');
  });
  it('strips leading/trailing slashes from prefix', () => {
    expect(buildDestinationPath(
      { id: '1', storageType: 's3', s3Bucket: 'b', s3Prefix: '//op///', s3Endpoint: null, s3Region: null, active: true, name: null },
      'mail', 'mail-db',
    )).toBe('s3://b/op/wal-archive/mail-mail-db');
  });
});

describe('extractStatus', () => {
  it('returns null for null cr', () => {
    expect(extractStatus(null)).toBeNull();
  });
  it('maps ContinuousArchiving=True to healthy', () => {
    const s = extractStatus({
      status: {
        firstRecoverabilityPoint: '2026-05-07T10:00:00Z',
        conditions: [{ type: 'ContinuousArchiving', status: 'True', reason: 'ContinuousArchivingSuccess', lastTransitionTime: '2026-05-07T10:01:00Z' }],
      },
    });
    expect(s?.lastArchivedWal).toBe('ContinuousArchivingSuccess');
    expect(s?.lastArchivedWalTime).toBe('2026-05-07T10:01:00Z');
    expect(s?.lastFailedArchiveTime).toBeNull();
    expect(s?.firstRecoverabilityPoint).toBe('2026-05-07T10:00:00Z');
  });
  it('maps ContinuousArchiving=False to failing', () => {
    const s = extractStatus({
      status: {
        conditions: [{ type: 'ContinuousArchiving', status: 'False', reason: 'ContinuousArchivingFailing', message: 's3: connection refused', lastTransitionTime: '2026-05-07T10:02:00Z' }],
      },
    });
    expect(s?.lastArchivedWal).toBeNull();
    expect(s?.lastFailedArchiveTime).toBe('2026-05-07T10:02:00Z');
    expect(s?.lastFailedArchiveError).toBe('s3: connection refused');
  });
});

describe('enableWalArchive — plugin model', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates ObjectStore + Cluster.spec.plugins[] + ScheduledBackup', async () => {
    const { k8s, calls } = makeK8sStub({});
    const { db, inserts } = makeDbStub();

    const result = await enableWalArchive({
      db, k8s,
      clusterNamespace: 'platform',
      clusterName: 'system-db',
      targetConfigId: 'cfg-1',
      retentionDays: 30,
      operatorUserId: 'admin',
      operatorIp: '10.0.0.1',
      archiveTimeout: '5min',
      baseBackupSchedule: '0 0 3 * * *',
      baseBackupRetentionDays: 30,
    });

    expect(result.destinationPath).toBe('s3://staging-bucket/platform/wal-archive/platform-system-db');

    // 1. Cluster READ (readClusterCR)
    const clusterRead = calls.find((c) => c.verb === 'get' && c.plural === 'clusters');
    expect(clusterRead?.name).toBe('system-db');

    // 2. ObjectStore CREATE (didn't exist)
    const objectStoreCreate = calls.find((c) => c.verb === 'create' && c.plural === 'objectstores');
    expect(objectStoreCreate).toBeDefined();
    expect(objectStoreCreate?.group).toBe(BARMAN_GROUP);
    expect(objectStoreCreate?.version).toBe(BARMAN_VERSION);
    const osBody = objectStoreCreate?.body as { metadata: { name: string; namespace: string }; spec: { configuration: { destinationPath: string; endpointURL?: string; s3Credentials: unknown; wal: unknown; data: unknown }; retentionPolicy: string } };
    expect(osBody.metadata.name).toBe('system-db-system-store');
    expect(osBody.metadata.namespace).toBe('platform');
    expect(osBody.spec.configuration.destinationPath).toBe('s3://staging-bucket/platform/wal-archive/platform-system-db');
    expect(osBody.spec.configuration.endpointURL).toBe('https://s3.example.com');
    expect(osBody.spec.retentionPolicy).toBe('30d');

    // 3. Cluster PATCH with spec.plugins[]
    const clusterPatch = calls.find((c) => c.verb === 'patch' && c.plural === 'clusters');
    expect(clusterPatch).toBeDefined();
    const patchBody = clusterPatch?.body as { spec: { plugins: Array<{ name: string; isWALArchiver: boolean; parameters: { barmanObjectName: string } }>; postgresql?: unknown } };
    expect(patchBody.spec.plugins).toHaveLength(1);
    expect(patchBody.spec.plugins[0].name).toBe(BARMAN_PLUGIN_NAME);
    expect(patchBody.spec.plugins[0].isWALArchiver).toBe(true);
    expect(patchBody.spec.plugins[0].parameters.barmanObjectName).toBe('system-db-system-store');
    expect(patchBody.spec.postgresql).toBeDefined();

    // 4. ScheduledBackup CREATE with method=plugin
    const sbCreate = calls.find((c) => c.verb === 'create' && c.plural === 'scheduledbackups');
    expect(sbCreate).toBeDefined();
    const sbBody = sbCreate?.body as { spec: { method: string; pluginConfiguration: { name: string }; schedule: string } };
    expect(sbBody.spec.method).toBe('plugin');
    expect(sbBody.spec.pluginConfiguration.name).toBe(BARMAN_PLUGIN_NAME);
    expect(sbBody.spec.schedule).toBe('0 0 3 * * *');

    // 5. DB writes captured (state row + audit log row)
    expect(inserts.length).toBe(2);
  });

  it('PATCHES ObjectStore + ScheduledBackup when they already exist (re-enable path)', async () => {
    const { k8s, calls } = makeK8sStub({ objectStoreExists: true, scheduledBackupExists: true });
    const { db } = makeDbStub();

    await enableWalArchive({
      db, k8s,
      clusterNamespace: 'mail', clusterName: 'mail-db',
      targetConfigId: 'cfg-1', retentionDays: 14,
      operatorUserId: 'admin', operatorIp: null,
      baseBackupSchedule: '0 0 4 * * *',
    });

    // ObjectStore PATCH (not CREATE)
    const osCalls = calls.filter((c) => c.plural === 'objectstores');
    expect(osCalls.find((c) => c.verb === 'patch')).toBeDefined();
    expect(osCalls.find((c) => c.verb === 'create')).toBeUndefined();

    // ScheduledBackup PATCH (not CREATE), and it sets method=plugin
    // (covers the legacy in-tree → plugin migration where an old SB CR
    // had method=barmanObjectStore).
    const sbCalls = calls.filter((c) => c.plural === 'scheduledbackups');
    const sbPatch = sbCalls.find((c) => c.verb === 'patch');
    expect(sbPatch).toBeDefined();
    const sbBody = sbPatch?.body as { spec: { method?: string; pluginConfiguration?: { name: string } } };
    expect(sbBody.spec.method).toBe('plugin');
    expect(sbBody.spec.pluginConfiguration?.name).toBe(BARMAN_PLUGIN_NAME);
  });

  it('skips ScheduledBackup when baseBackupSchedule omitted', async () => {
    const { k8s, calls } = makeK8sStub({});
    const { db } = makeDbStub();

    await enableWalArchive({
      db, k8s,
      clusterNamespace: 'platform', clusterName: 'system-db',
      targetConfigId: 'cfg-1', retentionDays: 30,
      operatorUserId: 'admin', operatorIp: null,
      // baseBackupSchedule omitted
    });

    // No SB create. Object store + plugin patch still happen.
    expect(calls.find((c) => c.verb === 'create' && c.plural === 'scheduledbackups')).toBeUndefined();
    expect(calls.find((c) => c.verb === 'create' && c.plural === 'objectstores')).toBeDefined();
  });

  it('rejects non-S3 storage targets', async () => {
    const { k8s } = makeK8sStub({});
    const { db } = makeDbStub({
      activeS3Target: {
        id: 'cfg-1', storageType: 'sftp', s3Bucket: null, s3Prefix: null,
        s3Endpoint: null, s3Region: null, active: true, name: 'sftp-target',
      },
    });

    await expect(enableWalArchive({
      db, k8s,
      clusterNamespace: 'mail', clusterName: 'mail-db',
      targetConfigId: 'cfg-1', retentionDays: 14,
      operatorUserId: 'admin', operatorIp: null,
    })).rejects.toThrow(/s3/i);
  });

  it('preserves OTHER plugins and Postgres parameters across enable (read-merge-write)', async () => {
    // Pre-existing state: cluster already has an audit plugin and
    // max_connections GUC set by some other feature. Enabling WAL
    // archive must NOT silently drop them.
    const { k8s, calls } = makeK8sStub({
      existingPlugins: [{ name: 'audit.example/plugin', isWALArchiver: false, parameters: { mode: 'verbose' } }],
      existingPgParameters: { max_connections: '200', shared_buffers: '256MB' },
    });
    const { db } = makeDbStub();

    await enableWalArchive({
      db, k8s,
      clusterNamespace: 'platform', clusterName: 'system-db',
      targetConfigId: 'cfg-1', retentionDays: 30,
      operatorUserId: 'admin', operatorIp: null,
      archiveTimeout: '5min',
      baseBackupSchedule: '0 0 3 * * *',
    });

    const clusterPatch = calls.find((c) => c.verb === 'patch' && c.plural === 'clusters');
    const body = clusterPatch?.body as {
      spec: {
        plugins: Array<{ name?: string; parameters?: Record<string, string> }>;
        postgresql?: { parameters: Record<string, string> };
      };
    };

    // plugins[]: audit plugin survives, barman appended.
    expect(body.spec.plugins).toHaveLength(2);
    expect(body.spec.plugins.find((p) => p.name === 'audit.example/plugin')).toBeDefined();
    expect(body.spec.plugins.find((p) => p.name === BARMAN_PLUGIN_NAME)).toBeDefined();

    // postgresql.parameters: existing GUCs survive, archive_timeout added.
    expect(body.spec.postgresql?.parameters.max_connections).toBe('200');
    expect(body.spec.postgresql?.parameters.shared_buffers).toBe('256MB');
    expect(body.spec.postgresql?.parameters.archive_timeout).toBe('5min');
  });

  it('rejects inactive backup configurations', async () => {
    const { k8s } = makeK8sStub({});
    const { db } = makeDbStub({
      activeS3Target: {
        id: 'cfg-1', storageType: 's3', s3Bucket: 'b', s3Prefix: null,
        s3Endpoint: null, s3Region: null, active: false, name: 'inactive',
      },
    });

    await expect(enableWalArchive({
      db, k8s,
      clusterNamespace: 'platform', clusterName: 'system-db',
      targetConfigId: 'cfg-1', retentionDays: 30,
      operatorUserId: 'admin', operatorIp: null,
    })).rejects.toThrow(/not active/);
  });

  it('takes pg_advisory_xact_lock + records previous state in audit changes (re-enable)', async () => {
    const { k8s } = makeK8sStub({});
    const { db, inserts, state } = makeDbStub({
      priorState: {
        targetConfigId: 'cfg-OLD',
        destinationPath: 's3://old-bucket/wal-archive/platform-system-db',
        retentionDays: 7,
      },
    });

    await enableWalArchive({
      db, k8s,
      clusterNamespace: 'platform', clusterName: 'system-db',
      targetConfigId: 'cfg-1', retentionDays: 30,
      operatorUserId: 'admin', operatorIp: null,
    });

    expect(state.advisoryLocks).toBe(1);

    // The audit-log insert is the SECOND insert (after the state row).
    const auditInsert = inserts[1];
    expect(auditInsert).toBeDefined();
    const audit = auditInsert?.values as { changes?: { previousTargetConfigId?: string; previousDestinationPath?: string; previousRetentionDays?: number } };
    expect(audit.changes?.previousTargetConfigId).toBe('cfg-OLD');
    expect(audit.changes?.previousDestinationPath).toBe('s3://old-bucket/wal-archive/platform-system-db');
    expect(audit.changes?.previousRetentionDays).toBe(7);
  });

  it('records null previous-state on first-ever enable (no prior row)', async () => {
    const { k8s } = makeK8sStub({});
    const { db, inserts } = makeDbStub({ /* no priorState */ });

    await enableWalArchive({
      db, k8s,
      clusterNamespace: 'platform', clusterName: 'system-db',
      targetConfigId: 'cfg-1', retentionDays: 30,
      operatorUserId: 'admin', operatorIp: null,
    });

    const audit = inserts[1]?.values as { changes?: { previousTargetConfigId?: string | null; previousDestinationPath?: string | null } };
    expect(audit.changes?.previousTargetConfigId).toBeNull();
    expect(audit.changes?.previousDestinationPath).toBeNull();
  });
});

describe('disableWalArchive — plugin teardown', () => {
  beforeEach(() => vi.clearAllMocks());

  it('detaches plugin from Cluster + deletes ScheduledBackup + ObjectStore', async () => {
    const { k8s, calls } = makeK8sStub({});
    const { db, deletes } = makeDbStub();

    await disableWalArchive({
      db, k8s,
      clusterNamespace: 'mail', clusterName: 'mail-db',
      operatorUserId: 'admin', operatorIp: null,
    });

    // Plugin detach: PATCH cluster with spec.plugins=[]
    const clusterPatch = calls.find((c) => c.verb === 'patch' && c.plural === 'clusters');
    expect(clusterPatch).toBeDefined();
    const body = clusterPatch?.body as { spec: { plugins: unknown[] } };
    expect(body.spec.plugins).toEqual([]);

    // SB + OS deletes
    expect(calls.find((c) => c.verb === 'delete' && c.plural === 'scheduledbackups' && c.name === 'mail-db-system-backup')).toBeDefined();
    expect(calls.find((c) => c.verb === 'delete' && c.plural === 'objectstores' && c.name === 'mail-db-system-store')).toBeDefined();

    // DB delete + audit log insert
    expect(deletes.length).toBeGreaterThanOrEqual(1);
  });

  it('preserves OTHER plugins on disable (drops only barman entry)', async () => {
    const { k8s, calls } = makeK8sStub({
      existingPlugins: [
        { name: 'audit.example/plugin', isWALArchiver: false, parameters: { mode: 'verbose' } },
        { name: BARMAN_PLUGIN_NAME, isWALArchiver: true, parameters: { barmanObjectName: 'system-db-system-store' } },
      ],
    });
    const { db } = makeDbStub();

    await disableWalArchive({
      db, k8s,
      clusterNamespace: 'platform', clusterName: 'system-db',
      operatorUserId: 'admin', operatorIp: null,
    });

    const clusterPatch = calls.find((c) => c.verb === 'patch' && c.plural === 'clusters');
    const body = clusterPatch?.body as { spec: { plugins: Array<{ name?: string }> } };
    expect(body.spec.plugins).toHaveLength(1);
    expect(body.spec.plugins[0].name).toBe('audit.example/plugin');
  });

  it('tolerates 404 when SB or OS already gone', async () => {
    // makeK8sStub returns 404 by default for delete probes in this branch
    // because we route through deleteNamespacedCustomObject directly.
    // We simulate "already gone" by overriding delete to throw 404.
    const { k8s, calls } = makeK8sStub({});
    const customStub = (k8s as unknown as { custom: { deleteNamespacedCustomObject: ReturnType<typeof vi.fn> } }).custom;
    customStub.deleteNamespacedCustomObject.mockImplementationOnce(async () => {
      throw Object.assign(new Error('not found'), { code: 404, response: { statusCode: 404 } });
    });
    customStub.deleteNamespacedCustomObject.mockImplementationOnce(async () => {
      throw Object.assign(new Error('not found'), { code: 404, response: { statusCode: 404 } });
    });

    const { db } = makeDbStub();
    // Should NOT throw — disableWalArchive swallows 404s from each delete.
    await disableWalArchive({
      db, k8s,
      clusterNamespace: 'platform', clusterName: 'system-db',
      operatorUserId: 'admin', operatorIp: null,
    });

    // Cluster patch still happens.
    expect(calls.find((c) => c.verb === 'patch' && c.plural === 'clusters')).toBeDefined();
  });
});
