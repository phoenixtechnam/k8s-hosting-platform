/**
 * Tenant-quota provisioning gate.
 *
 * Before saving a quota override on `resource_quotas`, this module
 * checks whether the new limit would push the sum of all tenant
 * commitments past the cluster's failover-safe budget. The budget
 * comes from getClusterFailoverHeadroom (see platform-storage-policy/
 * failover-headroom.ts): total server allocatable minus system pod
 * baseline minus one server's worth (reserved for single-node-loss
 * survivability).
 *
 * The gate exists to make the user's 2026-05-11 invariant enforceable
 * rather than merely visible: "an operator cannot accidentally
 * overschedule past the point where a single-server loss leaves
 * rescheduling impossible."
 *
 * SCOPE:
 * - Sums the LIMIT fields (cpuCoresLimit, memoryGbLimit) across all
 *   resource_quotas rows — i.e. the maximum a tenant is ALLOWED to
 *   request, not what's currently allocated. This is intentional:
 *   the headroom must protect the worst-case scenario where every
 *   tenant scales to their limit simultaneously.
 * - A `force=true` query param lets a super_admin commit a quota
 *   that the cluster cannot survive — appropriate for "I accept this
 *   risk" scenarios (e.g. testing, capacity expansion in flight).
 *   Both paths emit audit-log entries.
 *
 * KNOWN LIMITATION (deliberately deferred):
 * - No advisory lock around the read-compute-write sequence. Two
 *   admin PATCHes racing within milliseconds could both see "fits"
 *   and both succeed, summing past the limit. Mitigation: this gate
 *   is an UI-driven action; humans hit it at human cadence. A
 *   pg_advisory_xact_lock around the gate is a follow-up if we ever
 *   automate quota allocation.
 */

import type { Database } from '../../db/index.js';
import { resourceQuotas } from '../../db/schema.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { getClusterFailoverHeadroom } from '../platform-storage-policy/failover-headroom.js';

export interface QuotaGateInput {
  /** Client whose quota is about to change. */
  readonly clientId: string;
  /**
   * New limit values. `null` means "leave the existing field alone" —
   * the gate then uses the current DB value for that dimension.
   */
  readonly newCpuLimit: number | null;
  readonly newMemoryLimitGi: number | null;
}

export interface QuotaGateResult {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly details: {
    readonly currentSumCpu: number;
    readonly currentSumMemoryGi: number;
    readonly projectedSumCpu: number;
    readonly projectedSumMemoryGi: number;
    readonly headroomCpu: number;
    readonly headroomMemoryGi: number;
    readonly overByCpu: number;
    readonly overByMemoryGi: number;
    /** From getClusterFailoverHeadroom — surfaces structural over-commit. */
    readonly headroomClamped: boolean;
  };
}

interface QuotaRow {
  readonly clientId: string;
  readonly cpuCoresLimit: string | null;
  readonly memoryGbLimit: number | null;
}

/**
 * Sum all tenant quota limits in a single query. Treats NULLs as the
 * application default (2 CPU / 4 GiB / 50 GiB) — review-flagged on
 * 2026-05-11 as a potential foot-gun if an operator interprets NULL
 * as "unlimited". The codebase contract (per
 * resource-quotas/service.ts DEFAULT_CPU_LIMIT etc.) is that NULL
 * means "use the plan/application default", NOT unlimited; the gate
 * follows the same convention so an under-configured tenant can't
 * escape headroom accounting just by leaving its row defaults.
 *
 * If "truly unlimited" semantics are needed in the future, introduce a
 * sentinel value (-1 or NULL with an explicit `unlimited` boolean
 * column) — silently flipping NULL's meaning would invalidate every
 * existing quota row.
 */
async function sumCurrentQuotas(
  db: Database,
  excludeClientId: string,
): Promise<{ sumCpu: number; sumMemoryGi: number; selfRow: QuotaRow | null }> {
  const rows = await db
    .select({
      clientId: resourceQuotas.clientId,
      cpuCoresLimit: resourceQuotas.cpuCoresLimit,
      memoryGbLimit: resourceQuotas.memoryGbLimit,
    })
    .from(resourceQuotas);

  const DEFAULT_CPU = 2;
  const DEFAULT_MEM = 4;
  let sumCpu = 0;
  let sumMemoryGi = 0;
  let selfRow: QuotaRow | null = null;
  for (const r of rows) {
    if (r.clientId === excludeClientId) {
      selfRow = r;
      continue;
    }
    sumCpu += r.cpuCoresLimit != null ? Number(r.cpuCoresLimit) : DEFAULT_CPU;
    sumMemoryGi += r.memoryGbLimit != null ? r.memoryGbLimit : DEFAULT_MEM;
  }
  return { sumCpu, sumMemoryGi, selfRow };
}

export async function validateQuotaFitsHeadroom(
  db: Database,
  k8s: K8sClients,
  input: QuotaGateInput,
): Promise<QuotaGateResult> {
  const headroom = await getClusterFailoverHeadroom(k8s);
  const { sumCpu, sumMemoryGi, selfRow } = await sumCurrentQuotas(db, input.clientId);

  const DEFAULT_CPU = 2;
  const DEFAULT_MEM = 4;

  // Resolve the projected limit for THIS client:
  //   - if a new value is supplied in the patch, use it
  //   - otherwise fall back to the existing DB value
  //   - otherwise the application default
  const projectedThisCpu =
    input.newCpuLimit != null
      ? input.newCpuLimit
      : selfRow?.cpuCoresLimit != null
        ? Number(selfRow.cpuCoresLimit)
        : DEFAULT_CPU;
  const projectedThisMemoryGi =
    input.newMemoryLimitGi != null
      ? input.newMemoryLimitGi
      : selfRow?.memoryGbLimit != null
        ? selfRow.memoryGbLimit
        : DEFAULT_MEM;

  const projectedSumCpu = sumCpu + projectedThisCpu;
  const projectedSumMemoryGi = sumMemoryGi + projectedThisMemoryGi;

  const overByCpu = Math.max(0, projectedSumCpu - headroom.tenantAvailableCpu);
  const overByMemoryGi = Math.max(0, projectedSumMemoryGi - headroom.tenantAvailableMemoryGi);

  const allowed = overByCpu === 0 && overByMemoryGi === 0 && !headroom.headroomClamped;

  let reason: string | null = null;
  if (!allowed) {
    const parts: string[] = [];
    if (headroom.headroomClamped) {
      parts.push(
        'cluster has no failover headroom (system baseline + one-server reserve ≥ total allocatable)',
      );
    }
    if (overByCpu > 0) parts.push(`CPU over by ${overByCpu.toFixed(2)} cores`);
    if (overByMemoryGi > 0) parts.push(`memory over by ${overByMemoryGi.toFixed(2)} GiB`);
    reason = `Granting this quota would breach single-failure survivability: ${parts.join('; ')}. Tenant total ${projectedSumCpu.toFixed(2)} CPU / ${projectedSumMemoryGi} GiB vs headroom ${headroom.tenantAvailableCpu.toFixed(2)} CPU / ${headroom.tenantAvailableMemoryGi.toFixed(2)} GiB.`;
  }

  return {
    allowed,
    reason,
    details: {
      currentSumCpu: sumCpu,
      currentSumMemoryGi: sumMemoryGi,
      projectedSumCpu,
      projectedSumMemoryGi,
      headroomCpu: headroom.tenantAvailableCpu,
      headroomMemoryGi: headroom.tenantAvailableMemoryGi,
      overByCpu,
      overByMemoryGi,
      headroomClamped: headroom.headroomClamped,
    },
  };
}

/**
 * Re-export for tests that want to stub getClusterFailoverHeadroom +
 * sumCurrentQuotas independently. Kept internal otherwise.
 */
export const __testing = { sumCurrentQuotas };
