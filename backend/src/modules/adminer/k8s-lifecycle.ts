import type { K8sClients } from '../k8s-provisioner/k8s-client.js';

export type AdminerStatus = {
  readonly ready: boolean;
  readonly phase: 'not_deployed' | 'starting' | 'ready' | 'failed';
  readonly message?: string;
};

const ADMINER_NAME = 'adminer';
const ADMINER_PORT = 8080;
const ADMINER_LABELS = {
  app: ADMINER_NAME,
  'platform.io/component': ADMINER_NAME,
  'platform.io/system': 'true',
};

function isK8s404(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return true;
  if ((err as { statusCode?: number }).statusCode === 404) return true;
  return false;
}

/**
 * Ensure the Adminer Deployment + Service exist in the namespace.
 * If already running, does nothing.
 */
export async function ensureAdminerRunning(
  k8s: K8sClients,
  namespace: string,
  image = 'adminer:4',
): Promise<void> {
  // Check if deployment exists
  let deployExists = false;
  try {
    await k8s.apps.readNamespacedDeployment({ name: ADMINER_NAME, namespace });
    deployExists = true;
  } catch (err: unknown) {
    if (!isK8s404(err)) throw err;
  }

  if (!deployExists) {
    await k8s.apps.createNamespacedDeployment({
      namespace,
      body: {
        metadata: {
          name: ADMINER_NAME,
          namespace,
          labels: ADMINER_LABELS,
          annotations: {
            'platform.io/idle-timeout': '180',
          },
        },
        spec: {
          replicas: 1,
          selector: { matchLabels: { app: ADMINER_NAME } },
          template: {
            metadata: { labels: ADMINER_LABELS },
            spec: {
              containers: [{
                name: ADMINER_NAME,
                image,
                imagePullPolicy: 'IfNotPresent',
                ports: [{ containerPort: ADMINER_PORT }],
                resources: {
                  requests: { cpu: '25m', memory: '32Mi' },
                  limits: { cpu: '100m', memory: '128Mi' },
                },
                env: [
                  { name: 'ADMINER_DEFAULT_SERVER', value: '' },
                  { name: 'ADMINER_DESIGN', value: 'nette' },
                ],
                livenessProbe: {
                  httpGet: { path: '/', port: ADMINER_PORT },
                  initialDelaySeconds: 3,
                  periodSeconds: 15,
                },
                readinessProbe: {
                  httpGet: { path: '/', port: ADMINER_PORT },
                  initialDelaySeconds: 2,
                  periodSeconds: 5,
                },
              }],
            },
          },
        },
      },
    });
  }

  // Check if service exists
  let svcExists = false;
  try {
    await k8s.core.readNamespacedService({ name: ADMINER_NAME, namespace });
    svcExists = true;
  } catch (err: unknown) {
    if (!isK8s404(err)) throw err;
  }

  if (!svcExists) {
    await k8s.core.createNamespacedService({
      namespace,
      body: {
        metadata: { name: ADMINER_NAME, namespace, labels: ADMINER_LABELS },
        spec: {
          selector: { app: ADMINER_NAME },
          ports: [{ port: ADMINER_PORT, targetPort: ADMINER_PORT }],
        },
      },
    });
  }
}

/**
 * Delete the Adminer Deployment + Service.
 */
export async function stopAdminer(
  k8s: K8sClients,
  namespace: string,
): Promise<void> {
  try {
    await k8s.apps.deleteNamespacedDeployment({ name: ADMINER_NAME, namespace });
  } catch (err: unknown) {
    if (!isK8s404(err)) throw err;
  }
  try {
    await k8s.core.deleteNamespacedService({ name: ADMINER_NAME, namespace });
  } catch (err: unknown) {
    if (!isK8s404(err)) throw err;
  }
}

/**
 * Check if the Adminer pod is ready.
 */
export async function getAdminerStatus(
  k8s: K8sClients,
  namespace: string,
): Promise<AdminerStatus> {
  // Check deployment exists
  try {
    await k8s.apps.readNamespacedDeployment({ name: ADMINER_NAME, namespace });
  } catch (err: unknown) {
    if (isK8s404(err)) return { ready: false, phase: 'not_deployed' };
    throw err;
  }

  // Check pod status
  const pods = await k8s.core.listNamespacedPod({
    namespace,
    labelSelector: `app=${ADMINER_NAME}`,
  });

  const podList = (pods as { items?: Array<{ status?: { phase?: string; conditions?: Array<{ type?: string; status?: string }> } }> }).items ?? [];

  if (podList.length === 0) {
    return { ready: false, phase: 'starting', message: 'Pod is being created' };
  }

  const pod = podList[0];
  const phase = pod.status?.phase;
  const readyCondition = pod.status?.conditions?.find(
    (c: { type?: string; status?: string }) => c.type === 'Ready' && c.status === 'True',
  );

  if (readyCondition) {
    return { ready: true, phase: 'ready' };
  }

  if (phase === 'Failed') {
    return { ready: false, phase: 'failed', message: 'Pod failed to start' };
  }

  return { ready: false, phase: 'starting', message: `Pod phase: ${phase}` };
}
