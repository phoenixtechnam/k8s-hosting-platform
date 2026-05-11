/**
 * Bundle orchestrator (ADR-032 §6).
 *
 * State machine:
 *
 *   reserveBundle
 *     → write files component (Job, slow)
 *     → write config component (in-process)
 *     → write secrets component (in-process; AES-256-GCM)
 *     → write mailboxes component (Phase 3, see ADR-032)
 *     → putMeta (commit marker)
 *
 * Any single component failure marks `backup_components.status='failed'`
 * and the bundle `backup_jobs.status='partial'`. The caller (admin
 * endpoint or scheduler) can resume by re-running only the failed
 * components — putMeta is only invoked when every enabled component
 * is `completed`.
 *
 * The orchestrator is intentionally agnostic to:
 *   - The store kind. It always calls through {@link BackupStore}.
 *   - The initiator. ACL is enforced at the route layer; the same
 *     orchestrator runs admin/system/scheduled bundles.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import {
  backupJobs,
  backupComponents,
  clients,
  domains,
  deployments,
  type NewBackupJob,
  type NewBackupComponent,
} from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { BackupStore } from './bundle-store.js';
import {
  BACKUP_META_SCHEMA_VERSION,
  type BackupMetaV1,
  type BackupInitiator,
  type BackupSystemTrigger,
  type BackupComponentName,
} from '@k8s-hosting/api-contracts';
import {
  captureFilesComponent,
  FilesComponentSkippedError,
  type FilesComponentResult,
} from './components/files.js';
import { runPreCaptureDatabaseDumps } from './components/database-predump-orchestration.js';
import { recordResticSnapshot, recordResticRunFailed } from './repo-state.js';
import {
  buildResticRepoUri,
  deriveRegionId,
  type BackupTarget,
  type ResticComponent,
} from './restic-driver.js';
import { resolveBackupTarget } from './resolve-backup-target.js';
import { resolveBaseDomain } from '../../config/domains.js';
import { backupConfigurations, tenantBackupV2Settings } from '../../db/schema.js';
import { captureConfigComponent, type ConfigComponentResult } from './components/config.js';
import { captureSecretsComponent, type SecretsComponentResult } from './components/secrets.js';

export interface OrchestratorDeps {
  readonly db: Database;
  readonly k8s: K8sClients | undefined;
  readonly store: BackupStore;
  readonly platformVersion: string;
  readonly secretsKeyHex: string;
  /**
   * Internal cluster URL of platform-api — passed into the
   *  files-component Job so it can POST archive + tree uploads back
   *  to the BackupStore. Format: `http://platform-api.platform.svc:3000`.
   *  Required for files component capture (Phase 3).
   */
  readonly platformApiUrl?: string;
  /** Legacy — unused since the hostpath production path was retired
   *  in favour of off-site-only stores. Kept on the type for unit
   *  tests that still pass it; ignored by the orchestrator. */
  readonly hostpathRoot?: string;
  /** Platform DNS apex used to derive the snapshot-tag region id
   *  (slugified). Caller passes app.config.PLATFORM_BASE_DOMAIN.
   *  Falls back to a placeholder for unit tests where region tagging
   *  is not under test. */
  readonly platformBaseDomain?: string;
  /** Path to a kubeconfig file for `kubectl exec` inside the SQL
   *  Manager pre-dump path. NULL/undefined → use the in-cluster
   *  serviceaccount (the standard production path). */
  readonly kubeconfigPath?: string;
}

export interface RunBundleInput {
  readonly clientId: string;
  readonly initiator: BackupInitiator;
  readonly systemTrigger?: BackupSystemTrigger | null;
  readonly label?: string | null;
  readonly description?: string | null;
  readonly retentionDays: number;
  readonly targetConfigId?: string | null;
  readonly targetUri: string;
  readonly components: { files: boolean; mailboxes: boolean; config: boolean; secrets: boolean };
  /**
   * GDPR data-export wrapper. When set, after meta.json is committed
   * the orchestrator builds a single AES-256-CBC tarball of every
   * component artifact + meta.json, encrypted with `exportPassphrase`
   * (the platform never stores the passphrase). The artifact is
   * written to components/config/data-export-<bundleId>.tar.gz.enc
   * and its name is recorded in backup_jobs.export_artifact.
   */
  readonly exportMode?: 'data_export' | null;
  readonly exportPassphrase?: string | null;
  /**
   * Optional callback fired AFTER the `backup_jobs` row is inserted
   * (status='pending') and the bundle is reserved on the off-site
   * target. Async callers use this to return the bundleId to the
   * client immediately while the rest of the orchestration runs in
   * the background. Synchronous callers can ignore it.
   */
  readonly onBundleReserved?: (bundleId: string) => void | Promise<void>;
  /**
   * The user (admin or client) that initiated the bundle. Threaded
   * through to the Task Tracker chip so the operator's session lights
   * up. Null for system/cron-triggered bundles (initiator='system' or
   * 'cluster') — those land in notifications on failure, never in any
   * user's chip per the UX agreement.
   */
  readonly triggeredByUserId?: string | null;
}

export interface RunBundleResult {
  readonly bundleId: string;
  readonly status: 'completed' | 'partial';
  readonly meta: BackupMetaV1;
}

/**
 * Run a backup bundle synchronously. Caller is expected to have
 * already validated input + plan-quota. The function inserts the
 * `backup_jobs` row, drives every enabled component, and returns
 * once meta.json is committed (or aborts with an error if any
 * component failed).
 */
export async function runBundle(
  deps: OrchestratorDeps,
  input: RunBundleInput,
): Promise<RunBundleResult> {
  const bundleId = `bkp-${randomUUID()}`;

  // Resolve the client's namespace + PVC up-front. We need both for
  // the files + secrets components; failing here gives a clean error
  // before any external state is touched.
  const namespace = await resolveClientNamespace(deps.db, input.clientId);

  // Insert the backup_jobs row in `pending`.
  const newJob: NewBackupJob = {
    id: bundleId,
    clientId: input.clientId,
    initiator: input.initiator,
    systemTrigger: input.systemTrigger ?? null,
    status: 'pending',
    targetKind: deps.store.kind,
    targetUri: input.targetUri,
    targetConfigId: input.targetConfigId ?? null,
    label: input.label ?? null,
    description: input.description ?? null,
    sizeBytes: 0,
    retentionDays: input.retentionDays,
    expiresAt: input.retentionDays > 0 ? addDays(new Date(), input.retentionDays) : null,
    startedAt: new Date(),
  };
  await deps.db.insert(backupJobs).values(newJob);

  // Mirror to the Task Tracker chip — best-effort, never throws.
  // Skipped when system/cron-triggered (no triggeredByUserId).
  if (input.triggeredByUserId) {
    try {
      const { start: startTask } = await import('../tasks/service.js');
      const { toSafeText } = await import('@k8s-hosting/api-contracts');
      await startTask(deps.db, {
        kind: 'backup.bundle',
        refId: bundleId,
        scope: input.initiator === 'client' ? 'client' : 'admin',
        userId: input.triggeredByUserId,
        clientId: input.clientId,
        label: toSafeText(`Backup bundle (${input.clientId.slice(0, 8)})`),
        target: { type: 'route', href: `/clients/${input.clientId}?tab=backups` },
        details: { bundleId, initiator: input.initiator },
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[tenant-bundles] task tracker enroll failed for ${bundleId}: ${msg}`);
    }
  }

  // Reserve the bundle in the store (in-flight; meta.json absent).
  const handle = await deps.store.reserveBundle({ backupId: bundleId, clientId: input.clientId });

  await deps.db
    .update(backupJobs)
    .set({ status: 'running' })
    .where(eq(backupJobs.id, bundleId));

  // The bundle now has a row + a reserved off-site directory. Async
  // callers can early-return the bundleId here while the rest of the
  // capture continues. Component progress is observable via
  // GET /admin/tenant-bundles/:id (the row is updated as each
  // component flips through pending → running → completed/failed).
  if (input.onBundleReserved) await input.onBundleReserved(bundleId);

  const errors: string[] = [];
  const componentInfos: BackupMetaV1['components'] = {};

  // Components run in parallel via Promise.allSettled. Each branch
  // owns its own backup_components row + try/catch + failure
  // bookkeeping; aggregating after means a single component's failure
  // never blocks the others. Total wall-clock is now
  // max(files, mailboxes) instead of the previous serial sum.
  //
  // Parallelism contract:
  //   * `errors[]`, `componentInfos`, and the `*Result` lets are
  //     written from concurrent async closures. The Node.js event
  //     loop runs each microtask atomically, so distinct-key writes
  //     do not interleave. Adding a step that READS these mid-flight
  //     (i.e., before `await Promise.allSettled` returns) would
  //     break that contract — keep all aggregation strictly after.
  //   * Each branch is responsible for finalising its own
  //     backup_components row to a terminal state (completed, failed,
  //     or skipped). Branches must not throw out of the IIFE.
  let filesResult: FilesComponentResult | undefined;
  let configResult: ConfigComponentResult | undefined;
  let secretsResult: SecretsComponentResult | undefined;
  let mailboxesResult: import('./components/mailboxes.js').MailboxesComponentResult | undefined;

  const tasks: Array<Promise<void>> = [];

  // ── files ──────────────────────────────────────────────────────
  if (input.components.files) {
    tasks.push((async () => {
      if (!deps.k8s) {
        errors.push('files: kubernetes client unavailable');
        await markComponentFailed(deps.db, bundleId, 'files', 'archive.tar.gz', 'kubernetes client unavailable');
        return;
      }
      const componentRowId = await insertComponentRow(deps.db, bundleId, 'files', 'archive.tar.gz');
      try {
        if (!deps.platformApiUrl) {
          throw new Error('files component requires platformApiUrl on OrchestratorDeps (Phase 3 HTTP-upload pattern)');
        }
        // Reviewer #2: derive pvcName from the namespace already
        // resolved at line 153 — saves a redundant SELECT on `clients`
        // in the bundle hot path. Convention `${ns}-storage` mirrors
        // resolveTenantPvc / component-registry.ts.
        const pvcName = `${namespace}-storage`;

        // Phase 1 piece #6 (ADR-036): pre-capture DB dump hook. Walks
        // every database deployment for the tenant and dispatches
        // mysqldump/pg_dump INSIDE the live tenant DB pod via the
        // existing SQL Manager primitive. Dumps land at /exports/...
        // on the tenant PVC and are picked up by the tar stream below.
        // Failures are per-deployment + per-database; never abort the
        // bundle (the file-system snapshot is still valid even if
        // logical dumps fail).
        try {
          const predumpResults = await runPreCaptureDatabaseDumps({
            db: deps.db,
            k8s: deps.k8s,
            clientId: input.clientId,
            namespace,
            backupId: bundleId,
            kubeconfigPath: deps.kubeconfigPath,
          });
          for (const r of predumpResults) {
            if (r.error) {
              // eslint-disable-next-line no-console
              console.warn(`[bundle ${bundleId}] pre-dump failed for ${r.deploymentName}: ${r.error}`);
            }
          }
        } catch (err) {
          // Non-fatal — log and proceed with the FS snapshot anyway.
          // eslint-disable-next-line no-console
          console.warn(`[bundle ${bundleId}] pre-dump orchestration error: ${(err as Error).message}`);
        }

        filesResult = await captureFilesComponent({
          k8s: deps.k8s,
          namespace,
          pvcName,
          clientId: input.clientId,
          backupId: bundleId,
          platformApiUrl: deps.platformApiUrl,
          secretsKeyHex: deps.secretsKeyHex,
        });
        await markComponentDone(deps.db, componentRowId, { sizeBytes: filesResult.sizeBytes, sha256: filesResult.sha256 });
        componentInfos.files = {
          sizeBytes: filesResult.sizeBytes,
          fileCount: filesResult.fileCount,
          sha256: filesResult.sha256,
        };

        // Persist tenant_restic_repo_state so the admin UI + retention
        // sweeper can reach the per-tenant repo without re-resolving
        // the BackupConfiguration. Best-effort — a write failure here
        // does NOT mark the bundle failed (snapshot is already on the
        // store). Operator surfaces it via the staleness query.
        try {
          await recordResticSnapshotForFiles({
            deps,
            input,
            bundleId,
            snapshotId: filesResult.snapshotId,
            sizeBytes: filesResult.sizeBytes,
          });
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[bundle ${bundleId}] could not persist tenant_restic_repo_state: ${(err as Error).message}`);
        }
      } catch (err) {
        if (err instanceof FilesComponentSkippedError) {
          // PVC missing → record skipped, do NOT add to errors[].
          await markComponentRowSkipped(deps.db, componentRowId, err.reason);
          return;
        }
        const msg = (err as Error).message ?? 'files capture failed';
        errors.push(`files: ${msg}`);
        await markComponentRowFailed(deps.db, componentRowId, msg);
        // Bump last_run_at so "stale tenant" alerts pick this up
        // even on first-attempt failures (no prior row exists).
        await recordResticRunFailed({
          db: deps.db,
          clientId: input.clientId,
          component: 'files',
          runAt: new Date(),
        }).catch(() => undefined);
      }
    })());
  }

  // ── config ─────────────────────────────────────────────────────
  if (input.components.config) {
    tasks.push((async () => {
      const componentRowId = await insertComponentRow(deps.db, bundleId, 'config', 'db-rows.json.gz');
      try {
        configResult = await captureConfigComponent({
          db: deps.db,
          clientId: input.clientId,
          store: deps.store,
          handle,
        });
        await markComponentDone(deps.db, componentRowId, { sizeBytes: configResult.sizeBytes, sha256: null });
        componentInfos.config = { sizeBytes: configResult.sizeBytes, rowCount: configResult.rowCount };
      } catch (err) {
        const msg = (err as Error).message ?? 'config capture failed';
        errors.push(`config: ${msg}`);
        await markComponentRowFailed(deps.db, componentRowId, msg);
      }
    })());
  }

  // ── secrets ────────────────────────────────────────────────────
  if (input.components.secrets) {
    tasks.push((async () => {
      if (!deps.k8s) {
        errors.push('secrets: kubernetes client unavailable');
        await markComponentFailed(deps.db, bundleId, 'secrets', 'tls.json.gz.enc', 'kubernetes client unavailable');
        return;
      }
      // Skip-when-empty: if the tenant ns has no Secrets at all there
      // is nothing to encrypt + ship. Still record the component row
      // (status='skipped') so the coverage drift report stays
      // consistent.
      const hasSecrets = await tenantNamespaceHasSecrets(deps.k8s, namespace);
      const componentRowId = await insertComponentRow(deps.db, bundleId, 'secrets', 'tls.json.gz.enc');
      if (!hasSecrets) {
        await markComponentRowSkipped(deps.db, componentRowId, `no secrets in namespace ${namespace}`);
        return;
      }
      try {
        secretsResult = await captureSecretsComponent({
          k8s: deps.k8s,
          namespace,
          store: deps.store,
          handle,
          keyHex: deps.secretsKeyHex,
        });
        await markComponentDone(deps.db, componentRowId, { sizeBytes: secretsResult.sizeBytes, sha256: null });
        componentInfos.secrets = {
          sizeBytes: secretsResult.sizeBytes,
          secretCount: secretsResult.secretCount,
          encryptionKeyId: secretsResult.encryptionKeyId,
        };
      } catch (err) {
        const msg = (err as Error).message ?? 'secrets capture failed';
        errors.push(`secrets: ${msg}`);
        await markComponentRowFailed(deps.db, componentRowId, msg);
      }
    })());
  }

  // ── mailboxes ──────────────────────────────────────────────────
  if (input.components.mailboxes) {
    tasks.push((async () => {
      if (!deps.k8s) {
        errors.push('mailboxes: kubernetes client unavailable');
        await markComponentFailed(deps.db, bundleId, 'mailboxes', '__pending__', 'kubernetes client unavailable');
        return;
      }
      if (!deps.platformApiUrl) {
        errors.push('mailboxes: platformApiUrl required for HTTP-upload pattern');
        await markComponentFailed(deps.db, bundleId, 'mailboxes', '__pending__', 'platformApiUrl missing');
        return;
      }
      // Skip-when-empty: a client without any mailboxes rows skips
      // the whole mbsync Job — saves up to 60 min of activeDeadline
      // on every clientful-of-no-mail bundle. Recorded as `skipped`
      // so the coverage drift report still tracks the component.
      const mailboxCount = await countClientMailboxes(deps.db, input.clientId);
      const componentRowId = await insertComponentRow(deps.db, bundleId, 'mailboxes', '__pending__');
      if (mailboxCount === 0) {
        await markComponentRowSkipped(deps.db, componentRowId, 'no mailboxes for client');
        return;
      }
      try {
        const { captureMailboxesComponent } = await import('./components/mailboxes.js');
        mailboxesResult = await captureMailboxesComponent({
          db: deps.db,
          k8s: deps.k8s,
          clientId: input.clientId,
          backupId: bundleId,
          platformApiUrl: deps.platformApiUrl,
          secretsKeyHex: deps.secretsKeyHex,
        });
        await markComponentDone(deps.db, componentRowId, { sizeBytes: mailboxesResult.sizeBytes, sha256: null });
        componentInfos.mailboxes = {
          sizeBytes: mailboxesResult.sizeBytes,
          mailboxCount: mailboxesResult.mailboxCount,
          addresses: [...mailboxesResult.addresses],
        };
        // Persist Email/changes state AFTER the restic snapshot is
        // acked (ADR-036 — at-least-once: dedup makes re-pull harmless).
        // Best-effort: a row-write failure here doesn't fail the
        // bundle (snapshot is already on the off-site target).
        if (mailboxesResult.newStates.length > 0) {
          try {
            const { persistJmapStates } = await import('./components/mailboxes-state.js');
            await persistJmapStates(deps.db, input.clientId, mailboxesResult.newStates);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // eslint-disable-next-line no-console
            console.warn(`[tenant-bundles] tenant_jmap_state persist failed for ${input.clientId}: ${msg}`);
          }
        }
      } catch (err) {
        const msg = (err as Error).message ?? 'mailboxes capture failed';
        errors.push(`mailboxes: ${msg}`);
        await markComponentRowFailed(deps.db, componentRowId, msg);
      }
    })());
  }

  // Wait for every component to finish — succeeded, failed, or
  // skipped. We never reject out of allSettled because each task
  // already swallowed its own error into `errors[]`; passing this
  // through as `await Promise.all` would crash the orchestrator on
  // an unexpected throw.
  await Promise.allSettled(tasks);

  // Bundle is `completed` iff no component reported a failure into
  // `errors[]`. `skipped` rows do not contribute — a client with no
  // mailboxes still produces a fully-completed bundle.
  const status: 'completed' | 'partial' = errors.length === 0 ? 'completed' : 'partial';

  // Build + persist meta.json *only* if every requested non-mailbox
  // component succeeded — otherwise the bundle is partial and meta.json
  // is left absent so retention sweeps can GC the in-flight prefix.
  const totalSize =
    (filesResult?.sizeBytes ?? 0) +
    (configResult?.sizeBytes ?? 0) +
    (secretsResult?.sizeBytes ?? 0) +
    (mailboxesResult?.sizeBytes ?? 0);

  // v2 meta.json: capture the client account + counts + summaries so
  // the import flow can present a confirmation dialog without
  // unzipping the config component.
  const clientMetaBlock = await captureClientBlock(deps.db, input.clientId);
  const domainsSummaryRO = await captureDomainsSummary(deps.db, input.clientId);
  const deploymentsSummaryRO = await captureDeploymentsSummary(deps.db, input.clientId);
  const domainsSummary = [...domainsSummaryRO];
  const deploymentsSummary = [...deploymentsSummaryRO];

  const meta: BackupMetaV1 = {
    schemaVersion: BACKUP_META_SCHEMA_VERSION,
    backupId: bundleId,
    clientId: input.clientId,
    capturedAt: new Date().toISOString(),
    platformVersion: deps.platformVersion,
    initiator: input.initiator,
    systemTrigger: input.systemTrigger ?? null,
    label: input.label ?? null,
    components: componentInfos,
    nodePlacement: clientMetaBlock.workerNodeName
      ? { preferredNode: clientMetaBlock.workerNodeName, preferredRegion: clientMetaBlock.regionId }
      : null,
    expiresAt: input.retentionDays > 0
      ? addDays(new Date(), input.retentionDays).toISOString()
      : null,
    retentionDays: input.retentionDays,
    description: input.description ?? null,
    client: clientMetaBlock,
    domainsSummary,
    deploymentsSummary,
  };

  if (status === 'completed') {
    await deps.store.putMeta(handle, meta);
  }

  // GDPR data-export wrapper. Only on a fully-completed bundle —
  // partials would produce a half-tarball that can't be safely
  // restored from. The wrapper streams every artifact + meta.json
  // through tar → gzip → AES-256-CBC and writes the result to the
  // off-site target. We record the resulting artifact name on
  // backup_jobs.export_artifact for the download endpoint.
  let exportArtifact: string | null = null;
  if (status === 'completed' && input.exportMode === 'data_export' && input.exportPassphrase) {
    try {
      const componentsToWrap: ReadonlyArray<{ component: BackupComponentName; name: string }> = (
        await deps.db.select().from(backupComponents).where(eq(backupComponents.backupJobId, bundleId))
      )
        .filter((c) => c.status === 'completed' && c.artifactName)
        .map((c) => ({ component: c.component as BackupComponentName, name: c.artifactName! }));
      const { wrapBundleAsDataExport } = await import('./data-export.js');
      const wrapped = await wrapBundleAsDataExport({
        store: deps.store,
        handle,
        backupId: bundleId,
        passphrase: input.exportPassphrase,
        components: componentsToWrap as ReadonlyArray<{ component: 'files' | 'mailboxes' | 'config' | 'secrets'; name: string }>,
      });
      exportArtifact = wrapped.artifactPath;
    } catch (err) {
      // Wrap failure is recorded as an error on the bundle but
      // does NOT downgrade status from 'completed' — the underlying
      // bundle is still good and the operator can re-trigger the
      // export wrap separately. Surface the error so the UI can
      // present a "wrap failed; retry" affordance.
      errors.push(`data_export: ${(err as Error).message}`);
    }
  }

  await deps.db
    .update(backupJobs)
    .set({
      status,
      sizeBytes: totalSize,
      finishedAt: new Date(),
      lastError: errors.length === 0 ? null : errors.join('; '),
      exportMode: input.exportMode ?? null,
      exportArtifact,
    })
    .where(eq(backupJobs.id, bundleId));

  // Mirror terminal state to the chip + bell.
  //
  // UX contract: the chip surfaces in-flight + recent-success work.
  // Failures land in the notifications bell instead — the chip would
  // otherwise show a red row for 5 min and operators have to manually
  // dismiss it. `clearImmediately: true` sets the task's cleared_at
  // alongside the failed status so the chip hides it the moment we
  // know it failed. The same details (truncated error, bundleId) flow
  // into a per-user notification so the operator can still find the
  // failure on the bell.
  if (input.triggeredByUserId) {
    try {
      const { finishByRef } = await import('../tasks/service.js');
      const { toSafeText } = await import('@k8s-hosting/api-contracts');
      const failed = errors.length > 0;
      const taskStatus = failed ? 'failed' : 'succeeded';
      const errText = failed ? errors.join('; ').slice(0, 4096) : null;
      await finishByRef(deps.db, 'backup.bundle', bundleId, {
        status: taskStatus,
        text: toSafeText(`${(totalSize / (1024 * 1024)).toFixed(1)} MiB captured`),
        error: errText,
        clearImmediately: failed,
      });
      if (failed) {
        try {
          const { notifyUser } = await import('../notifications/service.js');
          await notifyUser(deps.db, input.triggeredByUserId, {
            type: 'error',
            title: 'Backup bundle failed',
            message: `Bundle ${bundleId} (${input.clientId.slice(0, 8)}…) failed: ${errText ?? 'unknown error'}`,
            resourceType: 'backup_bundle',
            resourceId: bundleId,
          });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[tenant-bundles] notification publish failed for ${bundleId}: ${msg}`);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[tenant-bundles] task tracker finish failed for ${bundleId}: ${msg}`);
    }
  }

  return { bundleId, status, meta };
}

async function insertComponentRow(
  db: Database,
  bundleId: string,
  component: BackupComponentName,
  artifactName: string,
): Promise<string> {
  const id = randomUUID();
  await db.insert(backupComponents).values({
    id,
    backupJobId: bundleId,
    component,
    artifactName,
    status: 'running',
    startedAt: new Date(),
  } satisfies NewBackupComponent);
  return id;
}

async function markComponentDone(
  db: Database,
  rowId: string,
  fields: { sizeBytes: number; sha256: string | null },
): Promise<void> {
  await db
    .update(backupComponents)
    .set({
      status: 'completed',
      sizeBytes: fields.sizeBytes,
      sha256: fields.sha256,
      finishedAt: new Date(),
    })
    .where(eq(backupComponents.id, rowId));
}

async function markComponentRowFailed(
  db: Database,
  rowId: string,
  error: string,
): Promise<void> {
  await db
    .update(backupComponents)
    .set({ status: 'failed', lastError: error, finishedAt: new Date() })
    .where(eq(backupComponents.id, rowId));
}

/**
 * Record a component as `skipped` — used when there is nothing to
 * capture (no mailboxes, no Secrets, no PVC). Skipped rows do NOT
 * count as bundle failures; the overall bundle can still be
 * `completed`. The reason is stored in `last_error` so the operator
 * UI can show why nothing shipped.
 */
async function markComponentRowSkipped(
  db: Database,
  rowId: string,
  reason: string,
): Promise<void> {
  await db
    .update(backupComponents)
    .set({ status: 'skipped', lastError: reason, finishedAt: new Date() })
    .where(eq(backupComponents.id, rowId));
}

async function markComponentFailed(
  db: Database,
  bundleId: string,
  component: BackupComponentName,
  artifactName: string,
  error: string,
): Promise<void> {
  await db.insert(backupComponents).values({
    id: randomUUID(),
    backupJobId: bundleId,
    component,
    artifactName,
    status: 'failed',
    lastError: error,
    startedAt: new Date(),
    finishedAt: new Date(),
  } satisfies NewBackupComponent);
}

/**
 * Resolve the client's namespace + tenant data PVC name in one query.
 *
 * Convention (matches storage-lifecycle/service.ts):
 *   namespace = clients.kubernetesNamespace
 *   pvcName   = `${namespace}-storage`
 *
 * Throws OperatorError-friendly messages when the client is missing or
 * has no provisioned namespace yet (e.g. a freshly created client whose
 * provisioning Job hasn't run).
 */
async function resolveClientNamespace(db: Database, clientId: string): Promise<string> {
  const [r] = await db
    .select({ ns: clients.kubernetesNamespace })
    .from(clients)
    .where(eq(clients.id, clientId))
    .limit(1);
  if (!r) throw new Error(`client not found: ${clientId}`);
  if (!r.ns) throw new Error(`client ${clientId} has no kubernetesNamespace yet — wait for provisioning to complete`);
  return r.ns;
}

async function resolveTenantPvc(db: Database, clientId: string): Promise<string> {
  const namespace = await resolveClientNamespace(db, clientId);
  return `${namespace}-storage`;
}

function addDays(d: Date, days: number): Date {
  const next = new Date(d);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

/**
 * Build the meta.json `client` block (v2). Pulls the live row from
 * `clients` + counts via raw SQL to keep the latency low. Throws if
 * the client is missing — capture should fail loudly because a v2
 * bundle without a client block can't be imported.
 *
 * Numeric override fields land in PG as `numeric(...)` and Drizzle
 * returns them as strings; we coerce to number|null so the JSON
 * round-trips cleanly through z.number().nullable() on the schema.
 */
async function captureClientBlock(
  db: Database,
  clientId: string,
): Promise<import('@k8s-hosting/api-contracts').BackupMetaClient> {
  const [c] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!c) throw new Error(`captureClientBlock: client ${clientId} not found`);

  const rawDb = db as unknown as {
    execute: (q: ReturnType<typeof sql>) => Promise<{
      rows: Array<{ mailboxes: number | string; domains: number | string; deployments: number | string }>;
    }>;
  };
  const counts = await rawDb.execute(sql`
    SELECT
      (SELECT COUNT(*)::int FROM mailboxes WHERE client_id = ${clientId})  AS mailboxes,
      (SELECT COUNT(*)::int FROM domains    WHERE client_id = ${clientId})  AS domains,
      (SELECT COUNT(*)::int FROM deployments WHERE client_id = ${clientId} AND deleted_at IS NULL) AS deployments
  `);
  const row = counts.rows[0] ?? { mailboxes: 0, domains: 0, deployments: 0 };

  const numOrNull = (v: unknown): number | null =>
    v === null || v === undefined ? null : Number(v);

  return {
    companyName: c.companyName,
    companyEmail: c.companyEmail,
    contactEmail: c.contactEmail ?? null,
    status: c.status as string,
    kubernetesNamespace: c.kubernetesNamespace,
    regionId: c.regionId,
    planId: c.planId,
    workerNodeName: c.workerNodeName ?? null,
    storageTier: c.storageTier as string,
    timezone: c.timezone ?? null,
    storageLimitOverride: numOrNull(c.storageLimitOverride),
    cpuLimitOverride: numOrNull(c.cpuLimitOverride),
    memoryLimitOverride: numOrNull(c.memoryLimitOverride),
    maxSubUsersOverride: c.maxSubUsersOverride ?? null,
    maxMailboxesOverride: c.maxMailboxesOverride ?? null,
    monthlyPriceOverride: numOrNull(c.monthlyPriceOverride),
    emailSendRateLimit: c.emailSendRateLimit ?? null,
    subscriptionExpiresAt: c.subscriptionExpiresAt ? c.subscriptionExpiresAt.toISOString() : null,
    counts: {
      mailboxes: Number(row.mailboxes ?? 0),
      domains: Number(row.domains ?? 0),
      deployments: Number(row.deployments ?? 0),
    },
  };
}

async function captureDomainsSummary(
  db: Database,
  clientId: string,
): Promise<ReadonlyArray<import('@k8s-hosting/api-contracts').BackupMetaDomainSummary>> {
  const rows = await db
    .select({ name: domains.domainName, status: domains.status })
    .from(domains)
    .where(eq(domains.clientId, clientId));
  return rows.map((r) => ({ name: r.name, status: r.status as string }));
}

async function captureDeploymentsSummary(
  db: Database,
  clientId: string,
): Promise<ReadonlyArray<import('@k8s-hosting/api-contracts').BackupMetaDeploymentSummary>> {
  const rows = await db
    .select({
      name: deployments.name,
      catalogEntryId: deployments.catalogEntryId,
      replicas: deployments.replicaCount,
      status: deployments.status,
    })
    .from(deployments)
    .where(eq(deployments.clientId, clientId));
  // Type predicate so the post-filter type narrows from
  // `name: string | null` to `name: string` (Array.prototype.filter
  // does not narrow without an explicit predicate). Belt-and-braces:
  // the column is currently non-null at the schema level, but if it
  // is ever made nullable a silent null-leak into the meta would be
  // a data-corruption bug — caught here at compile time.
  const isComplete = (r: typeof rows[number]): r is typeof r & { name: string; catalogEntryId: string } =>
    Boolean(r.name && r.catalogEntryId);
  return rows
    .filter(isComplete)
    .map((r) => ({
      name: r.name,
      catalogEntryId: r.catalogEntryId,
      replicas: r.replicas ?? 0,
      status: r.status as string,
    }));
}

/**
 * Count the client's mailboxes without dragging the full list across
 * the wire. Used to decide whether to skip the mailboxes component
 * entirely. Failure is non-fatal: an error here returns `1` so the
 * Job runs anyway (better to spawn an empty Job than to silently skip
 * a component on a transient DB hiccup).
 */
async function countClientMailboxes(db: Database, clientId: string): Promise<number> {
  try {
    const rawDb = db as unknown as { execute: (q: ReturnType<typeof sql>) => Promise<{ rows: { count: string | number }[] }> };
    const r = await rawDb.execute(
      sql`SELECT COUNT(*)::int AS count FROM mailboxes WHERE client_id = ${clientId}`,
    );
    const c = r.rows[0]?.count;
    return typeof c === 'number' ? c : Number(c ?? 0);
  } catch {
    return 1;
  }
}

/**
 * Probe for ANY Secret in the tenant namespace. Used to decide
 * whether to spawn the secrets-component capture (which would
 * otherwise produce a near-empty AES-256 envelope). Service-account
 * tokens etc. are excluded because they are recreated on restore by
 * the platform itself.
 *
 * Failure mode: any API error returns `true` so the capture is
 * attempted (loud failure beats silent skip).
 *
 * Threat-model note: a tenant with `secrets/delete` on their own
 * namespace could in principle wipe their Secrets right before a
 * scheduled backup, causing this probe to record `skipped` instead
 * of capturing a (now-empty) component. That requires equivalent of
 * write-admin on the namespace already — not a new escalation path.
 * The `skipped` row makes the omission visible in the operator UI
 * and the coverage drift report; it is not silent.
 */
async function tenantNamespaceHasSecrets(
  k8s: K8sClients,
  namespace: string,
): Promise<boolean> {
  try {
    const res = await k8s.core.listNamespacedSecret({ namespace });
    const items = res.items ?? [];
    return items.some((s) => {
      const t = s.type ?? '';
      // skip the kubernetes default service-account token; it is
      // recreated on restore by the platform-provisioner.
      return t !== 'kubernetes.io/service-account-token';
    });
  } catch {
    return true;
  }
}

/**
 * Persist the per-tenant restic state for the files component after a
 * successful capture. Resolves the BackupConfiguration → BackupTarget
 * → repo URI, looks up the region id (with operator override), then
 * upserts the row. Throws on internal errors so the caller can log
 * (orchestrator catches around the call so a state-write failure
 * never marks the bundle failed).
 */
async function recordResticSnapshotForFiles(args: {
  deps: OrchestratorDeps;
  input: RunBundleInput;
  bundleId: string;
  snapshotId: string;
  sizeBytes: number;
}): Promise<void> {
  const { deps, input, bundleId, snapshotId, sizeBytes } = args;
  const targetConfigId = input.targetConfigId ?? null;
  let target: BackupTarget | null = null;
  if (targetConfigId) {
    const [cfg] = await deps.db
      .select()
      .from(backupConfigurations)
      .where(eq(backupConfigurations.id, targetConfigId))
      .limit(1);
    if (cfg) {
      // Reviewer #3: drop the dead `hostpathPath` cast. The hostpath
      // production path was retired; backup_configurations has no such
      // column. resolveBackupTarget treats missing optional fields
      // safely (resolves only if storageType matches an active branch).
      target = resolveBackupTarget(cfg, { secretsKeyHex: deps.secretsKeyHex });
    }
  }
  // Build the canonical per-tenant repo URI. If the BackupConfiguration
  // was missing (e.g. ad-hoc bundle without a target), record the row
  // anyway with an empty repoUri — the admin UI will surface the gap.
  const repoUri = target
    ? buildResticRepoUri(target, input.clientId, 'files' satisfies ResticComponent)
    : '';

  // Region id derivation: read the override from settings, fall back
  // to the slugified PLATFORM_BASE_DOMAIN. Reviewer #1: do NOT pass
  // '' — `resolveBaseDomain` falls back to DEV_DEFAULT_BASE_DOMAIN
  // ('k8s-platform.test') only when the value is undefined; an empty
  // string short-circuits the ?? chain and yields '' which then
  // throws in deriveRegionId, silently breaking state-row writes on
  // every dev/CI cluster.
  const [settings] = await deps.db.select().from(tenantBackupV2Settings).limit(1);
  const apex = resolveBaseDomain({
    PLATFORM_BASE_DOMAIN: deps.platformBaseDomain,
    INGRESS_BASE_DOMAIN: undefined,
  });
  const regionId = deriveRegionId(apex, settings?.regionIdOverride ?? '');

  await recordResticSnapshot({
    db: deps.db,
    clientId: input.clientId,
    component: 'files',
    repoUri,
    targetConfigId,
    snapshotId,
    backupJobId: bundleId,
    sizeBytes,
    regionId,
    snapshotAt: new Date(),
  });
}
