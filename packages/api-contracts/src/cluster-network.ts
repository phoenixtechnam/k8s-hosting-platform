/**
 * Cluster network — admin-side schemas for the always-on set-mode firewall.
 *
 * Three resource families exposed by the admin API:
 *   1. Nodes          — list, toggle exposure (public ↔ private)
 *   2. Trusted ranges — CRUD ClusterTrustedRange CRs
 *   3. Pending peers  — CRUD ClusterPendingPeer CRs + bootstrap command
 *
 * The CRDs are defined in k8s/base/cluster-network/. The peer-firewall-
 * reconciler DaemonSet converges them into nft sets on every node.
 * See docs/04-deployment/CLUSTER_NETWORK.md for the operator workflow.
 */

import { z } from 'zod';

// ─── IP / CIDR validation (mirrors reconciler's net/netip rules) ──────────
//
// CRD admission is the primary gate (regex + CEL); these schemas are the
// SECONDARY gate at the platform-api layer. Reconciler is authoritative.

/** IPv4 CIDR — accepts /1..32; rejects /0 (allow-all). */
const ipv4CidrPattern = /^([0-9]{1,3}\.){3}[0-9]{1,3}\/([1-9]|[12][0-9]|3[0-2])$/;
/** Bare IPv4 — implies /32 downstream. */
const ipv4BarePattern = /^([0-9]{1,3}\.){3}[0-9]{1,3}$/;
/** IPv6 CIDR — accepts /1..128. */
const ipv6CidrPattern = /^[0-9a-fA-F:]+\/([1-9]|[1-9][0-9]|1[01][0-9]|12[0-8])$/;
/** Bare IPv6 — implies /128 downstream. Must contain at least one `:` */
const ipv6BarePattern = /^[0-9a-fA-F:]+:[0-9a-fA-F:]*$/;

/** Accept any IPv4/v6 single address or CIDR. /0 prefixes are rejected. */
const cidrOrIpString = z
  .string()
  .min(1)
  .max(64)
  .refine(
    (s) =>
      ipv4CidrPattern.test(s) ||
      ipv4BarePattern.test(s) ||
      ipv6CidrPattern.test(s) ||
      ipv6BarePattern.test(s),
    { message: 'must be IPv4/v6 address or CIDR (e.g. 1.2.3.4, 10.0.0.0/16, 2001:db8::1, fd00::/8); /0 prefix not allowed' },
  );

/** Accept ONLY a bare IPv4/v6 (used by ClusterPendingPeer.spec.ip). */
const bareIpString = z
  .string()
  .min(1)
  .max(64)
  .refine((s) => ipv4BarePattern.test(s) || ipv6BarePattern.test(s), {
    message: 'must be a bare IPv4 or IPv6 address (no prefix)',
  });

// Note: cluster Node listing is already exposed via the existing
// `/admin/nodes` API (see packages/api-contracts/src/cluster-nodes.ts
// and backend/src/modules/nodes/). The Phase 6 PRIVATE NODE feature
// will add the exposure-toggle endpoint there alongside the scheduler
// affinity + reconciler firewall-chain changes.

// ─── Trusted ranges (ClusterTrustedRange) ─────────────────────────────────

export const trustedRangeSchema = z.object({
  /** Kubernetes resource name; URL-safe. */
  name: z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
  /** spec.cidr — see cidrOrIpString. */
  cidr: cidrOrIpString,
  /** spec.description — operator-readable purpose. */
  description: z.string().max(200).default(''),
  /** spec.addedBy — set by platform-api on POST. */
  addedBy: z.string().max(200).default(''),
  /** status.normalizedCidr — reconciler-written; null until first reconcile. */
  normalizedCidr: z.string().nullable(),
  /** status.family — null until first reconcile. */
  family: z.enum(['v4', 'v6']).nullable(),
  /** status.lastSyncedAt — null until first reconcile. */
  lastSyncedAt: z.string().datetime().nullable(),
  /** Last condition observed — surfaced in UI as "Synced" / "Failed: <reason>". */
  ready: z.enum(['True', 'False', 'Unknown']),
  readyReason: z.string().nullable(),
  readyMessage: z.string().nullable(),
  /** ISO creationTimestamp. */
  createdAt: z.string().datetime(),
});
export type TrustedRange = z.infer<typeof trustedRangeSchema>;

export const listTrustedRangesResponseSchema = z.object({
  data: z.array(trustedRangeSchema),
});
export type ListTrustedRangesResponse = z.infer<typeof listTrustedRangesResponseSchema>;

export const createTrustedRangeRequestSchema = z.object({
  name: z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
  cidr: cidrOrIpString,
  description: z.string().max(200).default(''),
});
export type CreateTrustedRangeRequest = z.infer<typeof createTrustedRangeRequestSchema>;

export const updateTrustedRangeRequestSchema = z.object({
  description: z.string().max(200),
});
export type UpdateTrustedRangeRequest = z.infer<typeof updateTrustedRangeRequestSchema>;

// ─── Pending peers (ClusterPendingPeer) ───────────────────────────────────

export const pendingPeerSchema = z.object({
  name: z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
  ip: bareIpString,
  /** spec.hostname — operator hint, not used by reconciler. */
  hostname: z.string().max(253).default(''),
  role: z.enum(['server', 'worker']),
  ttlSeconds: z.number().int().min(60).max(86400),
  addedBy: z.string().max(200).default(''),
  /** status.normalizedIp — null until first reconcile. */
  normalizedIp: z.string().nullable(),
  family: z.enum(['v4', 'v6']).nullable(),
  /** status.expiresAt — set by reconciler. */
  expiresAt: z.string().datetime().nullable(),
  /** status.claimedAt — set when matching Node InternalIP appears. */
  claimedAt: z.string().datetime().nullable(),
  ready: z.enum(['True', 'False', 'Unknown']),
  readyReason: z.string().nullable(),
  readyMessage: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type PendingPeer = z.infer<typeof pendingPeerSchema>;

export const listPendingPeersResponseSchema = z.object({
  data: z.array(pendingPeerSchema),
});
export type ListPendingPeersResponse = z.infer<typeof listPendingPeersResponseSchema>;

export const createPendingPeerRequestSchema = z.object({
  name: z.string().min(1).max(63).regex(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/),
  ip: bareIpString,
  hostname: z.string().max(253).default(''),
  role: z.enum(['server', 'worker']),
  ttlSeconds: z.number().int().min(60).max(86400).default(1800),
});
export type CreatePendingPeerRequest = z.infer<typeof createPendingPeerRequestSchema>;

// ─── Bootstrap command ────────────────────────────────────────────────────

/** Returned by GET /admin/cluster/bootstrap-command/:name. The command is
 *  the operator's paste-ready bootstrap.sh invocation for the new node.
 *  The platform-api already knows the existing cluster's join-server IP
 *  (one of the existing nodes' InternalIPs) and join-token (k3s server
 *  node-token, fetched at request time). */
export const bootstrapCommandResponseSchema = z.object({
  /** The peer-firewall-add break-glass step the operator may need to run
   *  on each existing peer if the reconciler hasn't propagated the
   *  pending_peers entry yet. Optional — most operators won't need it. */
  preAuthCommand: z.string().nullable(),
  /** The full bootstrap.sh command to run on the NEW node. Includes
   *  --join-as, --server, --token, --domain, --acme-email, and any
   *  --allow-source the operator should seed. */
  bootstrapCommand: z.string(),
  /** Echo of the inputs for the UI to display alongside the command. */
  serverIp: z.string(),
  /** Role hint from spec.role. */
  role: z.enum(['server', 'worker']),
  /** The new node's IP from spec.ip. */
  nodeIp: z.string(),
});
export type BootstrapCommandResponse = z.infer<typeof bootstrapCommandResponseSchema>;
