/**
 * Kubelet Image-GC Reconciler — Phase 2 stub.
 *
 * PURPOSE
 *   Detect drift between the kubelet's actual --image-gc-high-threshold,
 *   --image-gc-low-threshold, and --minimum-image-ttl-duration flags versus
 *   the operator-configured values stored in system_settings
 *   (imageGcHighThreshold, imageGcLowThreshold, imageGcMinTtlMinutes).
 *
 * CURRENT BEHAVIOUR (stub)
 *   - Reads each k3s node's `k3s.io/node-args` annotation, which k3s
 *     populates with the flags that were used to start the process.
 *   - Compares to the DB values.
 *   - Logs drift to the platform-api log (no auto-restart performed).
 *
 * DEFERRED BEHAVIOUR (TODO Phase 2)
 *   - Cordon the node, write updated kubelet flags to
 *     /etc/rancher/k3s/config.yaml via a privileged DaemonSet, then
 *     `systemctl restart k3s` / `k3s-agent`. Roll one node at a time.
 *   - Why deferred: live kubelet restarts affect in-flight workloads and
 *     require careful orchestration (drain → restart → uncordon). The DB +
 *     UI scaffolding ships now so the operator can see the desired state; the
 *     reconciler actuates it once we have the DaemonSet harness in place.
 *
 * OPERATOR GUIDANCE
 *   Changes to the GC thresholds take effect automatically on nodes added
 *   after the next k3s install (bootstrap.sh ships the correct
 *   --kubelet-arg flags). Existing nodes keep their current values until
 *   manually rebooted or until Phase 2 is shipped.
 */

import type { FastifyBaseLogger } from 'fastify';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { Database } from '../../db/index.js';
import { getSettings } from '../system-settings/service.js';

const RECONCILE_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes

interface GcSettings {
  highThreshold: number;
  lowThreshold: number;
  minTtlMinutes: number;
}

/**
 * Parse the kubelet image-GC flags out of the k3s node-args annotation.
 * Returns null for any flag that isn't present (meaning the kubelet default
 * applies — which we can't compare against without running on the node).
 *
 * k3s annotates each node with:
 *   k3s.io/node-args: '["server","--cluster-init","--kubelet-arg=image-gc-high-threshold=70",...]'
 */
function parseNodeGcArgs(nodeArgsJson: string): Partial<GcSettings> {
  let args: string[] = [];
  try {
    args = JSON.parse(nodeArgsJson) as string[];
  } catch {
    return {};
  }
  const result: Partial<GcSettings> = {};
  for (const arg of args) {
    const inner = arg.replace(/^--kubelet-arg=/, '');
    const [key, val] = inner.split('=');
    if (key === 'image-gc-high-threshold' && val) result.highThreshold = parseInt(val, 10);
    if (key === 'image-gc-low-threshold' && val) result.lowThreshold = parseInt(val, 10);
    if (key === 'minimum-image-ttl-duration' && val) {
      // e.g. "60m" → 60
      const match = val.match(/^(\d+)m$/);
      if (match) result.minTtlMinutes = parseInt(match[1], 10);
    }
  }
  return result;
}

/**
 * Single reconcile tick: read desired state from DB, compare to node
 * annotations, log any drift. Does NOT restart kubelets (Phase 2 TODO).
 */
async function tick(
  db: Database,
  k8s: K8sClients,
  log: FastifyBaseLogger,
): Promise<void> {
  const settings = await getSettings(db);
  const desired: GcSettings = {
    highThreshold: settings.imageGcHighThreshold,
    lowThreshold: settings.imageGcLowThreshold,
    minTtlMinutes: settings.imageGcMinTtlMinutes,
  };

  let nodeList: readonly { metadata?: { name?: string; annotations?: Record<string, string> } }[] = [];
  try {
    const raw = await k8s.core.listNode();
    nodeList = (raw as { items?: typeof nodeList }).items ?? [];
  } catch {
    log.warn('[kubelet-gc-reconciler] listNode failed — skipping tick');
    return;
  }

  for (const node of nodeList) {
    const nodeName = node.metadata?.name ?? 'unknown';
    const argsJson = node.metadata?.annotations?.['k3s.io/node-args'] ?? '';
    if (!argsJson) continue;

    const actual = parseNodeGcArgs(argsJson);
    const drifted: string[] = [];

    if (actual.highThreshold !== undefined && actual.highThreshold !== desired.highThreshold) {
      drifted.push(`image-gc-high-threshold: node=${actual.highThreshold} desired=${desired.highThreshold}`);
    }
    if (actual.lowThreshold !== undefined && actual.lowThreshold !== desired.lowThreshold) {
      drifted.push(`image-gc-low-threshold: node=${actual.lowThreshold} desired=${desired.lowThreshold}`);
    }
    if (actual.minTtlMinutes !== undefined && actual.minTtlMinutes !== desired.minTtlMinutes) {
      drifted.push(`minimum-image-ttl-duration: node=${actual.minTtlMinutes}m desired=${desired.minTtlMinutes}m`);
    }

    if (drifted.length > 0) {
      log.warn(
        { node: nodeName, drift: drifted },
        '[kubelet-gc-reconciler] kubelet GC settings drift detected — restart k3s on this node to apply desired values (auto-reconcile is Phase 2 TODO)',
      );
    }
  }
}

export interface KubeletGcReconcilerHandle {
  stop: () => void;
}

/**
 * Start the kubelet GC reconciler. Returns a handle with a `stop()` method
 * that clears the interval for clean shutdown.
 */
export function startKubeletGcReconciler(
  db: Database,
  k8s: K8sClients,
  log: FastifyBaseLogger,
): KubeletGcReconcilerHandle {
  const timer = setInterval(() => {
    tick(db, k8s, log).catch(err => {
      log.warn({ err }, '[kubelet-gc-reconciler] tick failed');
    });
  }, RECONCILE_INTERVAL_MS);

  return { stop: () => clearInterval(timer) };
}
