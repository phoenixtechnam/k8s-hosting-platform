/**
 * File-manager sidecar lifecycle management.
 *
 * IMPORTANT: In Docker-in-Docker (DinD) local development, the first container
 * creation takes 20-30 seconds because k3s uses the "native" snapshotter
 * (overlayfs can't stack inside Docker). On production servers with native
 * overlayfs, cold start is ~3-4 seconds.
 */

import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { FileManagerStatus } from '@k8s-hosting/api-contracts';

const FM_NAME = 'file-manager';
const FM_PORT = 8111;
const FM_LABELS = { app: FM_NAME, 'platform.io/component': FM_NAME, 'platform.io/system': 'true' };

function isK8s404(err: unknown): boolean {
  if (err instanceof Error && err.message.includes('HTTP-Code: 404')) return true;
  if ((err as { statusCode?: number }).statusCode === 404) return true;
  return false;
}

/**
 * Ensure the file-manager Deployment + Service exist in the namespace.
 * If already running, does nothing.
 */
export async function ensureFileManagerRunning(
  k8s: K8sClients,
  namespace: string,
  image: string,
): Promise<void> {
  // Check if deployment exists
  let deployExists = false;
  try {
    await k8s.apps.readNamespacedDeployment({ name: FM_NAME, namespace });
    deployExists = true;
  } catch (err: unknown) {
    if (!isK8s404(err)) throw err;
  }

  // Ensure the platform-internal Secret exists in this namespace
  const INTERNAL_SECRET_NAME = 'platform-internal';
  try {
    await k8s.core.readNamespacedSecret({ name: INTERNAL_SECRET_NAME, namespace });
  } catch (err: unknown) {
    if (!isK8s404(err)) throw err;
    if (process.env.PLATFORM_INTERNAL_SECRET) {
      await k8s.core.createNamespacedSecret({
        namespace,
        body: {
          metadata: { name: INTERNAL_SECRET_NAME, namespace },
          type: 'Opaque',
          stringData: { PLATFORM_INTERNAL_SECRET: process.env.PLATFORM_INTERNAL_SECRET },
        },
      });
    }
  }

  const deployBody = {
      namespace,
      body: {
        metadata: { name: FM_NAME, namespace, labels: FM_LABELS },
        spec: {
          replicas: 1,
          selector: { matchLabels: FM_LABELS },
          template: {
            metadata: { labels: FM_LABELS },
            spec: {
              containers: [{
                name: FM_NAME,
                image,
                imagePullPolicy: 'IfNotPresent',
                ports: [{ containerPort: FM_PORT }],
                env: [
                  // Phase 3 T5.1: shared secret for the platform bypass header.
                  // Referenced from a K8s Secret (never as literal env value).
                  // The provisioner creates this Secret in the namespace.
                  {
                    name: 'PLATFORM_INTERNAL_SECRET',
                    valueFrom: {
                      secretKeyRef: {
                        name: 'platform-internal',
                        key: 'PLATFORM_INTERNAL_SECRET',
                        optional: true,
                      },
                    },
                  },
                ],
                securityContext: {
                  // SYS_ADMIN is required for the SFTP chroot jail bind mount.
                  // Drop ALL other capabilities to minimize blast radius.
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ['ALL'], add: ['SYS_ADMIN'] },
                },
                resources: {
                  requests: { cpu: '25m', memory: '32Mi' },
                  limits: { cpu: '100m', memory: '128Mi' },
                },
                volumeMounts: [
                  { name: 'client-storage', mountPath: '/data' },
                  { name: 'sftp-jail', mountPath: '/jail' },
                ],
                livenessProbe: {
                  httpGet: { path: '/health', port: FM_PORT },
                  initialDelaySeconds: 2,
                  periodSeconds: 10,
                },
                readinessProbe: {
                  httpGet: { path: '/health', port: FM_PORT },
                  initialDelaySeconds: 1,
                  periodSeconds: 3,
                },
              }],
              volumes: [
                {
                  name: 'client-storage',
                  persistentVolumeClaim: { claimName: `${namespace}-storage` },
                },
                {
                  name: 'sftp-jail',
                  emptyDir: { sizeLimit: '10Mi' },
                },
              ],
            },
          },
        },
      },
    };

  if (!deployExists) {
    await k8s.apps.createNamespacedDeployment(deployBody);
  } else {
    // Delete and recreate — K8s doesn't allow changing spec.selector on replace
    try {
      await k8s.apps.deleteNamespacedDeployment({ name: FM_NAME, namespace });
    } catch { /* best-effort cleanup */ }
    await k8s.apps.createNamespacedDeployment(deployBody);
  }

  // Ensure SFTP gateway has per-namespace exec permission (Role + RoleBinding).
  // This scopes pod/exec to THIS namespace only — no cluster-wide exec.
  const SFTP_EXEC_ROLE = 'sftp-gateway-exec';
  let roleExists = false;
  try {
    await k8s.rbac.readNamespacedRole({ name: SFTP_EXEC_ROLE, namespace });
    roleExists = true;
  } catch (err: unknown) {
    if (!isK8s404(err)) throw err;
  }
  if (!roleExists) {
    await k8s.rbac.createNamespacedRole({
      namespace,
      body: {
        metadata: { name: SFTP_EXEC_ROLE, namespace },
        rules: [{
          apiGroups: [''],
          resources: ['pods/exec'],
          verbs: ['create'],
        }],
      },
    });
    await k8s.rbac.createNamespacedRoleBinding({
      namespace,
      body: {
        metadata: { name: SFTP_EXEC_ROLE, namespace },
        roleRef: {
          apiGroup: 'rbac.authorization.k8s.io',
          kind: 'Role',
          name: SFTP_EXEC_ROLE,
        },
        subjects: [{
          kind: 'ServiceAccount',
          name: 'sftp-gateway',
          namespace: 'platform-system',
        }],
      },
    });
  }

  // Check if service exists
  let svcExists = false;
  try {
    await k8s.core.readNamespacedService({ name: FM_NAME, namespace });
    svcExists = true;
  } catch (err: unknown) {
    if (!isK8s404(err)) throw err;
  }

  if (!svcExists) {
    await k8s.core.createNamespacedService({
      namespace,
      body: {
        metadata: { name: FM_NAME, namespace, labels: FM_LABELS },
        spec: {
          selector: FM_LABELS,
          ports: [{ port: FM_PORT, targetPort: FM_PORT }],
        },
      },
    });
  }
}

/**
 * Delete the file-manager Deployment + Service.
 */
export async function stopFileManager(
  k8s: K8sClients,
  namespace: string,
): Promise<void> {
  try {
    await k8s.apps.deleteNamespacedDeployment({ name: FM_NAME, namespace });
  } catch (err: unknown) {
    if (!isK8s404(err)) throw err;
  }
  try {
    await k8s.core.deleteNamespacedService({ name: FM_NAME, namespace });
  } catch (err: unknown) {
    if (!isK8s404(err)) throw err;
  }
}

/**
 * Check if the file-manager pod is ready.
 */
export async function getFileManagerStatus(
  k8s: K8sClients,
  namespace: string,
): Promise<FileManagerStatus> {
  // Check deployment exists
  try {
    await k8s.apps.readNamespacedDeployment({ name: FM_NAME, namespace });
  } catch (err: unknown) {
    if (isK8s404(err)) return { ready: false, phase: 'not_deployed' };
    throw err;
  }

  // Check pod status
  const pods = await k8s.core.listNamespacedPod({
    namespace,
    labelSelector: `app=${FM_NAME}`,
  });

  const podList = (pods as { items?: Array<{ status?: { phase?: string; conditions?: Array<{ type?: string; status?: string }> } }> }).items ?? [];

  if (podList.length === 0) {
    return { ready: false, phase: 'starting', message: 'Pod is being created' };
  }

  const pod = podList[0];
  const phase = pod.status?.phase;
  const readyCondition = pod.status?.conditions?.find(
    (c: { type?: string; status?: string }) => c.type === 'Ready' && c.status === 'True'
  );

  if (readyCondition) {
    return { ready: true, phase: 'ready' };
  }

  if (phase === 'Failed') {
    return { ready: false, phase: 'failed', message: 'Pod failed to start' };
  }

  return { ready: false, phase: 'starting', message: `Pod phase: ${phase}` };
}
