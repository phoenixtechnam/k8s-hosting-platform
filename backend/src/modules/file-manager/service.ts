import * as k8s from '@kubernetes/client-node';
import { ensureFileManagerRunning, getFileManagerStatus } from './k8s-lifecycle.js';
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
  const kc = loadKubeConfig(kubeconfigPath);
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error('No active cluster in kubeconfig');

  const proxyPath = `/api/v1/namespaces/${namespace}/services/${FM_SERVICE}:${FM_PORT}/proxy${sidecarPath}${queryStr}`;

  // Extract TLS options (client certs) from kubeconfig
  const httpsOpts = {} as { ca?: string; cert?: string; key?: string; headers?: Record<string, string> };
  await kc.applyToHTTPSOptions(httpsOpts);

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
  const user = kc.getCurrentUser();
  if (user?.token) headers['Authorization'] = `Bearer ${user.token}`;

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
 */
export async function proxyToFileManagerStream(
  kubeconfigPath: string | undefined,
  namespace: string,
  sidecarPath: string,
  body: string,
  clientRes: import('node:http').ServerResponse,
): Promise<void> {
  const kc = loadKubeConfig(kubeconfigPath);
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error('No active cluster in kubeconfig');

  const proxyPath = `/api/v1/namespaces/${namespace}/services/${FM_SERVICE}:${FM_PORT}/proxy${sidecarPath}`;

  const httpsOpts = {} as { ca?: string; cert?: string; key?: string; headers?: Record<string, string> };
  await kc.applyToHTTPSOptions(httpsOpts);

  const headers: Record<string, string> = {
    ...(httpsOpts.headers ?? {}),
    'Content-Type': 'application/json',
    'Content-Length': String(Buffer.byteLength(body)),
  };

  const user = kc.getCurrentUser();
  if (user?.token) headers['Authorization'] = `Bearer ${user.token}`;

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
      const contentType = res.headers['content-type'] ?? 'application/json';
      clientRes.writeHead(res.statusCode ?? 200, {
        'Content-Type': contentType,
        'Transfer-Encoding': 'chunked',
        'Cache-Control': 'no-cache',
      });
      res.on('data', (chunk: Buffer) => clientRes.write(chunk));
      res.on('end', () => { clientRes.end(); resolve(); });
      res.on('error', (err) => { clientRes.end(); reject(err); });
    });

    req.on('error', reject);
    req.write(body);
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
  } = {},
): Promise<ProxyResult> {
  const kc = loadKubeConfig(kubeconfigPath);
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error('No active cluster in kubeconfig');

  const queryStr = options.query
    ? '?' + new URLSearchParams(options.query).toString()
    : '';
  const proxyPath = `/api/v1/namespaces/${namespace}/services/${FM_SERVICE}:${FM_PORT}/proxy${sidecarPath}${queryStr}`;

  const httpsOpts = {} as { ca?: string; cert?: string; key?: string; headers?: Record<string, string> };
  await kc.applyToHTTPSOptions(httpsOpts);

  const headers: Record<string, string> = { ...(httpsOpts.headers ?? {}) };
  if (options.contentType) headers['Content-Type'] = options.contentType;
  if (options.contentLength) headers['Content-Length'] = options.contentLength;
  // Use Transfer-Encoding: chunked if no Content-Length
  if (!options.contentLength) headers['Transfer-Encoding'] = 'chunked';

  const user = kc.getCurrentUser();
  if (user?.token) headers['Authorization'] = `Bearer ${user.token}`;

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
  const t0 = Date.now();
  const directUrl = await resolveFmServiceUrl(k8sClients, namespace);
  let probeMs = 0;
  let ensureMs = 0;
  let waitMs = 0;

  if (!hot) {
    // Phase 5: probe-first. With N platform-api replicas, the per-
    // process cache only helps 1/N of requests. Probing FM /health
    // via cluster DNS catches the common case (FM healthy, just not
    // observed by this replica yet) in ~5-30ms instead of ~1.5-3s.
    let probedOk = false;
    if (directUrl) {
      const tp0 = Date.now();
      probedOk = await probeFmHealth(directUrl);
      probeMs = Date.now() - tp0;
      if (probedOk) cacheReady(namespace);
    }

    if (!probedOk) {
      // Slow path: FM not reachable — reconcile (deploy/scale/wait).
      const t1 = Date.now();
      await ensureFileManagerRunning(k8sClients, namespace, image, 1);
      ensureMs = Date.now() - t1;
      const t2 = Date.now();
      const status = await waitForReady(k8sClients, namespace);
      waitMs = Date.now() - t2;
      if (!status.ready) {
        throw new Error(`File manager not ready: ${status.message}`);
      }
      cacheReady(namespace);
    }
  }

  const t4 = Date.now();
  const result = await proxyToFileManager(kubeconfigPath, namespace, sidecarPath, {
    ...options,
    ...(directUrl ? { directUrl } : {}),
  });
  const t5 = Date.now();
  // eslint-disable-next-line no-console
  console.log(`[fm-bench] ns=${namespace} hot=${hot} probe=${probeMs}ms ensure=${ensureMs}ms wait=${waitMs}ms proxy=${t5 - t4}ms direct=${!!directUrl} total=${t5 - t0}ms`);

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
  image = 'file-manager-sidecar:latest',
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
