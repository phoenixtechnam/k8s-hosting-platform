import { z } from 'zod';
import { tenantStatusEnum, storageLifecycleStateEnum, uuidField, paginatedResponseSchema } from './shared.js';
import { provisioningStatusEnum } from './provisioning.js';

// ─── E.164 phone number ─────────────────────────────────────────────────────
//
// ITU-T E.164: leading +, country code starting with non-zero digit,
// total length 2–16 chars (i.e. 1–15 digits after the +). Backend
// performs stricter validation (libphonenumber) on top of this regex.
export const e164Regex = /^\+[1-9]\d{1,14}$/;
export const phoneE164Schema = z.string().regex(e164Regex, 'phone must be ITU-T E.164 format, e.g. +14155552671');

// ─── Tenant storage tier ────────────────────────────────────────────────────
export const tenantStorageTierEnum = z.enum(['local', 'ha']);
export type TenantStorageTier = z.infer<typeof tenantStorageTierEnum>;

// ─── Billing address ────────────────────────────────────────────────────────
//
// Two address fields are tracked separately:
//   streetAddress — the tenant's physical/visit address (where servers,
//                   office, or registered headquarters are located)
//   postalAddress — the tenant's mailing address (P.O. Box, billing
//                   correspondence). May equal streetAddress.
// Both are required at create time.
export const billingAddressInputSchema = z.object({
  street_address: z.string().min(1).max(500),
  postal_address: z.string().min(1).max(500),
  city: z.string().min(1).max(200),
  country: z.string().min(2).max(100),
});

export const billingAddressResponseSchema = z.object({
  streetAddress: z.string(),
  postalAddress: z.string(),
  city: z.string(),
  country: z.string(),
});
export type BillingAddress = z.infer<typeof billingAddressResponseSchema>;

// ─── Input Schemas (what the frontend sends) ────────────────────────────────

export const createTenantSchema = z.object({
  // Display name of the tenant organisation (was "company_name").
  name: z.string().min(1).max(255),
  // Person's name for billing / primary contact (separate from
  // organisation name). Optional at the API layer — admin-panel
  // CreateTenantModal enforces it client-side via HTML required;
  // service-to-service callers (integration tests, scripted creates)
  // can omit and backfill later.
  contact_name: z.string().min(1).max(255).optional(),
  primary_email: z.string().email(),
  secondary_email: z.string().email().optional(),
  // Phone + billing address: same optional-at-API treatment as
  // contact_name. DB columns are nullable; UI enforces required.
  phone_e164: phoneE164Schema.optional(),
  billing_address: billingAddressInputSchema.optional(),
  plan_id: uuidField,
  // region_id is optional on input. The backend auto-assigns the
  // platform-apex region (system_settings.platform_apex_region_id)
  // when omitted, which is the only path exposed through the UI.
  region_id: uuidField.optional(),
  subscription_expires_at: z.string().datetime().optional(),
  // Optional: admin can override the system default timezone per tenant.
  // Any IANA zone. When absent, the service falls back to the system
  // default (SystemSettings.timezone, itself defaulting to UTC).
  timezone: z.string().min(1).max(50).optional(),
  // M5: optional worker pin at provisioning time. The admin UI
  // presents free-resource-ranked options; unset = default scheduler.
  // Renamed from worker_node_name → node_name as part of the
  // tenant rename.
  node_name: z.string().min(1).max(253).optional(),
  // M7: tenant storage tier. 'local' (1 replica, cheap) is the default;
  // 'ha' requests 2 replicas via longhorn-tenant-ha. Enabling HA on an
  // existing tenant doesn't migrate the PVC — operator must run the
  // storage-migration flow (future).
  storage_tier: tenantStorageTierEnum.optional(),
});

export const updateTenantSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  contact_name: z.string().min(1).max(255).optional(),
  primary_email: z.string().email().optional(),
  secondary_email: z.string().email().nullable().optional(),
  phone_e164: phoneE164Schema.optional(),
  billing_address: billingAddressInputSchema.optional(),
  status: tenantStatusEnum.optional(),
  plan_id: uuidField.optional(),
  subscription_expires_at: z.string().datetime().nullable().optional(),
  cpu_limit_override: z.number().min(0.1).max(64).nullable().optional(),
  memory_limit_override: z.number().min(0.1).max(256).nullable().optional(),
  storage_limit_override: z.number().min(1).max(10000).nullable().optional(),
  max_sub_users_override: z.number().int().min(1).max(100).nullable().optional(),
  // Per-tenant mailbox count override. null = inherit from the plan's
  // max_mailboxes. Min 1 (blocking via 0 is handled by tenant.status).
  max_mailboxes_override: z.number().int().min(1).max(10000).nullable().optional(),
  monthly_price_override: z.number().min(0).max(99999).nullable().optional(),
  // Per-tenant email send rate limit (messages/hour).
  // null = inherit the global default. 0 = blocked.
  email_send_rate_limit: z.number().int().min(0).max(1000000).nullable().optional(),
  timezone: z.string().min(1).max(50).nullable().optional(),
  // M5: re-assign the tenant to a different worker. A subsequent
  // deployment revision (M6 migration flow) actually moves the pods.
  node_name: z.string().min(1).max(253).nullable().optional(),
  // M7: toggle tenant HA. Flipping 'local' → 'ha' on a provisioned
  // tenant marks the intent but doesn't move existing data.
  storage_tier: tenantStorageTierEnum.optional(),
  // Status-driven lifecycle (collapse phase): when status flips to
  // 'archived' we dispatch the storage-lifecycle archiveTenant
  // orchestrator (final snapshot + workload+PVC delete) and use this
  // value for the snapshot retention. Falls back to platform setting
  // `storage.retention.pre_archive_days` (default 90) when omitted.
  // Ignored on every status that isn't 'archived'.
  archive_retention_days: z.number().int().min(1).max(365).optional(),
  // Destructive shrink consent. Reducing storage_limit_override or
  // switching to a smaller-storage plan_id requires snapshot →
  // recreate-PVC → restore (filesystems can't shrink in place safely).
  // Default-false safety belt: PATCH that lowers storage without this
  // flag is rejected with STORAGE_RESIZE_REQUIRED. Setting true opts
  // into the destructive path; the orchestrator still verifies the
  // current usedBytes fits in the new size with a 10% buffer.
  confirm_destructive_shrink: z.boolean().optional(),
  // Phase A.1 of backup UI consolidation: per-tenant override of the
  // plan's include_in_scheduled_bundles. null clears the override
  // (tenant inherits the plan default); true/false explicitly opt
  // in/out regardless of plan.
  include_in_scheduled_bundles_override: z.boolean().nullable().optional(),
});

// ─── Response Schemas (what the backend returns) ─────────────────────────────

export const tenantResponseSchema = z.object({
  id: uuidField,
  name: z.string(),
  contactName: z.string(),
  primaryEmail: z.string(),
  secondaryEmail: z.string().nullable(),
  phoneE164: z.string(),
  billingAddress: billingAddressResponseSchema,
  kubernetesNamespace: z.string(),
  planId: uuidField,
  // SYSTEM tenant flag (ADR-040). True on exactly one row — the
  // platform-owned tenant that owns the apex domain and the reserved
  // mailbox space. UI uses this to render a "SYSTEM" pill, hide
  // destructive actions, and exclude the row from bulk-select.
  isSystem: z.boolean().default(false),
  // regionId is always populated on the response (server auto-fills
  // platform apex on create when the client omits it). The UI hides
  // the field; it's surfaced here for API clients that need it.
  regionId: uuidField,
  status: tenantStatusEnum,
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
  // Renamed from workerNodeName → nodeName as part of the tenant rename.
  nodeName: z.string().nullable().optional(),
  // M7: current tenant storage tier.
  storageTier: tenantStorageTierEnum.optional(),
  createdBy: z.string().nullable(),
  subscriptionExpiresAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  // Online-grow side-effect metadata: when PATCH /tenants/:id grows
  // storage_limit_override (or switches to a larger plan), the
  // updateTenant handler kicks off the storage-lifecycle online-grow
  // orchestrator and surfaces the operation id here so the UI can
  // open a progress modal. Absent on every other update.
  storageGrowOperationId: z.string().nullable().optional(),
  // Status-driven lifecycle side-effects (collapse phase). When the
  // PATCH transitions tenant.status, the storage-lifecycle orchestrator
  // attached to that transition emits an op id here so the UI can
  // poll progress. Each is mutually exclusive with the others on a
  // single PATCH:
  //   * status=archived (when not currently archived) → archiveTenant
  //     returns storageArchiveOperationId
  //   * status=active (from archived) → restoreArchivedTenant returns
  //     storageRestoreOperationId
  //   * status=suspended/active (non-archive) → operations are
  //     synchronous today (cascades, not orchestrators), so the
  //     response normally omits these fields
  storageArchiveOperationId: z.string().nullable().optional(),
  storageRestoreOperationId: z.string().nullable().optional(),
  // Destructive shrink side-effect: present when PATCH lowers storage
  // and includes confirm_destructive_shrink:true. Orchestrator runs
  // snapshot → recreate-PVC → restore; UI polls this id like the grow
  // op id and renders the same progress modal.
  storageShrinkOperationId: z.string().nullable().optional(),
});

export const tenantListResponseSchema = paginatedResponseSchema(tenantResponseSchema);

// POST /api/v1/tenants returns the created tenant enriched with the
// auto-created tenant_admin user's one-shot generated password. This
// extra `tenantUser` block is only present on the create response.
export const createTenantResponseSchema = tenantResponseSchema.extend({
  tenantUser: z.object({
    id: z.string(),
    email: z.string(),
    generatedPassword: z.string(),
  }),
});
export type CreateTenantResponse = z.infer<typeof createTenantResponseSchema>;

// ─── Types ───────────────────────────────────────────────────────────────────

export type CreateTenantInput = z.infer<typeof createTenantSchema>;
export type UpdateTenantInput = z.infer<typeof updateTenantSchema>;
export type TenantResponse = z.infer<typeof tenantResponseSchema>;
export type TenantListResponse = z.infer<typeof tenantListResponseSchema>;

// PVC node placement (GET /api/v1/tenants/:id/storage-placement).
// Read by the Storage Lifecycle card so the operator sees which
// node currently hosts the tenant's data + the volume's health.
//
// Health surface (added 2026-04-28): engineConditions surfaces the
// True-status entries from Longhorn Volume.status.conditions[]
// (filtered to abnormal ones — Restore, OfflineRebuilding, etc.;
// Scheduled==True is the healthy case and is filtered out).
// replicasHealthy/Expected expose the live vs desired replica count
// directly so a UI can flag degradation even when robustness lags.
// fsType is sourced from PV.spec.csi.volumeAttributes (the SC's
// fsType param flows through here at PV creation).
export const tenantStoragePlacementSchema = z.object({
  pvcs: z.array(z.object({
    namespace: z.string(),
    pvcName: z.string(),
    volumeName: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    usedBytes: z.number().int().nonnegative().default(0),
    allocatedBytes: z.number().int().nonnegative().default(0),
    state: z.string().nullable(),
    robustness: z.string().nullable(),
    replicaNodes: z.array(z.string()).default([]),
    engineConditions: z.array(z.object({
      type: z.string(),
      reason: z.string().nullable(),
      message: z.string().nullable(),
    })).default([]),
    replicasHealthy: z.number().int().nonnegative().default(0),
    replicasExpected: z.number().int().nonnegative().default(1),
    lastBackupAt: z.string().nullable(),
    fsType: z.string().nullable(),
    frontendState: z.string().nullable(),
  })).default([]),
});
export type TenantStoragePlacement = z.infer<typeof tenantStoragePlacementSchema>;
export type TenantStoragePlacementRow = TenantStoragePlacement['pvcs'][number];
