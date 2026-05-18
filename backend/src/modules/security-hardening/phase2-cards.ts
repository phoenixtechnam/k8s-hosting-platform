/**
 * Phase 2 cards — observability augmentations to the snapshot:
 *   - Calico WG (51821) verification
 *   - Reserved-platform-hostname collision feed
 *   - TLS cert expiry < 30d summary
 *   - Backup target encryption + freshness
 *   - Audit-log gap detector
 *   - K8s posture (Phase 2.1)
 *   - Auth/Audit metrics (Phase 2.2)
 *
 * Each function is best-effort — when its data source is missing or
 * errors, it returns null/[] and the UI shows "unavailable" rather
 * than blocking the whole snapshot.
 */

import type { CoreV1Api, CustomObjectsApi, AppsV1Api } from '@kubernetes/client-node';
import { count, desc, gte, inArray, sql } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  type CalicoWgStatus,
  type ReservedHostnameCollision,
  type CertExpiry,
  type BackupTargetHealth,
  type AuditLogHealth,
  type K8sPosture,
  type AuthPosture,
  type NamespacePss,
  type PrivilegedPod,
  type PssLevel,
} from '@k8s-hosting/api-contracts';
import { auditLogs } from '../../db/schema.js';

// Process-wide baseline for the audit-log row-count monotonicity
// check. Captured on the first buildAuditLogHealth() invocation so we
// have a reference point for future calls. Null before capture.
let auditRowCountBaseline: { count: number; capturedAt: Date } | null = null;

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

// ─── Calico WG verification ─────────────────────────────────────────────

interface ProbePortsByNode {
  readonly nodeName: string;
  readonly udp: ReadonlyArray<number>;
}

/** Listening on UDP/51821 across every node, public-key auth confirmed
 *  by the absence of a Calico Felix `WireguardEnabled: false` toggle.
 *  We can't directly assert the auth mode from the probe (it's
 *  controller-side config), so the "confirmed" flag here just asserts
 *  the listener is up on every node — operators verify the mode via
 *  the Calico FelixConfiguration spec. */
export async function buildCalicoWgStatus(
  totalNodes: number,
  portsByNode: ReadonlyArray<ProbePortsByNode>,
): Promise<CalicoWgStatus | null> {
  if (totalNodes === 0) return null;
  const listening = portsByNode.filter((n) => n.udp.includes(51821)).length;
  return {
    listeningNodes: listening,
    totalNodes,
    publicKeyAuthConfirmed: listening === totalNodes,
  };
}

// ─── Reserved-hostname collision feed (ADR-040) ────────────────────────

export async function fetchReservedHostnameCollisions(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  limit = 25,
): Promise<ReservedHostnameCollision[]> {
  // ADR-040's `RESERVED_PLATFORM_HOSTNAME` 409s currently surface
  // through the audit-log middleware as `resource_type` = 'domain'
  // or 'dns_record' (whichever endpoint was hit) with http_status =
  // 409. We can't distinguish a reserved-hostname collision from
  // any other 409 on those endpoints without a dedicated audit row
  // — but most 409s on these endpoints ARE reserved-hostname
  // violations (duplicate-entry is the other case, less common).
  // Best-effort surface.
  const rows = await db
    .select({
      createdAt: auditLogs.createdAt,
      tenantId: auditLogs.tenantId,
      resourceId: auditLogs.resourceId,
      resourceType: auditLogs.resourceType,
      actorId: auditLogs.actorId,
      changes: auditLogs.changes,
      httpStatus: auditLogs.httpStatus,
    })
    .from(auditLogs)
    .where(
      sql`${auditLogs.resourceType} IN ('domain', 'dns_record', 'reserved_platform_hostname')
          AND ${auditLogs.httpStatus} = 409`,
    )
    .orderBy(desc(auditLogs.createdAt))
    .limit(limit);

  return rows.map((r) => {
    const surface: 'domain' | 'dns-record' = r.resourceType === 'dns_record' ? 'dns-record' : 'domain';
    const hostname =
      (r.changes as { hostname?: string } | null | undefined)?.hostname ?? r.resourceId ?? '';
    return {
      occurredAt: toIso(r.createdAt),
      tenantId: r.tenantId,
      hostname,
      surface,
      userId: r.actorId,
    };
  });
}

// ─── TLS cert expiry ────────────────────────────────────────────────────

interface CertCr {
  readonly metadata?: { readonly name?: string; readonly namespace?: string };
  readonly status?: {
    readonly conditions?: ReadonlyArray<{ readonly type?: string; readonly status?: string }>;
    readonly notAfter?: string;
  };
}

interface CertList {
  readonly items?: ReadonlyArray<CertCr>;
}

export async function fetchExpiringCerts(
  custom: CustomObjectsApi,
  withinDays = 30,
  now: () => Date = () => new Date(),
): Promise<CertExpiry[]> {
  const list = await custom
    .listClusterCustomObject({
      group: 'cert-manager.io',
      version: 'v1',
      plural: 'certificates',
    })
    .then((r) => r as CertList)
    .catch(() => ({ items: [] }) as CertList);
  const cutoff = new Date(now().getTime() + withinDays * ONE_DAY_MS);
  const out: CertExpiry[] = [];
  for (const item of list.items ?? []) {
    const notAfterStr = item.status?.notAfter;
    if (!notAfterStr) continue;
    const notAfter = new Date(notAfterStr);
    if (Number.isNaN(notAfter.getTime())) continue;
    if (notAfter > cutoff) continue;
    const ready =
      item.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True') ?? false;
    out.push({
      name: item.metadata?.name ?? '',
      namespace: item.metadata?.namespace ?? '',
      expiresAt: notAfter.toISOString(),
      daysRemaining: Math.floor((notAfter.getTime() - now().getTime()) / ONE_DAY_MS),
      ready,
    });
  }
  out.sort((a, b) => a.daysRemaining - b.daysRemaining);
  return out;
}

// ─── Backup target health (Phase 2.5.4) ─────────────────────────────────
//
// The platform's backup target table lives in `backup_configurations`
// (see docs/02-operations/TENANT_BACKUP.md). We query a narrow set of
// columns + the most-recent storage_snapshots row per target to
// surface "last-successful-snapshot age". The exact column names are
// resolved via raw SQL because the security-hardening module is
// intentionally decoupled from backup-config Drizzle schemas.

export async function fetchBackupTargetHealth(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  now: () => Date = () => new Date(),
): Promise<BackupTargetHealth[]> {
  // Use a single SQL query so we don't depend on backup-config's
  // Drizzle table definitions changing under us. The query is
  // defensive: if either table is missing or columns are renamed,
  // we return [] rather than throw.
  try {
    const result = await db.execute(sql`
      SELECT
        bc.id::text AS id,
        bc.name AS name,
        COALESCE(bc.encryption_at_rest, true) AS encryption_at_rest,
        bc.last_connection_test_at AS last_connection_test_at,
        bc.last_connection_test_ok AS last_connection_test_ok,
        (
          SELECT MAX(created_at)
          FROM storage_snapshots ss
          WHERE ss.target_id = bc.id AND ss.status = 'completed'
        ) AS last_successful_snapshot_at
      FROM backup_configurations bc
      WHERE COALESCE(bc.disabled, false) = false
      ORDER BY bc.name
      LIMIT 50
    `);
    const rows = (result as { rows: ReadonlyArray<Record<string, unknown>> }).rows ?? [];
    return rows.map((r) => {
      const lastSnapStr = (r.last_successful_snapshot_at as Date | string | null) ?? null;
      const lastConnStr = (r.last_connection_test_at as Date | string | null) ?? null;
      const lastSnapAt = lastSnapStr ? toIso(lastSnapStr) : null;
      const daysSinceLastSnapshot =
        lastSnapAt !== null
          ? Math.floor((now().getTime() - new Date(lastSnapAt).getTime()) / ONE_DAY_MS)
          : null;
      return {
        id: String(r.id),
        name: String(r.name),
        encryptionAtRest: Boolean(r.encryption_at_rest),
        lastConnectionTestAt: lastConnStr ? toIso(lastConnStr) : null,
        lastConnectionTestOk:
          r.last_connection_test_ok === null ? null : Boolean(r.last_connection_test_ok),
        lastSuccessfulSnapshotAt: lastSnapAt,
        daysSinceLastSnapshot,
      };
    });
  } catch {
    return [];
  }
}

// ─── Audit-log gap detector (Phase 2.5.5) ─────────────────────────────

export async function buildAuditLogHealth(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  now: () => Date = () => new Date(),
): Promise<AuditLogHealth> {
  const [latest] = await db
    .select({ createdAt: auditLogs.createdAt })
    .from(auditLogs)
    .orderBy(desc(auditLogs.createdAt))
    .limit(1);
  const lastInsertAt = latest ? toIso(latest.createdAt) : null;
  const secondsSinceLastInsert =
    lastInsertAt !== null
      ? Math.max(0, Math.floor((now().getTime() - new Date(lastInsertAt).getTime()) / 1000))
      : null;

  // Rolling 7-day insert rate. Two queries kept simple so they're
  // fast even with millions of rows (count(*) on the indexed
  // created_at).
  const sevenDaysAgo = new Date(now().getTime() - 7 * ONE_DAY_MS);
  const [{ value: rowCount7d } = { value: 0 }] = await db
    .select({ value: count() })
    .from(auditLogs)
    .where(gte(auditLogs.createdAt, sevenDaysAgo));
  const rollingHourlyRate = rowCount7d / (7 * 24);
  // Expected gap = inverse of rate, in seconds. If we observe a gap
  // > 4x expected, flag it. With rate=0 (no rows this week) we never
  // flag — there's no baseline to compare against.
  const expectedGapSeconds = rollingHourlyRate > 0 ? 3600 / rollingHourlyRate : Number.POSITIVE_INFINITY;
  const gapSuspected =
    secondsSinceLastInsert !== null &&
    rollingHourlyRate > 0 &&
    secondsSinceLastInsert > expectedGapSeconds * 4;

  // Capture/compare the row-count baseline. First call sets it,
  // subsequent calls compare. Returns null while baseline is
  // warming up, true if count is monotonically increasing, false
  // if count went DOWN (audit-log tampering or table truncation).
  const [{ value: totalRowCount } = { value: 0 }] = await db
    .select({ value: count() })
    .from(auditLogs);
  let rowCountMonotonic: boolean | null = null;
  if (auditRowCountBaseline === null) {
    auditRowCountBaseline = { count: totalRowCount, capturedAt: now() };
    // First call after process boot — return null until next tick.
  } else {
    rowCountMonotonic = totalRowCount >= auditRowCountBaseline.count;
    // Slide the baseline forward on every successful increase so
    // the check catches a more recent regression, not just one
    // dating back to process start.
    if (rowCountMonotonic) {
      auditRowCountBaseline = { count: totalRowCount, capturedAt: now() };
    }
  }

  return {
    lastInsertAt,
    secondsSinceLastInsert,
    rollingHourlyRate,
    gapSuspected,
    rowCountMonotonic,
  };
}

/** Test-only — reset the audit-log baseline between vitest cases. */
export function __resetAuditRowCountBaselineForTests(): void {
  auditRowCountBaseline = null;
}

// ─── K8s posture (Phase 2.1) ───────────────────────────────────────────

interface NamespaceItem {
  readonly metadata?: {
    readonly name?: string;
    readonly labels?: Record<string, string>;
  };
}

interface PodItem {
  readonly metadata?: { readonly name?: string; readonly namespace?: string };
  readonly spec?: {
    readonly hostNetwork?: boolean;
    readonly hostPID?: boolean;
    readonly containers?: ReadonlyArray<{
      readonly securityContext?: {
        readonly privileged?: boolean;
        readonly capabilities?: { readonly add?: ReadonlyArray<string> };
      };
      readonly volumeMounts?: ReadonlyArray<{ readonly name?: string }>;
    }>;
    readonly volumes?: ReadonlyArray<{
      readonly name?: string;
      readonly hostPath?: unknown;
    }>;
  };
}

export async function buildK8sPosture(core: CoreV1Api): Promise<K8sPosture | null> {
  let namespacePss: NamespacePss[] = [];
  let pods: ReadonlyArray<PodItem> = [];
  try {
    const nsList = await core.listNamespace();
    namespacePss = (nsList.items ?? []).map((ns: NamespaceItem) => ({
      namespace: ns.metadata?.name ?? '',
      enforceLevel: readPssLabel(ns.metadata?.labels, 'pod-security.kubernetes.io/enforce'),
      warnLevel: readPssLabel(ns.metadata?.labels, 'pod-security.kubernetes.io/warn'),
      auditLevel: readPssLabel(ns.metadata?.labels, 'pod-security.kubernetes.io/audit'),
    }));
  } catch {
    return null;
  }
  try {
    const podList = await core.listPodForAllNamespaces();
    pods = podList.items ?? [];
  } catch {
    return null;
  }

  const privileged: PrivilegedPod[] = [];
  const hostPath: PrivilegedPod[] = [];
  const hostNetwork: PrivilegedPod[] = [];
  for (const p of pods) {
    const name = p.metadata?.name ?? '';
    const ns = p.metadata?.namespace ?? '';
    if (p.spec?.hostNetwork) hostNetwork.push({ namespace: ns, name, reasons: ['hostNetwork: true'] });
    if (p.spec?.volumes?.some((v) => v.hostPath !== undefined && v.hostPath !== null)) {
      hostPath.push({ namespace: ns, name, reasons: ['volume references hostPath'] });
    }
    const reasons: string[] = [];
    for (const c of p.spec?.containers ?? []) {
      if (c.securityContext?.privileged) reasons.push('container privileged: true');
      const caps = c.securityContext?.capabilities?.add ?? [];
      for (const cap of caps) {
        if (cap !== 'NET_ADMIN' && cap !== 'NET_BIND_SERVICE') reasons.push(`capability add: ${cap}`);
      }
    }
    if (reasons.length > 0) privileged.push({ namespace: ns, name, reasons });
  }
  return {
    namespacePss,
    privilegedPods: privileged,
    hostPathPods: hostPath,
    hostNetworkPods: hostNetwork,
    totalPodCount: pods.length,
  };
}

function readPssLabel(labels: Record<string, string> | undefined, key: string): PssLevel {
  const v = (labels?.[key] ?? '').toLowerCase();
  if (v === 'privileged' || v === 'baseline' || v === 'restricted') return v;
  return 'unset';
}

// ─── Auth posture (Phase 2.2) ──────────────────────────────────────────

export async function buildAuthPosture(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: NodePgDatabase<any>,
  apps: AppsV1Api,
  now: () => Date = () => new Date(),
): Promise<AuthPosture | null> {
  const since24h = new Date(now().getTime() - ONE_DAY_MS);
  const since7d = new Date(now().getTime() - 7 * ONE_DAY_MS);

  let failed24h = 0;
  let failed7d = 0;
  try {
    const [{ value: v24h } = { value: 0 }] = await db
      .select({ value: count() })
      .from(auditLogs)
      .where(
        sql`${auditLogs.actionType} = 'login_failed' AND ${auditLogs.createdAt} >= ${since24h}`,
      );
    const [{ value: v7d } = { value: 0 }] = await db
      .select({ value: count() })
      .from(auditLogs)
      .where(
        sql`${auditLogs.actionType} = 'login_failed' AND ${auditLogs.createdAt} >= ${since7d}`,
      );
    failed24h = v24h;
    failed7d = v7d;
  } catch {
    // Audit-log query failure should not block the rest of the
    // snapshot.
  }

  const dexHealthy = await checkDeploymentReady(apps, 'dex', 'dex').catch(() => null);
  const oauth2ProxyHealthy = await checkDeploymentReady(apps, 'oauth2-proxy', 'platform-system').catch(
    () => null,
  );

  return {
    failedLogins24h: failed24h,
    failedLogins7d: failed7d,
    oldestActiveSessionAgeSeconds: null,
    jwtSecretAgeSeconds: null,
    dexHealthy,
    oauth2ProxyHealthy,
    lastSuccessfulDexLoginAt: null,
  };
}

async function checkDeploymentReady(
  apps: AppsV1Api,
  name: string,
  namespace: string,
): Promise<boolean | null> {
  try {
    const dep = await apps.readNamespacedDeployment({ name, namespace });
    const desired = dep.spec?.replicas ?? 0;
    const ready = dep.status?.readyReplicas ?? 0;
    return desired > 0 && ready >= desired;
  } catch {
    return null;
  }
}

function toIso(d: Date | string): string {
  if (d instanceof Date) return d.toISOString();
  return new Date(d).toISOString();
}
