import { z } from 'zod';

/**
 * Phase A.2 of the backup UI consolidation: aggregated overview
 * endpoints for the new System / Tenant Backups pages. These cut
 * each page from 4-6 round-trips down to 1.
 *
 *   GET /admin/backups/system/overview
 *   GET /admin/backups/tenants/overview?cursor=&limit=&filter=
 *   GET /admin/backups/tenants/:id/overview
 */

// ─── /admin/backups/system/overview ───────────────────────────────────

export const systemFilesystemSnapshotsSummarySchema = z.object({
  /** Total PVCs scanned (across system namespaces). */
  totalPvcs: z.number().int().nonnegative(),
  /** PVCs with at least one Longhorn snapshot. */
  pvcsWithSnapshots: z.number().int().nonnegative(),
  /** Aggregate snapshot count + bytes. */
  totalSnapshots: z.number().int().nonnegative(),
  totalBytes: z.number().nonnegative(),
  /** Most recent snapshot across all PVCs. */
  newestAt: z.string().datetime().nullable(),
});
export type SystemFilesystemSnapshotsSummary = z.infer<typeof systemFilesystemSnapshotsSummarySchema>;

export const systemObjectBackupsSummarySchema = z.object({
  /** Mail-restic last-run aggregate (from system_settings). */
  mail: z.object({
    enabled: z.boolean(),
    targetName: z.string().nullable(),
    snapshotCount: z.number().int().nonnegative(),
    totalSnapshotSizeBytes: z.number().nonnegative(),
    lastRunAt: z.string().datetime().nullable(),
    secondsSinceLastRun: z.number().int().nonnegative().nullable(),
    healthy: z.boolean(),
  }),
  /** Postgres PITR base backup + WAL archive state. */
  pitr: z.object({
    baseBackupAt: z.string().datetime().nullable(),
    secondsSinceBase: z.number().int().nonnegative().nullable(),
    walArchivingHealthy: z.boolean().nullable(),
  }),
  /** Secrets bundle latest backup. */
  secrets: z.object({
    lastBackupAt: z.string().datetime().nullable(),
    sizeBytes: z.number().nonnegative().nullable(),
  }),
});
export type SystemObjectBackupsSummary = z.infer<typeof systemObjectBackupsSummarySchema>;

export const systemBackupsOverviewSchema = z.object({
  filesystem: systemFilesystemSnapshotsSummarySchema,
  objectBackups: systemObjectBackupsSummarySchema,
  /** Per-schedule status to drive the schedule cards on the page. */
  schedules: z.array(z.object({
    subsystem: z.string(),
    enabled: z.boolean(),
    cronExpression: z.string().nullable(),
    gateSatisfied: z.boolean(),
  })),
  generatedAt: z.string().datetime(),
});
export type SystemBackupsOverview = z.infer<typeof systemBackupsOverviewSchema>;

// ─── /admin/backups/tenants/overview ──────────────────────────────────

export const tenantBackupOverviewRowSchema = z.object({
  tenantId: z.string().uuid(),
  tenantName: z.string(),
  /** TRUE for the singleton SYSTEM tenant per ADR-040. */
  isSystem: z.boolean(),
  planName: z.string().nullable(),
  /** Resolved include flag (override OR plan-default). */
  includedInScheduledBundles: z.boolean(),
  /** Three-state representation of the override column. */
  scheduledBundlesOverride: z.enum(['inherit', 'on', 'off']),
  /** Tenant-PVC snapshot stats (class=tenant_snapshot). */
  snapshotCount: z.number().int().nonnegative(),
  snapshotBytes: z.number().nonnegative(),
  lastSnapshotAt: z.string().datetime().nullable(),
  /** Bundle stats (class=tenant_bundle). */
  bundleCount: z.number().int().nonnegative(),
  bundleBytes: z.number().nonnegative(),
  lastBundleAt: z.string().datetime().nullable(),
  /** Quota usage. */
  snapshotQuotaPct: z.number().nonnegative().nullable(),
  /** Open restore-cart id (link target). */
  openCartId: z.string().uuid().nullable(),
});
export type TenantBackupOverviewRow = z.infer<typeof tenantBackupOverviewRowSchema>;

export const tenantsBackupsOverviewResponseSchema = z.object({
  rows: z.array(tenantBackupOverviewRowSchema),
  /** Aggregate KPIs across all tenants (not just this page). */
  kpi: z.object({
    totalTenants: z.number().int().nonnegative(),
    includedTenants: z.number().int().nonnegative(),
    overdueTenants: z.number().int().nonnegative(),
    totalSnapshotBytes: z.number().nonnegative(),
    totalBundleBytes: z.number().nonnegative(),
    openCarts: z.number().int().nonnegative(),
  }),
  generatedAt: z.string().datetime(),
});
export type TenantsBackupsOverviewResponse = z.infer<typeof tenantsBackupsOverviewResponseSchema>;

// ─── /admin/backups/tenants/:id/overview ──────────────────────────────

export const tenantBackupDetailSchema = z.object({
  tenantId: z.string().uuid(),
  tenantName: z.string(),
  isSystem: z.boolean(),
  planName: z.string().nullable(),
  includedInScheduledBundles: z.boolean(),
  scheduledBundlesOverride: z.enum(['inherit', 'on', 'off']),
  /** Snapshot quota usage. */
  quota: z.object({
    currentBytes: z.number().nonnegative(),
    maxBytes: z.number().nonnegative(),
    currentCount: z.number().int().nonnegative(),
    maxCount: z.number().int().nonnegative(),
    retentionDays: z.number().int().nonnegative(),
  }),
  /** Tenant-PVC snapshot list (recent first). */
  snapshots: z.array(z.object({
    id: z.string().uuid(),
    label: z.string().nullable(),
    sizeBytes: z.number().nonnegative(),
    status: z.string(),
    createdAt: z.string().datetime(),
    targetId: z.string().nullable(),
    targetName: z.string().nullable(),
  })),
  /** Bundle list (recent first). */
  bundles: z.array(z.object({
    id: z.string().uuid(),
    label: z.string().nullable(),
    sizeBytes: z.number().nonnegative(),
    status: z.string(),
    createdAt: z.string().datetime(),
    targetConfigId: z.string().nullable(),
  })),
  /** Open restore cart if any. */
  openCartId: z.string().uuid().nullable(),
  generatedAt: z.string().datetime(),
});
export type TenantBackupDetail = z.infer<typeof tenantBackupDetailSchema>;
