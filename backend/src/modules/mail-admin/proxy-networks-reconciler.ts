/**
 * Proxy-networks reconciler — keeps Stalwart's `proxyNetworks` on every
 * mail NetworkListener in sync with the set of server-role node IPs
 * (the source addresses haproxy DaemonSet pods will use, since they run
 * hostNetwork).
 *
 * Why this exists:
 *   When mailPortExposureMode flips to 'allServerNodes', haproxy pods on
 *   each server node accept mail connections, write a PROXY-v2 header
 *   carrying the real client IP, and forward to stalwart-mail.mail.svc.
 *   Stalwart must trust those source addresses to honor the PROXY-v2
 *   header — that trust list is `proxyNetworks` on each NetworkListener.
 *
 *   Setting `proxyNetworks` to 0.0.0.0/0 would let any internet attacker
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
 *   (per operator request) so we don't have to re-patch listeners every
 *   time the mode flips.
 *
 * Mail listeners are identified by their bind port (any of 25, 465, 587,
 * 143, 993, 4190) — this is robust to Stalwart's default listener names
 * vs. names added by bootstrap.sh.
 *
 * Tick cadence: 60s (matches the certificate reconciler). Empty node
 * sets are NEVER pushed; if the node listing fails or returns zero
 * server-role nodes, the tick logs a warning and waits for the next
 * cycle. Listeners' proxyNetworks are never blown away.
 */

import { readStalwartCredentials } from './credentials.js';

type CoreV1Api = import('@kubernetes/client-node').CoreV1Api;

/** Default tick: 60s — same cadence as certificate reconciler. */
export const PROXY_NETWORKS_RECONCILER_TICK_MS = 60_000;

/** Mail ports a NetworkListener can bind that this reconciler touches. */
export const MAIL_LISTENER_PORTS: readonly number[] = [25, 143, 465, 587, 993, 4190] as const;

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
  readonly tickMs?: number;
  readonly logger?: {
    warn: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
  };
  /** Override for tests — defaults to STALWART_MGMT_URL. */
  readonly stalwartMgmtUrl?: string;
  /** Override for tests — defaults to process.env. */
  readonly env?: NodeJS.ProcessEnv;
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

interface NetworkListenerRow {
  readonly id: string;
  readonly name: string;
  readonly bind?: Record<string, boolean> | null;
  readonly proxyNetworks?: Record<string, boolean> | null;
}

interface AllowedIpRow {
  readonly id: string;
  readonly address?: string | null;
  readonly reason?: string | null;
}

/**
 * One tick of the reconciler. Exported for unit-testability.
 *
 * Steps:
 *   1. Enumerate server-role node InternalIPs from the K8s API.
 *   2. GET x:NetworkListener — filter to listeners binding any mail port.
 *   3. For each such listener: UPDATE proxyNetworks if it differs.
 *   4. GET x:AllowedIp — sync per-node mail-haproxy-<hostname> entries.
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

  const expectedProxyNetworks: Record<string, boolean> = {};
  for (const node of serverNodes) {
    expectedProxyNetworks[`${node.ip}/32`] = true;
  }

  const baseUrl = deps.stalwartMgmtUrl ?? STALWART_MGMT_URL;
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

  // ── Step 1: reconcile NetworkListener.proxyNetworks ────────────────
  try {
    await reconcileListenerProxyNetworks(
      baseUrl,
      auth,
      expectedProxyNetworks,
      log,
    );
  } catch (err) {
    log.warn('NetworkListener reconcile failed:', err);
    // Continue to AllowedIp reconcile — independent failure modes.
  }

  // ── Step 2: reconcile x:AllowedIp for cluster-IP rate-limit safety ─
  try {
    await reconcileAllowedIps(
      baseUrl,
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
  const list = (await core.listNode({})) as { items?: NodeShape[] };
  const out: Array<{ hostname: string; ip: string }> = [];
  for (const n of list.items ?? []) {
    if (n.metadata?.labels?.[SERVER_ROLE_LABEL_KEY] !== SERVER_ROLE_LABEL_VALUE) continue;
    const hostname =
      n.metadata?.labels?.['kubernetes.io/hostname'] ?? n.metadata?.name ?? '';
    if (!hostname) continue;
    const internal = n.status?.addresses?.find((a) => a.type === 'InternalIP')?.address;
    if (!internal) continue;
    out.push({ hostname, ip: internal });
  }
  // Deterministic order helps log diffs and tests.
  return out.sort((a, b) => a.hostname.localeCompare(b.hostname));
}

// ── Internal: JMAP plumbing ──────────────────────────────────────────

interface JmapInvocationResponse {
  readonly methodResponses: ReadonlyArray<[string, Record<string, unknown>, string]>;
}

async function jmapPost(
  baseUrl: string,
  auth: string,
  body: unknown,
): Promise<JmapInvocationResponse> {
  const res = await fetch(`${baseUrl}/jmap/`, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(JMAP_TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Stalwart JMAP ${res.status} ${res.statusText}: ${text.slice(0, 200)}`,
    );
  }
  const data = (await res.json()) as unknown;
  if (
    !data ||
    typeof data !== 'object' ||
    !Array.isArray((data as { methodResponses?: unknown }).methodResponses)
  ) {
    throw new Error('Stalwart JMAP response missing methodResponses array');
  }
  return data as JmapInvocationResponse;
}

// ── Internal: NetworkListener reconcile ──────────────────────────────

async function reconcileListenerProxyNetworks(
  baseUrl: string,
  auth: string,
  expected: Record<string, boolean>,
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): Promise<void> {
  const getRes = await jmapPost(baseUrl, auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      ['x:NetworkListener/get', { accountId: ADMIN_ACCOUNT_ID, ids: null }, 'c0'],
    ],
  });

  const args = getRes.methodResponses[0]?.[1] as { list?: unknown };
  const rawList: unknown = args?.list;
  if (!Array.isArray(rawList)) {
    log.warn('x:NetworkListener/get returned non-list payload — skipping.');
    return;
  }

  const mailListeners: NetworkListenerRow[] = [];
  for (const raw of rawList as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as NetworkListenerRow;
    if (!row.id || !row.name) continue;
    if (!isMailListener(row)) continue;
    mailListeners.push(row);
  }

  if (mailListeners.length === 0) {
    log.warn('No mail-port NetworkListeners found — Stalwart bootstrap may not be complete yet.');
    return;
  }

  // Group listeners that need an update — issue one x:NetworkListener/set.
  const update: Record<string, Record<string, unknown>> = {};
  for (const row of mailListeners) {
    if (!proxyNetworksMatches(row.proxyNetworks, expected)) {
      update[row.id] = { proxyNetworks: expected };
    }
  }
  if (Object.keys(update).length === 0) return;

  await jmapPost(baseUrl, auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      [
        'x:NetworkListener/set',
        { accountId: ADMIN_ACCOUNT_ID, update },
        'c0',
      ],
    ],
  });

  log.info(
    `Updated proxyNetworks on ${Object.keys(update).length} listener(s): ` +
      `${mailListeners.filter((l) => update[l.id]).map((l) => l.name).join(', ')} → ` +
      `${Object.keys(expected).join(', ')}`,
  );
}

/**
 * A listener is a "mail listener" if it binds any of MAIL_LISTENER_PORTS.
 * Stalwart's bind map uses keys like `[::]:587`, `0.0.0.0:587`,
 * `127.0.0.1:25`. We parse the trailing :PORT off each key.
 */
export function isMailListener(row: NetworkListenerRow): boolean {
  const binds = row.bind;
  if (!binds || typeof binds !== 'object') return false;
  for (const bindKey of Object.keys(binds)) {
    const port = parseBindPort(bindKey);
    if (port !== null && (MAIL_LISTENER_PORTS as readonly number[]).includes(port)) {
      return true;
    }
  }
  return false;
}

/** Parse the port from a Stalwart bind key like `[::]:587` or `0.0.0.0:25`. */
export function parseBindPort(bindKey: string): number | null {
  // IPv6 form `[::]:port` or `[2001:db8::1]:port`
  const v6 = bindKey.match(/\]:(\d+)$/);
  if (v6) return Number(v6[1]);
  // IPv4 or hostname form `0.0.0.0:port`
  const v4 = bindKey.match(/:(\d+)$/);
  if (v4) return Number(v4[1]);
  return null;
}

/** Set-equal comparison of proxyNetworks key sets. */
export function proxyNetworksMatches(
  current: Record<string, boolean> | null | undefined,
  expected: Record<string, boolean>,
): boolean {
  const currentKeys = current ? Object.keys(current).filter((k) => current[k] === true) : [];
  const expectedKeys = Object.keys(expected);
  if (currentKeys.length !== expectedKeys.length) return false;
  const set = new Set(currentKeys);
  for (const k of expectedKeys) {
    if (!set.has(k)) return false;
  }
  return true;
}

// ── Internal: AllowedIp reconcile ────────────────────────────────────

/**
 * Sync x:AllowedIp entries `mail-haproxy-<hostname>` so cluster node IPs
 * are never subject to Stalwart's rate-limiter even if PROXY-v2 unwrap
 * ever fails. Entries for nodes no longer in the cluster are destroyed
 * to keep the list tight.
 */
async function reconcileAllowedIps(
  baseUrl: string,
  auth: string,
  serverNodes: ReadonlyArray<{ hostname: string; ip: string }>,
  log: { warn: (...args: unknown[]) => void; info: (...args: unknown[]) => void },
): Promise<void> {
  const PREFIX = 'mail-haproxy-';
  const getRes = await jmapPost(baseUrl, auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      ['x:AllowedIp/get', { accountId: ADMIN_ACCOUNT_ID, ids: null }, 'c0'],
    ],
  });

  const args = getRes.methodResponses[0]?.[1] as { list?: unknown };
  const rawList: unknown = args?.list;
  if (!Array.isArray(rawList)) return;

  const existing: Map<string, AllowedIpRow> = new Map();
  for (const raw of rawList as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const row = raw as AllowedIpRow;
    if (typeof row.id === 'string' && row.id.startsWith(PREFIX)) {
      existing.set(row.id, row);
    }
  }

  // Build expected map keyed by ID.
  const expected = new Map<string, { address: string; reason: string }>();
  for (const node of serverNodes) {
    expected.set(`${PREFIX}${node.hostname}`, {
      address: `${node.ip}/32`,
      reason: `Cluster server node ${node.hostname} (haproxy source) — exempt from rate-limit`,
    });
  }

  // Plan create / update / destroy.
  const create: Record<string, { address: string; reason: string }> = {};
  const update: Record<string, Record<string, unknown>> = {};
  const destroy: string[] = [];

  for (const [id, want] of expected) {
    const have = existing.get(id);
    if (!have) {
      create[id] = want;
    } else if (have.address !== want.address) {
      update[id] = { address: want.address, reason: want.reason };
    }
  }
  for (const id of existing.keys()) {
    if (!expected.has(id)) destroy.push(id);
  }

  if (
    Object.keys(create).length === 0 &&
    Object.keys(update).length === 0 &&
    destroy.length === 0
  ) {
    return;
  }

  await jmapPost(baseUrl, auth, {
    using: [JMAP_CORE, JMAP_STALWART],
    methodCalls: [
      [
        'x:AllowedIp/set',
        {
          accountId: ADMIN_ACCOUNT_ID,
          ...(Object.keys(create).length > 0 ? { create } : {}),
          ...(Object.keys(update).length > 0 ? { update } : {}),
          ...(destroy.length > 0 ? { destroy } : {}),
        },
        'c0',
      ],
    ],
  });

  log.info(
    `AllowedIp synced — created=${Object.keys(create).length}, ` +
      `updated=${Object.keys(update).length}, destroyed=${destroy.length}`,
  );
}
