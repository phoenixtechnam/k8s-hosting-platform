/**
 * k8s-client wrapper for the security-hardening admin module.
 *
 * The security-probe DaemonSet writes one ConfigMap per node
 * (security-probe-<node>) into `platform-system`. This module reads
 * those ConfigMaps via CoreV1Api and exposes a small surface for
 * counting ClusterPendingPeer / ClusterTrustedRange CRs via the
 * CustomObjectsApi (cross-references the firewall posture).
 *
 * Lazy-imports @kubernetes/client-node so unit tests that swap a
 * fake never pay the import cost.
 */

import type { AppsV1Api, CoreV1Api, CustomObjectsApi } from '@kubernetes/client-node';

export const PROBE_NAMESPACE = 'platform-system';
export const PROBE_CONFIGMAP_PREFIX = 'security-probe-';
export const PROBE_DAEMONSET_NAME = 'security-probe';

export interface SecurityHardeningClients {
  readonly core: CoreV1Api;
  readonly custom: CustomObjectsApi;
  readonly apps: AppsV1Api;
}

export interface LoadOptions {
  readonly kubeconfigPath?: string | undefined;
}

export async function loadSecurityHardeningClients(
  opts: LoadOptions = {},
): Promise<SecurityHardeningClients> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (opts.kubeconfigPath) {
    kc.loadFromFile(opts.kubeconfigPath);
  } else {
    kc.loadFromCluster();
  }
  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    custom: kc.makeApiClient(k8s.CustomObjectsApi),
    apps: kc.makeApiClient(k8s.AppsV1Api),
  };
}

/** Threshold (ms) after which a probe ConfigMap is considered stale. */
export const PROBE_STALE_AFTER_MS = 5 * 60 * 1000;
