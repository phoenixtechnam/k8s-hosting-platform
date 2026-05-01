import { describe, it, expect } from 'vitest';
import { buildFilesComponentJobSpec } from './files.js';

describe('buildFilesComponentJobSpec', () => {
  const baseInput = {
    jobName: 'bk-files-bkp-test',
    namespace: 'client-abc',
    pvcName: 'tenant-data-pvc',
    clientId: 'abc',
    backupId: 'bkp-test',
    jobImage: 'alpine:3.20',
    hostMount: {
      volumeSpec: { name: 'platform-bundles', hostPath: { path: '/var/lib/platform/bundles', type: 'DirectoryOrCreate' } },
      mountPath: '/bundle',
    },
    archiveRelative: 'components/files/archive.tar.gz',
    treeRelative: 'components/files/tree.jsonl.gz',
  };

  it('produces a Job with backoffLimit=0 and ttlSecondsAfterFinished=600', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as { spec: { backoffLimit: number; ttlSecondsAfterFinished: number } };
    expect(spec.spec.backoffLimit).toBe(0);
    expect(spec.spec.ttlSecondsAfterFinished).toBe(600);
  });

  it('mounts the source PVC read-only', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { volumes: Array<{ name: string; persistentVolumeClaim?: { claimName: string; readOnly: boolean } }> } } };
    };
    const sourceVol = spec.spec.template.spec.volumes.find((v) => v.name === 'source');
    expect(sourceVol?.persistentVolumeClaim?.claimName).toBe('tenant-data-pvc');
    expect(sourceVol?.persistentVolumeClaim?.readOnly).toBe(true);
  });

  it('uses platform-tenant-overhead priority class so it does not count against client quota', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { priorityClassName: string } } };
    };
    expect(spec.spec.template.spec.priorityClassName).toBe('platform-tenant-overhead');
  });

  it('labels the Job with backup-id and client-id so backup-health can find it', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as { metadata: { labels: Record<string, string> } };
    expect(spec.metadata.labels['platform.io/component']).toBe('backup-files');
    expect(spec.metadata.labels['platform.io/client-id']).toBe('abc');
    expect(spec.metadata.labels['platform.io/backup-id']).toBe('bkp-test');
  });

  it('runs a script that emits both archive.tar.gz and tree.jsonl.gz under /bundle', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain('/bundle/components/files/archive.tar.gz');
    expect(cmd).toContain('/bundle/components/files/tree.jsonl.gz');
    expect(cmd).toContain('sha256sum');
    // tree pipeline produces gzipped JSONL
    expect(cmd).toContain('gzip -1');
  });
});
