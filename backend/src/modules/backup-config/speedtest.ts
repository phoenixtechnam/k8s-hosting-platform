// Phase 10 of the snapshot-storage overhaul: speedtest for backup targets.
//
// Operator clicks "Speedtest" on any configured target → spawns a k8s
// Job that:
//   1. Generates a random payload (default 100 MB) via /dev/urandom
//   2. Times an rclone upload of the payload to the target
//   3. Times an rclone download back to the pod
//   4. Deletes the remote test file
//   5. Reports upload_mbps, download_mbps, latency, duration
//
// Surfaces via the task-center (kind='backup.speedtest') with a
// detailed progress modal showing each of the 4 stages. Result is
// persisted to `backup_configurations.last_speedtest_*` so the
// BackupSettings UI shows the most-recent result without re-running.

import { eq } from 'drizzle-orm';
import crypto from 'node:crypto';
import { backupConfigurations } from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { ApiError } from '../../shared/errors.js';
import { decrypt } from '../oidc/crypto.js';
import { rcloneObscure } from '../storage-lifecycle/rclone-obscure.js';
import type { SpeedtestResult } from '@k8s-hosting/api-contracts';

const RCLONE_IMAGE = 'rclone/rclone:1.66';
const DEFAULT_PAYLOAD_BYTES = 100 * 1024 * 1024; // 100 MB
const SPEEDTEST_JOB_TIMEOUT_MS = 30 * 60 * 1000; // 30 min hard cap
const PLATFORM_NAMESPACE = process.env.PLATFORM_NAMESPACE ?? 'platform';

export interface RunSpeedtestOpts {
  readonly targetId: string;
  readonly payloadBytes?: number;
  readonly triggeredByUserId: string | null;
}

/**
 * Top-level entry point — spawns the speedtest Job, polls until
 * complete, parses results, persists, returns. Caller (the route
 * handler) returns the result + taskId to the operator.
 *
 * Task-center: this function calls `start/progress/finish` from
 * `tasks/service.ts` so the operation surfaces in the chip with the
 * 4-stage progress modal. Modal kind = 'backup.speedtest'; refId =
 * the operationId we mint here (NOT a storage_operations row — those
 * are tenant-scoped; speedtest is platform-scoped).
 */
export async function runSpeedtest(
  db: Database,
  k8s: K8sClients,
  opts: RunSpeedtestOpts,
): Promise<SpeedtestResult> {
  const payloadBytes = opts.payloadBytes ?? DEFAULT_PAYLOAD_BYTES;
  const operationId = crypto.randomUUID();

  // Lookup target + decrypt creds before doing anything visible.
  const [target] = await db
    .select()
    .from(backupConfigurations)
    .where(eq(backupConfigurations.id, opts.targetId))
    .limit(1);
  if (!target) {
    throw new ApiError('TARGET_NOT_FOUND', `Backup target ${opts.targetId} not found`, 404);
  }
  if (target.enabled !== 1) {
    throw new ApiError('TARGET_DISABLED', `Backup target ${target.name} is disabled — enable it before speedtest`, 400);
  }

  const key = process.env.PLATFORM_ENCRYPTION_KEY;
  if (!key) {
    throw new ApiError('CONFIGURATION_ERROR', 'PLATFORM_ENCRYPTION_KEY is not set', 500);
  }

  // Task-center: register the speedtest as a running task BEFORE the
  // Job is created so the chip lights up immediately on click.
  const { start: startTask, progress: progressTask, finish: finishTask } =
    await import('../tasks/service.js');
  const { toSafeText } = await import('@k8s-hosting/api-contracts');
  const started = await startTask(db, {
    kind: 'backup.speedtest',
    refId: operationId,
    scope: 'admin',
    userId: opts.triggeredByUserId,
    tenantId: null,
    label: toSafeText(`Speedtest ${target.name} (${formatBytes(payloadBytes)})`),
    target: {
      type: 'modal',
      modal: 'backup-speedtest',
      modalProps: {
        operationId,
        targetId: opts.targetId,
        targetName: target.name,
        payloadBytes,
      },
    },
    progressPct: 0,
    progressText: toSafeText('Provisioning Job'),
  });
  const taskId = started.id;

  const jobName = `speedtest-${operationId.slice(0, 8)}-${Date.now().toString(36)}`.slice(0, 63);
  const remoteFile = `speedtest/${operationId}.bin`;
  const startedAt = Date.now();
  let result: Omit<SpeedtestResult, 'targetId' | 'targetName'> = {
    payloadBytes,
    uploadMbps: null,
    downloadMbps: null,
    latencyMs: null,
    durationSeconds: null,
    taskId,
    operationId,
    ok: false,
    error: 'Job did not complete',
    completedAt: null,
  };

  try {
    // Build the rclone env block + script for the resolved target type.
    const { publicEnv, secretEnv, remoteRef, kindLabel } = buildRcloneEnv(target, key);

    const script = buildSpeedtestScript({ payloadBytes, remoteFile, remoteRef });

    // Phase 12: ephemeral credentials Secret, GC'd via Job ownerRef.
    const {
      createEphemeralCredentialsSecret,
      attachOwnerToSecret,
      deleteSecretBestEffort,
      buildEnvFromSecret,
      credSecretNameFor,
    } = await import('../storage-lifecycle/streaming-store.js');
    const credSecretName = credSecretNameFor(jobName);
    const hasSecretEnv = Object.keys(secretEnv).length > 0;
    if (hasSecretEnv) {
      await createEphemeralCredentialsSecret(
        k8s as unknown as Parameters<typeof createEphemeralCredentialsSecret>[0],
        PLATFORM_NAMESPACE,
        credSecretName,
        secretEnv,
      );
    }

    const jobBody = {
      metadata: {
        name: jobName,
        namespace: PLATFORM_NAMESPACE,
        labels: {
          'platform.io/component': 'backup-speedtest',
          'platform.io/target-id': opts.targetId,
          'platform.io/target-kind': kindLabel,
        },
      },
      spec: {
        backoffLimit: 0,
        ttlSecondsAfterFinished: 1800,
        activeDeadlineSeconds: Math.floor(SPEEDTEST_JOB_TIMEOUT_MS / 1000),
        template: {
          metadata: {
            labels: {
              'platform.io/component': 'backup-speedtest',
              'platform.io/target-id': opts.targetId,
            },
          },
          spec: {
            restartPolicy: 'Never',
            containers: [{
              name: 'rclone',
              image: RCLONE_IMAGE,
              imagePullPolicy: 'IfNotPresent',
              command: ['sh', '-c', script],
              env: publicEnv,
              envFrom: hasSecretEnv ? buildEnvFromSecret(credSecretName) : undefined,
              resources: {
                requests: { cpu: '100m', memory: '128Mi' },
                limits: { cpu: '500m', memory: '256Mi' },
              },
            }],
          },
        },
      },
    };

    await progressTask(db, taskId, {
      pct: 10,
      text: toSafeText('Provisioning Job'),
    });

    let createdJobResp: unknown;
    try {
      createdJobResp = await (k8s.batch as unknown as {
        createNamespacedJob: (args: { namespace: string; body: unknown }) => Promise<unknown>;
      }).createNamespacedJob({ namespace: PLATFORM_NAMESPACE, body: jobBody });
    } catch (err) {
      if (hasSecretEnv) {
        await deleteSecretBestEffort(
          k8s as unknown as Parameters<typeof deleteSecretBestEffort>[0],
          PLATFORM_NAMESPACE,
          credSecretName,
        );
      }
      throw err;
    }
    if (hasSecretEnv) {
      const jobUid = ((createdJobResp as { body?: { metadata?: { uid?: string } } }).body?.metadata?.uid
        ?? (createdJobResp as { metadata?: { uid?: string } }).metadata?.uid);
      if (jobUid) {
        await attachOwnerToSecret(
          k8s as unknown as Parameters<typeof attachOwnerToSecret>[0],
          PLATFORM_NAMESPACE,
          credSecretName,
          { name: jobName, uid: jobUid },
        ).catch(() => { /* cron picks up */ });
      }
    }

    // Poll the Job until terminal or timeout.
    let lastPct = 10;
    while (true) {
      const job = await (k8s.batch as unknown as {
        readNamespacedJob: (args: { name: string; namespace: string }) => Promise<{
          status?: { conditions?: Array<{ type: string; status: string }>; succeeded?: number; failed?: number };
        }>;
      }).readNamespacedJob({ name: jobName, namespace: PLATFORM_NAMESPACE });
      const status = job.status ?? {};
      const completed = (status.conditions ?? []).find((c) => c.type === 'Complete' && c.status === 'True');
      const failed = (status.conditions ?? []).find((c) => c.type === 'Failed' && c.status === 'True');
      if (completed || (status.succeeded ?? 0) > 0) break;
      if (failed || (status.failed ?? 0) > 0) {
        // Try to extract the actual rclone error from the pod log
        // (script emits `SPEEDTEST_FAILED=<stage>: <reason>` on the
        // failure path) so the operator sees the real cause instead of
        // a generic "Job failed".
        const failedLog = await parseSpeedtestLog(k8s, jobName).catch(() => ({ kind: 'none' as const }));
        const reason = failedLog.kind === 'failed' ? failedLog.reason : `Job ${jobName} failed`;
        throw new ApiError('SPEEDTEST_FAILED', reason, 502);
      }
      if (Date.now() - startedAt > SPEEDTEST_JOB_TIMEOUT_MS) {
        throw new ApiError('SPEEDTEST_TIMEOUT', `Speedtest Job ${jobName} timed out`, 504);
      }
      // Bump progress based on elapsed time (heuristic — the real
      // pipeline stages are inside the pod and surface via the log tail).
      const elapsed = Date.now() - startedAt;
      const expectedMs = Math.max(payloadBytes / 1024 / 100 * 1000, 5000); // ~100 KB/ms rough floor
      const pct = Math.min(90, Math.round(10 + (elapsed / expectedMs) * 80));
      if (pct > lastPct + 5) {
        await progressTask(db, taskId, { pct, text: toSafeText(`Running (${formatDuration(elapsed)})`) });
        lastPct = pct;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }

    // Parse the Job pod's logs for the result JSON line.
    const parsedEnvelope = await parseSpeedtestLog(k8s, jobName);
    if (parsedEnvelope.kind === 'failed') {
      // Job exited 0 but the script chose to fail explicitly (e.g.
      // cleanup-only failure path) — surface the actual reason.
      throw new ApiError('SPEEDTEST_FAILED', parsedEnvelope.reason, 502);
    }
    if (parsedEnvelope.kind !== 'result') {
      throw new ApiError('SPEEDTEST_NO_RESULT', `Speedtest Job ${jobName} completed but emitted no parseable result`, 500);
    }
    const parsed = parsedEnvelope.result;

    result = {
      payloadBytes,
      uploadMbps: parsed.uploadMbps,
      downloadMbps: parsed.downloadMbps,
      latencyMs: parsed.latencyMs,
      durationSeconds: Math.round((Date.now() - startedAt) / 1000),
      taskId,
      operationId,
      ok: true,
      error: null,
      completedAt: new Date().toISOString(),
    };

    // Persist to backup_configurations for the BackupSettings UI tile.
    await db
      .update(backupConfigurations)
      .set({
        lastSpeedtestAt: new Date(),
        lastSpeedtestUploadMbps: String(parsed.uploadMbps),
        lastSpeedtestDownloadMbps: String(parsed.downloadMbps),
        lastSpeedtestLatencyMs: parsed.latencyMs,
        lastSpeedtestPayloadBytes: payloadBytes,
        lastSpeedtestError: null,
      })
      .where(eq(backupConfigurations.id, opts.targetId));

    await finishTask(db, taskId, { status: 'succeeded' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    result = {
      ...result,
      ok: false,
      error: msg,
      completedAt: new Date().toISOString(),
      durationSeconds: Math.round((Date.now() - startedAt) / 1000),
    };
    try {
      await db
        .update(backupConfigurations)
        .set({
          lastSpeedtestAt: new Date(),
          lastSpeedtestUploadMbps: null,
          lastSpeedtestDownloadMbps: null,
          lastSpeedtestLatencyMs: null,
          lastSpeedtestPayloadBytes: payloadBytes,
          lastSpeedtestError: msg,
        })
        .where(eq(backupConfigurations.id, opts.targetId));
    } catch { /* best-effort */ }
    await finishTask(db, taskId, { status: 'failed', error: msg });
    // Best-effort Job cleanup (TTL handles it eventually, but speed up
    // on the failure path for quick iteration).
    try {
      await (k8s.batch as unknown as {
        deleteNamespacedJob: (args: { name: string; namespace: string; propagationPolicy?: string }) => Promise<unknown>;
      }).deleteNamespacedJob({ name: jobName, namespace: PLATFORM_NAMESPACE, propagationPolicy: 'Background' });
    } catch { /* ignore */ }
  }

  return { ...result, targetId: opts.targetId, targetName: target.name };
}

// ─── helpers ──────────────────────────────────────────────────────────

function buildRcloneEnv(
  target: typeof backupConfigurations.$inferSelect,
  encryptionKey: string,
): {
  // Phase 12: split into publicEnv (inline, visible in pod spec) +
  // secretEnv (mounted via ephemeral Secret).
  publicEnv: Array<{ name: string; value: string }>;
  secretEnv: Record<string, string>;
  remoteRef: string;
  kindLabel: string;
} {
  if (target.storageType === 's3') {
    if (!target.s3Bucket || !target.s3Region || !target.s3AccessKeyEncrypted || !target.s3SecretKeyEncrypted) {
      throw new ApiError('TARGET_INCOMPLETE', `S3 target ${target.name} is missing bucket/region/credentials`, 400);
    }
    const accessKey = decrypt(target.s3AccessKeyEncrypted, encryptionKey);
    const secretKey = decrypt(target.s3SecretKeyEncrypted, encryptionKey);
    const prefix = (target.s3Prefix ?? '').replace(/^\/+|\/+$/g, '');
    const publicEnv: Array<{ name: string; value: string }> = [
      { name: 'RCLONE_CONFIG_REMOTE_TYPE', value: 's3' },
      { name: 'RCLONE_CONFIG_REMOTE_PROVIDER', value: 'Other' },
      { name: 'RCLONE_CONFIG_REMOTE_REGION', value: target.s3Region },
      { name: 'RCLONE_S3_CHUNK_SIZE', value: '16M' },
      { name: 'RCLONE_S3_UPLOAD_CONCURRENCY', value: '8' },
      { name: 'RCLONE_CONTIMEOUT', value: '60s' },
      { name: 'RCLONE_TIMEOUT', value: '300s' },
    ];
    if (target.s3Endpoint) {
      publicEnv.push({ name: 'RCLONE_CONFIG_REMOTE_ENDPOINT', value: target.s3Endpoint });
      publicEnv.push({ name: 'RCLONE_CONFIG_REMOTE_FORCE_PATH_STYLE', value: 'true' });
    }
    const secretEnv: Record<string, string> = {
      RCLONE_CONFIG_REMOTE_ACCESS_KEY_ID: accessKey,
      RCLONE_CONFIG_REMOTE_SECRET_ACCESS_KEY: secretKey,
    };
    const remoteRef = `REMOTE:${target.s3Bucket}${prefix ? `/${prefix}` : ''}`;
    return { publicEnv, secretEnv, remoteRef, kindLabel: 's3' };
  }
  if (target.storageType === 'cifs') {
    if (!target.cifsHost || !target.cifsShare || !target.cifsUser || !target.cifsPasswordEncrypted) {
      throw new ApiError('TARGET_INCOMPLETE', `CIFS target ${target.name} is missing host/share/user/password`, 400);
    }
    const plainPassword = decrypt(target.cifsPasswordEncrypted, encryptionKey);
    const obscured = rcloneObscure(plainPassword);
    const publicEnv: Array<{ name: string; value: string }> = [
      { name: 'RCLONE_CONFIG_REMOTE_TYPE', value: 'smb' },
      { name: 'RCLONE_CONFIG_REMOTE_HOST', value: target.cifsHost },
      { name: 'RCLONE_CONTIMEOUT', value: '60s' },
      { name: 'RCLONE_TIMEOUT', value: '300s' },
    ];
    if (target.cifsPort && target.cifsPort !== 445) {
      publicEnv.push({ name: 'RCLONE_CONFIG_REMOTE_PORT', value: String(target.cifsPort) });
    }
    if (target.cifsDomain) {
      publicEnv.push({ name: 'RCLONE_CONFIG_REMOTE_DOMAIN', value: target.cifsDomain });
    }
    const secretEnv: Record<string, string> = {
      RCLONE_CONFIG_REMOTE_USER: target.cifsUser,
      RCLONE_CONFIG_REMOTE_PASS: obscured,
    };
    // Strip any leading and trailing slashes from cifsPath, then always
    // reattach a single leading "/" between share and path. Without this
    // a path like "speedtest-1779…" was concatenated directly onto the
    // share name, and rclone read "u335-sub10speedtest-1779…" as a new
    // (non-existent) share.
    const basePath = target.cifsPath ? target.cifsPath.replace(/^\/+|\/+$/g, '') : '';
    const remoteRef = `REMOTE:${target.cifsShare}${basePath ? `/${basePath}` : ''}`;
    return { publicEnv, secretEnv, remoteRef, kindLabel: 'cifs' };
  }
  throw new ApiError(
    'TARGET_KIND_UNSUPPORTED',
    `Speedtest does not yet support target kind '${target.storageType}'. Use s3 or cifs.`,
    400,
  );
}

/**
 * Pipeline script — emits a single JSON line `SPEEDTEST_RESULT={...}`
 * (or `SPEEDTEST_FAILED=<reason>`) which the platform-api parses out
 * of the pod log.
 *
 * Runs under busybox `sh` inside `rclone/rclone:1.66`. Two non-obvious
 * busybox constraints drive the shape of this script:
 *
 * 1. `date +%s%N` drops `%N` silently and emits only whole seconds —
 *    so we use `/proc/uptime` (centisecond resolution) for timing.
 * 2. `set -e` alone is not enough to catch failures through a pipe;
 *    `set -o pipefail` is also required, and we capture rclone's
 *    exit code explicitly via `RC=$?` after `|| true` for any path
 *    that has fallback semantics.
 */
function buildSpeedtestScript(opts: {
  payloadBytes: number;
  remoteFile: string;
  remoteRef: string;
}): string {
  return [
    '#!/bin/sh',
    'set -e',
    // Without pipefail, `rclone ... 2>&1 | tail -3` masks rclone's
    // non-zero exit and the script reports bogus success.
    'set -o pipefail',
    '',
    '# Helper: sub-second timestamp from /proc/uptime (busybox-safe).',
    'now() { awk "{print \\$1}" /proc/uptime; }',
    '',
    '# Helper: emit a failure line + non-zero exit. Always called via',
    '# `fail "stage" "$LOG"` so the parser sees one canonical line.',
    'fail() {',
    '  STAGE="$1"; REASON="$(printf %s "$2" | tail -3 | tr "\\n" " " | head -c 400)"',
    '  echo "SPEEDTEST_FAILED=${STAGE}: ${REASON}"',
    '  exit 1',
    '}',
    '',
    '# Generate random payload (deterministic size, /dev/urandom for entropy).',
    `dd if=/dev/urandom of=/tmp/speedtest.bin bs=1024 count=${Math.ceil(opts.payloadBytes / 1024)} 2>/dev/null`,
    'ACTUAL_BYTES=$(wc -c < /tmp/speedtest.bin)',
    'echo "[speedtest] payload generated: $ACTUAL_BYTES bytes"',
    '',
    '# Latency probe: rclone size of the remote root. Best-effort; even',
    '# auth failures here are tolerated so the real upload/download',
    '# failures surface with their full error rather than masking under',
    '# an early latency error.',
    'LATENCY_START=$(now)',
    `rclone size --max-depth 1 "${opts.remoteRef}" >/dev/null 2>&1 || true`,
    'LATENCY_END=$(now)',
    'LATENCY_MS=$(awk "BEGIN{printf \\"%d\\", (${LATENCY_END} - ${LATENCY_START}) * 1000}")',
    'echo "[speedtest] latency: ${LATENCY_MS}ms"',
    '',
    '# Upload — capture rclone exit explicitly. If it failed, surface',
    '# the actual error instead of reporting fabricated throughput.',
    '#',
    '# We use `if cmd > log; then RC=0; else RC=$?; fi` instead of',
    '# `VAR=$(cmd); RC=$?` because under busybox ash + `set -e`, a',
    '# command-substitution assignment whose inner command exits',
    '# non-zero terminates the whole script BEFORE `RC=$?` can run',
    '# (verified empirically — without this dance, rclone auth-fail',
    '# kills the script silently and our `fail` helper never runs).',
    'echo "[speedtest] uploading..."',
    'UPLOAD_START=$(now)',
    `if rclone copyto /tmp/speedtest.bin "${opts.remoteRef}/${opts.remoteFile}" > /tmp/upload.log 2>&1; then`,
    '  UPLOAD_RC=0',
    'else',
    '  UPLOAD_RC=$?',
    'fi',
    'UPLOAD_END=$(now)',
    '[ "$UPLOAD_RC" -ne 0 ] && fail "upload" "$(cat /tmp/upload.log)"',
    'UPLOAD_SEC=$(awk "BEGIN{printf \\"%.3f\\", ${UPLOAD_END} - ${UPLOAD_START}}")',
    '# Floor at 10ms (one /proc/uptime tick) to avoid div-by-zero on',
    '# trivially small transfers — still smaller than any real WAN RTT.',
    'UPLOAD_MBPS=$(awk "BEGIN{ s=${UPLOAD_SEC}; if (s<0.01) s=0.01; printf \\"%.2f\\", (${ACTUAL_BYTES} * 8) / (s * 1000000) }")',
    'echo "[speedtest] upload: ${UPLOAD_MBPS} Mbps (${UPLOAD_SEC}s)"',
    '',
    '# Download — same shape as upload (see comment above for why we',
    '# avoid the assignment-of-command-substitution pattern under set -e).',
    'echo "[speedtest] downloading..."',
    'DOWNLOAD_START=$(now)',
    `if rclone copyto "${opts.remoteRef}/${opts.remoteFile}" /tmp/download.bin > /tmp/download.log 2>&1; then`,
    '  DOWNLOAD_RC=0',
    'else',
    '  DOWNLOAD_RC=$?',
    'fi',
    'DOWNLOAD_END=$(now)',
    '[ "$DOWNLOAD_RC" -ne 0 ] && fail "download" "$(cat /tmp/download.log)"',
    'DOWNLOAD_SEC=$(awk "BEGIN{printf \\"%.3f\\", ${DOWNLOAD_END} - ${DOWNLOAD_START}}")',
    'DOWNLOAD_MBPS=$(awk "BEGIN{ s=${DOWNLOAD_SEC}; if (s<0.01) s=0.01; printf \\"%.2f\\", (${ACTUAL_BYTES} * 8) / (s * 1000000) }")',
    'echo "[speedtest] download: ${DOWNLOAD_MBPS} Mbps (${DOWNLOAD_SEC}s)"',
    '',
    '# Cleanup — delete the remote test file. Cleanup failures are not',
    '# fatal (the orphan-sweep cron + per-target retention catch them).',
    `rclone deletefile "${opts.remoteRef}/${opts.remoteFile}" 2>&1 | tail -2 || echo "[speedtest] cleanup warning (file may remain)"`,
    '',
    '# Emit the final result as a single parseable line.',
    'echo "SPEEDTEST_RESULT={\\"uploadMbps\\":${UPLOAD_MBPS},\\"downloadMbps\\":${DOWNLOAD_MBPS},\\"latencyMs\\":${LATENCY_MS},\\"payloadBytes\\":${ACTUAL_BYTES}}"',
  ].join('\n');
}

interface ParsedResult {
  readonly uploadMbps: number;
  readonly downloadMbps: number;
  readonly latencyMs: number;
}

type ParsedLog =
  | { kind: 'result'; result: ParsedResult }
  | { kind: 'failed'; reason: string }
  | { kind: 'none' };

async function readSpeedtestLog(k8s: K8sClients, jobName: string): Promise<string | null> {
  const pods = await (k8s.core as unknown as {
    listNamespacedPod: (args: { namespace: string; labelSelector?: string }) => Promise<{
      items: Array<{ metadata?: { name?: string } }>;
    }>;
  }).listNamespacedPod({ namespace: PLATFORM_NAMESPACE, labelSelector: `job-name=${jobName}` });
  const pod = pods.items?.[0];
  if (!pod?.metadata?.name) return null;

  const logResp = await (k8s.core as unknown as {
    readNamespacedPodLog: (args: { name: string; namespace: string; tailLines?: number }) => Promise<string>;
  }).readNamespacedPodLog({ name: pod.metadata.name, namespace: PLATFORM_NAMESPACE, tailLines: 50 });
  return logResp ?? null;
}

function parseSpeedtestLogText(logText: string | null): ParsedLog {
  if (!logText) return { kind: 'none' };
  const lines = logText.split('\n');
  // Prefer SPEEDTEST_RESULT (success). If absent, surface the FAILED
  // line so operators see the actual rclone error instead of a generic
  // "Job failed".
  for (const line of lines) {
    const m = line.match(/SPEEDTEST_RESULT=(\{.+\})/);
    if (!m) continue;
    try {
      const parsed = JSON.parse(m[1]);
      if (
        typeof parsed.uploadMbps === 'number'
        && typeof parsed.downloadMbps === 'number'
        && typeof parsed.latencyMs === 'number'
      ) {
        return {
          kind: 'result',
          result: {
            uploadMbps: parsed.uploadMbps,
            downloadMbps: parsed.downloadMbps,
            latencyMs: parsed.latencyMs,
          },
        };
      }
    } catch { /* fall through to next line */ }
  }
  for (const line of lines) {
    const f = line.match(/SPEEDTEST_FAILED=(.+)/);
    if (f) return { kind: 'failed', reason: f[1].trim().slice(0, 500) };
  }
  return { kind: 'none' };
}

async function parseSpeedtestLog(k8s: K8sClients, jobName: string): Promise<ParsedLog> {
  return parseSpeedtestLogText(await readSpeedtestLog(k8s, jobName));
}

function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / (1024 ** 3)).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${(bytes / (1024 ** 2)).toFixed(0)} MiB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KiB`;
  return `${bytes} B`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${s % 60}s`;
}
