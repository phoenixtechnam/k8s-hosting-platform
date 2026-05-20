/**
 * Cluster-trusted-proxies admin routes.
 *
 *   GET    /admin/cluster-network/trusted-proxies      list rows + status
 *   POST   /admin/cluster-network/trusted-proxies      add operator row
 *   DELETE /admin/cluster-network/trusted-proxies/:id  remove operator row
 *
 * All super_admin only. POST + DELETE fire an inline reconcile (not
 * awaited) so the API response stays fast but the operator sees the
 * effect within seconds.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import * as k8s from '@kubernetes/client-node';
import {
  createTrustedProxyRangeRequestSchema,
  type ListTrustedProxyRangesResponse,
} from '@k8s-hosting/api-contracts';
import { authenticate, requirePanel, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import type { Database } from '../../db/index.js';
import {
  createRange,
  deleteRange,
  listAllRanges,
  listMaterialisedCidrs,
} from './service.js';
import {
  countPanelPodsRolled,
  renderHash,
  renderTraefikCsv,
} from './reconciler.js';
import { runReconcileExclusive } from './scheduler.js';

interface AuthedRequest {
  readonly user?: { readonly sub?: string };
}

export interface ClusterTrustedProxiesDeps {
  readonly db: Database;
}

function loadK8sClients(kubeconfigPath: string | undefined): {
  core: k8s.CoreV1Api;
  apps: k8s.AppsV1Api;
} {
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) {
    kc.loadFromFile(kubeconfigPath);
  } else {
    kc.loadFromCluster();
  }
  return {
    core: kc.makeApiClient(k8s.CoreV1Api),
    apps: kc.makeApiClient(k8s.AppsV1Api),
  };
}

export function buildClusterTrustedProxiesRoutes(
  deps: ClusterTrustedProxiesDeps,
) {
  return async function clusterTrustedProxiesRoutes(
    app: FastifyInstance,
  ): Promise<void> {
    app.addHook('onRequest', authenticate);
    const cfg = app.config as Record<string, unknown>;
    const kubeconfigPath = cfg.KUBECONFIG_PATH as string | undefined;

    // ─── GET — list all ranges + reconciler status + roll progress ──────
    app.get(
      '/admin/cluster-network/trusted-proxies',
      { preHandler: [requirePanel('admin'), requireRole('super_admin')] },
      async () => {
        const ranges = await listAllRanges(deps.db);
        // Use the SAME query the reconciler uses (listMaterialisedCidrs)
        // so the hash here matches the hash the reconciler writes to
        // the ConfigMap. Two queries against the same DB rows can drift
        // in ordering if either side adds a JOIN or filter — this
        // explicit call makes the invariant load-bearing rather than
        // implicit-via-renderTraefikCsv's sort.
        const materialised = await listMaterialisedCidrs(deps.db);
        const csv = renderTraefikCsv(materialised);
        const hash = renderHash(csv);

        let panelsRolled = 0;
        let panelsTotal = 0;
        try {
          const clients = loadK8sClients(kubeconfigPath);
          const r = await countPanelPodsRolled(
            clients.apps,
            clients.core,
            hash,
            app.log,
          );
          panelsRolled = r.rolled;
          panelsTotal = r.total;
        } catch (err) {
          app.log.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'cluster-trusted-proxies: status read failed',
          );
        }

        const response: ListTrustedProxyRangesResponse = {
          ranges: ranges.map((r) => ({
            id: r.id,
            cidr: r.cidr,
            description: r.description,
            source: r.source,
            createdAt: r.createdAt ? r.createdAt.toISOString() : null,
            createdByEmail: r.createdByEmail,
          })),
          lastReconciledAt: null, // future: persist last-reconciled timestamp
          lastReconcileError: null,
          panelPodsRolled: panelsRolled,
          panelPodsTotal: panelsTotal,
        };
        return success(response);
      },
    );

    // ─── POST — add operator row + inline reconcile ─────────────────────
    app.post(
      '/admin/cluster-network/trusted-proxies',
      { preHandler: [requirePanel('admin'), requireRole('super_admin')] },
      async (req: FastifyRequest, reply: FastifyReply) => {
        const parsed = createTrustedProxyRangeRequestSchema.safeParse(
          req.body ?? {},
        );
        if (!parsed.success) {
          return reply.status(400).send({
            error: 'INVALID_BODY',
            message: parsed.error.issues
              .map((i) => `${i.path.join('.')}: ${i.message}`)
              .join('; '),
          });
        }
        const actor = (req as AuthedRequest).user?.sub ?? null;
        try {
          await createRange(deps.db, {
            cidr: parsed.data.cidr,
            description: parsed.data.description,
            source: 'operator',
            createdBy: actor,
          });
        } catch (err) {
          const e = err as Error & { code?: string };
          if (e.code === 'DUPLICATE_CIDR') {
            return reply.status(409).send({
              error: 'DUPLICATE_CIDR',
              message: e.message,
            });
          }
          app.log.warn({ err }, 'cluster-trusted-proxies: create failed');
          // Generic message — raw DB / Drizzle / k8s errors can leak
          // table names, constraint names, and query fragments.
          return reply.status(500).send({
            error: 'CREATE_FAILED',
            message: 'An internal error occurred; see server logs for details.',
          });
        }
        // Fire-and-forget reconcile. Errors logged inside reconciler.
        setImmediate(() => {
          void fireInlineReconcile(deps.db, kubeconfigPath, app.log);
        });
        return success({ ok: true });
      },
    );

    // ─── DELETE — remove operator row + inline reconcile ────────────────
    app.delete(
      '/admin/cluster-network/trusted-proxies/:id',
      { preHandler: [requirePanel('admin'), requireRole('super_admin')] },
      async (req: FastifyRequest, reply: FastifyReply) => {
        const { id } = (req.params ?? {}) as { id?: string };
        if (!id || !/^[0-9a-f-]{36}$/i.test(id)) {
          return reply.status(400).send({
            error: 'INVALID_ID',
            message: 'id must be a UUID',
          });
        }
        try {
          await deleteRange(deps.db, id);
        } catch (err) {
          const e = err as Error & { code?: string };
          if (e.code === 'NOT_DELETABLE') {
            return reply.status(404).send({
              error: 'NOT_DELETABLE',
              message: e.message,
            });
          }
          app.log.warn({ err, id }, 'cluster-trusted-proxies: delete failed');
          return reply.status(500).send({
            error: 'DELETE_FAILED',
            message: 'An internal error occurred; see server logs for details.',
          });
        }
        setImmediate(() => {
          void fireInlineReconcile(deps.db, kubeconfigPath, app.log);
        });
        return success({ ok: true });
      },
    );
  };
}

async function fireInlineReconcile(
  db: Database,
  kubeconfigPath: string | undefined,
  log: Pick<import('pino').Logger, 'info' | 'warn' | 'error'>,
): Promise<void> {
  try {
    const clients = loadK8sClients(kubeconfigPath);
    // Goes through the module-level exclusive runner so concurrent
    // ticks (scheduler + inline) collapse into a single reconcile.
    // Prevents Traefik DS JSON-patch index races (HIGH #1 from code review).
    await runReconcileExclusive(db, clients, log);
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      'cluster-trusted-proxies: inline reconcile failed',
    );
  }
}
