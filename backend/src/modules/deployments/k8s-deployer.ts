/**
 * Multi-component K8s deployer.
 *
 * Creates/manages Deployments, CronJobs, and Services
 * for catalog entries in client namespaces.
 * All component types (including those marked 'statefulset' in catalog manifests)
 * are deployed as K8s Deployments using the shared client PVC with subPath.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface DeployComponentInput {
  readonly name: string;
  readonly type: 'deployment' | 'statefulset' | 'cronjob' | 'job';
  readonly image: string;
  readonly ports: Array<{ port: number; protocol: string; ingress?: boolean }>;
  readonly optional?: boolean;
  readonly schedule?: string;
}

export interface DeployCatalogEntryInput {
  readonly deploymentName: string;
  readonly resourceSuffix: string;
  readonly namespace: string;
  readonly components: readonly DeployComponentInput[];
  readonly volumes: Array<{ local_path: string; container_path: string }>;
  readonly replicaCount: number;
  readonly cpuRequest: string;
  readonly memoryRequest: string;
  readonly storageRequest?: string;
  readonly configuration?: Record<string, unknown>;
  readonly envVars?: { fixed?: Record<string, string> };
}

export interface ComponentPodStatus {
  readonly name: string;
  readonly type: string;
  readonly phase: 'not_deployed' | 'starting' | 'running' | 'failed' | 'stopped';
  readonly ready: boolean;
  readonly message?: string;
}

export interface AggregateDeploymentStatus {
  readonly phase: 'not_deployed' | 'starting' | 'running' | 'failed' | 'stopped';
  readonly ready: boolean;
  readonly components: readonly ComponentPodStatus[];
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

function deploymentLabels(baseName: string, componentName: string): Record<string, string> {
  return {
    app: baseName,
    component: componentName,
    'platform.io/managed': 'true',
  };
}

function k8sResourceName(deploymentName: string, resourceSuffix: string, componentName: string, componentCount: number): string {
  const base = `${deploymentName}-${resourceSuffix}`;
  if (componentCount <= 1) return base;
  return `${base}-${componentName}`;
}

function buildEnvVars(fixed?: Record<string, string>, configuration?: Record<string, unknown>): Array<{ name: string; value: string }> {
  const envVars: Array<{ name: string; value: string }> = [];

  if (fixed) {
    for (const [key, value] of Object.entries(fixed)) {
      envVars.push({ name: key, value });
    }
  }

  if (configuration) {
    for (const [key, value] of Object.entries(configuration)) {
      if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        envVars.push({ name: key, value: String(value) });
      }
    }
  }

  return envVars;
}

// ─── Deploy ─────────────────────────────────────────────────────────────────

export async function deployCatalogEntry(
  k8s: K8sClients,
  input: DeployCatalogEntryInput,
): Promise<void> {
  const { deploymentName, resourceSuffix, namespace, components, volumes, replicaCount, cpuRequest, memoryRequest, configuration, envVars } = input;
  const componentCount = components.length;
  const env = buildEnvVars(envVars?.fixed, configuration);
  const baseName = `${deploymentName}-${resourceSuffix}`;

  for (const component of components) {
    const name = k8sResourceName(deploymentName, resourceSuffix, component.name, componentCount);
    const labels = deploymentLabels(baseName, component.name);

    const container = {
      name: component.name,
      image: component.image,
      imagePullPolicy: 'IfNotPresent' as const,
      ports: component.ports.map(p => ({ containerPort: p.port })),
      resources: {
        requests: { cpu: cpuRequest, memory: memoryRequest },
        limits: { cpu: cpuRequest, memory: memoryRequest },
      },
      ...(env.length > 0 ? { env } : {}),
    };

    switch (component.type) {
      case 'deployment':
      case 'statefulset':  // Uses Deployment + shared PVC (type is semantic hint only)
        await deployK8sDeployment(k8s, namespace, name, labels, container, replicaCount, volumes);
        break;

      case 'cronjob':
        await deployK8sCronJob(k8s, namespace, name, labels, container, component.schedule ?? '0 * * * *');
        break;

      case 'job':
        // Jobs are one-shot; create only
        await deployK8sJob(k8s, namespace, name, labels, container);
        break;
    }

    // Create Service for components that have ports
    if (component.ports.length > 0 && component.type !== 'cronjob' && component.type !== 'job') {
      await deployK8sService(k8s, namespace, name, labels, component.ports);
    }
  }
}

async function deployK8sDeployment(
  k8s: K8sClients,
  namespace: string,
  name: string,
  labels: Record<string, string>,
  container: Record<string, unknown>,
  replicaCount: number,
  volumes: Array<{ local_path: string; container_path: string }> = [],
): Promise<void> {
  const selectorLabels = { app: labels.app, component: labels.component };

  // Mount shared client PVC with subPath per volume
  // Use K8s resource name in path for instance isolation so multiple
  // deployments of the same catalog entry don't collide on disk.
  const volumeMounts = volumes.map(v => {
    const parentDir = v.local_path.split('/').slice(0, -1).join('/');
    const instancePath = parentDir ? `${parentDir}/${name}` : name;
    return {
      name: 'client-storage',
      mountPath: v.container_path,
      subPath: instancePath,
    };
  });

  const containerWithMounts = volumes.length > 0
    ? { ...container, volumeMounts }
    : container;

  // Init container: ensures directories exist on the shared PVC and are
  // world-writable so database processes running as non-root can write.
  const initContainers = volumes.length > 0
    ? [{
        name: 'init-dirs',
        image: 'busybox:1.36',
        command: ['sh', '-c', volumes.map(v => {
          const parentDir = v.local_path.split('/').slice(0, -1).join('/');
          const instancePath = parentDir ? `${parentDir}/${name}` : name;
          return `mkdir -p /data/${instancePath} && chmod 777 /data/${instancePath}`;
        }).join(' && ')],
        volumeMounts: [{ name: 'client-storage', mountPath: '/data' }],
        resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { cpu: '50m', memory: '32Mi' } },
      }]
    : undefined;

  const podVolumes = volumes.length > 0
    ? [{ name: 'client-storage', persistentVolumeClaim: { claimName: `${namespace}-storage` } }]
    : undefined;

  const body = {
    metadata: { name, namespace, labels },
    spec: {
      replicas: replicaCount,
      selector: { matchLabels: selectorLabels },
      template: {
        metadata: { labels },
        spec: {
          ...(initContainers ? { initContainers } : {}),
          containers: [containerWithMounts],
          ...(podVolumes ? { volumes: podVolumes } : {}),
        },
      },
    },
  } as Record<string, unknown>;

  try {
    await k8s.apps.createNamespacedDeployment({ namespace, body } as Parameters<typeof k8s.apps.createNamespacedDeployment>[0]);
  } catch (err: unknown) {
    if (isK8s409(err)) {
      await k8s.apps.replaceNamespacedDeployment({ name, namespace, body } as Parameters<typeof k8s.apps.replaceNamespacedDeployment>[0]);
    } else {
      throw err;
    }
  }
}

async function deployK8sCronJob(
  k8s: K8sClients,
  namespace: string,
  name: string,
  labels: Record<string, string>,
  container: Record<string, unknown>,
  schedule: string,
): Promise<void> {
  const body = {
    metadata: { name, namespace, labels },
    spec: {
      schedule,
      jobTemplate: {
        metadata: { labels },
        spec: {
          template: {
            metadata: { labels },
            spec: {
              containers: [container],
              restartPolicy: 'OnFailure',
            },
          },
        },
      },
    },
  };

  try {
    await (k8s as unknown as { batch: { createNamespacedCronJob: (args: Record<string, unknown>) => Promise<void> } }).batch.createNamespacedCronJob({ namespace, body });
  } catch (err: unknown) {
    if (isK8s409(err)) {
      await (k8s as unknown as { batch: { replaceNamespacedCronJob: (args: Record<string, unknown>) => Promise<void> } }).batch.replaceNamespacedCronJob({ name, namespace, body });
    } else {
      throw err;
    }
  }
}

async function deployK8sJob(
  k8s: K8sClients,
  namespace: string,
  name: string,
  labels: Record<string, string>,
  container: Record<string, unknown>,
): Promise<void> {
  const body = {
    metadata: { name, namespace, labels },
    spec: {
      template: {
        metadata: { labels },
        spec: {
          containers: [container],
          restartPolicy: 'Never',
        },
      },
      backoffLimit: 3,
    },
  };

  try {
    await (k8s as unknown as { batch: { createNamespacedJob: (args: Record<string, unknown>) => Promise<void> } }).batch.createNamespacedJob({ namespace, body });
  } catch (err: unknown) {
    if (isK8s409(err)) {
      // Jobs cannot be updated; ignore conflict
    } else {
      throw err;
    }
  }
}

async function deployK8sService(
  k8s: K8sClients,
  namespace: string,
  name: string,
  labels: Record<string, string>,
  ports: Array<{ port: number; protocol: string; ingress?: boolean }>,
): Promise<void> {
  const svcPorts = ports.map((p, i) => ({
    name: `port-${i}`,
    port: p.port,
    targetPort: p.port,
    protocol: p.protocol.toUpperCase() === 'UDP' ? 'UDP' as const : 'TCP' as const,
  }));

  const body = {
    metadata: { name, namespace, labels },
    spec: {
      type: 'ClusterIP',
      selector: { app: labels.app, component: labels.component },
      ports: svcPorts,
    },
  };

  try {
    await k8s.core.createNamespacedService({ namespace, body });
  } catch (err: unknown) {
    if (isK8s409(err)) {
      await k8s.core.deleteNamespacedService({ name, namespace });
      await k8s.core.createNamespacedService({ namespace, body });
    } else {
      throw err;
    }
  }
}

// ─── Stop (scale to 0 / suspend) ───────────────────────────────────────────

export async function stopDeployment(
  k8s: K8sClients,
  namespace: string,
  deploymentName: string,
  resourceSuffix: string,
  components: readonly DeployComponentInput[],
): Promise<void> {
  const componentCount = components.length;

  for (const component of components) {
    const name = k8sResourceName(deploymentName, resourceSuffix, component.name, componentCount);

    try {
      if (component.type === 'deployment' || component.type === 'statefulset') {
        await k8s.apps.patchNamespacedDeployment({
          name,
          namespace,
          body: { spec: { replicas: 0 } },
          contentType: 'application/strategic-merge-patch+json',
        } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0]);
      } else if (component.type === 'cronjob') {
        await (k8s as unknown as { batch: { patchNamespacedCronJob: (args: Record<string, unknown>) => Promise<void> } }).batch.patchNamespacedCronJob({
          name,
          namespace,
          body: { spec: { suspend: true } },
          contentType: 'application/strategic-merge-patch+json',
        });
      }
    } catch (err: unknown) {
      if (!isK8s404(err)) throw err;
    }
  }
}

// ─── Start (scale back up / resume) ─────────────────────────────────────────

export async function startDeployment(
  k8s: K8sClients,
  namespace: string,
  deploymentName: string,
  resourceSuffix: string,
  components: readonly DeployComponentInput[],
  replicas: number,
): Promise<void> {
  const componentCount = components.length;

  for (const component of components) {
    const name = k8sResourceName(deploymentName, resourceSuffix, component.name, componentCount);

    try {
      if (component.type === 'deployment' || component.type === 'statefulset') {
        await k8s.apps.patchNamespacedDeployment({
          name,
          namespace,
          body: { spec: { replicas } },
          contentType: 'application/strategic-merge-patch+json',
        } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0]);
      } else if (component.type === 'cronjob') {
        await (k8s as unknown as { batch: { patchNamespacedCronJob: (args: Record<string, unknown>) => Promise<void> } }).batch.patchNamespacedCronJob({
          name,
          namespace,
          body: { spec: { suspend: false } },
          contentType: 'application/strategic-merge-patch+json',
        });
      }
    } catch (err: unknown) {
      if (!isK8s404(err)) throw err;
    }
  }
}

// ─── Restart (rolling restart via annotation) ───────────────────────────────

export async function restartDeployment(
  k8s: K8sClients,
  namespace: string,
  deploymentName: string,
  resourceSuffix: string,
  components: readonly DeployComponentInput[],
): Promise<void> {
  // Restart by deleting pods — the Deployment controller will recreate them
  const componentCount = components.length;
  const baseName = `${deploymentName}-${resourceSuffix}`;

  for (const component of components) {
    if (component.type === 'cronjob' || component.type === 'job') continue;

    const name = k8sResourceName(deploymentName, resourceSuffix, component.name, componentCount);

    try {
      // Find all pods owned by this component
      const pods = await k8s.core.listNamespacedPod({
        namespace,
        labelSelector: `app=${baseName},component=${component.name}`,
      });

      const podList = (pods as { items?: Array<{ metadata?: { name?: string } }> }).items ?? [];

      // Delete each pod — the controller will recreate them
      for (const pod of podList) {
        const podName = pod.metadata?.name;
        if (podName) {
          try {
            await k8s.core.deleteNamespacedPod({ name: podName, namespace });
          } catch (err: unknown) {
            if (!isK8s404(err)) throw err;
          }
        }
      }

      // If no pods found by label, try by resource name prefix
      if (podList.length === 0) {
        const allPods = await k8s.core.listNamespacedPod({ namespace });
        const matchingPods = ((allPods as { items?: Array<{ metadata?: { name?: string } }> }).items ?? [])
          .filter(p => p.metadata?.name?.startsWith(name));

        for (const pod of matchingPods) {
          const podName = pod.metadata?.name;
          if (podName) {
            try {
              await k8s.core.deleteNamespacedPod({ name: podName, namespace });
            } catch (err: unknown) {
              if (!isK8s404(err)) throw err;
            }
          }
        }
      }
    } catch (err: unknown) {
      if (!isK8s404(err)) throw err;
    }
  }
}

// ─── Delete ─────────────────────────────────────────────────────────────────

export async function deleteDeploymentResources(
  k8s: K8sClients,
  namespace: string,
  deploymentName: string,
  resourceSuffix: string,
  components: readonly DeployComponentInput[],
): Promise<void> {
  const componentCount = components.length;

  for (const component of components) {
    const name = k8sResourceName(deploymentName, resourceSuffix, component.name, componentCount);

    try {
      if (component.type === 'deployment' || component.type === 'statefulset') {
        await k8s.apps.deleteNamespacedDeployment({ name, namespace });
      } else if (component.type === 'cronjob') {
        await (k8s as unknown as { batch: { deleteNamespacedCronJob: (args: Record<string, unknown>) => Promise<void> } }).batch.deleteNamespacedCronJob({ name, namespace });
      } else if (component.type === 'job') {
        await (k8s as unknown as { batch: { deleteNamespacedJob: (args: Record<string, unknown>) => Promise<void> } }).batch.deleteNamespacedJob({ name, namespace });
      }
    } catch (err: unknown) {
      if (!isK8s404(err)) throw err;
    }

    // Delete associated Service
    if (component.ports.length > 0 && component.type !== 'cronjob' && component.type !== 'job') {
      try {
        await k8s.core.deleteNamespacedService({ name, namespace });
      } catch (err: unknown) {
        if (!isK8s404(err)) throw err;
      }
    }
  }
}

// ─── Status ─────────────────────────────────────────────────────────────────

export async function getDeploymentStatus(
  k8s: K8sClients,
  namespace: string,
  deploymentName: string,
  resourceSuffix: string,
  components: readonly DeployComponentInput[],
): Promise<AggregateDeploymentStatus> {
  const componentCount = components.length;
  const componentStatuses: ComponentPodStatus[] = [];
  const baseName = `${deploymentName}-${resourceSuffix}`;

  for (const component of components) {
    const name = k8sResourceName(deploymentName, resourceSuffix, component.name, componentCount);

    if (component.type === 'deployment' || component.type === 'statefulset') {
      const status = await getK8sDeploymentStatus(k8s, namespace, name, baseName, component.name);
      componentStatuses.push(status);
    } else if (component.type === 'cronjob') {
      // CronJobs are either suspended or active
      componentStatuses.push({
        name: component.name,
        type: 'cronjob',
        phase: 'running',
        ready: true,
      });
    } else {
      componentStatuses.push({
        name: component.name,
        type: component.type,
        phase: 'running',
        ready: true,
      });
    }
  }

  // Aggregate status: failed if any non-optional component failed, running if all ready
  const requiredComponents = componentStatuses.filter((cs, i) => !components[i].optional);

  let aggregatePhase: AggregateDeploymentStatus['phase'] = 'running';
  let aggregateReady = true;

  if (requiredComponents.some(c => c.phase === 'failed')) {
    aggregatePhase = 'failed';
    aggregateReady = false;
  } else if (requiredComponents.some(c => c.phase === 'not_deployed')) {
    aggregatePhase = 'not_deployed';
    aggregateReady = false;
  } else if (requiredComponents.some(c => c.phase === 'stopped')) {
    aggregatePhase = 'stopped';
    aggregateReady = false;
  } else if (requiredComponents.some(c => c.phase === 'starting')) {
    aggregatePhase = 'starting';
    aggregateReady = false;
  }

  return {
    phase: aggregatePhase,
    ready: aggregateReady,
    components: componentStatuses,
  };
}

async function getK8sDeploymentStatus(
  k8s: K8sClients,
  namespace: string,
  name: string,
  baseName: string,
  componentName: string,
): Promise<ComponentPodStatus> {
  let deployment: Record<string, unknown> | null = null;
  try {
    deployment = await k8s.apps.readNamespacedDeployment({ name, namespace }) as Record<string, unknown>;
  } catch (err: unknown) {
    if (isK8s404(err)) return { name: componentName, type: 'deployment', phase: 'not_deployed', ready: false };
    throw err;
  }

  const spec = (deployment as { spec?: { replicas?: number } }).spec;
  const status = (deployment as { status?: { replicas?: number; readyReplicas?: number } }).status;
  const desiredReplicas = spec?.replicas ?? 1;
  const readyReplicas = status?.readyReplicas ?? 0;

  if (desiredReplicas === 0) {
    return { name: componentName, type: 'deployment', phase: 'stopped', ready: false };
  }

  // Check for pod failures — use baseName for app label selector
  const pods = await k8s.core.listNamespacedPod({ namespace, labelSelector: `app=${baseName}` });
  const podList = (pods as { items?: Array<{ status?: { containerStatuses?: Array<{ state?: { waiting?: { reason?: string; message?: string }; terminated?: { reason?: string; message?: string; exitCode?: number } } }> } }> }).items ?? [];

  for (const pod of podList) {
    for (const cs of (pod.status?.containerStatuses ?? [])) {
      // Check waiting state (CrashLoopBackOff, ImagePullBackOff, etc.)
      const waitReason = cs.state?.waiting?.reason;
      if (waitReason === 'CrashLoopBackOff' || waitReason === 'ImagePullBackOff' || waitReason === 'ErrImagePull') {
        return {
          name: componentName,
          type: 'deployment',
          phase: 'failed',
          ready: false,
          message: `${waitReason}: ${cs.state?.waiting?.message ?? ''}`.trim(),
        };
      }

      // Check terminated state (OOMKilled, Error, etc.)
      const terminatedReason = cs.state?.terminated?.reason;
      if (terminatedReason === 'OOMKilled' || terminatedReason === 'Error') {
        const exitCode = cs.state?.terminated?.exitCode;
        const terminatedMsg = cs.state?.terminated?.message ?? '';
        const detail = exitCode !== undefined ? `exit code ${exitCode}` : '';
        const parts = [terminatedReason, terminatedMsg, detail].filter(Boolean);
        return {
          name: componentName,
          type: 'deployment',
          phase: 'failed',
          ready: false,
          message: parts.join(': ').trim(),
        };
      }
    }
  }

  if (readyReplicas >= desiredReplicas) {
    return { name: componentName, type: 'deployment', phase: 'running', ready: true };
  }

  return {
    name: componentName,
    type: 'deployment',
    phase: 'starting',
    ready: false,
    message: `${readyReplicas}/${desiredReplicas} replicas ready`,
  };
}

