/**
 * SYSTEM tenant provisioning service.
 *
 * `ensureSystemTenant` is the idempotent entry point used by:
 *   1. `scripts/bootstrap.sh` — first-install
 *   2. Backend startup (`server.ts`) — self-healing for restored
 *      databases or accidental direct-SQL deletion of the SYSTEM row
 *   3. Integration tests — fresh fixture setup
 *
 * The at-most-one-row invariant is enforced at the DB layer by the
 * partial unique index `tenants_only_one_system_idx` from migration
 * 0008. This code does a read-before-write lookup so the common path
 * (SYSTEM already exists) returns cheaply without churning the
 * constraint-violation log.
 *
 * The SYSTEM row uses:
 *   - status='active' (always; protected against transitions by the
 *     system-tenant-guard lifecycle hook + service-layer guards)
 *   - kubernetes_namespace='tenant-system' (deterministic)
 *   - plan_id = smallest plan (by monthly_price_usd) found in the
 *     hosting_plans table
 *   - max_mailboxes_override=10, max_sub_users_override=10,
 *     storage_limit_override=2.00 — the agreed ceiling per ADR-040
 *
 * The tenant_admin user uses `_system@<apex>` (see slug.ts for why).
 *
 * Bootstrap-time provisioning of the k8s namespace is fire-and-forget
 * via the standard runProvisionNamespace task — same pattern as
 * routes.ts POST /tenants. If kubeconfig isn't available (test boot,
 * pre-k8s bootstrap step), the namespace gets provisioned on first
 * admin action against SYSTEM through the regular UI path.
 */

import { eq, asc } from 'drizzle-orm';
import bcrypt from 'bcrypt';
import { tenants, domains, hostingPlans, regions, users, provisioningTasks } from '../../db/schema.js';
import { resolveBaseDomain } from '../../config/domains.js';
import { SYSTEM_TENANT_NAME, SYSTEM_TENANT_NAMESPACE, systemTenantEmail } from './slug.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

/** Per-tenant override ceiling for SYSTEM (ADR-040 §3, "Plan / quota"). */
export const SYSTEM_TENANT_OVERRIDES = {
  /** Max mailbox count override — 10 transactional addresses leaves
   *  headroom for noreply@, postmaster@, abuse@, security@, etc. */
  maxMailboxes: 10,
  /** Sub-user override — 10 platform-internal operator accounts. */
  maxSubUsers: 10,
  /** Storage cap in GiB. 2 GiB matches the cheapest plan's default
   *  and is plenty for the apex landing-page content + a small
   *  marketing/docs site if the operator ever uses it. */
  storageLimitGiB: 2,
} as const;

export interface EnsureSystemTenantResult {
  tenantId: string;
  created: boolean;
  /** True if the row already existed and we did nothing. */
  alreadyExisted: boolean;
  /** True if the apex domain row was inserted in this call. */
  apexDomainCreated: boolean;
  /** True if the tenant_admin user was created in this call. */
  adminUserCreated: boolean;
}

/**
 * Find the SYSTEM tenant row, if any. Returns the full row so callers
 * can read its id/namespace for downstream operations.
 */
export async function findSystemTenant(db: Database) {
  const [row] = await db.select()
    .from(tenants)
    .where(eq(tenants.isSystem, true))
    .limit(1);
  return row ?? null;
}

/**
 * Idempotent: ensures exactly one SYSTEM tenant exists with the
 * canonical name, namespace, plan, and override ceilings. Returns
 * a structured result so callers (bootstrap script, server startup,
 * tests) can log "created" vs "already existed" without re-reading.
 *
 * Does NOT trigger k8s namespace provisioning — the caller decides
 * (bootstrap defers to operator; server startup enqueues a task).
 */
export async function ensureSystemTenant(
  db: Database,
  baseDomain: string,
): Promise<EnsureSystemTenantResult> {
  const apex = baseDomain.trim().replace(/^\.+/, '');
  if (!apex) {
    throw new Error('ensureSystemTenant: baseDomain is empty');
  }

  const existing = await findSystemTenant(db);
  if (existing) {
    // Self-heal: a follow-up call may need to insert the apex domain
    // row + admin user if those were lost (PG restore, manual SQL).
    const apexCreated = await ensureSystemApexDomain(db, existing.id, apex);
    const adminCreated = await ensureSystemAdminUser(db, existing.id, apex);
    return {
      tenantId: existing.id,
      created: false,
      alreadyExisted: true,
      apexDomainCreated: apexCreated,
      adminUserCreated: adminCreated,
    };
  }

  // Resolve smallest plan (by monthly_price_usd ASC). Defensive fallback
  // to the row count check: if no plans exist yet, seed hasn't run.
  const [smallestPlan] = await db.select({ id: hostingPlans.id })
    .from(hostingPlans)
    .orderBy(asc(hostingPlans.monthlyPriceUsd))
    .limit(1);
  if (!smallestPlan) {
    throw new Error('ensureSystemTenant: no hosting_plans rows found (seed.ts must run first)');
  }

  // Resolve a region. SYSTEM lives in whatever region the rest of the
  // platform considers the apex region. seed.ts inserts a single
  // 'eu-west' row by default; production may have multiple.
  const [anyRegion] = await db.select({ id: regions.id })
    .from(regions)
    .limit(1);
  if (!anyRegion) {
    throw new Error('ensureSystemTenant: no regions rows found (seed.ts must run first)');
  }

  const tenantId = crypto.randomUUID();
  try {
    await db.insert(tenants).values({
      id: tenantId,
      regionId: anyRegion.id,
      name: SYSTEM_TENANT_NAME,
      primaryEmail: systemTenantEmail(apex),
      contactName: 'Platform Operator',
      status: 'active',
      kubernetesNamespace: SYSTEM_TENANT_NAMESPACE,
      planId: smallestPlan.id,
      maxMailboxesOverride: SYSTEM_TENANT_OVERRIDES.maxMailboxes,
      maxSubUsersOverride: SYSTEM_TENANT_OVERRIDES.maxSubUsers,
      storageLimitOverride: String(SYSTEM_TENANT_OVERRIDES.storageLimitGiB),
      storageTier: 'local',
      provisioningStatus: 'unprovisioned',
      isSystem: true,
      // No createdBy: the platform itself owns this row, not an admin
      // user. UI surfaces this as "platform-managed" rather than
      // "created by X".
    });
  } catch (err) {
    // Concurrent-startup race: two replicas may both pass the
    // `findSystemTenant` check above and race to INSERT. The partial
    // unique index `tenants_only_one_system_idx` ensures exactly one
    // wins; the loser hits SQLSTATE 23505 (unique_violation). Treat
    // that as "another replica created it first" and fall back to a
    // re-read so we return a consistent `alreadyExisted: true` result.
    const pgErr = err as { code?: string; cause?: { code?: string; constraint?: string } };
    const code = pgErr.code ?? pgErr.cause?.code;
    const constraint = pgErr.cause?.constraint;
    if (code === '23505' && (constraint === 'tenants_only_one_system_idx' || !constraint)) {
      const existingAfterRace = await findSystemTenant(db);
      if (existingAfterRace) {
        const apexCreated = await ensureSystemApexDomain(db, existingAfterRace.id, apex);
        const adminCreated = await ensureSystemAdminUser(db, existingAfterRace.id, apex);
        return {
          tenantId: existingAfterRace.id,
          created: false,
          alreadyExisted: true,
          apexDomainCreated: apexCreated,
          adminUserCreated: adminCreated,
        };
      }
    }
    throw err;
  }

  const apexCreated = await ensureSystemApexDomain(db, tenantId, apex);
  const adminCreated = await ensureSystemAdminUser(db, tenantId, apex);

  return {
    tenantId,
    created: true,
    alreadyExisted: false,
    apexDomainCreated: apexCreated,
    adminUserCreated: adminCreated,
  };
}

/**
 * Insert the apex domain row owned by SYSTEM if it doesn't already
 * exist. Idempotent. Uses `dnsMode='primary'` because the apex is the
 * canonical hostname for the entire platform — every customer-facing
 * subdomain CNAMEs to it.
 *
 * Returns true if we inserted a row, false if it already existed.
 */
export async function ensureSystemApexDomain(
  db: Database,
  systemTenantId: string,
  apex: string,
): Promise<boolean> {
  const [existing] = await db.select({ id: domains.id })
    .from(domains)
    .where(eq(domains.domainName, apex))
    .limit(1);
  if (existing) return false;

  try {
    await db.insert(domains).values({
      id: crypto.randomUUID(),
      tenantId: systemTenantId,
      domainName: apex,
      status: 'active',
      dnsMode: 'primary',
    });
    return true;
  } catch (err) {
    // Concurrent-bootstrap race: another replica inserted the apex
    // row between our findById check and this INSERT. The
    // domains_name_unique constraint surfaces as 23505; treat as
    // "already exists" and report false.
    const pgErr = err as { code?: string; cause?: { code?: string } };
    if ((pgErr.code ?? pgErr.cause?.code) === '23505') return false;
    throw err;
  }
}

/**
 * Insert the SYSTEM tenant_admin user if missing. Password is random
 * and unrecoverable — the account exists for admin-impersonation
 * audit trail, not for direct login. Operators reach the SYSTEM
 * tenant by clicking "Impersonate" on the Clients page.
 *
 * Returns true if we inserted a row, false if the user already existed.
 */
export async function ensureSystemAdminUser(
  db: Database,
  systemTenantId: string,
  apex: string,
): Promise<boolean> {
  const email = systemTenantEmail(apex);
  // Always generate a fresh random password — used both for fresh
  // inserts and to overwrite any pre-existing row (defends against an
  // attacker pre-creating `_system@<apex>` with a known password
  // before first bootstrap; see SECURITY note below).
  const randomPassword = crypto.randomUUID().replace(/-/g, '') + crypto.randomUUID().replace(/-/g, '');
  const passwordHash = await bcrypt.hash(randomPassword, 12);

  const [existing] = await db.select({ id: users.id, tenantId: users.tenantId })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing) {
    // SECURITY (ADR-040): an attacker with tenant_admin on ANY tenant
    // could pre-create a sub-user with email `_system@<apex>` before
    // the platform's first bootstrap completes, then wait for
    // ensureSystemAdminUser to repoint that row at SYSTEM — gaining
    // tenant_admin access over the SYSTEM tenant via the password the
    // attacker set. To close this: on every repoint, also reset
    // panel, roleName, status, AND passwordHash so the row is
    // normalized to a known-safe state regardless of its prior
    // contents. The new password is unrecoverable (random, never
    // displayed); operators reach SYSTEM via admin impersonation.
    await db.update(users)
      .set({
        tenantId: systemTenantId,
        panel: 'tenant',
        roleName: 'tenant_admin',
        status: 'active',
        passwordHash,
        fullName: 'Platform System Account',
        emailVerifiedAt: new Date(),
      })
      .where(eq(users.id, existing.id));
    return false;
  }

  try {
    await db.insert(users).values({
      id: crypto.randomUUID(),
      email,
      passwordHash,
      fullName: 'Platform System Account',
      roleName: 'tenant_admin',
      panel: 'tenant',
      tenantId: systemTenantId,
      status: 'active',
      emailVerifiedAt: new Date(),
    });
    return true;
  } catch (err) {
    // Concurrent-bootstrap race: another replica inserted the
    // `_system@<apex>` user row between our find check and this
    // INSERT. users_email_unique surfaces as 23505; treat as
    // "already exists" and report false. The orphan-hardening
    // UPDATE in the `if (existing)` branch above runs on the next
    // bootstrap pass to normalize panel/role/password against the
    // (potentially attacker-set) row.
    const pgErr = err as { code?: string; cause?: { code?: string } };
    if ((pgErr.code ?? pgErr.cause?.code) === '23505') return false;
    throw err;
  }
}

/**
 * Enqueue a k8s namespace provisioning task for the SYSTEM tenant if
 * (a) the row exists and (b) provisioning_status is still
 * 'unprovisioned'. Fire-and-forget; failures are logged but do not
 * block the bootstrap.
 *
 * Returns the task id if enqueued, null if skipped (already
 * provisioned, no k8s available, etc.).
 */
export async function enqueueSystemNamespaceProvision(
  db: Database,
  k8s: K8sClients | null,
  log: { info: (msg: string) => void; warn: (msg: string, err?: unknown) => void },
): Promise<string | null> {
  if (!k8s) {
    log.info('[system-tenant] no k8s client — namespace provisioning deferred');
    return null;
  }
  const sys = await findSystemTenant(db);
  if (!sys) {
    log.warn('[system-tenant] enqueueSystemNamespaceProvision called but SYSTEM row missing');
    return null;
  }
  if (sys.provisioningStatus !== 'unprovisioned') {
    return null;
  }

  // Lazy import the provisioning helpers to avoid pulling the k8s
  // dependency tree into modules that don't need it (the same trick
  // tenants/routes.ts uses).
  const { PROVISION_STEPS, buildStepsLog, runProvisionNamespace, mirrorProvisioningToTaskTracker } =
    await import('../k8s-provisioner/service.js');

  const taskId = crypto.randomUUID();
  await db.insert(provisioningTasks).values({
    id: taskId,
    tenantId: sys.id,
    type: 'provision_namespace',
    status: 'pending',
    totalSteps: PROVISION_STEPS.length,
    completedSteps: 0,
    stepsLog: buildStepsLog(PROVISION_STEPS),
    startedBy: null,
  });

  await mirrorProvisioningToTaskTracker(db, taskId).catch((err) => {
    log.warn('[system-tenant] task tracker enroll failed (non-fatal)', err);
  });

  runProvisionNamespace(db, k8s, taskId, sys.id, {}).catch((err) => {
    log.warn(`[system-tenant] namespace provisioning failed (taskId=${taskId})`, err);
  });

  log.info(`[system-tenant] enqueued provisioning task ${taskId}`);
  return taskId;
}
