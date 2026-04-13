import * as k8s from '@kubernetes/client-node';

export interface K8sClients {
  readonly core: k8s.CoreV1Api;
  readonly apps: k8s.AppsV1Api;
  readonly networking: k8s.NetworkingV1Api;
  readonly custom: k8s.CustomObjectsApi;
  readonly batch: k8s.BatchV1Api;
  readonly rbac: k8s.RbacAuthorizationV1Api;
}

/**
 * Create K8s API clients from a kubeconfig file path.
 * If no path is given, attempts in-cluster config (for production pods).
 */
export function createK8sClients(kubeconfigPath?: string): K8sClients {
  const kc = new k8s.KubeConfig();

  if (kubeconfigPath) {
    kc.loadFromFile(kubeconfigPath);
  } else {
    kc.loadFromCluster();
  }

  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
    networking: kc.makeApiClient(k8s.NetworkingV1Api),
    custom: kc.makeApiClient(k8s.CustomObjectsApi),
    batch: kc.makeApiClient(k8s.BatchV1Api),
    rbac: kc.makeApiClient(k8s.RbacAuthorizationV1Api),
  };
}
