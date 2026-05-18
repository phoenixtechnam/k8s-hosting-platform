/**
 * Top-level SYSTEM tenant bootstrap entrypoint.
 *
 * Composes `ensureSystemTenant` (DB row + apex domain + admin user)
 * with optional k8s namespace provisioning. Called from:
 *
 *   1. `server.ts` — every backend startup (self-healing pass).
 *   2. `scripts/bootstrap.sh` — via POST /admin/internal/system-tenant/ensure.
 *   3. Integration tests — direct import.
 *
 * Self-healing rationale: a Postgres restore from a backup taken
 * before the SYSTEM tenant existed would leave the cluster without
 * one. By re-running on every startup (~10 ms when the row already
 * exists, ~100 ms on fresh install) we close that whole class of
 * "we restored from snapshot and forgot the system row" bugs.
 *
 * The base domain is read from system_settings.ingress_base_domain
 * (the canonical platform config) with env-var fallback so the call
 * works before the first request hits the API.
 */

import { eq } from 'drizzle-orm';
import { systemSettings } from '../../db/schema.js';
import { resolveBaseDomain } from '../../config/domains.js';
import { ensureSystemTenant, enqueueSystemNamespaceProvision, type EnsureSystemTenantResult } from './service.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export interface BootstrapSystemTenantOptions {
  /** Optional k8s client. When present, the bootstrap also enqueues
   *  a namespace-provisioning task (fire-and-forget). When absent
   *  (e.g. pre-k8s bootstrap step, unit tests), the namespace gets
   *  provisioned later on the first admin action against SYSTEM. */
  k8s?: K8sClients | null;
  /** Logger surface — pluggable so server.ts can pass app.log and
   *  scripts/integration tests can pass console.log shims. */
  log?: {
    info: (msg: string) => void;
    warn: (msg: string, err?: unknown) => void;
  };
  /** Explicit base-domain override. When omitted, the bootstrap
   *  reads system_settings.ingress_base_domain falling back to
   *  PLATFORM_BASE_DOMAIN/INGRESS_BASE_DOMAIN env. */
  baseDomain?: string;
}

export interface BootstrapSystemTenantResult extends EnsureSystemTenantResult {
  /** The apex domain string used (post-trim, post-normalize). */
  baseDomain: string;
  /** Task id of the namespace-provisioning job, if one was kicked
   *  off this call. Null when k8s was unavailable, the namespace was
   *  already provisioned, or the SYSTEM row was already healthy. */
  namespaceProvisioningTaskId: string | null;
}

const NOOP_LOG = {
  info: () => {},
  warn: () => {},
};

/**
 * Resolve the platform base domain. Priority:
 *   1. Explicit override on the options
 *   2. system_settings.ingress_base_domain (canonical post-bootstrap)
 *   3. PLATFORM_BASE_DOMAIN / INGRESS_BASE_DOMAIN env (pre-DB-seed
 *      install where the row doesn't exist yet)
 *   4. Dev default (k8s-platform.test) — only relevant for local DinD
 */
async function resolvePlatformApex(
  db: Database,
  override: string | undefined,
): Promise<string> {
  if (override && override.trim()) return override.trim().replace(/^\.+/, '');

  const [row] = await db.select({ ingressBaseDomain: systemSettings.ingressBaseDomain })
    .from(systemSettings)
    .where(eq(systemSettings.id, 'system'))
    .limit(1);
  if (row?.ingressBaseDomain && row.ingressBaseDomain.trim()) {
    return row.ingressBaseDomain.trim().replace(/^\.+/, '');
  }

  return resolveBaseDomain(process.env);
}

/**
 * Run the full bootstrap pass. Safe to call repeatedly; idempotent
 * by design.
 *
 * Throws when prerequisites are missing (no hosting_plans / no
 * regions — these come from seed.ts and must be present before
 * SYSTEM can be created). Callers should run seed.ts first.
 */
export async function bootstrapSystemTenant(
  db: Database,
  options: BootstrapSystemTenantOptions = {},
): Promise<BootstrapSystemTenantResult> {
  const log = options.log ?? NOOP_LOG;
  const baseDomain = await resolvePlatformApex(db, options.baseDomain);

  const ensureResult = await ensureSystemTenant(db, baseDomain);
  if (ensureResult.created) {
    log.info(`[system-tenant] created SYSTEM tenant ${ensureResult.tenantId} (apex=${baseDomain})`);
  } else {
    log.info(`[system-tenant] SYSTEM tenant ${ensureResult.tenantId} already exists`);
  }

  const namespaceProvisioningTaskId = options.k8s !== undefined
    ? await enqueueSystemNamespaceProvision(db, options.k8s, log)
    : null;

  return {
    ...ensureResult,
    baseDomain,
    namespaceProvisioningTaskId,
  };
}
