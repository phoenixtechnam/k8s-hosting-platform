import * as k8s from '@kubernetes/client-node';
import { createHmac } from 'node:crypto';
import { ensureAdminerRunning, getAdminerStatus } from './k8s-lifecycle.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { AdminerStatus } from './k8s-lifecycle.js';

const ADMINER_SERVICE = 'adminer';
const ADMINER_PORT = 8080;
const STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;

// ─── Signed login tokens ───────────────────────────────────────────────────
// Instead of in-memory storage (which only works within a single process),
// we use HMAC-signed Base64 tokens. The payload contains the login data
// and expiry. Both the main backend and the Adminer proxy server can
// create/verify tokens using the shared JWT_SECRET.

interface LoginToken {
  readonly server: string;
  readonly username: string;
  readonly password: string;
  readonly clientId: string;
  readonly expiresAt: number;
}

// Used tokens set — prevents replay attacks within the same process.
// Since the adminer-server is the only consumer, this is effective.
const usedTokens = new Set<string>();

// Cleanup expired token IDs every 60s
setInterval(() => {
  // We can't easily check expiry from just the ID, so just clear if the set
  // grows large. Tokens have a 60s TTL so old IDs become harmless quickly.
  if (usedTokens.size > 10_000) {
    usedTokens.clear();
  }
}, 60_000);

function getSigningSecret(): string {
  return process.env.JWT_SECRET ?? 'adminer-fallback-secret';
}

function signPayload(payload: string): string {
  return createHmac('sha256', getSigningSecret()).update(payload).digest('base64url');
}

/**
 * Create a signed auto-login token with 60s TTL.
 * The token is self-contained: payload + HMAC signature.
 */
export function createLoginToken(
  clientId: string,
  server: string,
  username: string,
  password: string,
): string {
  const tokenId = crypto.randomUUID();
  const payload = JSON.stringify({
    id: tokenId,
    server,
    username,
    password,
    clientId,
    expiresAt: Date.now() + 60_000,
  });
  const payloadB64 = Buffer.from(payload).toString('base64url');
  const signature = signPayload(payloadB64);
  return `${payloadB64}.${signature}`;
}

/**
 * Verify and consume a signed login token. Returns null if invalid, expired, or replayed.
 */
export function consumeLoginToken(token: string, clientId: string): LoginToken | null {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return null;

  const payloadB64 = token.slice(0, dotIndex);
  const signature = token.slice(dotIndex + 1);

  // Verify signature
  const expectedSignature = signPayload(payloadB64);
  if (signature !== expectedSignature) return null;

  // Decode payload
  let entry: LoginToken & { id?: string };
  try {
    entry = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf-8'));
  } catch {
    return null;
  }

  // Check expiry
  if (entry.expiresAt < Date.now()) return null;

  // Check clientId
  if (entry.clientId !== clientId) return null;

  // Prevent replay (one-time use)
  const tokenId = entry.id ?? token;
  if (usedTokens.has(tokenId)) return null;
  usedTokens.add(tokenId);

  return entry;
}

// ─── KubeConfig helper ───────────────────────────────────────────────────────

function loadKubeConfig(kubeconfigPath?: string): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) {
    kc.loadFromFile(kubeconfigPath);
  } else {
    kc.loadFromCluster();
  }
  return kc;
}

// ─── Wait for ready ──────────────────────────────────────────────────────────

async function waitForReady(
  k8sClients: K8sClients,
  namespace: string,
  timeoutMs = STARTUP_TIMEOUT_MS,
): Promise<AdminerStatus> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await getAdminerStatus(k8sClients, namespace);
    if (status.ready) return status;
    if (status.phase === 'failed') return status;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { ready: false, phase: 'failed', message: 'Timeout waiting for Adminer to start' };
}

// ─── Proxy ───────────────────────────────────────────────────────────────────

interface ProxyResult {
  readonly status: number;
  readonly body: string;
  readonly bodyBuffer: Buffer;
  readonly headers: Record<string, string>;
}

/**
 * Proxy a request to the Adminer pod via K8s API server service proxy.
 */
export async function proxyToAdminer(
  kubeconfigPath: string | undefined,
  namespace: string,
  adminerPath: string,
  options: {
    method?: string;
    body?: string | Buffer;
    contentType?: string;
    query?: Record<string, string>;
    cookies?: string;
  } = {},
): Promise<ProxyResult> {
  const kc = loadKubeConfig(kubeconfigPath);
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error('No active cluster in kubeconfig');

  const queryStr = options.query
    ? '?' + new URLSearchParams(options.query).toString()
    : '';
  const proxyPath = `/api/v1/namespaces/${namespace}/services/${ADMINER_SERVICE}:${ADMINER_PORT}/proxy${adminerPath}${queryStr}`;

  const httpsOpts = {} as { ca?: string; cert?: string; key?: string; headers?: Record<string, string> };
  await kc.applyToHTTPSOptions(httpsOpts);

  const headers: Record<string, string> = { ...(httpsOpts.headers ?? {}) };
  if (options.contentType) headers['Content-Type'] = options.contentType;
  if (options.cookies) headers['Cookie'] = options.cookies;

  if (options.body) {
    const bodyLen = Buffer.isBuffer(options.body) ? options.body.length : Buffer.byteLength(options.body);
    headers['Content-Length'] = String(bodyLen);
  }

  const user = kc.getCurrentUser();
  if (user?.token) headers['Authorization'] = `Bearer ${user.token}`;

  const { default: https } = await import('node:https');

  return new Promise((resolve, reject) => {
    const fullUrl = new URL(`${cluster.server}${proxyPath}`);
    const req = https.request({
      hostname: fullUrl.hostname,
      port: fullUrl.port || 443,
      path: fullUrl.pathname + fullUrl.search,
      method: options.method ?? 'GET',
      headers,
      ca: httpsOpts.ca,
      cert: httpsOpts.cert,
      key: httpsOpts.key,
      rejectUnauthorized: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const bodyBuffer = Buffer.concat(chunks);
        const responseHeaders: Record<string, string> = {};
        for (const [k, v] of Object.entries(res.headers)) {
          if (typeof v === 'string') responseHeaders[k] = v;
        }
        resolve({
          status: res.statusCode ?? 500,
          body: bodyBuffer.toString('utf-8'),
          bodyBuffer,
          headers: responseHeaders,
        });
      });
    });

    req.on('error', reject);

    if (options.body) {
      const buf = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
      req.write(buf);
      req.end();
    } else {
      req.end();
    }
  });
}

/**
 * Ensure Adminer is running and ready, then proxy a request.
 */
export async function adminerRequest(
  k8sClients: K8sClients,
  kubeconfigPath: string | undefined,
  namespace: string,
  adminerPath: string,
  options: {
    method?: string;
    body?: string | Buffer;
    contentType?: string;
    query?: Record<string, string>;
  } = {},
): Promise<ProxyResult> {
  await ensureAdminerRunning(k8sClients, namespace);

  const status = await waitForReady(k8sClients, namespace);
  if (!status.ready) {
    throw new Error(`Adminer not ready: ${status.message}`);
  }

  return proxyToAdminer(kubeconfigPath, namespace, adminerPath, options);
}

/**
 * Build the auto-login HTML that auto-submits credentials to Adminer.
 */
export function buildAutoLoginHtml(
  proxyBaseUrl: string,
  server: string,
  username: string,
  password: string,
): string {
  // Escape HTML entities to prevent XSS
  const esc = (s: string) => s
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>Connecting to database...</title></head>
<body onload="document.getElementById('f').submit()">
<p>Connecting to database...</p>
<form id="f" method="post" action="${esc(proxyBaseUrl)}">
  <input type="hidden" name="auth[driver]" value="server">
  <input type="hidden" name="auth[server]" value="${esc(server)}">
  <input type="hidden" name="auth[username]" value="${esc(username)}">
  <input type="hidden" name="auth[password]" value="${esc(password)}">
  <input type="hidden" name="auth[db]" value="">
</form>
</body>
</html>`;
}

export { ensureAdminerRunning, getAdminerStatus, stopAdminer } from './k8s-lifecycle.js';
