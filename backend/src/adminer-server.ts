/**
 * Standalone Adminer proxy server.
 *
 * Listens on ADMINER_PROXY_PORT (default 8081) and serves Adminer requests
 * at the root path (/). Because Adminer is a full web application with CSS,
 * JS, forms, cookies, and redirects, proxying it under a path prefix
 * (e.g., /api/v1/clients/:id/adminer/proxy/*) breaks relative URLs.
 *
 * By giving Adminer its own port and serving from /, all internal links,
 * form actions, and redirects work correctly.
 */

import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify';
import { loadConfig } from './config/index.js';
import { getDb, closeDb } from './db/index.js';
import { eq } from 'drizzle-orm';
import { clients } from './db/schema.js';
import { ApiError } from './shared/errors.js';
import { createK8sClients } from './modules/k8s-provisioner/k8s-client.js';
import {
  consumeLoginToken,
  buildAutoLoginHtml,
  proxyToAdminer,
  ensureAdminerRunning,
} from './modules/adminer/service.js';

const ADMINER_PROXY_PORT = parseInt(process.env.ADMINER_PROXY_PORT ?? '8081', 10);

const config = loadConfig();
const db = getDb(config.DATABASE_URL);

const app = Fastify({
  logger: config.NODE_ENV !== 'test' && {
    level: config.LOG_LEVEL,
  },
  genReqId: () => crypto.randomUUID(),
  // Disable body size limit for Adminer uploads (SQL imports, etc.)
  bodyLimit: 50 * 1024 * 1024,
});

// ─── Content type parsers ──────────────────────────────────────────────────
// Adminer sends forms, CSS, JS, etc. — accept everything as raw buffers.
app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
app.addContentTypeParser('multipart/form-data', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));
app.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, body, done) => done(null, body));

// ─── Track active sessions: clientId -> namespace ──────────────────────────
// After auto-login succeeds, all subsequent requests from the browser will
// arrive without the clientId. We store the namespace from the auto-login
// and send a cookie so we know which namespace to proxy to.

const sessionNamespaces = new Map<string, { namespace: string; clientId: string; expiresAt: number }>();

// Cleanup expired sessions every 60s
setInterval(() => {
  const now = Date.now();
  for (const [key, value] of sessionNamespaces) {
    if (value.expiresAt < now) {
      sessionNamespaces.delete(key);
    }
  }
}, 60_000);

// ─── Helpers ───────────────────────────────────────────────────────────────

async function resolveNamespace(clientId: string): Promise<string> {
  const [client] = await db.select().from(clients).where(eq(clients.id, clientId)).limit(1);
  if (!client) throw new ApiError('CLIENT_NOT_FOUND', `Client '${clientId}' not found`, 404);
  if (client.provisioningStatus !== 'provisioned') {
    throw new ApiError('NOT_PROVISIONED', 'Client must be provisioned before using Adminer', 409);
  }
  return client.kubernetesNamespace;
}

function getK8s() {
  return { k8sClients: createK8sClients(config.KUBECONFIG_PATH), kubeconfigPath: config.KUBECONFIG_PATH };
}

function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  if (!cookieHeader) return {};
  const result: Record<string, string> = {};
  for (const pair of cookieHeader.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name) result[name.trim()] = rest.join('=').trim();
  }
  return result;
}

// ─── Auto-login route ──────────────────────────────────────────────────────

app.get('/auto-login', async (request, reply) => {
  const query = request.query as { token?: string; clientId?: string };

  if (!query.token || !query.clientId) {
    reply.status(400);
    return reply.send('Missing token or clientId query parameter');
  }

  const loginData = consumeLoginToken(query.token, query.clientId);
  if (!loginData) {
    reply.status(401);
    return reply.send('Login token is invalid or expired');
  }

  // Resolve namespace and ensure Adminer is running
  const namespace = await resolveNamespace(query.clientId);
  const { k8sClients } = getK8s();
  await ensureAdminerRunning(k8sClients, namespace);

  // Create a session ID and store the namespace mapping
  const sessionId = crypto.randomUUID();
  sessionNamespaces.set(sessionId, {
    namespace,
    clientId: query.clientId,
    expiresAt: Date.now() + 3 * 60 * 60 * 1000, // 3 hours
  });

  // The auto-login form POSTs to "/" — which is the root of this server.
  // After Adminer processes the login, it redirects to its main page,
  // which also resolves to "/" on this server. Everything works.
  const html = buildAutoLoginHtml('/', loginData.server, loginData.username, loginData.password);

  // Inject the session cookie into the HTML response and add a hidden field
  // so we can track which session this belongs to on subsequent requests.
  // We set the cookie and also include it as part of the response.
  reply.header('Content-Type', 'text/html; charset=utf-8');
  reply.header('Cache-Control', 'no-store');
  reply.header('Set-Cookie', `adminer_session=${sessionId}; Path=/; HttpOnly; SameSite=Lax; Max-Age=10800`);
  return reply.send(html);
});

// ─── Proxy handler ─────────────────────────────────────────────────────────

async function proxyHandler(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  // Determine namespace from session cookie
  const cookies = parseCookies(request.headers.cookie);
  const sessionId = cookies['adminer_session'];

  if (!sessionId) {
    reply.status(401);
    return reply.send('No Adminer session. Please use the auto-login URL from the client panel.');
  }

  const session = sessionNamespaces.get(sessionId);
  if (!session || session.expiresAt < Date.now()) {
    if (session) sessionNamespaces.delete(sessionId);
    reply.status(401);
    return reply.send('Adminer session expired. Please re-open from the client panel.');
  }

  const { namespace } = session;

  // Extract the path and query from the URL
  const [pathOnly, queryString] = request.url.split('?');
  const queryParams: Record<string, string> = {};
  if (queryString) {
    const params = new URLSearchParams(queryString);
    for (const [k, v] of params) {
      queryParams[k] = v;
    }
  }

  // Collect request body
  let bodyContent: string | Buffer | undefined;
  const contentType = request.headers['content-type'] ?? '';

  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const raw = request.body;
    if (Buffer.isBuffer(raw)) {
      bodyContent = raw;
    } else if (typeof raw === 'string') {
      bodyContent = raw;
    } else if (raw != null) {
      bodyContent = JSON.stringify(raw);
    }
  }

  // Forward cookies from the browser to Adminer (Adminer uses PHP sessions)
  // We need to forward all cookies except our session cookie
  const adminerCookies = Object.entries(cookies)
    .filter(([name]) => name !== 'adminer_session')
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');

  const result = await proxyToAdminer(config.KUBECONFIG_PATH, namespace, pathOnly, {
    method: request.method,
    body: bodyContent,
    contentType: contentType || undefined,
    query: Object.keys(queryParams).length > 0 ? queryParams : undefined,
    cookies: adminerCookies || undefined,
  });

  // Forward response headers
  if (result.headers['content-type']) {
    reply.header('Content-Type', result.headers['content-type']);
  }
  if (result.headers['location']) {
    // Adminer redirects are relative to root — they just work on this server
    reply.header('Location', result.headers['location']);
  }
  if (result.headers['set-cookie']) {
    reply.header('Set-Cookie', result.headers['set-cookie']);
  }
  if (result.headers['content-disposition']) {
    reply.header('Content-Disposition', result.headers['content-disposition']);
  }

  reply.status(result.status);
  return reply.send(result.bodyBuffer);
}

// Register proxy handler for both root path and wildcard
// (Fastify's /* may not match / in all versions)
app.all('/', proxyHandler);
app.all('/*', proxyHandler);

// ─── Error handler ─────────────────────────────────────────────────────────

app.setErrorHandler((error: Error & { statusCode?: number; code?: string }, _request, reply) => {
  const statusCode = error.statusCode ?? 500;
  app.log.error({ err: error }, 'Adminer proxy error');
  reply.status(statusCode).send({
    error: {
      code: error.code ?? 'INTERNAL_ERROR',
      message: error.message,
    },
  });
});

// ─── Startup ───────────────────────────────────────────────────────────────

const shutdown = async () => {
  await app.close();
  await closeDb();
  process.exit(0);
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await app.listen({ port: ADMINER_PROXY_PORT, host: '0.0.0.0' });
console.log(`Adminer proxy server listening on port ${ADMINER_PROXY_PORT}`);
