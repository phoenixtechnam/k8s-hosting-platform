import { eq, sql } from 'drizzle-orm';
import type { Database } from '../../db/index.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import { clients, clusterNodes } from '../../db/schema.js';
import { ApiError } from '../../shared/errors.js';

// M6: minimal tenant migration between workers.
//
// Flow:
//   1. Validate the target worker (must exist in cluster_nodes and
//      carry canHostClientWorkloads=true).
//   2. Flip clients.worker_node_name in the DB so future Deployment
//      creates pick the new pin (via M5 plumbing).
//   3. Trigger a rollout-restart on every tenant Deployment in the
//      client's namespace so the scheduler re-evaluates with the
//      new nodeSelector.
//
// Not yet covered (out of M6 scope — future revisit):
//   - PVC data migration across nodes. Longhorn with replicaCount=1
//     stays on the original node; access from the new worker is
//     cross-node block I/O (functional but slower). Real migration
//     needs a snapshot+restore flow against the new node's disk.
//   - DNS record updates. PowerDNS lives in a separate project
//     (ADR-022); the admin runs the DNS update manually for now.
//   - Progress tracking via provisioning_tasks. Current flow is
//     synchronous — the request holds open until all rollouts are
//     triggered. For large tenants that's fine (Deployments don't
//     wait for ready; kubectl just patches the annotation).

async function rolloutRestart(k8s: K8sClients, namespace: string): Promise<number> {
  let count = 0;
  const now = new Date().toISOString();

  const res = await k8s.apps.listNamespacedDeployment({ namespace });
  for (const deploy of res.items ?? []) {
    const name = deploy.metadata?.name;
    if (!name) continue;
    // kubectl rollout restart = patch the pod template with a fresh
    // annotation, which forces a new ReplicaSet and rescheduling.
    await k8s.apps.patchNamespacedDeployment({
      name,
      namespace,
      body: {
        spec: {
          template: {
            metadata: {
              annotations: {
                'platform.phoenix-host.net/restarted-at': now,
              },
            },
          },
        },
      },
      contentType: 'application/strategic-merge-patch+json',
    } as unknown as Parameters<typeof k8s.apps.patchNamespacedDeployment>[0]);
    count += 1;
  }
  return count;
}

export interface MigrateToWorkerInput {
  readonly workerNodeName: string;
}

export interface MigrateToWorkerResult {
  readonly clientId: string;
  readonly previousWorker: string | null;
  readonly currentWorker: string;
  readonly deploymentsRestarted: number;
}

export async function migrateClientToWorker(
  db: Database,
  k8s: K8sClients,
  clientId: string,
  input: MigrateToWorkerInput,
): Promise<MigrateToWorkerResult> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) {
    throw new ApiError('CLIENT_NOT_FOUND', `Client '${clientId}' not found`, 404, { client_id: clientId });
  }

  const [targetNode] = await db.select()
    .from(clusterNodes)
    .where(eq(clusterNodes.name, input.workerNodeName))
    .limit(1);
  if (!targetNode) {
    throw new ApiError('NODE_NOT_FOUND', `Node '${input.workerNodeName}' not found`, 404, { node_name: input.workerNodeName });
  }
  if (!targetNode.canHostClientWorkloads) {
    throw new ApiError(
      'NODE_NOT_TENANT_CAPABLE',
      `Node '${input.workerNodeName}' is not tenant-capable (host_client_workloads=false).`,
      409,
      { node_name: input.workerNodeName },
    );
  }

  const previousWorker = client.workerNodeName ?? null;

  await db.update(clients)
    .set({ workerNodeName: input.workerNodeName, updatedAt: sql`NOW()` })
    .where(eq(clients.id, clientId));

  const deploymentsRestarted = await rolloutRestart(k8s, client.kubernetesNamespace);

  return {
    clientId,
    previousWorker,
    currentWorker: input.workerNodeName,
    deploymentsRestarted,
  };
}
