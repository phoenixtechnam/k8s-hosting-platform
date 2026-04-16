import * as k8s from '@kubernetes/client-node';
import { PassThrough, type Readable } from 'stream';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export interface ComponentInfo {
  name: string;
  podName: string;
  containerName: string;
  ready: boolean;
  status: string;
  restarts: number;
}

export function listDeploymentComponents(
  pods: k8s.V1Pod[],
): readonly ComponentInfo[] {
  return pods
    .filter((p) => p.metadata?.labels?.['platform.io/managed'] === 'true')
    .map((p) => {
      const component = p.metadata?.labels?.['component'] ?? 'default';
      const cs = p.status?.containerStatuses?.[0];
      return {
        name: component,
        podName: p.metadata?.name ?? '',
        containerName: cs?.name ?? component,
        ready: cs?.ready ?? false,
        status: cs?.state?.running ? 'running'
          : cs?.state?.waiting?.reason ?? cs?.state?.terminated?.reason ?? 'unknown',
        restarts: cs?.restartCount ?? 0,
      };
    })
    .filter((c) => c.podName !== '');
}

export async function fetchPods(
  k8sClients: K8sClients,
  namespace: string,
  deploymentName: string,
): Promise<k8s.V1Pod[]> {
  const result = await k8sClients.core.listNamespacedPod({
    namespace,
    labelSelector: `app=${deploymentName},platform.io/managed=true`,
  });
  return result.items;
}

export function findPodForComponent(
  pods: k8s.V1Pod[],
  componentName: string,
): k8s.V1Pod | undefined {
  return pods.find(
    (p) => p.metadata?.labels?.['component'] === componentName
      && p.status?.phase === 'Running',
  );
}

export function createLogStream(
  kc: k8s.KubeConfig,
  namespace: string,
  podName: string,
  containerName: string,
  tailLines: number,
): Readable {
  const log = new k8s.Log(kc);
  const stream = new PassThrough();
  log.log(namespace, podName, containerName, stream, {
    follow: true,
    tailLines,
    timestamps: true,
  }).catch(() => {
    stream.destroy();
  });
  return stream;
}

export function createKubeConfig(kubeconfigPath?: string): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) {
    kc.loadFromFile(kubeconfigPath);
  } else {
    kc.loadFromCluster();
  }
  return kc;
}
