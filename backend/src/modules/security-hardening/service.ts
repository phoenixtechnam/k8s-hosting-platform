/**
 * Composes the top-level SecurityHardeningSnapshot from the four
 * Phase 1 sub-readers + the five Phase 2 cards. Pure orchestration —
 * no IO of its own.
 */

import type { CoreV1Api, CustomObjectsApi, AppsV1Api } from '@kubernetes/client-node';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import {
  type SecurityHardeningSnapshot,
} from '@k8s-hosting/api-contracts';
import { readProbeSnapshots, aggregateConntrack } from './ssh-probe.js';
import { buildFirewallPosture } from './firewall-posture.js';
import { fetchRecentSecurityEvents } from './recent-events.js';
import {
  buildCalicoWgStatus,
  fetchReservedHostnameCollisions,
  fetchExpiringCerts,
  fetchBackupTargetHealth,
  buildAuditLogHealth,
  buildK8sPosture,
  buildAuthPosture,
} from './phase2-cards.js';
import {
  loadSecurityHardeningClients,
  PROBE_DAEMONSET_NAME,
  PROBE_NAMESPACE,
  type LoadOptions,
} from './k8s-client.js';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';

export interface BuildSnapshotDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly db: NodePgDatabase<any>;
  readonly core: CoreV1Api;
  readonly custom: CustomObjectsApi;
  readonly apps: AppsV1Api;
  readonly now?: () => Date;
}

export async function buildSecurityHardeningSnapshot(
  deps: BuildSnapshotDeps,
): Promise<SecurityHardeningSnapshot> {
  const now = deps.now ?? (() => new Date());

  const { snapshots, publicPortsPerNode, conntrackByNode } = await readProbeSnapshots(deps.core, now);
  const aggregatedConntrack = aggregateConntrack(conntrackByNode);

  const [firewall, recentEvents, reservedHostnameCollisions, certExpiries, backupTargets, auditLogHealth, k8sPosture, authPosture] =
    await Promise.all([
      buildFirewallPosture(deps.custom, { publicPortsPerNode }, 'set', aggregatedConntrack),
      fetchRecentSecurityEvents(deps.db, 50),
      fetchReservedHostnameCollisions(deps.db, 25),
      fetchExpiringCerts(deps.custom, 30, now),
      fetchBackupTargetHealth(deps.db, now),
      buildAuditLogHealth(deps.db, now),
      buildK8sPosture(deps.core),
      buildAuthPosture(deps.db, deps.apps, now),
    ]);

  const calicoWg = await buildCalicoWgStatus(
    snapshots.length,
    publicPortsPerNode.map((p) => ({ nodeName: p.nodeName, udp: p.udp })),
  );

  return {
    generatedAt: now().toISOString(),
    nodes: [...snapshots],
    firewall,
    recentEvents,
    calicoWg,
    reservedHostnameCollisions,
    certExpiries,
    backupTargets,
    auditLogHealth,
    k8sPosture,
    authPosture,
  };
}

/** "Refresh" — patches an annotation on the security-probe DaemonSet
 *  to bump it, which forces a rollout of probe pods (and thus a
 *  fresh ConfigMap write inside the next 60s). Best-effort. */
export async function triggerProbeRefresh(opts: LoadOptions): Promise<number> {
  const clients = await loadSecurityHardeningClients(opts);
  try {
    const ds = await clients.apps.readNamespacedDaemonSet({
      name: PROBE_DAEMONSET_NAME,
      namespace: PROBE_NAMESPACE,
    });
    const ts = new Date().toISOString();
    const annotations = ds.spec?.template?.metadata?.annotations ?? {};
    const newAnnotations = {
      ...annotations,
      'security-probe.platform.phoenix-host.net/refresh-trigger': ts,
    };
    // Strategic merge for the DaemonSet — the @kubernetes/client-node
    // SDK defaults to RFC 6902 JSON patch which would reject this
    // merge-object body. STRATEGIC_MERGE_PATCH overrides the
    // Content-Type header. Without this the call silently returned
    // 422 in production and the DaemonSet was never restarted.
    // ci-k8s-patch-check.sh catches the omission.
    await clients.apps.patchNamespacedDaemonSet(
      {
        name: PROBE_DAEMONSET_NAME,
        namespace: PROBE_NAMESPACE,
        body: {
          spec: { template: { metadata: { annotations: newAnnotations } } },
        },
      },
      STRATEGIC_MERGE_PATCH,
    );
    return ds.status?.desiredNumberScheduled ?? 0;
  } catch {
    return 0;
  }
}
