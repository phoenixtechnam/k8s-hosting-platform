/**
 * Centralised hook registration. Called once per process from
 * `buildApp` so reviewers can grep `registerLifecycleHooks` and see
 * every registered hook in one place.
 *
 * Each individual register* function is idempotent (module-local
 * `_registered` flag), so calling this twice from a hot-reload is
 * safe.
 */
import { registerPvCleanupReleasedHook } from './pv-cleanup-released.js';
import { registerDomainsStatusHook } from './db-domains.js';
import { registerCronjobsEnableHook } from './db-cronjobs.js';
import { registerMailboxesStatusHook } from './db-mailboxes.js';
import { registerEmailAliasesEnableHook } from './db-email-aliases.js';
import { registerDeploymentsStatusHook } from './db-deployments.js';
import { registerPrivateWorkersLifecycleHook } from './db-private-workers.js';
import { registerTenantsStatusStampHook } from './db-tenants-stamp.js';
import { registerIngressHooks } from './k8s-ingress.js';
import { registerDnsZoneCleanupHook } from './dns-zone-cleanup.js';
import { registerTenantBundlesBundleCleanupHook } from './tenant-bundles-cleanup.js';
import { registerClusterScopedRefsCleanupHook } from './cluster-scoped-refs.js';
import { registerCustomDeploymentsScaleHook } from './k8s-custom-deployments.js';
// ADR-039 Phase 8 — purge orphan Bulwark settings on archive.
import { registerBulwarkSettingsPurgeHook } from './bulwark-settings-purge.js';
// ADR-040 — SYSTEM tenant protection. Runs first on suspended /
// archived / deleted; aborts the transition if the target is SYSTEM.
import { registerSystemTenantGuardHook } from './system-tenant-guard.js';

export function registerAllLifecycleHooks(): void {
  // ADR-040: SYSTEM tenant guard runs FIRST on destructive transitions
  // so no other hook does any work before we know the target is safe
  // to mutate. order:1, blocking:abort, maxAttempts:1.
  registerSystemTenantGuardHook();

  // Phase 2: PV/Longhorn cleanup on delete.
  registerPvCleanupReleasedHook();

  // Phase 3: DB cascades for suspend/active/archived/restored.
  registerDomainsStatusHook();
  registerCronjobsEnableHook();
  registerMailboxesStatusHook();
  registerEmailAliasesEnableHook();
  registerDeploymentsStatusHook();
  registerPrivateWorkersLifecycleHook();
  registerTenantsStatusStampHook();

  // Phase 3: K8s ingress suspend / resume / reconcile.
  registerIngressHooks();

  // Phase 4: external-system cleanup hooks (the actual orphan-prevention
  // win). Each defaults to AUTHORITATIVE (no legacy parallel path) but
  // accepts an emergency kill-switch via:
  //   LIFECYCLE_HOOK_DNS_ZONE_CLEANUP=disable
  //   LIFECYCLE_HOOK_BACKUPS_V2_CLEANUP=disable
  // — set when a provider outage is causing every delete to slow-fail
  // through retries.
  registerDnsZoneCleanupHook();
  registerTenantBundlesBundleCleanupHook();
  registerClusterScopedRefsCleanupHook();

  // ADR-036: custom deployments — scale K8s Deployments to 0/1 on
  // tenant suspend/restore so tenant workloads stop consuming resources.
  registerCustomDeploymentsScaleHook();

  // ADR-039 Phase 8 (retired 2026-05-17): hook is now a no-op since
  // the bulwark-impersonator sidecar that owned the cleanup endpoint
  // was removed when Bulwark's upstream /api/auth/impersonate
  // shipped. Orphan settings files are inert; see
  // bulwark-settings-purge.ts for the retire rationale.
  registerBulwarkSettingsPurgeHook();
}
