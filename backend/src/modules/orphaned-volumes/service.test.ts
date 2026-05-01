import { describe, it, expect, vi } from 'vitest';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { detectOrphans, deleteOrphan, purgeAllOrphans } from './service.js';

// Schema mock so the dynamic-import path inside service.ts works.
vi.mock('../../db/schema.js', () => ({
  clients: { kubernetesNamespace: 'kubernetesNamespace', companyName: 'companyName' },
}));

function makeDb(rows: ReadonlyArray<{ ns: string | null; name: string }>): Database {
  return {
    select: () => ({ from: () => Promise.resolve(rows) }),
  } as unknown as Database;
}

interface NamespaceMock { name: string; createdDaysAgo?: number }

interface MockOpts {
  pvs?: unknown[];
  namespaces?: Array<string | NamespaceMock>;
  longhornVolumes?: unknown[];
  longhornReplicas?: unknown[];
}

function makeK8s(opts: MockOpts, captures?: { deletedNamespaces: string[] }): K8sClients {
  const namespaces = (opts.namespaces ?? []).map((n) =>
    typeof n === 'string'
      ? { metadata: { name: n } }
      : {
          metadata: {
            name: n.name,
            creationTimestamp: n.createdDaysAgo !== undefined
              ? new Date(Date.now() - n.createdDaysAgo * 86400_000).toISOString()
              : undefined,
          },
        });
  return {
    core: {
      listPersistentVolume: vi.fn().mockResolvedValue({ items: opts.pvs ?? [] }),
      listNamespace: vi.fn().mockResolvedValue({ items: namespaces }),
      deletePersistentVolume: vi.fn().mockResolvedValue({}),
      deleteNamespace: vi.fn().mockImplementation(async (req: { name: string }) => {
        captures?.deletedNamespaces.push(req.name);
        return {};
      }),
    },
    custom: {
      listNamespacedCustomObject: vi.fn().mockImplementation(async (req: { plural: string }) => {
        if (req.plural === 'volumes') return { items: opts.longhornVolumes ?? [] };
        if (req.plural === 'replicas') return { items: opts.longhornReplicas ?? [] };
        return { items: [] };
      }),
      deleteNamespacedCustomObject: vi.fn().mockResolvedValue({}),
    },
  } as unknown as K8sClients;
}

describe('detectOrphans', () => {
  it('flags Released stale PV with no Longhorn backing — longhornVolumeName=null', async () => {
    // PV provisioned by a non-Longhorn driver (e.g. local-path) goes
    // Released, the namespace was deleted. We still flag it as orphan
    // but Longhorn-targeted operations (snapshot) must be a no-op.
    const k8s = makeK8s({
      pvs: [{
        metadata: { name: 'pvc-localpath-orphan' },
        spec: { claimRef: { namespace: 'gone' }, capacity: { storage: '1Gi' } },
        status: { phase: 'Released', lastTransitionTime: new Date(Date.now() - 10 * 86400_000).toISOString() },
      }],
      namespaces: [],
      longhornVolumes: [],
    });
    const db = makeDb([]);

    const r = await detectOrphans(db, k8s);
    expect(r.totalCount).toBe(1);
    expect(r.orphans[0]).toMatchObject({
      pvName: 'pvc-localpath-orphan',
      longhornVolumeName: null,
      reason: 'namespace_deleted',
    });
  });

  it('flags PV whose namespace was deleted', async () => {
    const k8s = makeK8s({
      pvs: [{
        metadata: { name: 'pvc-deleted-ns' },
        spec: {
          claimRef: { namespace: 'gone-ns', name: 'data' },
          capacity: { storage: '10Gi' },
          persistentVolumeReclaimPolicy: 'Retain',
        },
        status: { phase: 'Released', lastTransitionTime: new Date(Date.now() - 86400_000).toISOString() },
      }],
      namespaces: ['platform', 'longhorn-system'], // gone-ns missing
      longhornVolumes: [{
        metadata: { name: 'pvc-deleted-ns' },
        spec: { size: String(10 * 1024 ** 3) },
        status: { kubernetesStatus: { pvName: 'pvc-deleted-ns', namespace: 'gone-ns', pvcName: 'data' } },
      }],
      longhornReplicas: [{ spec: { volumeName: 'pvc-deleted-ns', nodeID: 'worker' }, status: { currentState: 'running' } }],
    });
    const db = makeDb([]);

    const r = await detectOrphans(db, k8s);

    expect(r.totalCount).toBe(1);
    expect(r.orphans[0]).toMatchObject({
      pvName: 'pvc-deleted-ns',
      longhornVolumeName: 'pvc-deleted-ns',
      namespace: 'gone-ns',
      reason: 'namespace_deleted',
      nodes: ['worker'],
      ownerLabel: 'Platform System (gone-ns)',
    });
  });

  it('flags tenant PV whose client row was deleted but namespace still exists', async () => {
    const k8s = makeK8s({
      pvs: [{
        metadata: { name: 'pvc-orphan-tenant' },
        spec: {
          claimRef: { namespace: 'client-stale', name: 'data' },
          capacity: { storage: '5Gi' },
        },
        status: { phase: 'Bound', lastTransitionTime: new Date().toISOString() },
      }],
      namespaces: ['client-stale'],
      longhornVolumes: [{ metadata: { name: 'pvc-orphan-tenant' }, status: { kubernetesStatus: { pvName: 'pvc-orphan-tenant' } } }],
    });
    const db = makeDb([]); // no client rows

    const r = await detectOrphans(db, k8s);
    expect(r.orphans[0]).toMatchObject({
      reason: 'client_record_deleted',
      ownerLabel: 'Platform System (client-stale)',
    });
  });

  it('flags PV stuck in Released phase past the stale threshold', async () => {
    const old = new Date(Date.now() - 10 * 86400_000).toISOString(); // 10 days
    const k8s = makeK8s({
      pvs: [{
        metadata: { name: 'pvc-stale' },
        spec: { claimRef: { namespace: 'platform', name: 'old-data' }, capacity: { storage: '1Gi' } },
        status: { phase: 'Released', lastTransitionTime: old },
      }],
      namespaces: ['platform'],
      longhornVolumes: [{ metadata: { name: 'pvc-stale' }, status: { kubernetesStatus: { pvName: 'pvc-stale' } } }],
    });
    const db = makeDb([]);

    const r = await detectOrphans(db, k8s, { stalePvThresholdDays: 7 });
    expect(r.orphans[0].reason).toBe('pv_released_stale');
    expect(r.orphans[0].ageDays).toBeGreaterThanOrEqual(10);
  });

  it('does NOT flag a Bound PV whose client row exists', async () => {
    const k8s = makeK8s({
      pvs: [{
        metadata: { name: 'pvc-healthy' },
        spec: { claimRef: { namespace: 'client-acme', name: 'data' }, capacity: { storage: '2Gi' } },
        status: { phase: 'Bound', lastTransitionTime: new Date().toISOString() },
      }],
      namespaces: ['client-acme'],
      longhornVolumes: [{ metadata: { name: 'pvc-healthy' }, status: { kubernetesStatus: { pvName: 'pvc-healthy' } } }],
    });
    const db = makeDb([{ ns: 'client-acme', name: 'Acme Co' }]);

    const r = await detectOrphans(db, k8s);
    expect(r.totalCount).toBe(0);
  });

  it('flags Longhorn volume with no matching PV', async () => {
    const k8s = makeK8s({
      pvs: [],
      namespaces: ['longhorn-system'],
      longhornVolumes: [{
        metadata: { name: 'orphan-lh-vol' },
        spec: { size: String(3 * 1024 ** 3) },
        status: { kubernetesStatus: { pvName: '', namespace: '', pvcName: '' } },
      }],
      longhornReplicas: [{ spec: { volumeName: 'orphan-lh-vol', nodeID: 'staging1' }, status: { currentState: 'running' } }],
    });
    const db = makeDb([]);

    const r = await detectOrphans(db, k8s);
    expect(r.totalCount).toBe(1);
    expect(r.orphans[0]).toMatchObject({
      pvName: null,
      longhornVolumeName: 'orphan-lh-vol',
      reason: 'longhorn_volume_unbound',
      sizeBytes: 3 * 1024 ** 3,
      nodes: ['staging1'],
    });
  });

  it('attributes a tenant orphan to its client when the client row still exists', async () => {
    const k8s = makeK8s({
      pvs: [{
        metadata: { name: 'pvc-acme' },
        spec: { claimRef: { namespace: 'client-acme', name: 'data' }, capacity: { storage: '5Gi' } },
        status: { phase: 'Released', lastTransitionTime: new Date(Date.now() - 10 * 86400_000).toISOString() },
      }],
      namespaces: ['client-acme'],
      longhornVolumes: [{ metadata: { name: 'pvc-acme' }, status: { kubernetesStatus: { pvName: 'pvc-acme' } } }],
    });
    const db = makeDb([{ ns: 'client-acme', name: 'Acme Co' }]);

    const r = await detectOrphans(db, k8s);
    expect(r.orphans[0]).toMatchObject({
      reason: 'pv_released_stale',
      ownerLabel: 'Acme Co',
    });
  });

  it('flags a client-* namespace with no client row + no PV as namespace_orphaned', async () => {
    const k8s = makeK8s({
      pvs: [],
      namespaces: [{ name: 'client-stranded', createdDaysAgo: 2 }, 'platform'],
      longhornVolumes: [],
    });
    const db = makeDb([]); // no client rows

    const r = await detectOrphans(db, k8s);
    expect(r.totalCount).toBe(1);
    expect(r.orphans[0]).toMatchObject({
      pvName: null,
      longhornVolumeName: null,
      namespace: 'client-stranded',
      reason: 'namespace_orphaned',
      sizeBytes: 0,
      ownerLabel: 'Platform System (client-stranded)',
    });
    expect(r.orphans[0].ageDays).toBeGreaterThanOrEqual(1);
  });

  it('does NOT double-report a namespace already covered by a PV-side orphan row', async () => {
    // The namespace is also tenant-shaped without a client row, but a PV
    // already triggered `client_record_deleted` — the namespace pass
    // must skip it so the operator sees one row, not two.
    const k8s = makeK8s({
      pvs: [{
        metadata: { name: 'pvc-existing' },
        spec: { claimRef: { namespace: 'client-dup', name: 'data' }, capacity: { storage: '1Gi' } },
        status: { phase: 'Bound', lastTransitionTime: new Date().toISOString() },
      }],
      namespaces: [{ name: 'client-dup', createdDaysAgo: 3 }],
      longhornVolumes: [{ metadata: { name: 'pvc-existing' }, status: { kubernetesStatus: { pvName: 'pvc-existing' } } }],
    });
    const db = makeDb([]);

    const r = await detectOrphans(db, k8s);
    expect(r.totalCount).toBe(1);
    expect(r.orphans[0].reason).toBe('client_record_deleted');
  });

  it('does NOT flag a namespace that has a matching client row', async () => {
    const k8s = makeK8s({
      pvs: [],
      namespaces: ['client-acme'],
      longhornVolumes: [],
    });
    const db = makeDb([{ ns: 'client-acme', name: 'Acme Co' }]);

    const r = await detectOrphans(db, k8s);
    expect(r.totalCount).toBe(0);
  });

  it('aggregates totalBytes and sorts orphans largest-first', async () => {
    const k8s = makeK8s({
      pvs: [
        {
          metadata: { name: 'small' },
          spec: { claimRef: { namespace: 'gone' }, capacity: { storage: '1Gi' } },
          status: { phase: 'Released', lastTransitionTime: new Date().toISOString() },
        },
        {
          metadata: { name: 'big' },
          spec: { claimRef: { namespace: 'gone' }, capacity: { storage: '50Gi' } },
          status: { phase: 'Released', lastTransitionTime: new Date().toISOString() },
        },
      ],
      namespaces: [],
      longhornVolumes: [
        { metadata: { name: 'small' }, status: { kubernetesStatus: { pvName: 'small' } } },
        { metadata: { name: 'big' }, status: { kubernetesStatus: { pvName: 'big' } } },
      ],
    });
    const db = makeDb([]);

    const r = await detectOrphans(db, k8s);
    expect(r.totalCount).toBe(2);
    expect(r.orphans[0].pvName).toBe('big');
    expect(r.orphans[1].pvName).toBe('small');
    expect(r.totalBytes).toBe(51 * 1024 ** 3);
  });
});

describe('deleteOrphan', () => {
  it('cascades the namespace when cascadeNamespace=true', async () => {
    const captures = { deletedNamespaces: [] as string[] };
    const k8s = makeK8s({}, captures);
    const r = await deleteOrphan(k8s, {
      pvName: null,
      longhornVolumeName: null,
      namespace: 'client-gone',
      cascadeNamespace: true,
    });
    expect(r.deletedNamespace).toBe(true);
    expect(captures.deletedNamespaces).toEqual(['client-gone']);
  });

  it('does NOT delete the namespace unless cascadeNamespace=true', async () => {
    const captures = { deletedNamespaces: [] as string[] };
    const k8s = makeK8s({}, captures);
    const r = await deleteOrphan(k8s, {
      pvName: 'pvc-x',
      longhornVolumeName: 'pvc-x',
      namespace: 'client-keep',
    });
    expect(r.deletedNamespace).toBe(false);
    expect(captures.deletedNamespaces).toEqual([]);
  });
});

describe('purgeAllOrphans', () => {
  it('deletes every orphan and reports per-row failures', async () => {
    const captures = { deletedNamespaces: [] as string[] };
    const k8s = makeK8s({
      pvs: [{
        metadata: { name: 'pvc-stale' },
        spec: { claimRef: { namespace: 'platform', name: 'old' }, capacity: { storage: '4Gi' } },
        status: { phase: 'Released', lastTransitionTime: new Date(Date.now() - 30 * 86400_000).toISOString() },
      }],
      namespaces: ['platform', { name: 'client-orphan-ns' }],
      longhornVolumes: [{ metadata: { name: 'pvc-stale' }, spec: { size: String(4 * 1024 ** 3) }, status: { kubernetesStatus: { pvName: 'pvc-stale' } } }],
    }, captures);
    const db = makeDb([]); // no clients → client-orphan-ns is namespace_orphaned

    const r = await purgeAllOrphans(db, k8s);
    expect(r.attempted).toBe(2);
    expect(r.deleted).toBe(2);
    expect(r.failures).toEqual([]);
    expect(r.bytesReclaimed).toBe(4 * 1024 ** 3);
    expect(captures.deletedNamespaces).toEqual(['client-orphan-ns']);
  });

  it('reports per-row failures without aborting the batch', async () => {
    const k8s = makeK8s({
      pvs: [
        {
          metadata: { name: 'pvc-good' },
          spec: { claimRef: { namespace: 'gone' }, capacity: { storage: '1Gi' } },
          status: { phase: 'Released', lastTransitionTime: new Date().toISOString() },
        },
        {
          metadata: { name: 'pvc-bad' },
          spec: { claimRef: { namespace: 'gone' }, capacity: { storage: '2Gi' } },
          status: { phase: 'Released', lastTransitionTime: new Date().toISOString() },
        },
      ],
      namespaces: [],
      longhornVolumes: [
        { metadata: { name: 'pvc-good' }, status: { kubernetesStatus: { pvName: 'pvc-good' } } },
        { metadata: { name: 'pvc-bad' }, status: { kubernetesStatus: { pvName: 'pvc-bad' } } },
      ],
    });
    // Force the second PV deletion to throw.
    let call = 0;
    (k8s.core.deletePersistentVolume as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      call++;
      if (call === 2) throw new Error('boom');
      return {};
    });
    const db = makeDb([]);

    const r = await purgeAllOrphans(db, k8s);
    expect(r.attempted).toBe(2);
    expect(r.deleted).toBe(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].error).toContain('boom');
  });
});
