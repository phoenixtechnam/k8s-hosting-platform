/**
 * Round-4 Phase 2: webmail provisioning status reconciler.
 *
 * Periodically scans email_domains rows in `pending` or
 * `ready_no_tls` state, queries the matching cert-manager
 * Certificate CR for `webmail.<domain>`, and transitions the
 * status when cert-manager has caught up:
 *
 *   pending      → ready          (Certificate.status.conditions[Ready].status = True)
 *   pending      → ready_no_tls   (cert is still issuing after the grace window)
 *   ready_no_tls → ready          (cert finally issued)
 *
 * The reconciler does NOT downgrade ready → ready_no_tls. Once an
 * Ingress has TLS the status sticks; only the underlying cert
 * lifecycle (auto-renewal failures) would warrant a downgrade and
 * cert-manager handles that with its own state transitions.
 *
 * Cert-manager Certificate CR layout:
 *   apiVersion: cert-manager.io/v1
 *   kind: Certificate
 *   status:
 *     conditions:
 *       - type: Ready
 *         status: 'True' | 'False' | 'Unknown'
 *         reason: ...
 *         message: ...
 */

import { eq, inArray } from 'drizzle-orm';
import { emailDomains, domains, tenants } from '../../db/schema.js';
import { certificateNameFor } from '../certificates/service.js';
import { getDefaultWebmailEngine } from '../webmail-settings/service.js';
import { serviceNameForEngine } from '../webmail-router/reconciler.js';
import { MERGE_PATCH } from '../../shared/k8s-patch.js';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

interface CertCondition {
  type: string;
  status: 'True' | 'False' | 'Unknown';
  reason?: string;
  message?: string;
}

interface CertResource {
  status?: {
    conditions?: CertCondition[];
  };
}

const DEFAULT_INTERVAL_MINUTES = 5;
const INITIAL_DELAY_MS = 90_000;

interface SchedulerHandle {
  stop: () => void;
}
const handles = new WeakMap<NodeJS.Timeout, SchedulerHandle>();

/**
 * Read the cert-manager Certificate CR for a hostname and return
 * its Ready condition. Returns null if the CR doesn't exist or the
 * k8s call fails. Used by the reconciler to decide whether to flip
 * a row from `pending` / `ready_no_tls` → `ready`.
 */
export async function readCertReadyStatus(
  k8s: K8sClients,
  namespace: string,
  hostname: string,
): Promise<CertCondition | null> {
  const certName = certificateNameFor(hostname, false);
  try {
    const cert = (await (k8s.custom as unknown as {
      getNamespacedCustomObject: (args: {
        group: string;
        version: string;
        namespace: string;
        plural: string;
        name: string;
      }) => Promise<CertResource>;
    }).getNamespacedCustomObject({
      group: 'cert-manager.io',
      version: 'v1',
      namespace,
      plural: 'certificates',
      name: certName,
    })) as CertResource;

    return cert?.status?.conditions?.find((c) => c.type === 'Ready') ?? null;
  } catch {
    return null;
  }
}

/**
 * Run a single reconcile pass over all email_domains in pending or
 * ready_no_tls state. For each, query the matching webmail
 * Certificate and flip status to `ready` when cert-manager reports
 * Ready=True. Returns counts for logging.
 */
export async function reconcileWebmailCertificates(
  db: Database,
  k8s: K8sClients,
): Promise<{ scanned: number; promoted: number; errors: number }> {
  // Pull all rows that need reconciliation in a single query.
  const candidates = await db
    .select({
      id: emailDomains.id,
      domainName: domains.domainName,
      tenantNamespace: tenants.kubernetesNamespace,
      webmailStatus: emailDomains.webmailStatus,
      webmailEnabled: emailDomains.webmailEnabled,
    })
    .from(emailDomains)
    .innerJoin(domains, eq(emailDomains.domainId, domains.id))
    .innerJoin(tenants, eq(emailDomains.tenantId, tenants.id))
    .where(inArray(emailDomains.webmailStatus, ['pending', 'ready_no_tls']));

  let promoted = 0;
  let errors = 0;

  for (const row of candidates) {
    if (row.webmailEnabled !== 1) continue;
    const hostname = `webmail.${row.domainName}`;
    try {
      const ready = await readCertReadyStatus(k8s, row.tenantNamespace, hostname);
      if (ready?.status === 'True') {
        await db
          .update(emailDomains)
          .set({
            webmailStatus: 'ready',
            webmailStatusMessage: null,
            webmailStatusUpdatedAt: new Date(),
          })
          .where(eq(emailDomains.id, row.id));
        promoted += 1;
      } else if (ready?.status === 'False' && row.webmailStatus === 'pending') {
        // Cert-manager has actively rejected the cert (e.g. ACME
        // challenge timed out). Move to ready_no_tls so the user
        // sees the right badge and the failure reason.
        await db
          .update(emailDomains)
          .set({
            webmailStatus: 'ready_no_tls',
            webmailStatusMessage: ready.message ?? ready.reason ?? 'Certificate not yet issued',
            webmailStatusUpdatedAt: new Date(),
          })
          .where(eq(emailDomains.id, row.id));
      }
      // status === 'Unknown' or null → leave row alone, try again next tick.
    } catch (err) {
      errors += 1;
      console.warn(
        `[webmail-reconciler] failed to reconcile ${hostname}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { scanned: candidates.length, promoted, errors };
}

/**
 * 2026-05-18: re-target every per-tenant webmail.<clientdomain>
 * ExternalName Service so it points at the currently-active webmail
 * engine (Roundcube or Bulwark), matching the behaviour of the
 * platform-wide webmail-router for `webmail.<apex>`.
 *
 * Before this reconciler, `ensureWebmailIngress` published an
 * ExternalName Service hardcoded to `roundcube.mail.svc.cluster.local`
 * — when the operator flipped the engine to Bulwark, Roundcube was
 * scaled to 0 and every per-tenant route returned 503 until someone
 * manually toggled `webmail_enabled` on each row.
 *
 * Drift detection is label-based for cheapness: each ExternalName
 * Service carries `platform.phoenix-host.net/webmail-engine: <engine>`
 * stamped by `ensureWebmailIngress`. If the label doesn't match the
 * active engine, we MERGE_PATCH both the label and `spec.externalName`
 * in a single API call. Pre-2026-05-18 Services missing the label are
 * patched once and then converge.
 *
 * Missing ExternalName Service (e.g. delete-by-hand) triggers a full
 * `ensureWebmailIngress` re-bootstrap. Disabled rows
 * (`webmailEnabled !== 1`) are skipped.
 */
export const WEBMAIL_ENGINE_LABEL = 'platform.phoenix-host.net/webmail-engine';

interface ExternalNameServiceShape {
  metadata?: {
    labels?: Record<string, string>;
  };
  spec?: {
    externalName?: string;
  };
}

export async function reconcilePerTenantWebmailEngineRouting(
  db: Database,
  k8s: K8sClients,
): Promise<{ scanned: number; patched: number; rebuilt: number; errors: number }> {
  const engine = await getDefaultWebmailEngine(db);
  const expectedService = serviceNameForEngine(engine);
  const expectedExternalName = `${expectedService}.mail.svc.cluster.local`;

  const candidates = await db
    .select({
      id: emailDomains.id,
      domainName: domains.domainName,
      tenantNamespace: tenants.kubernetesNamespace,
      webmailEnabled: emailDomains.webmailEnabled,
    })
    .from(emailDomains)
    .innerJoin(domains, eq(emailDomains.domainId, domains.id))
    .innerJoin(tenants, eq(emailDomains.tenantId, tenants.id))
    .where(eq(emailDomains.webmailEnabled, 1));

  let patched = 0;
  let rebuilt = 0;
  let errors = 0;

  for (const row of candidates) {
    const hostname = `webmail.${row.domainName}`;
    const safeName = hostname.replace(/[^a-z0-9-]/gi, '-').toLowerCase().slice(0, 50);
    const externalSvcName = `${safeName}-upstream`;
    const namespace = row.tenantNamespace;

    try {
      let live: ExternalNameServiceShape;
      try {
        live = (await k8s.core.readNamespacedService({
          namespace,
          name: externalSvcName,
        } as unknown as Parameters<typeof k8s.core.readNamespacedService>[0])) as ExternalNameServiceShape;
      } catch (err) {
        const statusCode = (err as { statusCode?: number; code?: number })?.statusCode
          ?? (err as { code?: number })?.code;
        if (statusCode === 404) {
          // The ExternalName service was deleted out-of-band. Bootstrap
          // the full Ingress + Service via the canonical path.
          const { ensureWebmailIngress } = await import('./service.js');
          await ensureWebmailIngress(db, k8s, row.id);
          rebuilt += 1;
          continue;
        }
        throw err;
      }

      const currentEngine = live.metadata?.labels?.[WEBMAIL_ENGINE_LABEL];
      const currentExternalName = live.spec?.externalName;
      if (currentEngine === engine && currentExternalName === expectedExternalName) {
        continue;
      }

      await k8s.core.patchNamespacedService(
        {
          namespace,
          name: externalSvcName,
          body: {
            metadata: { labels: { [WEBMAIL_ENGINE_LABEL]: engine } },
            spec: { externalName: expectedExternalName },
          },
        } as unknown as Parameters<typeof k8s.core.patchNamespacedService>[0],
        MERGE_PATCH,
      );
      patched += 1;
    } catch (err) {
      errors += 1;
      console.warn(
        `[webmail-reconciler] per-tenant engine reconcile failed for ${hostname}:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  return { scanned: candidates.length, patched, rebuilt, errors };
}

/**
 * Start the webmail cert status reconciler on a 5-minute timer
 * (configurable via webmail_reconciler_interval_minutes platform
 * setting in a future iteration). The first pass runs after a 90s
 * grace window so app startup completes first.
 */
export function startWebmailReconciler(
  db: Database,
  k8s: K8sClients,
): NodeJS.Timeout {
  console.log('[webmail-reconciler] Starting webmail cert status reconciler');
  const state: { stopped: boolean; pending: NodeJS.Timeout | null } = {
    stopped: false,
    pending: null,
  };

  const runCycle = async () => {
    if (state.stopped) return;
    try {
      const result = await reconcileWebmailCertificates(db, k8s);
      if (result.promoted > 0 || result.errors > 0) {
        console.log(
          `[webmail-reconciler] cycle: scanned=${result.scanned} promoted=${result.promoted} errors=${result.errors}`,
        );
      }
    } catch (err) {
      console.warn(
        '[webmail-reconciler] cycle error:',
        err instanceof Error ? err.message : String(err),
      );
    }
    // 2026-05-18: also re-target per-tenant webmail Ingresses to
    // the active engine. Runs in the same tick (and same try-isolate
    // pattern) so a failure in one pass doesn't block the other.
    try {
      const result = await reconcilePerTenantWebmailEngineRouting(db, k8s);
      if (result.patched > 0 || result.rebuilt > 0 || result.errors > 0) {
        console.log(
          `[webmail-reconciler] per-tenant engine routing: scanned=${result.scanned} patched=${result.patched} rebuilt=${result.rebuilt} errors=${result.errors}`,
        );
      }
    } catch (err) {
      console.warn(
        '[webmail-reconciler] per-tenant engine routing error:',
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!state.stopped) {
      state.pending = setTimeout(runCycle, DEFAULT_INTERVAL_MINUTES * 60 * 1000);
      if (firstHandle) handles.set(firstHandle, controlHandle);
    }
  };

  state.pending = setTimeout(runCycle, INITIAL_DELAY_MS);
  const firstHandle = state.pending;
  const controlHandle: SchedulerHandle = {
    stop: () => {
      state.stopped = true;
      if (state.pending) clearTimeout(state.pending);
    },
  };
  handles.set(firstHandle, controlHandle);
  return firstHandle;
}

export function stopWebmailReconciler(handle: NodeJS.Timeout): void {
  const ctrl = handles.get(handle);
  if (ctrl) {
    ctrl.stop();
    handles.delete(handle);
  } else {
    clearTimeout(handle);
  }
}
