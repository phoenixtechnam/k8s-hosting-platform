/**
 * Files component Job-spec tests (Phase 1 tenant-backup-v2 / ADR-036).
 *
 * Pipeline: tar | curl --upload-file - to platform-api restic-stream.
 * No gzip (restic dedups raw blocks). No tree.jsonl.gz (replaced by
 * `restic ls`). No sha256 in the Job (restic content-addresses).
 * Tar-exit side-channel preserved (silent-truncation guard).
 */

import { describe, it, expect } from 'vitest';
import { buildFilesComponentJobSpec, parseFilesDone } from './files.js';

describe('buildFilesComponentJobSpec', () => {
  const baseInput = {
    jobName: 'bk-files-bkp-test',
    namespace: 'client-abc',
    pvcName: 'tenant-data-pvc',
    clientId: 'abc',
    backupId: 'bkp-test',
    jobImage: 'alpine:3.20',
    // Reviewer #5 (Phase 1.5+): token NOT in URL; mounted via Secret
    // and concatenated by the script after $(cat /var/run/upload-token/token).
    uploadUrlNoToken:
      'http://platform-api.platform.svc:3000/api/v1/internal/bundles/bkp-test/components/files/restic-stream?filename=archive.tar',
    uploadTokenSecretName: 'bk-files-token-bkp-test',
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

  it('uses platform-tenant-overhead priority class', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { priorityClassName: string } } };
    };
    expect(spec.spec.template.spec.priorityClassName).toBe('platform-tenant-overhead');
  });

  it('labels the Job with backup-id and client-id', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as { metadata: { labels: Record<string, string> } };
    expect(spec.metadata.labels['platform.io/component']).toBe('backup-files');
    expect(spec.metadata.labels['platform.io/client-id']).toBe('abc');
    expect(spec.metadata.labels['platform.io/backup-id']).toBe('bkp-test');
  });

  it('streams tar straight to the restic-stream upload endpoint via stdin', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain(baseInput.uploadUrlNoToken);
    expect(cmd).toContain('tar cf - .');
    expect(cmd).toContain('--upload-file -');
  });

  it('mounts the upload token from a per-Job Secret (NOT inlined in command)', () => {
    // Reviewer #5: HMAC token in command body would land in etcd
    // and be readable by anyone with `get jobs` RBAC. Now sourced
    // from a tmpfs-backed projected Secret at mode 0400.
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: {
        containers: Array<{ command: string[]; volumeMounts: Array<{ name: string; mountPath: string; readOnly?: boolean }> }>;
        volumes: Array<{ name: string; secret?: { secretName: string; defaultMode?: number; items?: Array<{ key: string; path: string }> } }>;
      } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    // Command reads the token from the mounted file; URL has no &token=
    // baked in; concatenation happens in the script.
    expect(cmd).toContain('TOKEN=$(cat /var/run/upload-token/token)');
    expect(cmd).toContain('&token=$TOKEN');
    expect(cmd).not.toMatch(/[?&]token=[^$]/); // no literal token in URL
    // Volume + mount wired correctly.
    const mount = spec.spec.template.spec.containers[0]!.volumeMounts.find((m) => m.name === 'upload-token');
    expect(mount?.mountPath).toBe('/var/run/upload-token');
    expect(mount?.readOnly).toBe(true);
    const vol = spec.spec.template.spec.volumes.find((v) => v.name === 'upload-token');
    expect(vol?.secret?.secretName).toBe('bk-files-token-bkp-test');
    expect(vol?.secret?.defaultMode).toBe(0o400);
    expect(vol?.secret?.items).toEqual([{ key: 'token', path: 'token' }]);
  });

  it('fails the script loudly if the token Secret is missing', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain('[ -n "$TOKEN" ] || { echo "ERROR: upload token missing"; exit 1; }');
  });

  it('does NOT gzip the tar stream (restic dedups raw blocks)', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    // Defensive: gzip would defeat restic's content-addressed dedup
    // and reintroduce ~10x storage cost on incremental snapshots.
    expect(cmd).not.toMatch(/\|\s*gzip/);
  });

  it('does NOT build a tree.jsonl.gz sidecar (`restic ls` is the new browse primitive)', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).not.toContain('tree.jsonl.gz');
    expect(cmd).not.toContain('FILES_TREE_COUNT=');
    expect(cmd).not.toContain('apk add --no-cache findutils');
  });

  it('captures tar exit code via /tmp/tar.exit side-channel (silent-truncation guard)', () => {
    // If tar dies mid-stream, curl sees clean EOF and restic stores
    // a truncated tar with a real snapshot id. Pipefail does NOT
    // catch this. The script must capture tar's exit separately.
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain('echo $? > /tmp/tar.exit');
    expect(cmd).toContain('TAR_EXIT=$(cat /tmp/tar.exit');
    expect(cmd).toContain('[ "$TAR_EXIT" = "0" ]');
  });

  it('asserts platform-api returned HTTP 200 (loud failure on 4xx/5xx)', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    // After reviewer #2 fix: status written to /tmp/http_status via
    // -w "%{http_code}", read via tr -d, asserted against 200.
    expect(cmd).toContain('/tmp/http_status');
    expect(cmd).toContain('HTTP=$(tr -d');
    expect(cmd).toContain('[ "$HTTP" = "200" ]');
  });

  it('emits FILES_DONE bundleId=<id> snapshot=$SNAP sizeBytes=$SIZE fileCount=$COUNT for the orchestrator', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain(`FILES_DONE bundleId=${baseInput.backupId} snapshot=$SNAP`);
    expect(cmd).toContain('sizeBytes=${SIZE:-0}');
    expect(cmd).toContain('fileCount=${COUNT:-0}');
  });

  it('parses snapshotId/sizeBytes/fileCount via grep -o + sed (POSIX, busybox-safe)', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    // Reviewer #1 fix: grep+sed replaces awk RS=, which broke when
    // upstream JSON had embedded commas in array values.
    expect(cmd).toContain("grep -o '\"snapshotId\":\"[0-9a-f]\\{64\\}\"'");
    expect(cmd).toContain("grep -o '\"sizeBytes\":[0-9]\\+'");
    expect(cmd).toContain("grep -o '\"fileCount\":[0-9]\\+'");
  });

  it('writes HTTP status to a separate file (not bundled with the response body)', () => {
    // Reviewer #2: -w "%{http_code}" -o /tmp/restic-resp.json -> /tmp/http_status
    // separates the status code from the body, avoiding any \n
    // interpretation ambiguity across busybox/full-curl variants.
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain('/tmp/http_status');
    expect(cmd).toContain('-w "%{http_code}"');
    expect(cmd).not.toContain('HTTP_STATUS=%{http_code}');
  });

  it('drops the apt-get fallback (alpine ships curl; reviewer #4)', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).not.toMatch(/apt-get/);
  });

  it('does NOT use bash process substitution (busybox ash compatibility)', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).not.toMatch(/>\s*\(/);
    expect(cmd).not.toMatch(/<\s*\(/);
  });

  it('caps scratch emptyDir at 256Mi (only side-channel files; tar stays in pipe)', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { volumes: Array<{ name: string; emptyDir?: { sizeLimit?: string } }> } } };
    };
    const scratch = spec.spec.template.spec.volumes.find((v) => v.name === 'scratch');
    expect(scratch?.emptyDir?.sizeLimit).toBe('256Mi');
  });

  it('uses --upload-file (streaming) and does not load whole tar into memory', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).toContain('--upload-file -');
    expect(cmd).not.toContain('--data-binary @');
  });

  it('does not embed any S3/SSH credentials in the Job script', () => {
    // The whole point of the HTTP-upload pattern is that the Job
    // never sees off-site target credentials. Defence-in-depth check.
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { containers: Array<{ command: string[] }> } } };
    };
    const cmd = spec.spec.template.spec.containers[0]!.command.join(' ');
    expect(cmd).not.toMatch(/AWS_ACCESS_KEY|AWS_SECRET|BEGIN OPENSSH|BEGIN RSA|s3\.amazonaws/i);
  });

  it('pins to the supplied node when pinToNode is set', () => {
    const spec = buildFilesComponentJobSpec({ ...baseInput, pinToNode: 'staging2' }) as {
      spec: { template: { spec: { nodeName?: string } } };
    };
    expect(spec.spec.template.spec.nodeName).toBe('staging2');
  });

  it('omits nodeName when pinToNode is null/undefined', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as {
      spec: { template: { spec: { nodeName?: string } } };
    };
    expect(spec.spec.template.spec.nodeName).toBeUndefined();
  });

  it('sets activeDeadlineSeconds when supplied', () => {
    const spec = buildFilesComponentJobSpec({ ...baseInput, activeDeadlineSeconds: 1860 }) as {
      spec: { activeDeadlineSeconds?: number };
    };
    expect(spec.spec.activeDeadlineSeconds).toBe(1860);
  });

  it('omits activeDeadlineSeconds when not supplied or non-positive', () => {
    const spec = buildFilesComponentJobSpec(baseInput) as { spec: { activeDeadlineSeconds?: number } };
    expect(spec.spec.activeDeadlineSeconds).toBeUndefined();
    const spec2 = buildFilesComponentJobSpec({ ...baseInput, activeDeadlineSeconds: 0 }) as { spec: { activeDeadlineSeconds?: number } };
    expect(spec2.spec.activeDeadlineSeconds).toBeUndefined();
  });
});

// Reviewer #10: parseFilesDone is the highest-risk parsing function
// in the file. Cover the bundleId-mismatch defence (#3), the
// 64-char-only regex (#7), empty-log + truncated-line failure modes,
// and the size/count extraction.
describe('parseFilesDone', () => {
  const SNAP = 'a'.repeat(64);
  const SNAP2 = 'b'.repeat(64);
  const ok = `FILES_DONE bundleId=bk-test snapshot=${SNAP} sizeBytes=12345 fileCount=7`;

  it('parses a clean FILES_DONE line', () => {
    expect(parseFilesDone(`...\n${ok}\n...`, 'bk-test')).toEqual({
      snapshotId: SNAP,
      sizeBytes: 12345,
      fileCount: 7,
    });
  });

  it('returns null when the bundleId in the line does not match (reviewer #3)', () => {
    expect(parseFilesDone(ok, 'different-bundle')).toBeNull();
  });

  it('prefers the LAST matching line (most recent run wins)', () => {
    const oldLine = `FILES_DONE bundleId=bk-test snapshot=${SNAP} sizeBytes=10 fileCount=1`;
    const newLine = `FILES_DONE bundleId=bk-test snapshot=${SNAP2} sizeBytes=20 fileCount=2`;
    const res = parseFilesDone(`${oldLine}\n${newLine}\n`, 'bk-test');
    expect(res?.snapshotId).toBe(SNAP2);
    expect(res?.sizeBytes).toBe(20);
  });

  it('rejects truncated snapshot ids (reviewer #7: 64-char-only regex)', () => {
    const truncated = `FILES_DONE bundleId=bk-test snapshot=${'a'.repeat(63)} sizeBytes=1 fileCount=1`;
    expect(parseFilesDone(truncated, 'bk-test')).toBeNull();
    const tooLong = `FILES_DONE bundleId=bk-test snapshot=${'a'.repeat(65)} sizeBytes=1 fileCount=1`;
    expect(parseFilesDone(tooLong, 'bk-test')).toBeNull();
  });

  it('returns null on empty log', () => {
    expect(parseFilesDone('', 'bk-test')).toBeNull();
  });

  it('returns null on partial line (FILES_DONE but no snapshot)', () => {
    expect(parseFilesDone('FILES_DONE\n', 'bk-test')).toBeNull();
    expect(parseFilesDone('FILES_DONE bundleId=bk-test\n', 'bk-test')).toBeNull();
  });
});
