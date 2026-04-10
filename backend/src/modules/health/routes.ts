import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import { runAllChecks } from './service.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';
import { clients } from '../../db/schema.js';

export async function healthRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);

  // GET /api/v1/admin/health — run all health checks
  app.get('/admin/health', {
    onRequest: [requireRole('super_admin', 'admin', 'read_only')],
  }, async () => {
    const encryptionKey = app.config?.OIDC_ENCRYPTION_KEY ?? process.env.OIDC_ENCRYPTION_KEY ?? '0'.repeat(64) /* Dev-only fallback — production requires OIDC_ENCRYPTION_KEY env var */;
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    let k8sCore;
    try {
      const k8s = createK8sClients(kubeconfigPath);
      k8sCore = k8s.core;
    } catch {
      // kubeconfig missing or invalid — checkKubernetes will report degraded
    }
    const result = await runAllChecks(app.db, encryptionKey, k8sCore);
    return success(result);
  });

  /**
   * IMAP Phase 6: GET /api/v1/admin/pods — list all pods across all
   * namespaces with a derived lifecycle classification:
   *
   *   running    — pod is Running with Ready=True
   *   pending    — pod is Pending (scheduling, image pull, etc.)
   *   failed     — pod has terminated with an error
   *   completed  — pod finished successfully (e.g. Job pods)
   *   orphaned   — pod is in a client-* namespace with no matching
   *                client row in the DB (the namespace leak scenario)
   *   unknown    — any other phase
   *
   * Also returns node capacity (pod allocatable vs pod count).
   * Requires admin / super_admin / read_only role.
   */
  app.get('/admin/pods', {
    onRequest: [requireRole('super_admin', 'admin', 'read_only')],
  }, async () => {
    const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
    let k8s;
    try {
      k8s = createK8sClients(kubeconfigPath);
    } catch {
      throw new ApiError(
        'K8S_UNAVAILABLE',
        'Kubernetes cluster is not reachable',
        503,
      );
    }

    // Fetch all pods and nodes in parallel
    const [podsResult, nodesResult] = await Promise.all([
      (k8s.core as unknown as {
        listPodForAllNamespaces: (args?: Record<string, unknown>) => Promise<{
          items: {
            metadata?: { name?: string; namespace?: string; creationTimestamp?: string; labels?: Record<string, string> };
            status?: {
              phase?: string;
              conditions?: { type: string; status: string }[];
              containerStatuses?: { ready?: boolean; restartCount?: number; state?: { waiting?: { reason?: string } } }[];
            };
            spec?: { nodeName?: string };
          }[];
        }>;
      }).listPodForAllNamespaces({}),
      (k8s.core as unknown as {
        listNode: (args?: Record<string, unknown>) => Promise<{
          items: {
            metadata?: { name?: string };
            status?: { allocatable?: { pods?: string }; capacity?: { pods?: string } };
          }[];
        }>;
      }).listNode({}),
    ]);

    // Build a set of known client namespaces from the DB for orphan
    // detection.
    const clientRows = await app.db
      .select({ ns: clients.kubernetesNamespace })
      .from(clients);
    const knownNamespaces = new Set(
      clientRows.map((r) => r.ns).filter(Boolean),
    );

    // Derive capacity from nodes
    let podCapacity = 0;
    let podAllocatable = 0;
    for (const node of nodesResult.items) {
      podCapacity += Number(node.status?.capacity?.pods ?? 0);
      podAllocatable += Number(node.status?.allocatable?.pods ?? 0);
    }

    // Classify pods
    const podList = podsResult.items.map((pod) => {
      const ns = pod.metadata?.namespace ?? '';
      const phase = pod.status?.phase ?? 'Unknown';
      const isClientNs = ns.startsWith('client-');
      const isOrphaned = isClientNs && !knownNamespaces.has(ns);

      // Ready check
      const readyCondition = pod.status?.conditions?.find(
        (c) => c.type === 'Ready',
      );
      const isReady = readyCondition?.status === 'True';

      // Waiting reason (for pending classification detail)
      const waitingReason = pod.status?.containerStatuses
        ?.find((cs) => cs.state?.waiting)
        ?.state?.waiting?.reason ?? null;

      let classification: string;
      if (isOrphaned) {
        classification = 'orphaned';
      } else if (phase === 'Running' && isReady) {
        classification = 'running';
      } else if (phase === 'Running' && !isReady) {
        classification = 'not_ready';
      } else if (phase === 'Pending') {
        classification = 'pending';
      } else if (phase === 'Succeeded') {
        classification = 'completed';
      } else if (phase === 'Failed') {
        classification = 'failed';
      } else {
        classification = 'unknown';
      }

      // Total restarts across containers
      const restarts = (pod.status?.containerStatuses ?? [])
        .reduce((sum, cs) => sum + (cs.restartCount ?? 0), 0);

      return {
        name: pod.metadata?.name ?? '',
        namespace: ns,
        phase,
        classification,
        isOrphaned,
        ready: isReady,
        restarts,
        waitingReason,
        node: pod.spec?.nodeName ?? null,
        age: pod.metadata?.creationTimestamp ?? null,
      };
    });

    // Count running pods (for the capacity tile)
    const runningCount = podList.filter(
      (p) => p.phase === 'Running' || p.phase === 'Pending',
    ).length;

    return success({
      capacity: {
        total: podCapacity,
        allocatable: podAllocatable,
        used: runningCount,
      },
      pods: podList,
    });
  });
}
