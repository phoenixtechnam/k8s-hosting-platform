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
import { registerClientsStatusStampHook } from './db-clients-stamp.js';
import { registerIngressHooks } from './k8s-ingress.js';

export function registerAllLifecycleHooks(): void {
  // Phase 2: PV/Longhorn cleanup on delete.
  registerPvCleanupReleasedHook();

  // Phase 3: DB cascades for suspend/active/archived/restored.
  registerDomainsStatusHook();
  registerCronjobsEnableHook();
  registerMailboxesStatusHook();
  registerEmailAliasesEnableHook();
  registerDeploymentsStatusHook();
  registerClientsStatusStampHook();

  // Phase 3: K8s ingress suspend / resume / reconcile.
  registerIngressHooks();
}
