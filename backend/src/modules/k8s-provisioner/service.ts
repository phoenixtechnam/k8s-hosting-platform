import { eq } from 'drizzle-orm';
import type { K8sClients } from './k8s-client.js';
import type { ProvisioningStep } from '@k8s-hosting/api-contracts';
import { clients, provisioningTasks, hostingPlans } from '../../db/schema.js';
import { getDefaultStorageClass } from '../storage-settings/service.js';
import type { Database } from '../../db/index.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/** Detect 404 errors from @kubernetes/client-node v1.4 */
function isK8s404(err: unknown): boolean {
  // v1.4 HttpException: message starts with "HTTP-Code: 404"
  if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return true;
  // Older client versions used statusCode property
  if ((err as { statusCode?: number }).statusCode === 404) return true;
  return false;
}

// ─── Step Definitions ────────────────────────────────────────────────────────

export const PROVISION_STEPS = [
  'Create Namespace',
  'Create ResourceQuota',
  'Create NetworkPolicy',
  'Create PVC',
] as const;

export const DEPROVISION_STEPS = [
  'Delete Namespace',
] as const;

// ─── Step Log Helpers ────────────────────────────────────────────────────────

export function buildStepsLog(steps: readonly string[]): ProvisioningStep[] {
  return steps.map(name => ({
    name,
    status: 'pending' as const,
    startedAt: null,
    completedAt: null,
  }));
}

export function updateStepStatus(
  log: ProvisioningStep[],
  stepName: string,
  status: ProvisioningStep['status'],
  error?: string,
): ProvisioningStep[] {
  return log.map(step => {
    if (step.name !== stepName) return step;
    return {
      ...step,
      status,
      startedAt: status === 'running' ? new Date().toISOString() : step.startedAt,
      completedAt: (status === 'completed' || status === 'failed') ? new Date().toISOString() : step.completedAt,
      error: error ?? step.error,
    };
  });
}

// ─── K8s Resource Creators ───────────────────────────────────────────────────

export async function applyNamespace(
  k8s: K8sClients,
  namespace: string,
  clientId: string,
): Promise<void> {
  // Check if namespace already exists
  try {
    await k8s.core.readNamespace({ name: namespace });
    return; // Already exists, skip
  } catch (err: unknown) {
    // @kubernetes/client-node v1.4 throws HttpException with "HTTP-Code: 404" in message
    const isNotFound = isK8s404(err);
    if (!isNotFound) throw err;
  }

  await k8s.core.createNamespace({
    body: {
      metadata: {
        name: namespace,
        labels: {
          platform: 'k8s-hosting',
          client: clientId,
        },
      },
    },
  });
}

export async function applyResourceQuota(
  k8s: K8sClients,
  namespace: string,
  limits: { cpu: string; memory: string; storage: string },
): Promise<void> {
  await k8s.core.createNamespacedResourceQuota({
    namespace,
    body: {
      metadata: {
        name: `${namespace}-quota`,
        namespace,
      },
      spec: {
        hard: {
          'limits.cpu': limits.cpu,
          'limits.memory': `${limits.memory}Gi`,
          'requests.storage': `${limits.storage}Gi`,
        },
      },
    },
  });
}

export async function applyNetworkPolicy(
  k8s: K8sClients,
  namespace: string,
): Promise<void> {
  await k8s.networking.createNamespacedNetworkPolicy({
    namespace,
    body: {
      metadata: {
        name: 'default-deny-ingress',
        namespace,
      },
      spec: {
        podSelector: {},
        policyTypes: ['Ingress'],
        ingress: [
          {
            _from: [
              {
                namespaceSelector: {
                  matchLabels: {
                    'kubernetes.io/metadata.name': 'ingress-nginx',
                  },
                },
              },
            ],
          },
        ],
      },
    },
  });
}

export async function applyPVC(
  k8s: K8sClients,
  namespace: string,
  storageGi: string,
  storageClass: string,
): Promise<void> {
  await k8s.core.createNamespacedPersistentVolumeClaim({
    namespace,
    body: {
      metadata: {
        name: `${namespace}-storage`,
        namespace,
      },
      spec: {
        accessModes: ['ReadWriteOnce'],
        storageClassName: storageClass,
        resources: {
          requests: {
            storage: `${storageGi}Gi`,
          },
        },
      },
    },
  });
}

// ─── Orchestrator ────────────────────────────────────────────────────────────

export interface ProvisionOptions {
  readonly overrides?: {
    readonly cpu_limit?: string;
    readonly memory_limit?: string;
    readonly storage_limit?: string;
  };
}

/**
 * Run the full namespace provisioning flow.
 * Updates the provisioning_tasks row with progress at each step.
 * This runs async (fire-and-forget from the route handler).
 */
export async function runProvisionNamespace(
  db: Database,
  k8s: K8sClients,
  taskId: string,
  clientId: string,
  options?: ProvisionOptions,
): Promise<void> {
  // Fetch client + plan
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) throw new Error(`Client ${clientId} not found`);

  const [plan] = await db.select().from(hostingPlans).where(eq(hostingPlans.id, client.planId)).limit(1);
  if (!plan) throw new Error(`Plan ${client.planId} not found`);

  const namespace = client.kubernetesNamespace;
  const cpuLimit = options?.overrides?.cpu_limit ?? String(parseFloat(plan.cpuLimit));
  const memoryLimit = options?.overrides?.memory_limit ?? String(parseFloat(plan.memoryLimit));
  const storageLimit = options?.overrides?.storage_limit ?? String(parseFloat(plan.storageLimit));
  const storageClass = await getDefaultStorageClass(db);

  let stepsLog = buildStepsLog(PROVISION_STEPS);
  let completedSteps = 0;

  const updateProgress = async (stepName: string, status: ProvisioningStep['status'], error?: string) => {
    stepsLog = updateStepStatus(stepsLog, stepName, status, error);
    if (status === 'completed') completedSteps++;

    await db.update(provisioningTasks).set({
      currentStep: stepName,
      completedSteps,
      stepsLog,
      ...(status === 'failed' ? { status: 'failed' as const, errorMessage: error, completedAt: new Date() } : {}),
    }).where(eq(provisioningTasks.id, taskId));
  };

  // Mark task as running
  await db.update(provisioningTasks).set({
    status: 'running',
    startedAt: new Date(),
    stepsLog,
  }).where(eq(provisioningTasks.id, taskId));

  await db.update(clients).set({
    provisioningStatus: 'provisioning',
  }).where(eq(clients.id, clientId));

  try {
    // Step 1: Create Namespace
    await updateProgress('Create Namespace', 'running');
    await applyNamespace(k8s, namespace, clientId);
    await updateProgress('Create Namespace', 'completed');

    // Step 2: Create ResourceQuota
    await updateProgress('Create ResourceQuota', 'running');
    await applyResourceQuota(k8s, namespace, { cpu: cpuLimit, memory: memoryLimit, storage: storageLimit });
    await updateProgress('Create ResourceQuota', 'completed');

    // Step 3: Create NetworkPolicy
    await updateProgress('Create NetworkPolicy', 'running');
    await applyNetworkPolicy(k8s, namespace);
    await updateProgress('Create NetworkPolicy', 'completed');

    // Step 4: Create shared PVC (all components use Deployment + subPath on this PVC)
    await updateProgress('Create PVC', 'running');
    const sharedPvcSize = Math.min(10, Number(storageLimit) || 10);
    await applyPVC(k8s, namespace, String(sharedPvcSize), storageClass);
    await updateProgress('Create PVC', 'completed');

    // All done — mark task and client as provisioned
    await db.update(provisioningTasks).set({
      status: 'completed',
      completedSteps,
      completedAt: new Date(),
      stepsLog,
    }).where(eq(provisioningTasks.id, taskId));

    await db.update(clients).set({
      provisioningStatus: 'provisioned',
    }).where(eq(clients.id, clientId));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);

    await db.update(provisioningTasks).set({
      status: 'failed',
      errorMessage: message,
      completedAt: new Date(),
      stepsLog,
    }).where(eq(provisioningTasks.id, taskId));

    await db.update(clients).set({
      provisioningStatus: 'failed',
    }).where(eq(clients.id, clientId));
  }
}

// ─── Decommission Orchestrator ───────────────────────────────────────────────

/**
 * Delete the entire namespace (cascades all resources inside it).
 * Runs async, updates provisioning_tasks with progress.
 */
export async function runDeprovision(
  db: Database,
  k8s: K8sClients,
  taskId: string,
  clientId: string,
): Promise<void> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) throw new Error(`Client ${clientId} not found`);

  const namespace = client.kubernetesNamespace;
  let stepsLog = buildStepsLog(DEPROVISION_STEPS);
  let completedSteps = 0;

  const updateProgress = async (stepName: string, status: ProvisioningStep['status'], error?: string) => {
    stepsLog = updateStepStatus(stepsLog, stepName, status, error);
    if (status === 'completed') completedSteps++;
    await db.update(provisioningTasks).set({
      currentStep: stepName,
      completedSteps,
      stepsLog,
      ...(status === 'failed' ? { status: 'failed' as const, errorMessage: error, completedAt: new Date() } : {}),
    }).where(eq(provisioningTasks.id, taskId));
  };

  await db.update(provisioningTasks).set({
    status: 'running',
    startedAt: new Date(),
    stepsLog,
  }).where(eq(provisioningTasks.id, taskId));

  try {
    // Step 1: Delete Namespace (cascades everything inside)
    await updateProgress('Delete Namespace', 'running');
    try {
      await k8s.core.deleteNamespace({ name: namespace });
    } catch (err: unknown) {
      if (!isK8s404(err)) throw err;
      // Already gone — that's fine
    }
    await updateProgress('Delete Namespace', 'completed');

    await db.update(provisioningTasks).set({
      status: 'completed',
      completedSteps,
      completedAt: new Date(),
      stepsLog,
    }).where(eq(provisioningTasks.id, taskId));

    await db.update(clients).set({
      provisioningStatus: 'unprovisioned',
    }).where(eq(clients.id, clientId));
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    await db.update(provisioningTasks).set({
      status: 'failed',
      errorMessage: message,
      completedAt: new Date(),
      stepsLog,
    }).where(eq(provisioningTasks.id, taskId));
  }
}
