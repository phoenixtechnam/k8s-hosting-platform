import { z } from 'zod';
import { statusEnum, storageLifecycleStateEnum, uuidField, paginatedResponseSchema } from './shared.js';
import { provisioningStatusEnum } from './provisioning.js';

// ─── Input Schemas (what the frontend sends) ────────────────────────────────

export const createClientSchema = z.object({
  company_name: z.string().min(1).max(255),
  company_email: z.string().email(),
  contact_email: z.string().email().optional(),
  plan_id: uuidField,
  region_id: uuidField,
  subscription_expires_at: z.string().datetime().optional(),
  // Optional: admin can override the system default timezone per client.
  // Any IANA zone. When absent, the service falls back to the system
  // default (SystemSettings.timezone, itself defaulting to UTC).
  timezone: z.string().min(1).max(50).optional(),
  // M5: optional worker pin at provisioning time. The admin UI
  // presents free-resource-ranked options; unset = default scheduler.
  worker_node_name: z.string().min(1).max(253).optional(),
  // M7: tenant storage tier. 'local' (1 replica, cheap) is the default;
  // 'ha' requests 2 replicas via longhorn-tenant-ha. Enabling HA on an
  // existing client doesn't migrate the PVC — operator must run the
  // storage-migration flow (future).
  storage_tier: z.enum(['local', 'ha']).optional(),
});

export const updateClientSchema = z.object({
  company_name: z.string().min(1).max(255).optional(),
  company_email: z.string().email().optional(),
  contact_email: z.string().email().optional(),
  status: statusEnum.optional(),
  plan_id: uuidField.optional(),
  subscription_expires_at: z.string().datetime().nullable().optional(),
  cpu_limit_override: z.number().min(0.1).max(64).nullable().optional(),
  memory_limit_override: z.number().min(0.1).max(256).nullable().optional(),
  storage_limit_override: z.number().min(1).max(10000).nullable().optional(),
  max_sub_users_override: z.number().int().min(1).max(100).nullable().optional(),
  // Phase 1 (client-panel email parity round 2): per-customer
  // mailbox count override. null = inherit from the plan's
  // max_mailboxes. Min 1 (blocking via 0 is handled by client.status).
  max_mailboxes_override: z.number().int().min(1).max(10000).nullable().optional(),
  monthly_price_override: z.number().min(0).max(99999).nullable().optional(),
  // Phase 3.B.3: per-customer email send rate limit (messages/hour).
  // null = inherit the global default. 0 = blocked.
  email_send_rate_limit: z.number().int().min(0).max(1000000).nullable().optional(),
  timezone: z.string().min(1).max(50).nullable().optional(),
  // M5: re-assign the client to a different worker. A subsequent
  // deployment revision (M6 migration flow) actually moves the pods.
  worker_node_name: z.string().min(1).max(253).nullable().optional(),
  // M7: toggle tenant HA. Flipping 'local' → 'ha' on a provisioned
  // client marks the intent but doesn't move existing data.
  storage_tier: z.enum(['local', 'ha']).optional(),
});

// ─── Response Schemas (what the backend returns) ─────────────────────────────

export const clientResponseSchema = z.object({
  id: uuidField,
  companyName: z.string(),
  companyEmail: z.string(),
  contactEmail: z.string().nullable(),
  kubernetesNamespace: z.string(),
  planId: uuidField,
  regionId: uuidField,
  status: statusEnum,
  // Orthogonal storage-lifecycle state. `idle` is the common case; any
  // other value means an orchestrator is currently operating on the PVC.
  storageLifecycleState: storageLifecycleStateEnum.optional(),
  provisioningStatus: provisioningStatusEnum,
  cpuLimitOverride: z.string().nullable(),
  memoryLimitOverride: z.string().nullable(),
  storageLimitOverride: z.string().nullable(),
  maxSubUsersOverride: z.number().nullable(),
  maxMailboxesOverride: z.number().nullable().optional(),
  monthlyPriceOverride: z.string().nullable(),
  emailSendRateLimit: z.number().nullable().optional(),
  // M5: current worker pin (k8s node name) or null for default scheduler.
  workerNodeName: z.string().nullable().optional(),
  // M7: current tenant storage tier.
  storageTier: z.enum(['local', 'ha']).optional(),
  createdBy: z.string().nullable(),
  subscriptionExpiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const clientListResponseSchema = paginatedResponseSchema(clientResponseSchema);

// ─── Types ───────────────────────────────────────────────────────────────────

export type CreateClientInput = z.infer<typeof createClientSchema>;
export type UpdateClientInput = z.infer<typeof updateClientSchema>;
export type ClientResponse = z.infer<typeof clientResponseSchema>;
export type ClientListResponse = z.infer<typeof clientListResponseSchema>;
