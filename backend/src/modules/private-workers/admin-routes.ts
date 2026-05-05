/**
 * Admin-panel routes for private-worker tunnel system settings.
 *
 *   GET  /api/v1/admin/private-workers/tunnel-settings
 *   PATCH /api/v1/admin/private-workers/tunnel-settings { issuer }
 *   GET  /api/v1/admin/private-workers/tunnel-status
 *
 * The issuer is the cert-manager ClusterIssuer name used on per-worker
 * tunnel Ingresses. Default is letsencrypt-prod-http01 (no DNS-API
 * required). Operators with a DNS-01 ClusterIssuer wired can flip to
 * that for one wildcard cert instead of N per-FQDN issuances.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { eq, sql } from 'drizzle-orm';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { ApiError } from '../../shared/errors.js';
import { success } from '../../shared/response.js';
import { platformSettings, privateWorkers } from '../../db/schema.js';
import { loadTunnelIssuer } from './reconciler.js';
import { createK8sClients } from '../k8s-provisioner/k8s-client.js';

const TUNNEL_ISSUER_KEY = 'private_worker_tunnel_issuer';
const DEFAULT_ISSUER = 'letsencrypt-prod-http01';

const updateSettingsSchema = z.object({
  issuer: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, 'issuer must be a valid Kubernetes resource name'),
});

interface ClusterIssuerSummary {
  readonly name: string;
  readonly ready: boolean;
  readonly type: 'http01' | 'dns01' | 'unknown';
}

interface TunnelStatus {
  readonly anchorCertReady: boolean;
  readonly anchorCertReason: string | null;
  readonly perWorkerCerts: {
    readonly issued: number;
    readonly pending: number;
    readonly failed: number;
  };
  readonly availableIssuers: ReadonlyArray<ClusterIssuerSummary>;
  readonly currentIssuer: string;
  readonly currentIssuerReady: boolean;
}

function classifyIssuerKind(spec: unknown): 'http01' | 'dns01' | 'unknown' {
  if (typeof spec !== 'object' || spec === null) return 'unknown';
  const acme = (spec as Record<string, unknown>).acme;
  if (typeof acme !== 'object' || acme === null) return 'unknown';
  const solvers = (acme as Record<string, unknown>).solvers;
  if (!Array.isArray(solvers)) return 'unknown';
  let hasDns = false;
  let hasHttp = false;
  for (const s of solvers) {
    if (typeof s !== 'object' || s === null) continue;
    if ('dns01' in s) hasDns = true;
    if ('http01' in s) hasHttp = true;
  }
  if (hasDns && !hasHttp) return 'dns01';
  if (hasHttp && !hasDns) return 'http01';
  return 'unknown';
}

async function listClusterIssuers(): Promise<ReadonlyArray<ClusterIssuerSummary>> {
  let k8s;
  try {
    k8s = createK8sClients();
  } catch {
    return [];
  }
  const customApi = k8s.custom;
  try {
    const list = (await customApi.listClusterCustomObject({
      group: 'cert-manager.io',
      version: 'v1',
      plural: 'clusterissuers',
    } as never)) as { items?: Array<{ metadata?: { name?: string }; spec?: unknown; status?: { conditions?: Array<{ type?: string; status?: string }> } }> };
    return (list.items ?? []).flatMap((item) => {
      const name = item.metadata?.name;
      if (!name) return [];
      const ready = (item.status?.conditions ?? []).some(
        (c) => c.type === 'Ready' && c.status === 'True',
      );
      return [{ name, ready, type: classifyIssuerKind(item.spec) }];
    });
  } catch {
    return [];
  }
}

async function getAnchorCertStatus(): Promise<{ ready: boolean; reason: string | null }> {
  let k8s;
  try {
    k8s = createK8sClients();
  } catch {
    return { ready: false, reason: 'k8s client unavailable' };
  }
  try {
    const cert = (await k8s.custom.getNamespacedCustomObject({
      group: 'cert-manager.io',
      version: 'v1',
      namespace: 'platform-system',
      plural: 'certificates',
      name: 'tunnels-platform-domain',
    } as never)) as { status?: { conditions?: Array<{ type?: string; status?: string; reason?: string; message?: string }> } };
    const conditions = cert.status?.conditions ?? [];
    const readyCond = conditions.find((c) => c.type === 'Ready');
    return {
      ready: readyCond?.status === 'True',
      reason: readyCond?.message ?? readyCond?.reason ?? null,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ready: false, reason: msg.includes('not found') ? 'Certificate CR not yet created' : msg };
  }
}

async function getPerWorkerCertCounts(): Promise<{ issued: number; pending: number; failed: number }> {
  let k8s;
  try {
    k8s = createK8sClients();
  } catch {
    return { issued: 0, pending: 0, failed: 0 };
  }
  try {
    const list = (await k8s.custom.listNamespacedCustomObject({
      group: 'cert-manager.io',
      version: 'v1',
      namespace: 'platform-system',
      plural: 'certificates',
      labelSelector: 'app.kubernetes.io/managed-by=platform-api',
    } as never)) as { items?: Array<{ metadata?: { name?: string }; status?: { conditions?: Array<{ type?: string; status?: string; reason?: string }> } }> };
    let issued = 0; let pending = 0; let failed = 0;
    for (const c of list.items ?? []) {
      // Only count tunnel certs (named tunnel-*-tls in our reconciler).
      const name = c.metadata?.name ?? '';
      if (!name.startsWith('tunnel-')) continue;
      const conds = c.status?.conditions ?? [];
      const ready = conds.find((cc) => cc.type === 'Ready');
      const issuing = conds.find((cc) => cc.type === 'Issuing');
      if (ready?.status === 'True') issued++;
      else if (issuing?.status === 'True') pending++;
      else failed++;
    }
    return { issued, pending, failed };
  } catch {
    return { issued: 0, pending: 0, failed: 0 };
  }
}

export async function privateWorkerAdminRoutes(app: FastifyInstance): Promise<void> {
  // Same chain as backend/src/modules/admin-users/routes.ts: authenticate
  // first, then gate by staff roles. The platform's role enum is
  // ['super_admin','admin','support','read_only','client_admin','client_user']
  // — we accept the two staff roles that have admin-panel write access.
  app.addHook('onRequest', authenticate);
  app.addHook('onRequest', requireRole('super_admin', 'admin'));

  app.get('/admin/private-workers/tunnel-settings', async () => {
    const issuer = await loadTunnelIssuer(app.db);
    return success({ issuer });
  });

  app.patch('/admin/private-workers/tunnel-settings', async (request) => {
    const parsed = updateSettingsSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ApiError('VALIDATION_ERROR', parsed.error.issues[0]?.message ?? 'invalid', 400);
    }
    const { issuer } = parsed.data;
    await app.db
      .insert(platformSettings)
      .values({ key: TUNNEL_ISSUER_KEY, value: issuer })
      .onConflictDoUpdate({ target: platformSettings.key, set: { value: issuer } });
    return success({ issuer });
  });

  app.get('/admin/private-workers/tunnel-status', async () => {
    const [issuer, availableIssuers, anchorCert, perWorkerCerts, workerCount] = await Promise.all([
      loadTunnelIssuer(app.db),
      listClusterIssuers(),
      getAnchorCertStatus(),
      getPerWorkerCertCounts(),
      app.db
        .select({ count: sql<number>`count(*)::int` })
        .from(privateWorkers)
        .where(eq(privateWorkers.status, 'active'))
        .then((rows) => rows[0]?.count ?? 0),
    ]);
    const currentIssuer = issuer || DEFAULT_ISSUER;
    const currentIssuerReady = availableIssuers.some(
      (i) => i.name === currentIssuer && i.ready,
    );
    const status: TunnelStatus = {
      anchorCertReady: anchorCert.ready,
      anchorCertReason: anchorCert.reason,
      perWorkerCerts,
      availableIssuers,
      currentIssuer,
      currentIssuerReady,
    };
    return success({ ...status, activeWorkerCount: workerCount });
  });
}
