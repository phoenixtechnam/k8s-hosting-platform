/**
 * Phase 3 (post-Phase-3 hardening): Stalwart admin proxy.
 *
 * The platform admin panel needs visibility into:
 *   - Stalwart's outbound queue (for stuck-message debugging)
 *   - Stalwart's runtime metrics (deliveries, AUTH failures, queue size)
 *
 * Stalwart exposes both via its admin HTTP API on port 8080
 * (`/metrics/prometheus` for OpenMetrics + `/api/queue/messages` for
 * the queue). The backend proxies these via the k8s API server's
 * service-proxy (same pattern as backend/src/modules/file-manager/),
 * so no NodePort exposure is required and the existing platform-api
 * RBAC (services verbs="*") covers it.
 *
 * For the lightweight operator UI we don't ship a full Prometheus +
 * Grafana stack — instead we parse the OpenMetrics output server-side
 * and surface a small JSON summary that the admin panel renders as
 * cards. Operators who want full historical data can still scrape
 * Stalwart directly with prometheus-operator + a ServiceMonitor.
 */

import * as k8s from '@kubernetes/client-node';

const STALWART_NAMESPACE = 'mail';
// stalwart-mail (the LoadBalancer Service) only exposes mail
// listener ports. The management HTTP API on 8080 is on a separate
// ClusterIP Service named stalwart-mail-mgmt — see
// k8s/base/stalwart/service.yaml.
//
// The k8s service-proxy URL accepts either the port NUMBER or the
// port NAME after the colon. We use the name (`mgmt-http`) so the
// proxy works regardless of any future port-number reshuffle.
const STALWART_MGMT_SERVICE = 'stalwart-mail-mgmt';
const STALWART_MGMT_PORT_NAME = 'mgmt-http';
// Stalwart runs as a single-replica StatefulSet, so the deterministic
// pod-0 name is stable. resolveStalwartPodName() falls back to a
// label-selector lookup if the constant is wrong (e.g. after a rename
// or scale).
const STALWART_DEFAULT_POD = 'stalwart-mail-0';
const STALWART_POD_LABEL_SELECTOR = 'app=stalwart-mail';

interface ProxyResult {
  readonly status: number;
  readonly body: string;
}

function loadKubeConfig(kubeconfigPath?: string): k8s.KubeConfig {
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) {
    kc.loadFromFile(kubeconfigPath);
  } else {
    kc.loadFromCluster();
  }
  return kc;
}

function adminAuth(): string {
  const pw =
    process.env.STALWART_ADMIN_PASSWORD ??
    process.env.STALWART_ADMIN_SECRET_PLAIN ??
    process.env.ADMIN_SECRET_PLAIN;
  if (!pw) {
    throw new Error(
      'Stalwart admin password is required (set STALWART_ADMIN_PASSWORD or ADMIN_SECRET_PLAIN)',
    );
  }
  return Buffer.from(`admin:${pw}`).toString('base64');
}

/**
 * Proxy a GET to Stalwart's management HTTP API via the k8s service
 * proxy. Returns the raw response body and status; callers parse it.
 */
export async function proxyStalwartGet(
  kubeconfigPath: string | undefined,
  path: string,
): Promise<ProxyResult> {
  const kc = loadKubeConfig(kubeconfigPath);
  const cluster = kc.getCurrentCluster();
  if (!cluster) throw new Error('No active cluster in kubeconfig');

  const proxyPath = `/api/v1/namespaces/${STALWART_NAMESPACE}/services/${STALWART_MGMT_SERVICE}:${STALWART_MGMT_PORT_NAME}/proxy${path}`;

  const httpsOpts = {} as { ca?: string; cert?: string; key?: string; headers?: Record<string, string> };
  await kc.applyToHTTPSOptions(httpsOpts);

  const headers: Record<string, string> = {
    ...(httpsOpts.headers ?? {}),
    Authorization: `Basic ${adminAuth()}`,
    Accept: 'application/json, text/plain',
  };

  const user = kc.getCurrentUser();
  if (user?.token) headers['Authorization-K8s'] = `Bearer ${user.token}`;
  // Note: applyToHTTPSOptions already sets the K8s Authorization
  // header if the kubeconfig uses bearer-token auth. We add the
  // Stalwart Basic Auth header above on TOP of that — the k8s API
  // server forwards it through the proxy untouched.

  const { default: https } = await import('node:https');

  return new Promise((resolve, reject) => {
    const fullUrl = new URL(`${cluster.server}${proxyPath}`);
    // applyToHTTPSOptions populates `httpsOpts.ca` from the
    // kubeconfig's certificate-authority-data, so we trust the
    // k3s self-signed CA via the proper chain validation rather
    // than disabling verification entirely. This carries the
    // Authorization: Basic header for Stalwart through the k8s
    // API service-proxy, so MITM resistance is critical.
    const req = https.request({
      hostname: fullUrl.hostname,
      port: fullUrl.port || 443,
      path: fullUrl.pathname + fullUrl.search,
      method: 'GET',
      headers,
      ca: httpsOpts.ca,
      cert: httpsOpts.cert,
      key: httpsOpts.key,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode ?? 500,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Prometheus parser ───────────────────────────────────────────────────

export interface PromMetric {
  readonly type: 'counter' | 'gauge' | 'untyped';
  readonly help: string;
  readonly value: number;
}

export type PromMetrics = Record<string, PromMetric>;

/**
 * Minimal Prometheus text format parser. Aggregates labeled metrics
 * by summing all label permutations (so e.g.
 * `auth_failures_total{listener="submission"} 3` and
 * `auth_failures_total{listener="submissions"} 5` collapse to a
 * single `auth_failures_total: 8` entry).
 *
 * This is intentionally simple — we don't ship a full Prometheus
 * client because the backend just needs a few headline counters for
 * the admin UI cards. For full per-label series, prometheus-operator
 * is the right tool.
 */
export function parsePrometheusToJson(text: string): PromMetrics {
  const out: Record<string, { type: 'counter' | 'gauge' | 'untyped'; help: string; value: number }> = {};
  const helpByName: Record<string, string> = {};
  const typeByName: Record<string, 'counter' | 'gauge' | 'untyped'> = {};

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith('# HELP ')) {
      const rest = line.slice(7);
      const sp = rest.indexOf(' ');
      if (sp > 0) {
        helpByName[rest.slice(0, sp)] = rest.slice(sp + 1);
      }
      continue;
    }
    if (line.startsWith('# TYPE ')) {
      const rest = line.slice(7);
      const sp = rest.indexOf(' ');
      if (sp > 0) {
        const t = rest.slice(sp + 1).trim();
        if (t === 'counter' || t === 'gauge' || t === 'untyped') {
          typeByName[rest.slice(0, sp)] = t;
        }
      }
      continue;
    }
    if (line.startsWith('#')) continue;

    // metric_name{labels} value  OR  metric_name value
    let nameEnd = line.indexOf('{');
    if (nameEnd === -1) nameEnd = line.indexOf(' ');
    if (nameEnd <= 0) continue;
    const name = line.slice(0, nameEnd);
    // Find the value as the last whitespace-separated token
    const valueStr = line.slice(line.lastIndexOf(' ') + 1);
    const value = parseFloat(valueStr);
    if (!Number.isFinite(value)) continue;

    const existing = out[name];
    if (existing) {
      out[name] = { ...existing, value: existing.value + value };
    } else {
      out[name] = {
        type: typeByName[name] ?? 'untyped',
        help: helpByName[name] ?? '',
        value,
      };
    }
  }
  return out;
}

// ─── Headline summary ────────────────────────────────────────────────────

export interface MailMetricsSummary {
  readonly messagesReceived: number;
  readonly messagesDelivered: number;
  readonly messagesFailed: number;
  readonly imapConnections: number;
  readonly queueSize: number;
  readonly uptimeSeconds: number;
}

function metricValue(parsed: PromMetrics, names: readonly string[]): number {
  for (const n of names) {
    const m = parsed[n];
    if (m) return m.value;
  }
  return 0;
}

/**
 * Roll up the verbose Prometheus output into the small JSON the
 * admin panel needs. Tries multiple metric name candidates so we
 * don't break if Stalwart renames a counter between releases.
 */
export function summarizeMailMetrics(parsed: PromMetrics): MailMetricsSummary {
  return {
    messagesReceived: metricValue(parsed, [
      'stalwart_smtp_messages_received_total',
      'stalwart_smtp_messages_total',
      'stalwart_messages_received',
    ]),
    messagesDelivered: metricValue(parsed, [
      'stalwart_smtp_messages_delivered_total',
      'stalwart_delivery_attempts_succeeded_total',
    ]),
    messagesFailed: metricValue(parsed, [
      'stalwart_smtp_messages_failed_total',
      'stalwart_delivery_attempts_failed_total',
    ]),
    imapConnections: metricValue(parsed, [
      'stalwart_imap_connections',
      'stalwart_imap_connections_active',
    ]),
    queueSize: metricValue(parsed, [
      'stalwart_queue_size',
      'stalwart_queue_messages',
    ]),
    uptimeSeconds: metricValue(parsed, [
      'stalwart_uptime_seconds',
      'process_uptime_seconds',
    ]),
  };
}

// ─── Public service entry points ─────────────────────────────────────────

export async function getMailMetrics(
  kubeconfigPath: string | undefined,
): Promise<{ summary: MailMetricsSummary; raw: PromMetrics }> {
  const result = await proxyStalwartGet(kubeconfigPath, '/metrics/prometheus');
  if (result.status >= 400) {
    throw new Error(
      `Stalwart metrics endpoint returned ${result.status}: ${result.body.slice(0, 200)}`,
    );
  }
  const raw = parsePrometheusToJson(result.body);
  return { summary: summarizeMailMetrics(raw), raw };
}

export interface QueueMessagesResponse {
  readonly status: number;
  readonly raw: unknown;
}

/**
 * Fetch the current queue contents from Stalwart by exec'ing
 * `stalwart-cli queue list` inside the running stalwart-mail-0 pod
 * and parsing its output.
 *
 * Why exec instead of the k8s service-proxy? The metrics endpoint
 * (`/metrics/prometheus`) is unauthenticated so it works through the
 * service-proxy fine. The queue API (`/api/queue/messages`) requires
 * Basic Auth, but the k8s API server's service-proxy STRIPS the
 * `Authorization` header (it uses the same header for its own auth)
 * — so we can never forward Stalwart credentials through it. The
 * exec path uses Stalwart's own ADMIN_SECRET_PLAIN env var inside
 * the pod, so the cleartext never leaves the cluster.
 */
async function resolveStalwartPodName(kc: k8s.KubeConfig): Promise<string> {
  // Try the deterministic StatefulSet name first — this is the
  // common case and skips an extra API call.
  const core = kc.makeApiClient(k8s.CoreV1Api);
  try {
    await (core as unknown as {
      readNamespacedPod: (args: { name: string; namespace: string }) => Promise<unknown>;
    }).readNamespacedPod({ name: STALWART_DEFAULT_POD, namespace: STALWART_NAMESPACE });
    return STALWART_DEFAULT_POD;
  } catch {
    // Fall through to label-selector lookup.
  }
  const list = await (core as unknown as {
    listNamespacedPod: (args: { namespace: string; labelSelector: string }) => Promise<{
      items: { metadata?: { name?: string }; status?: { phase?: string } }[];
    }>;
  }).listNamespacedPod({
    namespace: STALWART_NAMESPACE,
    labelSelector: STALWART_POD_LABEL_SELECTOR,
  });
  const running = (list.items ?? []).find((p) => p.status?.phase === 'Running');
  if (!running?.metadata?.name) {
    throw new Error(
      `No running Stalwart pod found in namespace '${STALWART_NAMESPACE}' (label: ${STALWART_POD_LABEL_SELECTOR})`,
    );
  }
  return running.metadata.name;
}

export async function getMailQueue(
  kubeconfigPath: string | undefined,
): Promise<QueueMessagesResponse> {
  const kc = loadKubeConfig(kubeconfigPath);
  const exec = new k8s.Exec(kc);
  const podName = await resolveStalwartPodName(kc);

  const { Writable } = await import('node:stream');
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  const stdout = new Writable({
    write(chunk, _enc, cb) {
      stdoutChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      cb();
    },
  });
  const stderr = new Writable({
    write(chunk, _enc, cb) {
      stderrChunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      cb();
    },
  });

  // Run stalwart-cli with the cleartext admin password from the pod's
  // own env. Single-quoted shell prevents the platform-side process
  // from ever touching the cleartext.
  const cmd = [
    'sh',
    '-c',
    'stalwart-cli --url http://127.0.0.1:8080 --credentials "admin:${ADMIN_SECRET_PLAIN}" queue list',
  ];

  await new Promise<void>((resolve, reject) => {
    exec.exec(
      STALWART_NAMESPACE,
      podName,
      'stalwart',
      cmd,
      stdout,
      stderr,
      null,
      false,
      (status) => {
        if (status?.status === 'Success') {
          resolve();
        } else {
          // Wrap the raw status in a generic error so the route
          // can decide what to surface to the client. The full
          // status object is logged separately by the caller.
          const e = new Error('stalwart-cli queue list exec failed') as Error & {
            details?: unknown;
          };
          e.details = status;
          reject(e);
        }
      },
    ).catch(reject);
  });

  const stdoutText = Buffer.concat(stdoutChunks).toString('utf-8');
  const stderrText = Buffer.concat(stderrChunks).toString('utf-8');

  // stalwart-cli queue list output formats:
  //   "0 queued message(s) found."        when empty (written to stderr)
  //   table with id / sender / etc.        when non-empty (written to stdout)
  // The empty-state message goes to stderr, which is not actually
  // an error — it's how stalwart-cli reports "no rows" in v0.15.5.
  // The admin UI parses both fields; we just provide a convenient
  // boolean for the empty case.
  const combined = `${stdoutText}\n${stderrText}`;
  return {
    status: 200,
    raw: {
      output: stdoutText,
      // stderr only included if non-empty AND not the empty-state msg
      errors: stderrText && !stderrText.includes('0 queued message')
        ? stderrText
        : undefined,
      empty: /0 queued message/.test(combined),
    },
  };
}
