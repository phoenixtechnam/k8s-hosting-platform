/**
 * Unit tests for the files-paths restore executor — focused on the
 * Job spec and the path-injection guard. The end-to-end restore is
 * covered by the integration-staging harness (E2E).
 */

import { describe, it, expect } from 'vitest';
import { buildFilesPathsJobSpec } from './files-paths.js';

describe('buildFilesPathsJobSpec', () => {
  const baseInput = {
    jobName: 'rs-files-item-1',
    namespace: 'client-acme',
    pvcName: 'client-acme-storage',
    clientId: 'client-acme',
    cartId: 'rstr-1',
    itemId: 'item-1',
    downloadUrl: 'http://platform-api.platform.svc:3000/api/v1/internal/bundles/bkp-1/components/files/archive.tar.gz?token=1.deadbeef',
    pathArgs: 'all' as const,
  };

  it('runs in the tenant namespace and mounts the tenant PVC', () => {
    const spec = buildFilesPathsJobSpec(baseInput) as {
      metadata: { namespace: string };
      spec: { template: { spec: { volumes: Array<{ name: string; persistentVolumeClaim?: { claimName: string } }> } } };
    };
    expect(spec.metadata.namespace).toBe('client-acme');
    const target = spec.spec.template.spec.volumes.find((v) => v.name === 'target');
    expect(target?.persistentVolumeClaim?.claimName).toBe('client-acme-storage');
  });

  it('labels with platform.io/component=restore-files so the tightened NetworkPolicy applies', () => {
    const spec = buildFilesPathsJobSpec(baseInput) as { metadata: { labels: Record<string, string> } };
    expect(spec.metadata.labels['platform.io/component']).toBe('restore-files');
    expect(spec.metadata.labels['platform.io/restore-cart']).toBe('rstr-1');
    expect(spec.metadata.labels['platform.io/restore-item']).toBe('item-1');
  });

  it('mounts target PVC RW (not readOnly)', () => {
    const spec = buildFilesPathsJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ volumeMounts: Array<{ name: string; readOnly?: boolean }> }> } } };
    };
    const target = spec.spec.template.spec.containers[0]!.volumeMounts.find((m) => m.name === 'target');
    expect(target?.readOnly).not.toBe(true);
  });

  it('extracts the whole archive when pathArgs === "all"', () => {
    const spec = buildFilesPathsJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain('tar -xzf /tmp/archive.tar.gz -C /target');
    expect(cmd).not.toContain('--files-from');
  });

  it('uses --files-from when paths are provided (defends against tar-arg-injection)', () => {
    const spec = buildFilesPathsJobSpec({
      ...baseInput,
      pathArgs: ['var/www/html/index.php', 'etc/config.json'],
    }) as { spec: { template: { spec: { containers: Array<{ command: string[] }> } } } };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain('--files-from=/tmp/paths.lst');
    // The actual paths are written via printf — they're in the script,
    // but they go through `printf '%s\n' '<path>'` so even if a path
    // contained `--strip-components=2` (impossible because of the
    // selector regex), tar reads it as a literal filename via files-from.
    expect(cmd).toContain('var/www/html/index.php');
    expect(cmd).toContain('etc/config.json');
  });

  it('does not embed the download token in tar command (only in curl)', () => {
    const spec = buildFilesPathsJobSpec({ ...baseInput, pathArgs: ['foo.txt'] }) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    // Token appears once (in the curl URL), not twice.
    const occurrences = cmd.match(/1\.deadbeef/g) ?? [];
    expect(occurrences.length).toBe(1);
  });
});
