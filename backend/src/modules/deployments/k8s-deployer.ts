/**
 * Multi-component K8s deployer.
 *
 * Creates/manages Deployments, StatefulSets, CronJobs, and Services
 * for catalog entries in client namespaces.
 * Replaces the single-component workloads/k8s-deployer.ts.
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
  readonly namespace: string;
  readonly components: readonly DeployComponentInput[];
  readonly volumes: Array<{ local_path: string; container_path: string; size_megabytes: number }>;
  readonly replicaCount: number;
  readonly cpuRequest: string;
  readonly memoryRequest: string;
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

function deploymentLabels(deploymentName: string, componentName: string): Record<string, string> {
  return {
    app: deploymentName,
    component: componentName,
    'platform.io/managed': 'true',
  };
}

function resourceName(deploymentName: string, componentName: string, componentCount: number): string {
  // Single-component entries use just the deployment name
  if (componentCount === 1) return deploymentName;
  return `${deploymentName}-${componentName}`;
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
  const { deploymentName, namespace, components, volumes, replicaCount, cpuRequest, memoryRequest, configuration, envVars } = input;
  const componentCount = components.length;
  const env = buildEnvVars(envVars?.fixed, configuration);

  for (const component of components) {
    const name = resourceName(deploymentName, component.name, componentCount);
    const labels = deploymentLabels(deploymentName, component.name);

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
        await deployK8sDeployment(k8s, namespace, name, labels, container, replicaCount, volumes);
        break;

      case 'statefulset':
        await deployK8sStatefulSet(k8s, namespace, name, labels, container, replicaCount, volumes);
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
  volumes: Array<{ local_path: string; container_path: string; size_megabytes: number }> = [],
): Promise<void> {
  const selectorLabels = { app: labels.app, component: labels.component };

  // Mount shared client PVC with subPath per volume
  const volumeMounts = volumes.map(v => ({
    name: 'client-storage',
    mountPath: v.container_path,
    subPath: v.local_path,
  }));

  const containerWithMounts = volumes.length > 0
    ? { ...container, volumeMounts }
    : container;

  // Init container: ensures local_path directories exist on the shared PVC
  const initContainers = volumes.length > 0
    ? [{
        name: 'init-dirs',
        image: 'busybox:1.36',
        command: ['sh', '-c', volumes.map(v => `mkdir -p /data/${v.local_path}`).join(' && ')],
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

async function deployK8sStatefulSet(
  k8s: K8sClients,
  namespace: string,
  name: string,
  labels: Record<string, string>,
  container: Record<string, unknown>,
  replicaCount: number,
  volumes: Array<{ local_path: string; container_path: string; size_megabytes: number }>,
): Promise<void> {
  // Add volume mounts to container
  const volumeMounts = volumes.map((v, i) => ({
    name: `vol-${i}`,
    mountPath: v.container_path,
  }));

  const containerWithMounts = {
    ...container,
    volumeMounts,
  };

  const volumeClaimTemplates = volumes.map((v, i) => ({
    metadata: { name: `vol-${i}` },
    spec: {
      accessModes: ['ReadWriteOnce'],
      resources: {
        requests: { storage: `${v.size_megabytes}Mi` },
      },
    },
  }));

  // Init container ensures mount point directories exist inside PVCs
  const initContainers = volumes.length > 0
    ? [{
        name: 'init-dirs',
        image: 'busybox:1.36',
        command: ['sh', '-c', volumeMounts.map(vm => `mkdir -p ${vm.mountPath}`).join(' && ')],
        volumeMounts,
        resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { cpu: '50m', memory: '32Mi' } },
      }]
    : undefined;

  const selectorLabels = { app: labels.app, component: labels.component };
  const body = {
    metadata: { name, namespace, labels },
    spec: {
      replicas: replicaCount,
      serviceName: name,
      selector: { matchLabels: selectorLabels },
      template: {
        metadata: { labels },
        spec: {
          ...(initContainers ? { initContainers } : {}),
          containers: [containerWithMounts],
        },
      },
      volumeClaimTemplates,
    },
  } as Record<string, unknown>;

  try {
    await k8s.apps.createNamespacedStatefulSet({ namespace, body } as Parameters<typeof k8s.apps.createNamespacedStatefulSet>[0]);
  } catch (err: unknown) {
    if (isK8s409(err)) {
      await k8s.apps.replaceNamespacedStatefulSet({ name, namespace, body } as Parameters<typeof k8s.apps.replaceNamespacedStatefulSet>[0]);
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
  components: readonly DeployComponentInput[],
): Promise<void> {
  const componentCount = components.length;

  for (const component of components) {
    const name = resourceName(deploymentName, component.name, componentCount);

    try {
      if (component.type === 'deployment') {
        await k8s.apps.patchNamespacedDeployment({
          name,
          namespace,
          body: { spec: { replicas: 0 } },
          contentType: 'application/strategic-merge-patch+json',
        } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0]);
      } else if (component.type === 'statefulset') {
        await k8s.apps.patchNamespacedStatefulSet({
          name,
          namespace,
          body: { spec: { replicas: 0 } },
          contentType: 'application/strategic-merge-patch+json',
        } as unknown as Parameters<typeof k8s.apps.patchNamespacedStatefulSet>[0]);
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
  components: readonly DeployComponentInput[],
  replicas: number,
): Promise<void> {
  const componentCount = components.length;

  for (const component of components) {
    const name = resourceName(deploymentName, component.name, componentCount);

    try {
      if (component.type === 'deployment') {
        await k8s.apps.patchNamespacedDeployment({
          name,
          namespace,
          body: { spec: { replicas } },
          contentType: 'application/strategic-merge-patch+json',
        } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0]);
      } else if (component.type === 'statefulset') {
        await k8s.apps.patchNamespacedStatefulSet({
          name,
          namespace,
          body: { spec: { replicas } },
          contentType: 'application/strategic-merge-patch+json',
        } as unknown as Parameters<typeof k8s.apps.patchNamespacedStatefulSet>[0]);
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

// ─── Delete ─────────────────────────────────────────────────────────────────

export async function deleteDeploymentResources(
  k8s: K8sClients,
  namespace: string,
  deploymentName: string,
  components: readonly DeployComponentInput[],
): Promise<void> {
  const componentCount = components.length;

  for (const component of components) {
    const name = resourceName(deploymentName, component.name, componentCount);

    try {
      if (component.type === 'deployment') {
        await k8s.apps.deleteNamespacedDeployment({ name, namespace });
      } else if (component.type === 'statefulset') {
        await k8s.apps.deleteNamespacedStatefulSet({ name, namespace });
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
  components: readonly DeployComponentInput[],
): Promise<AggregateDeploymentStatus> {
  const componentCount = components.length;
  const componentStatuses: ComponentPodStatus[] = [];

  for (const component of components) {
    const name = resourceName(deploymentName, component.name, componentCount);

    if (component.type === 'deployment') {
      const status = await getK8sDeploymentStatus(k8s, namespace, name, component.name);
      componentStatuses.push(status);
    } else if (component.type === 'statefulset') {
      const status = await getK8sStatefulSetStatus(k8s, namespace, name, component.name);
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

  // Check for pod failures
  const pods = await k8s.core.listNamespacedPod({ namespace, labelSelector: `app=${name}` });
  const podList = (pods as { items?: Array<{ status?: { containerStatuses?: Array<{ state?: { waiting?: { reason?: string; message?: string } } }> } }> }).items ?? [];

  for (const pod of podList) {
    for (const cs of (pod.status?.containerStatuses ?? [])) {
      const waitReason = cs.state?.waiting?.reason;
      if (waitReason === 'CrashLoopBackOff' || waitReason === 'ImagePullBackOff' || waitReason === 'ErrImagePull' || waitReason === 'OOMKilled') {
        return {
          name: componentName,
          type: 'deployment',
          phase: 'failed',
          ready: false,
          message: `${waitReason}: ${cs.state?.waiting?.message ?? ''}`.trim(),
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

async function getK8sStatefulSetStatus(
  k8s: K8sClients,
  namespace: string,
  name: string,
  componentName: string,
): Promise<ComponentPodStatus> {
  let sts: Record<string, unknown> | null = null;
  try {
    sts = await k8s.apps.readNamespacedStatefulSet({ name, namespace }) as Record<string, unknown>;
  } catch (err: unknown) {
    if (isK8s404(err)) return { name: componentName, type: 'statefulset', phase: 'not_deployed', ready: false };
    throw err;
  }

  const spec = (sts as { spec?: { replicas?: number } }).spec;
  const status = (sts as { status?: { replicas?: number; readyReplicas?: number } }).status;
  const desiredReplicas = spec?.replicas ?? 1;
  const readyReplicas = status?.readyReplicas ?? 0;

  if (desiredReplicas === 0) {
    return { name: componentName, type: 'statefulset', phase: 'stopped', ready: false };
  }

  if (readyReplicas >= desiredReplicas) {
    return { name: componentName, type: 'statefulset', phase: 'running', ready: true };
  }

  return {
    name: componentName,
    type: 'statefulset',
    phase: 'starting',
    ready: false,
    message: `${readyReplicas}/${desiredReplicas} replicas ready`,
  };
}
