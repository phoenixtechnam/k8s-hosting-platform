import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { tenants, hostingPlans, notifications, users } from '../../db/schema.js';
import {
  applyNamespace,
  applyResourceQuota,
  applyNetworkPolicy,
  applyPVC,
} from '../k8s-provisioner/service.js';

// Issue 1 fix: a namespace can lose its tenant PVC / ResourceQuota /
// NetworkPolicies after a cluster rebootstrap (sqlite→etcd, DR
// restore, etc.) while tenants.provisioning_status stays
// "provisioned". The lifecycle module recreates the namespace +
// file-manager but not these other resources, leaving deployments
// stuck in pending forever.
//
// This module audits a single tenant (or the full fleet) for missing
// resources and repairs the gap.

export type IntegrityFinding =
  | 'namespace_missing'
  | 'pvc_missing'
  | 'resource_quota_missing'
  | 'network_policy_missing';

export interface NamespaceIntegrityReport {
  readonly tenantId: string;
  readonly name: string;
  readonly namespace: string;
  readonly findings: readonly IntegrityFinding[];
  readonly repaired: readonly IntegrityFinding[];
  readonly errors: readonly string[];
}

const REQUIRED_NETPOLS = ['default-deny-ingress', 'allow-intra-namespace'] as const;

async function exists(call: () => Promise<unknown>): Promise<boolean> {
  try {
    await call();
    return true;
  } catch (err) {
    const status = (err as { code?: number }).code ?? (err as { statusCode?: number }).statusCode;
    if (status === 404) return false;
    throw err;
  }
}

async function inspect(
  k8s: K8sClients,
  namespace: string,
): Promise<IntegrityFinding[]> {
  const findings: IntegrityFinding[] = [];

  if (!(await exists(() => k8s.core.readNamespace({ name: namespace })))) {
    findings.push('namespace_missing');
    // No point checking children if the parent is gone.
    return findings;
  }

  if (!(await exists(() =>
    k8s.core.readNamespacedPersistentVolumeClaim({
      name: `${namespace}-storage`,
      namespace,
    })))) {
    findings.push('pvc_missing');
  }

  if (!(await exists(() =>
    k8s.core.readNamespacedResourceQuota({
      name: `${namespace}-quota`,
      namespace,
    })))) {
    findings.push('resource_quota_missing');
  }

  for (const np of REQUIRED_NETPOLS) {
    if (!(await exists(() =>
      k8s.networking.readNamespacedNetworkPolicy({ name: np, namespace })))) {
      findings.push('network_policy_missing');
      break; // single signal — the repair recreates both anyway
    }
  }

  return findings;
}

/**
 * Audit + optionally repair a single tenant's namespace. `repair=false`
 * is the read-only audit used by the UI. `repair=true` is the
 * "Run reconciler" admin action and the cron-driven sweep.
 */
export async function checkTenantNamespaceIntegrity(
  db: Database,
  k8s: K8sClients,
  tenantId: string,
  repair: boolean,
): Promise<NamespaceIntegrityReport> {
  const [tenant] = await db.select().from(tenants).where(eq(tenants.id, tenantId)).limit(1);
  if (!tenant) {
    throw new Error(`Client ${tenantId} not found`);
  }
  if (tenant.provisioningStatus !== 'provisioned') {
    return {
      tenantId,
      name: tenant.name,
      namespace: tenant.kubernetesNamespace,
      findings: [],
      repaired: [],
      errors: [],
    };
  }

  const findings = await inspect(k8s, tenant.kubernetesNamespace);
  if (findings.length === 0 || !repair) {
    return {
      tenantId,
      name: tenant.name,
      namespace: tenant.kubernetesNamespace,
      findings,
      repaired: [],
      errors: [],
    };
  }

  const [plan] = await db.select().from(hostingPlans).where(eq(hostingPlans.id, tenant.planId)).limit(1);
  // Unified tenant SC; tier is encoded as Volume.spec.numberOfReplicas
  // and patched live by applyTenantTier rather than baked into the SC.
  const storageClass = 'longhorn-tenant';

  const repaired: IntegrityFinding[] = [];
  const errors: string[] = [];
  const ns = tenant.kubernetesNamespace;

  // Repair each missing resource. Order matters: namespace first, then
  // PVC + RQ + NetPol (can be parallel but the failure mode is clearer
  // serial).
  if (findings.includes('namespace_missing')) {
    try {
      // Mirror the provisionTenant PSA-label logic: read the cluster's
      // `allow_host_ports_*` toggles so the recreated namespace matches
      // what a fresh provisioning call would produce. Without this, a
      // recovered namespace would always land at PSA=baseline even on
      // host-ports-enabled clusters, and any hostPort deployment would
      // re-fail until the next routine applyNamespace touch.
      const { getSettings } = await import('../system-settings/service.js');
      const settings = await getSettings(db).catch(() => null);
      const allowHostPorts = !!(settings?.allowHostPortsServer || settings?.allowHostPortsWorker);
      await applyNamespace(k8s, ns, tenantId, { allowHostPorts });
      repaired.push('namespace_missing');
    } catch (err) {
      errors.push(`namespace_missing: ${(err as Error).message}`);
    }
  }
  if (findings.includes('pvc_missing')) {
    try {
      const sharedPvcSize = Math.min(10, Number(tenant.storageLimitOverride ?? plan?.storageLimit ?? 10));
      await applyPVC(k8s, ns, String(sharedPvcSize), storageClass);
      repaired.push('pvc_missing');
    } catch (err) {
      errors.push(`pvc_missing: ${(err as Error).message}`);
    }
  }
  if (findings.includes('resource_quota_missing')) {
    try {
      const cpu = String(parseFloat(String(tenant.cpuLimitOverride ?? plan?.cpuLimit ?? '2')));
      const memory = String(parseFloat(String(tenant.memoryLimitOverride ?? plan?.memoryLimit ?? '4')));
      const storage = String(parseFloat(String(tenant.storageLimitOverride ?? plan?.storageLimit ?? '50')));
      await applyResourceQuota(k8s, ns, { cpu, memory, storage });
      repaired.push('resource_quota_missing');
    } catch (err) {
      errors.push(`resource_quota_missing: ${(err as Error).message}`);
    }
  }
  if (findings.includes('network_policy_missing')) {
    try {
      await applyNetworkPolicy(k8s, ns);
      repaired.push('network_policy_missing');
    } catch (err) {
      errors.push(`network_policy_missing: ${(err as Error).message}`);
    }
  }

  // Surface findings to every admin-panel super_admin / admin so the
  // bell icon picks them up. notifications.user_id is per-recipient,
  // so we fan out one row per admin.
  if (repaired.length > 0 || errors.length > 0) {
    const adminRows = await db
      .select({ id: users.id })
      .from(users)
      .where(inArray(users.roleName, ['super_admin', 'admin']));
    const title = errors.length > 0
      ? `Namespace integrity issues for '${tenant.name}'`
      : `Namespace integrity repaired for '${tenant.name}'`;
    const message = errors.length > 0
      ? `Auto-repair partially failed. Repaired: ${repaired.join(', ') || 'none'}. Errors: ${errors.join('; ')}`
      : `Auto-repaired missing resources: ${repaired.join(', ')}`;
    for (const a of adminRows) {
      await db.insert(notifications).values({
        id: crypto.randomUUID(),
        userId: a.id,
        type: errors.length > 0 ? 'error' : 'success',
        title,
        message,
        resourceType: 'tenant',
        resourceId: tenantId,
      }).catch((err) => {
        console.error('[namespace-integrity] notification write failed:', (err as Error).message);
      });
    }
  }

  return {
    tenantId,
    name: tenant.name,
    namespace: ns,
    findings,
    repaired,
    errors,
  };
}

/**
 * Cron-driven fleet sweep — audit every active provisioned tenant, repair
 * any gaps. Runs from the storage-lifecycle scheduler so it shares the
 * same k8s tenant + DB pool.
 */
export async function sweepFleetIntegrity(
  db: Database,
  k8s: K8sClients,
): Promise<{ readonly checked: number; readonly repaired: number; readonly errored: number }> {
  const provisioned = await db
    .select({ id: tenants.id })
    .from(tenants)
    .where(inArray(tenants.provisioningStatus, ['provisioned']));

  let repairedTotal = 0;
  let erroredTotal = 0;

  for (const c of provisioned) {
    try {
      const report = await checkTenantNamespaceIntegrity(db, k8s, c.id, true);
      if (report.repaired.length > 0) repairedTotal += 1;
      if (report.errors.length > 0) erroredTotal += 1;
    } catch (err) {
      erroredTotal += 1;
      console.error(`[namespace-integrity] sweep failed for ${c.id}:`, (err as Error).message);
    }
  }

  return { checked: provisioned.length, repaired: repairedTotal, errored: erroredTotal };
}
