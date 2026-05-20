/**
 * F1+F6 Stage C — operator-facing CrowdSec L4 enforcement toggle.
 *
 * Three modes:
 *   - `disabled`: firewall-reconciler's crowdsec goroutine is dormant.
 *      Zero LAPI calls, zero kernel writes. **Default.**
 *   - `dryrun`: goroutine runs, fetches LAPI, computes exclusions, logs
 *      what WOULD be applied. Still zero kernel writes. Operator can
 *      verify what they'd see in `enforce` mode before flipping.
 *   - `enforce`: goroutine fetches + computes + WRITES the
 *      crowdsec_blocklist_v{4,6} nft sets. Banned IPs are dropped at
 *      L4 BEFORE reaching Traefik. Highest-risk mode — a bug here
 *      can drop legit traffic, including SSH.
 *
 * Defence in depth — operator-allowlist guard runs at PATCH time:
 *   Backend reads the request's X-Real-IP header (set by Traefik on
 *   the admin ingress) and checks it against the UNION of:
 *     - ClusterTrustedRange CRDs (trusted_ranges_v{4,6})
 *     - Node InternalIPs + ClusterPendingPeer (cluster_peers_v{4,6})
 *   If the operator's IP isn't in either, the PATCH is refused with
 *   `OPERATOR_IP_NOT_TRUSTED 403`. This prevents the obvious
 *   foot-gun where an operator behind a NAT (whose home IP isn't
 *   in trusted_ranges) flips to enforce and immediately gets caught
 *   by a CrowdSec scenario fired by their own probing.
 *
 * The guard is NOT user-disableable. Bypass requires direct
 * kubectl edit of the DaemonSet — which is itself the operator
 * acknowledging the risk on their own terms.
 */

import { z } from 'zod';

export const crowdsecL4ModeSchema = z.enum(['disabled', 'dryrun', 'enforce']);
export type CrowdsecL4Mode = z.infer<typeof crowdsecL4ModeSchema>;

export const crowdsecL4StatusSchema = z.object({
  /** Live env value read from the firewall-reconciler DaemonSet. May
   * differ briefly from a just-PATCHed value while pods roll. */
  mode: crowdsecL4ModeSchema,
  /** Total firewall-reconciler pods in the cluster (DS replicas).
   * Operator can compare against `appliedPods` to spot rollout lag. */
  totalPods: z.number().int().nonnegative(),
  /** Pods whose env reads as the live `mode` value. Equals totalPods
   * when rollout is complete; lower while rolling. */
  appliedPods: z.number().int().nonnegative(),
  /** Operator's detected source IP (from X-Real-IP). Surfaced so
   * the UI can show "you are coming from N.N.N.N, which is/isn't
   * trusted — flipping to enforce would/wouldn't lock you out". */
  operatorIp: z.string().nullable(),
  /** True if `operatorIp` is in trusted_ranges OR cluster_peers.
   * UI uses this to disable the enforce button when false. */
  operatorIpTrusted: z.boolean(),
  /** How many trusted prefixes the guard sees. Empty/zero means the
   * cluster has no CTRs and no cluster peers — flipping to enforce
   * from any non-cluster IP would be refused. */
  trustedRangeCount: z.number().int().nonnegative(),
  clusterPeerCount: z.number().int().nonnegative(),
});
export type CrowdsecL4Status = z.infer<typeof crowdsecL4StatusSchema>;

export const crowdsecL4PatchModeRequestSchema = z.object({
  mode: crowdsecL4ModeSchema,
});
export type CrowdsecL4PatchModeRequest = z.infer<typeof crowdsecL4PatchModeRequestSchema>;
