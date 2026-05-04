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
import { registerClientsStatusStampHook } from './db-clients-stamp.js';
import { registerIngressHooks } from './k8s-ingress.js';
import { registerDnsZoneCleanupHook } from './dns-zone-cleanup.js';
import { registerBackupsV2BundleCleanupHook } from './backups-v2-cleanup.js';
import { registerClusterScopedRefsCleanupHook } from './cluster-scoped-refs.js';

export function registerAllLifecycleHooks(): void {
  // Phase 2: PV/Longhorn cleanup on delete.
  registerPvCleanupReleasedHook();

  // Phase 3: DB cascades for suspend/active/archived/restored.
  registerDomainsStatusHook();
  registerCronjobsEnableHook();
  registerMailboxesStatusHook();
  registerEmailAliasesEnableHook();
  registerDeploymentsStatusHook();
  registerPrivateWorkersLifecycleHook();
  registerClientsStatusStampHook();

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
  registerBackupsV2BundleCleanupHook();
  registerClusterScopedRefsCleanupHook();
}
