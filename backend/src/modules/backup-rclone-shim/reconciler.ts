/**
 * backup-rclone-shim reconciler.
 *
 * One pass converges the cluster state with the platform-api's view:
 *
 *   ┌──────────────┐   ┌────────────────────────────┐
 *   │ DB rows      │   │ Secret platform/backup-    │
 *   │ - bt_assigns │   │ target-key                 │
 *   │ - bt_configs │   │  (Tier-1; bootstrap-seed)  │
 *   └──────┬───────┘   └────────────┬───────────────┘
 *          │                        │
 *          ▼                        ▼
 *      service.loadShimAssignments() + loadBackupTargetKey()
 *          │
 *          ▼
 *      renderShimConfig() (pure, in rclone-config.ts)
 *          │
 *          ▼
 *      reconcileBackupRcloneShim() <— this file
 *          │
 *          ├─► ConfigMap platform/backup-rclone-shim-config
 *          │   (merge-patch: rclone.conf + buckets.txt — leaves
 *          │    static launcher.sh untouched)
 *          │
 *          ├─► Secret platform/backup-rclone-shim-ssh-keys
 *          │   (PEM material per class — Secret, not ConfigMap)
 *          │
 *          ├─► DaemonSet platform/backup-rclone-shim
 *          │   spec.template.metadata.annotations.config-hash bump
 *          │   (rolling-restart picks up the new ConfigMap)
 *          │
 *          └─► ConfigMap platform/backup-rclone-shim-status
 *              (operator-readable: state, fingerprint, last reconcile,
 *               assigned classes — polled by rotation CLI)
 *
 * Idempotent:
 *   - The reconciler computes `inputHash` (deterministic) and compares
 *     it against the status ConfigMap's input-hash annotation. Match
 *     means inputs unchanged; no writes happen and the pod-template
 *     annotation is NOT bumped.
 *   - On mismatch, all three writes happen. ConfigMap + DaemonSet
 *     patches use MERGE_PATCH semantics so concurrent unrelated
 *     fields aren't clobbered.
 *
 * Failure modes:
 *   - BACKUP_TARGET_KEY missing → STATE_MISSING_KEY in status CM;
 *     ConfigMap + DaemonSet untouched (shim continues with previous
 *     config until operator re-runs bootstrap.sh or restores bundle).
 *   - No assignments → STATE_NO_ASSIGNMENTS; ConfigMap merge-patched
 *     with empty buckets.txt → launcher.sh sees zero buckets → sleeps.
 *   - Any other error → STATE_ERROR with one-line message; previous
 *     config remains live.
 */

import { createHash } from 'node:crypto';
import type * as k8s from '@kubernetes/client-node';
import type { Logger } from 'pino';

import type { Database } from '../../db/index.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import {
  BUCKETS_TXT_KEY,
  CONFIG_HASH_ANNOTATION,
  FIELD_MANAGER,
  INPUT_HASH_ANNOTATION,
  loadBackupTargetKey,
  loadShimAssignments,
  logAssignmentDiagnostics,
  RCLONE_CONF_KEY,
  SHIM_CONFIG_CM_NAME,
  SHIM_CREDENTIALS_SECRET_NAME,
  SHIM_DAEMONSET_NAME,
  SHIM_NAMESPACE,
  SHIM_SSH_KEYS_SECRET_NAME,
  SHIM_STATUS_CM_NAME,
  ShimKeyMissingError,
  formatStatusForConfigMap,
  type ShimStatus,
  type LoadedAssignments,
} from './service.js';
import {
  computeInputHash,
  renderShimConfig,
  type BackupClass,
  type RenderedShimConfig,
} from './rclone-config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ShimReconcileClients {
  readonly core: k8s.CoreV1Api;
  readonly apps: k8s.AppsV1Api;
}

export interface ShimReconcileResult {
  readonly state: ShimStatus['state'];
  readonly inputHash: string;
  readonly configHash: string;
  readonly assignedClasses: ReadonlyArray<BackupClass>;
  readonly skipped: boolean;
  readonly errorMessage: string;
}

// Lightweight duck-typed views over the k8s SDK return shapes so we
// don't import a half-dozen generated types.
interface ConfigMapShape {
  metadata?: {
    annotations?: Record<string, string>;
  };
  data?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * One full reconcile pass. Safe to call repeatedly (idempotent when
 * inputs are unchanged). Throws are caught at the boundary so the
 * scheduler can keep ticking.
 */
export async function reconcileBackupRcloneShim(
  db: Database,
  clients: ShimReconcileClients,
  encryptionKey: string,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
): Promise<ShimReconcileResult> {
  const reconciledAt = new Date().toISOString();

  // ─── 1. Load BACKUP_TARGET_KEY ───────────────────────────────────
  let keyInput: import('./service.js').BackupTargetKeyInput;
  try {
    keyInput = await loadBackupTargetKey(clients.core, SHIM_NAMESPACE, { log });
  } catch (err) {
    if (err instanceof ShimKeyMissingError) {
      log.error(
        { err: err.message },
        'backup-rclone-shim: BACKUP_TARGET_KEY missing — refusing to render',
      );
      await writeStatus(clients.core, log, {
        state: 'STATE_MISSING_KEY',
        reconciledAt,
        keyFingerprint: '',
        inputHash: '',
        assignedClasses: [],
        errorMessage: err.message,
      });
      return {
        state: 'STATE_MISSING_KEY',
        inputHash: '',
        configHash: '',
        assignedClasses: [],
        skipped: true,
        errorMessage: err.message,
      };
    }
    throw err;
  }

  // ─── 2. Load assignments + decrypt creds ─────────────────────────
  let loaded: LoadedAssignments;
  try {
    loaded = await loadShimAssignments(db, encryptionKey);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'backup-rclone-shim: assignment load failed');
    await writeStatus(clients.core, log, {
      state: 'STATE_ERROR',
      reconciledAt,
      keyFingerprint: keyInput.fingerprint,
      inputHash: '',
      assignedClasses: [],
      errorMessage: msg,
    });
    return {
      state: 'STATE_ERROR',
      inputHash: '',
      configHash: '',
      assignedClasses: [],
      skipped: true,
      errorMessage: msg,
    };
  }
  logAssignmentDiagnostics(loaded, log);

  // ─── 3. No assignments → empty config ───────────────────────────
  if (loaded.assignments.length === 0) {
    // Emit empty rclone.conf + empty buckets.txt → shim sleeps.
    const emptyRendered: RenderedShimConfig = {
      rcloneConf: emptyRcloneConfHeader(keyInput.fingerprint),
      bucketsTxt: '',
      configHash: hashForEmpty(keyInput.fingerprint),
      shimAccessKey: '',
      shimSecretKey: '',
      keyFingerprint: keyInput.fingerprint,
      assignedClasses: [],
      posixMounts: [],
      sshKeyMaterializations: [],
    };
    const emptyInputHash = computeInputHash(keyInput.rawKey, []);
    return await materializeAndWriteStatus(
      clients,
      log,
      reconciledAt,
      emptyRendered,
      emptyInputHash,
      'STATE_NO_ASSIGNMENTS',
      keyInput.fingerprint,
    );
  }

  // ─── 4. Render config + compute input hash ──────────────────────
  let rendered: RenderedShimConfig;
  try {
    rendered = renderShimConfig(keyInput.rawKey, loaded.assignments);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'backup-rclone-shim: render failed');
    await writeStatus(clients.core, log, {
      state: 'STATE_ERROR',
      reconciledAt,
      keyFingerprint: keyInput.fingerprint,
      inputHash: '',
      assignedClasses: [],
      errorMessage: msg,
    });
    return {
      state: 'STATE_ERROR',
      inputHash: '',
      configHash: '',
      assignedClasses: [],
      skipped: true,
      errorMessage: msg,
    };
  }
  const inputHash = computeInputHash(keyInput.rawKey, loaded.assignments);

  // ─── 5. Bail-early if inputs unchanged ──────────────────────────
  const currentInputHash = await readStatusInputHash(clients.core);
  if (currentInputHash === inputHash) {
    log.info(
      { inputHash, classes: rendered.assignedClasses },
      'backup-rclone-shim: inputs unchanged — skipping materialise',
    );
    // Still refresh `reconciledAt` so operators see the loop is alive.
    await writeStatus(clients.core, log, {
      state: 'STATE_OK',
      reconciledAt,
      keyFingerprint: keyInput.fingerprint,
      inputHash,
      assignedClasses: rendered.assignedClasses,
      errorMessage: '',
    });
    return {
      state: 'STATE_OK',
      inputHash,
      configHash: rendered.configHash,
      assignedClasses: rendered.assignedClasses,
      skipped: true,
      errorMessage: '',
    };
  }

  // ─── 6. Materialise: ConfigMap + SSH-keys Secret + DaemonSet ────
  return await materializeAndWriteStatus(
    clients,
    log,
    reconciledAt,
    rendered,
    inputHash,
    'STATE_OK',
    keyInput.fingerprint,
  );
}

// ---------------------------------------------------------------------------
// Materialisation (k8s I/O)
// ---------------------------------------------------------------------------

async function materializeAndWriteStatus(
  clients: ShimReconcileClients,
  log: Pick<Logger, 'info' | 'warn' | 'error'>,
  reconciledAt: string,
  rendered: RenderedShimConfig,
  inputHash: string,
  state: ShimStatus['state'],
  keyFingerprint: string,
): Promise<ShimReconcileResult> {
  try {
    // 6a. ConfigMap merge-patch — non-sensitive data only (buckets.txt).
    // launcher.sh is owned by the static placeholder; merge-patch leaves
    // it untouched.
    await mergePatchConfigMapData(clients.core, log, SHIM_CONFIG_CM_NAME, {
      [BUCKETS_TXT_KEY]: rendered.bucketsTxt,
    });

    // 6b. Credentials Secret — holds the rendered rclone.conf. rclone-
    // obscure is reversible by anyone with the rclone binary, so the
    // rendered conf is effectively a credential bundle: ConfigMap
    // would let any cluster principal with `get configmap` in
    // `platform` exfiltrate upstream provider keys. Secret is the
    // correct object kind here (covered by EncryptionConfiguration
    // when operators enable it; treated more carefully by tooling).
    await materializeCredentialsSecret(
      clients.core,
      log,
      rendered.rcloneConf,
    );

    // 6c. SSH-keys Secret. If empty → ensure Secret has no data.
    await materializeSshKeysSecret(
      clients.core,
      log,
      rendered.sshKeyMaterializations.map((s) => ({
        className: s.className,
        pemContent: s.pemContent,
      })),
    );

    // 6d. DaemonSet annotation bump. Two annotations:
    //   - config-hash (random-IV) → rolling restart
    //   - input-hash  (deterministic) → operator diagnostics
    await patchDaemonSetAnnotations(clients.apps, log, {
      [CONFIG_HASH_ANNOTATION]: rendered.configHash,
      [INPUT_HASH_ANNOTATION]: inputHash,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error({ err: msg }, 'backup-rclone-shim: materialise failed');
    // CRITICAL: do NOT persist inputHash to the status CM on
    // STATE_ERROR. If we did, the next tick's idempotency check
    // (currentInputHash === inputHash) would short-circuit and the
    // shim would stay stuck in STATE_ERROR until operator-driven
    // input change. By writing an empty inputHash here, the next
    // tick will see a hash mismatch and re-attempt materialisation,
    // which is exactly the self-heal behavior we want for transient
    // apiserver failures.
    await writeStatus(clients.core, log, {
      state: 'STATE_ERROR',
      reconciledAt,
      keyFingerprint,
      inputHash: '',
      assignedClasses: rendered.assignedClasses,
      errorMessage: msg,
    });
    return {
      state: 'STATE_ERROR',
      inputHash,
      configHash: rendered.configHash,
      assignedClasses: rendered.assignedClasses,
      skipped: false,
      errorMessage: msg,
    };
  }

  // 6e. Status ConfigMap last so a partial materialisation failure
  // doesn't claim STATE_OK with a stale-input shim.
  await writeStatus(clients.core, log, {
    state,
    reconciledAt,
    keyFingerprint,
    inputHash,
    assignedClasses: rendered.assignedClasses,
    errorMessage: '',
  });

  log.info(
    {
      inputHash,
      configHash: rendered.configHash,
      assignedClasses: rendered.assignedClasses,
      sshKeyCount: rendered.sshKeyMaterializations.length,
      posixMountCount: rendered.posixMounts.length,
    },
    'backup-rclone-shim: reconciled',
  );

  return {
    state,
    inputHash,
    configHash: rendered.configHash,
    assignedClasses: rendered.assignedClasses,
    skipped: false,
    errorMessage: '',
  };
}

// ---------------------------------------------------------------------------
// ConfigMap helpers
// ---------------------------------------------------------------------------

/**
 * Merge-patch only the requested data keys into the named ConfigMap.
 * launcher.sh (and any other operator-owned keys) is preserved.
 *
 * 404 → create the ConfigMap with the requested data + the standard
 * managed-by annotation. This codepath is exercised on fresh clusters
 * before the static placeholder has been applied (or in CI).
 */
async function mergePatchConfigMapData(
  core: k8s.CoreV1Api,
  log: Pick<Logger, 'info' | 'warn'>,
  name: string,
  data: Record<string, string>,
): Promise<void> {
  try {
    await core.readNamespacedConfigMap({
      name,
      namespace: SHIM_NAMESPACE,
    } as unknown as Parameters<typeof core.readNamespacedConfigMap>[0]);
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code !== 404) throw err;
    await core.createNamespacedConfigMap({
      namespace: SHIM_NAMESPACE,
      body: {
        metadata: {
          name,
          namespace: SHIM_NAMESPACE,
          labels: {
            app: 'backup-rclone-shim',
            'app.kubernetes.io/part-of': 'hosting-platform',
            'app.kubernetes.io/component': 'backup',
            'app.kubernetes.io/managed-by': FIELD_MANAGER,
          },
        },
        data,
      },
    } as unknown as Parameters<typeof core.createNamespacedConfigMap>[0]);
    log.info({ name }, 'backup-rclone-shim: ConfigMap created');
    return;
  }

  await core.patchNamespacedConfigMap(
    {
      name,
      namespace: SHIM_NAMESPACE,
      body: { data },
    } as unknown as Parameters<typeof core.patchNamespacedConfigMap>[0],
    MERGE_PATCH,
  );
}

async function readStatusInputHash(
  core: k8s.CoreV1Api,
): Promise<string | null> {
  try {
    const cm = (await core.readNamespacedConfigMap({
      name: SHIM_STATUS_CM_NAME,
      namespace: SHIM_NAMESPACE,
    } as unknown as Parameters<typeof core.readNamespacedConfigMap>[0])) as ConfigMapShape;
    return cm.data?.['inputHash'] ?? null;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code === 404) return null;
    // Any other read error: treat as "unknown" → force a rewrite. The
    // race between status-read and the actual writes is benign: we
    // converge to the correct state.
    return null;
  }
}

async function writeStatus(
  core: k8s.CoreV1Api,
  log: Pick<Logger, 'warn'>,
  status: ShimStatus,
): Promise<void> {
  const data = formatStatusForConfigMap(status);
  try {
    await core.readNamespacedConfigMap({
      name: SHIM_STATUS_CM_NAME,
      namespace: SHIM_NAMESPACE,
    } as unknown as Parameters<typeof core.readNamespacedConfigMap>[0]);
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code !== 404) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        'backup-rclone-shim: status ConfigMap read failed (non-blocking)',
      );
      return;
    }
    try {
      await core.createNamespacedConfigMap({
        namespace: SHIM_NAMESPACE,
        body: {
          metadata: {
            name: SHIM_STATUS_CM_NAME,
            namespace: SHIM_NAMESPACE,
            labels: {
              app: 'backup-rclone-shim',
              'app.kubernetes.io/part-of': 'hosting-platform',
              'app.kubernetes.io/component': 'backup',
              'app.kubernetes.io/managed-by': FIELD_MANAGER,
            },
          },
          data,
        },
      } as unknown as Parameters<typeof core.createNamespacedConfigMap>[0]);
    } catch (createErr) {
      log.warn(
        { err: createErr instanceof Error ? createErr.message : String(createErr) },
        'backup-rclone-shim: status ConfigMap create failed (non-blocking)',
      );
    }
    return;
  }
  try {
    await core.patchNamespacedConfigMap(
      {
        name: SHIM_STATUS_CM_NAME,
        namespace: SHIM_NAMESPACE,
        body: { data },
      } as unknown as Parameters<typeof core.patchNamespacedConfigMap>[0],
      MERGE_PATCH,
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'backup-rclone-shim: status ConfigMap patch failed (non-blocking)',
    );
  }
}

// ---------------------------------------------------------------------------
// Credentials Secret (rclone.conf)
// ---------------------------------------------------------------------------

/**
 * Materialise the rendered rclone.conf into the credentials Secret.
 * Uses MERGE_PATCH on `data` so unrelated keys (if operators added
 * any) aren't clobbered — though under normal operation the Secret
 * has exactly one key.
 *
 * 404 → create the Secret. This is the cold-start path (fresh
 * cluster, Flux hasn't applied the placeholder yet).
 */
async function materializeCredentialsSecret(
  core: k8s.CoreV1Api,
  log: Pick<Logger, 'info' | 'warn'>,
  rcloneConf: string,
): Promise<void> {
  const dataB64 = {
    [RCLONE_CONF_KEY]: Buffer.from(rcloneConf, 'utf8').toString('base64'),
  };

  let exists = false;
  try {
    await core.readNamespacedSecret({
      name: SHIM_CREDENTIALS_SECRET_NAME,
      namespace: SHIM_NAMESPACE,
    } as unknown as Parameters<typeof core.readNamespacedSecret>[0]);
    exists = true;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code !== 404) throw err;
  }

  if (!exists) {
    // backup-coverage: excluded:cluster-infrastructure
    // The contents are recoverable by re-rendering from
    // BACKUP_TARGET_KEY + backup_configurations rows.
    await core.createNamespacedSecret({
      namespace: SHIM_NAMESPACE,
      body: {
        metadata: {
          name: SHIM_CREDENTIALS_SECRET_NAME,
          namespace: SHIM_NAMESPACE,
          labels: {
            app: 'backup-rclone-shim',
            'app.kubernetes.io/part-of': 'hosting-platform',
            'app.kubernetes.io/component': 'backup',
            'app.kubernetes.io/managed-by': FIELD_MANAGER,
          },
        },
        type: 'Opaque',
        data: dataB64,
      },
    } as unknown as Parameters<typeof core.createNamespacedSecret>[0]);
    log.info({ name: SHIM_CREDENTIALS_SECRET_NAME }, 'backup-rclone-shim: credentials Secret created');
    return;
  }

  await core.patchNamespacedSecret(
    {
      name: SHIM_CREDENTIALS_SECRET_NAME,
      namespace: SHIM_NAMESPACE,
      body: { data: dataB64 },
    } as unknown as Parameters<typeof core.patchNamespacedSecret>[0],
    MERGE_PATCH,
  );
}

// ---------------------------------------------------------------------------
// SSH-keys Secret
// ---------------------------------------------------------------------------

interface SshKeyEntry {
  readonly className: BackupClass;
  readonly pemContent: string;
}

/**
 * Materialise per-class SSH PEM keys into the Secret. The renderer's
 * `rclone.conf` references `/etc/rclone/ssh-keys/<class>.pem`, so the
 * data-key MUST be `<class>.pem` for the projected mount to land at
 * the expected path.
 *
 * When `entries` is empty we still ensure the Secret exists with
 * `data: {}` (rather than deleting it) so the DaemonSet's volume
 * source stays valid. The launcher.sh tolerates an empty key
 * directory.
 */
async function materializeSshKeysSecret(
  core: k8s.CoreV1Api,
  log: Pick<Logger, 'warn'>,
  entries: ReadonlyArray<SshKeyEntry>,
): Promise<void> {
  const dataB64: Record<string, string> = {};
  for (const e of entries) {
    if (!e.pemContent.trim()) continue;
    const key = `${e.className}.pem`;
    dataB64[key] = Buffer.from(e.pemContent, 'utf8').toString('base64');
  }

  let exists = false;
  try {
    await core.readNamespacedSecret({
      name: SHIM_SSH_KEYS_SECRET_NAME,
      namespace: SHIM_NAMESPACE,
    } as unknown as Parameters<typeof core.readNamespacedSecret>[0]);
    exists = true;
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code !== 404) throw err;
  }

  if (!exists) {
    // backup-coverage: excluded:cluster-infrastructure
    // Per-class SFTP key material; recoverable from the DB
    // backup_configurations.ssh_key_encrypted column.
    await core.createNamespacedSecret({
      namespace: SHIM_NAMESPACE,
      body: {
        metadata: {
          name: SHIM_SSH_KEYS_SECRET_NAME,
          namespace: SHIM_NAMESPACE,
          labels: {
            app: 'backup-rclone-shim',
            'app.kubernetes.io/part-of': 'hosting-platform',
            'app.kubernetes.io/component': 'backup',
            'app.kubernetes.io/managed-by': FIELD_MANAGER,
          },
        },
        type: 'Opaque',
        data: dataB64,
      },
    } as unknown as Parameters<typeof core.createNamespacedSecret>[0]);
    return;
  }

  // Replace the entire `data` map in ONE call so a removed class's
  // PEM disappears atomically.
  //
  // Why JSON-Patch with a single `replace /data` op (instead of the
  // earlier merge-patch + stale-cleanup dance):
  //   - RFC 7396 merge-patch on `{data: {...}}` MERGES keys; entries
  //     present on the cluster but absent from our payload are LEFT
  //     IN PLACE. That requires a follow-up cleanup pass with a TOCTOU
  //     window between read and delete.
  //   - RFC 6902 JSON-Patch `replace /data` replaces the entire data
  //     map atomically — no TOCTOU, no second round-trip, no stale
  //     entries.
  const replaceDataOp = [{
    op: 'replace' as const,
    path: '/data',
    value: dataB64,
  }];
  const { JSON_PATCH } = await import('../../shared/k8s-patch.js');
  try {
    await core.patchNamespacedSecret(
      {
        name: SHIM_SSH_KEYS_SECRET_NAME,
        namespace: SHIM_NAMESPACE,
        body: replaceDataOp as unknown as object,
      } as unknown as Parameters<typeof core.patchNamespacedSecret>[0],
      JSON_PATCH,
    );
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'backup-rclone-shim: ssh-keys Secret data replace failed (non-blocking)',
    );
  }
}

// ---------------------------------------------------------------------------
// DaemonSet annotation patch
// ---------------------------------------------------------------------------

async function patchDaemonSetAnnotations(
  apps: k8s.AppsV1Api,
  log: Pick<Logger, 'warn'>,
  annotations: Record<string, string>,
): Promise<void> {
  try {
    await apps.patchNamespacedDaemonSet(
      {
        name: SHIM_DAEMONSET_NAME,
        namespace: SHIM_NAMESPACE,
        body: {
          spec: {
            template: {
              metadata: {
                annotations,
              },
            },
          },
        },
      } as unknown as Parameters<typeof apps.patchNamespacedDaemonSet>[0],
      MERGE_PATCH,
    );
  } catch (err) {
    const code = (err as { statusCode?: number; code?: number })?.statusCode
      ?? (err as { code?: number })?.code;
    if (code === 404) {
      // DaemonSet not yet applied (fresh cluster pre-Flux first-sync).
      // Tolerate — the next reconcile pass will succeed once Flux applies.
      log.warn(
        { name: SHIM_DAEMONSET_NAME },
        'backup-rclone-shim: DaemonSet not found — Flux has not applied yet',
      );
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function emptyRcloneConfHeader(fingerprint: string): string {
  return [
    '# rclone.conf — backup-rclone-shim (no class assignments)',
    `# key-fingerprint = ${fingerprint}`,
    '# AUTO-GENERATED. Operators assign targets via the admin panel.',
    '',
  ].join('\n');
}

function hashForEmpty(fingerprint: string): string {
  return createHash('sha256')
    .update('empty\n')
    .update(fingerprint)
    .digest('hex');
}
