/**
 * Cluster-internal BlockedIp purger — clears Stalwart auth-rate-limit
 * entries that accumulate during admin-password rotation churn (drift
 * between platform-api's mounted-Secret view and Stalwart's pod-env
 * view → repeated 401s → IPs added to Stalwart's `BlockedIp` table
 * → silent connection-resets for legitimate operator traffic).
 *
 * SCOPE: only IPs that match either:
 *   (a) the cluster's pod CIDR (pod-internal sources — platform-api,
 *       admin-panel proxies, listener-reconcile cli pods, etc.)
 *   (b) the cluster's node IPs (nginx-ingress / Traefik runs
 *       hostNetwork=true, so iframe-proxied browser logins source
 *       from node IPs)
 *
 * Public IPs of operators or external attackers are NOT touched —
 * those entries represent legitimate rate-limit decisions and should
 * remain enforced.
 *
 * **2026-05-15 streamline**: this module previously spawned an Alpine
 * Pod that downloaded `stalwart-cli` (with sha256-pin), then invoked
 * `stalwart-cli query BlockedIp` + `stalwart-cli delete BlockedIp`.
 * Stalwart 0.16 deprecated stalwart-cli; the upstream image dropped
 * the binary. We now use the same kubectl-exec-into-Stalwart-pod
 * pattern that the proxy-networks-reconciler uses — `curl` against
 * `127.0.0.1:8080/jmap/` to bypass Stalwart 0.16's PROXY-v2 sniffing
 * (see proxy-networks-reconciler.ts:jmapPost for the full root cause).
 *
 * Net effect: removed the Alpine-pod-lifecycle scaffold, removed the
 * stalwart-cli download + extract + auth-via-env logic, dropped the
 * STALWART_CLI_DOWNLOAD_URL + STALWART_CLI_SHA256 dependency. The
 * function now operates JMAP-natively in ~120 LOC instead of ~340.
 *
 * Best-effort: a purge failure is logged but does NOT fail the
 * rotation. The blocklist is operational hygiene, not correctness.
 */

import { Buffer } from 'node:buffer';
import { mailLogger } from '../../shared/mail-logger.js';

const log = mailLogger().child({ module: 'mail-admin-purge-blocked-ips' });

const MAIL_NAMESPACE = 'mail';
const ADMIN_SECRET_NAME = 'stalwart-admin-creds';
const ADMIN_ACCOUNT_ID = 'd333333';
const JMAP_CORE = 'urn:ietf:params:jmap:core';
const JMAP_STALWART = 'urn:stalwart:jmap';
const JMAP_EXEC_TIMEOUT_MS = 15_000;

export interface PurgeBlockedIpsOptions {
  readonly kubeconfigPath: string | undefined;
  /**
   * Cluster pod CIDR. Defaults to '10.42.0.0/16' (k3s standard). Override
   * via `PLATFORM_POD_CIDR_V4` env var. Only `/16` masks supported —
   * the function uses a first-two-octets prefix match (e.g. '10.42.').
   */
  readonly podCidrV4: string;
  /**
   * Optional explicit node IPs to also purge. If empty, the function
   * queries the K8s API and uses every node's InternalIP + ExternalIP.
   */
  readonly nodeIps?: readonly string[];
  /** Total operation timeout. Default 90s. */
  readonly timeoutMs?: number;
}

export interface PurgeBlockedIpsResult {
  /** Number of BlockedIp entries destroyed. */
  readonly purgedCount: number;
  /** Whether the JMAP path ran to completion (false = soft-failed). */
  readonly ran: boolean;
  /** Last error if `ran === false`. */
  readonly errorMessage: string | null;
}

// ── Pure helpers ───────────────────────────────────────────────────────

function podCidrPrefix(cidr: string): string {
  // '10.42.0.0/16' → '10.42.'
  // We use a /16 prefix match because k3s assigns /24 slices to nodes
  // out of a /16 cluster CIDR — every pod IP starts with the same
  // first two octets.
  //
  // Hard-fail for non-/16 masks: a /8 like '10.0.0.0/8' would silently
  // produce prefix '10.0.' which is wrong (real cluster pod IPs would
  // span 10.0.x.y through 10.255.x.y).
  const slashIdx = cidr.indexOf('/');
  if (slashIdx < 0) {
    throw new Error(`invalid podCidrV4 (expected dotted-quad/maskbits): ${cidr}`);
  }
  const ip = cidr.slice(0, slashIdx);
  const mask = cidr.slice(slashIdx + 1);
  if (mask !== '16') {
    throw new Error(
      `unsupported podCidrV4 mask /${mask} — purge-blocked-ips only supports /16 cluster CIDRs ` +
        `(extend podCidrPrefix() with proper CIDR-range matching to support other masks)`,
    );
  }
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p))) {
    throw new Error(`invalid podCidrV4 (expected dotted-quad/maskbits): ${cidr}`);
  }
  return `${parts[0]}.${parts[1]}.`;
}

// ── K8s helpers ────────────────────────────────────────────────────────

async function listClusterNodeIps(kubeconfigPath: string | undefined): Promise<string[]> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const list = await core.listNode();
  const ips = new Set<string>();
  for (const node of list.items ?? []) {
    for (const addr of node.status?.addresses ?? []) {
      if ((addr.type === 'InternalIP' || addr.type === 'ExternalIP') && addr.address) {
        ips.add(addr.address);
      }
    }
  }
  return [...ips];
}

async function findStalwartPodName(
  core: import('@kubernetes/client-node').CoreV1Api,
): Promise<string | null> {
  try {
    const pods = await core.listNamespacedPod({
      namespace: MAIL_NAMESPACE,
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

async function readStalwartAdminPassword(
  core: import('@kubernetes/client-node').CoreV1Api,
): Promise<string> {
  const sec = await core.readNamespacedSecret({
    name: ADMIN_SECRET_NAME,
    namespace: MAIL_NAMESPACE,
  }) as { data?: Record<string, string> };
  // Prefer recoveryPassword (mgmt-level access) over adminPassword
  // (account-level) — recoveryPassword is what stalwart-cli used to
  // consume via $recoveryPassword + STALWART_PASSWORD.
  const b64 = sec.data?.recoveryPassword ?? sec.data?.adminPassword;
  if (!b64) {
    throw new Error(`Secret mail/${ADMIN_SECRET_NAME} missing recoveryPassword + adminPassword`);
  }
  return Buffer.from(b64, 'base64').toString('utf8').trim();
}

// ── JMAP transport (exec curl in Stalwart pod) ─────────────────────────

interface JmapResponse {
  readonly methodResponses: ReadonlyArray<[string, Record<string, unknown>, string]>;
}

async function execJmap(
  podName: string,
  kubeconfigPath: string | undefined,
  authHeader: string,
  body: unknown,
): Promise<JmapResponse> {
  const { Exec, KubeConfig } = await import('@kubernetes/client-node');
  const { Writable, Readable } = await import('node:stream');
  const kc = new KubeConfig();
  if (kubeconfigPath) kc.loadFromFile(kubeconfigPath);
  else kc.loadFromCluster();
  const exec = new Exec(kc);

  const args = [
    'curl',
    '-sf',
    '--max-time', String(Math.floor(JMAP_EXEC_TIMEOUT_MS / 1000)),
    '-H', `Authorization: ${authHeader}`,
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
  const stdin = Readable.from(Buffer.from(JSON.stringify(body), 'utf8'));

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`JMAP exec-curl timed out after ${JMAP_EXEC_TIMEOUT_MS}ms`)),
      JMAP_EXEC_TIMEOUT_MS + 5_000,
    );
    exec.exec(
      MAIL_NAMESPACE,
      podName,
      'stalwart',
      args,
      stdoutSink,
      stderrSink,
      stdin,
      false,
      (status) => {
        clearTimeout(timer);
        if (status.status === 'Failure') {
          reject(new Error(`JMAP exec-curl failed: ${status.message ?? 'unknown'} (stderr=${stderr.slice(0, 200)})`));
        } else {
          resolve();
        }
      },
    ).catch(reject);
  });

  let data: unknown;
  try {
    data = JSON.parse(stdout);
  } catch {
    throw new Error(`JMAP non-JSON response: ${stdout.slice(0, 200)}`);
  }
  if (
    !data ||
    typeof data !== 'object' ||
    !Array.isArray((data as { methodResponses?: unknown }).methodResponses)
  ) {
    throw new Error('JMAP response missing methodResponses array');
  }
  return data as JmapResponse;
}

// ── Public API ─────────────────────────────────────────────────────────

interface BlockedIpEntry {
  readonly id: string;
  readonly address?: string;
}

export async function purgeClusterInternalBlockedIps(
  opts: PurgeBlockedIpsOptions,
): Promise<PurgeBlockedIpsResult> {
  const k8s = await import('@kubernetes/client-node');
  const kc = new k8s.KubeConfig();
  if (opts.kubeconfigPath) kc.loadFromFile(opts.kubeconfigPath);
  else kc.loadFromCluster();
  const core = kc.makeApiClient(k8s.CoreV1Api);

  const cidrPrefix = podCidrPrefix(opts.podCidrV4);
  const nodeIps =
    opts.nodeIps && opts.nodeIps.length > 0
      ? opts.nodeIps
      : await listClusterNodeIps(opts.kubeconfigPath);
  const nodeIpSet = new Set(nodeIps);

  let podName: string | null = null;
  let password: string;
  try {
    podName = await findStalwartPodName(core);
    if (!podName) {
      log.warn('No Running Stalwart pod found — skipping purge.');
      return { purgedCount: 0, ran: false, errorMessage: 'no running Stalwart pod' };
    }
    password = await readStalwartAdminPassword(core);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'purge-blocked-ips: preflight failed');
    return { purgedCount: 0, ran: false, errorMessage: msg };
  }

  const authHeader = `Basic ${Buffer.from(`admin:${password}`).toString('base64')}`;

  // GET all BlockedIp entries.
  let getRes: JmapResponse;
  try {
    getRes = await execJmap(podName, opts.kubeconfigPath, authHeader, {
      using: [JMAP_CORE, JMAP_STALWART],
      methodCalls: [
        ['x:BlockedIp/get', { accountId: ADMIN_ACCOUNT_ID, ids: null }, 'c0'],
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'purge-blocked-ips: BlockedIp/get failed');
    return { purgedCount: 0, ran: false, errorMessage: msg };
  }

  const getArgs = getRes.methodResponses[0]?.[1] as { list?: BlockedIpEntry[] } | undefined;
  const entries = getArgs?.list ?? [];
  const idsToDestroy: string[] = [];
  for (const e of entries) {
    if (!e.id || !e.address) continue;
    if (e.address.startsWith(cidrPrefix) || nodeIpSet.has(e.address)) {
      idsToDestroy.push(e.id);
    }
  }

  if (idsToDestroy.length === 0) {
    log.info({ cidrPrefix, nodeIpCount: nodeIps.length, total: entries.length },
      'purge-blocked-ips: no cluster-internal entries to purge');
    return { purgedCount: 0, ran: true, errorMessage: null };
  }

  // DESTROY filtered entries.
  let setRes: JmapResponse;
  try {
    setRes = await execJmap(podName, opts.kubeconfigPath, authHeader, {
      using: [JMAP_CORE, JMAP_STALWART],
      methodCalls: [
        ['x:BlockedIp/set', { accountId: ADMIN_ACCOUNT_ID, destroy: idsToDestroy }, 'c0'],
      ],
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg, idsToDestroy: idsToDestroy.length },
      'purge-blocked-ips: BlockedIp/set destroy failed');
    return { purgedCount: 0, ran: false, errorMessage: msg };
  }

  // Validate set/set response — extract destroyed ids.
  const setArgs = setRes.methodResponses[0]?.[1] as {
    destroyed?: string[];
    notDestroyed?: Record<string, unknown>;
  } | undefined;
  const destroyed = setArgs?.destroyed ?? [];
  const notDestroyed = Object.keys(setArgs?.notDestroyed ?? {});

  if (notDestroyed.length > 0) {
    log.warn({
      destroyed: destroyed.length,
      notDestroyed: notDestroyed.length,
      notDestroyedDetail: setArgs?.notDestroyed,
    }, 'purge-blocked-ips: partial-failure on BlockedIp/set destroy');
  } else {
    log.info({
      purgedCount: destroyed.length,
      cidrPrefix,
      nodeIpCount: nodeIps.length,
    }, 'purge-blocked-ips: purged cluster-internal BlockedIp entries');
  }

  return {
    purgedCount: destroyed.length,
    ran: true,
    errorMessage: notDestroyed.length > 0 ? `notDestroyed: ${notDestroyed.length}` : null,
  };
}

// Re-exports for tests
export { podCidrPrefix as _podCidrPrefix };
