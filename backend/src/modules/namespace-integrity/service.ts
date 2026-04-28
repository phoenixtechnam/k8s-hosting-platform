import { eq, inArray } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { clients, hostingPlans, notifications, users } from '../../db/schema.js';
import {
  applyNamespace,
  applyResourceQuota,
  applyNetworkPolicy,
  applyPVC,
} from '../k8s-provisioner/service.js';

// Issue 1 fix: a namespace can lose its tenant PVC / ResourceQuota /
// NetworkPolicies after a cluster rebootstrap (sqlite→etcd, DR
// restore, etc.) while clients.provisioning_status stays
// "provisioned". The lifecycle module recreates the namespace +
// file-manager but not these other resources, leaving deployments
// stuck in pending forever.
//
// This module audits a single client (or the full fleet) for missing
// resources and repairs the gap.

export type IntegrityFinding =
  | 'namespace_missing'
  | 'pvc_missing'
  | 'resource_quota_missing'
  | 'network_policy_missing';

export interface NamespaceIntegrityReport {
  readonly clientId: string;
  readonly companyName: string;
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
 * Audit + optionally repair a single client's namespace. `repair=false`
 * is the read-only audit used by the UI. `repair=true` is the
 * "Run reconciler" admin action and the cron-driven sweep.
 */
export async function checkClientNamespaceIntegrity(
  db: Database,
  k8s: K8sClients,
  clientId: string,
  repair: boolean,
): Promise<NamespaceIntegrityReport> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) {
    throw new Error(`Client ${clientId} not found`);
  }
  if (client.provisioningStatus !== 'provisioned') {
    return {
      clientId,
      companyName: client.companyName,
      namespace: client.kubernetesNamespace,
      findings: [],
      repaired: [],
      errors: [],
    };
  }

  const findings = await inspect(k8s, client.kubernetesNamespace);
  if (findings.length === 0 || !repair) {
    return {
      clientId,
      companyName: client.companyName,
      namespace: client.kubernetesNamespace,
      findings,
      repaired: [],
      errors: [],
    };
  }

  const [plan] = await db.select().from(hostingPlans).where(eq(hostingPlans.id, client.planId)).limit(1);
  // Unified tenant SC; tier is encoded as Volume.spec.numberOfReplicas
  // and patched live by applyTenantTier rather than baked into the SC.
  const storageClass = 'longhorn-tenant';

  const repaired: IntegrityFinding[] = [];
  const errors: string[] = [];
  const ns = client.kubernetesNamespace;

  // Repair each missing resource. Order matters: namespace first, then
  // PVC + RQ + NetPol (can be parallel but the failure mode is clearer
  // serial).
  if (findings.includes('namespace_missing')) {
    try {
      await applyNamespace(k8s, ns, clientId);
      repaired.push('namespace_missing');
    } catch (err) {
      errors.push(`namespace_missing: ${(err as Error).message}`);
    }
  }
  if (findings.includes('pvc_missing')) {
    try {
      const sharedPvcSize = Math.min(10, Number(client.storageLimitOverride ?? plan?.storageLimit ?? 10));
      await applyPVC(k8s, ns, String(sharedPvcSize), storageClass);
      repaired.push('pvc_missing');
    } catch (err) {
      errors.push(`pvc_missing: ${(err as Error).message}`);
    }
  }
  if (findings.includes('resource_quota_missing')) {
    try {
      const cpu = String(parseFloat(String(client.cpuLimitOverride ?? plan?.cpuLimit ?? '2')));
      const memory = String(parseFloat(String(client.memoryLimitOverride ?? plan?.memoryLimit ?? '4')));
      const storage = String(parseFloat(String(client.storageLimitOverride ?? plan?.storageLimit ?? '50')));
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
      ? `Namespace integrity issues for '${client.companyName}'`
      : `Namespace integrity repaired for '${client.companyName}'`;
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
        resourceType: 'client',
        resourceId: clientId,
      }).catch((err) => {
        console.error('[namespace-integrity] notification write failed:', (err as Error).message);
      });
    }
  }

  return {
    clientId,
    companyName: client.companyName,
    namespace: ns,
    findings,
    repaired,
    errors,
  };
}

/**
 * Cron-driven fleet sweep — audit every active provisioned client, repair
 * any gaps. Runs from the storage-lifecycle scheduler so it shares the
 * same k8s client + DB pool.
 */
export async function sweepFleetIntegrity(
  db: Database,
  k8s: K8sClients,
): Promise<{ readonly checked: number; readonly repaired: number; readonly errored: number }> {
  const provisioned = await db
    .select({ id: clients.id })
    .from(clients)
    .where(inArray(clients.provisioningStatus, ['provisioned']));

  let repairedTotal = 0;
  let erroredTotal = 0;

  for (const c of provisioned) {
    try {
      const report = await checkClientNamespaceIntegrity(db, k8s, c.id, true);
      if (report.repaired.length > 0) repairedTotal += 1;
      if (report.errors.length > 0) erroredTotal += 1;
    } catch (err) {
      erroredTotal += 1;
      console.error(`[namespace-integrity] sweep failed for ${c.id}:`, (err as Error).message);
    }
  }

  return { checked: provisioned.length, repaired: repairedTotal, errored: erroredTotal };
}
