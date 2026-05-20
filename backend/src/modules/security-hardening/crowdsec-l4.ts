/**
 * F1+F6 Stage C — operator-facing CrowdSec L4 enforcement toggle.
 *
 * Sets the firewall-reconciler DaemonSet's `CROWDSEC_L4_MODE` env via
 * a strategic-merge patch on the pod template. The container reads
 * this env at startup to decide between disabled/dryrun/enforce.
 * Pods roll automatically once the env changes.
 *
 * Operator-allowlist guard — runs at PATCH time, fail-CLOSED:
 *
 *   getOperatorIp(req) → extract from X-Real-IP header
 *   ↓
 *   resolveTrustSources(k8s) → trustedRangesV{4,6} + clusterPeersV{4,6}
 *   ↓
 *   isOperatorIpTrusted(ip, sources) → true if IP lands in ANY trust set
 *
 * If the operator's IP isn't in either trust set, the PATCH is refused
 * with `OPERATOR_IP_NOT_TRUSTED 403`. This prevents the foot-gun where
 * an operator behind a NAT (their home IP not in trusted_ranges) flips
 * to enforce and immediately gets caught by a CrowdSec scenario they
 * fired on themselves.
 *
 * The guard is NOT user-disableable. Bypass requires direct
 * `kubectl edit ds firewall-reconciler` — which is itself the operator
 * acknowledging the risk on their own terms.
 */

import { isIP } from 'node:net';
import * as k8s from '@kubernetes/client-node';
import type { CrowdsecL4Mode, CrowdsecL4Status } from '@k8s-hosting/api-contracts';
import { STRATEGIC_MERGE_PATCH } from '../../shared/k8s-patch.js';

const FIREWALL_RECONCILER_NAMESPACE = 'platform-system';
const FIREWALL_RECONCILER_DS = 'firewall-reconciler';
const CROWDSEC_L4_ENV = 'CROWDSEC_L4_MODE';

// CTR + CPP GVRs match what the firewall-reconciler Go code uses.
const CTR_GVR = { group: 'platform.phoenix-host.net', version: 'v1alpha1', plural: 'clustertrustedranges' } as const;
const CPP_GVR = { group: 'platform.phoenix-host.net', version: 'v1alpha1', plural: 'clusterpendingpeers' } as const;

export class OperatorIpNotTrustedError extends Error {
  constructor(public readonly operatorIp: string | null, message: string) {
    super(message);
    this.name = 'OperatorIpNotTrustedError';
  }
}

/**
 * Extract the operator's IP from a Fastify request. Traefik sets
 * `X-Real-IP` on the admin ingress to the upstream client IP; the
 * platform-api also runs behind that ingress. We prefer X-Real-IP
 * over `req.ip` because the latter would be the in-cluster pod IP
 * (Traefik DS) when the request comes through the ingress.
 *
 * If neither header nor fallback yields a parseable IP, returns null.
 * The PATCH route treats null as "guard fail" — refuse to engage.
 */
export const getOperatorIp = (req: {
  readonly headers?: Record<string, string | string[] | undefined>;
  readonly ip?: string;
}): string | null => {
  const xri = req.headers?.['x-real-ip'];
  const candidate = (typeof xri === 'string' ? xri : Array.isArray(xri) ? xri[0] : undefined)
    ?? req.ip;
  if (!candidate) return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  return isIP(trimmed) ? trimmed : null;
};

export interface TrustSources {
  readonly trustedRangesV4: ReadonlyArray<string>; // CIDR strings
  readonly trustedRangesV6: ReadonlyArray<string>;
  readonly clusterPeersV4: ReadonlyArray<string>; // bare IPs ("10.0.0.1")
  readonly clusterPeersV6: ReadonlyArray<string>;
}

/**
 * Reads the live trust sources from the kube apiserver. Pull the
 * Node InternalIPs (every node), ClusterPendingPeer IPs (active),
 * and ClusterTrustedRange CIDRs.
 *
 * On any kube-API error, returns empty arrays — the caller's guard
 * MUST refuse the PATCH because we can't prove the operator is
 * trusted. This is the fail-CLOSED design.
 */
export const resolveTrustSources = async (
  kubeconfigPath: string | undefined,
): Promise<TrustSources> => {
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) {
    kc.loadFromFile(kubeconfigPath);
  } else {
    kc.loadFromCluster();
  }
  const core = kc.makeApiClient(k8s.CoreV1Api);
  const dyn = kc.makeApiClient(k8s.CustomObjectsApi);

  const trustedRangesV4: string[] = [];
  const trustedRangesV6: string[] = [];
  const clusterPeersV4: string[] = [];
  const clusterPeersV6: string[] = [];

  // 1. Node InternalIPs → clusterPeers
  try {
    const nodesResp = (await core.listNode(
      undefined as unknown as Parameters<typeof core.listNode>[0],
    )) as unknown as { items: Array<{ status?: { addresses?: Array<{ type?: string; address?: string }> } }> };
    for (const node of nodesResp.items ?? []) {
      for (const addr of node.status?.addresses ?? []) {
        if (addr.type !== 'InternalIP' || !addr.address) continue;
        const ver = isIP(addr.address);
        if (ver === 4) clusterPeersV4.push(addr.address);
        else if (ver === 6) clusterPeersV6.push(addr.address);
      }
    }
  } catch {
    // Don't throw — empty list still flows through the fail-CLOSED check.
  }

  // 2. ClusterPendingPeer → clusterPeers (active only is too much state
  // for this read path — we union all spec.ip's; expired CRs are
  // GC'd by the firewall-reconciler within a few ticks).
  try {
    const cppResp = (await dyn.listClusterCustomObject({
      group: CPP_GVR.group,
      version: CPP_GVR.version,
      plural: CPP_GVR.plural,
    } as unknown as Parameters<typeof dyn.listClusterCustomObject>[0])) as unknown as {
      items: Array<{ spec?: { ip?: string } }>;
    };
    for (const cpp of cppResp.items ?? []) {
      const ip = cpp.spec?.ip;
      if (!ip) continue;
      const ver = isIP(ip);
      if (ver === 4) clusterPeersV4.push(ip);
      else if (ver === 6) clusterPeersV6.push(ip);
    }
  } catch {
    // Empty list is fine.
  }

  // 3. ClusterTrustedRange → trustedRanges (CIDRs)
  try {
    const ctrResp = (await dyn.listClusterCustomObject({
      group: CTR_GVR.group,
      version: CTR_GVR.version,
      plural: CTR_GVR.plural,
    } as unknown as Parameters<typeof dyn.listClusterCustomObject>[0])) as unknown as {
      items: Array<{ spec?: { cidr?: string } }>;
    };
    for (const ctr of ctrResp.items ?? []) {
      const cidr = ctr.spec?.cidr;
      if (!cidr) continue;
      const [addr] = cidr.split('/');
      const ver = isIP(addr ?? '');
      if (ver === 4) trustedRangesV4.push(cidr);
      else if (ver === 6) trustedRangesV6.push(cidr);
    }
  } catch {
    // Empty list is fine.
  }

  return {
    trustedRangesV4,
    trustedRangesV6,
    clusterPeersV4,
    clusterPeersV6,
  };
};

/**
 * Returns true if `ip` is in ANY of the trust sources. CIDR-aware for
 * trustedRanges; exact-match for clusterPeers (those are bare IPs).
 *
 * Pure function — given the same inputs, returns the same output.
 * Tested via crowdsec-l4.test.ts.
 */
export const isOperatorIpTrusted = (ip: string | null, sources: TrustSources): boolean => {
  if (!ip) return false;
  const ver = isIP(ip);
  if (ver === 0) return false;

  if (ver === 4) {
    if (sources.clusterPeersV4.includes(ip)) return true;
    for (const cidr of sources.trustedRangesV4) {
      if (ipv4InCidr(ip, cidr)) return true;
    }
    return false;
  }
  // IPv6
  if (sources.clusterPeersV6.includes(ip)) return true;
  for (const cidr of sources.trustedRangesV6) {
    if (ipv6InCidr(ip, cidr)) return true;
  }
  return false;
};

/**
 * Reads the firewall-reconciler DaemonSet's pod template env to
 * determine the live `CROWDSEC_L4_MODE` value + how many pods have
 * picked it up. Used by the GET status endpoint.
 */
export const getL4Status = async (
  kubeconfigPath: string | undefined,
  operatorIp: string | null,
): Promise<CrowdsecL4Status> => {
  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) {
    kc.loadFromFile(kubeconfigPath);
  } else {
    kc.loadFromCluster();
  }
  const apps = kc.makeApiClient(k8s.AppsV1Api);
  const core = kc.makeApiClient(k8s.CoreV1Api);

  let mode: CrowdsecL4Mode = 'disabled';
  let totalPods = 0;
  let appliedPods = 0;
  try {
    const ds = (await apps.readNamespacedDaemonSet({
      name: FIREWALL_RECONCILER_DS,
      namespace: FIREWALL_RECONCILER_NAMESPACE,
    } as unknown as Parameters<typeof apps.readNamespacedDaemonSet>[0])) as unknown as {
      spec?: { template?: { spec?: { containers?: Array<{ env?: Array<{ name?: string; value?: string }> }> } } };
      status?: { desiredNumberScheduled?: number };
    };
    const envs = ds.spec?.template?.spec?.containers?.[0]?.env ?? [];
    const found = envs.find((e) => e.name === CROWDSEC_L4_ENV);
    const raw = found?.value ?? 'disabled';
    if (raw === 'dryrun' || raw === 'enforce') {
      mode = raw;
    }
    totalPods = ds.status?.desiredNumberScheduled ?? 0;
  } catch {
    // DS missing or kube error → leave mode as disabled, counts as 0.
  }

  // Count pods with the matching env value as `appliedPods` (rolling
  // status indicator). When all pods have rolled, applied == total.
  try {
    const pods = (await core.listNamespacedPod({
      namespace: FIREWALL_RECONCILER_NAMESPACE,
      labelSelector: `app=${FIREWALL_RECONCILER_DS}`,
    } as unknown as Parameters<typeof core.listNamespacedPod>[0])) as unknown as {
      items: Array<{ spec?: { containers?: Array<{ env?: Array<{ name?: string; value?: string }> }> } }>;
    };
    for (const pod of pods.items ?? []) {
      const envs = pod.spec?.containers?.[0]?.env ?? [];
      const found = envs.find((e) => e.name === CROWDSEC_L4_ENV);
      const raw = found?.value ?? 'disabled';
      if (raw === mode) {
        appliedPods++;
      }
    }
  } catch {
    // empty
  }

  const sources = await resolveTrustSources(kubeconfigPath);
  const operatorIpTrusted = isOperatorIpTrusted(operatorIp, sources);

  return {
    mode,
    totalPods,
    appliedPods,
    operatorIp,
    operatorIpTrusted,
    trustedRangeCount: sources.trustedRangesV4.length + sources.trustedRangesV6.length,
    clusterPeerCount: sources.clusterPeersV4.length + sources.clusterPeersV6.length,
  };
};

/**
 * Patch the firewall-reconciler DS's pod-template env to set
 * CROWDSEC_L4_MODE. Throws OperatorIpNotTrustedError if the
 * operator's IP isn't trusted AND the target mode is "enforce".
 * `disabled` and `dryrun` are always allowed (they don't write nft).
 */
export const setL4Mode = async (
  kubeconfigPath: string | undefined,
  operatorIp: string | null,
  newMode: CrowdsecL4Mode,
): Promise<CrowdsecL4Status> => {
  if (newMode === 'enforce') {
    const sources = await resolveTrustSources(kubeconfigPath);
    if (!isOperatorIpTrusted(operatorIp, sources)) {
      throw new OperatorIpNotTrustedError(
        operatorIp,
        `OPERATOR_IP_NOT_TRUSTED: refusing to enable enforce — operator IP ${operatorIp ?? '(unknown)'} is not in any ClusterTrustedRange or cluster peer set. Add a ClusterTrustedRange covering your source IP before flipping to enforce.`,
      );
    }
  }

  const kc = new k8s.KubeConfig();
  if (kubeconfigPath) {
    kc.loadFromFile(kubeconfigPath);
  } else {
    kc.loadFromCluster();
  }
  const apps = kc.makeApiClient(k8s.AppsV1Api);

  // Read current env to merge — strategic-merge on env arrays needs
  // the full set replayed because the array's merge-key is `name` but
  // strategic merge only works if the entire structure is patched.
  // Easiest reliable path: PATCH the env value via a merge patch on
  // the specific env entry by index — but indices aren't stable.
  // Cleanest pattern: GET the DS, mutate the env array in place, PUT
  // it back. Use a merge patch on the entire pod template's env.
  //
  // We do a strategic-merge patch with the typed mergeKey hint via
  // `MERGE_PATCH` shared helper. This is the same pattern roundcube-db
  // uses and matches k8s expectations for env array updates.
  // Defense in depth: set the secondary guard env var alongside the
  // mode change. The Go reconciler refuses enforce mode unless BOTH
  // vars agree (a direct kubectl edit that sets only mode=enforce
  // gets downgraded to dryrun with a loud warning). The guard env is
  // ALWAYS "true" when set via the API — the API itself is the trust
  // verifier. Direct DS edits that bypass the API must add the guard
  // env by hand — explicit acknowledgement of the lockout risk.
  const guardValue = newMode === 'enforce' ? 'true' : '';
  const body = {
    spec: {
      template: {
        spec: {
          containers: [
            {
              name: 'reconciler', // must match the container name in the DS
              env: [
                { name: CROWDSEC_L4_ENV, value: newMode },
                { name: 'CROWDSEC_L4_GUARD_PASSED', value: guardValue },
              ],
            },
          ],
        },
      },
    },
  };

  // Strategic-merge (NOT plain merge) is required here: the env array
  // merge-key is `name`, and the container array merge-key is also
  // `name`. Plain merge-patch on the containers array would REPLACE it,
  // and the new object only has `name` + `env` (no `image`), so the
  // apiserver rejects with `spec.template.spec.containers[0].image:
  // Required value`. Strategic-merge correctly recognises `name` as
  // the merge key and patches in place. Caught during Stage D harness
  // verification on 2026-05-20.
  await apps.patchNamespacedDaemonSet(
    {
      name: FIREWALL_RECONCILER_DS,
      namespace: FIREWALL_RECONCILER_NAMESPACE,
      body,
    } as unknown as Parameters<typeof apps.patchNamespacedDaemonSet>[0],
    STRATEGIC_MERGE_PATCH,
  );

  // Return the fresh status (mode will read as newMode once the patch
  // commits; applied count will lag while pods roll).
  return getL4Status(kubeconfigPath, operatorIp);
};

// ─── CIDR helpers (CIDR-aware membership) ────────────────────────────

/**
 * Test if `ip` (bare v4 string) is inside `cidr` (v4 prefix string).
 * Pure-function, no deps. Returns false on any parse failure.
 */
const ipv4InCidr = (ip: string, cidr: string): boolean => {
  const [base, bitsStr] = cidr.split('/');
  if (!base || !bitsStr) return false;
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const ipNum = ipv4ToInt(ip);
  const baseNum = ipv4ToInt(base);
  if (ipNum === null || baseNum === null) return false;
  if (bits === 0) return true;
  // Mask: top `bits` bits of a 32-bit unsigned int.
  // Use BigInt to avoid 32-bit sign-extension surprises on >>> 0 edge cases.
  const mask = bits === 32 ? 0xffffffff : ((0xffffffff << (32 - bits)) >>> 0);
  return (ipNum & mask) === (baseNum & mask);
};

const ipv4ToInt = (s: string): number | null => {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  let v = 0;
  for (const p of parts) {
    const n = Number(p);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    v = ((v << 8) >>> 0) + n;
  }
  return v >>> 0;
};

/**
 * Test if `ip` (bare v6 string) is inside `cidr` (v6 prefix string).
 * Uses BigInt to handle 128-bit math; doesn't require a v6 library.
 */
const ipv6InCidr = (ip: string, cidr: string): boolean => {
  const [base, bitsStr] = cidr.split('/');
  if (!base || !bitsStr) return false;
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 128) return false;
  const ipBig = ipv6ToBigInt(ip);
  const baseBig = ipv6ToBigInt(base);
  if (ipBig === null || baseBig === null) return false;
  if (bits === 0) return true;
  const mask = ((1n << 128n) - 1n) ^ ((1n << BigInt(128 - bits)) - 1n);
  return (ipBig & mask) === (baseBig & mask);
};

const ipv6ToBigInt = (s: string): bigint | null => {
  // Expand "::" and parse 8 groups of up to 4 hex digits.
  // Reject obvious malformed inputs.
  if (!/^[0-9a-fA-F:]+$/.test(s)) return null;
  const parts = s.split('::');
  if (parts.length > 2) return null;
  const left = parts[0] ? parts[0].split(':') : [];
  const right = parts.length === 2 ? (parts[1] ? parts[1].split(':') : []) : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  // For "::1", parts=["",""], left=[""], right=[]; need to treat "" as 0.
  // Same for "1::", parts=["1",""], left=["1"], right=[].
  // Easier: trim empty leading/trailing entries that result from the split.
  const leftTrimmed = left.filter((p, i) => !(p === '' && i === 0 && parts.length === 2));
  const rightTrimmed = right.filter((p, i) => !(p === '' && i === right.length - 1 && parts.length === 2));
  const groups: string[] = [];
  groups.push(...leftTrimmed);
  if (parts.length === 2) {
    for (let i = 0; i < 8 - leftTrimmed.length - rightTrimmed.length; i++) {
      groups.push('0');
    }
  }
  groups.push(...rightTrimmed);
  if (groups.length !== 8) return null;
  let v = 0n;
  for (const g of groups) {
    if (g.length > 4) return null;
    const n = parseInt(g === '' ? '0' : g, 16);
    if (!Number.isInteger(n) || n < 0 || n > 0xffff) return null;
    v = (v << 16n) + BigInt(n);
  }
  return v;
};
