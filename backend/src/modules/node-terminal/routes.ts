import type { FastifyInstance, FastifyRequest } from 'fastify';
import os from 'node:os';
import * as k8s from '@kubernetes/client-node';
import { ApiError, invalidToken } from '../../shared/errors.js';
import { authenticate, requirePanel, requireRole, type JwtPayload } from '../../middleware/auth.js';
import { createKubeConfig } from '../container-console/service.js';
import {
  createSession,
  attachExec,
  terminateSession,
  NODE_TERMINAL_IDLE_MS,
  type ServiceCtx,
} from './service.js';
import { listSessions, listSessionsForNode } from './session-registry.js';
import { eq } from 'drizzle-orm';
import { users } from '../../db/schema.js';

// RFC-1123 DNS subdomain label with dots — matches k8s' own node-name
// validation. Shared with backend/src/modules/nodes/routes.ts.
const NODE_NAME_REGEX = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

function validateNodeName(name: string): void {
  if (!NODE_NAME_REGEX.test(name)) {
    throw new ApiError('INVALID_FIELD_VALUE', 'Invalid node name', 400, { field: 'nodeName' });
  }
}

/**
 * Resolve the public wss origin to embed in the websocketUrl.
 *
 * Security finding H2: a naive X-Forwarded-Host lookup is attacker-
 * controllable — even a privileged super_admin who is being phished
 * could be tricked into receiving a wsUrl that points at attacker.example.com.
 *
 * Resolution order:
 *   1. PLATFORM_WSS_ORIGIN env var (preferred in prod) — overrides all.
 *   2. The Host header validated against an allowlist:
 *        - app.config.CORS_ORIGINS (already validated at startup)
 *        - app.config.PLATFORM_PUBLIC_HOSTS (CSV) when set explicitly
 *      The Host header is what Fastify parsed from the request, with
 *      trustProxy honouring XFH only when the proxy was authenticated.
 *      We further constrain it to known-good hostnames.
 *   3. Fallback to `wss://<request.hostname>` only when CORS_ORIGINS is
 *      empty (dev / DinD).
 */
function publicWssOrigin(request: FastifyRequest, app: FastifyInstance): string {
  const cfg = app.config as Record<string, unknown>;
  const env = cfg.PLATFORM_WSS_ORIGIN as string | undefined;
  if (env) return env;

  const allowlist = new Set<string>();
  const corsOrigins = cfg.CORS_ORIGINS as string | undefined;
  if (corsOrigins) {
    for (const origin of corsOrigins.split(',')) {
      try {
        const u = new URL(origin.trim());
        if (u.hostname) allowlist.add(u.hostname.toLowerCase());
      } catch { /* ignore malformed */ }
    }
  }
  const extraHosts = cfg.PLATFORM_PUBLIC_HOSTS as string | undefined;
  if (extraHosts) {
    for (const host of extraHosts.split(',')) {
      const h = host.trim().toLowerCase();
      if (h) allowlist.add(h);
    }
  }

  // request.hostname is Fastify's parsed Host header. trustProxy honours
  // XFH from a trusted proxy, but we no longer trust that value blindly.
  const candidate = (request.hostname ?? '').toLowerCase().split(':')[0];

  if (allowlist.size > 0) {
    if (!allowlist.has(candidate)) {
      throw new ApiError(
        'PLATFORM_HOST_UNALLOWED',
        'Refusing to construct a node-terminal WS URL for an unrecognised host. Set PLATFORM_WSS_ORIGIN or PLATFORM_PUBLIC_HOSTS to allow this host.',
        500,
      );
    }
  }
  // Preserve port from the actual request. Fastify's `request.hostname`
  // drops the port; pull it from the raw Host header instead (and from
  // X-Forwarded-Port via trustProxy when present). DinD listens on
  // :2011 — without this the constructed wsUrl points at the standard
  // :443 which the ingress doesn't serve.
  const hostHeader = request.headers['x-forwarded-host'] ?? request.headers.host;
  const hostStr = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;
  const portFromHost = (hostStr ?? '').match(/:(\d+)$/)?.[1];
  const portFromXf = request.headers['x-forwarded-port'];
  const port = portFromHost
    ?? (typeof portFromXf === 'string' ? portFromXf : Array.isArray(portFromXf) ? portFromXf[0] : '');
  return `wss://${candidate}${port ? ':' + port : ''}`;
}

function makeServiceCtx(app: FastifyInstance): ServiceCtx {
  const kubeconfigPath = (app.config as Record<string, unknown>).KUBECONFIG_PATH as string | undefined;
  const kc = createKubeConfig(kubeconfigPath);
  const coreApi = kc.makeApiClient(k8s.CoreV1Api);
  return {
    db: app.db,
    kubeConfig: kc,
    k8sCoreApi: coreApi,
    // PLATFORM_API_REPLICA_HOST is the Pod's hostname for sticky-session
    // anchoring; fall back to os.hostname() for dev / single-replica.
    replicaHost: (app.config as Record<string, unknown>).PLATFORM_API_REPLICA_HOST as string
      ?? os.hostname(),
  };
}

async function lookupActorEmail(app: FastifyInstance, userId: string): Promise<string> {
  const [row] = await app.db.select({ email: users.email }).from(users).where(eq(users.id, userId)).limit(1);
  return row?.email ?? 'unknown';
}

interface SessionParams { nodeName: string; }
interface SessionWithIdParams { nodeName: string; sessionId: string; }
interface WsQuery { token?: string; replica?: string; jwt?: string; }

/**
 * Authenticate the WS upgrade. The query string carries the session-
 * scoped `token` (single-use, sessionId-bound) AND the access JWT in
 * `jwt`. The JWT is also read from:
 *   - Authorization: Bearer header (used by the integration harness)
 *   - platform_session cookie (used by browsers when same-site)
 * The browser can't set Authorization on a WebSocket, hence `?jwt=`.
 *
 * We never accept the same value for both — `?token=` is the wsToken
 * (validated separately by attachExec), `?jwt=` / Bearer / cookie is
 * the access JWT.
 */
function authenticateWs(app: FastifyInstance, request: FastifyRequest): JwtPayload {
  let jwtToken: string | undefined;
  const auth = request.headers.authorization;
  if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
    jwtToken = auth.slice(7);
  }
  if (!jwtToken) {
    const q = request.query as WsQuery;
    if (q.jwt) jwtToken = q.jwt;
  }
  if (!jwtToken) {
    // Cookie fallback — same name as the rest of the platform.
    const cookieHeader = request.headers.cookie;
    if (typeof cookieHeader === 'string') {
      for (const pair of cookieHeader.split(';')) {
        const eq = pair.indexOf('=');
        if (eq === -1) continue;
        const name = pair.slice(0, eq).trim();
        if (name === 'platform_session') {
          jwtToken = pair.slice(eq + 1).trim();
          break;
        }
      }
    }
  }
  if (!jwtToken) throw invalidToken();
  try {
    const decoded = app.jwt.verify<JwtPayload>(jwtToken);
    // Reject pre-auth tokens (passkey 2FA step-1) — never enough for
    // node terminal, even when they decode correctly.
    if ((decoded as { step?: string }).step) throw invalidToken();
    return decoded;
  } catch {
    throw invalidToken();
  }
}

export async function nodeTerminalRoutes(app: FastifyInstance): Promise<void> {
  // Defence in depth — all routes are admin-panel + super_admin only.
  // The WS route bypasses these hooks (raw upgrade handler) and does
  // its own auth via authenticateWs() below.
  const adminGate = [
    authenticate,
    requirePanel('admin'),
    requireRole('super_admin'),
  ];

  // POST /api/v1/admin/nodes/:nodeName/terminal/sessions
  app.post<{ Params: SessionParams }>('/admin/nodes/:nodeName/terminal/sessions', {
    onRequest: adminGate,
    config: { rateLimit: { max: 30, timeWindow: '5 minutes' } },
    schema: {
      tags: ['Node Terminal'],
      summary: 'Create a privileged-shell session on a cluster node',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const { nodeName } = request.params;
    validateNodeName(nodeName);
    const user = request.user as JwtPayload;
    const email = await lookupActorEmail(app, user.sub);
    const ctx = makeServiceCtx(app);
    const created = await createSession(
      ctx,
      { userId: user.sub, userEmail: email, ip: request.ip },
      { nodeName, publicWssOrigin: publicWssOrigin(request, app) },
      request,
    );
    return reply.code(201).send({
      data: {
        sessionId: created.sessionId,
        nodeName: created.nodeName,
        podName: created.podName,
        websocketUrl: created.websocketUrl,
        createdAt: created.createdAt.toISOString(),
        expiresAt: created.expiresAt.toISOString(),
        idleTimeoutSeconds: Math.floor(NODE_TERMINAL_IDLE_MS / 1000),
      },
    });
  });

  // GET /api/v1/admin/nodes/:nodeName/terminal/sessions
  app.get<{ Params: SessionParams }>('/admin/nodes/:nodeName/terminal/sessions', {
    onRequest: adminGate,
    schema: {
      tags: ['Node Terminal'],
      summary: 'List active terminal sessions on a node',
      security: [{ bearerAuth: [] }],
    },
  }, async (request) => {
    const { nodeName } = request.params;
    validateNodeName(nodeName);
    const sessions = listSessionsForNode(nodeName);
    return {
      data: sessions.map((s) => ({
        sessionId: s.id,
        nodeName: s.nodeName,
        podName: s.podName,
        userId: s.userId,
        userEmail: s.userEmail,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        lastActivityAt: s.lastActivityAt.toISOString(),
      })),
    };
  });

  // GET /api/v1/admin/node-terminal/sessions — cross-node list
  app.get('/admin/node-terminal/sessions', {
    onRequest: adminGate,
    schema: {
      tags: ['Node Terminal'],
      summary: 'List ALL active terminal sessions (cross-node)',
      security: [{ bearerAuth: [] }],
    },
  }, async () => {
    const sessions = listSessions();
    return {
      data: sessions.map((s) => ({
        sessionId: s.id,
        nodeName: s.nodeName,
        podName: s.podName,
        userId: s.userId,
        userEmail: s.userEmail,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        lastActivityAt: s.lastActivityAt.toISOString(),
      })),
    };
  });

  // DELETE /api/v1/admin/nodes/:nodeName/terminal/sessions/:sessionId
  app.delete<{ Params: SessionWithIdParams }>('/admin/nodes/:nodeName/terminal/sessions/:sessionId', {
    onRequest: adminGate,
    schema: {
      tags: ['Node Terminal'],
      summary: 'Terminate a terminal session + delete its privileged Pod',
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const { nodeName, sessionId } = request.params;
    validateNodeName(nodeName);
    const user = request.user as JwtPayload;
    const ctx = makeServiceCtx(app);
    // Pass the requesting user separately so the audit row attributes
    // forced-closures correctly (security finding M1).
    await terminateSession(ctx, sessionId, 'server_close', request, user.sub);
    return reply.send({ data: { sessionId, terminated: true as const } });
  });

  // WebSocket: /api/v1/admin/nodes/:nodeName/terminal/sessions/:sessionId/ws
  //
  // Bearer auth is the gate: the WS upgrade carries the platform-session
  // JWT (header or ?token=) AND the ephemeral session token bound to
  // sessionId. Both are required.
  app.get<{ Params: SessionWithIdParams; Querystring: WsQuery }>(
    '/admin/nodes/:nodeName/terminal/sessions/:sessionId/ws',
    {
      websocket: true,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    (socket, request) => {
      let user: JwtPayload;
      try {
        user = authenticateWs(app, request);
      } catch {
        try { socket.send(JSON.stringify({ type: 'error', code: 'UNAUTHORIZED', message: 'Unauthorized' })); } catch { /* socket gone */ }
        socket.close(4401, 'Unauthorized');
        return;
      }
      if (user.panel !== 'admin') {
        try { socket.send(JSON.stringify({ type: 'error', code: 'PANEL_ACCESS_DENIED', message: 'Admin panel required' })); } catch { /* socket gone */ }
        socket.close(4403, 'Forbidden');
        return;
      }
      if (user.role !== 'super_admin') {
        try { socket.send(JSON.stringify({ type: 'error', code: 'INSUFFICIENT_PERMISSIONS', message: 'super_admin required' })); } catch { /* socket gone */ }
        socket.close(4403, 'Forbidden');
        return;
      }
      const { nodeName, sessionId } = request.params;
      try { validateNodeName(nodeName); } catch {
        try { socket.send(JSON.stringify({ type: 'error', code: 'INVALID_FIELD_VALUE', message: 'Invalid node name' })); } catch { /* socket gone */ }
        socket.close(4400, 'Bad request');
        return;
      }
      const q = request.query as WsQuery;
      const presentedToken = q.token ?? '';
      if (!presentedToken) {
        try { socket.send(JSON.stringify({ type: 'error', code: 'TOKEN_MISSING', message: 'Missing session token' })); } catch { /* socket gone */ }
        socket.close(4401, 'Unauthorized');
        return;
      }
      const ctx = makeServiceCtx(app);
      // attachExec validates the session token + sets up the streams.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      void attachExec(ctx, sessionId, presentedToken, user.sub, socket as any, request).catch((err) => {
        request.log.error({ err, sessionId }, 'node-terminal attachExec crashed');
        try { socket.close(4500, 'Internal error'); } catch { /* already closed */ }
      });
    },
  );
}
