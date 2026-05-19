/**
 * CrowdSec — Banned IPs admin schemas.
 *
 * Wraps the in-cluster CrowdSec Local API (LAPI) at
 * http://crowdsec.crowdsec.svc.cluster.local:8080. Reads use the
 * bouncer key (from Secret `crowdsec/crowdsec-bouncer-key`); writes
 * (manual ban + unban) shell out to `cscli` inside the CrowdSec pod
 * via `kubectl exec` because the LAPI machine-auth path is not
 * exposed to the platform — same kubectl-exec pattern as the existing
 * container-console module.
 *
 * Enforcement coverage is by-design cluster-wide: the bouncer is
 * loaded as a Traefik middleware on the Traefik DaemonSet, so every
 * node's Traefik replica queries the same LAPI on every request.
 * See k8s/base/crowdsec/deployment.yaml for the architecture
 * narrative.
 */

import { z } from 'zod';

export const crowdsecDecisionScopeSchema = z.enum(['Ip', 'Range', 'Country', 'AS']);
export type CrowdsecDecisionScope = z.infer<typeof crowdsecDecisionScopeSchema>;

export const crowdsecDecisionTypeSchema = z.enum(['ban', 'captcha', 'throttle', 'mfa']);
export type CrowdsecDecisionType = z.infer<typeof crowdsecDecisionTypeSchema>;

export const crowdsecDecisionSchema = z.object({
  /** LAPI's numeric decision ID — required for delete-by-id. */
  id: z.number().int().min(0),
  /** "cscli" for manual bans; the scenario name (e.g. "crowdsecurity/http-bf") for scenarios. */
  origin: z.string(),
  type: crowdsecDecisionTypeSchema,
  scope: crowdsecDecisionScopeSchema,
  /** IP, CIDR range, country code, or AS number, depending on scope. */
  value: z.string(),
  /** Scenario / reason text. For manual bans this is the operator-supplied reason. */
  scenario: z.string(),
  /** Human-readable time-remaining e.g. "4h30m12s". */
  duration: z.string(),
  /** When the decision expires (LAPI doesn't always provide an absolute time — best-effort derived). */
  expiresAt: z.string().datetime().nullable(),
  /** True if this was added by the platform-api UI (origin=cscli AND scenario starts with "admin-panel:"). */
  manualByOperator: z.boolean(),
  /** True if simulated (won't actually be enforced). */
  simulated: z.boolean(),
});
export type CrowdsecDecision = z.infer<typeof crowdsecDecisionSchema>;

export const crowdsecListDecisionsQuerySchema = z.object({
  /** Substring match on `value` (IP/CIDR/country) for filtering. */
  q: z.string().max(64).regex(/^[a-zA-Z0-9.:\-_/]*$/, 'invalid characters in filter').optional(),
  /** Filter by scope. */
  scope: crowdsecDecisionScopeSchema.optional(),
  /** Filter to only operator-added bans (origin=cscli + admin-panel prefix). */
  manualOnly: z.coerce.boolean().optional(),
});
export type CrowdsecListDecisionsQuery = z.infer<typeof crowdsecListDecisionsQuerySchema>;

export const crowdsecListDecisionsResponseSchema = z.object({
  decisions: z.array(crowdsecDecisionSchema),
  /** Total before any filter — useful for the "X of Y" UI label. */
  totalActive: z.number().int().min(0),
});
export type CrowdsecListDecisionsResponse = z.infer<typeof crowdsecListDecisionsResponseSchema>;

// ─── Add manual ban ─────────────────────────────────────────────────────

export const crowdsecAddBanRequestSchema = z.object({
  /** IPv4, IPv6 or CIDR. */
  value: z.string().min(1).max(64).regex(/^[a-fA-F0-9.:/]+$/, 'value must be an IP or CIDR'),
  scope: crowdsecDecisionScopeSchema.default('Ip'),
  /** CrowdSec duration string: e.g. "1h", "4h30m", "7d". Min 1m, max 8760h (1y). */
  duration: z.string().min(2).max(16).regex(/^\d+[smhd](\d+[smhd])*$/, 'must be a CrowdSec duration like "4h" or "30m"'),
  /**
   * Operator-supplied reason — surfaced in the decisions list. Required so
   * bans aren't anonymous. Restricted to single-line printable text: no CR,
   * LF, or C0 control chars (prevents log-injection if the raw scenario
   * string is ever piped to a structured logger that splits on newlines).
   */
  reason: z.string().min(3).max(200).regex(/^[^\r\n\x00-\x1f]+$/, 'reason must be a single line of printable text'),
});
export type CrowdsecAddBanRequest = z.infer<typeof crowdsecAddBanRequestSchema>;

export const crowdsecAddBanResponseSchema = z.object({
  /** Pretty-printed cscli stdout for the operator log. */
  message: z.string(),
  /** Echoed inputs (for the UI to show success card without re-fetching). */
  value: z.string(),
  scope: crowdsecDecisionScopeSchema,
  duration: z.string(),
  reason: z.string(),
});
export type CrowdsecAddBanResponse = z.infer<typeof crowdsecAddBanResponseSchema>;

// ─── Delete (unban) ─────────────────────────────────────────────────────

export const crowdsecDeleteByIdResponseSchema = z.object({
  message: z.string(),
  /** Count of decisions actually removed (LAPI may delete >1 if a single ID was attached to multiple decisions). */
  deleted: z.number().int().min(0),
});
export type CrowdsecDeleteByIdResponse = z.infer<typeof crowdsecDeleteByIdResponseSchema>;

// ─── Status / coverage ──────────────────────────────────────────────────

export const crowdsecMachineSchema = z.object({
  name: z.string(),
  ipAddress: z.string(),
  lastHeartbeatAt: z.string().nullable(),
  online: z.boolean(),
});
export type CrowdsecMachine = z.infer<typeof crowdsecMachineSchema>;

export const crowdsecBouncerSchema = z.object({
  name: z.string(),
  ipAddress: z.string(),
  type: z.string(),
  lastApiPullAt: z.string().nullable(),
  /** Online = pulled within the last 5 minutes. */
  online: z.boolean(),
});
export type CrowdsecBouncer = z.infer<typeof crowdsecBouncerSchema>;

export const crowdsecCoverageSchema = z.object({
  /** Total Traefik DaemonSet pods (one per node). */
  traefikPodsTotal: z.number().int().min(0),
  /** Traefik pods with the crowdsec middleware mounted + reachable. */
  traefikPodsCovered: z.number().int().min(0),
  /** modsec-crs pods running (informational — modsec is independent of CrowdSec). */
  modsecPodsTotal: z.number().int().min(0),
  /** Total cluster nodes (sanity check vs traefik DS replicas). */
  nodesTotal: z.number().int().min(0),
});
export type CrowdsecCoverage = z.infer<typeof crowdsecCoverageSchema>;

export const crowdsecStatusSchema = z.object({
  /** True if the LAPI /health endpoint responded OK on the most-recent check. */
  lapiHealthy: z.boolean(),
  /** Optional human-readable LAPI error if not healthy. */
  lapiError: z.string().nullable(),
  /** True if cscli reports CAPI auth working (community blocklist pull enabled). */
  capiAuthenticated: z.boolean(),
  /** True if `cscli capi status` reports the community blocklist pull is enabled. */
  communityBlocklistEnabled: z.boolean(),
  machines: z.array(crowdsecMachineSchema),
  bouncers: z.array(crowdsecBouncerSchema),
  /** Count of loaded scenarios (rules that can trigger automatic bans). */
  scenariosLoaded: z.number().int().min(0),
  coverage: crowdsecCoverageSchema,
});
export type CrowdsecStatus = z.infer<typeof crowdsecStatusSchema>;
