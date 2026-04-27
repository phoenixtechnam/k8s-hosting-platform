import * as k8s from '@kubernetes/client-node';
import { ensureFileManagerRunning, getFileManagerStatus } from './k8s-lifecycle.js';
import type { K8sClients } from '../k8s-provisioner/k8s-client.js';
import type { FileManagerStatus } from '@k8s-hosting/api-contracts';

const FM_SERVICE = 'file-manager';
const FM_PORT = 8111;
const STARTUP_TIMEOUT_MS = 30_000;
const POLL_INTERVAL_MS = 1_000;

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
  } = {},
): Promise<ProxyResult> {
  const kc = loadKubeConfig(kubeconfigPath);
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error('No active cluster in kubeconfig');

  // Build the proxy path
  const queryStr = options.query
    ? '?' + new URLSearchParams(options.query).toString()
    : '';
  const proxyPath = `/api/v1/namespaces/${namespace}/services/${FM_SERVICE}:${FM_PORT}/proxy${sidecarPath}${queryStr}`;

  // Extract TLS options (client certs) from kubeconfig
  const httpsOpts = {} as { ca?: string; cert?: string; key?: string; headers?: Record<string, string> };
  await kc.applyToHTTPSOptions(httpsOpts);

  const headers: Record<string, string> = { ...(httpsOpts.headers ?? {}) };
  if (options.contentType) headers['Content-Type'] = options.contentType;
  if (options.platformInternal) {
    // The sidecar compares this with PLATFORM_INTERNAL_SECRET using
    // constant-time equality. If the env var is unset on either
    // side, the sidecar fails closed — hidden paths become
    // unreachable until an operator injects the secret.
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

  // Use https module for proper client cert support
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
      rejectUnauthorized: false, // k3s self-signed
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
  // Ensure deployed AND scaled up. The provisioner creates the FM
  // Deployment with replicas=0 so it doesn't fight the workload's
  // RWO PVC at provision time (Multi-Attach). Pass initialReplicas=1
  // so /files/start (and the proxy path) bring it up on demand.
  await ensureFileManagerRunning(k8sClients, namespace, image, 1);

  // Wait for ready
  const status = await waitForReady(k8sClients, namespace);
  if (!status.ready) {
    throw new Error(`File manager not ready: ${status.message}`);
  }

  // Proxy the request
  return proxyToFileManager(kubeconfigPath, namespace, sidecarPath, options);
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
