import { describe, it, expect, vi } from 'vitest';
import { buildHostpathDirJobSpec, ensureHostpathDirs } from './hostpath-job.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

describe('buildHostpathDirJobSpec', () => {
  const base = {
    jobName: 'bk-mkdir-bkp-test',
    bundleId: 'bkp-test',
    clientId: 'abc',
    hostpathRoot: '/var/lib/platform/snapshots',
    mountPath: '/snapshots',
    paths: [
      '/var/lib/platform/snapshots/_bundles_v2/bkp-test',
      '/var/lib/platform/snapshots/_bundles_v2/bkp-test/components/files',
      '/var/lib/platform/snapshots/_bundles_v2/bkp-test/components/secrets',
    ],
  };

  it('translates host paths to in-Pod paths under mountPath', () => {
    const spec = buildHostpathDirJobSpec(base) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain('install -d -m 0777 "/snapshots/_bundles_v2/bkp-test"');
    expect(cmd).toContain('install -d -m 0777 "/snapshots/_bundles_v2/bkp-test/components/files"');
    expect(cmd).toContain('install -d -m 0777 "/snapshots/_bundles_v2/bkp-test/components/secrets"');
    expect(cmd).not.toContain('/var/lib/platform/snapshots'); // host path absent in container cmd
  });

  it('rejects paths not under hostpathRoot (defence against caller bugs)', () => {
    expect(() => buildHostpathDirJobSpec({ ...base, paths: ['/etc/passwd'] }))
      .toThrow(/not under hostpathRoot/);
  });

  it('runs in PLATFORM_TENANT_OPS_NS with platform-storage-ops priorityClass', () => {
    const spec = buildHostpathDirJobSpec(base) as {
      metadata: { namespace: string };
      spec: { template: { spec: { priorityClassName: string } } };
    };
    expect(spec.metadata.namespace).toBe('platform-tenant-ops');
    expect(spec.spec.template.spec.priorityClassName).toBe('platform-storage-ops');
  });

  it('mounts the snapshots hostPath read-write (no readOnly flag)', () => {
    const spec = buildHostpathDirJobSpec(base) as {
      spec: { template: { spec: { volumes: Array<{ name: string; hostPath?: { path: string } }> } } };
    };
    const vol = spec.spec.template.spec.volumes.find((v) => v.name === 'platform-bundles');
    expect(vol?.hostPath?.path).toBe('/var/lib/platform/snapshots');
  });

  it('labels the Job with backup-id + client-id for backup-health watcher', () => {
    const spec = buildHostpathDirJobSpec(base) as { metadata: { labels: Record<string, string> } };
    expect(spec.metadata.labels['platform.io/backup-id']).toBe('bkp-test');
    expect(spec.metadata.labels['platform.io/client-id']).toBe('abc');
  });

  it('sets backoffLimit=0 (fail fast) and ttl=300 (5 min cleanup)', () => {
    const spec = buildHostpathDirJobSpec(base) as { spec: { backoffLimit: number; ttlSecondsAfterFinished: number } };
    expect(spec.spec.backoffLimit).toBe(0);
    expect(spec.spec.ttlSecondsAfterFinished).toBe(300);
  });
});

describe('ensureHostpathDirs — error tolerance', () => {
  function makeFakeK8s(opts: {
    onCreate: () => Promise<unknown>;
    succeededOnRead?: boolean;
  }): K8sClients {
    return {
      batch: {
        createNamespacedJob: vi.fn(opts.onCreate),
        readNamespacedJob: vi.fn(async () => ({
          status: opts.succeededOnRead === false ? {} : { succeeded: 1 },
        })),
      },
    } as unknown as K8sClients;
  }

  const baseInput = {
    bundleId: 'bkp-x',
    clientId: 'c1',
    hostpathRoot: '/var/lib/platform/snapshots',
    mountPath: '/snapshots',
    paths: ['/var/lib/platform/snapshots/_bundles_v2'],
  };

  it.each([
    { name: 'statusCode shape',     err: { statusCode: 409 } as object },
    { name: 'bare numeric code',    err: { code: 409 } as object },
    { name: 'string code',          err: { code: '409' } as object },
    { name: 'nested body.code',     err: { body: { code: 409 } } as object },
  ])('tolerates 409 in $name', async ({ err }) => {
    const k8s = makeFakeK8s({ onCreate: async () => { throw err; } });
    await expect(ensureHostpathDirs({ ...baseInput, k8s })).resolves.toBeUndefined();
  });

  it('rethrows non-409 create errors', async () => {
    const k8s = makeFakeK8s({ onCreate: async () => { throw { statusCode: 500, message: 'boom' }; } });
    await expect(ensureHostpathDirs({ ...baseInput, k8s })).rejects.toThrow();
  });
});
