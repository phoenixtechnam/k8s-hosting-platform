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
  /** True if this is a long-duration "static" ban (origin=cscli AND scenario starts with "admin-panel-static:"). */
  staticByOperator: z.boolean(),
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
  /** Filter to only static (long-duration) operator-added bans. */
  staticOnly: z.coerce.boolean().optional(),
});
export type CrowdsecListDecisionsQuery = z.infer<typeof crowdsecListDecisionsQuerySchema>;

export const crowdsecListDecisionsResponseSchema = z.object({
  decisions: z.array(crowdsecDecisionSchema),
  /** Total before any filter — useful for the "X of Y" UI label. */
  totalActive: z.number().int().min(0),
});
export type CrowdsecListDecisionsResponse = z.infer<typeof crowdsecListDecisionsResponseSchema>;

// ─── Add manual ban ─────────────────────────────────────────────────────

/**
 * Sum a CrowdSec duration string like "4h30m12s" or "7d" into milliseconds.
 * Returns NaN for unparseable input. Exported so backend + frontend can
 * apply the same numeric clamp without drift.
 */
export function crowdsecDurationToMs(duration: string): number {
  const re = /(\d+)([smhd])/g;
  let total = 0;
  let matched = false;
  let m: RegExpExecArray | null;
  while ((m = re.exec(duration)) !== null) {
    matched = true;
    const n = Number(m[1]);
    const mult = m[2] === 's' ? 1_000 : m[2] === 'm' ? 60_000 : m[2] === 'h' ? 3_600_000 : 86_400_000;
    total += n * mult;
  }
  return matched ? total : NaN;
}

/** Maximum ban duration: 8760h = 1 year. addStaticBan uses exactly this. */
export const MAX_BAN_DURATION_MS = 8760 * 60 * 60 * 1000;
/** Minimum ban duration: 1 minute. */
export const MIN_BAN_DURATION_MS = 60 * 1000;

export const crowdsecAddBanRequestSchema = z.object({
  /** IPv4, IPv6 or CIDR. */
  value: z.string().min(1).max(64).regex(/^[a-fA-F0-9.:/]+$/, 'value must be an IP or CIDR'),
  scope: crowdsecDecisionScopeSchema.default('Ip'),
  /** CrowdSec duration string: e.g. "1h", "4h30m", "7d". Min 1m, max 8760h (1y) — enforced numerically below. */
  duration: z.string().min(2).max(16)
    .regex(/^\d+[smhd](\d+[smhd])*$/, 'must be a CrowdSec duration like "4h" or "30m"')
    .refine((v) => {
      const ms = crowdsecDurationToMs(v);
      return ms >= MIN_BAN_DURATION_MS && ms <= MAX_BAN_DURATION_MS;
    }, `duration must be between 1m and 8760h (1 year)`),
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

// ─── F2 — allowlist (cscli allowlists wrapper) ──────────────────────────

export const crowdsecAllowlistEntrySchema = z.object({
  /** IP, CIDR, or country code depending on scope. */
  value: z.string().min(1).max(64),
  scope: crowdsecDecisionScopeSchema,
  /** Operator-supplied reason / comment. Single line. */
  comment: z.string().max(200),
  /** Who added it (sub claim). */
  addedBy: z.string().nullable(),
  /** When (ISO). */
  addedAt: z.string().datetime().nullable(),
  /** Expiration if any. null = never expires. */
  expiresAt: z.string().datetime().nullable(),
});
export type CrowdsecAllowlistEntry = z.infer<typeof crowdsecAllowlistEntrySchema>;

export const crowdsecListAllowlistResponseSchema = z.object({
  entries: z.array(crowdsecAllowlistEntrySchema),
});
export type CrowdsecListAllowlistResponse = z.infer<typeof crowdsecListAllowlistResponseSchema>;

export const crowdsecAddAllowlistRequestSchema = z.object({
  /** IPv4, IPv6, or CIDR. */
  value: z.string().min(1).max(64).regex(/^[a-fA-F0-9.:/]+$/, 'value must be an IP or CIDR'),
  /** Default Ip; Range = CIDR. */
  scope: crowdsecDecisionScopeSchema.default('Ip'),
  /**
   * Operator-supplied comment surfaced in the listing. Required so entries
   * aren't anonymous. Single line of printable text (CR/LF rejected to
   * avoid log-injection via cscli output).
   */
  comment: z.string().min(3).max(200).regex(/^[^\r\n\x00-\x1f]+$/, 'comment must be single line of printable text'),
});
export type CrowdsecAddAllowlistRequest = z.infer<typeof crowdsecAddAllowlistRequestSchema>;

export const crowdsecAddAllowlistResponseSchema = z.object({
  message: z.string(),
  value: z.string(),
  scope: crowdsecDecisionScopeSchema,
  comment: z.string(),
});
export type CrowdsecAddAllowlistResponse = z.infer<typeof crowdsecAddAllowlistResponseSchema>;

export const crowdsecRemoveAllowlistResponseSchema = z.object({
  message: z.string(),
  removed: z.number().int().min(0),
});
export type CrowdsecRemoveAllowlistResponse = z.infer<typeof crowdsecRemoveAllowlistResponseSchema>;

// ─── F2 — static (long-duration) ban ────────────────────────────────────
//
// Implementation note: there's no "permanent" decision type in CrowdSec;
// we re-use `addBan` with the maximum supported duration `8760h` (1 year)
// and a distinguishing scenario prefix `admin-panel-static:` so the list
// endpoint can flag them as `staticByOperator: true`.

export const crowdsecAddStaticBanRequestSchema = z.object({
  value: z.string().min(1).max(64).regex(/^[a-fA-F0-9.:/]+$/, 'value must be an IP or CIDR'),
  scope: crowdsecDecisionScopeSchema.default('Ip'),
  reason: z.string().min(3).max(200).regex(/^[^\r\n\x00-\x1f]+$/, 'reason must be single line of printable text'),
});
export type CrowdsecAddStaticBanRequest = z.infer<typeof crowdsecAddStaticBanRequestSchema>;

/**
 * Aggregate decision counts broken down by origin (CAPI = community
 * blocklist, cscli = operator-added manual bans, lists/* = console
 * blocklists, crowdsecurity/* = local scenario triggers). null when
 * cscli was unavailable on the most-recent check — UI renders as
 * "(count unavailable)" rather than misleading zeros.
 *
 * Source: `cscli metrics show decisions -o json` — returns aggregate
 * counts, scales to a 6M-entry community blocklist without OOM.
 */
export const crowdsecDecisionCountsSchema = z.object({
  total: z.number().int().min(0),
  byOrigin: z.record(z.string(), z.number().int().min(0)),
  /** Convenience field — equals byOrigin.CAPI or 0. */
  communityBlocklist: z.number().int().min(0),
});
export type CrowdsecDecisionCounts = z.infer<typeof crowdsecDecisionCountsSchema>;

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
  /** Aggregate decision counts. null when cscli was unavailable. */
  decisionCounts: crowdsecDecisionCountsSchema.nullable(),
});
export type CrowdsecStatus = z.infer<typeof crowdsecStatusSchema>;

/**
 * Manual stale-bouncer prune response. The platform also runs an
 * auto-prune scheduler every 24h that calls the same backend path —
 * the manual route just lets the operator trigger it on demand.
 *
 * `olderThanSeconds` defaults to 24h on the backend; the API doesn't
 * accept overrides (defence: a low override could prune live bouncers
 * mid-pull). To change the threshold, edit the constant in
 * backend/src/modules/security-hardening/crowdsec.ts.
 */
export const crowdsecPruneBouncersResponseSchema = z.object({
  message: z.string(),
  pruned: z.number().int().min(0),
  olderThanSeconds: z.number().int().positive(),
});
export type CrowdsecPruneBouncersResponse = z.infer<typeof crowdsecPruneBouncersResponseSchema>;
