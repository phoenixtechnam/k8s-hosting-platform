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
    incomingStream.pipe(req);

    // If incoming stream is destroyed (client abort), destroy the proxy request too
    incomingStream.on('error', () => req.destroy());
    incomingStream.on('close', () => {
      if (!req.writableEnded) req.destroy();
    });
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
  } = {},
): Promise<ProxyResult> {
  // Ensure deployed
  await ensureFileManagerRunning(k8sClients, namespace, image);

  // Wait for ready
  const status = await waitForReady(k8sClients, namespace);
  if (!status.ready) {
    throw new Error(`File manager not ready: ${status.message}`);
  }

  // Proxy the request
  return proxyToFileManager(kubeconfigPath, namespace, sidecarPath, options);
}

export { ensureFileManagerRunning, getFileManagerStatus, stopFileManager } from './k8s-lifecycle.js';
