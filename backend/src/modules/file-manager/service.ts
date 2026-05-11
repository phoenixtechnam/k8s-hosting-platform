import * as k8s from '@kubernetes/client-node';
import { ensureFileManagerRunning, getFileManagerStatus } from './k8s-lifecycle.js';
import { getFileManagerImage } from './image.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { FileManagerStatus } from '@k8s-hosting/api-contracts';

const FM_SERVICE = 'file-manager';
const FM_PORT = 8111;
const STARTUP_TIMEOUT_MS = 30_000;
// Phase 3: tightened poll cadence — only relevant on cold start.
// Once FM is ready, the cache below short-circuits the poll loop.
const POLL_INTERVAL_MS = 250;

// Phase 1: in-memory ready cache. Populated on every confirmed-ready
// observation, expired after READY_CACHE_TTL_MS. Hot-path callers skip
// readNamespacedDeployment + listNamespacedPod entirely on cache hit,
// going straight to the proxy. On cache miss (or after a request
// returns non-2xx), we re-do the full check.
const READY_CACHE_TTL_MS = 10_000;
const readyCache = new Map<string, number>();

function cacheReady(namespace: string): void {
  readyCache.set(namespace, Date.now());
}

function recentlySeenReady(namespace: string): boolean {
  const at = readyCache.get(namespace);
  if (!at) return false;
  if (Date.now() - at > READY_CACHE_TTL_MS) {
    readyCache.delete(namespace);
    return false;
  }
  return true;
}

function invalidateReady(namespace: string): void {
  readyCache.delete(namespace);
}

/**
 * Test-only: clear the entire ready cache. Used by service.test.ts
 * to keep test cases independent — cache is module-level so a prior
 * test's success would otherwise short-circuit subsequent tests'
 * readiness checks.
 */
export function __resetFileManagerReadyCacheForTests(): void {
  readyCache.clear();
}

// Phase 4: persistent HTTPS Agent for direct ClusterIP and apiserver-
// proxy connections. keepAlive avoids TLS handshake on every request;
// `maxSockets` is per-host so platform-api scales with FM count.
let _httpsAgent: import('node:https').Agent | null = null;
async function getHttpsAgent(): Promise<import('node:https').Agent> {
  if (!_httpsAgent) {
    // Use namespace import — `default` is incomplete under some test
    // module-mock setups (the .Agent constructor lives on the named
    // export tree, not on the synthesized default).
    const https = await import('node:https');
    _httpsAgent = new https.Agent({
      keepAlive: true,
      keepAliveMsecs: 15_000,
      maxSockets: 32,
      maxFreeSockets: 8,
      rejectUnauthorized: false, // mirrors per-request setting
    });
  }
  return _httpsAgent;
}

let _httpAgent: import('node:http').Agent | null = null;
async function getHttpAgent(): Promise<import('node:http').Agent> {
  if (!_httpAgent) {
    const http = await import('node:http');
    _httpAgent = new http.Agent({
      keepAlive: true,
      keepAliveMsecs: 15_000,
      maxSockets: 32,
      maxFreeSockets: 8,
    });
  }
  return _httpAgent;
}

/**
 * Phase 2: Direct ClusterIP path. When platform-api runs in-cluster
 * (the normal case), we resolve the FM Service ClusterIP and hit it
 * directly — bypassing the K8s service proxy through the apiserver,
 * which adds 0.5-1.5s per request because every byte routes through
 * the apiserver TLS proxy + service VIP + node kubelet.
 *
 * Returns null when:
 *   - we're not in-cluster (kubeconfig has explicit server URL)
 *   - the Service can't be resolved (FM not deployed yet)
 * Caller falls back to the apiserver-proxy path in that case.
 */
export async function resolveFmServiceUrlForRoute(
  k8sClients: K8sClients,
  namespace: string,
): Promise<string | null> {
  return resolveFmServiceUrl(k8sClients, namespace);
}

async function resolveFmServiceUrl(
  k8sClients: K8sClients,
  namespace: string,
): Promise<string | null> {
  // In-cluster check: KUBERNETES_SERVICE_HOST is set when running
  // inside a Pod; absent on local dev with kubeconfig.
  if (!process.env.KUBERNETES_SERVICE_HOST) return null;
  try {
    // Cluster DNS form is more stable than ClusterIP across Service
    // re-creations and avoids a per-call API GET. CoreDNS resolves
    // <svc>.<ns>.svc.cluster.local in <1ms.
    return `http://${FM_SERVICE}.${namespace}.svc.cluster.local:${FM_PORT}`;
  } catch {
    return null;
  }
}

/**
 * Probe-first ready helper for streaming routes (upload-raw, download,
 * fetch-url, clone-site). Mirrors the hot-path logic in
 * fileManagerRequest so streaming paths get the same sub-second cold
 * start: cache hit → 0 K8s calls, FM-healthy probe → 1 HTTP /health
 * call (~10 ms), only fall through to ensureFileManagerRunning +
 * waitForReady when FM is genuinely down.
 *
 * Before this helper, streaming routes called ensureFileManagerRunning
 * + getFileManagerStatus unconditionally on every request. That cost
 * 2-4 K8s round-trips (~3-7 s cold) and the browser's <img> spinner /
 * download UI showed nothing during the delay, looking hung even when
 * the underlying transfer would have been fast.
 */
export async function ensureFileManagerReady(
  k8sClients: K8sClients,
  namespace: string,
  image: string,
): Promise<{ directUrl: string | null }> {
  const directUrl = await resolveFmServiceUrl(k8sClients, namespace);
  if (recentlySeenReady(namespace)) return { directUrl };
  if (directUrl && await probeFmHealth(directUrl)) {
    cacheReady(namespace);
    return { directUrl };
  }
  await ensureFileManagerRunning(k8sClients, namespace, image, 1);
  const status = await waitForReady(k8sClients, namespace);
  if (!status.ready) {
    throw new Error(`File manager not ready: ${status.message}`);
  }
  cacheReady(namespace);
  return { directUrl };
}

/**
 * Phase 5: probe-first fast cold-path.
 *
 * The Phase-1 ready cache is per-process, so with N platform-api
 * replicas only ~1 in N requests hits a hot cache. The other replicas
 * paid the full ensureFileManagerRunning + waitForReady cost
 * (~1.5–3s) on every "cold" call even though FM was actually healthy.
 *
 * This probe asks FM directly via the cluster DNS path: if /health
 * answers within ~1.5s, FM is alive and we can populate the cache and
 * skip the expensive K8s API reconciliation entirely. If the probe
 * fails (FM scaled to 0 by idle-cleanup, evicted, or never created)
 * we fall back to the full ensure + wait path.
 */
async function probeFmHealth(directUrl: string, timeoutMs = 1500): Promise<boolean> {
  const { default: http } = await import('node:http');
  const agent = await getHttpAgent();
  return new Promise<boolean>((resolve) => {
    const u = new URL(directUrl + '/health');
    const req = http.request({
      hostname: u.hostname,
      port: u.port || 80,
      path: u.pathname,
      method: 'GET',
      agent,
      timeout: timeoutMs,
    }, (res) => {
      // Drain so the keep-alive socket can be reused.
      res.resume();
      resolve((res.statusCode ?? 500) >= 200 && (res.statusCode ?? 500) < 500);
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.end();
  });
}

/**
 * Create a KubeConfig object from file path for making raw HTTP requests.
 */
function loadKubeConfig(kubeconfigPath?: string): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) {
    kc.loadFromFile(kubeconfigPath);
  } else {
    kc.loadFromCluster();
  }
  return kc;
}

// Module-level cached KubeConfig. Loading from disk + parsing is the
// expensive part (~30-50ms) — cache the parsed KubeConfig and the
// cluster/CA material. **Do NOT cache the bearer token**: in-cluster
// projected SA tokens rotate every ~1h (default expirationSeconds=3607)
// and the kubelet rewrites the file in place. We re-read the token via
// kc.getCurrentUser() on every call — that pulls from the in-memory
// KubeConfig.users[] which loadFromCluster repopulates from
// /var/run/secrets/.../token — but K8s SDK only re-reads on
// loadFromCluster(). To get fresh tokens we instead drop+rebuild the
// CachedKubeContext if it's older than CACHE_TTL_MS.
const KUBECONTEXT_TTL_MS = 5 * 60_000; // 5 min

interface CachedKubeContext {
  kc: k8s.KubeConfig;
  cluster: ReturnType<k8s.KubeConfig['getCurrentCluster']>;
  httpsOpts: { ca?: string; cert?: string; key?: string; headers?: Record<string, string> };
  loadedAt: number;
}
const _kubeContextByPath = new Map<string, CachedKubeContext>();

async function getKubeContext(kubeconfigPath: string | undefined): Promise<CachedKubeContext> {
  const key = kubeconfigPath ?? '__incluster__';
  const cached = _kubeContextByPath.get(key);
  if (cached && Date.now() - cached.loadedAt < KUBECONTEXT_TTL_MS) return cached;
  const kc = loadKubeConfig(kubeconfigPath);
  const cluster = kc.getCurrentCluster();
  const httpsOpts = {} as CachedKubeContext['httpsOpts'];
  await kc.applyToHTTPSOptions(httpsOpts);
  const ctx: CachedKubeContext = {
    kc,
    cluster,
    httpsOpts,
    loadedAt: Date.now(),
  };
  _kubeContextByPath.set(key, ctx);
  return ctx;
}

/** Pull a fresh bearer token from the cached KubeConfig. Reads from
 *  the SDK's parsed users[] table, which `loadFromCluster()` populated
 *  from disk. We rebuild the whole context every KUBECONTEXT_TTL_MS so
 *  the disk read happens before SA token rotation expires the old one. */
function getBearerTokenFromContext(ctx: CachedKubeContext): string | undefined {
  return ctx.kc.getCurrentUser()?.token;
}

/** Test-only: clear the kube-context cache so tests don't share state. */
export function __resetKubeContextCacheForTests(): void {
  _kubeContextByPath.clear();
}

/**
 * Wait for the file-manager pod to be ready.
 */
async function waitForReady(
  k8sClients: K8sClients,
  namespace: string,
  timeoutMs = STARTUP_TIMEOUT_MS,
): Promise<FileManagerStatus> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const status = await getFileManagerStatus(k8sClients, namespace);
    if (status.ready) return status;
    if (status.phase === 'failed') return status;
    await new Promise(r => setTimeout(r, POLL_INTERVAL_MS));
  }
  return { ready: false, phase: 'failed', message: 'Timeout waiting for file manager to start' };
}

interface ProxyResult {
  readonly status: number;
  readonly body: string;
  readonly bodyBuffer: Buffer;
  readonly headers: Record<string, string>;
}

/**
 * Direct-cluster proxy. Hits the FM Service ClusterIP DNS without
 * going through the apiserver proxy. Saves 0.5-1.5s per call.
 *
 * Used when KUBERNETES_SERVICE_HOST is set (in-cluster) AND the
 * caller passed directUrl. No TLS, no client certs — the request
 * stays on the pod-network and Network Policies enforce isolation.
 */
async function proxyDirect(
  baseUrl: string,
  pathAndQuery: string,
  options: {
    method?: string;
    body?: string | Buffer;
    contentType?: string;
    platformInternal?: boolean;
  },
): Promise<ProxyResult> {
  const headers: Record<string, string> = {};
  if (options.contentType) headers['Content-Type'] = options.contentType;
  if (options.platformInternal) {
    const secret = process.env.PLATFORM_INTERNAL_SECRET;
    if (!secret) {
      throw new Error(
        'PLATFORM_INTERNAL_SECRET is required for platform-internal file-manager requests',
      );
    }
    headers['X-Platform-Internal'] = secret;
  }
  if (options.body) {
    const bodyLen = Buffer.isBuffer(options.body) ? options.body.length : Buffer.byteLength(options.body);
    headers['Content-Length'] = String(bodyLen);
  }

  const { default: http } = await import('node:http');
  const agent = await getHttpAgent();

  return new Promise((resolve, reject) => {
    const fullUrl = new URL(baseUrl + pathAndQuery);
    const req = http.request({
      hostname: fullUrl.hostname,
      port: fullUrl.port || 80,
      path: fullUrl.pathname + fullUrl.search,
      method: options.method ?? 'GET',
      headers,
      agent,
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
      req.end(buf);
    } else {
      req.end();
    }
  });
}

/**
 * Proxy a request to the file-manager sidecar via the K8s API server.
 * Uses the service proxy: /api/v1/namespaces/{ns}/services/{svc}:{port}/proxy/{path}
 * Auth is handled via kubeconfig (client certs or token).
 *
 * Returns both body (string) and bodyBuffer (Buffer) so callers can choose.
 * Binary endpoints (download) should use bodyBuffer to avoid UTF-8 corruption.
 */
export async function proxyToFileManager(
  kubeconfigPath: string | undefined,
  namespace: string,
  sidecarPath: string,
  options: {
    method?: string;
    body?: string | Buffer;
    contentType?: string;
    query?: Record<string, string>;
    // Phase 3 T5.1: set to true when the platform backend needs to
    // read/write paths hidden from the customer file manager (e.g.
    // .platform/sendmail-auth). The sidecar gates hidden paths
    // behind the `X-Platform-Internal: 1` header.
    platformInternal?: boolean;
    // Phase 2: when set, hit the FM Service ClusterIP directly.
    // Bypasses the apiserver proxy (saves 0.5-1.5s per call). Caller
    // populates this from resolveFmServiceUrl().
    directUrl?: string;
  } = {},
): Promise<ProxyResult> {
  const queryStr = options.query
    ? '?' + new URLSearchParams(options.query).toString()
    : '';

  // Phase 2: fast direct path via ClusterIP DNS — no apiserver proxy.
  if (options.directUrl) {
    return proxyDirect(options.directUrl, sidecarPath + queryStr, options);
  }

  // Slow path: kubeconfig + apiserver service-proxy. Used when
  // platform-api runs out-of-cluster (local dev) or when the
  // ClusterIP isn't reachable.
  const ctx = await getKubeContext(kubeconfigPath);
  const cluster = ctx.cluster;
  if (!cluster) throw new Error('No active cluster in kubeconfig');

  const proxyPath = `/api/v1/namespaces/${namespace}/services/${FM_SERVICE}:${FM_PORT}/proxy${sidecarPath}${queryStr}`;
  const httpsOpts = ctx.httpsOpts;

  const headers: Record<string, string> = { ...(httpsOpts.headers ?? {}) };
  if (options.contentType) headers['Content-Type'] = options.contentType;
  if (options.platformInternal) {
    const secret = process.env.PLATFORM_INTERNAL_SECRET;
    if (!secret) {
      throw new Error(
        'PLATFORM_INTERNAL_SECRET is required for platform-internal file-manager requests',
      );
    }
    headers['X-Platform-Internal'] = secret;
  }

  // Set Content-Length for bodies to avoid chunked encoding issues
  if (options.body) {
    const bodyLen = Buffer.isBuffer(options.body) ? options.body.length : Buffer.byteLength(options.body);
    headers['Content-Length'] = String(bodyLen);
  }

  // Apply auth headers (token-based auth)
  const _tok = getBearerTokenFromContext(ctx); if (_tok) headers["Authorization"] = `Bearer ${_tok}`;

  const { default: https } = await import('node:https');
  const agent = await getHttpsAgent();

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
      rejectUnauthorized: false, // k3s self-signed
      agent,
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
      // Write in chunks for large bodies to avoid backpressure
      const buf = Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body);
      const CHUNK_SIZE = 64 * 1024; // 64KB chunks
      let offset = 0;
      const writeChunk = () => {
        while (offset < buf.length) {
          const end = Math.min(offset + CHUNK_SIZE, buf.length);
          const ok = req.write(buf.subarray(offset, end));
          offset = end;
          if (!ok) {
            // Backpressure — wait for drain event
            req.once('drain', writeChunk);
            return;
          }
        }
        req.end();
      };
      writeChunk();
    } else {
      req.end();
    }
  });
}

/**
 * Stream a response FROM the file-manager sidecar directly to the client.
 * Unlike proxyToFileManager, this does NOT buffer — it pipes the K8s API
 * proxy response directly to the outgoing HTTP response for real-time progress.
 *
 * When `directUrl` is provided, hits the FM ClusterIP directly (HTTP, no
 * apiserver hop) for full streaming throughput. Otherwise falls back to
 * the apiserver service-proxy which is rate-limited for bulk data.
 */
export async function proxyToFileManagerStream(
  kubeconfigPath: string | undefined,
  namespace: string,
  sidecarPath: string,
  body: string,
  clientRes: import('node:http').ServerResponse,
  options: { directUrl?: string } = {},
): Promise<void> {
  const writeUpstream = (res: import('node:http').IncomingMessage) => {
    const contentType = res.headers['content-type'] ?? 'application/json';
    clientRes.writeHead(res.statusCode ?? 200, {
      'Content-Type': contentType,
      'Transfer-Encoding': 'chunked',
      'Cache-Control': 'no-cache',
    });
    res.pipe(clientRes);
  };

  if (options.directUrl) {
    const { default: http } = await import('node:http');
    const httpAgent = await getHttpAgent();
    return new Promise((resolve, reject) => {
      const u = new URL(options.directUrl + sidecarPath);
      const req = http.request({
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: 'POST',
        agent: httpAgent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(body)),
        },
      }, (res) => {
        writeUpstream(res);
        res.on('end', resolve);
        res.on('error', (err) => { try { clientRes.end(); } catch { /* ignore */ } reject(err); });
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  const ctx = await getKubeContext(kubeconfigPath);
  const cluster = ctx.cluster;
  if (!cluster) throw new Error('No active cluster in kubeconfig');

  const proxyPath = `/api/v1/namespaces/${namespace}/services/${FM_SERVICE}:${FM_PORT}/proxy${sidecarPath}`;
  const httpsOpts = ctx.httpsOpts;

  const headers: Record<string, string> = {
    ...(httpsOpts.headers ?? {}),
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
  };
  const _tok = getBearerTokenFromContext(ctx); if (_tok) headers["Authorization"] = `Bearer ${_tok}`;

  const { default: https } = await import('node:https');
  const agent = await getHttpsAgent();

  return new Promise((resolve, reject) => {
    const fullUrl = new URL(`${cluster.server}${proxyPath}`);
    const req = https.request({
      hostname: fullUrl.hostname,
      port: fullUrl.port || 443,
      path: fullUrl.pathname,
      method: 'POST',
      headers,
      ca: httpsOpts.ca,
      cert: httpsOpts.cert,
      key: httpsOpts.key,
      rejectUnauthorized: false,
      agent,
    }, (res) => {
      writeUpstream(res);
      res.on('end', resolve);
      res.on('error', (err) => { try { clientRes.end(); } catch { /* ignore */ } reject(err); });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Stream a response FROM the file-manager sidecar (e.g. binary file
 * download) back to the client without buffering. Memory stays flat
 * regardless of file size — bytes go pod→platform-api→client in flight.
 *
 * Returns:
 *   - on 2xx: pipes the upstream body directly to clientRes after
 *     forwarding Content-Type / Content-Length / Content-Disposition.
 *   - on non-2xx: drains a small bounded buffer (16 KiB) and throws an
 *     ApiError-shaped object with the status + body. We never stream a
 *     potentially 1 GB body to the client when the upstream is an error.
 */
export async function streamFromFileManager(
  kubeconfigPath: string | undefined,
  namespace: string,
  sidecarPath: string,
  clientRes: import('node:http').ServerResponse,
  options: {
    query?: Record<string, string>;
    method?: string;
    directUrl?: string;
  } = {},
): Promise<void> {
  const queryStr = options.query
    ? '?' + new URLSearchParams(options.query).toString()
    : '';
  const method = options.method ?? 'GET';

  const passthroughHeaders = ['content-type', 'content-length', 'content-disposition', 'last-modified', 'etag'];

  const handleUpstream = (res: import('node:http').IncomingMessage, resolve: () => void, reject: (err: Error) => void) => {
    const status = res.statusCode ?? 500;
    if (status >= 200 && status < 300) {
      const out: Record<string, string> = {};
      for (const k of passthroughHeaders) {
        const v = res.headers[k];
        if (typeof v === 'string') out[k] = v;
      }
      clientRes.writeHead(status, out);
      res.pipe(clientRes);
      res.on('end', resolve);
      res.on('error', (err) => { try { clientRes.end(); } catch { /* ignore */ } reject(err); });
      return;
    }
    // Non-2xx: drain bounded buffer then surface as a thrown error so
    // the route handler can map it to an ApiError envelope. Cap at
    // 16 KiB so a misbehaving upstream that returns a huge HTML error
    // page can't blow up platform-api memory.
    const chunks: Buffer[] = [];
    let total = 0;
    const CAP = 16 * 1024;
    res.on('data', (chunk: Buffer) => {
      if (total < CAP) {
        chunks.push(chunk.subarray(0, Math.min(chunk.length, CAP - total)));
        total += chunk.length;
      }
    });
    res.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8').slice(0, CAP);
      const err: Error & { upstreamStatus?: number; upstreamBody?: string } = new Error(`File manager returned ${status}: ${text || '(empty body)'}`);
      err.upstreamStatus = status;
      err.upstreamBody = text;
      reject(err);
    });
    res.on('error', reject);
  };

  if (options.directUrl) {
    const { default: http } = await import('node:http');
    const httpAgent = await getHttpAgent();
    return new Promise((resolve, reject) => {
      const u = new URL(options.directUrl + sidecarPath + queryStr);
      const req = http.request({
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method,
        agent: httpAgent,
      }, (res) => handleUpstream(res, () => resolve(), reject));
      req.on('error', reject);
      req.end();
    });
  }

  const ctx = await getKubeContext(kubeconfigPath);
  const cluster = ctx.cluster;
  if (!cluster) throw new Error('No active cluster in kubeconfig');

  const proxyPath = `/api/v1/namespaces/${namespace}/services/${FM_SERVICE}:${FM_PORT}/proxy${sidecarPath}${queryStr}`;
  const httpsOpts = ctx.httpsOpts;
  const headers: Record<string, string> = { ...(httpsOpts.headers ?? {}) };
  const _tok = getBearerTokenFromContext(ctx); if (_tok) headers["Authorization"] = `Bearer ${_tok}`;

  const { default: https } = await import('node:https');
  const agent = await getHttpsAgent();
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(`${cluster.server}${proxyPath}`);
    const req = https.request({
      hostname: fullUrl.hostname,
      port: fullUrl.port || 443,
      path: fullUrl.pathname + fullUrl.search,
      method,
      headers,
      ca: httpsOpts.ca,
      cert: httpsOpts.cert,
      key: httpsOpts.key,
      rejectUnauthorized: false,
      agent,
    }, (res) => handleUpstream(res, () => resolve(), reject));
    req.on('error', reject);
    req.end();
  });
}

/**
 * Stream a request body directly to the file-manager sidecar.
 * Unlike proxyToFileManager, this does NOT buffer the body — it pipes
 * the incoming stream directly to the K8s API proxy.
 * Used for unlimited-size file uploads.
 */
export async function streamToFileManager(
  kubeconfigPath: string | undefined,
  namespace: string,
  sidecarPath: string,
  incomingStream: import('node:stream').Readable,
  options: {
    contentType?: string;
    contentLength?: string;
    query?: Record<string, string>;
    /** Hit FM ClusterIP directly — bypasses apiserver-proxy bulk-data
     *  cap (~MB/s) and removes ~0.5-1.5s startup latency per upload. */
    directUrl?: string;
  } = {},
): Promise<ProxyResult> {
  const queryStr = options.query
    ? '?' + new URLSearchParams(options.query).toString()
    : '';

  const buildHeaders = (extra: Record<string, string>): Record<string, string> => {
    const h: Record<string, string> = { ...extra };
    if (options.contentType) h['Content-Type'] = options.contentType;
    if (options.contentLength) h['Content-Length'] = options.contentLength;
    if (!options.contentLength) h['Transfer-Encoding'] = 'chunked';
    return h;
  };

  // Direct ClusterIP: HTTP, no apiserver hop, full bandwidth.
  if (options.directUrl) {
    const { default: http } = await import('node:http');
    const httpAgent = await getHttpAgent();
    return new Promise((resolve, reject) => {
      const u = new URL(options.directUrl + sidecarPath + queryStr);
      const req = http.request({
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname + u.search,
        method: 'POST',
        agent: httpAgent,
        headers: buildHeaders({}),
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
      let pipeCompleted = false;
      incomingStream.pipe(req);
      req.on('finish', () => { pipeCompleted = true; });
      incomingStream.on('error', (err) => { if (!pipeCompleted) req.destroy(err); });
    });
  }

  const ctx = await getKubeContext(kubeconfigPath);
  const cluster = ctx.cluster;
  if (!cluster) throw new Error('No active cluster in kubeconfig');

  const proxyPath = `/api/v1/namespaces/${namespace}/services/${FM_SERVICE}:${FM_PORT}/proxy${sidecarPath}${queryStr}`;
  const httpsOpts = ctx.httpsOpts;
  const headers = buildHeaders({ ...(httpsOpts.headers ?? {}) });
  const _tok = getBearerTokenFromContext(ctx); if (_tok) headers["Authorization"] = `Bearer ${_tok}`;

  const { default: https } = await import('node:https');
  const agent = await getHttpsAgent();

  return new Promise((resolve, reject) => {
    const fullUrl = new URL(`${cluster.server}${proxyPath}`);
    const req = https.request({
      hostname: fullUrl.hostname,
      port: fullUrl.port || 443,
      path: fullUrl.pathname + fullUrl.search,
      method: 'POST',
      headers,
      ca: httpsOpts.ca,
      cert: httpsOpts.cert,
      key: httpsOpts.key,
      rejectUnauthorized: false,
      agent,
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

    // Pipe incoming stream directly to the K8s proxy — zero buffering
    // Track if pipe completed normally so we don't destroy on normal close
    let pipeCompleted = false;

    incomingStream.pipe(req);

    // When pipe completes, req.end() is called automatically by pipe
    req.on('finish', () => { pipeCompleted = true; });

    // Only handle abnormal close (client abort)
    incomingStream.on('error', (err) => {
      if (!pipeCompleted) req.destroy(err);
    });
    // Removed the close handler — pipe handles normal completion.
    // The old close handler could race with pipe's req.end(), causing
    // "Cannot call write after a stream was destroyed".
  });
}

/**
 * Ensure file manager is running and ready, then proxy a request.
 */
export async function fileManagerRequest(
  k8sClients: K8sClients,
  kubeconfigPath: string | undefined,
  namespace: string,
  image: string,
  sidecarPath: string,
  options: {
    method?: string;
    body?: string | Buffer;
    contentType?: string;
    query?: Record<string, string>;
    platformInternal?: boolean;
  } = {},
): Promise<ProxyResult> {
  // Phase 1: hot path — if we recently saw FM ready in this namespace,
  // skip ensureFileManagerRunning + waitForReady entirely.
  const hot = recentlySeenReady(namespace);
  const directUrl = await resolveFmServiceUrl(k8sClients, namespace);

  if (!hot) {
    // Phase 5: probe-first. With N platform-api replicas, the per-
    // process cache only helps 1/N of requests. Probing FM /health
    // via cluster DNS catches the common case (FM healthy, just not
    // observed by this replica yet) in ~5-150ms instead of ~1.5-3s
    // of K8s API reads + readiness polling. Falls through to the
    // full reconcile path only when FM is genuinely unreachable
    // (idle-scaled to 0, evicted, or never created).
    const probedOk = directUrl ? await probeFmHealth(directUrl) : false;
    if (probedOk) {
      cacheReady(namespace);
    } else {
      await ensureFileManagerRunning(k8sClients, namespace, image, 1);
      const status = await waitForReady(k8sClients, namespace);
      if (!status.ready) {
        throw new Error(`File manager not ready: ${status.message}`);
      }
      cacheReady(namespace);
    }
  }

  const result = await proxyToFileManager(kubeconfigPath, namespace, sidecarPath, {
    ...options,
    ...(directUrl ? { directUrl } : {}),
  });

  // 5xx might mean FM died between our cache hit and now (idle-cleanup,
  // OOM, eviction). Invalidate so the next call re-checks.
  if (result.status >= 500) {
    invalidateReady(namespace);
  }
  return result;
}

/**
 * Ensure file-manager is running and return a ready pod name.
 * Use this when you need to exec into the file-manager pod directly
 * (e.g. for cp/tar operations) rather than proxying HTTP requests.
 * Handles auto-start from idle (scaled to 0) with up to 30s wait.
 */
export async function getReadyFileManagerPod(
  k8sClients: K8sClients,
  namespace: string,
  image = getFileManagerImage(),
): Promise<string> {
  // Same on-demand semantics as fileManagerRequest — scale up to 1
  // even if provisioner created it at 0.
  await ensureFileManagerRunning(k8sClients, namespace, image, 1);
  const status = await waitForReady(k8sClients, namespace);
  if (!status.ready) {
    throw new Error(`File manager not ready: ${status.message ?? 'timeout'}`);
  }

  const pods = await k8sClients.core.listNamespacedPod({
    namespace,
    labelSelector: 'app=file-manager',
  });
  const podItems = (pods as { items?: readonly { metadata?: { name?: string }; status?: { phase?: string } }[] }).items ?? [];
  const runningPod = podItems.find(p => p.status?.phase === 'Running');
  if (!runningPod?.metadata?.name) {
    throw new Error('File manager pod not found after startup');
  }
  return runningPod.metadata.name;
}

export { ensureFileManagerRunning, getFileManagerStatus, stopFileManager } from './k8s-lifecycle.js';
