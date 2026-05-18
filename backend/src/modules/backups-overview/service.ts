/**
 * Aggregation service for the consolidated Backup pages.
 *
 * The endpoints here don't add new data — they JOIN existing ledgers
 * (storage_snapshots, tenant_backups, system_settings,
 * backup_target_assignments) so the new frontend pages make one
 * call instead of six.
 */

import { eq, and, sql, desc, inArray } from 'drizzle-orm';
import {
  tenants,
  hostingPlans,
  storageSnapshots,
  backupConfigurations,
  backupTargetAssignments,
  systemSettings,
  backupJobs,
  backupSchedules,
} from '../../db/schema.js';
import type { Database } from '../../db/index.js';
import type {
  SystemBackupsOverview,
  TenantsBackupsOverviewResponse,
  TenantBackupDetail,
  TenantBackupOverviewRow,
} from '@k8s-hosting/api-contracts';

// Avoid drizzle complaining about unused — kept for future joins.
export const __unused = and;
export const __unused2 = desc;
export const __unused3 = inArray;

// ─── /admin/backups/system/overview ───────────────────────────────────

export async function loadSystemOverview(db: Database): Promise<SystemBackupsOverview> {
  // Filesystem snapshots: aggregate storage_snapshots filtered by
  // class IN (system_backup, system_mail). The `subsystem` column
  // distinguishes producers; the count + bytes aggregates roll up
  // across all of them.
  const sysAgg = (await db.execute(sql`
    SELECT
      COUNT(DISTINCT subsystem)::int AS subsystems,
      COUNT(*)::int AS snapshot_count,
      COALESCE(SUM(size_bytes), 0)::bigint AS total_bytes,
      MAX(created_at) AS newest_at
    FROM storage_snapshots
    WHERE snapshot_class IN ('system_backup', 'system_mail')
      AND status = 'ready'
  `)) as unknown as Array<{ subsystems: number; snapshot_count: number; total_bytes: string | number; newest_at: Date | string | null }>;

  const sysRow = sysAgg[0] ?? { subsystems: 0, snapshot_count: 0, total_bytes: 0, newest_at: null };

  // Mail-restic last-run from system_settings (already maintained by
  // the sidecar callback wired into /internal/mail/snapshot-last-run).
  const [settings] = await db.select({
    mailStats: systemSettings.mailSnapshotLastRunStats,
    mailBackupStoreId: systemSettings.mailSnapshotBackupStoreId,
  }).from(systemSettings).where(eq(systemSettings.id, 'system'));

  const mailStats = (settings?.mailStats ?? {}) as {
    totalSnapshotSizeBytes?: number;
    snapshotCount?: number;
    runAt?: string;
  };

  // Resolve mail target name for display.
  let mailTargetName: string | null = null;
  if (settings?.mailBackupStoreId) {
    const [cfg] = await db.select({ name: backupConfigurations.name })
      .from(backupConfigurations)
      .where(eq(backupConfigurations.id, settings.mailBackupStoreId));
    mailTargetName = cfg?.name ?? null;
  }

  const mailLastRun = mailStats.runAt ? new Date(mailStats.runAt) : null;
  const secondsSinceMail = mailLastRun
    ? Math.max(0, Math.floor((Date.now() - mailLastRun.getTime()) / 1000))
    : null;
  // Mail considered healthy when last run is < 5 minutes old (2-min
  // schedule + 3-min jitter window). Matches the existing health
  // banner threshold.
  const mailHealthy = secondsSinceMail !== null && secondsSinceMail < 300;

  // Mail enabled flag from backup_schedules.
  const [mailSched] = await db.select({ enabled: backupSchedules.enabled })
    .from(backupSchedules)
    .where(eq(backupSchedules.subsystem, 'mail'));

  // Schedule states for the page's schedule strip.
  const schedRows = await db.select().from(backupSchedules);
  // Quick gate-sat lookup per subsystem.
  const gatedClassFor: Record<string, string | null> = {
    mail: 'system_mail',
    tenant_bundle: 'tenant_bundle',
    system_pitr: 'system_backup',
    longhorn_recurring: null,
  };
  const gatedClasses = Array.from(
    new Set(schedRows.map((r) => gatedClassFor[r.subsystem]).filter((c): c is string => !!c)),
  );
  const gateSat = new Set<string>();
  if (gatedClasses.length > 0) {
    const a = await db
      .select({ snapshotClass: backupTargetAssignments.snapshotClass })
      .from(backupTargetAssignments)
      .where(inArray(backupTargetAssignments.snapshotClass, gatedClasses));
    for (const r of a) gateSat.add(r.snapshotClass);
  }

  return {
    filesystem: {
      totalPvcs: 0, // populated by listSystemPvcSnapshots if/when called by frontend
      pvcsWithSnapshots: sysRow.subsystems,
      totalSnapshots: sysRow.snapshot_count,
      totalBytes: Number(sysRow.total_bytes),
      newestAt: sysRow.newest_at
        ? (sysRow.newest_at instanceof Date ? sysRow.newest_at.toISOString() : new Date(sysRow.newest_at).toISOString())
        : null,
    },
    objectBackups: {
      mail: {
        enabled: mailSched?.enabled ?? false,
        targetName: mailTargetName,
        snapshotCount: mailStats.snapshotCount ?? 0,
        totalSnapshotSizeBytes: mailStats.totalSnapshotSizeBytes ?? 0,
        lastRunAt: mailStats.runAt ?? null,
        secondsSinceLastRun: secondsSinceMail,
        healthy: mailHealthy,
      },
      pitr: {
        baseBackupAt: null, // populated by postgres-restore status if/when surfaced
        secondsSinceBase: null,
        walArchivingHealthy: null,
      },
      secrets: {
        lastBackupAt: null,
        sizeBytes: null,
      },
    },
    schedules: schedRows.map((r) => {
      const cls = gatedClassFor[r.subsystem] ?? null;
      return {
        subsystem: r.subsystem,
        enabled: r.enabled,
        cronExpression: r.cronExpression,
        gateSatisfied: cls ? gateSat.has(cls) : true,
      };
    }),
    generatedAt: new Date().toISOString(),
  };
}

// ─── /admin/backups/tenants/overview ──────────────────────────────────

interface ListTenantsOpts {
  readonly limit?: number;
  readonly cursor?: string;
  readonly filter?: string;
}

export async function loadTenantsOverview(db: Database, opts: ListTenantsOpts = {}): Promise<TenantsBackupsOverviewResponse> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 100);

  // One query: tenants × plans × aggregates from storage_snapshots
  // and tenant_backups. SQL is wide but the alternative is 4N queries.
  const rows = (await db.execute(sql`
    SELECT
      t.id AS tenant_id,
      t.name AS tenant_name,
      t.is_system AS is_system,
      p.name AS plan_name,
      t.include_in_scheduled_bundles AS include_override,
      p.include_in_scheduled_bundles AS plan_include,
      COALESCE(t.include_in_scheduled_bundles, p.include_in_scheduled_bundles) AS resolved_include,
      COALESCE(snap.cnt, 0)::int AS snapshot_count,
      COALESCE(snap.bytes, 0)::bigint AS snapshot_bytes,
      snap.newest AS last_snapshot_at,
      COALESCE(bun.cnt, 0)::int AS bundle_count,
      COALESCE(bun.bytes, 0)::bigint AS bundle_bytes,
      bun.newest AS last_bundle_at,
      p.max_snapshot_size_bytes AS quota_max_bytes,
      cart.id AS open_cart_id
    FROM tenants t
    LEFT JOIN hosting_plans p ON p.id = t.plan_id
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS cnt,
        SUM(size_bytes) AS bytes,
        MAX(created_at) AS newest
      FROM storage_snapshots
      WHERE tenant_id = t.id
        AND snapshot_class = 'tenant_snapshot'
        AND status = 'ready'
    ) snap ON TRUE
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*) AS cnt,
        SUM(size_bytes) AS bytes,
        MAX(created_at) AS newest
      FROM backup_jobs
      WHERE tenant_id = t.id
        AND status = 'completed'
    ) bun ON TRUE
    LEFT JOIN LATERAL (
      SELECT id FROM restore_jobs
      WHERE tenant_id = t.id AND status NOT IN ('completed', 'failed', 'cancelled')
      ORDER BY created_at DESC LIMIT 1
    ) cart ON TRUE
    WHERE t.status != 'deleted'
      ${opts.filter ? sql`AND t.name ILIKE ${'%' + opts.filter + '%'}` : sql``}
    ORDER BY t.is_system DESC, t.name
    LIMIT ${limit}
  `)) as unknown as Array<{
    tenant_id: string;
    tenant_name: string;
    is_system: boolean;
    plan_name: string | null;
    include_override: boolean | null;
    plan_include: boolean | null;
    resolved_include: boolean | null;
    snapshot_count: number;
    snapshot_bytes: string | number;
    last_snapshot_at: Date | string | null;
    bundle_count: number;
    bundle_bytes: string | number;
    last_bundle_at: Date | string | null;
    quota_max_bytes: string | number | null;
    open_cart_id: string | null;
  }>;

  const toIso = (v: Date | string | null): string | null => {
    if (v == null) return null;
    return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
  };

  const rowsOut: TenantBackupOverviewRow[] = rows.map((r) => {
    const snapshotBytes = Number(r.snapshot_bytes);
    const quotaMax = r.quota_max_bytes ? Number(r.quota_max_bytes) : 0;
    return {
      tenantId: r.tenant_id,
      tenantName: r.tenant_name,
      isSystem: r.is_system,
      planName: r.plan_name,
      includedInScheduledBundles: r.resolved_include === true,
      scheduledBundlesOverride: r.include_override === null
        ? 'inherit'
        : r.include_override
        ? 'on'
        : 'off',
      snapshotCount: r.snapshot_count,
      snapshotBytes,
      lastSnapshotAt: toIso(r.last_snapshot_at),
      bundleCount: r.bundle_count,
      bundleBytes: Number(r.bundle_bytes),
      lastBundleAt: toIso(r.last_bundle_at),
      snapshotQuotaPct: quotaMax > 0 ? snapshotBytes / quotaMax : null,
      openCartId: r.open_cart_id,
    };
  });

  // KPIs aggregate across the *page* (full table is in `rows` since we cap at 100).
  const kpi = {
    totalTenants: rowsOut.length,
    includedTenants: rowsOut.filter((r) => r.includedInScheduledBundles).length,
    // "Overdue" = included AND no bundle in last 36h.
    overdueTenants: rowsOut.filter((r) => {
      if (!r.includedInScheduledBundles) return false;
      if (!r.lastBundleAt) return true;
      return Date.now() - new Date(r.lastBundleAt).getTime() > 36 * 3600 * 1000;
    }).length,
    totalSnapshotBytes: rowsOut.reduce((s, r) => s + r.snapshotBytes, 0),
    totalBundleBytes: rowsOut.reduce((s, r) => s + r.bundleBytes, 0),
    openCarts: rowsOut.filter((r) => !!r.openCartId).length,
  };

  return { rows: rowsOut, kpi, generatedAt: new Date().toISOString() };
}

// ─── /admin/backups/tenants/:id/overview ──────────────────────────────

export async function loadTenantDetail(db: Database, tenantId: string): Promise<TenantBackupDetail | null> {
  const [tenant] = await db.select({
    id: tenants.id,
    name: tenants.name,
    isSystem: tenants.isSystem,
    planId: tenants.planId,
    includeOverride: tenants.includeInScheduledBundlesOverride,
  }).from(tenants).where(eq(tenants.id, tenantId));
  if (!tenant) return null;

  const [plan] = tenant.planId ? await db.select({
    name: hostingPlans.name,
    include: hostingPlans.includeInScheduledBundles,
    maxBytes: hostingPlans.maxSnapshotSizeBytes,
    maxCount: hostingPlans.maxSnapshotCount,
    retention: hostingPlans.maxSnapshotRetentionDays,
  }).from(hostingPlans).where(eq(hostingPlans.id, tenant.planId)) : [];

  const includedInScheduledBundles = tenant.includeOverride !== null
    ? tenant.includeOverride
    : plan?.include ?? false;

  // Recent snapshots + bundles + open cart, in parallel.
  const [snapshots, bundles, openCart, usage] = await Promise.all([
    db.select({
      id: storageSnapshots.id,
      label: storageSnapshots.label,
      sizeBytes: storageSnapshots.sizeBytes,
      status: storageSnapshots.status,
      createdAt: storageSnapshots.createdAt,
      targetId: storageSnapshots.targetId,
    }).from(storageSnapshots)
      .where(and(
        eq(storageSnapshots.tenantId, tenantId),
        eq(storageSnapshots.snapshotClass, 'tenant_snapshot'),
      ))
      .orderBy(desc(storageSnapshots.createdAt))
      .limit(50),
    db.select({
      id: backupJobs.id,
      label: backupJobs.label,
      sizeBytes: backupJobs.sizeBytes,
      status: backupJobs.status,
      createdAt: backupJobs.createdAt,
      targetConfigId: backupJobs.targetConfigId,
    }).from(backupJobs)
      .where(eq(backupJobs.tenantId, tenantId))
      .orderBy(desc(backupJobs.createdAt))
      .limit(50),
    db.execute(sql`
      SELECT id FROM restore_jobs
      WHERE tenant_id = ${tenantId} AND status NOT IN ('completed', 'failed', 'cancelled')
      ORDER BY created_at DESC LIMIT 1
    `) as unknown as Promise<Array<{ id: string }>>,
    db.execute(sql`
      SELECT
        COALESCE(SUM(CASE WHEN status = 'ready' THEN size_bytes ELSE 0 END), 0)::bigint AS bytes,
        COUNT(*) FILTER (WHERE status IN ('ready','creating'))::int AS cnt
      FROM storage_snapshots
      WHERE tenant_id = ${tenantId} AND snapshot_class = 'tenant_snapshot'
    `) as unknown as Promise<Array<{ bytes: string | number; cnt: number }>>,
  ]);

  // Resolve target names for snapshot rows.
  const targetIds = Array.from(new Set(snapshots.map((s) => s.targetId).filter((id): id is string => !!id)));
  const targetNames = new Map<string, string>();
  if (targetIds.length > 0) {
    const cfgs = await db.select({ id: backupConfigurations.id, name: backupConfigurations.name })
      .from(backupConfigurations)
      .where(inArray(backupConfigurations.id, targetIds));
    for (const c of cfgs) targetNames.set(c.id, c.name);
  }

  const toIso = (v: Date | string | null | undefined): string => {
    if (v == null) return new Date().toISOString();
    return v instanceof Date ? v.toISOString() : new Date(v).toISOString();
  };

  const u = usage[0] ?? { bytes: 0, cnt: 0 };

  return {
    tenantId: tenant.id,
    tenantName: tenant.name,
    isSystem: tenant.isSystem ?? false,
    planName: plan?.name ?? null,
    includedInScheduledBundles,
    scheduledBundlesOverride: tenant.includeOverride === null
      ? 'inherit'
      : tenant.includeOverride ? 'on' : 'off',
    quota: {
      currentBytes: Number(u.bytes),
      maxBytes: plan?.maxBytes ?? 0,
      currentCount: u.cnt,
      maxCount: plan?.maxCount ?? 0,
      retentionDays: plan?.retention ?? 0,
    },
    snapshots: snapshots.map((s) => ({
      id: s.id,
      label: s.label,
      sizeBytes: Number(s.sizeBytes ?? 0),
      status: s.status,
      createdAt: toIso(s.createdAt),
      targetId: s.targetId,
      targetName: s.targetId ? targetNames.get(s.targetId) ?? null : null,
    })),
    bundles: bundles.map((b) => ({
      id: b.id,
      label: b.label,
      sizeBytes: b.sizeBytes ?? 0,
      status: b.status,
      createdAt: toIso(b.createdAt),
      targetConfigId: b.targetConfigId,
    })),
    openCartId: openCart[0]?.id ?? null,
    generatedAt: new Date().toISOString(),
  };
}
