import { z } from 'zod';

// Per-client tunnel agents that let a service running outside the cluster
// (home box, NAS, on-prem VPS) be exposed under the platform's ingress.
// See docs/04-deployment/PRIVATE_WORKER.md for the full design.

// ─── Input Schemas ──────────────────────────────────────────────────────────

const slugRegex = /^[a-z0-9][a-z0-9-]{2,58}[a-z0-9]$/;

export const createPrivateWorkerSchema = z.object({
  name: z
    .string()
    .min(1, 'Name is required')
    .max(120, 'Name too long'),
  // Optional — derived from name when omitted. The slug is the routing key in
  // the wss://tunnels.${DOMAIN}/c/{slug}/ URL, so it must be globally unique.
  slug: z
    .string()
    .regex(slugRegex, 'slug must be 4-60 chars, lowercase alphanumeric + hyphens, no leading/trailing hyphen')
    .optional(),
  exposed_port: z
    .number()
    .int()
    .min(1)
    .max(65535)
    .describe('TCP port the cluster-side Service listens on; ingress routes target this port'),
  description: z.string().max(1000).optional(),
});

export const updatePrivateWorkerSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(1000).nullable().optional(),
});

// Body for the rotate-token endpoint is empty — operator confirms by clicking.
export const rotatePrivateWorkerTokenSchema = z.object({}).strict();

// Body for revoke is empty — terminal action, no params.
export const revokePrivateWorkerSchema = z.object({}).strict();

// ─── Response Schemas ───────────────────────────────────────────────────────

export const privateWorkerStatusSchema = z.enum([
  'pending',
  'active',
  'revoked',
  'suspended',
]);

export const privateWorkerResponseSchema = z.object({
  id: z.string(),
  clientId: z.string(),
  name: z.string(),
  slug: z.string(),
  status: privateWorkerStatusSchema,
  exposedPort: z.number().int(),
  description: z.string().nullable(),
  serviceName: z
    .string()
    .describe('In-cluster Service name (e.g. pw-<workerId>) the ingress route targets'),
  tunnelUrl: z
    .string()
    .describe('Operator-facing tunnel dial-in URL — wss://tunnels.${DOMAIN}/c/{slug}/'),
  lastSeenAt: z.string().nullable(),
  lastUsedIp: z.string().nullable(),
  bytesIn: z.number().int(),
  bytesOut: z.number().int(),
  createdAt: z.string(),
  revokedAt: z.string().nullable(),
  updatedAt: z.string(),
});

// One-time response — the only place the token is ever returned in plaintext.
// Returned on create and on rotate. Never re-fetched from any other endpoint.
export const privateWorkerSecretResponseSchema = z.object({
  workerId: z.string(),
  // Base64url-encoded JSON blob the agent reads from the
  // PRIVATE_WORKER_TOKEN env var. See docs/04-deployment/PRIVATE_WORKER.md
  // for the inner format.
  token: z.string(),
  // Convenience copy-paste artefacts for the client UI.
  dockerRunCommand: z.string(),
  dockerComposeYaml: z.string(),
  // Mirror of privateWorkerResponseSchema so the UI can update its row
  // without a follow-up GET.
  worker: privateWorkerResponseSchema,
});

export const privateWorkerListResponseSchema = z.object({
  items: z.array(privateWorkerResponseSchema),
});

// Audit-log entries shown in the worker detail drawer.
export const privateWorkerAuditEntrySchema = z.object({
  id: z.number().int(),
  privateWorkerId: z.string(),
  event: z.string(),
  ip: z.string().nullable(),
  detail: z.unknown().nullable(),
  occurredAt: z.string(),
});

export const privateWorkerAuditListResponseSchema = z.object({
  items: z.array(privateWorkerAuditEntrySchema),
});

// ─── Inferred Types ─────────────────────────────────────────────────────────

export type CreatePrivateWorkerInput = z.infer<typeof createPrivateWorkerSchema>;
export type UpdatePrivateWorkerInput = z.infer<typeof updatePrivateWorkerSchema>;
export type PrivateWorkerStatus = z.infer<typeof privateWorkerStatusSchema>;
export type PrivateWorkerResponse = z.infer<typeof privateWorkerResponseSchema>;
export type PrivateWorkerSecretResponse = z.infer<typeof privateWorkerSecretResponseSchema>;
export type PrivateWorkerListResponse = z.infer<typeof privateWorkerListResponseSchema>;
export type PrivateWorkerAuditEntry = z.infer<typeof privateWorkerAuditEntrySchema>;
export type PrivateWorkerAuditListResponse = z.infer<typeof privateWorkerAuditListResponseSchema>;
