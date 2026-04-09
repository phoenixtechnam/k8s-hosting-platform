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
import { emailDomains, domains, clients } from '../../db/schema.js';
import { certificateNameFor } from '../certificates/service.js';
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
      clientNamespace: clients.kubernetesNamespace,
      webmailStatus: emailDomains.webmailStatus,
      webmailEnabled: emailDomains.webmailEnabled,
    })
    .from(emailDomains)
    .innerJoin(domains, eq(emailDomains.domainId, domains.id))
    .innerJoin(clients, eq(emailDomains.clientId, clients.id))
    .where(inArray(emailDomains.webmailStatus, ['pending', 'ready_no_tls']));

  let promoted = 0;
  let errors = 0;

  for (const row of candidates) {
    if (row.webmailEnabled !== 1) continue;
    const hostname = `webmail.${row.domainName}`;
    try {
      const ready = await readCertReadyStatus(k8s, row.clientNamespace, hostname);
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
