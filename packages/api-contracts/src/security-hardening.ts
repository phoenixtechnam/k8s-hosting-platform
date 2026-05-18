/**
 * Security / Firewall / Node Hardening — admin-side schemas.
 *
 * Drives the `/settings/security-hardening` admin page. The
 * `security-probe` DaemonSet writes one ConfigMap per node into the
 * `platform-system` namespace; the backend composes those snapshots
 * into a single envelope keyed by node name and surfaces it through
 * `GET /admin/security-hardening`.
 *
 * Read-mostly contract — write actions in Phase 1 are limited to the
 * existing ClusterPendingPeer / ClusterTrustedRange CRUD already
 * exposed under `/admin/cluster/*`. Destructive ops (SSH lockdown,
 * mesh provider switch) surface as guided runbooks driven by the
 * `bootstrap.sh --ssh-via-mesh` flag and verified via probe poll.
 *
 * See docs/04-deployment/SECURITY_HARDENING_ROADMAP.md.
 */

import { z } from 'zod';

// ─── Mesh provider ──────────────────────────────────────────────────────
//
// Operator picks ONE per node. Detection is interface-based: the probe
// looks for the well-known interface name of each provider. `none` =
// no mesh detected; SSH lockdown will refuse to enable in that state.

export const meshProviderSchema = z.enum(['netbird', 'tailscale', 'wireguard', 'none']);
export type MeshProvider = z.infer<typeof meshProviderSchema>;

export const nodeMeshStatusSchema = z.object({
  nodeName: z.string().min(1).max(253),
  provider: meshProviderSchema,
  /** Interface name the probe detected (`wt0`, `tailscale0`, `wg0`, etc.). null when `none`. */
  interfaceName: z.string().nullable(),
  /** First non-link-local IP bound to the interface. null when `none` or no IP yet. */
  interfaceIp: z.string().nullable(),
  /** Peer count from `wg show` / `tailscale status` / `netbird status`; null when unknown. */
  peerCount: z.number().int().min(0).nullable(),
  /** Seconds since last handshake (best-effort, WireGuard only); null when unknown. */
  lastHandshakeAgeSeconds: z.number().int().min(0).nullable(),
});
export type NodeMeshStatus = z.infer<typeof nodeMeshStatusSchema>;

// ─── SSH exposure ───────────────────────────────────────────────────────

export const sshRestrictionModeSchema = z.enum(['public', 'mesh-only', 'trusted-only', 'mesh-and-trusted']);
export type SshRestrictionMode = z.infer<typeof sshRestrictionModeSchema>;

/** Flattened sshd_config flags relevant to hardening. */
export const sshdFlagsSchema = z.object({
  permitRootLogin: z.string().nullable(),
  passwordAuthentication: z.string().nullable(),
  kbdInteractiveAuthentication: z.string().nullable(),
  allowUsers: z.array(z.string()),
  port: z.number().int().min(1).max(65535),
  /** sha256 of the merged sshd_config text — surfaces drift between nodes. */
  configSha256: z.string().length(64),
});
export type SshdFlags = z.infer<typeof sshdFlagsSchema>;

export const nodeSshExposureSchema = z.object({
  nodeName: z.string().min(1).max(253),
  /** Inferred from nft rules: what does the firewall actually allow on :22? */
  restrictionMode: sshRestrictionModeSchema,
  /** True when bootstrap.sh was invoked with --ssh-via-mesh (persisted in /etc/hosting-platform/firewall.conf). */
  sshViaMeshFlag: z.boolean(),
  /** Mesh interface enforced (if sshViaMeshFlag); empty when public. */
  enforcedInterface: z.string().nullable(),
  sshdFlags: sshdFlagsSchema,
  /** Probe reports whether sshd_config could be fully parsed.
   *  When false, UI MUST surface "config parse failed" — never display the flags as authoritative. */
  parseSucceeded: z.boolean(),
  parseError: z.string().nullable(),
});
export type NodeSshExposure = z.infer<typeof nodeSshExposureSchema>;

// ─── Node hardening (CIS-style) ─────────────────────────────────────────

export const cisSeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info']);
export type CisSeverity = z.infer<typeof cisSeveritySchema>;

export const cisFindingSchema = z.object({
  id: z.string().min(3).max(32),
  severity: cisSeveritySchema,
  title: z.string().min(1).max(200),
  observed: z.string().max(500),
  expected: z.string().max(500),
  /** When true the check passed and the row is informational only. */
  passing: z.boolean(),
});
export type CisFinding = z.infer<typeof cisFindingSchema>;

export const nodeHardeningSchema = z.object({
  nodeName: z.string().min(1).max(253),
  kernelVersion: z.string(),
  kernelEol: z.boolean(),
  /** Seconds since boot. */
  timeSinceRebootSeconds: z.number().int().min(0),
  /** True when apt/dnf reports a pending kernel upgrade (best-effort). */
  pendingKernelUpdate: z.boolean(),
  fail2banPresent: z.boolean(),
  sshguardPresent: z.boolean(),
  unattendedUpgradesActive: z.boolean(),
  /** From /etc/apt/apt.conf.d/50unattended-upgrades or equivalent. */
  automaticRebootWindow: z.string().nullable(),
  /** Distro+version from /etc/os-release. */
  osPretty: z.string(),
  cisFindings: z.array(cisFindingSchema),
});
export type NodeHardening = z.infer<typeof nodeHardeningSchema>;

// ─── Firewall posture ───────────────────────────────────────────────────

export const firewallModeSchema = z.enum(['set', 'cidr', 'single']);
export type FirewallMode = z.infer<typeof firewallModeSchema>;

export const publicPortsPerNodeSchema = z.object({
  nodeName: z.string().min(1).max(253),
  tcp: z.array(z.number().int().min(1).max(65535)),
  udp: z.array(z.number().int().min(1).max(65535)),
});
export type PublicPortsPerNode = z.infer<typeof publicPortsPerNodeSchema>;

export const deniedCountWindowSchema = z.object({
  /** False when the probe couldn't read conntrack (capability, permission, missing file). */
  available: z.boolean(),
  denies: z.number().int().min(0).nullable(),
  windowSeconds: z.number().int().min(1).max(86400),
  reason: z.string().nullable(),
});
export type DeniedCountWindow = z.infer<typeof deniedCountWindowSchema>;

/** Phase 2.3: top-N denied source IPs from /proc/net/nf_conntrack. */
export const deniedSourceSchema = z.object({
  ip: z.string().min(1).max(64),
  count: z.number().int().min(1),
  firstSeenAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
  family: z.enum(['v4', 'v6']),
});
export type DeniedSource = z.infer<typeof deniedSourceSchema>;

export const firewallPostureSchema = z.object({
  mode: firewallModeSchema,
  clusterPeersV4Count: z.number().int().min(0),
  clusterPeersV6Count: z.number().int().min(0),
  trustedRangesV4Count: z.number().int().min(0),
  trustedRangesV6Count: z.number().int().min(0),
  publicPortsPerNode: z.array(publicPortsPerNodeSchema),
  deniedCountWindow: deniedCountWindowSchema,
  /** Phase 2.3: present when probe reports denied-source rollup. */
  topDeniedSources: z.array(deniedSourceSchema).default([]),
});
export type FirewallPosture = z.infer<typeof firewallPostureSchema>;

// ─── Phase 2 cards (codebase-grounded suggested displays) ──────────────

/** Phase 2.5.1 — Calico WG (51821) verification card. */
export const calicoWgStatusSchema = z.object({
  /** Number of nodes where the probe observed a UDP/51821 listener. */
  listeningNodes: z.number().int().min(0),
  /** Total expected (cluster Node count). */
  totalNodes: z.number().int().min(0),
  /** True when every node has the listener up AND public-key auth confirmed (Calico WG default). */
  publicKeyAuthConfirmed: z.boolean(),
});
export type CalicoWgStatus = z.infer<typeof calicoWgStatusSchema>;

/** Phase 2.5.2 — reserved-platform-hostname collision feed (ADR-040). */
export const reservedHostnameCollisionSchema = z.object({
  occurredAt: z.string().datetime(),
  tenantId: z.string().nullable(),
  hostname: z.string(),
  surface: z.enum(['domain', 'dns-record']),
  userId: z.string().nullable(),
});
export type ReservedHostnameCollision = z.infer<typeof reservedHostnameCollisionSchema>;

/** Phase 2.5.3 — TLS cert expiry < 30d. */
export const certExpirySchema = z.object({
  name: z.string(),
  namespace: z.string(),
  /** ISO datetime when the cert expires (notAfter from the cert-manager status). */
  expiresAt: z.string().datetime(),
  daysRemaining: z.number().int(),
  ready: z.boolean(),
});
export type CertExpiry = z.infer<typeof certExpirySchema>;

/** Phase 2.5.4 — backup target encryption + freshness. */
export const backupTargetHealthSchema = z.object({
  id: z.string(),
  name: z.string(),
  encryptionAtRest: z.boolean(),
  lastConnectionTestAt: z.string().datetime().nullable(),
  lastConnectionTestOk: z.boolean().nullable(),
  lastSuccessfulSnapshotAt: z.string().datetime().nullable(),
  daysSinceLastSnapshot: z.number().int().min(0).nullable(),
});
export type BackupTargetHealth = z.infer<typeof backupTargetHealthSchema>;

/** Phase 2.5.5 — audit-log gap detector. */
export const auditLogHealthSchema = z.object({
  lastInsertAt: z.string().datetime().nullable(),
  /** Seconds since the most recent audit-log insert. */
  secondsSinceLastInsert: z.number().int().min(0).nullable(),
  /** Rolling 7-day average insert rate (rows per hour). */
  rollingHourlyRate: z.number().min(0),
  /** True when secondsSinceLastInsert exceeds 4x the rolling rate's expected gap. */
  gapSuspected: z.boolean(),
  /** True when audit_logs row count strictly increased since process start.
   *  Null when the baseline hasn't been captured yet (e.g. first observation,
   *  process restart). Treat null as "not yet known" in UI rendering. */
  rowCountMonotonic: z.boolean().nullable(),
});
export type AuditLogHealth = z.infer<typeof auditLogHealthSchema>;

// ─── K8s posture (Phase 2.1) ────────────────────────────────────────────

export const pssLevelSchema = z.enum(['privileged', 'baseline', 'restricted', 'unset']);
export type PssLevel = z.infer<typeof pssLevelSchema>;

export const namespacePssSchema = z.object({
  namespace: z.string(),
  enforceLevel: pssLevelSchema,
  warnLevel: pssLevelSchema,
  auditLevel: pssLevelSchema,
});
export type NamespacePss = z.infer<typeof namespacePssSchema>;

export const privilegedPodSchema = z.object({
  namespace: z.string(),
  name: z.string(),
  reasons: z.array(z.string()),
});
export type PrivilegedPod = z.infer<typeof privilegedPodSchema>;

export const k8sPostureSchema = z.object({
  namespacePss: z.array(namespacePssSchema),
  privilegedPods: z.array(privilegedPodSchema),
  hostPathPods: z.array(privilegedPodSchema),
  hostNetworkPods: z.array(privilegedPodSchema),
  totalPodCount: z.number().int().min(0),
});
export type K8sPosture = z.infer<typeof k8sPostureSchema>;

// ─── Auth/Audit metrics (Phase 2.2) ────────────────────────────────────

export const authPostureSchema = z.object({
  failedLogins24h: z.number().int().min(0),
  failedLogins7d: z.number().int().min(0),
  oldestActiveSessionAgeSeconds: z.number().int().min(0).nullable(),
  jwtSecretAgeSeconds: z.number().int().min(0).nullable(),
  dexHealthy: z.boolean().nullable(),
  oauth2ProxyHealthy: z.boolean().nullable(),
  lastSuccessfulDexLoginAt: z.string().datetime().nullable(),
});
export type AuthPosture = z.infer<typeof authPostureSchema>;

// ─── Recent security events (audit-log filter) ──────────────────────────

export const securityEventSchema = z.object({
  occurredAt: z.string().datetime(),
  resourceType: z.string(),
  action: z.string(),
  resourceName: z.string().nullable(),
  userId: z.string().nullable(),
  outcome: z.enum(['success', 'failure', 'unknown']),
});
export type SecurityEvent = z.infer<typeof securityEventSchema>;

// ─── Composed node snapshot ─────────────────────────────────────────────

export const nodeSecuritySnapshotSchema = z.object({
  name: z.string().min(1).max(253),
  /** Probe ConfigMap's lastUpdatedAt; null when no probe report for this node yet. */
  lastUpdatedAt: z.string().datetime().nullable(),
  /** True when lastUpdatedAt is older than 5min (UI flags as "stale"). */
  stale: z.boolean(),
  mesh: nodeMeshStatusSchema,
  ssh: nodeSshExposureSchema,
  hardening: nodeHardeningSchema,
});
export type NodeSecuritySnapshot = z.infer<typeof nodeSecuritySnapshotSchema>;

// ─── Top-level envelope returned by GET /admin/security-hardening ─────

export const securityHardeningSnapshotSchema = z.object({
  generatedAt: z.string().datetime(),
  nodes: z.array(nodeSecuritySnapshotSchema),
  firewall: firewallPostureSchema,
  recentEvents: z.array(securityEventSchema),
  // Phase 2 cards
  calicoWg: calicoWgStatusSchema.nullable(),
  reservedHostnameCollisions: z.array(reservedHostnameCollisionSchema).default([]),
  certExpiries: z.array(certExpirySchema).default([]),
  backupTargets: z.array(backupTargetHealthSchema).default([]),
  auditLogHealth: auditLogHealthSchema.nullable(),
  k8sPosture: k8sPostureSchema.nullable(),
  authPosture: authPostureSchema.nullable(),
});
export type SecurityHardeningSnapshot = z.infer<typeof securityHardeningSnapshotSchema>;

export const securityHardeningResponseSchema = z.object({
  data: securityHardeningSnapshotSchema,
});
export type SecurityHardeningResponse = z.infer<typeof securityHardeningResponseSchema>;

// ─── Refresh action ─────────────────────────────────────────────────────

/** POST /admin/security-hardening/refresh — bumps an annotation on the
 *  security-probe DaemonSet to kick a probe loop early. Returns the
 *  fresh snapshot the next time the polling tick completes. */
export const refreshSecurityHardeningResponseSchema = z.object({
  triggeredAt: z.string().datetime(),
  podsTouched: z.number().int().min(0),
});
export type RefreshSecurityHardeningResponse = z.infer<typeof refreshSecurityHardeningResponseSchema>;

// ─── NetworkPolicy templates (Phase 2.4) ───────────────────────────────

export const networkPolicyTemplateIdSchema = z.enum([
  'isolate-tenant',
  'deny-all-egress',
  'allow-dns-only',
]);
export type NetworkPolicyTemplateId = z.infer<typeof networkPolicyTemplateIdSchema>;

export const networkPolicyTemplateSchema = z.object({
  id: networkPolicyTemplateIdSchema,
  title: z.string(),
  description: z.string(),
  /** Rendered NetworkPolicy YAML for the operator to preview. */
  manifestPreview: z.string(),
});
export type NetworkPolicyTemplate = z.infer<typeof networkPolicyTemplateSchema>;

export const listNetworkPolicyTemplatesResponseSchema = z.object({
  data: z.array(networkPolicyTemplateSchema),
});
export type ListNetworkPolicyTemplatesResponse = z.infer<typeof listNetworkPolicyTemplatesResponseSchema>;

export const applyNetworkPolicyTemplateRequestSchema = z.object({
  templateId: networkPolicyTemplateIdSchema,
  /** When false, list affected namespaces but don't write anything. */
  apply: z.boolean(),
  /** Tenant namespaces to skip (already has a custom policy, opt-out, etc.). */
  excludeNamespaces: z.array(z.string()).default([]),
});
export type ApplyNetworkPolicyTemplateRequest = z.infer<typeof applyNetworkPolicyTemplateRequestSchema>;

export const applyNetworkPolicyTemplateResponseSchema = z.object({
  /** task-center id (Phase 2 destructive ops always run as long-running tasks). */
  taskId: z.string().nullable(),
  affectedNamespaces: z.array(z.string()),
  skipped: z.array(z.string()),
  /** True when the request was a dry-run (apply: false). */
  dryRun: z.boolean(),
});
export type ApplyNetworkPolicyTemplateResponse = z.infer<typeof applyNetworkPolicyTemplateResponseSchema>;
