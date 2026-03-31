/**
 * Workload K8s deployer.
 *
 * Creates/manages Deployments + Services in client namespaces.
 * Follows the same patterns as file-manager/k8s-lifecycle.ts.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface WorkloadDeployInput {
  readonly name: string;
  readonly image: string;
  readonly containerPort: number;
  readonly replicaCount: number;
  readonly cpuRequest: string;
  readonly memoryRequest: string;
  readonly mountPath?: string | null;
  readonly namespace: string;
}

export interface WorkloadPodStatus {
  readonly phase: 'not_deployed' | 'starting' | 'running' | 'failed' | 'stopped';
  readonly ready: boolean;
  readonly replicas: number;
  readonly readyReplicas: number;
  readonly message?: string;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function isK8s404(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return true;
  if ((err as { statusCode?: number }).statusCode === 404) return true;
  return false;
}

function isK8s409(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 409')) return true;
  if ((err as { statusCode?: number }).statusCode === 409) return true;
  return false;
}

function workloadLabels(name: string): Record<string, string> {
  return { app: name, 'platform.io/component': 'workload' };
}

// ─── Deploy ─────────────────────────────────────────────────────────────────

/**
 * Create a Deployment + ClusterIP Service for a workload.
 * Idempotent: if resources exist, updates them.
 */
export async function deployWorkload(
  k8s: K8sClients,
  input: WorkloadDeployInput,
): Promise<void> {
  const labels = workloadLabels(input.name);
  const { namespace, name } = input;

  // Build container spec
  const volumeMounts = input.mountPath
    ? [{ name: 'client-storage', mountPath: input.mountPath, subPath: name }]
    : undefined;

  const container = {
    name,
    image: input.image,
    imagePullPolicy: 'IfNotPresent' as const,
    ports: [{ containerPort: input.containerPort }],
    resources: {
      requests: { cpu: input.cpuRequest, memory: input.memoryRequest },
      limits: { cpu: input.cpuRequest, memory: input.memoryRequest },
    },
    ...(volumeMounts ? { volumeMounts } : {}),
  };

  // Mount shared PVC if the image specifies a mount path
  const volumes = input.mountPath
    ? [{ name: 'client-storage', persistentVolumeClaim: { claimName: `${namespace}-storage` } }]
    : undefined;

  const deploymentBody = {
    metadata: { name, namespace, labels },
    spec: {
      replicas: input.replicaCount,
      selector: { matchLabels: { app: name } },
      template: {
        metadata: { labels },
        spec: {
          containers: [container],
          ...(volumes ? { volumes } : {}),
        },
      },
    },
  };

  // Create or update Deployment
  try {
    await k8s.apps.createNamespacedDeployment({ namespace, body: deploymentBody });
  } catch (err: unknown) {
    if (isK8s409(err)) {
      await k8s.apps.replaceNamespacedDeployment({ name, namespace, body: deploymentBody });
    } else {
      throw err;
    }
  }

  // Create or update Service
  const serviceBody = {
    metadata: { name, namespace, labels },
    spec: {
      type: 'ClusterIP',
      selector: { app: name },
      ports: [{ port: 80, targetPort: input.containerPort }],
    },
  };

  try {
    await k8s.core.createNamespacedService({ namespace, body: serviceBody });
  } catch (err: unknown) {
    if (isK8s409(err)) {
      // Services can't be replaced easily — delete and recreate
      await k8s.core.deleteNamespacedService({ name, namespace });
      await k8s.core.createNamespacedService({ namespace, body: serviceBody });
    } else {
      throw err;
    }
  }
}

// ─── Stop (scale to 0) ─────────────────────────────────────────────────────

export async function stopWorkload(
  k8s: K8sClients,
  namespace: string,
  name: string,
): Promise<void> {
  try {
    await k8s.apps.patchNamespacedDeployment({
      name,
      namespace,
      body: { spec: { replicas: 0 } },
      contentType: 'application/strategic-merge-patch+json',
    } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0]);
  } catch (err: unknown) {
    if (!isK8s404(err)) throw err;
  }
}

// ─── Start (scale back up) ──────────────────────────────────────────────────

export async function startWorkload(
  k8s: K8sClients,
  namespace: string,
  name: string,
  replicas: number,
): Promise<void> {
  try {
    await k8s.apps.patchNamespacedDeployment({
      name,
      namespace,
      body: { spec: { replicas } },
      contentType: 'application/strategic-merge-patch+json',
    } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0]);
  } catch (err: unknown) {
    if (!isK8s404(err)) throw err;
  }
}

// ─── Delete ─────────────────────────────────────────────────────────────────

export async function deleteWorkloadResources(
  k8s: K8sClients,
  namespace: string,
  name: string,
): Promise<void> {
  try {
    await k8s.apps.deleteNamespacedDeployment({ name, namespace });
  } catch (err: unknown) {
    if (!isK8s404(err)) throw err;
  }
  try {
    await k8s.core.deleteNamespacedService({ name, namespace });
  } catch (err: unknown) {
    if (!isK8s404(err)) throw err;
  }
}

// ─── Status ─────────────────────────────────────────────────────────────────

export async function getWorkloadStatus(
  k8s: K8sClients,
  namespace: string,
  name: string,
): Promise<WorkloadPodStatus> {
  // Check deployment exists
  let deployment: Record<string, unknown> | null = null;
  try {
    deployment = await k8s.apps.readNamespacedDeployment({ name, namespace }) as Record<string, unknown>;
  } catch (err: unknown) {
    if (isK8s404(err)) return { phase: 'not_deployed', ready: false, replicas: 0, readyReplicas: 0 };
    throw err;
  }

  const spec = (deployment as { spec?: { replicas?: number } }).spec;
  const status = (deployment as { status?: { replicas?: number; readyReplicas?: number; unavailableReplicas?: number } }).status;
  const desiredReplicas = spec?.replicas ?? 1;
  const readyReplicas = status?.readyReplicas ?? 0;
  const currentReplicas = status?.replicas ?? 0;

  if (desiredReplicas === 0) {
    return { phase: 'stopped', ready: false, replicas: 0, readyReplicas: 0 };
  }

  // Check pods for error details
  const pods = await k8s.core.listNamespacedPod({ namespace, labelSelector: `app=${name}` });
  const podList = (pods as { items?: Array<{ status?: { phase?: string; containerStatuses?: Array<{ state?: { waiting?: { reason?: string; message?: string } } }> } }> }).items ?? [];

  for (const pod of podList) {
    const containerStatuses = pod.status?.containerStatuses ?? [];
    for (const cs of containerStatuses) {
      const waitReason = cs.state?.waiting?.reason;
      if (waitReason === 'CrashLoopBackOff' || waitReason === 'ImagePullBackOff' || waitReason === 'ErrImagePull' || waitReason === 'OOMKilled') {
        return {
          phase: 'failed',
          ready: false,
          replicas: currentReplicas,
          readyReplicas,
          message: `${waitReason}: ${cs.state?.waiting?.message ?? ''}`.trim(),
        };
      }
    }
  }

  if (readyReplicas >= desiredReplicas) {
    return { phase: 'running', ready: true, replicas: currentReplicas, readyReplicas };
  }

  return {
    phase: 'starting',
    ready: false,
    replicas: currentReplicas,
    readyReplicas,
    message: `${readyReplicas}/${desiredReplicas} replicas ready`,
  };
}
