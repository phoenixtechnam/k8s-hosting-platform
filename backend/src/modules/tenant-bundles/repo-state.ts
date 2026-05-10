/**
 * tenant_restic_repo_state upsert helpers (Phase 1 piece #6, ADR-036).
 *
 * After a successful `restic backup` snapshot, the orchestrator
 * upserts a row that records:
 *   - which repo URI received the snapshot (so retention sweeper +
 *     cross-region browse can reach it without re-resolving the
 *     BackupConfiguration)
 *   - which snapshot id (full 64-char) is the most recent
 *   - which bundle produced it
 *   - bytes processed (for the per-tenant storage cost UI)
 *   - source region id (slugified PLATFORM_BASE_DOMAIN; informational
 *     on local repos, mandatory for restored-from-external rows)
 *   - bundle schema version that wrote it
 *
 * Single-row PK is (clientId, component) — every backup overwrites
 * the last_snapshot_* fields. The history of snapshots lives in
 * restic itself (`restic snapshots`); this row is a fast-lookup
 * cache for the admin UI and the retention sweeper.
 */

import { sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import {
  tenantResticRepoState,
  type NewTenantResticRepoState,
} from '../../db/schema.js';
import { BUNDLE_SCHEMA_VERSION } from './restic-driver.js';

export interface RecordResticSnapshotArgs {
  readonly db: Database;
  readonly clientId: string;
  readonly component: 'files' | 'mailboxes';
  readonly repoUri: string;
  readonly targetConfigId: string | null;
  readonly snapshotId: string;
  readonly backupJobId: string;
  readonly sizeBytes: number;
  readonly regionId: string;
  readonly snapshotAt: Date;
}

/**
 * Upsert the per-tenant restic state. Conflict on PK (clientId,
 * component) — last_* fields overwritten on every successful capture.
 */
export async function recordResticSnapshot(args: RecordResticSnapshotArgs): Promise<void> {
  const row: NewTenantResticRepoState = {
    clientId: args.clientId,
    component: args.component,
    repoUri: args.repoUri,
    targetConfigId: args.targetConfigId,
    lastSnapshotId: args.snapshotId,
    lastBackupJobId: args.backupJobId,
    lastRepoSizeBytes: args.sizeBytes,
    lastSnapshotAt: args.snapshotAt,
    lastRunAt: args.snapshotAt,
    bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    sourceRegionId: args.regionId,
  };
  await args.db
    .insert(tenantResticRepoState)
    .values(row)
    .onConflictDoUpdate({
      target: [tenantResticRepoState.clientId, tenantResticRepoState.component],
      set: {
        repoUri: sql`excluded.repo_uri`,
        targetConfigId: sql`excluded.target_config_id`,
        lastSnapshotId: sql`excluded.last_snapshot_id`,
        lastBackupJobId: sql`excluded.last_backup_job_id`,
        lastRepoSizeBytes: sql`excluded.last_repo_size_bytes`,
        lastSnapshotAt: sql`excluded.last_snapshot_at`,
        lastRunAt: sql`excluded.last_run_at`,
        bundleSchemaVersion: sql`excluded.bundle_schema_version`,
        sourceRegionId: sql`excluded.source_region_id`,
      },
    });
}

/**
 * Mark the run timestamp without recording a successful snapshot.
 * Used when the capture failed mid-stream — keeps last_run_at fresh
 * for "stale tenant" alerts without claiming a snapshot we don't
 * have.
 */
export async function recordResticRunFailed(args: {
  readonly db: Database;
  readonly clientId: string;
  readonly component: 'files' | 'mailboxes';
  readonly runAt: Date;
}): Promise<void> {
  // INSERT path uses a dummy repoUri because the row may not exist
  // yet (first-ever attempt that failed). On conflict we only bump
  // last_run_at; repoUri stays whatever the prior successful run
  // wrote.
  await args.db
    .insert(tenantResticRepoState)
    .values({
      clientId: args.clientId,
      component: args.component,
      repoUri: '',
      lastRunAt: args.runAt,
      bundleSchemaVersion: BUNDLE_SCHEMA_VERSION,
    } as NewTenantResticRepoState)
    .onConflictDoUpdate({
      target: [tenantResticRepoState.clientId, tenantResticRepoState.component],
      set: {
        lastRunAt: sql`excluded.last_run_at`,
      },
    });
}
