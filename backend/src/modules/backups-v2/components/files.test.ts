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
    uploadBase: 'http://platform-api.platform.svc:3000/api/v1/internal/bundles/bkp-test/components/files',
    archiveToken: '1234567890.deadbeef',
    treeToken: '1234567890.cafebabe',
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

  it('uploads archive + tree to the platform-api internal endpoint with HMAC tokens', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain(`${baseInput.uploadBase}/archive.tar.gz?token=${baseInput.archiveToken}`);
    expect(cmd).toContain(`${baseInput.uploadBase}/tree.jsonl.gz?token=${baseInput.treeToken}`);
    // Sanity: tar + sha256 + tree.jsonl pipeline still in place.
    expect(cmd).toContain('tar cf - .');
    expect(cmd).toContain('sha256sum');
    expect(cmd).toContain('FILES_TREE_COUNT=');
  });

  it('uses --upload-file (streaming) NOT --data-binary @ (load whole file into memory)', () => {
    // Streaming upload is non-negotiable: a 50 GiB tenant PVC would
    // OOM the 512Mi Job pod with --data-binary @file. Pin this so the
    // next refactor doesn't accidentally flip back.
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain('--upload-file /tmp/archive.tar.gz');
    expect(cmd).toContain('--upload-file /tmp/tree.jsonl.gz');
    expect(cmd).not.toContain('--data-binary @');
  });

  it('does not embed the SSH key or any S3 credentials in the Job script', () => {
    // The whole point of the HTTP-upload pattern is that the Job
    // never sees off-site target credentials. Defence-in-depth check.
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).not.toMatch(/AWS_ACCESS_KEY|AWS_SECRET|BEGIN OPENSSH|BEGIN RSA|s3\.amazonaws/i);
  });
});
