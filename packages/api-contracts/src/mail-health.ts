import { z } from 'zod';

/**
 * GET /admin/mail/health
 *
 * Real, verified mail-server health. Replaces the cosmetic "Mail Server
 * Status" tile that just echoed the operator's intent (placement +
 * port-exposure settings) without ever talking to the cluster. The
 * 2026-05-14 streamline made this an actual probe set.
 *
 * Each component reports `healthy: boolean` independently — the
 * top-level `healthy` is the AND of all components. Operator UI
 * (Phase-5 banner drill-down) renders the components in order:
 *
 *   pod        — does the Stalwart pod exist + is its `stalwart`
 *                container ready? Returns node name + phase. This
 *                catches CrashLoopBackOff, ImagePullBackOff, restore-
 *                state initContainer hangs, etc.
 *
 *   jmap       — does Stalwart actually answer JMAP? We call
 *                `Server/get` and report the response time + version.
 *                Catches "pod ready but RocksDB lock failed" and
 *                similar split-brain shapes.
 *
 *   rocksdb    — exec `stalwart -e check` inside the pod (or
 *                equivalent open-only validation). Catches DataStore
 *                corruption while pod and JMAP are both green. SHIPS
 *                as null/`not_implemented` in Phase 3a; populated in
 *                Phase 3b once the read-only check helper is wired
 *                into the Stalwart pod's command surface.
 *
 *   cert       — TLS cert serving on each mail port: validity window,
 *                issuer, days-until-expiry. SHIPS as null in Phase 3a;
 *                Phase 3b reuses the existing ssl-status cache.
 *
 *   tcp        — TCP reach (from the platform-api pod, which is on a
 *                different node) on every mail port. SHIPS as null in
 *                Phase 3a; Phase 3b implements with node-mode-aware
 *                target selection (Service VIP in allServerNodes mode,
 *                hostPort in thisNodeOnly mode).
 *
 * Backend caches the full response for `cachedFor` seconds (default
 * 30s). UI must NOT poll faster than the cache window — instead use
 * an explicit `?refresh=1` query param when the operator clicks
 * "Re-check now".
 */

const componentStatusSchema = z.object({
  healthy: z.boolean(),
  error: z.string().nullable(),
});

export const mailHealthPodComponentSchema = componentStatusSchema.extend({
  podName: z.string().nullable(),
  node: z.string().nullable(),
  phase: z.enum(['Pending', 'Running', 'Succeeded', 'Failed', 'Unknown']).nullable(),
  containerReady: z.boolean().nullable(),
  restartCount: z.number().int().nonnegative().nullable(),
  initContainerStatus: z.string().nullable(),
});

export const mailHealthJmapComponentSchema = componentStatusSchema.extend({
  durationMs: z.number().int().nonnegative().nullable(),
  serverName: z.string().nullable(),
  serverVersion: z.string().nullable(),
});

/**
 * Status enum shared by the optional Phase-3b probes (rocksdb / cert / tcp):
 *   `ok`              — probe ran AND result was good
 *   `fail`            — probe ran AND result was bad (see `error`)
 *   `not_implemented` — probe didn't run on this platform/build
 */
export const optionalProbeStatusSchema = z.enum(['ok', 'fail', 'not_implemented']);

export const mailHealthRocksdbComponentSchema = componentStatusSchema.extend({
  status: optionalProbeStatusSchema,
  /** RocksDB CURRENT sentinel file exists in /var/lib/stalwart/data. */
  currentFile: z.boolean().nullable(),
  /** RocksDB LOCK file exists (only present while DB is open). */
  lockFile: z.boolean().nullable(),
});

export const mailHealthCertPortSchema = z.object({
  port: z.number().int(),
  protocol: z.enum(['smtps', 'submission', 'imaps', 'imap', 'managesieve', 'smtp']),
  daysUntilExpiry: z.number().int().nullable(),
  issuer: z.string().nullable(),
  error: z.string().nullable(),
});

export const mailHealthCertComponentSchema = componentStatusSchema.extend({
  status: optionalProbeStatusSchema,
  ports: z.array(mailHealthCertPortSchema),
});

export const mailHealthTcpPortSchema = z.object({
  port: z.number().int(),
  reachable: z.boolean(),
  latencyMs: z.number().int().nullable(),
  error: z.string().nullable(),
});

export const mailHealthTcpComponentSchema = componentStatusSchema.extend({
  status: optionalProbeStatusSchema,
  ports: z.array(mailHealthTcpPortSchema),
});

// ── Deliverability sub-probes (forward DNS, reverse DNS / FCrDNS, DNSBL,
// cert SAN match, SMTP banner). These hit *external* infrastructure
// (recursor + DNSBL providers) so they are inherently slower and
// noisier than the cluster-internal probes above. Each sub-probe carries
// the full advice payload — severity, expected vs actual, and a
// remediation string the operator can act on — because the UI surfaces
// them in a drill-down modal with per-row guidance.
//
// severity meanings:
//   `ok`        — assertion held; no action needed
//   `warning`   — assertion partially held or returned soft-fail; deliverability
//                 may degrade for some recipients (e.g. listed on a single
//                 mid-trust DNSBL)
//   `fail`      — assertion failed; mail flow likely broken or rejected
//                 (e.g. PTR doesn't match HELO, listed on Spamhaus ZEN)
//   `advisory`  — informational only; not factored into top-level `healthy`
//   `skipped`   — probe couldn't run (no hostname configured, no resolver,
//                 etc.); shown in modal but doesn't count against the
//                 deliverability rollup

export const deliverabilityProbeSeveritySchema = z.enum(['ok', 'warning', 'fail', 'advisory', 'skipped']);
export type DeliverabilityProbeSeverity = z.infer<typeof deliverabilityProbeSeveritySchema>;

const deliverabilityProbeBaseSchema = z.object({
  severity: deliverabilityProbeSeveritySchema,
  /** What the probe asserts (short imperative, e.g. "mail hostname has a PTR"). */
  assertion: z.string(),
  /** What was actually observed (free text). */
  actual: z.string().nullable(),
  /** What was expected (free text). */
  expected: z.string().nullable(),
  /** Operator-facing remediation steps when severity != 'ok'. */
  remediation: z.string().nullable(),
});

export const mailHealthForwardDnsProbeSchema = deliverabilityProbeBaseSchema.extend({
  hostname: z.string(),
  resolvedIps: z.array(z.string()),
  expectedIps: z.array(z.string()),
  missingIps: z.array(z.string()),
  extraIps: z.array(z.string()),
});
export type MailHealthForwardDnsProbe = z.infer<typeof mailHealthForwardDnsProbeSchema>;

export const mailHealthReverseDnsProbeSchema = deliverabilityProbeBaseSchema.extend({
  ip: z.string(),
  ptrRecords: z.array(z.string()),
  expectedPtr: z.string(),
  fcrdnsOk: z.boolean(),
});
export type MailHealthReverseDnsProbe = z.infer<typeof mailHealthReverseDnsProbeSchema>;

export const mailHealthBlocklistProbeSchema = deliverabilityProbeBaseSchema.extend({
  ip: z.string(),
  /** Short label, e.g. "Spamhaus ZEN". */
  list: z.string(),
  /** DNS zone queried, e.g. "zen.spamhaus.org". */
  zone: z.string(),
  listed: z.boolean(),
  /** Listing reason from TXT record if available. */
  reasonTxt: z.string().nullable(),
  /** Provider URL for removal/lookup. */
  lookupUrl: z.string().nullable(),
});
export type MailHealthBlocklistProbe = z.infer<typeof mailHealthBlocklistProbeSchema>;

export const mailHealthCertSanProbeSchema = deliverabilityProbeBaseSchema.extend({
  hostname: z.string(),
  /** SAN DNS names extracted from the served certificate. */
  sanDnsNames: z.array(z.string()),
  /** True if hostname matched a SAN entry (exact or wildcard). */
  matched: z.boolean(),
});
export type MailHealthCertSanProbe = z.infer<typeof mailHealthCertSanProbeSchema>;

export const mailHealthSmtpBannerProbeSchema = deliverabilityProbeBaseSchema.extend({
  hostname: z.string(),
  /** Hostname advertised in the 220 banner. */
  bannerHostname: z.string().nullable(),
  /** Hostname advertised in the first EHLO 250 line. */
  ehloHostname: z.string().nullable(),
  bannerMatches: z.boolean(),
  ehloMatches: z.boolean(),
});
export type MailHealthSmtpBannerProbe = z.infer<typeof mailHealthSmtpBannerProbeSchema>;

export const mailHealthDeliverabilityComponentSchema = componentStatusSchema.extend({
  status: optionalProbeStatusSchema,
  /** Hostname the probes were run against (mail.<apex> or operator override). */
  hostname: z.string().nullable(),
  /** Server-role node IPs that the cluster believes serve mail. */
  expectedMailIps: z.array(z.string()),
  forwardDns: mailHealthForwardDnsProbeSchema.nullable(),
  reverseDns: z.array(mailHealthReverseDnsProbeSchema),
  blocklists: z.array(mailHealthBlocklistProbeSchema),
  certSanMatch: mailHealthCertSanProbeSchema.nullable(),
  smtpBanner: mailHealthSmtpBannerProbeSchema.nullable(),
  /** Rollup: ok / warning / fail / advisory counts across all sub-probes. */
  summary: z.object({
    ok: z.number().int().nonnegative(),
    warning: z.number().int().nonnegative(),
    fail: z.number().int().nonnegative(),
    advisory: z.number().int().nonnegative(),
    skipped: z.number().int().nonnegative(),
  }),
});
export type MailHealthDeliverabilityComponent = z.infer<typeof mailHealthDeliverabilityComponentSchema>;

export const mailHealthResponseSchema = z.object({
  healthy: z.boolean(),
  components: z.object({
    pod: mailHealthPodComponentSchema,
    jmap: mailHealthJmapComponentSchema,
    rocksdb: mailHealthRocksdbComponentSchema,
    cert: mailHealthCertComponentSchema,
    tcp: mailHealthTcpComponentSchema,
    /**
     * External deliverability probes (DNS, blocklists, banner, cert SAN
     * match). Optional in the response because rollout is staged: older
     * backends still emit the 5-component shape. Frontend renders the
     * modal section only when this is present.
     */
    deliverability: mailHealthDeliverabilityComponentSchema.optional(),
  }),
  checkedAt: z.string().datetime(),
  cachedFor: z.number().int().nonnegative(),
});
export type MailHealthResponse = z.infer<typeof mailHealthResponseSchema>;
export type MailHealthPodComponent = z.infer<typeof mailHealthPodComponentSchema>;
export type MailHealthJmapComponent = z.infer<typeof mailHealthJmapComponentSchema>;
export type MailHealthRocksdbComponent = z.infer<typeof mailHealthRocksdbComponentSchema>;
export type MailHealthCertComponent = z.infer<typeof mailHealthCertComponentSchema>;
export type MailHealthCertPort = z.infer<typeof mailHealthCertPortSchema>;
export type MailHealthTcpComponent = z.infer<typeof mailHealthTcpComponentSchema>;
export type MailHealthTcpPort = z.infer<typeof mailHealthTcpPortSchema>;
