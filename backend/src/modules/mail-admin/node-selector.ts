/**
 * Stalwart mail server node selector — read + patch.
 *
 * When using CIFS BlobStore, Stalwart MUST run on the node where the
 * CIFS share is mounted (the kernel CIFS mount is per-node and exposed
 * as a hostPath volume). This module lets operators pin the Stalwart
 * pod to a specific node via nodeAffinity on the Deployment.
 *
 * Three modes:
 *   'any'       — no nodeAffinity (let the scheduler decide)
 *   'preferred' — preferredDuringSchedulingIgnoredDuringExecution
 *                 (soft pin; pod may land elsewhere if node is full)
 *   'required'  — requiredDuringSchedulingIgnoredDuringExecution
 *                 (hard pin; pod stays pending until node is ready)
 *
 * GET  /admin/mail/node-selector  → MailNodeSelectorResponse
 * PATCH /admin/mail/node-selector → MailNodeSelectorResponse
 */

import { ApiError } from '../../shared/errors.js';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';
import {
  type MailNodeSelectorResponse,
  type MailNodeSelectorUpdate,
  mailNodeSelectorResponseSchema,
} from '@k8s-hosting/api-contracts';

const MAIL_NAMESPACE = 'mail';
const STALWART_DEPLOYMENT = 'stalwart-mail';
const STALWART_POD_LABEL = 'app.kubernetes.io/name=stalwart';
const HOSTNAME_LABEL_KEY = 'kubernetes.io/hostname';

export interface NodeSelectorOptions {
  readonly kubeconfigPath: string | undefined;
}

// ── Thin shapes for k8s API responses ──────────────────────────────────────

interface MatchExpression {
  key: string;
  operator: string;
  values?: string[];
}

interface NodeSelectorTerm {
  matchExpressions?: MatchExpression[];
}

interface PreferredSchedulingTerm {
  weight: number;
  preference: {
    matchExpressions?: MatchExpression[];
  };
}

interface NodeAffinityShape {
  requiredDuringSchedulingIgnoredDuringExecution?: {
    nodeSelectorTerms?: NodeSelectorTerm[];
  };
  preferredDuringSchedulingIgnoredDuringExecution?: PreferredSchedulingTerm[];
}

interface DeploymentShape {
  spec?: {
    template?: {
      spec?: {
        nodeAffinity?: NodeAffinityShape;
      };
    };
  };
}

interface PodShape {
  spec?: {
    nodeName?: string;
  };
}

interface PodListShape {
  items?: PodShape[];
}

interface K8sClientsBundle {
  core: import('@kubernetes/client-node').CoreV1Api;
  apps: import('@kubernetes/client-node').AppsV1Api;
}

async function loadK8sClients(kubeconfigPath: string | undefined): Promise<K8sClientsBundle> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract the configured nodeName + mode from a nodeAffinity object.
 * Returns { mode: 'any', nodeName: null } when nodeAffinity is absent
 * or does not contain a hostname matchExpression in the expected slot.
 */
function parseNodeAffinity(
  nodeAffinity: NodeAffinityShape | null | undefined,
): { mode: 'any' | 'preferred' | 'required'; nodeName: string | null } {
  if (!nodeAffinity) {
    return { mode: 'any', nodeName: null };
  }

  // required path
  const requiredTerm =
    nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution?.nodeSelectorTerms?.[0];
  if (requiredTerm) {
    const expr = requiredTerm.matchExpressions?.find(
      (e) => e.key === HOSTNAME_LABEL_KEY && e.operator === 'In',
    );
    if (expr?.values?.[0]) {
      return { mode: 'required', nodeName: expr.values[0] };
    }
  }

  // preferred path
  const preferredTerm =
    nodeAffinity.preferredDuringSchedulingIgnoredDuringExecution?.[0];
  if (preferredTerm) {
    const expr = preferredTerm.preference.matchExpressions?.find(
      (e) => e.key === HOSTNAME_LABEL_KEY && e.operator === 'In',
    );
    if (expr?.values?.[0]) {
      return { mode: 'preferred', nodeName: expr.values[0] };
    }
  }

  return { mode: 'any', nodeName: null };
}

/**
 * Build the nodeAffinity patch body for a given mode + nodeName.
 * Passing `null` for nodeAffinity removes the field (merge-patch
 * semantics — strategic-merge also honours null as a delete for
 * well-known fields in v1 Deployment).
 */
function buildNodeAffinityPatch(
  update: MailNodeSelectorUpdate,
): NodeAffinityShape | null {
  const { mode, nodeName } = update;

  if (mode === 'any' || !nodeName) {
    return null;
  }

  if (mode === 'preferred') {
    return {
      preferredDuringSchedulingIgnoredDuringExecution: [
        {
          weight: 100,
          preference: {
            matchExpressions: [
              {
                key: HOSTNAME_LABEL_KEY,
                operator: 'In',
                values: [nodeName],
              },
            ],
          },
        },
      ],
    };
  }

  // mode === 'required'
  return {
    requiredDuringSchedulingIgnoredDuringExecution: {
      nodeSelectorTerms: [
        {
          matchExpressions: [
            {
              key: HOSTNAME_LABEL_KEY,
              operator: 'In',
              values: [nodeName],
            },
          ],
        },
      ],
    },
  };
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Read the current nodeAffinity setting from the Stalwart Deployment
 * and the live pod's scheduled node from the running pod.
 */
export async function getMailNodeSelector(
  opts: NodeSelectorOptions,
): Promise<MailNodeSelectorResponse> {
  const { core, apps } = await loadK8sClients(opts.kubeconfigPath);

  let deployment: DeploymentShape;
  try {
    deployment = (await apps.readNamespacedDeployment({
      namespace: MAIL_NAMESPACE,
      name: STALWART_DEPLOYMENT,
    })) as DeploymentShape;
  } catch (err) {
    const code =
      (err as { statusCode?: number; code?: number }).statusCode ??
      (err as { code?: number }).code;
    if (code === 404) {
      throw new ApiError(
        'MAIL_NODE_SELECTOR_READ_FAILED',
        `Deployment ${MAIL_NAMESPACE}/${STALWART_DEPLOYMENT} not found`,
        503,
      );
    }
    throw new ApiError(
      'MAIL_NODE_SELECTOR_READ_FAILED',
      `Could not read Stalwart Deployment: ${(err as Error).message ?? String(err)}`,
      503,
    );
  }

  const nodeAffinity =
    deployment.spec?.template?.spec?.nodeAffinity ?? null;
  const { mode, nodeName } = parseNodeAffinity(nodeAffinity);

  // Read the live pod's scheduled node — best-effort, falls back to null.
  let currentNode: string | null = null;
  try {
    const pods = (await core.listNamespacedPod({
      namespace: MAIL_NAMESPACE,
      labelSelector: STALWART_POD_LABEL,
      limit: 1,
    } as unknown as Parameters<typeof core.listNamespacedPod>[0])) as PodListShape;
    currentNode = pods.items?.[0]?.spec?.nodeName ?? null;
  } catch {
    // Best-effort — a missing pod is fine; operator just sees null.
  }

  return mailNodeSelectorResponseSchema.parse({ mode, nodeName, currentNode });
}

/**
 * Patch the Stalwart Deployment's nodeAffinity and return the new state.
 *
 * Validates the target node exists in k8s before patching (unless
 * mode='any', which clears the affinity entirely).
 */
export async function updateMailNodeSelector(
  update: MailNodeSelectorUpdate,
  opts: NodeSelectorOptions,
): Promise<MailNodeSelectorResponse> {
  const { core, apps } = await loadK8sClients(opts.kubeconfigPath);

  // Validate node exists when a specific node is requested.
  if (update.mode !== 'any' && update.nodeName) {
    try {
      await core.readNode({ name: update.nodeName });
    } catch (err) {
      const code =
        (err as { statusCode?: number; code?: number }).statusCode ??
        (err as { code?: number }).code;
      if (code === 404) {
        throw new ApiError(
          'MAIL_NODE_NOT_FOUND',
          `Node '${update.nodeName}' does not exist in the cluster`,
          404,
        );
      }
      // For other errors, surface as a patch-failed since the patch
      // would likely fail too.
      throw new ApiError(
        'MAIL_NODE_SELECTOR_PATCH_FAILED',
        `Could not verify node '${update.nodeName}': ${(err as Error).message ?? String(err)}`,
        500,
      );
    }
  }

  const nodeAffinity = buildNodeAffinityPatch(update);

  try {
    await apps.patchNamespacedDeployment(
      {
        namespace: MAIL_NAMESPACE,
        name: STALWART_DEPLOYMENT,
        body: {
          spec: {
            template: {
              spec: {
                nodeAffinity,
              },
            },
          },
        },
      } as unknown as Parameters<typeof apps.patchNamespacedDeployment>[0],
      STRATEGIC_MERGE_PATCH,
    );
  } catch (err) {
    throw new ApiError(
      'MAIL_NODE_SELECTOR_PATCH_FAILED',
      `Failed to patch Stalwart Deployment nodeAffinity: ${(err as Error).message ?? String(err)}`,
      500,
    );
  }

  // Return the freshly read state so the response reflects what k8s
  // accepted, not just what we sent.
  return getMailNodeSelector(opts);
}
