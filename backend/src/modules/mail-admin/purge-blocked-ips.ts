/**
 * Cluster-internal BlockedIp purger — used after admin password rotation
 * to clear out auth-rate-limit entries that accumulated during the
 * rotation churn (drift between platform-api's mounted-Secret view and
 * Stalwart's pod-env view → repeated 401s → IPs added to Stalwart's
 * `BlockedIp` table → silent connection-resets for legitimate operator
 * traffic afterwards).
 *
 * SCOPE: only IPs that match either:
 *   (a) the cluster's pod CIDR (pod-internal sources — platform-api,
 *       admin-panel proxies, listener-reconcile cli pods, etc.)
 *   (b) the cluster's node IPs (nginx-ingress runs hostNetwork=true,
 *       so iframe-proxied browser logins source from node IPs)
 *
 * Public IPs of operators or external attackers are NOT touched —
 * those entries represent legitimate rate-limit decisions and should
 * remain enforced.
 *
 * IMPLEMENTATION: spawn a one-shot Pod that downloads stalwart-cli (with
 * sha256-pin), queries `BlockedIp --json`, filters by CIDR + node IPs in
 * shell, then deletes the matching entries via `cli delete --ids`. The
 * pod authenticates via envFrom secretRef on `stalwart-admin-creds`
 * (NOT --env=PLAINTEXT — see CRITICAL fix in blob-store.ts).
 *
 * Best-effort: a purge failure is logged but does NOT fail the rotation.
 * The blocklist is operational hygiene, not correctness.
 */

import { mailLogger } from '../../shared/mail-logger.js';
import {
  STALWART_CLI_DOWNLOAD_URL,
  STALWART_CLI_SHA256,
} from './blob-store-cli-version.js';

const log = mailLogger().child({ module: 'mail-admin-purge-blocked-ips' });

const MAIL_NAMESPACE = 'mail';
const ADMIN_SECRET_NAME = 'stalwart-admin-creds';
const STALWART_MGMT_URL =
  'http://stalwart-mgmt-v016.mail.svc.cluster.local:8080';

export interface PurgeBlockedIpsOptions {
  readonly kubeconfigPath: string | undefined;
  /**
   * Cluster pod CIDR — used to match in-cluster source IPs. Defaults to
   * '10.42.0.0/16' which is k3s's standard pod CIDR. Override via the
   * `PLATFORM_POD_CIDR_V4` env var if your cluster uses a different
   * range. ONLY the first two octets are used for matching (e.g.
   * '10.42.') so pod CIDR slices per node are all covered.
   */
  readonly podCidrV4: string;
  /**
   * Optional explicit node IPs to also purge. If empty, the function
   * queries the K8s API and uses every node's InternalIP + ExternalIP.
   */
  readonly nodeIps?: readonly string[];
  /** Pod-creation timeout for the cli pod. Default 90s. */
  readonly timeoutMs?: number;
}

export interface PurgeBlockedIpsResult {
  /** Number of BlockedIp entries deleted. */
  readonly purgedCount: number;
  /** Whether the purge pod ran to completion (false = soft-failed). */
  readonly ran: boolean;
  /** Last error if `ran === false`. */
  readonly errorMessage: string | null;
}

const PURGE_PODNAME_PREFIX = 'stalwart-blocklist-purge-';

function randomShort(): string {
  return Math.random().toString(36).slice(2, 10);
}

function podCidrPrefix(cidr: string): string {
  // '10.42.0.0/16' → '10.42.'
  // '192.168.0.0/16' → '192.168.'
  // We use a /16 prefix match because k3s assigns /24 slices to nodes
  // out of a /16 cluster CIDR — every pod IP starts with the same first
  // two octets.
  //
  // Hard-fail for non-/16 masks: a /8 like '10.0.0.0/8' would silently
  // produce prefix '10.0.' which is wrong (real cluster pod IPs would
  // span 10.0.x.y through 10.255.x.y). Until we add proper CIDR-range
  // matching, refuse to operate on unsupported masks.
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

/**
 * Render the Pod manifest that runs the purge. The shell script does
 * the filter + delete in one pass to avoid spawning two Pods. Auth
 * comes from envFrom Secret reference — STALWART_PASSWORD is
 * exported from `$recoveryPassword` in the script body.
 *
 * Typed as V1Pod (lazy-imported via the same mechanism that loads the
 * client at runtime) for compile-time validation of field names. The
 * type-only import is erased at runtime so it does NOT pull the heavy
 * @kubernetes/client-node into the test path.
 */
function renderPurgePodManifest(
  podName: string,
  cidrPrefix: string,
  nodeIps: readonly string[],
): import('@kubernetes/client-node').V1Pod {
  const nodeIpList = nodeIps.join(' ');
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: podName,
      namespace: MAIL_NAMESPACE,
      labels: {
        'app.kubernetes.io/component': 'stalwart-blocklist-purge',
      },
    },
    spec: {
      restartPolicy: 'Never',
      activeDeadlineSeconds: 120,
      containers: [
        {
          name: 'cli',
          image: 'alpine:3.20',
          env: [
            { name: 'STALWART_URL', value: STALWART_MGMT_URL },
            { name: 'STALWART_USER', value: 'admin' },
            { name: 'POD_CIDR_PREFIX', value: cidrPrefix },
            { name: 'NODE_IPS', value: nodeIpList },
          ],
          envFrom: [{ secretRef: { name: ADMIN_SECRET_NAME } }],
          command: ['sh', '-c'],
          args: [
            `set -eu
# CRITICAL: stalwart-cli reads STALWART_PASSWORD; the Secret key is
# 'recoveryPassword' which envFrom maps to env-var \\$recoveryPassword.
export STALWART_PASSWORD="$recoveryPassword"

apk add --no-cache wget tar xz >/dev/null 2>&1
cd /tmp
wget -q -O cli.tar.xz "${STALWART_CLI_DOWNLOAD_URL}"
actual=$(sha256sum cli.tar.xz | awk '{print $1}')
if [ "$actual" != "${STALWART_CLI_SHA256}" ]; then
  echo "FATAL: stalwart-cli sha256 mismatch (expected ${STALWART_CLI_SHA256}, actual $actual)" >&2
  exit 1
fi
tar -xJf cli.tar.xz
CLI=/tmp/stalwart-cli-x86_64-unknown-linux-musl/stalwart-cli

# Query all BlockedIp entries; one JSON object per line.
"$CLI" query BlockedIp --json > /tmp/all.jsonl 2>/dev/null || {
  echo "{\\"purgedCount\\":0,\\"reason\\":\\"query failed\\"}"
  exit 0
}

if [ ! -s /tmp/all.jsonl ]; then
  echo "{\\"purgedCount\\":0,\\"reason\\":\\"no entries\\"}"
  exit 0
fi

# Filter: id is the BlockedIp object id; ipAddresses is a "set" map.
# Match if any of its IPs starts with POD_CIDR_PREFIX or appears in
# NODE_IPS. Output one id per line into /tmp/ids.txt.
> /tmp/ids.txt
while IFS= read -r line; do
  [ -z "$line" ] && continue
  id=$(echo "$line" | grep -oE '"id":"[^"]+"' | head -1 | cut -d'"' -f4)
  [ -z "$id" ] && continue
  ips=$(echo "$line" | grep -oE '[0-9]+\\.[0-9]+\\.[0-9]+\\.[0-9]+' || true)
  [ -z "$ips" ] && continue
  for ip in $ips; do
    case "$ip" in
      "$POD_CIDR_PREFIX"*)
        echo "$id" >> /tmp/ids.txt
        break
        ;;
    esac
    for nip in $NODE_IPS; do
      if [ "$ip" = "$nip" ]; then
        echo "$id" >> /tmp/ids.txt
        break 2
      fi
    done
  done
done < /tmp/all.jsonl

PURGED_COUNT=$(wc -l < /tmp/ids.txt | tr -d ' ')
if [ "$PURGED_COUNT" -gt 0 ]; then
  IDS=$(tr '\\n' ',' < /tmp/ids.txt | sed 's/,$//')
  "$CLI" delete BlockedIp --ids "$IDS" >&2
fi

# Machine-readable result on the LAST stdout line for the TS caller to
# parse out of the pod logs.
echo "{\\"purgedCount\\":$PURGED_COUNT}"
`,
          ],
        },
      ],
    },
  };
}

/**
 * Wait for a pod to reach Succeeded or Failed, then return.
 * Polls every 1.5s up to `timeoutMs`.
 */
async function waitPodPhase(
  core: import('@kubernetes/client-node').CoreV1Api,
  podName: string,
  terminalPhases: readonly string[],
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pod = await core.readNamespacedPod({
      namespace: MAIL_NAMESPACE,
      name: podName,
    });
    const phase = pod.status?.phase ?? 'Unknown';
    if (terminalPhases.includes(phase)) return phase;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return 'Timeout';
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

  const podName = `${PURGE_PODNAME_PREFIX}${randomShort()}`;
  const podManifest = renderPurgePodManifest(podName, cidrPrefix, nodeIps);

  try {
    await core.createNamespacedPod({
      namespace: MAIL_NAMESPACE,
      body: podManifest,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn({ err: msg }, 'failed to create blocklist-purge pod');
    return { purgedCount: 0, ran: false, errorMessage: msg };
  }

  try {
    const phase = await waitPodPhase(
      core,
      podName,
      ['Succeeded', 'Failed'],
      opts.timeoutMs ?? 90_000,
    );

    if (phase !== 'Succeeded') {
      log.warn({ phase, podName }, 'blocklist-purge pod did not Succeed');
      return { purgedCount: 0, ran: false, errorMessage: `phase=${phase}` };
    }

    const logText = await core.readNamespacedPodLog({
      namespace: MAIL_NAMESPACE,
      name: podName,
    });

    // The script prints exactly one machine-readable JSON line as its
    // final stdout output: {"purgedCount":N} or
    // {"purgedCount":0,"reason":"..."}. Extract the LAST {...} block.
    const jsonMatch = logText.match(/\{"purgedCount":\s*\d+(?:,"reason":"[^"]*")?\}/);
    if (!jsonMatch) {
      log.warn({ podName, logExcerpt: logText.slice(0, 200) },
        'blocklist-purge pod logs did not contain expected purgedCount line');
      return { purgedCount: 0, ran: false, errorMessage: 'no purgedCount in logs' };
    }
    const parsed = JSON.parse(jsonMatch[0]) as { purgedCount: number };

    log.info({
      purgedCount: parsed.purgedCount,
      cidrPrefix,
      nodeIpCount: nodeIps.length,
    }, 'purged cluster-internal BlockedIp entries');

    return {
      purgedCount: parsed.purgedCount,
      ran: true,
      errorMessage: null,
    };
  } finally {
    // Best-effort cleanup of the spawned pod. activeDeadlineSeconds=120
    // would eventually GC it anyway but explicit delete is faster.
    await core
      .deleteNamespacedPod({ namespace: MAIL_NAMESPACE, name: podName })
      .catch(() => {
        // ignore — pod may have been cleaned up by the kubelet's
        // ttlSecondsAfterFinished or by another concurrent runner
      });
  }
}

// Re-exports for tests
export { podCidrPrefix as _podCidrPrefix };
