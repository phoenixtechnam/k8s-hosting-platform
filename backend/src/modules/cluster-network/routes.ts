/**
 * Cluster network admin routes.
 *
 * All routes are super_admin only. Cluster-scoped firewall trust is the
 * highest-blast-radius surface in the platform — a misconfigured
 * trusted_ranges entry could open ports to the public internet, and a
 * malicious pending peer could let an attacker join the cluster as a
 * worker. Keep the gate tight.
 *
 * Audit logging:
 *   - All write operations log the requester sub + the resource name
 *     at WARN level so operators can trace policy changes.
 *   - addedBy on CTR/CPP is set from req.user.sub, never client-supplied.
 *
 *   GET    /admin/cluster/trusted-ranges
 *   POST   /admin/cluster/trusted-ranges
 *   PATCH  /admin/cluster/trusted-ranges/:name  description-only
 *   DELETE /admin/cluster/trusted-ranges/:name
 *   GET    /admin/cluster/pending-peers
 *   POST   /admin/cluster/pending-peers
 *   DELETE /admin/cluster/pending-peers/:name
 *   GET    /admin/cluster/bootstrap-command/:name
 *
 * Node listing is served by the existing /admin/nodes API. Phase 6
 * (PRIVATE NODE) will add exposure-toggle there alongside the
 * scheduler + firewall-chain changes.
 */

import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { success } from '../../shared/response.js';
import { ApiError } from '../../shared/errors.js';
import {
  createTrustedRangeRequestSchema,
  updateTrustedRangeRequestSchema,
  createPendingPeerRequestSchema,
} from '@k8s-hosting/api-contracts';
import {
  listTrustedRanges,
  createTrustedRange,
  updateTrustedRangeDescription,
  deleteTrustedRange,
} from './cluster-trusted-ranges.js';
import {
  listPendingPeers,
  createPendingPeer,
  deletePendingPeer,
} from './cluster-pending-peers.js';
import { generateBootstrapCommand } from './bootstrap-command.js';
import { setNodeExposure, setNodeExposureRequestSchema } from './node-exposure.js';

interface AuthedRequest {
  readonly body?: unknown;
  readonly params?: unknown;
  readonly user?: { readonly sub?: string };
}

function userOf(req: AuthedRequest): string {
  return req.user?.sub ?? 'unknown';
}

function paramName(req: AuthedRequest): string {
  const p = (req.params ?? {}) as { name?: unknown };
  if (typeof p.name !== 'string' || p.name.length === 0) {
    throw new ApiError('VALIDATION_ERROR', 'name path parameter required', 400);
  }
  return p.name;
}

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issues = parsed.error.issues;
    throw new ApiError(
      'VALIDATION_ERROR',
      issues
        .map((i) => `${i.path.map(String).join('.')}: ${i.message}`)
        .join(', ') || 'invalid request body',
      400,
    );
  }
  return parsed.data;
}

export async function clusterNetworkRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onRequest', authenticate);
  const cfg = app.config as Record<string, unknown>;
  const k8sOpts = { kubeconfigPath: cfg.KUBECONFIG_PATH as string | undefined };
  const platformDomain = (cfg.PLATFORM_DOMAIN as string | undefined) ?? undefined;

  // ─── Trusted ranges ─────────────────────────────────────────────────
  app.get(
    '/admin/cluster/trusted-ranges',
    { preHandler: requireRole('super_admin') },
    async () => {
      const data = await listTrustedRanges(k8sOpts);
      return success({ data });
    },
  );

  app.post(
    '/admin/cluster/trusted-ranges',
    { preHandler: requireRole('super_admin') },
    async (req: AuthedRequest) => {
      const body = parseOrThrow(createTrustedRangeRequestSchema, req.body);
      const userId = userOf(req);
      app.log.warn({ userId, name: body.name, cidr: body.cidr }, 'cluster-network: trusted-range create');
      const range = await createTrustedRange(body, userId, k8sOpts);
      return success(range);
    },
  );

  app.patch<{ Params: { name: string } }>(
    '/admin/cluster/trusted-ranges/:name',
    { preHandler: requireRole('super_admin') },
    async (req: AuthedRequest) => {
      const name = paramName(req);
      const body = parseOrThrow(updateTrustedRangeRequestSchema, req.body);
      const userId = userOf(req);
      app.log.warn({ userId, name }, 'cluster-network: trusted-range update');
      const range = await updateTrustedRangeDescription(name, body, k8sOpts);
      return success(range);
    },
  );

  app.delete<{ Params: { name: string } }>(
    '/admin/cluster/trusted-ranges/:name',
    { preHandler: requireRole('super_admin') },
    async (req: AuthedRequest) => {
      const name = paramName(req);
      const userId = userOf(req);
      app.log.warn({ userId, name }, 'cluster-network: trusted-range delete');
      await deleteTrustedRange(name, k8sOpts);
      return success({ deleted: name });
    },
  );

  // ─── Pending peers ──────────────────────────────────────────────────
  app.get(
    '/admin/cluster/pending-peers',
    { preHandler: requireRole('super_admin') },
    async () => {
      const data = await listPendingPeers(k8sOpts);
      return success({ data });
    },
  );

  app.post(
    '/admin/cluster/pending-peers',
    { preHandler: requireRole('super_admin') },
    async (req: AuthedRequest) => {
      const body = parseOrThrow(createPendingPeerRequestSchema, req.body);
      const userId = userOf(req);
      app.log.warn({ userId, name: body.name, ip: body.ip, role: body.role }, 'cluster-network: pending-peer create');
      const peer = await createPendingPeer(body, userId, k8sOpts);
      return success(peer);
    },
  );

  app.delete<{ Params: { name: string } }>(
    '/admin/cluster/pending-peers/:name',
    { preHandler: requireRole('super_admin') },
    async (req: AuthedRequest) => {
      const name = paramName(req);
      const userId = userOf(req);
      app.log.warn({ userId, name }, 'cluster-network: pending-peer delete');
      await deletePendingPeer(name, k8sOpts);
      return success({ deleted: name });
    },
  );

  // ─── Bootstrap command ──────────────────────────────────────────────
  app.get<{ Params: { name: string } }>(
    '/admin/cluster/bootstrap-command/:name',
    { preHandler: requireRole('super_admin') },
    async (req: AuthedRequest) => {
      const name = paramName(req);
      const cmd = await generateBootstrapCommand(name, {
        ...k8sOpts,
        domain: platformDomain,
      });
      return success(cmd);
    },
  );

  // ─── Node exposure (Phase 6 PRIVATE NODE) ────────────────────────────
  // Flips the platform.phoenix-host.net/exposure label on a Node.
  // Drives ingress-nginx + cert-manager solver scheduler affinity
  // (manifest-side); a future Phase 6.5 will add reconciler firewall-
  // chain drops on private nodes for workload ports.
  app.patch<{ Params: { name: string } }>(
    '/admin/cluster/nodes/:name/exposure',
    { preHandler: requireRole('super_admin') },
    async (req: AuthedRequest) => {
      const name = paramName(req);
      const body = parseOrThrow(setNodeExposureRequestSchema, req.body);
      const userId = userOf(req);
      app.log.warn(
        { userId, name, exposure: body.exposure },
        'cluster-network: node exposure toggle',
      );
      const result = await setNodeExposure(name, body, userId, k8sOpts);
      return success(result);
    },
  );
}
