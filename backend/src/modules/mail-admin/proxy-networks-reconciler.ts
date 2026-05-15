/**
 * Proxy-trusted-networks reconciler — keeps Stalwart's global
 * `SystemSettings.proxyTrustedNetworks` map in sync with the set of
 * server-role node IPs (the source addresses haproxy DaemonSet pods
 * will use, since they run hostNetwork).
 *
 * Why this exists:
 *   When mailPortExposureMode flips to 'allServerNodes', haproxy pods on
 *   each server node accept mail connections, write a PROXY-v2 header
 *   carrying the real client IP, and forward to stalwart-mail.mail.svc.
 *   Stalwart must trust those source addresses to honor the PROXY-v2
 *   header — that trust list is `proxyTrustedNetworks` on the singleton
 *   SystemSettings record (applied to every mail listener uniformly;
 *   the per-listener `overrideProxyTrustedNetworks` field is left
 *   untouched).
 *
 *   Setting the trust list to 0.0.0.0/0 would let any internet attacker
 *   spoof source IPs via PROXY-v2 and defeat Stalwart's IP rate-limiter.
 *   So the list is narrowed to the actual haproxy sources: the server
 *   nodes' kubelet InternalIPs (`/32` each).
 *
 *   We also append the same IPs to x:AllowedIp so cluster IPs are never
 *   subject to Stalwart's connection/login rate-limits even if PROXY-v2
 *   unwrap ever fails — belt-and-suspenders against blocking the cluster
 *   itself when an external user misbehaves.
 *
 *   The reconciler runs in both 'thisNodeOnly' and 'allServerNodes' modes
 *   (per operator request) so we don't have to re-patch settings every
 *   time the mode flips.
 *
 * Tick cadence: 60s (matches the certificate reconciler). Empty node
 * sets are NEVER pushed; if the node listing fails or returns zero
 * server-role nodes, the tick logs a warning and waits for the next
 * cycle. The trust list is never blown away.
 */

import { readStalwartCredentials } from './credentials.js';

type CoreV1Api = import('@kubernetes/client-node').CoreV1Api;

/** Default tick: 60s — same cadence as certificate reconciler. */
export const PROXY_NETWORKS_RECONCILER_TICK_MS = 60_000;

/** Server-role node label — matches placement.ts. */
const SERVER_ROLE_LABEL_KEY = 'platform.phoenix-host.net/node-role';
const SERVER_ROLE_LABEL_VALUE = 'server';

/** JMAP capability URIs (mirrors stalwart-jmap/client.ts). */
const JMAP_CORE = 'urn:ietf:params:jmap:core';
const JMAP_STALWART = 'urn:stalwart:jmap';

/** Stalwart admin account ID — fixed constant set by bootstrap. */
const ADMIN_ACCOUNT_ID = 'd333333';

/** Per-request timeout for JMAP calls in the reconciler. */
const JMAP_TIMEOUT_MS = 10_000;

/**
 * Stalwart mgmt URL. The platform-api Pod reaches Stalwart via the
 * in-cluster service DNS, which bypasses kube-apiserver's SA-token auth
 * (the `Authorization: Basic` header collides with SA bearer tokens).
 */
const STALWART_MGMT_URL =
  process.env.STALWART_MGMT_URL ?? 'http://stalwart-mgmt.mail.svc.cluster.local:8080';

export interface ProxyNetworksReconcilerDeps {
  readonly core: CoreV1Api;
  /**
   * Kubeconfig path for the exec-into-Stalwart-pod transport. Passed
   * through to `KubeConfig.loadFromFile`; falls back to
   * `loadFromCluster` when undefined. The reconciler exec's `curl
   * http://127.0.0.1:8080/jmap/` inside the Stalwart pod because
   * Stalwart 0.16's HTTP listener does PROXY-v2 sniffing on every
   * non-loopback connection — see jmapPost() comment.
   */
  readonly kubeconfigPath?: string;
  readonly tickMs?: number;
  readonly logger?: {
    warn: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
  };
  /**
   * Override for tests — defaults to STALWART_MGMT_URL. Kept for
   * forward-compat with a future Stalwart release that ships a
   * `disableProxyProtocolSniffing` per-listener option; the reconciler
   * could revert to plain HTTP and this URL would become live again.
   */
  readonly stalwartMgmtUrl?: string;
  /** Override for tests — defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
  /**
   * Optional JMAP transport injection (for unit tests). When provided,
   * bypasses pod-discovery + kubectl-exec entirely and routes calls
   * through the supplied function. Production callers do NOT set this.
   */
  readonly jmapTransport?: (
    auth: string,
    body: unknown,
  ) => Promise<JmapInvocationResponse>;
}

/**
 * Start the proxy-networks reconciler. Returns a stop function compatible
 * with `app.addHook('onClose', () => stop())`.
 */
export function startProxyNetworksReconciler(
  deps: ProxyNetworksReconcilerDeps,
): () => void {
  const tickMs = deps.tickMs ?? PROXY_NETWORKS_RECONCILER_TICK_MS;
  // Run one tick immediately on start to fix drift left over from a
  // platform-api restart.
  void runProxyNetworksReconcilerTick(deps);
  const timer = setInterval(() => void runProxyNetworksReconcilerTick(deps), tickMs);
  return () => clearInterval(timer);
}

/**
 * One tick of the reconciler. Exported for unit-testability.
 *
 * Steps:
 *   1. Enumerate server-role node InternalIPs from the K8s API.
 *   2. GET x:SystemSettings/singleton — UPDATE proxyTrustedNetworks if it
 *      differs from the expected per-node IP set.
 *   3. GET x:AllowedIp — CREATE entries for any cluster IPs not already
 *      present (ownership by address; existing entries are never touched).
 *
 * Never throws — any error is logged and the tick returns. A subsequent
 * tick will retry.
 */
export async function runProxyNetworksReconcilerTick(
  deps: ProxyNetworksReconcilerDeps,
): Promise<void> {
  const log = deps.logger ?? {
    warn: (...args: unknown[]) => console.warn('[proxy-networks-reconciler]', ...args),
    info: (...args: unknown[]) => console.info('[proxy-networks-reconciler]', ...args),
  };

  let serverNodes: ReadonlyArray<{ hostname: string; ip: string }>;
  try {
    serverNodes = await listServerNodeIps(deps.core);
  } catch (err) {
    log.warn('Failed to list server-role nodes — skipping tick:', err);
    return;
  }

  if (serverNodes.length === 0) {
    // Empty server-node set is a transient anomaly (cluster being
    // re-labeled, controller-manager race, etc). Skipping rather than
    // pushing an empty proxyNetworks map preserves the current trust
    // list until the next tick has real data.
    log.warn('No server-role nodes found — skipping (will retry).');
    return;
  }

  // Stalwart stores bare-IP keys for /32-equivalent entries (it strips
  // the suffix on storage), so we write what we'll read back. Wider CIDRs
  // would be preserved verbatim, but server-role node InternalIPs are
  // always individual hosts.
  //
  // **Per-listener trust architecture** (Phase 11 streamline, 2026-05-15):
  //
  // Until PR #57 surfaced Bug F, this reconciler set
  // `SystemSettings.proxyTrustedNetworks` GLOBALLY with cluster CIDRs +
  // server node IPs. That worked for mail listener PROXY-v2 forwarding
  // from haproxy, but it ALSO caused Stalwart to PROXY-v2-sniff HTTP
  // listeners (mgmt :8080 and http-acme :80). Any non-loopback connection
  // from a cluster-CIDR source (platform-api → mgmt, Traefik → http-acme
  // for ACME HTTP-01) was rejected with "invalid proxy header".
  //
  // Fix: split trust by listener protocol.
  //   - global `proxyTrustedNetworks` = {} (empty)
  //   - mail listener override = cluster CIDRs + node IPs (PROXY-v2 from
  //     haproxy honored)
  //   - http listener override = {} (inherits empty global → no sniff,
  //     plain HTTP from platform-api / Traefik works)
  //
  // Verified on staging.phoenix-host.net 2026-05-15: with this layout,
  //   cross-pod plain HTTP to mgmt:8080 succeeds (HTTP 200 JMAP session),
  //   and an external GET to http://mail.staging.../.well-known/acme-
  //   challenge/* returns 404 cleanly (no connection reset).
  //
  // CRITICAL: trust changes require Stalwart pod RESTART (or wait until
  // the listener is naturally re-bound). `x:Action/set ReloadSettings`
  // is NOT sufficient — Stalwart caches the trust list at listener-init
  // time in 0.16. The reconciler tolerates a stale pod for the duration
  // of one tick; operators can force a faster update by `kubectl rollout
  // restart deploy/stalwart-mail` after a node-IP change.
  const expectedProxyNetworks: Record<string, boolean> = {
    '10.42.0.0/16': true,
    '10.43.0.0/16': true,
  };
  for (const node of serverNodes) {
    expectedProxyNetworks[node.ip] = true;
  }

  /**
   * Per-listener override map: same trust list as `expectedProxyNetworks`
   * for mail listeners; empty for everything else (http etc).
   */
  const expectedMailListenerOverride: Record<string, boolean> = { ...expectedProxyNetworks };
  const expectedHttpListenerOverride: Record<string, boolean> = {};

  const env = deps.env ?? process.env;

  let auth: string;
  try {
    const { username, password } = readStalwartCredentials(env);
    auth = `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`;
  } catch (err) {
    // Creds not mounted yet — silently skip. Bootstrap will mount them
    // and the next tick will succeed.
    log.warn('Stalwart admin creds not available — skipping tick:', err);
    return;
  }

  // Build the JMAP transport. Tests inject a stub via `deps.jmapTransport`;
  // production discovers a Running Stalwart pod and exec's curl inside it
  // (only way to bypass Stalwart 0.16's PROXY-v2 sniffing — see jmapPost()).
  let jmapCall: (auth: string, body: unknown) => Promise<JmapInvocationResponse>;
  if (deps.jmapTransport) {
    jmapCall = deps.jmapTransport;
  } else {
    const podName = await findStalwartPodName(deps.core);
    if (!podName) {
      log.warn('No Running Stalwart pod found — skipping tick (will retry).');
      return;
    }
    const transport: ExecTransport = {
      core: deps.core,
      podName,
      kubeconfigPath: deps.kubeconfigPath,
    };
    jmapCall = (a, b) => jmapPost(transport, a, b);
  }

  // ── Step 1: global SystemSettings.proxyTrustedNetworks → empty ───────
  // See architectural rationale above. We keep this call so any stale
  // entries (e.g. from a prior reconciler version) get cleared exactly
  // once and stay clear.
  try {
    await reconcileSystemProxyTrustedNetworks(
      jmapCall,
      auth,
      {}, // empty — per-listener overrides own the trust now
      log,
    );
  } catch (err) {
    log.warn('SystemSettings.proxyTrustedNetworks reconcile failed:', err);
  }

  // ── Step 2: per-listener overrideProxyTrustedNetworks ────────────────
  // Mail protocols (smtp/imap/manageSieve/pop3) get the full trust list;
  // http (and any other) protocols get an empty override so they inherit
  // the empty global → no PROXY-v2 sniff on HTTP connections.
  try {
    await reconcileListenerProxyTrustedNetworks(
      jmapCall,
      auth,
      expectedMailListenerOverride,
      expectedHttpListenerOverride,
      log,
    );
  } catch (err) {
    log.warn('NetworkListener.overrideProxyTrustedNetworks reconcile failed:', err);
  }

  // ── Step 3: reconcile x:AllowedIp for cluster-IP rate-limit safety ─
  try {
    await reconcileAllowedIps(
      jmapCall,
      auth,
      serverNodes,
      log,
    );
  } catch (err) {
    log.warn('AllowedIp reconcile failed:', err);
  }
}

// ── Internal: server-node enumeration ────────────────────────────────

/**
 * List the server-role nodes (`platform.phoenix-host.net/node-role=server`)
 * and return their primary InternalIP. Nodes without an InternalIP are
 * skipped (kubelet should always report one for a healthy node).
 */
export async function listServerNodeIps(
  core: CoreV1Api,
): Promise<ReadonlyArray<{ hostname: string; ip: string }>> {
  type NodeShape = {
    metadata?: { labels?: Record<string, string>; name?: string };
    status?: {
      addresses?: Array<{ type: string; address: string }>;
      conditions?: Array<{ type: string; status: string }>;
    };
  };
  // Push-down: ask the API server for server-role nodes only. This avoids
  // pulling worker nodes (and any future role labels) into the response,
  // which would over-fetch on larger clusters. We still re-check the label
  // client-side below as a defense in depth.
  const list = (await core.listNode({
    labelSelector: `${SERVER_ROLE_LABEL_KEY}=${SERVER_ROLE_LABEL_VALUE}`,
  })) as { items?: NodeShape[] };
  const out: Array<{ hostname: string; ip: string }> = [];
  const seenHostnames = new Set<string>();
  for (const n of list.items ?? []) {
    if (n.metadata?.labels?.[SERVER_ROLE_LABEL_KEY] !== SERVER_ROLE_LABEL_VALUE) continue;
    const hostname =
      n.metadata?.labels?.['kubernetes.io/hostname'] ?? n.metadata?.name ?? '';
    if (!hostname) continue;
    // Reject duplicates rather than silently overwriting (would shrink the
    // trust list and bypass the never-push-empty guard on the next tick).
    if (seenHostnames.has(hostname)) continue;
    const internal = n.status?.addresses?.find((a) => a.type === 'InternalIP')?.address;
    if (!internal) continue;
    // Reject obviously bogus addresses that would be unsafe in proxyNetworks
    // (loopback can never be a haproxy source IP on a real cluster).
    if (internal === '127.0.0.1' || internal === '0.0.0.0' || internal === '::1') continue;
    seenHostnames.add(hostname);
    out.push({ hostname, ip: internal });
  }
  // Deterministic order helps log diffs and tests.
  return out.sort((a, b) => a.hostname.localeCompare(b.hostname));
}

// ── Internal: JMAP plumbing ──────────────────────────────────────────

interface JmapInvocationResponse {
  readonly methodResponses: ReadonlyArray<[string, Record<string, unknown>, string]>;
}

/**
 * Stalwart-mgmt transport.
 *
 * **Why this is exec-based, not fetch:** Stalwart 0.16's HTTP listener at
 * `:8080` does PROXY-v2 sniffing on every incoming connection whose source
 * IP is in `SystemSettings.proxyTrustedNetworks`. Since the Phase 1
 * streamline put the cluster pod/service CIDRs (10.42.0.0/16 + 10.43.0.0/16)
 * into that trust list — necessary for haproxy DS forwarding mail traffic
 * with PROXY-v2 — cross-pod plain HTTP from platform-api to
 * `stalwart-mgmt.mail.svc:8080` is silently rejected ("invalid proxy
 * header" in the Stalwart log, "fetch failed cause=other side closed"
 * from Node.js). Per-listener `overrideProxyTrustedNetworks` does NOT
 * disable the sniffing in 0.16 — it only refines trust decisions after
 * the sniff. The only source IP that bypasses the sniff is 127.0.0.1.
 *
 * So the reconciler exec's into the Stalwart pod and runs `curl` against
 * 127.0.0.1:8080. Loopback bypasses the PROXY-v2 sniff. This is the same
 * pattern used by the kubelet exec liveness probe (see
 * k8s/base/stalwart-mail/stalwart/deployment.yaml). The cost is roughly
 * 200ms per JMAP call (exec stream setup + curl) — well within the 60s
 * tick budget.
 *
 * If Stalwart upstream gains a `disableProxyProtocolSniffing` per-listener
 * option, replace this helper with a plain `fetch` to make the reconciler
 * snappier. The existing `STALWART_MGMT_URL` constant captures the URL
 * for that future direct-HTTP path.
 */
interface ExecTransport {
  readonly core: CoreV1Api;
  readonly podName: string;
  readonly kubeconfigPath: string | undefined;
}

/**
 * Find a Running Stalwart mail pod. Returns null if none — the reconciler
 * tick logs a warn + skips.
 */
async function findStalwartPodName(core: CoreV1Api): Promise<string | null> {
  try {
    const pods = await core.listNamespacedPod({
      namespace: 'mail',
      labelSelector: 'app=stalwart-mail',
    }) as {
      items?: Array<{
        metadata?: { name?: string };
        status?: { phase?: string; containerStatuses?: Array<{ ready?: boolean; name?: string }> };
      }>;
    };
    for (const p of pods.items ?? []) {
      if (p.status?.phase !== 'Running') continue;
      const ready = p.status?.containerStatuses?.find((c) => c.name === 'stalwart')?.ready;
      if (ready && p.metadata?.name) return p.metadata.name;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Exec curl inside the Stalwart pod and capture stdout. Wraps the raw
 * `@kubernetes/client-node` Exec stream API. Auth uses the recovery
 * password (which Stalwart accepts identically to adminPassword for
 * mgmt-level operations) so the reconciler doesn't have to find or
 * rotate the adminPassword separately.
 */
async function execCurlInStalwartPod(
  transport: ExecTransport,
  auth: string,
  body: unknown,
): Promise<string> {
  const { Exec, KubeConfig } = await import('@kubernetes/client-node');
  const { Writable } = await import('node:stream');
  const kc = new KubeConfig();
  if (transport.kubeconfigPath) kc.loadFromFile(transport.kubeconfigPath);
  else kc.loadFromCluster();
  const exec = new Exec(kc);

  const bodyJson = JSON.stringify(body);
  // curl args:
  //   -sf        → silent + fail-on-HTTP-error (4xx/5xx → curl exit 22)
  //   --max-time → bound the request
  //   -H Auth   → Basic creds via STDIN-piped body? No — pass via -H
  //   -d @-     → read body from stdin to avoid encoding the JSON in argv
  //               (Stalwart admin password may contain shell metacharacters
  //               if it ever changes; -d @- side-steps argv escaping)
  const args = [
    'curl',
    '-sf',
    '--max-time', String(Math.floor(JMAP_TIMEOUT_MS / 1000)),
    '-H', `Authorization: ${auth}`,
    '-H', 'Content-Type: application/json',
    '-H', 'Accept: application/json',
    '-X', 'POST',
    '--data-binary', '@-',
    'http://127.0.0.1:8080/jmap/',
  ];

  let stdout = '';
  let stderr = '';
  const stdoutSink = new Writable({
    write(chunk: Buffer, _enc, cb) { stdout += chunk.toString('utf8'); cb(); },
  });
  const stderrSink = new Writable({
    write(chunk: Buffer, _enc, cb) { stderr += chunk.toString('utf8'); cb(); },
  });

  // exec.exec returns a WebSocket-like handle whose `close` event resolves
  // the status callback we pass in. The body is fed via stdin (the 6th
  // arg, after stdoutSink/stderrSink).
  const { Readable } = await import('node:stream');
  const stdin = Readable.from(Buffer.from(bodyJson, 'utf8'));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Stalwart JMAP exec-curl timed out after ${JMAP_TIMEOUT_MS}ms`)),
      JMAP_TIMEOUT_MS + 5_000, // +5s grace beyond curl's own --max-time
    );
    exec.exec(
      'mail',
      transport.podName,
      'stalwart',
      args,
      stdoutSink,
      stderrSink,
      stdin,
      false,
      (status) => {
        clearTimeout(timer);
        if (status.status === 'Failure') {
          reject(
            new Error(
              `Stalwart JMAP exec-curl failed: ${status.message ?? 'unknown'} ` +
                `(stderr=${stderr.slice(0, 200)})`,
            ),
          );
        } else {
          resolve();
        }
      },
    ).catch(reject);
  });

  return stdout;
}

async function jmapPost(
  transport: ExecTransport,
  auth: string,
  body: unknown,
): Promise<JmapInvocationResponse> {
  const text = await execCurlInStalwartPod(transport, auth, body);
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Stalwart JMAP non-JSON response: ${text.slice(0, 200)}`);
  }
  if (
    !data ||
    typeof data !== 'object' ||
    !Array.isArray((data as { methodResponses?: unknown }).methodResponses)
  ) {
    throw new Error('Stalwart JMAP response missing methodResponses array');
  }
  return data as JmapInvocationResponse;
}

// ── Internal: SystemSettings reconcile ───────────────────────────────

/**
 * Patch the singleton SystemSettings record's `proxyTrustedNetworks` map.
 * Stalwart applies this trust list to every NetworkListener that lacks
 * its own `overrideProxyTrustedNetworks` (which, in this platform,
 * none do — we never set the per-listener override).
 */
async function reconcileSystemProxyTrustedNetworks(
  jmapCall: (auth: string, body: unknown) => Promise<JmapInvocationResponse>,
  auth: string,
  expected: Record<string, boolean>,
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): Promise<void> {
  const getRes = await jmapCall(auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      [
        'x:SystemSettings/get',
        { ids: ['singleton'], properties: ['proxyTrustedNetworks'] },
        'c0',
      ],
    ],
  });

  const args = getRes.methodResponses[0]?.[1] as { list?: unknown };
  const rawList: unknown = args?.list;
  if (!Array.isArray(rawList) || rawList.length === 0) {
    log.warn('x:SystemSettings/get returned no singleton — Stalwart bootstrap may not be complete yet.');
    return;
  }

  const current = (rawList[0] as { proxyTrustedNetworks?: Record<string, boolean> | null })
    .proxyTrustedNetworks;
  if (proxyNetworksMatches(current, expected)) return;

  const setRes = await jmapCall(auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      [
        'x:SystemSettings/set',
        {
          update: { singleton: { proxyTrustedNetworks: expected } },
        },
        'c0',
      ],
    ],
  });
  assertJmapSetSucceeded(setRes, 'x:SystemSettings/set');

  log.info(
    `Updated SystemSettings.proxyTrustedNetworks → ${Object.keys(expected).join(', ')}`,
  );
}

/**
 * Validate a JMAP `/set` response: rejects method-level error envelopes and
 * surfaces `notCreated` / `notUpdated` / `notDestroyed` maps as a thrown
 * error. Without this check, Stalwart can silently reject individual
 * writes (auth scope, schema mismatch, read-only state) while the HTTP
 * layer returns 200 — the reconciler would loop forever logging
 * "Updated ..." without actually changing the on-wire state. That drift
 * is security-relevant because proxyNetworks is the defense against
 * PROXY-v2 source-IP spoofing.
 */
function assertJmapSetSucceeded(
  res: JmapInvocationResponse,
  expectedMethod: string,
): void {
  const first = res.methodResponses[0];
  if (!first) {
    throw new Error(`${expectedMethod}: empty methodResponses`);
  }
  const [method, args] = first;
  if (method === 'error') {
    const errType = (args as { type?: unknown }).type;
    const errDesc = (args as { description?: unknown }).description;
    throw new Error(
      `${expectedMethod} returned method-level error: type=${String(errType)} desc=${String(errDesc)}`,
    );
  }
  if (method !== expectedMethod) {
    throw new Error(`${expectedMethod}: unexpected response method '${method}'`);
  }
  const notCreated = (args as { notCreated?: Record<string, unknown> | null }).notCreated;
  const notUpdated = (args as { notUpdated?: Record<string, unknown> | null }).notUpdated;
  const notDestroyed = (args as { notDestroyed?: Record<string, unknown> | null }).notDestroyed;
  const reasons: string[] = [];
  if (notCreated && Object.keys(notCreated).length > 0) {
    reasons.push(`notCreated=${JSON.stringify(notCreated).slice(0, 200)}`);
  }
  if (notUpdated && Object.keys(notUpdated).length > 0) {
    reasons.push(`notUpdated=${JSON.stringify(notUpdated).slice(0, 200)}`);
  }
  if (notDestroyed && Object.keys(notDestroyed).length > 0) {
    reasons.push(`notDestroyed=${JSON.stringify(notDestroyed).slice(0, 200)}`);
  }
  if (reasons.length > 0) {
    throw new Error(`${expectedMethod} partial failure: ${reasons.join('; ')}`);
  }
}

/**
 * Set-equal comparison of proxyTrustedNetworks key sets.
 *
 * Stalwart normalises CIDR keys on storage: bare-IPv4 hosts written as
 * `1.2.3.4/32` round-trip to `1.2.3.4` (the /32 suffix is dropped), while
 * non-/32 prefixes like `10.42.0.0/16` are preserved. Without
 * canonicalising both sides we'd patch every tick because what we wrote
 * (`1.2.3.4/32`) wouldn't match what we read (`1.2.3.4`).
 */
export function proxyNetworksMatches(
  current: Record<string, boolean> | null | undefined,
  expected: Record<string, boolean>,
): boolean {
  const canon = (k: string): string => k.endsWith('/32') ? k.slice(0, -3) : k;
  const currentKeys = current
    ? Object.keys(current).filter((k) => current[k] === true).map(canon)
    : [];
  const expectedKeys = Object.keys(expected).map(canon);
  if (currentKeys.length !== expectedKeys.length) return false;
  const set = new Set(currentKeys);
  for (const k of expectedKeys) {
    if (!set.has(k)) return false;
  }
  return true;
}

// ── Internal: NetworkListener.overrideProxyTrustedNetworks reconcile ─

/** Stalwart protocol categories — mail protocols get PROXY-v2 trust. */
const MAIL_PROTOCOLS = new Set(['smtp', 'imap', 'manageSieve', 'pop3']);

/**
 * For each NetworkListener, write the appropriate `overrideProxyTrustedNetworks`
 * map based on its `protocol`:
 *
 *   - Mail protocols (smtp/imap/manageSieve/pop3) → mail-trust (cluster
 *     CIDRs + node IPs)
 *   - Everything else (http and any future protocols) → empty map →
 *     inherits empty global → no PROXY-v2 sniff
 *
 * Idempotent — only writes a listener if its current override doesn't
 * match the expected map (per `proxyNetworksMatches`).
 *
 * Bulk-updates all changed listeners in a single x:NetworkListener/set
 * call to minimise round-trips. Stalwart's per-batch validation will
 * reject the whole batch if any individual listener update fails
 * (assertJmapSetSucceeded throws on `notUpdated`).
 */
async function reconcileListenerProxyTrustedNetworks(
  jmapCall: (auth: string, body: unknown) => Promise<JmapInvocationResponse>,
  auth: string,
  mailTrust: Record<string, boolean>,
  httpTrust: Record<string, boolean>,
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): Promise<void> {
  const getRes = await jmapCall(auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      [
        'x:NetworkListener/get',
        {
          accountId: ADMIN_ACCOUNT_ID,
          ids: null,
          properties: ['name', 'protocol', 'overrideProxyTrustedNetworks'],
        },
        'c0',
      ],
    ],
  });

  const args = getRes.methodResponses[0]?.[1] as { list?: unknown };
  const list = args?.list;
  if (!Array.isArray(list) || list.length === 0) {
    log.warn('x:NetworkListener/get returned no listeners — Stalwart may not be fully bootstrapped.');
    return;
  }

  type Listener = {
    id?: string;
    name?: string;
    protocol?: string;
    overrideProxyTrustedNetworks?: Record<string, boolean> | null;
  };

  const updates: Record<string, { overrideProxyTrustedNetworks: Record<string, boolean> }> = {};
  for (const l of list as Listener[]) {
    if (!l.id) continue;
    const expected = MAIL_PROTOCOLS.has(l.protocol ?? '') ? mailTrust : httpTrust;
    if (!proxyNetworksMatches(l.overrideProxyTrustedNetworks, expected)) {
      updates[l.id] = { overrideProxyTrustedNetworks: expected };
    }
  }

  if (Object.keys(updates).length === 0) return; // already in sync

  const setRes = await jmapCall(auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      ['x:NetworkListener/set', { accountId: ADMIN_ACCOUNT_ID, update: updates }, 'c0'],
    ],
  });
  assertJmapSetSucceeded(setRes, 'x:NetworkListener/set');

  log.info(
    `Updated NetworkListener.overrideProxyTrustedNetworks on ${Object.keys(updates).length} listener(s); ` +
      `mail-trust=${Object.keys(mailTrust).join(',')} http-trust=empty. ` +
      `NOTE: Stalwart caches the trust list at listener-init time; a pod ` +
      `restart may be needed for the change to take effect on existing connections.`,
  );
}

// ── Internal: AllowedIp reconcile ────────────────────────────────────

/**
 * Ensure each cluster server-role node IP is present in x:AllowedIp so it
 * is exempt from Stalwart's connection/login rate-limiter even if PROXY-v2
 * unwrap ever fails.
 *
 * Ownership model: we do NOT track entries by ID — Stalwart auto-generates
 * server-side IDs (e.g. `iqvat29iabae`) ignoring our create-time key.
 * Stalwart enforces uniqueness on the `address` field, so we use that as
 * the natural key: if an entry with the same address already exists
 * (regardless of who created it), we leave it alone. If it doesn't, we
 * create it with a reason field marking it as ours.
 *
 * We never destroy or update existing entries — the operator owns those,
 * and the manually-added bootstrap entries (`cluster-pod`, `cluster-svc`,
 * etc.) must remain untouched.
 */
async function reconcileAllowedIps(
  jmapCall: (auth: string, body: unknown) => Promise<JmapInvocationResponse>,
  auth: string,
  serverNodes: ReadonlyArray<{ hostname: string; ip: string }>,
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): Promise<void> {
  const getRes = await jmapCall(auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      ['x:AllowedIp/get', { accountId: ADMIN_ACCOUNT_ID, ids: null }, 'c0'],
    ],
  });

  const args = getRes.methodResponses[0]?.[1] as { list?: unknown };
  const rawList: unknown = args?.list;
  if (!Array.isArray(rawList)) return;

  // Stalwart strips `/32` from individual-host CIDRs but preserves wider
  // prefixes — canonicalise to the bare IP for the existing-entry check.
  const canonAddress = (a: string): string => a.endsWith('/32') ? a.slice(0, -3) : a;
  const existingAddresses = new Set<string>();
  for (const raw of rawList as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const addr = (raw as { address?: unknown }).address;
    if (typeof addr === 'string') existingAddresses.add(canonAddress(addr));
  }

  const create: Record<string, { address: string; reason: string }> = {};
  for (const node of serverNodes) {
    if (existingAddresses.has(node.ip)) continue;
    // Create-time keys aren't preserved by Stalwart, but a stable string
    // keeps the JMAP request body deterministic for log/audit purposes.
    const createKey = `mail-haproxy-${node.hostname}`;
    create[createKey] = {
      address: node.ip,
      reason: `Cluster server node ${node.hostname} (haproxy source) — exempt from rate-limit`,
    };
  }

  if (Object.keys(create).length === 0) return;

  const setRes = await jmapCall(auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      [
        'x:AllowedIp/set',
        { accountId: ADMIN_ACCOUNT_ID, create },
        'c0',
      ],
    ],
  });
  assertJmapSetSucceeded(setRes, 'x:AllowedIp/set');

  log.info(
    `AllowedIp synced — created=${Object.keys(create).length} ` +
      `(${Object.values(create).map((c) => c.address).join(', ')})`,
  );
}
