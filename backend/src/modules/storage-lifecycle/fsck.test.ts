import { describe, it, expect } from 'vitest';
import { buildFsckScript } from './fsck.js';

describe('buildFsckScript', () => {
  it('runs xfs_repair -n -v in dry-run mode for xfs', () => {
    const script = buildFsckScript('xfs', true);
    expect(script).toMatch(/apk add --no-cache xfsprogs/);
    expect(script).toMatch(/xfs_repair -n -v "\$DEV"/);
    // No -L (zero log) — destructive flag must be excluded.
    expect(script).not.toMatch(/-L/);
  });

  it('runs xfs_repair -v (no -n) in repair mode for xfs', () => {
    const script = buildFsckScript('xfs', false);
    expect(script).toMatch(/xfs_repair -v "\$DEV"/);
    expect(script).not.toMatch(/xfs_repair -n/);
  });

  it('runs e2fsck -n -fv in dry-run mode for ext4', () => {
    const script = buildFsckScript('ext4', true);
    expect(script).toMatch(/apk add --no-cache e2fsprogs/);
    expect(script).toMatch(/e2fsck -n -fv "\$DEV"/);
  });

  it('runs e2fsck -y -fv in repair mode for ext4', () => {
    const script = buildFsckScript('ext4', false);
    expect(script).toMatch(/e2fsck -y -fv "\$DEV"/);
  });

  it('treats ext3/ext2 the same as ext4 (e2fsck handles them all)', () => {
    expect(buildFsckScript('ext3', true)).toMatch(/e2fsck -n -fv/);
    expect(buildFsckScript('ext2', false)).toMatch(/e2fsck -y -fv/);
  });

  it('matches case-insensitively', () => {
    expect(buildFsckScript('XFS', true)).toMatch(/xfs_repair/);
    expect(buildFsckScript('Ext4', true)).toMatch(/e2fsck/);
  });

  it('rejects unsupported filesystems with exit 64', () => {
    const script = buildFsckScript('btrfs', true);
    expect(script).toMatch(/unsupported fsType 'btrfs'/);
    expect(script).toMatch(/exit 64/);
    expect(script).not.toMatch(/xfs_repair|e2fsck/);
  });

  it('checks block-device existence before running the tool', () => {
    const script = buildFsckScript('xfs', true);
    expect(script).toMatch(/\[ -b "\$DEV" \]/);
    expect(script).toMatch(/exit 65/); // missing-device sentinel
  });
});

describe('platform-ns constants', () => {
  it('exports the platform-tenant-ops namespace + storage-ops priority class', async () => {
    const { PLATFORM_TENANT_OPS_NS, STORAGE_OPS_PRIORITY_CLASS } = await import('./platform-ns.js');
    expect(PLATFORM_TENANT_OPS_NS).toBe('platform-tenant-ops');
    expect(STORAGE_OPS_PRIORITY_CLASS).toBe('platform-storage-ops');
  });
});

describe('runFsck — Job placement', () => {
  it('creates Jobs in the platform-tenant-ops namespace with the storage-ops priority class', async () => {
    const { runFsck } = await import('./fsck.js');
    interface JobBody {
      metadata?: { labels?: Record<string, string> };
      spec?: { template?: { spec?: { priorityClassName?: string } } };
    }
    const calls: Array<{ kind: string; namespace: string; body?: JobBody }> = [];
    const k8s = {
      batch: {
        createNamespacedJob: async (args: { namespace: string; body: JobBody }) => {
          calls.push({ kind: 'createJob', namespace: args.namespace, body: args.body });
        },
        readNamespacedJob: async () => ({ status: { conditions: [{ type: 'Complete', status: 'True' }], succeeded: 1 } }),
        deleteNamespacedJob: async () => undefined,
      },
      core: {
        listNamespacedPod: async () => ({ items: [{ metadata: { name: 'fsck-pod' }, status: { containerStatuses: [{ state: { terminated: { exitCode: 0 } } }] } }] }),
        readNamespacedPodLog: async () => '[fsck] exit=0\nfilesystem clean',
      },
    } as never;
    await runFsck(k8s, {
      namespace: 'client-tester',
      volumeName: 'pvc-abc12345',
      clientId: 'c-1',
      fsType: 'ext4',
      dryRun: true,
      nodeName: 'node-a',
    });
    const jobCall = calls.find((c) => c.kind === 'createJob');
    expect(jobCall).toBeDefined();
    expect(jobCall!.namespace).toBe('platform-tenant-ops');
    expect(jobCall!.body!.metadata!.labels!['platform.io/client-id']).toBe('c-1');
    expect(jobCall!.body!.metadata!.labels!['platform.io/client-namespace']).toBe('client-tester');
    expect(jobCall!.body!.spec!.template!.spec!.priorityClassName).toBe('platform-storage-ops');
  });
});
