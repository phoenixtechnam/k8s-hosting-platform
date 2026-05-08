/**
 * k8s-client wrapper for the cluster-network admin module.
 *
 * Exposes CoreV1Api (Node read + label patch) and CustomObjectsApi (CTR +
 * CPP CRUD) bound to either an in-cluster ServiceAccount or a kubeconfig
 * file (for local dev / unit tests via fake KubeConfig).
 *
 * One bundle shape so tests can swap in a mock without recreating the
 * whole loader. Lazy-imports @kubernetes/client-node so unit tests that
 * never call into k8s don't pay the import cost.
 */

import type { CoreV1Api, CustomObjectsApi } from '@kubernetes/client-node';

export const CRD_GROUP = 'networking.platform.phoenix-host.net';
export const CRD_VERSION = 'v1alpha1';
export const CTR_PLURAL = 'clustertrustedranges';
export const CPP_PLURAL = 'clusterpendingpeers';

/** Label key the platform writes onto Node objects to flag exposure. */
export const EXPOSURE_LABEL = 'platform.phoenix-host.net/exposure';
/** Annotation key recording who toggled the label and when. */
export const EXPOSURE_AUDIT_ANNOTATION = 'platform.phoenix-host.net/exposure-audit';

export interface ClusterNetworkClients {
  readonly core: CoreV1Api;
  readonly custom: CustomObjectsApi;
}

export interface LoadOptions {
  readonly kubeconfigPath?: string | undefined;
}

export async function loadClusterNetworkClients(
  opts: LoadOptions = {},
): Promise<ClusterNetworkClients> {
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
  };
}
