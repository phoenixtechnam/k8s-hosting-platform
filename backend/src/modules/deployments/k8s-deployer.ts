/**
 * Multi-component K8s deployer.
 *
 * Creates/manages Deployments, CronJobs, and Services for catalog entries
 * in client namespaces. For single-writer-per-tenant workloads (one
 * WordPress + one MariaDB per blog, etc.), a Deployment with strategy:
 * Recreate and the client's shared PVC mounted via subPath delivers
 * everything a StatefulSet would, with less complexity:
 *   - single replica → no ordered rollout / stable-pod-name need
 *   - shared PVC → one PVC per client, not N per app
 *   - Recreate → stop old pod before new, safe for databases
 *
 * `type: statefulset` in legacy catalog manifests is accepted for
 * backward compat and emits a Deployment with a deprecation warning.
 * Normalized catalog (k8s-application-catalog @ f20965f) uses only
 * `type: deployment | cronjob | job`.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { buildPasswordResetInitContainer } from './password-reset.js';

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
  readonly storagePath: string;
  readonly namespace: string;
  readonly components: readonly DeployComponentInput[];
  readonly volumes: Array<{ container_path: string; local_path?: string }>;
  readonly replicaCount: number;
  readonly cpuRequest: string;
  readonly memoryRequest: string;
  readonly storageRequest?: string;
  readonly configuration?: Record<string, unknown>;
  readonly envVars?: { fixed?: Record<string, string> };
  /** When true, adds a password-reset init container for reused data */
  readonly reuseExistingData?: boolean;
  /** Catalog entry code (e.g. 'mariadb', 'mysql', 'postgresql') — needed for password reset */
  readonly catalogCode?: string;
  /** Password env var name (e.g. 'MARIADB_ROOT_PASSWORD') */
  readonly passwordEnvVar?: string;
  /** Client timezone — injected as TZ env var */
  readonly timezone?: string;
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

function k8sResourceName(deploymentName: string, componentName: string, componentCount: number): string {
  if (componentCount <= 1) return deploymentName;
  return `${deploymentName}-${componentName}`;
}

function buildEnvVars(fixed?: Record<string, string>, configuration?: Record<string, unknown>): Array<{ name: string; value: string }> {
  const seen = new Set<string>();
  const envVars: Array<{ name: string; value: string }> = [];

  // Fixed env vars take precedence
  if (fixed) {
    for (const [key, value] of Object.entries(fixed)) {
      seen.add(key);
      envVars.push({ name: key, value });
    }
  }

  if (configuration) {
    for (const [key, value] of Object.entries(configuration)) {
      if (seen.has(key)) continue; // Already set by fixed
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
  const { deploymentName, namespace, components, volumes, replicaCount, cpuRequest, memoryRequest, configuration, envVars, timezone } = input;
  const componentCount = components.length;
  const env = buildEnvVars(envVars?.fixed, configuration);

  // Inject client timezone as TZ env var (respected by most Linux base images)
  if (timezone && !env.some((e) => e.name === 'TZ')) {
    env.push({ name: 'TZ', value: timezone });
  }

  // Build password-reset init container for reused data directories
  const passwordResetContainer = input.reuseExistingData && input.catalogCode && input.passwordEnvVar
    ? buildPasswordResetInitContainer({
        catalogCode: input.catalogCode,
        image: components[0]?.image ?? '',
        storagePath: input.storagePath,
        volumeMountName: 'client-storage',
        passwordEnvVar: input.passwordEnvVar,
      })
    : null;

  for (const component of components) {
    const name = k8sResourceName(deploymentName, component.name, componentCount);
    const labels = deploymentLabels(deploymentName, component.name);

    const container = {
      name: component.name,
      image: component.image,
      imagePullPolicy: 'Always' as const,
      ports: component.ports.map(p => ({ containerPort: p.port })),
      resources: {
        requests: { cpu: cpuRequest, memory: memoryRequest },
        limits: { cpu: cpuRequest, memory: memoryRequest },
      },
      ...(env.length > 0 ? { env } : {}),
    };

    switch (component.type) {
      case 'deployment':
        await deployK8sDeployment(k8s, namespace, name, labels, container, replicaCount, input.storagePath, volumes, passwordResetContainer, env);
        break;

      case 'statefulset':
        // Legacy manifest value — always emitted as a Deployment. Older
        // catalog_entries rows in the DB may still carry this type until
        // the next sync; warn and route through the Deployment path so the
        // install still succeeds.
        console.warn(
          `[deployer] component "${name}" in ${namespace} declares deprecated type 'statefulset'; emitting a Deployment. Update the catalog manifest to type: deployment.`,
        );
        await deployK8sDeployment(k8s, namespace, name, labels, container, replicaCount, input.storagePath, volumes, passwordResetContainer, env);
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
  storagePath: string,
  volumes: Array<{ container_path: string; local_path?: string }> = [],
  passwordResetContainer?: { name: string; image: string; command: readonly string[]; volumeMounts: readonly Record<string, unknown>[]; resources: Record<string, unknown>; securityContext?: Record<string, unknown> } | null,
  envVars?: Array<{ name: string; value: string }>,
): Promise<void> {
  const selectorLabels = { app: labels.app, component: labels.component };

  // Each volume gets its own subdirectory under storagePath so multi-volume
  // apps (e.g. WordPress = wp-content + mysql data) don't collide into a
  // single PVC directory. Priority:
  //   1. basename(local_path)  — catalog author's intended name
  //   2. basename(container_path) — reasonable fallback for older manifests
  //   3. `vol${index}` — last-resort unique suffix if both collide
  const seenSubPaths = new Set<string>();
  const volumeMounts = volumes.map((v, idx) => {
    const localBase = v.local_path ? v.local_path.replace(/\/+$/, '').split('/').pop() : undefined;
    const containerBase = v.container_path.replace(/\/+$/, '').split('/').pop();
    let key = (localBase && localBase !== '') ? localBase : (containerBase && containerBase !== '' ? containerBase : `vol${idx}`);
    if (seenSubPaths.has(key)) key = `${key}-${idx}`;
    seenSubPaths.add(key);
    const subPath = storagePath ? `${storagePath}/${key}` : key;
    return {
      name: 'client-storage',
      mountPath: v.container_path,
      subPath,
      _subPath: subPath, // kept for the init-dirs mkdir list below
    };
  });

  const cleanVolumeMounts = volumeMounts.map(({ name, mountPath, subPath }) => ({ name, mountPath, subPath }));

  const containerWithMounts = volumes.length > 0
    ? { ...container, volumeMounts: cleanVolumeMounts }
    : container;

  // Build init containers list
  const initContainersList: Record<string, unknown>[] = [];

  // 1. Password-reset init container (runs before init-dirs, needs the DB data)
  if (passwordResetContainer) {
    // Inject env vars so the password reset script can read $MARIADB_ROOT_PASSWORD etc.
    initContainersList.push({ ...passwordResetContainer, ...(envVars?.length ? { env: envVars } : {}) });
  }

  // 2. Init-dirs container: ensures every per-volume subPath exists on the
  //    shared PVC. Without this, Kubernetes creates the subPath for us but
  //    with root-owned 755 perms — app containers running as non-root can't
  //    write. `chmod 777` is coarse but matches the shared-PVC model where
  //    per-client isolation is enforced at the namespace/PVC boundary, not
  //    at the directory-permissions level.
  const allSubPaths = volumeMounts.map(v => v._subPath);
  if (storagePath || allSubPaths.length > 0) {
    const mkdirTargets = allSubPaths.length > 0 ? allSubPaths : [storagePath];
    const mkdirCmd = mkdirTargets
      .map(p => `mkdir -p /data/${p} && chmod 777 /data/${p}`)
      .join(' && ');
    initContainersList.push({
      name: 'init-dirs',
      image: 'busybox:1.36',
      command: ['sh', '-c', mkdirCmd],
      volumeMounts: [{ name: 'client-storage', mountPath: '/data' }],
      resources: { requests: { cpu: '10m', memory: '16Mi' }, limits: { cpu: '50m', memory: '32Mi' } },
    });
  }

  const initContainers = initContainersList.length > 0 ? initContainersList : undefined;

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
  components: readonly DeployComponentInput[],
): Promise<void> {
  const componentCount = components.length;

  for (const component of components) {
    const name = k8sResourceName(deploymentName, component.name, componentCount);

    try {
      if (component.type === 'deployment' || component.type === 'statefulset') {
        // Read current scale, set replicas to 0, replace
        const current = await k8s.apps.readNamespacedDeploymentScale({ name, namespace });
        const scale = current as { metadata?: Record<string, unknown>; spec?: Record<string, unknown> };
        await k8s.apps.replaceNamespacedDeploymentScale({
          name,
          namespace,
          body: { ...scale, spec: { ...scale.spec, replicas: 0 } },
        } as Parameters<typeof k8s.apps.replaceNamespacedDeploymentScale>[0]);
      }
    } catch (err: unknown) {
      console.error(`[k8s-deployer] Failed to stop ${name}:`, err instanceof Error ? err.message : String(err));
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
    const name = k8sResourceName(deploymentName, component.name, componentCount);

    try {
      if (component.type === 'deployment' || component.type === 'statefulset') {
        const current = await k8s.apps.readNamespacedDeploymentScale({ name, namespace });
        const scale = current as { metadata?: Record<string, unknown>; spec?: Record<string, unknown> };
        await k8s.apps.replaceNamespacedDeploymentScale({
          name,
          namespace,
          body: { ...scale, spec: { ...scale.spec, replicas } },
        } as Parameters<typeof k8s.apps.replaceNamespacedDeploymentScale>[0]);
      } else if (component.type === 'cronjob') {
        await (k8s as unknown as { batch: { patchNamespacedCronJob: (args: Record<string, unknown>) => Promise<void> } }).batch.patchNamespacedCronJob({
          name,
          namespace,
          body: { spec: { suspend: false } },
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
  components: readonly DeployComponentInput[],
): Promise<void> {
  // Restart by deleting pods — the Deployment controller will recreate them
  const componentCount = components.length;

  for (const component of components) {
    if (component.type === 'cronjob' || component.type === 'job') continue;

    const name = k8sResourceName(deploymentName, component.name, componentCount);

    try {
      // Find all pods owned by this component
      const pods = await k8s.core.listNamespacedPod({
        namespace,
        labelSelector: `app=${deploymentName},component=${component.name}`,
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
  components: readonly DeployComponentInput[],
): Promise<void> {
  const componentCount = components.length;

  for (const component of components) {
    const name = k8sResourceName(deploymentName, component.name, componentCount);

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
  components: readonly DeployComponentInput[],
): Promise<AggregateDeploymentStatus> {
  const componentCount = components.length;
  const componentStatuses: ComponentPodStatus[] = [];

  for (const component of components) {
    const name = k8sResourceName(deploymentName, component.name, componentCount);

    if (component.type === 'deployment' || component.type === 'statefulset') {
      const status = await getK8sDeploymentStatus(k8s, namespace, name, deploymentName, component.name);
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
  type PodItem = {
    status?: {
      phase?: string;
      conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }>;
      containerStatuses?: Array<{ state?: { waiting?: { reason?: string; message?: string }; terminated?: { reason?: string; message?: string; exitCode?: number } } }>;
    };
  };
  const pods = await k8s.core.listNamespacedPod({ namespace, labelSelector: `app=${baseName}` });
  const podList = (pods as { items?: PodItem[] }).items ?? [];

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

    // Check Pending pods with no container statuses (PVC not found, Unschedulable, etc.)
    if (pod.status?.phase === 'Pending' && (!pod.status.containerStatuses || pod.status.containerStatuses.length === 0)) {
      const conditions = pod.status.conditions ?? [];
      const unschedulable = conditions.find(
        c => c.type === 'PodScheduled' && c.status === 'False',
      );
      if (unschedulable?.message) {
        return {
          name: componentName,
          type: 'deployment',
          phase: 'failed',
          ready: false,
          message: unschedulable.message,
        };
      }
    }
  }

  if (readyReplicas >= desiredReplicas) {
    return { name: componentName, type: 'deployment', phase: 'running', ready: true };
  }

  // Check K8s events for FailedCreate (quota exceeded, etc.) — always check when not ready
  if (desiredReplicas > 0) {
    try {
      const events = await k8s.core.listNamespacedEvent({ namespace });
      const eventItems = (events as { items?: readonly { reason?: string; message?: string; involvedObject?: { kind?: string; name?: string } }[] }).items ?? [];
      const failedEvent = eventItems.find(
        e => e.reason === 'FailedCreate' && e.involvedObject?.kind === 'ReplicaSet' && e.involvedObject?.name?.startsWith(name),
      );
      if (failedEvent?.message) {
        const msg = failedEvent.message;
        if (msg.includes('exceeded quota')) {
          return { name: componentName, type: 'deployment', phase: 'failed', ready: false,
            message: 'Insufficient resources: the client quota has been exceeded. Free up resources or upgrade the plan.' };
        }
        return { name: componentName, type: 'deployment', phase: 'failed', ready: false, message: msg };
      }
    } catch { /* events not available */ }
  }

  return {
    name: componentName,
    type: 'deployment',
    phase: 'starting',
    ready: false,
    message: `${readyReplicas}/${desiredReplicas} replicas ready`,
  };
}

