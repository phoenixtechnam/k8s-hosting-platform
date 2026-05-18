import {
  pgTable,
  pgEnum,
  varchar,
  text,
  integer,
  numeric,
  bigint,
  bigserial,
  boolean,
  timestamp,
  jsonb,
  inet,
  customType,
  uniqueIndex,
  index,
  primaryKey,
} from 'drizzle-orm/pg-core';
import { sql, isNotNull } from 'drizzle-orm';

// PostgreSQL bytea — Drizzle has no first-class bytea helper, so we
// declare a custom type that maps Buffer ↔ bytea. Used for WebAuthn
// credential ids, public keys, challenges, and the random
// passkey_user_handle (migration 0061).
const bytea = customType<{ data: Buffer; default: false }>({
  dataType() { return 'bytea'; },
});

// ─── Enums ───

export const panelEnum = pgEnum('panel', ['admin', 'tenant']);
export const userStatusEnum = pgEnum('user_status', ['active', 'disabled', 'pending']);
export const regionStatusEnum = pgEnum('region_status', ['active', 'maintenance', 'offline']);
export const planStatusEnum = pgEnum('plan_status', ['active', 'deprecated']);
// Tenant lifecycle states:
//   active     — running normally
//   pending    — provisioned but not yet migrated / payment pending
//   suspended  — admin paused: workloads scaled to 0, quota near-zero,
//                PVC preserved, billing paused. Reversible via resume.
//   archived   — churned / paid off-boarding: PVC destroyed, snapshot
//                retained per snapshot_retention_days. Reversible via
//                restore (new PVC from snapshot).
//   cancelled  — hard terminated, snapshot also released. Not reversible.
export const tenantStatusEnum = pgEnum('tenant_status', ['active', 'suspended', 'archived', 'pending']);
export const tenantStorageTierEnum = pgEnum('tenant_storage_tier', ['local', 'ha']);
// Active storage-lifecycle operation (null when idle). Separate from
// tenants.status so the UI can show both "active & resizing" without
// losing the underlying state. Mirrors storage_operations.state for the
// operation currently owning this tenant.
export const storageLifecycleStateEnum = pgEnum('storage_lifecycle_state', [
  'idle', 'snapshotting', 'quiescing', 'resizing', 'replacing', 'restoring', 'unquiescing', 'archiving', 'failed',
]);
export const storageOperationTypeEnum = pgEnum('storage_operation_type', [
  'snapshot', 'resize', 'suspend', 'resume', 'archive', 'restore',
  // 0059_storage_op_fsck.sql: filesystem check (xfs_repair -n /
  // e2fsck -n) and repair (without -n). Both run via the
  // storage-lifecycle quiesce orchestrator.
  'fsck',
]);
export const storageSnapshotKindEnum = pgEnum('storage_snapshot_kind', [
  'manual', 'pre-resize', 'pre-suspend', 'pre-archive', 'scheduled', 'pre-restore',
]);
export const storageSnapshotStatusEnum = pgEnum('storage_snapshot_status', [
  'creating', 'ready', 'expired', 'failed',
]);
export const provisioningStatusEnum = pgEnum('provisioning_status', ['unprovisioned', 'provisioning', 'provisioned', 'failed']);
export const domainStatusEnum = pgEnum('domain_status', ['unverified', 'verified', 'active', 'pending', 'suspended', 'deleted']);
export const dnsModeEnum = pgEnum('dns_mode', ['primary', 'cname', 'secondary']);
export const dnsProviderTypeEnum = pgEnum('dns_provider_type', ['powerdns', 'rndc', 'cloudflare', 'route53', 'hetzner', 'cloudns', 'mock']);
export const zoneDefaultKindEnum = pgEnum('zone_default_kind', ['Native', 'Master']);
export const catalogRepoStatusEnum = pgEnum('catalog_repo_status', ['active', 'error', 'syncing']);
export const catalogEntryTypeEnum = pgEnum('catalog_entry_type', ['application', 'runtime', 'database', 'service', 'static']);
export const catalogEntryStatusEnum = pgEnum('catalog_entry_status', ['available', 'beta', 'deprecated']);
export const deploymentStatusEnum = pgEnum('deployment_status', ['deploying', 'running', 'stopped', 'failed', 'deleting', 'upgrading', 'pending', 'deleted']);
// ADR-036 (custom deployments). Discriminates a row's origin.
//   - 'catalog' : the row was created from a workload (ADR-025) or
//                 application (ADR-026) catalog entry; `catalog_entry_id`
//                 is NOT NULL and the components/volumes/env are
//                 resolved by joining catalog_entries.
//   - 'custom'  : tenant-supplied container or compose stack;
//                 `catalog_entry_id` is NULL and the spec lives
//                 entirely in the new `custom_spec` jsonb column.
export const deploymentSourceEnum = pgEnum('deployment_source', ['catalog', 'custom']);

// Migration 0076 — private_workers + polymorphic ingress_routes target.
export const privateWorkerStatusEnum = pgEnum('private_worker_status', [
  'pending',
  'active',
  'revoked',
  'suspended',
]);
export const ingressTargetTypeEnum = pgEnum('ingress_target_type', [
  'deployment',
  'private_worker',
]);
export const notificationTypeEnum = pgEnum('notification_type', ['info', 'warning', 'error', 'success']);
export const storageTypeEnum = pgEnum('storage_type', ['ssh', 's3', 'cifs']);
export const backupTypeEnum = pgEnum('backup_type', ['auto', 'manual', 'scheduled']);
export const backupStatusEnum = pgEnum('backup_status', ['pending', 'in_progress', 'completed', 'failed']);
export const metricTypeEnum = pgEnum('metric_type', ['cpu_cores', 'memory_gb', 'storage_gb', 'bandwidth_gb']);
export const cronJobTypeEnum = pgEnum('cron_job_type', ['webcron', 'deployment']);
export const httpMethodEnum = pgEnum('http_method', ['GET', 'POST', 'PUT']);
export const lastRunStatusEnum = pgEnum('last_run_status', ['success', 'failed', 'running']);
export const actorTypeEnum = pgEnum('actor_type', ['user', 'system', 'webhook']);
export const provTaskTypeEnum = pgEnum('prov_task_type', ['provision_namespace', 'deploy_workload', 'deprovision']);
export const provTaskStatusEnum = pgEnum('prov_task_status', ['pending', 'running', 'completed', 'failed']);
export const scopeTypeEnum = pgEnum('scope_type', ['global', 'region', 'tenant']);
export const dnsRecordTypeEnum = pgEnum('dns_record_type', ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS', 'CAA', 'PTR', 'SOA', 'ALIAS', 'DNAME']);
export const tlsModeEnum = pgEnum('tls_mode', ['auto', 'custom', 'none']);
export const ingressStatusEnum = pgEnum('ingress_status', ['active', 'pending', 'error']);
export const billingStatusEnum = pgEnum('billing_status', ['draft', 'invoiced', 'paid', 'failed']);
export const mailboxStatusEnum = pgEnum('mailbox_status', ['active', 'disabled']);
export const mailboxTypeEnum = pgEnum('mailbox_type', ['mailbox', 'forward_only']);
export const accessLevelEnum = pgEnum('access_level', ['full', 'read_only']);
export const smtpProviderTypeEnum = pgEnum('smtp_provider_type', ['direct', 'mailgun', 'postmark']);
export const upgradeStatusEnum = pgEnum('upgrade_status', [
  'pending', 'backing_up', 'pre_check', 'upgrading', 'health_check',
  'rolling_back', 'completed', 'failed', 'rolled_back',
]);
export const triggerTypeEnum = pgEnum('trigger_type', ['manual', 'batch', 'forced']);
export const catalogVersionStatusEnum = pgEnum('catalog_version_status', ['available', 'deprecated', 'eol']);
export const panelScopeEnum = pgEnum('panel_scope', ['admin', 'tenant']);
export const wwwRedirectEnum = pgEnum('www_redirect', ['none', 'add-www', 'remove-www']);

// ─── Admin & Shared Tables ───

export const users = pgTable('users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  passwordHash: varchar('password_hash', { length: 255 }),
  fullName: varchar('full_name', { length: 255 }).notNull(),
  roleName: varchar('role_name', { length: 50 }).notNull().default('read_only'),
  panel: panelEnum().notNull().default('admin'),
  tenantId: varchar('tenant_id', { length: 36 })
    .references(() => tenants.id, { onDelete: 'cascade' }),
  status: userStatusEnum().notNull().default('pending'),
  emailVerifiedAt: timestamp('email_verified_at'),
  lastLoginAt: timestamp('last_login_at'),
  // Renewable credential-check freshness — bumped by EVERY successful
  // credential challenge (password login, passkey verify, step-up). Read
  // by privileged operations (e.g. node-terminal session creation) to
  // decide whether to require a step-up re-auth. Distinct from
  // lastLoginAt (one event per session) — this is renewable inside an
  // existing session. NULL = stale.
  lastCredentialCheckAt: timestamp('last_credential_check_at'),
  // EXPLICIT step-up timestamp (ADR-041 evolved spec). Bumped ONLY by
  // /me/step-up/* endpoints — login + passkey-verify do NOT count.
  // Privileged actions (node-terminal session create) gate on THIS
  // column, not lastCredentialCheckAt, so the very first terminal
  // open after login always requires an explicit step-up prompt.
  lastStepUpAt: timestamp('last_step_up_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  oidcSubject: varchar('oidc_subject', { length: 255 }),
  oidcIssuer: varchar('oidc_issuer', { length: 500 }),
  timezone: varchar('timezone', { length: 50 }),
  // Passkey integration (migration 0061). NULL = password-only (default).
  // 'alternative' = either factor logs in. 'second_factor' = password
  // then passkey, 2-step. Setting 'second_factor' requires ≥1 verified
  // passkey (enforced in passkey-service); deleting the last passkey
  // while in second_factor mode is rejected.
  passkeyMode: varchar('passkey_mode', { length: 16 }),
  // Random per-user value embedded as WebAuthn userHandle on every
  // assertion. Keeping this distinct from users.id avoids leaking
  // internal row UUIDs to authenticators / password managers and lets
  // us rotate without invalidating credentials.
  passkeyUserHandle: bytea('passkey_user_handle'),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('users_email_unique').on(table.email),
  uniqueIndex('users_oidc_unique').on(table.oidcIssuer, table.oidcSubject),
]);

export const oidcProviders = pgTable('oidc_providers', {
  id: varchar('id', { length: 36 }).primaryKey(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  issuerUrl: varchar('issuer_url', { length: 500 }).notNull(),
  // OIDC protocol identifiers — DO NOT rename to tenant_*. These are
  // the OAuth2 client_id / client_secret of the IdP-registered relying
  // party (this platform). Bulk rename mistakenly renamed both to
  // tenant_* on first commit; reverted here. Follow-up migration
  // 0001_rename_oidc_client_id.sql renames the live column too.
  clientId: varchar('client_id', { length: 255 }).notNull(),
  clientSecretEncrypted: varchar('client_secret_encrypted', { length: 500 }).notNull(),
  panelScope: panelScopeEnum().notNull(),
  enabled: integer('enabled').notNull().default(0),
  backchannelLogoutEnabled: integer('backchannel_logout_enabled').notNull().default(0),
  discoveryMetadata: jsonb('discovery_metadata').$type<Record<string, unknown>>(),
  displayOrder: integer('display_order').notNull().default(0),
  autoProvision: integer('auto_provision').notNull().default(0),
  defaultRole: varchar('default_role', { length: 50 }).default('read_only'),
  additionalClaims: jsonb('additional_claims').$type<string[]>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

export const oidcGlobalSettings = pgTable('oidc_global_settings', {
  id: varchar('id', { length: 36 }).primaryKey(),
  disableLocalAuthAdmin: integer('disable_local_auth_admin').notNull().default(0),
  disableLocalAuthTenant: integer('disable_local_auth_tenant').notNull().default(0),
  breakGlassSecretHash: varchar('break_glass_secret_hash', { length: 255 }),
  protectAdminViaProxy: integer('protect_admin_via_proxy').notNull().default(0),
  protectTenantViaProxy: integer('protect_tenant_via_proxy').notNull().default(0),
  breakGlassPath: varchar('break_glass_path', { length: 100 }),
  oauth2ProxyCookieSecretEncrypted: text('oauth2_proxy_cookie_secret_encrypted'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

// Postgres-backed PKCE state for the OIDC authorization-code flow.
// Replaces the prior in-memory Map which lost state across the
// /authorize → /callback hop when the two requests landed on
// different platform-api replicas. See migration 0086.
export const oidcPkceState = pgTable('oidc_pkce_state', {
  state: text('state').primaryKey(),
  codeVerifier: text('code_verifier').notNull(),
  frontendRedirect: text('frontend_redirect').notNull(),
  providerId: text('provider_id').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const rbacRoles = pgTable('rbac_roles', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 50 }).notNull(),
  description: text('description'),
  isSystemRole: integer('is_system_role').notNull().default(0),
  permissions: jsonb('permissions').$type<string[]>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('rbac_roles_name_unique').on(table.name),
]);

export const regions = pgTable('regions', {
  id: varchar('id', { length: 36 }).primaryKey(),
  code: varchar('code', { length: 50 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  provider: varchar('provider', { length: 50 }).notNull(),
  kubernetesApiEndpoint: varchar('kubernetes_api_endpoint', { length: 500 }),
  status: regionStatusEnum().notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('regions_code_unique').on(table.code),
]);

export const hostingPlans = pgTable('hosting_plans', {
  id: varchar('id', { length: 36 }).primaryKey(),
  code: varchar('code', { length: 50 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  cpuLimit: numeric('cpu_limit', { precision: 5, scale: 2 }).notNull(),
  memoryLimit: numeric('memory_limit', { precision: 5, scale: 2 }).notNull(),
  storageLimit: numeric('storage_limit', { precision: 10, scale: 2 }).notNull(),
  monthlyPriceUsd: numeric('monthly_price_usd', { precision: 10, scale: 2 }).notNull(),
  maxSubUsers: integer('max_sub_users').notNull().default(3),
  // Plan-level cap on total mailboxes across all the tenant
  // email domains. Can be overridden per-tenant via
  // tenants.max_mailboxes_override.
  maxMailboxes: integer('max_mailboxes').notNull().default(50),
  weeklyAiBudgetCents: integer('weekly_ai_budget_cents').notNull().default(100),
  // Backup quota — see migration 0066 / ADR-032.
  defaultBackupRetentionDays: integer('default_backup_retention_days').notNull().default(30),
  maxBackupRetentionDays: integer('max_backup_retention_days').notNull().default(90),
  maxBackups: integer('max_backups').notNull().default(10),
  maxBackupSizeBytes: bigint('max_backup_size_bytes', { mode: 'number' }).notNull().default(53687091200),
  // Snapshot quota — Phase 6 of the snapshot-storage overhaul. Same
  // shape as the backup-bundle quotas above; enforced by the snapshot
  // orchestrator pre-flight check, NOT by k8s ResourceQuota (snapshots
  // don't live on the tenant's PVC). System snapshots have a separate
  // platform_settings-driven cap.
  maxSnapshotSizeBytes: bigint('max_snapshot_size_bytes', { mode: 'number' }).notNull().default(53687091200),
  maxSnapshotCount: integer('max_snapshot_count').notNull().default(10),
  maxSnapshotRetentionDays: integer('max_snapshot_retention_days').notNull().default(90),
  // Phase A.1 of backup UI consolidation: tenant-bundle cron iterates
  // tenants whose plan has this on (or who override it per-tenant).
  // Default TRUE so paid plans are included automatically; freemium /
  // trial plans can flip to FALSE if needed.
  includeInScheduledBundles: boolean('include_in_scheduled_bundles').notNull().default(true),
  features: jsonb('features').$type<Record<string, unknown>>(),
  status: planStatusEnum().notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('hosting_plans_code_unique').on(table.code),
]);

// ─── Tenant Tables ───

export const tenants = pgTable('tenants', {
  id: varchar('id', { length: 36 }).primaryKey(),
  regionId: varchar('region_id', { length: 36 }).notNull(),
  // Tenant organisation display name (was company_name).
  name: varchar('name', { length: 255 }).notNull(),
  // Primary billing / contact person name (separate from organisation).
  contactName: varchar('contact_name', { length: 255 }),
  primaryEmail: varchar('primary_email', { length: 255 }).notNull(),
  secondaryEmail: varchar('secondary_email', { length: 255 }),
  // ITU-T E.164 (e.g. +14155552671). Required.
  phoneE164: varchar('phone_e164', { length: 16 }),
  // Billing address. Physical (street) and postal (mailing) addresses
  // are tracked separately — many tenants have a P.O. Box for mail
  // and a physical site / registered office for visit / VAT.
  billingStreetAddress: varchar('billing_street_address', { length: 500 }),
  billingPostalAddress: varchar('billing_postal_address', { length: 500 }),
  billingCity: varchar('billing_city', { length: 200 }),
  billingCountry: varchar('billing_country', { length: 100 }),
  status: tenantStatusEnum().notNull().default('pending'),
  kubernetesNamespace: varchar('kubernetes_namespace', { length: 63 }).notNull(),
  // Migration 0077 — per-tenant shared auth secret for private-worker frps.
  // Generated on first worker mint, re-used across all workers in this
  // tenant (frps 0.62 = one auth.token per server). Per-worker revocation
  // happens via frps `allowPorts` rendered from active workers' ports.
  privateWorkerSharedSecret: varchar('private_worker_shared_secret', { length: 64 }),
  planId: varchar('plan_id', { length: 36 }).notNull(),
  cpuLimitOverride: numeric('cpu_limit_override', { precision: 5, scale: 2 }),
  memoryLimitOverride: numeric('memory_limit_override', { precision: 5, scale: 2 }),
  storageLimitOverride: numeric('storage_limit_override', { precision: 10, scale: 2 }),
  maxSubUsersOverride: integer('max_sub_users_override'),
  monthlyPriceOverride: numeric('monthly_price_override', { precision: 10, scale: 2 }),
  // Phase A.1 of backup UI consolidation: per-tenant override.
  // NULL = inherit hosting_plans.include_in_scheduled_bundles.
  // TRUE/FALSE = explicit override regardless of plan default.
  includeInScheduledBundlesOverride: boolean('include_in_scheduled_bundles'),
  // Phase 1 (tenant-panel email parity round 2): per-customer
  // mailbox count override. null = inherit from the plan's
  // max_mailboxes. Used by the limit check in mailboxes/service.ts.
  maxMailboxesOverride: integer('max_mailboxes_override'),
  // Phase 3.B.3: per-customer email send rate limit (messages/hour).
  // null = inherit the global default from platform_settings key
  // `email_send_rate_limit_default`. Suspended tenant are forced to
  // rate=0 at the Stalwart level regardless of this value.
  emailSendRateLimit: integer('email_send_rate_limit'),
  timezone: varchar('timezone', { length: 50 }),
  // M5: per-tenant worker pinning. NULL = default scheduler picks a
  // node that matches the (implicit) worker constraints (anti-affinity
  // with system pods via the server-only taint). When set, the
  // k8s-deployer passes this through to deployK8sDeployment's
  // nodeName parameter (M3), producing a
  // kubernetes.io/hostname nodeSelector.
  nodeName: varchar('node_name', { length: 253 }),
  // M7: tenant storage tier. 'local' = longhorn-tenant-local (1 replica);
  // 'ha' = longhorn-tenant-ha (2 replicas). Default 'local' matches
  // migration 0048 and preserves pre-M7 scheduling.
  storageTier: tenantStorageTierEnum('storage_tier').notNull().default('local'),
  provisioningStatus: provisioningStatusEnum().notNull().default('unprovisioned'),
  // Active storage-lifecycle op (null when the tenant isn't being
  // resized/suspended/archived/restored). The storage_operations row
  // carrying full state is referenced by activeStorageOpId.
  storageLifecycleState: storageLifecycleStateEnum('storage_lifecycle_state').notNull().default('idle'),
  activeStorageOpId: varchar('active_storage_op_id', { length: 36 }),
  createdBy: varchar('created_by', { length: 36 }),
  subscriptionExpiresAt: timestamp('subscription_expires_at'),
  // Stamped ONLY by the lifecycle cascades (applySuspended / applyArchived)
  // — used by the auto-archive / auto-delete crons so unrelated admin
  // edits to the tenant row don't reset the clock. See migration 0044.
  suspendedAt: timestamp('suspended_at'),
  archivedAt: timestamp('archived_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
  // SYSTEM tenant flag — at most one row may have is_system=TRUE
  // (enforced by partial unique index in migration 0008). The SYSTEM
  // tenant owns the platform apex domain and the platform-reserved
  // mailbox space (noreply@, postmaster@, etc.) and is protected
  // against suspend/archive/delete by service-layer guards plus the
  // system-tenant-guard lifecycle hook (ADR-040).
  isSystem: boolean('is_system').notNull().default(false),
}, (table) => [
  uniqueIndex('tenants_namespace_unique').on(table.kubernetesNamespace),
  index('tenants_region_idx').on(table.regionId),
  index('tenants_plan_idx').on(table.planId),
  index('tenants_status_idx').on(table.status),
]);

export const domains = pgTable('domains', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  domainName: varchar('domain_name', { length: 255 }).notNull(),
  deploymentId: varchar('deployment_id', { length: 36 }),
  dnsGroupId: varchar('dns_group_id', { length: 36 }),
  status: domainStatusEnum().notNull().default('pending'),
  dnsMode: dnsModeEnum().notNull().default('cname'),
  masterIp: varchar('master_ip', { length: 45 }),
  verifiedAt: timestamp('verified_at'),
  lastVerifiedAt: timestamp('last_verified_at'),
  // 0068: verification result cache — avoids hammering DNS on every page load.
  verificationCacheAt: timestamp('verification_cache_at', { withTimezone: true }),
  verificationCacheResult: jsonb('verification_cache_result').$type<{ verified: boolean; checks: Array<{ type: string; status: string; detail: string }> }>(),
  sslAutoRenew: integer('ssl_auto_renew').notNull().default(1),
  // Set by deployment-network-access reconciler when the underlying
  // deployment goes mesh-only (mode='tunneler'). annotation-sync.ts
  // checks this flag and short-circuits public Ingress creation.
  // Default false so existing domains are unaffected.
  suppressPublicIngress: boolean('suppress_public_ingress').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('domains_name_unique').on(table.domainName),
  index('domains_tenant_idx').on(table.tenantId),
  index('domains_status_idx').on(table.status),
]);

// ─── DNS Provider Groups ───

export const dnsProviderGroups = pgTable('dns_provider_groups', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  isDefault: integer('is_default').notNull().default(0),
  nsHostnames: jsonb('ns_hostnames').$type<string[]>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

// ─── DNS Servers (External Providers) ───

export const dnsServers = pgTable('dns_servers', {
  id: varchar('id', { length: 36 }).primaryKey(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  providerType: dnsProviderTypeEnum().notNull(),
  connectionConfigEncrypted: varchar('connection_config_encrypted', { length: 2000 }).notNull(),
  zoneDefaultKind: zoneDefaultKindEnum().notNull().default('Native'),
  groupId: varchar('group_id', { length: 36 }),
  role: varchar('role', { length: 20 }).notNull().default('primary'),
  isDefault: integer('is_default').notNull().default(0),
  enabled: integer('enabled').notNull().default(1),
  lastHealthCheck: timestamp('last_health_check'),
  lastHealthStatus: varchar('last_health_status', { length: 50 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

// ─── Catalog Repositories ───

export const catalogRepositories = pgTable('catalog_repositories', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  url: varchar('url', { length: 500 }).notNull(),
  branch: varchar('branch', { length: 100 }).notNull().default('main'),
  authToken: varchar('auth_token', { length: 500 }),
  syncIntervalMinutes: integer('sync_interval_minutes').notNull().default(60),
  lastSyncedAt: timestamp('last_synced_at'),
  status: catalogRepoStatusEnum().notNull().default('active'),
  lastError: text('last_error'),
  localCachePath: varchar('local_cache_path', { length: 500 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('catalog_repos_url_unique').on(table.url),
]);

// ─── Catalog Entries ───

export const catalogEntries = pgTable('catalog_entries', {
  id: varchar('id', { length: 36 }).primaryKey(),
  code: varchar('code', { length: 100 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  type: catalogEntryTypeEnum().notNull(),
  version: varchar('version', { length: 50 }),
  latestVersion: varchar('latest_version', { length: 50 }),
  defaultVersion: varchar('default_version', { length: 50 }),
  description: text('description'),
  url: varchar('url', { length: 500 }),
  documentation: varchar('documentation', { length: 500 }),
  category: varchar('category', { length: 50 }),
  minPlan: varchar('min_plan', { length: 50 }),
  tenancy: jsonb('tenancy').$type<string[] | null>(),
  components: jsonb('components').$type<Array<{ name: string; type: string; image: string; ports?: Array<{ port: number; protocol: string; ingress?: boolean }>; optional?: boolean; schedule?: string; volumes?: string[]; command?: string[]; args?: string[]; resources?: { cpu?: string; memory?: string } }> | null>(),
  networking: jsonb('networking').$type<{ ingress_ports: Array<{ port: number; protocol: string; tls: boolean; description?: string }>; host_ports?: Array<{ port: number; protocol: string; component: string; description: string }>; websocket?: boolean } | null>(),
  volumes: jsonb('volumes').$type<Array<{
    /** "." = PVC-root (no subPath), or a single lowercase segment e.g. "content" */
    local_path: string;
    container_path: string;
    description?: string;
    optional?: boolean;
  }> | null>(),
  resources: jsonb('resources').$type<{ recommended: { cpu: string; memory: string; storage?: string }; minimum: { cpu: string; memory: string; storage?: string } } | null>(),
  healthCheck: jsonb('health_check').$type<{ path?: string | null; command?: string[] | null; port?: number | null; initial_delay_seconds: number; period_seconds: number } | null>(),
  parameters: jsonb('parameters').$type<Array<{ key: string; label: string; type: string; default?: unknown; required?: boolean; description?: string; advanced?: boolean }> | null>(),
  tags: jsonb('tags').$type<string[] | null>(),
  // Runtime/database/service-specific fields
  runtime: varchar('runtime', { length: 50 }),
  webServer: varchar('web_server', { length: 50 }),
  image: varchar('image', { length: 500 }),
  hasDockerfile: integer('has_dockerfile').notNull().default(0),
  deploymentStrategy: varchar('deployment_strategy', { length: 20 }),
  services: jsonb('services').$type<Record<string, unknown> | null>(),
  provides: jsonb('provides').$type<Record<string, unknown> | null>(),
  envVars: jsonb('env_vars').$type<{ configurable?: string[]; generated?: string[]; fixed?: Record<string, string> } | null>(),
  /**
   * Per-app upgrade policy, synced from manifest's optional `versionLockMode`:
   *   - 'strict'   — block upgrades unless current version is in target's
   *                   upgradeFrom array (Nextcloud, Moodle, Wordpress majors).
   *                   Auto-upgrade cron NEVER touches strict apps.
   *   - 'advisory' — guard runs but admin can override with `force=true`.
   *                   Auto-upgrade cron enabled if deployment has autoUpgrade=true.
   *   - 'open'     — no guard (stateless services, runtimes). Default for
   *                   manifests that omit the field.
   * Default is 'advisory' — fail-safe for new manifests until catalog
   * authors classify them.
   */
  versionLockMode: varchar('version_lock_mode', { length: 20 }).notNull().default('advisory'),
  // Metadata
  status: catalogEntryStatusEnum().notNull().default('available'),
  featured: integer('featured').notNull().default(0),
  popular: integer('popular').notNull().default(0),
  sourceRepoId: varchar('source_repo_id', { length: 36 }),
  manifestUrl: varchar('manifest_url', { length: 500 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('catalog_entries_code_repo_unique').on(table.code, table.sourceRepoId),
  index('catalog_entries_type_idx').on(table.type),
  index('catalog_entries_status_idx').on(table.status),
  index('catalog_entries_category_idx').on(table.category),
  index('catalog_entries_source_repo_idx').on(table.sourceRepoId),
]);

// ─── Deployments (replaces both workloads and application_instances) ───

export const deployments = pgTable('deployments', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  // ADR-036: nullable when `source = 'custom'`. The XOR is enforced
  // by the CHECK constraint in migration 0098_custom_deployments.sql.
  catalogEntryId: varchar('catalog_entry_id', { length: 36 }),
  /**
   * ADR-036 source discriminator. Defaults to 'catalog' for backward
   * compatibility — all pre-existing rows are catalog-sourced.
   */
  source: deploymentSourceEnum().notNull().default('catalog'),
  /**
   * ADR-036 normalized custom-deployment spec. Null when source='catalog'.
   * Shape is `customDeploymentSpecSchema` from
   * @k8s-hosting/api-contracts/custom-deployments. The `specVersion`
   * field inside lets us migrate older shapes forward without a table
   * migration.
   */
  customSpec: jsonb('custom_spec').$type<Record<string, unknown> | null>(),
  name: varchar('name', { length: 63 }).notNull(),
  domainName: varchar('domain_name', { length: 255 }),
  replicaCount: integer('replica_count').notNull().default(1),
  cpuRequest: varchar('cpu_request', { length: 20 }).notNull().default('0.25'),
  memoryRequest: varchar('memory_request', { length: 20 }).notNull().default('256Mi'),
  configuration: jsonb('configuration').$type<Record<string, unknown> | null>(),
  storagePath: varchar('storage_path', { length: 500 }),
  helmReleaseName: varchar('helm_release_name', { length: 255 }),
  installedVersion: varchar('installed_version', { length: 50 }),
  targetVersion: varchar('target_version', { length: 50 }),
  /**
   * Rollback data — populated by upgradeDeploymentVersion() right before
   * the version flip. Set back to NULL when the deployment is rolled back
   * (rollback uses these to restore the image refs). Older history isn't
   * kept; only the immediately preceding version is rollback-eligible.
   */
  previousVersion: varchar('previous_version', { length: 50 }),
  /**
   * Per-deployment auto-upgrade opt-in. When true, the daily upgrade-cron
   * picks the latest catalog version that lists the current installedVersion
   * in its upgradeFrom array and runs the upgrade automatically. Apps with
   * versionLockMode='strict' (Nextcloud, Moodle, etc.) ignore this flag and
   * always require a manual click.
   */
  autoUpgrade: boolean('auto_upgrade').notNull().default(false),
  lastUpgradedAt: timestamp('last_upgraded_at'),
  lastError: text('last_error'),
  statusMessage: text('status_message'),
  /**
   * Migration 0053 — current node hosting the deployment's first
   * Running/Pending pod. Refreshed by the status-reconciler every
   * 60 s. Null when no pod exists. Multi-replica deployments report
   * the first found node only; UI labels it as "host node".
   */
  currentNodeName: varchar('current_node_name', { length: 253 }),
  deletedAt: timestamp('deleted_at'),
  status: deploymentStatusEnum().notNull().default('pending'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('deployments_tenant_name_unique').on(table.tenantId, table.name),
  index('deployments_tenant_idx').on(table.tenantId),
  index('deployments_catalog_entry_idx').on(table.catalogEntryId),
  index('deployments_status_idx').on(table.status),
  index('deployments_source_idx').on(table.source),
]);

// ─── Custom Deployments (ADR-036) ───
//
// Three sibling tables hang off a deployments row when source='custom':
//
//  custom_deployment_image_credentials — encrypted PAT per deployment.
//    Materialized as a kubernetes.io/dockerconfigjson Secret in the
//    tenant namespace named `image-pull-{deployment_id}` at deploy
//    time. Cleartext is NEVER returned by the API — only `token_last_four`.
//
//  custom_deployment_image_audit — forensic trail of every image+digest
//    a deployment has pulled. Populated by the status reconciler from
//    Pod.containerStatuses[].imageID once the kubelet has finished
//    pulling. Gated by system_settings.custom_deployments_image_pull_audit.
//
//  custom_deployment_image_check_cache — 60-minute cache of the
//    Docker Registry V2 update checker. Keyed on
//    (image_reference, registry_host, current_tag); the tenant panel's
//    lazy-load "Updates available?" pill reads this. Stale rows are
//    served immediately and a background refresh fires.

export const customDeploymentImageCredentials = pgTable('custom_deployment_image_credentials', {
  id: varchar('id', { length: 36 }).primaryKey(),
  deploymentId: varchar('deployment_id', { length: 36 })
    .notNull()
    .references(() => deployments.id, { onDelete: 'cascade' }),
  // Registry host without scheme or path. Validated by api-contracts
  // submitPullCredentialSchema. Examples: 'ghcr.io', 'docker.io',
  // 'registry.example.com:5000'.
  registryHost: varchar('registry_host', { length: 253 }).notNull(),
  username: varchar('username', { length: 255 }).notNull(),
  // Envelope-encrypted token (same PLATFORM_ENCRYPTION_KEY + 'kid:' prefix
  // shape as oidc_settings + mtls_providers). The cleartext PAT is
  // NEVER returned by the API; only the last 4 chars (token_last_four)
  // are surfaced for operator recognition.
  tokenCipher: text('token_cipher').notNull(),
  tokenLastFour: varchar('token_last_four', { length: 4 }).notNull(),
  // timestamptz — NOW() returns timezone-aware values; storing as
  // timestamp would silently truncate the offset across CNPG replicas
  // running in different zones. See migration 0098 header.
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  // Updated on token rotation (PUT /pull-credentials).
  rotatedAt: timestamp('rotated_at', { withTimezone: true }),
}, (table) => [
  // One credential per deployment in Phase 1. Phase 2 introduces a
  // tenant-scoped shared-credential table; this row is overridden by
  // a per-deployment one when present.
  uniqueIndex('custom_deployment_image_credentials_deployment_unique')
    .on(table.deploymentId),
]);

export const customDeploymentImageAudit = pgTable('custom_deployment_image_audit', {
  id: varchar('id', { length: 36 }).primaryKey(),
  deploymentId: varchar('deployment_id', { length: 36 })
    .notNull()
    .references(() => deployments.id, { onDelete: 'cascade' }),
  // Reference exactly as the tenant declared it (e.g. 'nginx:1.27',
  // 'ghcr.io/owner/app@sha256:...'). Kept verbatim for audit.
  image: varchar('image', { length: 500 }).notNull(),
  // Captured from containerStatuses[].imageID once the kubelet has
  // finished pulling. Format: <name>@sha256:<hex>. Null while still
  // pulling — the reconciler fills this on first observation.
  resolvedDigest: varchar('resolved_digest', { length: 256 }),
  // timestamptz so the forensic audit trail is unambiguous across
  // operator locales. See migration 0098 header.
  pulledAt: timestamp('pulled_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Fast lookup for the audit list view + dedupe-by-digest in the
  // image-audit module.
  index('custom_deployment_image_audit_deployment_idx').on(table.deploymentId),
  index('custom_deployment_image_audit_pulled_idx').on(table.pulledAt),
  // Unique (deployment, digest). Migration 0098 declares this index
  // with `NULLS NOT DISTINCT` (PG15+), which guarantees AT MOST ONE
  // NULL-digest sentinel row per deployment. Drizzle does not expose
  // .nullsNotDistinct() on uniqueIndex() in the version pinned here,
  // so the migration's raw SQL wins at the DB layer; this declaration
  // is for ORM column-shape awareness only.
  uniqueIndex('custom_deployment_image_audit_deployment_digest_unique')
    .on(table.deploymentId, table.resolvedDigest),
]);

export const customDeploymentImageCheckCache = pgTable('custom_deployment_image_check_cache', {
  id: varchar('id', { length: 36 }).primaryKey(),
  // Image reference without the tag — e.g. 'docker.io/library/nginx',
  // 'ghcr.io/owner/app'. Normalised by the update-checker so bare
  // 'nginx' resolves to 'docker.io/library/nginx' first.
  imageReference: varchar('image_reference', { length: 500 }).notNull(),
  registryHost: varchar('registry_host', { length: 253 }).notNull(),
  currentTag: varchar('current_tag', { length: 128 }).notNull(),
  // Latest tag found that is `>= current_tag` by semver ordering, or
  // NULL when no newer tag exists / the registry doesn't ship semver
  // tags / detection failed.
  latestTag: varchar('latest_tag', { length: 128 }),
  // 'no-update' | 'patch' | 'minor' | 'major' | 'unknown'. Stored as
  // text so future severities don't need a migration.
  severity: varchar('severity', { length: 16 }).notNull(),
  // Why 'unknown' — for the UI tooltip.
  reason: text('reason'),
  // timestamptz so the 60-min TTL comparison
  // `checked_at > now() - interval '60 minutes'` does not break under
  // a non-UTC session TimeZone GUC. See migration 0098 header.
  checkedAt: timestamp('checked_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex('custom_deployment_image_check_cache_key_unique')
    .on(table.imageReference, table.registryHost, table.currentTag),
  index('custom_deployment_image_check_cache_checked_idx').on(table.checkedAt),
]);

// ─── Notifications ───

export const notifications = pgTable('notifications', {
  id: varchar('id', { length: 36 }).primaryKey(),
  userId: varchar('user_id', { length: 36 }).notNull(),
  type: notificationTypeEnum().notNull().default('info'),
  title: varchar('title', { length: 255 }).notNull(),
  message: text('message').notNull(),
  resourceType: varchar('resource_type', { length: 50 }),
  // 64 chars so non-UUID resource ids (e.g. `bkp-<uuid>` = 40 chars,
  // future `<kind>-<uuid>` patterns up to 64) fit. The previous 36-char
  // cap silently dropped notifyUser() calls from the tenant-bundles
  // orchestrator — createNotification's fire-and-forget try/catch
  // swallowed the "value too long for type character varying(36)"
  // error. Caught 2026-05-11 against staging.
  resourceId: varchar('resource_id', { length: 64 }),
  isRead: integer('is_read').notNull().default(0),
  readAt: timestamp('read_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('notifications_user_idx').on(table.userId),
  index('notifications_read_idx').on(table.isRead),
  index('notifications_created_idx').on(table.createdAt),
]);

// ─── Backup Configurations ───

export const backupConfigurations = pgTable('backup_configurations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  storageType: storageTypeEnum().notNull(),
  sshHost: varchar('ssh_host', { length: 255 }),
  sshPort: integer('ssh_port').default(22),
  sshUser: varchar('ssh_user', { length: 100 }),
  sshKeyEncrypted: text('ssh_key_encrypted'),
  // Phase 12.5 follow-up: SSH targets can authenticate via password
  // instead of (or in addition to) a PEM key. CHECK constraint at the
  // DB layer enforces that at least one is set when storage_type='ssh'.
  sshPasswordEncrypted: text('ssh_password_encrypted'),
  sshPath: varchar('ssh_path', { length: 500 }),
  s3Endpoint: varchar('s3_endpoint', { length: 500 }),
  s3Bucket: varchar('s3_bucket', { length: 255 }),
  s3Region: varchar('s3_region', { length: 50 }),
  s3AccessKeyEncrypted: varchar('s3_access_key_encrypted', { length: 500 }),
  s3SecretKeyEncrypted: varchar('s3_secret_key_encrypted', { length: 500 }),
  s3Prefix: varchar('s3_prefix', { length: 255 }),
  // Phase 9: CIFS/SMB target fields. rclone smb backend handles
  // SMB1/2/3 — works against Hetzner Storage Box, Samba, Windows,
  // TrueNAS, NetApp. Password is stored encrypted with PLATFORM_ENCRYPTION_KEY
  // and re-obscured server-side via rcloneObscure() at Job creation time
  // (rclone's RCLONE_CONFIG_REMOTE_PASS env var requires the obscured form,
  // not plaintext).
  cifsHost: varchar('cifs_host', { length: 255 }),
  cifsPort: integer('cifs_port').default(445),
  cifsShare: varchar('cifs_share', { length: 255 }),
  cifsUser: varchar('cifs_user', { length: 255 }),
  cifsPasswordEncrypted: varchar('cifs_password_encrypted', { length: 500 }),
  cifsDomain: varchar('cifs_domain', { length: 255 }),
  cifsPath: varchar('cifs_path', { length: 500 }),
  retentionDays: integer('retention_days').notNull().default(30),
  scheduleExpression: varchar('schedule_expression', { length: 100 }).default('0 2 * * *'),
  enabled: integer('enabled').notNull().default(1),
  // Exactly one row per cluster may have active=true. A partial unique
  // index (`WHERE active=true`) in migration 0045 enforces that. The
  // Longhorn reconciler syncs the active row to BackupTarget/default.
  active: boolean('active').notNull().default(false),
  lastTestedAt: timestamp('last_tested_at'),
  lastTestStatus: varchar('last_test_status', { length: 50 }),
  // Phase 10: speedtest results. Populated by /admin/backup-configs/:id/speedtest.
  // Operator-readable comparison across all targets in BackupSettings.
  lastSpeedtestAt: timestamp('last_speedtest_at'),
  lastSpeedtestUploadMbps: numeric('last_speedtest_upload_mbps', { precision: 10, scale: 2 }),
  lastSpeedtestDownloadMbps: numeric('last_speedtest_download_mbps', { precision: 10, scale: 2 }),
  lastSpeedtestLatencyMs: integer('last_speedtest_latency_ms'),
  lastSpeedtestPayloadBytes: bigint('last_speedtest_payload_bytes', { mode: 'number' }),
  lastSpeedtestError: text('last_speedtest_error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

// ─── Backup & Metrics Tables ───

export const backups = pgTable('backups', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  backupType: backupTypeEnum().notNull().default('manual'),
  resourceType: varchar('resource_type', { length: 50 }).notNull().default('full'),
  resourceId: varchar('resource_id', { length: 36 }),
  storagePath: varchar('storage_path', { length: 500 }),
  sizeBytes: integer('size_bytes'),
  status: backupStatusEnum().notNull().default('pending'),
  completedAt: timestamp('completed_at'),
  expiresAt: timestamp('expires_at'),
  notes: text('notes'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('backups_tenant_idx').on(table.tenantId),
  index('backups_status_idx').on(table.status),
]);

export const usageMetrics = pgTable('usage_metrics', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  metricType: metricTypeEnum().notNull(),
  deploymentId: varchar('deployment_id', { length: 36 }),
  value: numeric('value', { precision: 10, scale: 4 }).notNull(),
  measurementTimestamp: timestamp('measurement_timestamp').notNull().defaultNow(),
}, (table) => [
  index('usage_metrics_tenant_idx').on(table.tenantId),
  index('usage_metrics_type_idx').on(table.metricType),
  index('usage_metrics_ts_idx').on(table.measurementTimestamp),
]);


// ─── Cron Jobs & Audit Tables ───

export const cronJobs = pgTable('cron_jobs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  type: cronJobTypeEnum().notNull().default('webcron'),
  schedule: varchar('schedule', { length: 100 }).notNull(),
  command: text('command'),
  url: varchar('url', { length: 2000 }),
  httpMethod: httpMethodEnum().default('GET'),
  deploymentId: varchar('deployment_id', { length: 36 }),
  enabled: integer('enabled').notNull().default(1),
  lastRunAt: timestamp('last_run_at'),
  lastRunStatus: lastRunStatusEnum(),
  lastRunDurationMs: integer('last_run_duration_ms'),
  lastRunResponseCode: integer('last_run_response_code'),
  lastRunOutput: text('last_run_output'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('cron_jobs_tenant_idx').on(table.tenantId),
]);

export const auditLogs = pgTable('audit_logs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 }),
  actionType: varchar('action_type', { length: 50 }).notNull(),
  resourceType: varchar('resource_type', { length: 50 }).notNull(),
  resourceId: varchar('resource_id', { length: 36 }),
  actorId: varchar('actor_id', { length: 36 }).notNull(),
  actorType: actorTypeEnum().notNull().default('user'),
  httpMethod: varchar('http_method', { length: 10 }),
  httpPath: varchar('http_path', { length: 500 }),
  httpStatus: integer('http_status'),
  changes: jsonb('changes').$type<Record<string, unknown>>(),
  ipAddress: varchar('ip_address', { length: 45 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('audit_logs_tenant_idx').on(table.tenantId),
  index('audit_logs_actor_idx').on(table.actorId),
  index('audit_logs_action_idx').on(table.actionType),
  index('audit_logs_created_idx').on(table.createdAt),
]);

// ─── Refresh Tokens (Phase 3 split-token auth) ───
//
// Replaces the in-memory tokenDenylist Map with a DB-backed table.
// The access JWT is short-lived (30 min) and verified statelessly.
// Refresh tokens are 256-bit opaque random strings, hashed (sha256)
// at rest, and validated via DB lookup on `/auth/refresh`.
//
// Rotation chain: each `family_id` groups successive refresh tokens
// for one login session. On rotation, the previous token is marked
// `revoked_at = now() / revoked_reason='rotated'` and a fresh one is
// inserted with the same family_id. If a previously-rotated token is
// re-presented, the entire family is revoked (`reuse_detected`) on
// the assumption the token leaked.

// Reason values: 'logout' | 'rotated' | 'reuse_detected' | 'password_change' | 'admin_revoke'
// Stored as varchar (not enum) so we can add new reasons without a migration.

export const refreshTokens = pgTable('refresh_tokens', {
  id: varchar('id', { length: 36 }).primaryKey(),
  userId: varchar('user_id', { length: 36 })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  familyId: varchar('family_id', { length: 36 }).notNull(),
  tokenHash: varchar('token_hash', { length: 64 }).notNull(),
  panel: panelEnum().notNull(),
  tenantId: varchar('tenant_id', { length: 36 })
    .references(() => tenants.id, { onDelete: 'cascade' }),
  userAgent: varchar('user_agent', { length: 500 }),
  ipAddress: varchar('ip_address', { length: 64 }),
  issuedAt: timestamp('issued_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  revokedReason: varchar('revoked_reason', { length: 50 }),
}, (table) => [
  uniqueIndex('refresh_tokens_hash_unique').on(table.tokenHash),
  index('refresh_tokens_user_idx').on(table.userId),
  index('refresh_tokens_family_idx').on(table.familyId),
  index('refresh_tokens_expires_idx').on(table.expiresAt),
]);

// ─── Provisioning Tasks ───

export const provisioningTasks = pgTable('provisioning_tasks', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  type: provTaskTypeEnum().notNull(),
  status: provTaskStatusEnum().notNull().default('pending'),
  currentStep: varchar('current_step', { length: 100 }),
  totalSteps: integer('total_steps').notNull().default(0),
  completedSteps: integer('completed_steps').notNull().default(0),
  stepsLog: jsonb('steps_log').$type<Array<{ name: string; status: string; startedAt: string | null; completedAt: string | null; error?: string | null }>>(),
  errorMessage: text('error_message'),
  startedBy: varchar('started_by', { length: 36 }),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('provisioning_tasks_tenant_idx').on(table.tenantId),
  index('provisioning_tasks_status_idx').on(table.status),
]);

// ─── Protected Directories ───

export const protectedDirectories = pgTable('protected_directories', {
  id: varchar('id', { length: 36 }).primaryKey(),
  domainId: varchar('domain_id', { length: 36 }).notNull(),
  path: varchar('path', { length: 500 }).notNull(),
  realm: varchar('realm', { length: 255 }).notNull().default('Restricted Area'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('protected_dirs_domain_idx').on(table.domainId),
]);

export const protectedDirectoryUsers = pgTable('protected_directory_users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  directoryId: varchar('directory_id', { length: 36 }).notNull(),
  username: varchar('username', { length: 255 }).notNull(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  enabled: integer('enabled').notNull().default(1),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('protected_dir_users_unique').on(table.directoryId, table.username),
  index('protected_dir_users_dir_idx').on(table.directoryId),
]);

// ─── Hosting Settings ───

export const hostingSettings = pgTable('hosting_settings', {
  id: varchar('id', { length: 36 }).primaryKey(),
  domainId: varchar('domain_id', { length: 36 }).notNull(),
  redirectWww: integer('redirect_www').notNull().default(0),
  redirectHttps: integer('redirect_https').notNull().default(1),
  forwardExternal: varchar('forward_external', { length: 500 }),
  webrootPath: varchar('webroot_path', { length: 500 }).notNull().default('/var/www/html'),
  hostingEnabled: integer('hosting_enabled').notNull().default(1),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('hosting_settings_domain_unique').on(table.domainId),
]);

// ─── User Roles (RBAC Association) ───

export const userRoles = pgTable('user_roles', {
  id: varchar('id', { length: 36 }).primaryKey(),
  userId: varchar('user_id', { length: 36 }).notNull(),
  roleId: varchar('role_id', { length: 36 }).notNull(),
  scopeType: scopeTypeEnum().notNull().default('global'),
  scopeId: varchar('scope_id', { length: 36 }),
  assignedBy: varchar('assigned_by', { length: 36 }),
  assignedAt: timestamp('assigned_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('uk_user_role_scope').on(table.userId, table.roleId, table.scopeType, table.scopeId),
  index('user_roles_user_idx').on(table.userId),
  index('user_roles_role_idx').on(table.roleId),
]);

// ─── DNS Records ───

export const dnsRecords = pgTable('dns_records', {
  id: varchar('id', { length: 36 }).primaryKey(),
  // Migration 0020 added the FK + ON DELETE CASCADE. Mirror it here
  // so Drizzle's type inference stays in sync and future db:generate
  // runs do not regenerate a schema without the constraint.
  domainId: varchar('domain_id', { length: 36 })
    .notNull()
    .references(() => domains.id, { onDelete: 'cascade' }),
  recordType: dnsRecordTypeEnum().notNull(),
  recordName: varchar('record_name', { length: 253 }),
  recordValue: varchar('record_value', { length: 1000 }),
  ttl: integer('ttl').notNull().default(3600),
  priority: integer('priority'),
  weight: integer('weight'),
  port: integer('port'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('dns_records_domain_idx').on(table.domainId),
  index('dns_records_type_idx').on(table.recordType),
]);

// ─── Ingress Routes ───

export const ingressRoutes = pgTable('ingress_routes', {
  id: varchar('id', { length: 36 }).primaryKey(),
  // Migration 0020 — CASCADE deletes when the domain is removed.
  domainId: varchar('domain_id', { length: 36 })
    .notNull()
    .references(() => domains.id, { onDelete: 'cascade' }),
  hostname: varchar('hostname', { length: 255 }).notNull(),
  path: varchar('path', { length: 255 }).notNull().default('/'),
  // Migration 0076 — polymorphic target. Exactly one of deploymentId or
  // privateWorkerId is set (CHECK constraint at the SQL layer).
  targetType: ingressTargetTypeEnum('target_type').notNull().default('deployment'),
  deploymentId: varchar('deployment_id', { length: 36 }),
  privateWorkerId: varchar('private_worker_id', { length: 36 }),
  ingressCname: varchar('ingress_cname', { length: 255 }).notNull(),
  nodeHostname: varchar('node_hostname', { length: 255 }),
  isApex: integer('is_apex').notNull().default(0),
  tlsMode: tlsModeEnum().notNull().default('auto'),
  status: ingressStatusEnum().notNull().default('pending'),
  // ── Redirect settings ──
  forceHttps: integer('force_https').notNull().default(1),
  wwwRedirect: wwwRedirectEnum('www_redirect').notNull().default('none'),
  redirectUrl: varchar('redirect_url', { length: 2048 }),
  // ── Security settings ──
  ipAllowlist: text('ip_allowlist'),
  rateLimitRps: integer('rate_limit_rps'),
  rateLimitConnections: integer('rate_limit_connections'),
  rateLimitBurstMultiplier: numeric('rate_limit_burst_multiplier', { precision: 4, scale: 1 }),
  // ── WAF settings ──
  wafEnabled: integer('waf_enabled').notNull().default(0),
  wafOwaspCrs: integer('waf_owasp_crs').notNull().default(0),
  wafAnomalyThreshold: integer('waf_anomaly_threshold').notNull().default(10),
  wafExcludedRules: text('waf_excluded_rules'),
  // ── Advanced settings ──
  customErrorCodes: varchar('custom_error_codes', { length: 255 }),
  customErrorPath: varchar('custom_error_path', { length: 255 }),
  additionalHeaders: jsonb('additional_headers').$type<Record<string, string>>(),
  // ── Custom-deployment routing ──
  servicePort: integer('service_port'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('ingress_routes_hostname_path_domain_unique').on(table.hostname, table.path, table.domainId),
  index('ingress_routes_domain_idx').on(table.domainId),
  index('ingress_routes_deployment_idx').on(table.deploymentId),
  index('ingress_routes_private_worker_idx').on(table.privateWorkerId),
]);

export type IngressRoute = typeof ingressRoutes.$inferSelect;

// ─── Route Protected Directories ───

export const routeProtectedDirs = pgTable('route_protected_dirs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  routeId: varchar('route_id', { length: 36 }).notNull()
    .references(() => ingressRoutes.id, { onDelete: 'cascade' }),
  path: varchar('path', { length: 255 }).notNull(),
  realm: varchar('realm', { length: 255 }).notNull().default('Restricted'),
  enabled: integer('enabled').notNull().default(1),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('route_protected_dirs_route_idx').on(table.routeId),
  uniqueIndex('route_protected_dirs_route_path').on(table.routeId, table.path),
]);

// ─── Route Auth Users ───

export const routeAuthUsers = pgTable('route_auth_users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  dirId: varchar('dir_id', { length: 36 })
    .notNull()
    .references(() => routeProtectedDirs.id, { onDelete: 'cascade' }),
  username: varchar('username', { length: 255 }).notNull(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  enabled: integer('enabled').notNull().default(1),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('route_auth_users_dir_username').on(table.dirId, table.username),
  index('route_auth_users_dir_idx').on(table.dirId),
]);

// ─── WAF Logs ───

export const wafLogs = pgTable('waf_logs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  routeId: varchar('route_id', { length: 36 })
    .notNull()
    .references(() => ingressRoutes.id, { onDelete: 'cascade' }),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  ruleId: varchar('rule_id', { length: 50 }).notNull(),
  severity: varchar('severity', { length: 20 }).notNull(),
  message: text('message').notNull(),
  requestUri: text('request_uri'),
  requestMethod: varchar('request_method', { length: 10 }),
  sourceIp: varchar('source_ip', { length: 45 }),
  matchedData: text('matched_data'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('waf_logs_route_idx').on(table.routeId),
  index('waf_logs_tenant_idx').on(table.tenantId),
  index('waf_logs_created_idx').on(table.createdAt),
]);

// ─── SSH Keys ───

export const sshKeys = pgTable('ssh_keys', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  publicKey: text('public_key').notNull(),
  keyFingerprint: varchar('key_fingerprint', { length: 255 }).notNull(),
  keyAlgorithm: varchar('key_algorithm', { length: 50 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('ssh_keys_fingerprint_unique').on(table.keyFingerprint),
  uniqueIndex('ssh_keys_tenant_name_unique').on(table.tenantId, table.name),
  index('ssh_keys_tenant_idx').on(table.tenantId),
]);

// ─── SFTP Users ───

export const sftpUsers = pgTable('sftp_users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  username: varchar('username', { length: 100 }).notNull(),
  passwordHash: varchar('password_hash', { length: 255 }),
  description: varchar('description', { length: 255 }),
  enabled: integer('enabled').notNull().default(1),
  homePath: varchar('home_path', { length: 512 }).notNull().default('/'),
  allowWrite: integer('allow_write').notNull().default(1),
  allowDelete: integer('allow_delete').notNull().default(0),
  ipWhitelist: text('ip_whitelist'),
  maxConcurrentSessions: integer('max_concurrent_sessions').notNull().default(3),
  lastLoginAt: timestamp('last_login_at'),
  lastLoginIp: varchar('last_login_ip', { length: 45 }),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('sftp_users_username_unique').on(table.username),
  index('sftp_users_tenant_idx').on(table.tenantId),
  index('sftp_users_expires_idx').on(table.expiresAt),
]);

// ─── SFTP User SSH Keys (scoped to individual SFTP users) ───

export const sftpUserSshKeys = pgTable('sftp_user_ssh_keys', {
  id: varchar('id', { length: 36 }).primaryKey(),
  sftpUserId: varchar('sftp_user_id', { length: 36 }).notNull().references(() => sftpUsers.id, { onDelete: 'cascade' }),
  sshKeyId: varchar('ssh_key_id', { length: 36 }).notNull().references(() => sshKeys.id, { onDelete: 'cascade' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('sftp_user_ssh_keys_unique').on(table.sftpUserId, table.sshKeyId),
  index('sftp_user_ssh_keys_user_idx').on(table.sftpUserId),
  index('sftp_user_ssh_keys_key_idx').on(table.sshKeyId),
]);

// ─── SFTP Audit Log ───

export const sftpAuditLog = pgTable('sftp_audit_log', {
  id: varchar('id', { length: 36 }).primaryKey(),
  sftpUserId: varchar('sftp_user_id', { length: 36 })
    .references(() => sftpUsers.id, { onDelete: 'set null' }),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  event: varchar('event', { length: 50 }).notNull(), // CONNECT, DISCONNECT, FAILED_AUTH
  sourceIp: varchar('source_ip', { length: 45 }).notNull(),
  protocol: varchar('protocol', { length: 10 }).notNull().default('sftp'), // sftp, scp, rsync, ftps
  sessionId: varchar('session_id', { length: 128 }),
  durationSeconds: integer('duration_seconds'),
  bytesTransferred: numeric('bytes_transferred', { precision: 18, scale: 0 }),
  errorMessage: varchar('error_message', { length: 512 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('sftp_audit_tenant_idx').on(table.tenantId, table.createdAt),
  index('sftp_audit_user_idx').on(table.sftpUserId, table.createdAt),
  index('sftp_audit_created_idx').on(table.createdAt),
]);

// ─── Subscription Billing Cycles ───

export const subscriptionBillingCycles = pgTable('subscription_billing_cycles', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  billingCycleStart: timestamp('billing_cycle_start').notNull(),
  billingCycleEnd: timestamp('billing_cycle_end').notNull(),
  planId: varchar('plan_id', { length: 36 }).notNull(),
  basePriceUsd: numeric('base_price_usd', { precision: 10, scale: 2 }),
  overagesPriceUsd: numeric('overages_price_usd', { precision: 10, scale: 2 }).default('0'),
  totalPriceUsd: numeric('total_price_usd', { precision: 10, scale: 2 }).notNull(),
  status: billingStatusEnum().notNull().default('draft'),
  externalBillingId: varchar('external_billing_id', { length: 255 }),
  invoiceNumber: varchar('invoice_number', { length: 50 }),
  paidAt: timestamp('paid_at'),
  invoicedAt: timestamp('invoiced_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('uk_tenant_cycle').on(table.tenantId, table.billingCycleStart),
  index('billing_cycles_tenant_idx').on(table.tenantId),
  index('billing_cycles_status_idx').on(table.status),
]);

// ─── Resource Quotas ───

export const resourceQuotas = pgTable('resource_quotas', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  cpuCoresLimit: numeric('cpu_cores_limit', { precision: 5, scale: 2 }),
  memoryGbLimit: integer('memory_gb_limit'),
  storageGbLimit: integer('storage_gb_limit'),
  bandwidthGbLimit: integer('bandwidth_gb_limit'),
  cpuCoresCurrent: numeric('cpu_cores_current', { precision: 5, scale: 2 }).default('0'),
  memoryGbCurrent: integer('memory_gb_current').default(0),
  storageGbCurrent: integer('storage_gb_current').default(0),
  cpuWarningThreshold: numeric('cpu_warning_threshold', { precision: 5, scale: 2 }).default('80'),
  memoryWarningThreshold: integer('memory_warning_threshold').default(80),
  storageWarningThreshold: integer('storage_warning_threshold').default(80),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('resource_quotas_tenant_unique').on(table.tenantId),
]);

// ─── Email System ───

export const emailDomains = pgTable('email_domains', {
  id: varchar('id', { length: 36 }).primaryKey(),
  // Migration 0020 — FK + CASCADE from domains so email config is
  // removed atomically when its parent domain is deleted.
  domainId: varchar('domain_id', { length: 36 })
    .notNull()
    .references(() => domains.id, { onDelete: 'cascade' }),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  enabled: integer('enabled').notNull().default(1),
  // Phase 2c: when true, the backend creates an Ingress for
  // webmail.<domain> in the tenant namespace pointing at the shared
  // Roundcube Service via an ExternalName service (roundcube.mail).
  // Default true — every email domain gets webmail access out of the
  // box; operators or tenant_admins can toggle it off per domain.
  webmailEnabled: integer('webmail_enabled').notNull().default(1),
  // Round-4 Phase 2 — webmail provisioning lifecycle status.
  // Values: 'pending' | 'ready' | 'ready_no_tls' | 'failed'.
  // See migration 0021 for the rationale.
  webmailStatus: varchar('webmail_status', { length: 16 }).notNull().default('pending'),
  webmailStatusMessage: text('webmail_status_message'),
  webmailStatusUpdatedAt: timestamp('webmail_status_updated_at'),
  // M13: dkimSelector, dkimPrivateKeyEncrypted, dkimPublicKey removed.
  // Platform-side DKIM is retired (M12). Stalwart 0.16 manages DKIM natively.
  // Columns dropped by migration 0075.
  // NOTE: max_mailboxes + max_quota_mb were removed in migration
  // 0019. Mailbox count is now capped at the plan level via
  // hosting_plans.max_mailboxes + tenants.max_mailboxes_override.
  catchAllAddress: varchar('catch_all_address', { length: 255 }),
  mxProvisioned: integer('mx_provisioned').notNull().default(0),
  spfProvisioned: integer('spf_provisioned').notNull().default(0),
  dkimProvisioned: integer('dkim_provisioned').notNull().default(0),
  dmarcProvisioned: integer('dmarc_provisioned').notNull().default(0),
  spamThresholdJunk: numeric('spam_threshold_junk', { precision: 4, scale: 1 }).notNull().default('5.0'),
  spamThresholdReject: numeric('spam_threshold_reject', { precision: 4, scale: 1 }).notNull().default('10.0'),
  // Stalwart 0.16: domain principal ID from Stalwart's JMAP store.
  // Null until provisioned via JMAP or backfilled by principals-sync.
  stalwartDomainId: text('stalwart_domain_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('email_domains_domain_unique').on(table.domainId),
  index('email_domains_tenant_idx').on(table.tenantId),
  index('email_domains_stalwart_domain_idx').on(table.stalwartDomainId).where(isNotNull(table.stalwartDomainId)),
]);

export const mailboxes = pgTable('mailboxes', {
  id: varchar('id', { length: 36 }).primaryKey(),
  // Migration 0020 — CASCADE from email_domains and tenant so
  // mailboxes disappear atomically with their parent.
  emailDomainId: varchar('email_domain_id', { length: 36 })
    .notNull()
    .references(() => emailDomains.id, { onDelete: 'cascade' }),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  localPart: varchar('local_part', { length: 64 }).notNull(),
  fullAddress: varchar('full_address', { length: 255 }).notNull(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  displayName: varchar('display_name', { length: 255 }),
  quotaMb: integer('quota_mb').notNull().default(1024),
  usedMb: integer('used_mb').notNull().default(0),
  status: mailboxStatusEnum().notNull().default('active'),
  mailboxType: mailboxTypeEnum().notNull().default('mailbox'),
  autoReply: integer('auto_reply').notNull().default(0),
  autoReplySubject: varchar('auto_reply_subject', { length: 255 }),
  autoReplyBody: text('auto_reply_body'),
  // Stalwart 0.16: principal ID from Stalwart's JMAP store.
  // Null until the principals-sync reconciler backfills it (or until the
  // mailbox is first provisioned via JMAP). Used for in-place password
  // changes and deletes without a full principal list scan.
  stalwartPrincipalId: text('stalwart_principal_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('mailboxes_address_unique').on(table.fullAddress),
  index('mailboxes_tenant_idx').on(table.tenantId),
  index('mailboxes_domain_idx').on(table.emailDomainId),
  index('mailboxes_stalwart_principal_idx').on(table.stalwartPrincipalId).where(isNotNull(table.stalwartPrincipalId)),
]);

export const mailboxAccess = pgTable('mailbox_access', {
  id: varchar('id', { length: 36 }).primaryKey(),
  userId: varchar('user_id', { length: 36 }).notNull(),
  // Migration 0020 review round-3: cascade from mailboxes so access
  // rows disappear when a mailbox is removed via the domain delete
  // cascade chain.
  mailboxId: varchar('mailbox_id', { length: 36 })
    .notNull()
    .references(() => mailboxes.id, { onDelete: 'cascade' }),
  accessLevel: accessLevelEnum().notNull().default('full'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('mailbox_access_unique').on(table.userId, table.mailboxId),
  index('mailbox_access_user_idx').on(table.userId),
  index('mailbox_access_mailbox_idx').on(table.mailboxId),
]);

export const emailAliases = pgTable('email_aliases', {
  id: varchar('id', { length: 36 }).primaryKey(),
  // Migration 0020 — CASCADE from email_domains and tenants.
  emailDomainId: varchar('email_domain_id', { length: 36 })
    .notNull()
    .references(() => emailDomains.id, { onDelete: 'cascade' }),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  sourceAddress: varchar('source_address', { length: 255 }).notNull(),
  destinationAddresses: jsonb('destination_addresses').$type<string[]>().notNull(),
  enabled: integer('enabled').notNull().default(1),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('email_aliases_source_unique').on(table.sourceAddress),
  index('email_aliases_tenant_idx').on(table.tenantId),
  index('email_aliases_domain_idx').on(table.emailDomainId),
]);

// Phase 2b shipped a per-tenant custom webmail_domains table + CRUD. Phase
// 2c reverted it in favour of a derived convention: every enabled email
// domain gets webmail.<domain> automatically. See migration 0006 and
// docs/06-features/MAIL_SERVER_IMPLEMENTATION_STATUS.md (Phase 2c section).

// Phase 3 T1.1 (B.2): DKIM key rotation with grace period.
// Status lifecycle: pending → active → retired → (deleted)
// Phase 3 T5.3 — per-mailbox quota threshold tracking. One row
// per (mailbox, threshold) so notifications fire exactly once per
// crossing rather than every reconciler cycle.
export const mailboxQuotaEvents = pgTable('mailbox_quota_events', {
  mailboxId: varchar('mailbox_id', { length: 36 })
    .notNull()
    .references(() => mailboxes.id, { onDelete: 'cascade' }),
  threshold: integer('threshold').notNull(),
  firstSeenAt: timestamp('first_seen_at').notNull().defaultNow(),
  clearedAt: timestamp('cleared_at'),
  notificationId: varchar('notification_id', { length: 36 }),
}, (table) => [
  uniqueIndex('mailbox_quota_events_unique').on(table.mailboxId, table.threshold),
  index('mailbox_quota_events_open_idx').on(table.mailboxId),
]);

// Phase 3 T2.1 — IMAPSync job runner. Tracks one-shot Kubernetes
// Jobs that migrate mail from an external IMAP server into a
// platform mailbox. Source password encrypted at rest with the
// OIDC encryption key; destination uses Stalwart `master` SSO so
// no mailbox cleartext password is required.
export const imapSyncJobs = pgTable('imap_sync_jobs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  mailboxId: varchar('mailbox_id', { length: 36 })
    .notNull()
    .references(() => mailboxes.id, { onDelete: 'cascade' }),
  sourceHost: varchar('source_host', { length: 255 }).notNull(),
  sourcePort: integer('source_port').notNull().default(993),
  sourceUsername: varchar('source_username', { length: 255 }).notNull(),
  sourcePasswordEncrypted: text('source_password_encrypted').notNull(),
  sourceSsl: integer('source_ssl').notNull().default(1),
  options: jsonb('options').notNull().default({}),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  k8sJobName: varchar('k8s_job_name', { length: 253 }),
  k8sNamespace: varchar('k8s_namespace', { length: 63 }).notNull().default('mail'),
  logTail: text('log_tail'),
  errorMessage: text('error_message'),
  // Round-4 Phase 3: progress tracking columns. Updated by the
  // reconciler on every tick while the job is running. See
  // migration 0022 + parseImapsyncProgress.
  messagesTotal: integer('messages_total'),
  messagesTransferred: integer('messages_transferred'),
  currentFolder: varchar('current_folder', { length: 255 }),
  lastProgressAt: timestamp('last_progress_at'),
  // IMAP Phase 3: pod-level observability. The reconciler polls
  // the pod (not just the Job) and writes its phase + a short
  // human-readable reason so the UI can distinguish a truly
  // running sync from one whose pod is stuck Pending (e.g.
  // FailedScheduling, ImagePullBackOff). These are NULL until
  // the reconciler has seen the pod at least once.
  podPhase: varchar('pod_phase', { length: 32 }),
  podMessage: text('pod_message'),
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('imap_sync_jobs_tenant_idx').on(table.tenantId),
  index('imap_sync_jobs_mailbox_idx').on(table.mailboxId),
]);

// Phase 3 T5.1 — per-tenant SMTP submission credentials used by
// sendmail-compatible wrappers in workload pods. Stored twice:
// encrypted (for writing to the customer PVC) + bcrypt hash (for
// Stalwart to verify via the directory view).
export const mailSubmitCredentials = pgTable('mail_submit_credentials', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  username: varchar('username', { length: 128 }).notNull(),
  passwordEncrypted: text('password_encrypted').notNull(),
  passwordHash: text('password_hash').notNull(),
  note: varchar('note', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  revokedAt: timestamp('revoked_at'),
  lastUsedAt: timestamp('last_used_at'),
}, (table) => [
  index('mail_submit_credentials_tenant_idx').on(table.tenantId),
]);

// emailDkimKeys table removed in M13 (migration 0075).
// Platform-side DKIM was retired in M12; Stalwart 0.16 manages DKIM natively.
// The physical table was renamed to email_dkim_keys_legacy (migration 0074)
// and dropped (migration 0075).

export const smtpRelayConfigs = pgTable('smtp_relay_configs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 255 }).notNull(),
  providerType: smtpProviderTypeEnum().notNull(),
  isDefault: integer('is_default').notNull().default(0),
  enabled: integer('enabled').notNull().default(1),
  smtpHost: varchar('smtp_host', { length: 255 }),
  smtpPort: integer('smtp_port').default(587),
  authUsername: varchar('auth_username', { length: 255 }),
  authPasswordEncrypted: varchar('auth_password_encrypted', { length: 500 }),
  apiKeyEncrypted: varchar('api_key_encrypted', { length: 500 }),
  region: varchar('region', { length: 50 }),
  lastTestedAt: timestamp('last_tested_at'),
  lastTestStatus: varchar('last_test_status', { length: 50 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

// ─── Deployment Upgrades ───

export const deploymentUpgrades = pgTable('deployment_upgrades', {
  id: varchar('id', { length: 36 }).primaryKey(),
  deploymentId: varchar('deployment_id', { length: 36 }).notNull(),
  fromVersion: varchar('from_version', { length: 50 }).notNull(),
  toVersion: varchar('to_version', { length: 50 }).notNull(),
  status: upgradeStatusEnum().notNull().default('pending'),
  triggeredBy: varchar('triggered_by', { length: 36 }).notNull(),
  triggerType: triggerTypeEnum().notNull().default('manual'),
  backupId: varchar('backup_id', { length: 36 }),
  progressPct: integer('progress_pct').notNull().default(0),
  statusMessage: text('status_message'),
  errorMessage: text('error_message'),
  helmValues: jsonb('helm_values').$type<Record<string, unknown> | null>(),
  rollbackHelmValues: jsonb('rollback_helm_values').$type<Record<string, unknown> | null>(),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('idx_deploy_upgrades_deployment').on(table.deploymentId, table.status),
  index('idx_deploy_upgrades_status').on(table.status, table.createdAt),
]);

// ─── Catalog Entry Versions ───

export const catalogEntryVersions = pgTable('catalog_entry_versions', {
  id: varchar('id', { length: 36 }).primaryKey(),
  catalogEntryId: varchar('catalog_entry_id', { length: 36 }).notNull(),
  version: varchar('version', { length: 50 }).notNull(),
  isDefault: integer('is_default').notNull().default(0),
  eolDate: varchar('eol_date', { length: 10 }),
  components: jsonb('components').$type<readonly { name: string; image: string }[] | null>(),
  upgradeFrom: jsonb('upgrade_from').$type<string[] | null>(),
  breakingChanges: text('breaking_changes'),
  envChanges: jsonb('env_changes').$type<readonly { key: string; action: string; oldKey?: string; default?: unknown }[] | null>(),
  migrationNotes: text('migration_notes'),
  minResources: jsonb('min_resources').$type<{ cpu?: string; memory?: string; storage?: string } | null>(),
  // Version-specific volume overrides (replaces entry-level volumes when present)
  volumes: jsonb('volumes').$type<readonly { local_path: string; container_path: string; description?: string }[] | null>(),
  // Version-specific env var overrides (merged on top of entry-level env_vars, version-level wins on fixed conflicts)
  envVars: jsonb('env_vars').$type<{ fixed?: Record<string, string>; configurable?: string[] } | null>(),
  status: catalogVersionStatusEnum().notNull().default('available'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('uk_catalog_entry_version').on(table.catalogEntryId, table.version),
  index('idx_catalog_versions_entry').on(table.catalogEntryId),
  index('idx_catalog_versions_status').on(table.catalogEntryId, table.status),
]);

// ─── SSL Certificates ───

export const sslCertificates = pgTable('ssl_certificates', {
  id: varchar('id', { length: 36 }).primaryKey(),
  domainId: varchar('domain_id', { length: 36 }).notNull(),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  certificate: text('certificate').notNull(),
  privateKeyEncrypted: text('private_key_encrypted').notNull(),
  caBundle: text('ca_bundle'),
  issuer: varchar('issuer', { length: 500 }),
  subject: varchar('subject', { length: 500 }),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('ssl_certs_domain_unique').on(table.domainId),
  index('ssl_certs_tenant_idx').on(table.tenantId),
]);

// ─── Platform Settings ───

export const platformSettings = pgTable('platform_settings', {
  key: varchar('setting_key', { length: 100 }).primaryKey(),
  value: text('setting_value').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

// M13: platform-level storage replication policy. Controls the Longhorn
// replica count for the platform's own StatefulSets (postgres,
// stalwart-mail) — distinct from tenant_storage_tier (M7) which only
// touches tenant PVCs. Single-row table (id='singleton'). Reconciler
// patches longhorn.io Volume CRs' .spec.numberOfReplicas to match.
export const platformStorageTierEnum = pgEnum('platform_storage_tier', ['local', 'ha']);
export const platformStoragePolicy = pgTable('platform_storage_policy', {
  id: varchar('id', { length: 16 }).primaryKey().default('singleton'),
  systemTier: platformStorageTierEnum('system_tier').notNull().default('local'),
  pinnedByAdmin: boolean('pinned_by_admin').notNull().default(false),
  lastAppliedAt: timestamp('last_applied_at', { withTimezone: true }),
  lastAppliedBy: varchar('last_applied_by', { length: 36 }),
  haRecommendationNotifiedAt: timestamp('ha_recommendation_notified_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});

// Persistent run tracking for Apply HA / Apply Local. Each row tracks
// one PATCH /admin/platform-storage-policy invocation. See migration
// 0078 + ApplyHaProgressModal in the admin panel for the full design.
export const platformStorageApplyRuns = pgTable('platform_storage_apply_runs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  tier: varchar('tier', { length: 8 }).notNull(),
  actorUserId: varchar('actor_user_id', { length: 36 }),
  status: varchar('status', { length: 32 }).notNull().default('running'),
  patchOutcomeJson: jsonb('patch_outcome_json'),
  convergenceJson: jsonb('convergence_json'),
});
export type PlatformStorageApplyRun = typeof platformStorageApplyRuns.$inferSelect;

// ─── System Backup runs (Phase 1: secrets bundle export) ────────────────────
//
// One row per "Export bundle" click. The age-encrypted payload is
// stored inline (small — typically <100 KiB) and scrubbed after a
// successful download or once the signed-URL TTL elapses. Audit
// metadata (operator id, ip, ua, sha256, manifest) survives.
//
// See migration 0081_system_backup_runs.sql + modules/system-backup/.
export const systemBackupRuns = pgTable('system_backup_runs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  kind: varchar('kind', { length: 32 }).notNull(),
  status: varchar('status', { length: 32 }).notNull().default('pending'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  sha256: varchar('sha256', { length: 64 }),
  errorEnvelope: jsonb('error_envelope'),
  operatorUserId: varchar('operator_user_id', { length: 36 }),
  operatorIp: varchar('operator_ip', { length: 45 }),
  operatorUserAgent: varchar('operator_user_agent', { length: 500 }),
  manifest: jsonb('manifest'),
  payload: bytea('payload'),
  // Phase 2 — pg_dump support (migration 0083). NULL for kind='secrets'.
  sourceNamespace: varchar('source_namespace', { length: 63 }),
  sourceCluster: varchar('source_cluster', { length: 63 }),
  sourceDatabase: varchar('source_database', { length: 63 }),
  targetConfigId: varchar('target_config_id', { length: 36 }),
  bundleId: varchar('bundle_id', { length: 64 }),
  artifactName: varchar('artifact_name', { length: 255 }),
  jobName: varchar('job_name', { length: 63 }),
  downloadTokenHash: varchar('download_token_hash', { length: 64 }),
  // The unhashed token is persisted alongside the payload (and wiped
  // in the same atomic UPDATE on first download) so any of the 3
  // platform-api replicas can hand it to the UI on GET /runs/:id. An
  // in-process Map would route 2 of 3 polls to the wrong replica and
  // surface downloadUrl=null. See migration 0082.
  downloadTokenRaw: varchar('download_token_raw', { length: 256 }),
  downloadUrlExpiresAt: timestamp('download_url_expires_at', { withTimezone: true }),
  downloadedAt: timestamp('downloaded_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
});
export type SystemBackupRun = typeof systemBackupRuns.$inferSelect;

// ─── System Backup Phase 4 — WAL archive runtime state ──────────────────────
// One row per (cluster_namespace, cluster_name) when WAL streaming is ON.
// Removed by the disable route. See migration 0085.
export const systemWalArchiveState = pgTable('system_wal_archive_state', {
  clusterNamespace: varchar('cluster_namespace', { length: 63 }).notNull(),
  clusterName:      varchar('cluster_name',      { length: 63 }).notNull(),
  targetConfigId:   varchar('target_config_id',  { length: 36 }).notNull(),
  retentionDays:    integer('retention_days').notNull().default(30),
  destinationPath:  varchar('destination_path',  { length: 1024 }).notNull(),
  enabledAt:        timestamp('enabled_at', { withTimezone: true }).notNull().defaultNow(),
  operatorUserId:   varchar('operator_user_id', { length: 36 }),
  // Phase 4b: operator-chosen overrides. Null = use defaults.
  archiveTimeout:   varchar('archive_timeout', { length: 16 }),
  baseBackupSchedule:       varchar('base_backup_schedule', { length: 64 }),
  baseBackupRetentionDays:  integer('base_backup_retention_days'),
}, (table) => [
  primaryKey({ columns: [table.clusterNamespace, table.clusterName] }),
  index('system_wal_archive_state_target_idx').on(table.targetConfigId),
]);
export type SystemWalArchiveState = typeof systemWalArchiveState.$inferSelect;

// ─── System Backup Phase 4b — scheduled pg_dump exports ────────────────────
export const systemPgDumpSchedules = pgTable('system_pg_dump_schedules', {
  id:                varchar('id', { length: 36 }).primaryKey(),
  sourceNamespace:   varchar('source_namespace', { length: 63 }).notNull(),
  sourceCluster:     varchar('source_cluster',   { length: 63 }).notNull(),
  sourceDatabase:    varchar('source_database',  { length: 63 }).notNull(),
  targetConfigId:    varchar('target_config_id', { length: 36 }).notNull(),
  cronSchedule:      varchar('cron_schedule',    { length: 64 }).notNull(),
  retentionDays:     integer('retention_days').notNull().default(30),
  enabled:           boolean('enabled').notNull().default(true),
  lastRunAt:         timestamp('last_run_at',  { withTimezone: true }),
  lastRunId:         varchar('last_run_id',    { length: 36 }),
  nextRunAt:         timestamp('next_run_at',  { withTimezone: true }),
  operatorUserId:    varchar('operator_user_id', { length: 36 }),
  createdAt:         timestamp('created_at',  { withTimezone: true }).notNull().defaultNow(),
  updatedAt:         timestamp('updated_at',  { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('system_pg_dump_schedules_unique_target').on(
    table.sourceNamespace, table.sourceCluster, table.sourceDatabase,
  ),
]);
export type SystemPgDumpSchedule = typeof systemPgDumpSchedules.$inferSelect;

// ─── DR-bundle Phase 1 — drill execution history (migration 0012) ───────────
// One row per DR drill execution. CI posts via the webhook route in
// system-backup/dr-drill-runs.ts; the admin UI reads the most recent 12.
export const drDrillRuns = pgTable('dr_drill_runs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  status: varchar('status', { length: 16 }).notNull(),
  trigger: varchar('trigger', { length: 32 }).notNull(),
  sourceBundleSha256: varchar('source_bundle_sha256', { length: 64 }),
  secretsRestoredCount: integer('secrets_restored_count'),
  bundleSizeBytes: bigint('bundle_size_bytes', { mode: 'number' }),
  durationSeconds: integer('duration_seconds'),
  failureReason: varchar('failure_reason', { length: 500 }),
  report: jsonb('report'),
  runner: varchar('runner', { length: 200 }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('dr_drill_runs_started_at_idx').on(table.startedAt),
  index('dr_drill_runs_status_idx').on(table.status),
]);
export type DrDrillRunRow = typeof drDrillRuns.$inferSelect;

// ─── Ingress access control (OIDC + claim rules) ────────────────────────────

export interface IngressClaimRule {
  readonly claim: string;
  readonly operator:
    | 'equals'
    | 'not_equals'
    | 'contains'
    | 'not_contains'
    | 'in'
    | 'not_in'
    | 'exists'
    | 'regex';
  readonly value?: string | string[];
}

/**
 * Per-tenant reusable OIDC provider configuration. One row per
 * (tenantId, IdP-OAuth-app); referenced by zero or more
 * ingress_auth_configs via provider_id. ON DELETE RESTRICT ensures
 * a provider in active use cannot be removed silently — the routes
 * layer translates the FK violation into a 409 with the consumer
 * count so the operator can decide.
 */
export const tenantOidcProviders = pgTable('tenant_oidc_providers', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 120 }).notNull(),
  issuerUrl: varchar('issuer_url', { length: 500 }).notNull(),
  oauthClientId: varchar('oauth_client_id', { length: 255 }).notNull(),
  oauthClientSecretEncrypted: text('oauth_client_secret_encrypted').notNull(),
  authMethod: varchar('auth_method', { length: 32 }).notNull().default('client_secret_basic'),
  responseType: varchar('response_type', { length: 32 }).notNull().default('code'),
  usePkce: boolean('use_pkce').notNull().default(true),
  defaultScopes: varchar('default_scopes', { length: 500 }).notNull().default('openid profile email'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

export type TenantOidcProvider = typeof tenantOidcProviders.$inferSelect;
export type NewTenantOidcProvider = typeof tenantOidcProviders.$inferInsert;

export const ingressAuthConfigs = pgTable('ingress_auth_configs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  ingressRouteId: varchar('ingress_route_id', { length: 36 })
    .notNull()
    .unique()
    .references(() => ingressRoutes.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  // FK to the reusable provider config. NOT NULL — every config must
  // resolve to a provider before it can be enabled. Set to NOT NULL
  // by migration 0057 after backfill.
  providerId: varchar('provider_id', { length: 36 })
    .notNull()
    .references(() => tenantOidcProviders.id, { onDelete: 'restrict' }),
  // Optional override of the provider's default_scopes. NULL = use
  // provider's value. Allows one provider to serve ingresses with
  // different scope requirements (e.g. one ingress also wants
  // 'groups' for claim-rule matching).
  scopesOverride: varchar('scopes_override', { length: 500 }),
  // Optional fixed redirect destination after a successful login.
  // When NULL the user lands back at the URL they originally
  // requested (oauth2-proxy default behaviour). When set, every
  // login lands here — used for forwarding into an app's own
  // OIDC callback or a static post-login landing page.
  postLoginRedirectUrl: varchar('post_login_redirect_url', { length: 2048 }),
  allowedEmails: text('allowed_emails'),
  allowedEmailDomains: text('allowed_email_domains'),
  allowedGroups: text('allowed_groups'),
  claimRules: jsonb('claim_rules').$type<ReadonlyArray<IngressClaimRule>>(),
  passAuthorizationHeader: boolean('pass_authorization_header').notNull().default(true),
  passAccessToken: boolean('pass_access_token').notNull().default(true),
  passIdToken: boolean('pass_id_token').notNull().default(true),
  passUserHeaders: boolean('pass_user_headers').notNull().default(true),
  setXauthrequest: boolean('set_xauthrequest').notNull().default(true),
  cookieDomain: varchar('cookie_domain', { length: 255 }),
  cookieRefreshSeconds: integer('cookie_refresh_seconds').notNull().default(3600),
  cookieExpireSeconds: integer('cookie_expire_seconds').notNull().default(86400),
  lastError: text('last_error'),
  lastReconciledAt: timestamp('last_reconciled_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

export type IngressAuthConfig = typeof ingressAuthConfigs.$inferSelect;
export type NewIngressAuthConfig = typeof ingressAuthConfigs.$inferInsert;

export const tenantOauth2ProxyState = pgTable('tenant_oauth2_proxy_state', {
  tenantId: varchar('tenant_id', { length: 36 })
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  cookieSecretEncrypted: text('cookie_secret_encrypted').notNull(),
  provisioned: boolean('provisioned').notNull().default(false),
  lastProvisionedAt: timestamp('last_provisioned_at'),
  lastError: text('last_error'),
});

export type TenantOauth2ProxyState = typeof tenantOauth2ProxyState.$inferSelect;
export type NewTenantOauth2ProxyState = typeof tenantOauth2ProxyState.$inferInsert;

// ─── Multi-mode network access foundation (Phase 1 of OpenZiti integration) ───
// See packages/api-contracts/src/{ingress-mtls,ziti-providers,zrok-providers,
// deployment-network-access}.ts for the contract docs. Migration 0058.

export const tenantZitiProviders = pgTable('tenant_ziti_providers', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 120 }).notNull(),
  controllerUrl: varchar('controller_url', { length: 500 }).notNull(),
  enrollmentJwtEncrypted: text('enrollment_jwt_encrypted'),
  certExpiresAt: timestamp('cert_expires_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  tenantIdx: index('tenant_ziti_providers_tenant_idx').on(table.tenantId),
}));

export type TenantZitiProvider = typeof tenantZitiProviders.$inferSelect;
export type NewTenantZitiProvider = typeof tenantZitiProviders.$inferInsert;

export const tenantZrokAccounts = pgTable('tenant_zrok_accounts', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 120 }).notNull(),
  controllerUrl: varchar('controller_url', { length: 500 }).notNull(),
  accountEmail: varchar('account_email', { length: 255 }).notNull(),
  accountTokenEncrypted: text('account_token_encrypted').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  tenantIdx: index('tenant_zrok_accounts_tenant_idx').on(table.tenantId),
}));

export type TenantZrokAccount = typeof tenantZrokAccounts.$inferSelect;
export type NewTenantZrokAccount = typeof tenantZrokAccounts.$inferInsert;

export const tenantMtlsProviders = pgTable('tenant_mtls_providers', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 120 }).notNull(),
  caCertPemEncrypted: text('ca_cert_pem_encrypted').notNull(),
  caKeyPemEncrypted: text('ca_key_pem_encrypted'),
  caCertFingerprint: varchar('ca_cert_fingerprint', { length: 64 }).notNull(),
  caCertSubject: varchar('ca_cert_subject', { length: 500 }).notNull(),
  caCertExpiresAt: timestamp('ca_cert_expires_at').notNull(),
  canIssue: boolean('can_issue').notNull().default(false),
  // CRL state (added in 0097). crlNumber is the X.509 CRL Number
  // extension — monotonically increasing per CRL generation. crlPem
  // is the cached CRL body, regenerated lazily on first read after a
  // revocation. crlLastGeneratedAt is the wall-clock for the cache.
  crlNumber: bigint('crl_number', { mode: 'number' }).notNull().default(0),
  crlPem: text('crl_pem'),
  crlLastGeneratedAt: timestamp('crl_last_generated_at'),
  nextSerialSeq: bigint('next_serial_seq', { mode: 'number' }).notNull().default(1),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  tenantIdx: index('tenant_mtls_providers_tenant_idx').on(table.tenantId),
}));

export type TenantMtlsProvider = typeof tenantMtlsProviders.$inferSelect;
export type NewTenantMtlsProvider = typeof tenantMtlsProviders.$inferInsert;

export const tenantCertificates = pgTable('tenant_certificates', {
  id: varchar('id', { length: 36 }).primaryKey(),
  providerId: varchar('provider_id', { length: 36 })
    .notNull()
    .references(() => tenantMtlsProviders.id, { onDelete: 'cascade' }),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  serialHex: varchar('serial_hex', { length: 64 }).notNull(),
  certPemEncrypted: text('cert_pem_encrypted').notNull(),
  certFingerprintSha256: varchar('cert_fingerprint_sha256', { length: 64 }).notNull(),
  subjectCn: varchar('subject_cn', { length: 255 }).notNull(),
  subjectFull: varchar('subject_full', { length: 500 }).notNull(),
  issuedAt: timestamp('issued_at').notNull().defaultNow(),
  expiresAt: timestamp('expires_at').notNull(),
  revokedAt: timestamp('revoked_at'),
  revocationReason: varchar('revocation_reason', { length: 64 }),
  revokedByUserId: varchar('revoked_by_user_id', { length: 36 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => ({
  providerSerialUnique: uniqueIndex('tenant_certificates_provider_serial_unique')
    .on(table.providerId, table.serialHex),
  providerIdx: index('tenant_certificates_provider_idx').on(table.providerId),
  tenantIdx: index('tenant_certificates_tenant_idx').on(table.tenantId),
  expiresIdx: index('tenant_certificates_expires_idx').on(table.expiresAt),
}));

export type TenantCertificate = typeof tenantCertificates.$inferSelect;
export type NewTenantCertificate = typeof tenantCertificates.$inferInsert;

export const ingressMtlsConfigs = pgTable('ingress_mtls_configs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  ingressRouteId: varchar('ingress_route_id', { length: 36 })
    .notNull()
    .unique()
    .references(() => ingressRoutes.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  providerId: varchar('provider_id', { length: 36 })
    .references(() => tenantMtlsProviders.id, { onDelete: 'restrict' }),
  caCertPemEncrypted: text('ca_cert_pem_encrypted'),
  caCertFingerprint: varchar('ca_cert_fingerprint', { length: 64 }),
  caCertSubject: varchar('ca_cert_subject', { length: 500 }),
  caCertExpiresAt: timestamp('ca_cert_expires_at'),
  verifyMode: varchar('verify_mode', { length: 32 }).notNull().default('on'),
  subjectRegex: varchar('subject_regex', { length: 500 }),
  passCertToUpstream: boolean('pass_cert_to_upstream').notNull().default(false),
  passDnToUpstream: boolean('pass_dn_to_upstream').notNull().default(true),
  lastError: text('last_error'),
  lastReconciledAt: timestamp('last_reconciled_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

export type IngressMtlsConfig = typeof ingressMtlsConfigs.$inferSelect;
export type NewIngressMtlsConfig = typeof ingressMtlsConfigs.$inferInsert;

export const deploymentNetworkAccessConfigs = pgTable('deployment_network_access_configs', {
  deploymentId: varchar('deployment_id', { length: 36 })
    .primaryKey()
    .references(() => deployments.id, { onDelete: 'cascade' }),
  mode: varchar('mode', { length: 32 }).notNull().default('public'),
  zitiProviderId: varchar('ziti_provider_id', { length: 36 })
    .references(() => tenantZitiProviders.id, { onDelete: 'restrict' }),
  zitiServiceName: varchar('ziti_service_name', { length: 255 }),
  zrokProviderId: varchar('zrok_provider_id', { length: 36 })
    .references(() => tenantZrokAccounts.id, { onDelete: 'restrict' }),
  zrokShareToken: varchar('zrok_share_token', { length: 255 }),
  passIdentityHeaders: boolean('pass_identity_headers').notNull().default(true),
  provisioned: boolean('provisioned').notNull().default(false),
  publicIngressSuppressed: boolean('public_ingress_suppressed').notNull().default(false),
  lastError: text('last_error'),
  lastReconciledAt: timestamp('last_reconciled_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => ({
  zitiIdx: index('deployment_network_access_ziti_idx').on(table.zitiProviderId),
  zrokIdx: index('deployment_network_access_zrok_idx').on(table.zrokProviderId),
}));

export type DeploymentNetworkAccessConfig = typeof deploymentNetworkAccessConfigs.$inferSelect;
export type NewDeploymentNetworkAccessConfig = typeof deploymentNetworkAccessConfigs.$inferInsert;

export const tenantMeshProxyState = pgTable('tenant_mesh_proxy_state', {
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  kind: varchar('kind', { length: 32 }).notNull(),
  provisioned: boolean('provisioned').notNull().default(false),
  lastProvisionedAt: timestamp('last_provisioned_at'),
  lastError: text('last_error'),
}, (table) => ({
  pk: uniqueIndex('tenant_mesh_proxy_state_pk').on(table.tenantId, table.kind),
}));

export type TenantMeshProxyState = typeof tenantMeshProxyState.$inferSelect;
export type NewTenantMeshProxyState = typeof tenantMeshProxyState.$inferInsert;

// Type exports
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Tenant = typeof tenants.$inferSelect;
export type NewTenant = typeof tenants.$inferInsert;
export type Domain = typeof domains.$inferSelect;
export type NewDomain = typeof domains.$inferInsert;
export type HostingPlan = typeof hostingPlans.$inferSelect;
export type Region = typeof regions.$inferSelect;
export type Backup = typeof backups.$inferSelect;
export type NewBackup = typeof backups.$inferInsert;
export type UsageMetric = typeof usageMetrics.$inferSelect;
export type CronJob = typeof cronJobs.$inferSelect;
export type NewCronJob = typeof cronJobs.$inferInsert;
export type AuditLog = typeof auditLogs.$inferSelect;
export type CatalogRepository = typeof catalogRepositories.$inferSelect;
export type NewCatalogRepository = typeof catalogRepositories.$inferInsert;
export type CatalogEntry = typeof catalogEntries.$inferSelect;
export type NewCatalogEntry = typeof catalogEntries.$inferInsert;
export type Deployment = typeof deployments.$inferSelect;
export type NewDeployment = typeof deployments.$inferInsert;
export type UserRole = typeof userRoles.$inferSelect;
export type DnsRecord = typeof dnsRecords.$inferSelect;
export type NewDnsRecord = typeof dnsRecords.$inferInsert;
export type SshKey = typeof sshKeys.$inferSelect;
export type NewSshKey = typeof sshKeys.$inferInsert;
export type BillingCycle = typeof subscriptionBillingCycles.$inferSelect;
export type ResourceQuota = typeof resourceQuotas.$inferSelect;
export type Notification = typeof notifications.$inferSelect;
export type NewNotification = typeof notifications.$inferInsert;
export type BackupConfiguration = typeof backupConfigurations.$inferSelect;
export type NewBackupConfiguration = typeof backupConfigurations.$inferInsert;
export type EmailDomain = typeof emailDomains.$inferSelect;
export type NewEmailDomain = typeof emailDomains.$inferInsert;
export type Mailbox = typeof mailboxes.$inferSelect;
export type NewMailbox = typeof mailboxes.$inferInsert;
export type MailboxAccessRow = typeof mailboxAccess.$inferSelect;
export type EmailAlias = typeof emailAliases.$inferSelect;
export type NewEmailAlias = typeof emailAliases.$inferInsert;
export type SmtpRelayConfig = typeof smtpRelayConfigs.$inferSelect;
// EmailDkimKey types removed in M13 — emailDkimKeys table dropped.
export type MailSubmitCredential = typeof mailSubmitCredentials.$inferSelect;
export type NewMailSubmitCredential = typeof mailSubmitCredentials.$inferInsert;
export type ImapSyncJob = typeof imapSyncJobs.$inferSelect;
export type NewImapSyncJob = typeof imapSyncJobs.$inferInsert;
export type MailboxQuotaEvent = typeof mailboxQuotaEvents.$inferSelect;
export type NewMailboxQuotaEvent = typeof mailboxQuotaEvents.$inferInsert;
export type CatalogEntryVersion = typeof catalogEntryVersions.$inferSelect;
export type NewCatalogEntryVersion = typeof catalogEntryVersions.$inferInsert;
export type DeploymentUpgrade = typeof deploymentUpgrades.$inferSelect;
export type NewDeploymentUpgrade = typeof deploymentUpgrades.$inferInsert;
export type PlatformSetting = typeof platformSettings.$inferSelect;
export type NewPlatformSetting = typeof platformSettings.$inferInsert;
export type SslCertificate = typeof sslCertificates.$inferSelect;
export type NewSslCertificate = typeof sslCertificates.$inferInsert;
export type ProvisioningTask = typeof provisioningTasks.$inferSelect;
export type NewProvisioningTask = typeof provisioningTasks.$inferInsert;
export type DnsProviderGroup = typeof dnsProviderGroups.$inferSelect;
export type NewDnsProviderGroup = typeof dnsProviderGroups.$inferInsert;

// ─── System Settings (single-row structured config) ───

export const systemSettings = pgTable('system_settings', {
  id: varchar('id', { length: 36 }).primaryKey(),
  platformName: varchar('platform_name', { length: 255 }).notNull().default('Hosting Platform'),
  adminPanelUrl: varchar('admin_panel_url', { length: 500 }),
  tenantPanelUrl: varchar('tenant_panel_url', { length: 500 }),
  supportEmail: varchar('support_email', { length: 255 }),
  supportUrl: varchar('support_url', { length: 500 }),
  ingressBaseDomain: varchar('ingress_base_domain', { length: 255 }),
  mailHostname: varchar('mail_hostname', { length: 255 }),
  webmailUrl: varchar('webmail_url', { length: 500 }),
  apiRateLimit: integer('api_rate_limit').notNull().default(100),
  currencySymbol: varchar('currency_symbol', { length: 5 }).notNull().default('$'),
  // ISO 4217 currency code (USD, EUR, GBP, …). Drives Intl.NumberFormat
  // across both panels for any monetary amount display. The older
  // currency_symbol column above is unused at the API/UI layer; new
  // code should only read/write `currency`. Default 'USD'.
  currency: varchar('currency', { length: 3 }).notNull().default('USD'),
  timezone: varchar('timezone', { length: 50 }).notNull().default('UTC'),
  // Host-port gating (migration 0062). When OFF, the catalog deploy
  // path rejects workloads that request hostPort or carry the
  // platform.io/firewall-{tcp,udp}-ports annotations on the
  // corresponding node role. Server is OFF by default — most
  // operators won't ever want host ports on the control plane.
  // Worker is OFF by default too — opt-in keeps the attack surface
  // explicit. Toggling either flips a flag read by the catalog
  // deploy gate; existing pods are not retroactively closed.
  allowHostPortsServer: boolean('allow_host_ports_server').notNull().default(false),
  allowHostPortsWorker: boolean('allow_host_ports_worker').notNull().default(false),
  // Node-defaults (migration 0063). Applied by the cluster-side node
  // reconciler (nodes/k8s-sync.ts) when a fresh SERVER node joins
  // without an explicit `platform.phoenix-host.net/host-tenant-workloads`
  // label. Default TRUE preserves the historical behaviour where every
  // server hosts tenant workloads. Operator-set bootstrap labels always
  // win — this only fills in the gap when bootstrap.sh ran with the
  // default flag and no explicit operator decision.
  newServerHostsTenantWorkloads: boolean('new_server_hosts_tenant_workloads').notNull().default(true),
  // ADR-036 custom-deployments toggles (migration 0099). All default
  // to permissive (enabled / on) so the feature ships usable out of
  // the box; operators tighten by flipping.
  //
  //   customDeploymentsEnabled — master kill switch. When false, the
  //     API rejects new custom deployments with 403 (existing ones
  //     keep running). Tenant UI hides the Custom Containers tab.
  //
  //   customDeploymentsAllowCompose — disable the compose editor
  //     specifically (simple-form still works). Use during a
  //     compose-parser incident.
  //
  //   customDeploymentsAllowPrivateRegistries — disable PAT submission
  //     (existing PATs keep working). Use when private-registry pulls
  //     are causing trouble.
  //
  //   customDeploymentsImagePullAudit — populate the
  //     custom_deployment_image_audit table. Default ON for forensic
  //     value; cheap to keep.
  //
  //   customDeploymentsScanOnPull — reserved for Phase 2 Trivy.
  //     Column exists in Phase 1 as a no-op so flipping it on later
  //     is a code-only change.
  //
  //   customDeploymentsWarnUnpinnedTags — UI advisory badge on
  //     `:latest` / missing tag. Default ON; operator can suppress
  //     the noise.
  customDeploymentsEnabled: boolean('custom_deployments_enabled').notNull().default(true),
  customDeploymentsAllowCompose: boolean('custom_deployments_allow_compose').notNull().default(true),
  customDeploymentsAllowPrivateRegistries: boolean('custom_deployments_allow_private_registries').notNull().default(true),
  customDeploymentsImagePullAudit: boolean('custom_deployments_image_pull_audit').notNull().default(true),
  customDeploymentsScanOnPull: boolean('custom_deployments_scan_on_pull').notNull().default(false),
  customDeploymentsWarnUnpinnedTags: boolean('custom_deployments_warn_unpinned_tags').notNull().default(true),
  // Kubelet image-GC thresholds (migration 0065). Shipped as k3s
  // --kubelet-arg flags by bootstrap.sh; surfaced in the admin panel.
  // Reconciliation to running kubelets is handled by the kubelet-gc
  // reconciler (deferred — see cluster-settings/kubelet-gc-reconciler.ts).
  imageGcHighThreshold: integer('image_gc_high_threshold').notNull().default(70),
  imageGcLowThreshold: integer('image_gc_low_threshold').notNull().default(60),
  imageGcMinTtlMinutes: integer('image_gc_min_ttl_minutes').notNull().default(60),
  // 0069: last-known cluster IP set for domain-verification cron. Stored as
  // { v4: string[], v6: string[] }. Used to suppress false regression
  // notifications when the platform's own IPs change.
  lastKnownPlatformIps: jsonb('last_known_platform_ips').$type<{ v4: string[]; v6: string[] } | null>(),
  // 0069: when true, domain verification failure notifications are also
  // dispatched via email (in addition to in-app). Default false.
  notifyDnsFailuresViaEmail: boolean('notify_dns_failures_via_email').notNull().default(false),
  // 0100: mail snapshot settings.
  // mailSnapshotSchedule: cron override for the stalwart-snapshot CronJob
  //   (null = use CronJob's own spec.schedule).
  // mailSnapshotBackupStoreId: FK to backup_configurations.id (no CASCADE).
  // mailSnapshotLastRunStats: JSON written by the upload sidecar after each
  //   successful restic run: { totalSnapshotSizeBytes, snapshotCount, runAt }.
  mailSnapshotSchedule: varchar('mail_snapshot_schedule', { length: 100 }),
  mailSnapshotBackupStoreId: varchar('mail_snapshot_backup_store_id', { length: 36 }),
  mailSnapshotLastRunStats: jsonb('mail_snapshot_last_run_stats').$type<{
    totalSnapshotSizeBytes: number;
    snapshotCount: number;
    runAt: string;
  } | null>(),
  // 0101: RocksDB DataStore tracking (Phase 1 migration).
  // mailDatastoreType: which DataStore engine is live on this cluster.
  //   'postgres' = CNPG-backed (legacy default until manually migrated).
  //   'rocksdb'  = embedded RocksDB on local-path PVC (Phase 1+).
  //   Once Phase 1 is applied on a cluster, update this to 'rocksdb'
  //   so the admin panel can reflect the correct storage type.
  // mailRocksdbNodeName: the Kubernetes node name where the
  //   stalwart-rocksdb-data PVC is bound. Set by the placement
  //   reconciler (Phase 2) when it pins the Stalwart pod to a node.
  //   Nullable — unset until placement reconciler runs.
  mailDatastoreType: varchar('mail_datastore_type', { length: 20 }).notNull().default('postgres'),
  mailRocksdbNodeName: varchar('mail_rocksdb_node_name', { length: 253 }),
  // 0103: mail placement policy (Phase 2 — primary/secondary/tertiary + DR state).
  // mailPrimaryNode/mailSecondaryNode/mailTertiaryNode: operator-configured preferred
  //   node hostnames for placement policy (Phase 2 failover scheduler uses them).
  // mailActiveNode: the node currently serving mail (may differ from primary during DR).
  // mailDrState: current DR state machine state ('healthy' | 'degraded' |
  //   'failing-over' | 'failed-over' | 'failing-back').
  // mailAutoFailoverEnabled: when true the Phase 5 scheduler can trigger failover
  //   automatically once mailFailoverThresholdSeconds have elapsed without a healthy pod.
  // mailFailoverThresholdSeconds: seconds of pod unavailability before auto-failover.
  // mailLastFailoverAt: timestamp of last failover action (manual or automatic).
  // mailPortExposureMode: default 'allServerNodes' since the Phase 2 streamline
  //   (2026-05-15). The haproxy DaemonSet (PROXY-v2) is the production-ready
  //   path. 'thisNodeOnly' (Stalwart hostPort on the active node only) remains
  //   supported via the admin API for debugging single-node installs but is no
  //   longer surfaced in the operator UI by default.
  // mailDatastorePvcSizeGi: requested size (Gi) for the stalwart-rocksdb-data PVC.
  mailPrimaryNode: varchar('mail_primary_node', { length: 253 }),
  mailSecondaryNode: varchar('mail_secondary_node', { length: 253 }),
  mailTertiaryNode: varchar('mail_tertiary_node', { length: 253 }),
  mailActiveNode: varchar('mail_active_node', { length: 253 }),
  mailDrState: varchar('mail_dr_state', { length: 32 }).notNull().default('healthy'),
  mailAutoFailoverEnabled: boolean('mail_auto_failover_enabled').notNull().default(false),
  mailFailoverThresholdSeconds: integer('mail_failover_threshold_seconds').notNull().default(300),
  mailLastFailoverAt: timestamp('mail_last_failover_at', { withTimezone: true }),
  mailPortExposureMode: varchar('mail_port_exposure_mode', { length: 32 }).notNull().default('allServerNodes'),
  mailDatastorePvcSizeGi: integer('mail_datastore_pvc_size_gi').notNull().default(20),
  // 0107: mail archive scheduler (minimum-viable fixed-interval cron).
  // mailArchiveScheduleInterval: 'off' | 'hourly' | 'daily' | 'weekly' — fires
  //   startMailArchive({ mode: 'no_downtime' }) on the in-process timer.
  // mailArchiveScheduleHourUtc: 0..23, used for daily + weekly.
  // mailArchiveScheduleWeekdayUtc: 0..6 (Sun..Sat), weekly only.
  // mailArchiveLastScheduledRunAt: when the scheduler last fired. Manual
  //   triggers do NOT update this (keeps cadence honest).
  mailArchiveScheduleInterval: varchar('mail_archive_schedule_interval', { length: 16 })
    .notNull().default('off'),
  mailArchiveScheduleHourUtc: integer('mail_archive_schedule_hour_utc').notNull().default(2),
  mailArchiveScheduleWeekdayUtc: integer('mail_archive_schedule_weekday_utc').notNull().default(0),
  mailArchiveLastScheduledRunAt: timestamp('mail_archive_last_scheduled_run_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

export type SystemSettings = typeof systemSettings.$inferSelect;

// ─── Image Reap Log (migration 0064) ────────────────────────────────────────

export const imageReapLog = pgTable('image_reap_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  imageName: text('image_name').notNull(),
  imageId: text('image_id'),
  nodesReclaimed: text('nodes_reclaimed').array().notNull().default([]),
  bytesReclaimed: bigint('bytes_reclaimed', { mode: 'number' }).notNull().default(0),
  triggeredBy: text('triggered_by').notNull(), // 'deployment_delete' | 'manual_purge' | 'pressure_watcher'
  triggerRef: text('trigger_ref'),
  succeeded: boolean('succeeded').notNull().default(false),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export type ImageReapLog = typeof imageReapLog.$inferSelect;

// ─── AI Editor ─────────────────────────────────────────────────────────────

export const aiProviders = pgTable('ai_providers', {
  id: varchar('id', { length: 100 }).primaryKey(),
  type: varchar('type', { length: 30 }).notNull(),
  displayName: varchar('display_name', { length: 200 }).notNull(),
  baseUrl: varchar('base_url', { length: 500 }),
  apiKeyEnc: text('api_key_enc'),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

export type AiProvider = typeof aiProviders.$inferSelect;

export const aiModels = pgTable('ai_models', {
  id: varchar('id', { length: 100 }).primaryKey(),
  providerId: varchar('provider_id', { length: 100 }).notNull().references(() => aiProviders.id, { onDelete: 'cascade' }),
  modelName: varchar('model_name', { length: 200 }).notNull(),
  displayName: varchar('display_name', { length: 200 }).notNull(),
  costPer1mInputTokens: numeric('cost_per_1m_input_tokens', { precision: 10, scale: 4 }).default('0'),
  costPer1mOutputTokens: numeric('cost_per_1m_output_tokens', { precision: 10, scale: 4 }).default('0'),
  maxOutputTokens: integer('max_output_tokens').notNull().default(4096),
  enabled: boolean('enabled').notNull().default(true),
  adminOnly: boolean('admin_only').notNull().default(false),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

export type AiModel = typeof aiModels.$inferSelect;

export const aiTokenUsage = pgTable('ai_token_usage', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  deploymentId: varchar('deployment_id', { length: 36 }).references(() => deployments.id, { onDelete: 'set null' }),
  modelId: varchar('model_id', { length: 100 }).notNull().references(() => aiModels.id),
  mode: varchar('mode', { length: 20 }).notNull(),
  tokensInput: integer('tokens_input').notNull(),
  tokensOutput: integer('tokens_output').notNull(),
  instruction: text('instruction'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
});

// ─── Storage Lifecycle ──────────────────────────────────────────────────────

/**
 * A snapshot is a point-in-time compressed tarball of a tenant's PVC,
 * stored by the configured SnapshotStore (hostPath in dev, S3 in prod).
 *
 * Kinds:
 *   - manual:      admin-triggered ad-hoc snapshot (kept until admin deletes)
 *   - pre-resize:  taken automatically before a resize; 7-day retention so
 *                  operators can roll back if something bad emerges post-fact
 *   - pre-suspend: defensive snapshot before a suspend (short retention)
 *   - pre-archive: the snapshot created when a tenant is archived — retained
 *                  for the plan's archive_retention_days so restore is possible
 *   - scheduled:   periodic full backups (future work)
 */
export const storageSnapshots = pgTable('storage_snapshots', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  kind: storageSnapshotKindEnum('kind').notNull(),
  status: storageSnapshotStatusEnum('status').notNull().default('creating'),
  // Opaque identifier in the SnapshotStore (dev: hostPath, prod: s3 key)
  archivePath: varchar('archive_path', { length: 500 }).notNull(),
  // Size of the archive on disk (compressed). 0 while status='creating'.
  sizeBytes: numeric('size_bytes', { precision: 20, scale: 0 }).notNull().default('0'),
  // sha256 of the tarball contents. Filled in once the snapshot completes.
  sha256: varchar('sha256', { length: 64 }),
  // When the snapshot is eligible for cleanup. null = retain forever
  // (admin-level decision; scheduled housekeeping won't touch).
  expiresAt: timestamp('expires_at'),
  // Free-form label the admin can set (e.g. "pre-stripe-migration 2026-Q2")
  label: text('label'),
  // Last error — null on success, populated if status='failed'.
  lastError: text('last_error'),
  // Migration 0003 (snapshot-storage overhaul Phase 1):
  //  - subsystem  : which producer wrote this row. 'tenant-pvc' today;
  //                 'mail-rocksdb', 'longhorn-volume', 'system-etcd'
  //                 etc. will land as the other subsystems get unified.
  //  - snapshotClass : logical class for target routing. CHECK
  //                 constraint added in migration 0004 locks the value
  //                 set; kept varchar to avoid coupling to a Postgres
  //                 enum that's harder to extend.
  subsystem: varchar('subsystem', { length: 64 }).notNull().default('tenant-pvc'),
  snapshotClass: varchar('snapshot_class', { length: 32 }).notNull().default('tenant_snapshot'),
  // Migration 0004: which backup target this snapshot lives on. NULL
  // for hostpath snapshots predating the migration; gets filled in by
  // the snapshot orchestrator (Phase 3 onwards) at row-create time
  // from the per-class resolver. ON DELETE SET NULL preserves
  // forensic visibility when an operator retires a target.
  targetId: varchar('target_id', { length: 36 }).references(() => backupConfigurations.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('storage_snapshots_tenant_idx').on(table.tenantId),
  index('storage_snapshots_status_idx').on(table.status),
  index('storage_snapshots_expires_idx').on(table.expiresAt),
  index('storage_snapshots_class_idx').on(table.snapshotClass),
  index('storage_snapshots_subsystem_idx').on(table.subsystem),
  index('storage_snapshots_target_idx').on(table.targetId),
]);

/**
 * An in-flight or completed lifecycle operation. The state machine is:
 *   pending → (op-specific states) → done | failed
 * All concurrent callers must check `tenants.activeStorageOpId IS NULL`
 * before starting a new op (enforced by the orchestrator, not the DB).
 */
export const storageOperations = pgTable('storage_operations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 }).notNull().references(() => tenants.id, { onDelete: 'cascade' }),
  opType: storageOperationTypeEnum('op_type').notNull(),
  state: storageLifecycleStateEnum('state').notNull().default('idle'),
  // Progress percentage (0-100) for long-running ops — UI shows in a progress bar.
  progressPct: integer('progress_pct').notNull().default(0),
  // Current human-readable status line ("Compressing 1.2 GiB…", etc.)
  progressMessage: text('progress_message'),
  // Op-specific parameters (new_gi for resize, retention_days for archive, etc.)
  params: jsonb('params').$type<Record<string, unknown> | null>(),
  // Snapshot created as part of this op (pre-resize/pre-archive). null if none.
  snapshotId: varchar('snapshot_id', { length: 36 }).references(() => storageSnapshots.id, { onDelete: 'set null' }),
  // Rollback state: when true, a failure in the "replacing" step triggered
  // auto-restore. Distinguishes "we cleaned up" from "we left tenant broken".
  rolledBack: integer('rolled_back').notNull().default(0),
  lastError: text('last_error'),
  // Who triggered this. null for scheduler-driven ops.
  triggeredByUserId: varchar('triggered_by_user_id', { length: 36 }),
  // Migration 0003 (snapshot-storage overhaul Phase 1):
  // Live byte counter for streaming snapshot/restore Jobs. Populated by
  // job-log-tail.ts parsing rclone --use-json-log emissions in Phase 4
  // (stays 0 in this phase — UI tolerates zero gracefully).
  bytesTransferred: numeric('bytes_transferred', { precision: 20, scale: 0 }).notNull().default('0'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
}, (table) => [
  index('storage_operations_tenant_idx').on(table.tenantId),
  index('storage_operations_state_idx').on(table.state),
  index('storage_operations_created_idx').on(table.createdAt),
]);

// ─── Snapshot per-class target routing (migration 0004) ────────────────
//
// Replaces the single-active-backup-target model. One row per
// (snapshot_class, target_id) lets the operator route each class to a
// different target. Strict-primary resolver picks
// ORDER BY priority ASC LIMIT 1.
//
// ON DELETE RESTRICT on target_id: deleting a target that is still
// routed-to is refused. Operator must reassign first. This protects
// against accidentally orphaning a class.

export const backupTargetAssignments = pgTable('backup_target_assignments', {
  snapshotClass: varchar('snapshot_class', { length: 32 }).notNull(),
  targetId: varchar('target_id', { length: 36 }).notNull().references(() => backupConfigurations.id, { onDelete: 'restrict' }),
  priority: integer('priority').notNull().default(100),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.snapshotClass, table.targetId] }),
  index('backup_target_assignments_class_priority_idx').on(table.snapshotClass, table.priority),
  index('backup_target_assignments_target_idx').on(table.targetId),
]);

export type BackupTargetAssignment = typeof backupTargetAssignments.$inferSelect;
export type NewBackupTargetAssignment = typeof backupTargetAssignments.$inferInsert;

// ─── backup_schedules (Phase A.1 of UI consolidation, migration 0011) ──
//
// One row per subsystem. Tracks {enabled, cron, retention} so every
// backup schedule has the same shape. The /admin/backups/schedules
// CRUD enforces strict-gate: `enabled=true` is refused until the
// relevant snapshot_class has at least one target assignment.
//
// Subsystems seeded by 0011: mail, tenant_bundle, system_pitr,
// longhorn_recurring. New subsystems can be added without schema
// migration since `subsystem` is free-form varchar.

export const backupSchedules = pgTable('backup_schedules', {
  subsystem: varchar('subsystem', { length: 64 }).primaryKey(),
  enabled: boolean('enabled').notNull().default(false),
  cronExpression: varchar('cron_expression', { length: 128 }),
  retentionDays: integer('retention_days'),
  retentionCount: integer('retention_count'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: varchar('updated_by', { length: 36 }),
});

export type BackupSchedule = typeof backupSchedules.$inferSelect;
export type NewBackupSchedule = typeof backupSchedules.$inferInsert;

// ─── Tenant lifecycle hook registry (migration 0069) ───
//
// One row per state transition the dispatcher kicks off + one row per
// (transition, hook) it tries to run. Mirrors the storage_operations
// shape so the existing progress-trail UI can render hook_runs once
// Phase 5 wires it up.
//
// Intentionally NOT cascade-on-tenant-delete: keeps history available
// for audit. Storage cron may prune rows older than N days.

export const tenantLifecycleTransitionKindEnum = pgEnum('tenant_lifecycle_transition_kind', [
  'active',
  'suspended',
  'archived',
  'restored',
  'deleted',
]);

export const tenantLifecycleTransitionStateEnum = pgEnum('tenant_lifecycle_transition_state', [
  'running',
  'completed',
  'failed_partial',
  'failed_blocking',
]);

export const tenantLifecycleHookRunStateEnum = pgEnum('tenant_lifecycle_hook_run_state', [
  'pending',
  'running',
  'ok',
  'noop',
  'failed',
]);

export const tenantLifecycleTransitions = pgTable('tenant_lifecycle_transitions', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 }).notNull(),
  transitionKind: tenantLifecycleTransitionKindEnum('transition_kind').notNull(),
  fromStatus: varchar('from_status', { length: 32 }),
  toStatus: varchar('to_status', { length: 32 }).notNull(),
  triggeredByUserId: varchar('triggered_by_user_id', { length: 36 }),
  state: tenantLifecycleTransitionStateEnum('state').notNull().default('running'),
  startedAt: timestamp('started_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
  // Captured at dispatch time so the Phase 5 retry scheduler can
  // re-run hooks even after the tenant row is gone (deleted transitions).
  namespace: varchar('namespace', { length: 63 }),
  detail: jsonb('detail').$type<Record<string, unknown> | null>(),
}, (table) => [
  index('tenant_lifecycle_transitions_tenant_idx').on(table.tenantId, table.startedAt),
  // Partial index — Phase 5 scheduler scans for stuck transitions.
  // Drizzle's index().where() emits this as `WHERE …` in the
  // generated migration; we keep the migration SQL hand-written for
  // 0069 so this entry exists purely to keep `drizzle-kit` from
  // flagging schema drift.
  index('tenant_lifecycle_transitions_state_idx')
    .on(table.state)
    .where(sql`state IN ('running', 'failed_blocking')`),
]);

export const tenantLifecycleHookRuns = pgTable('tenant_lifecycle_hook_runs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  transitionId: varchar('transition_id', { length: 36 })
    .notNull()
    .references(() => tenantLifecycleTransitions.id, { onDelete: 'cascade' }),
  hookName: varchar('hook_name', { length: 64 }).notNull(),
  hookOrder: integer('hook_order').notNull(),
  // 'abort' | 'continue' — declared by the hook, copied here at run time
  // so historical rows survive a hook re-classification.
  blocking: varchar('blocking', { length: 8 }).notNull(),
  state: tenantLifecycleHookRunStateEnum('state').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  // OperatorError envelope on failure; UI parses + renders via <ErrorPanel>.
  lastError: jsonb('last_error').$type<Record<string, unknown> | null>(),
  startedAt: timestamp('started_at'),
  completedAt: timestamp('completed_at'),
  // Set on retryable failure; scheduler picks rows where now() >= next_attempt_at.
  nextAttemptAt: timestamp('next_attempt_at'),
}, (table) => [
  index('tenant_lifecycle_hook_runs_transition_idx').on(table.transitionId, table.hookOrder),
  uniqueIndex('tenant_lifecycle_hook_runs_uniq_idx').on(table.transitionId, table.hookName),
  // Phase 5 retry tick scans this. Partial index avoids dragging
  // ok/noop rows into every retry pass.
  index('tenant_lifecycle_hook_runs_retry_idx')
    .on(table.nextAttemptAt)
    .where(sql`state = 'failed' AND next_attempt_at IS NOT NULL`),
]);

// ─── M1 Node-role Taxonomy (migration 0046) ───
//
// Backend mirror of k8s node inventory with platform-specific role +
// config annotations. Source of truth for platform-managed fields (role,
// canHostTenantWorkloads); k8s labels are the source of truth for
// operator-managed ad-hoc state and are captured in `labels`. The
// node-sync reconciler upserts from `kubectl get nodes` every 60s.
//
// See migration 0046_cluster_nodes.sql for column semantics.

export const nodeRoleEnum = pgEnum('node_role', ['server', 'worker']);

interface NodeCondition {
  type: string;
  status: string;
  reason?: string;
  message?: string;
}

// Three-state ingress mode (migration 0052). The DB column is a plain
// varchar with a CHECK constraint instead of a pgEnum because Postgres
// enums require a separate `ALTER TYPE … ADD VALUE` migration step
// per new value, which we may want to extend later (e.g. 'maintenance').
export type NodeIngressMode = 'all' | 'local' | 'none';

export const clusterNodes = pgTable('cluster_nodes', {
  name: varchar('name', { length: 253 }).primaryKey(),
  // Optional UI alias. k8s identity stays in `name`; operators see
  // displayName when set. Migration 0052.
  displayName: varchar('display_name', { length: 253 }),
  role: nodeRoleEnum('role').notNull().default('worker'),
  canHostTenantWorkloads: boolean('can_host_tenant_workloads').notNull().default(true),
  ingressMode: varchar('ingress_mode', { length: 8 }).$type<NodeIngressMode>().notNull().default('all'),
  publicIp: inet('public_ip'),
  kubeletVersion: varchar('kubelet_version', { length: 32 }),
  k3sVersion: varchar('k3s_version', { length: 32 }),
  cpuMillicores: integer('cpu_millicores'),
  memoryBytes: bigint('memory_bytes', { mode: 'number' }),
  storageBytes: bigint('storage_bytes', { mode: 'number' }),
  // Live-usage snapshot from the node-sync reconciler. Aggregates
  // pods.spec.containers[*].resources.requests per node. Null until
  // the reconciler has observed this node at least once.
  scheduledPods: integer('scheduled_pods'),
  cpuRequestsMillicores: integer('cpu_requests_millicores'),
  memoryRequestsBytes: bigint('memory_requests_bytes', { mode: 'number' }),
  statusConditions: jsonb('status_conditions').$type<NodeCondition[] | null>(),
  // Migration 0050 — TIMESTAMPTZ so freshServerCount's NOW()-interval
  // comparison isn't sensitive to the session TimeZone GUC.
  joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
  notes: text('notes'),
  labels: jsonb('labels').$type<Record<string, string> | null>(),
  taints: jsonb('taints').$type<Array<{ key: string; value?: string; effect: string }> | null>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index('cluster_nodes_role_idx').on(table.role),
  index('cluster_nodes_last_seen_idx').on(table.lastSeenAt),
]);

export type ClusterNode = typeof clusterNodes.$inferSelect;
export type NewClusterNode = typeof clusterNodes.$inferInsert;

// ─── Passkey (WebAuthn) tables (migration 0061) ──────────────────────

/**
 * One row per registered passkey credential. A user may have many.
 * Deletion cascades on the user row so a hard-deleted user can't leave
 * orphan credentials behind.
 *
 * sign_count rollback detection: only enforced when stored > 0 AND
 * incoming <= stored. Synced passkeys (Apple iCloud Keychain,
 * 1Password, Bitwarden) often report sign_count=0 every time, so a
 * naive `incoming <= stored` check breaks them on every login.
 */
export const userPasskeys = pgTable('user_passkeys', {
  id: varchar('id', { length: 36 }).primaryKey(),
  userId: varchar('user_id', { length: 36 })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  credentialId: bytea('credential_id').notNull(),
  publicKey: bytea('public_key').notNull(),
  signCount: integer('sign_count').notNull().default(0),
  transports: jsonb('transports').$type<string[] | null>(),
  aaguid: varchar('aaguid', { length: 36 }),
  nickname: varchar('nickname', { length: 100 }).notNull(),
  backupEligible: boolean('backup_eligible').notNull().default(false),
  backedUp: boolean('backed_up').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
}, (table) => [
  uniqueIndex('user_passkeys_credential_id_unique').on(table.credentialId),
  index('user_passkeys_user_idx').on(table.userId),
]);

export type UserPasskey = typeof userPasskeys.$inferSelect;
export type NewUserPasskey = typeof userPasskeys.$inferInsert;

/**
 * Ephemeral WebAuthn challenge store. Single-use, 5-min TTL.
 * Pruned by a nightly cron. Reading on /verify also marks consumed.
 *
 * userId is set on register and login_2fa flows (we know the user
 * up front), and NULL for login_userless flows where the user is
 * resolved post-assertion via the credential's userHandle.
 */
export const passkeyChallenges = pgTable('passkey_challenges', {
  id: varchar('id', { length: 36 }).primaryKey(),
  challenge: bytea('challenge').notNull(),
  purpose: varchar('purpose', { length: 16 }).notNull(),
  userId: varchar('user_id', { length: 36 })
    .references(() => users.id, { onDelete: 'cascade' }),
  panel: varchar('panel', { length: 16 }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => [
  index('passkey_challenges_expires_idx').on(table.expiresAt),
  index('passkey_challenges_user_idx').on(table.userId),
]);

export type PasskeyChallenge = typeof passkeyChallenges.$inferSelect;
export type NewPasskeyChallenge = typeof passkeyChallenges.$inferInsert;

/**
 * Single-use token marker. Replaces an in-memory JTI cache because
 * platform-api runs 3 replicas and we can't trust a per-replica
 * Map. Used for pre-auth tokens (issued during 2FA step 1) and
 * password-reset tokens.
 */
export const authConsumedTokens = pgTable('auth_consumed_tokens', {
  jti: varchar('jti', { length: 36 }).primaryKey(),
  userId: varchar('user_id', { length: 36 })
    .notNull()
    .references(() => users.id, { onDelete: 'cascade' }),
  purpose: varchar('purpose', { length: 32 }).notNull(),
  consumedAt: timestamp('consumed_at', { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
}, (table) => [
  index('auth_consumed_tokens_expires_idx').on(table.expiresAt),
]);

export type AuthConsumedToken = typeof authConsumedTokens.$inferSelect;
export type NewAuthConsumedToken = typeof authConsumedTokens.$inferInsert;

// ─── Backup Bundles v2 (ADR-032 / migration 0066) ───────────────────────────

export const backupInitiatorEnum = pgEnum('backup_initiator', [
  'tenant',
  'admin',
  'system',
  'cluster',
]);

export const backupSystemTriggerEnum = pgEnum('backup_system_trigger', [
  'pre_resize',
  'pre_archive',
  'scheduled',
  'manual',
]);

export const backupJobStatusEnum = pgEnum('backup_job_status', [
  'pending',
  'running',
  'completed',
  'partial',
  'failed',
  'expired',
]);

export const backupComponentNameEnum = pgEnum('backup_component_name', [
  'files',
  'mailboxes',
  'config',
  'secrets',
]);

export const backupComponentStatusEnum = pgEnum('backup_component_status', [
  'pending',
  'running',
  'completed',
  'skipped',
  'failed',
]);

export const backupTargetKindEnum = pgEnum('backup_target_kind', [
  'hostpath',
  's3',
  'ssh',
]);

export const tenantBackupScheduleFreqEnum = pgEnum('tenant_backup_schedule_freq', [
  'daily',
  'weekly',
  'monthly',
]);

export const backupJobs = pgTable('backup_jobs', {
  id: varchar('id', { length: 64 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  initiator: backupInitiatorEnum('initiator').notNull(),
  systemTrigger: backupSystemTriggerEnum('system_trigger'),
  status: backupJobStatusEnum('status').notNull().default('pending'),
  targetKind: backupTargetKindEnum('target_kind').notNull(),
  targetUri: varchar('target_uri', { length: 1000 }).notNull(),
  targetConfigId: varchar('target_config_id', { length: 36 })
    .references(() => backupConfigurations.id, { onDelete: 'set null' }),
  label: varchar('label', { length: 255 }),
  description: text('description'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
  retentionDays: integer('retention_days').notNull(),
  expiresAt: timestamp('expires_at'),
  exportMode: varchar('export_mode', { length: 32 }),
  exportArtifact: varchar('export_artifact', { length: 1000 }),
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('backup_jobs_tenant_idx').on(table.tenantId),
  index('backup_jobs_status_idx').on(table.status),
  index('backup_jobs_initiator_idx').on(table.initiator),
  index('backup_jobs_expires_idx').on(table.expiresAt),
]);

export const backupComponents = pgTable('backup_components', {
  id: varchar('id', { length: 36 }).primaryKey(),
  backupJobId: varchar('backup_job_id', { length: 64 })
    .notNull()
    .references(() => backupJobs.id, { onDelete: 'cascade' }),
  component: backupComponentNameEnum('component').notNull(),
  artifactName: varchar('artifact_name', { length: 255 }).notNull(),
  status: backupComponentStatusEnum('status').notNull().default('pending'),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
  sha256: varchar('sha256', { length: 64 }),
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('backup_components_job_component_artifact_unique')
    .on(table.backupJobId, table.component, table.artifactName),
  index('backup_components_job_idx').on(table.backupJobId),
  index('backup_components_status_idx').on(table.status),
]);

export const tenantBackupSchedules = pgTable('tenant_backup_schedules', {
  tenantId: varchar('tenant_id', { length: 36 })
    .primaryKey()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  enabled: boolean('enabled').notNull().default(false),
  frequency: tenantBackupScheduleFreqEnum('frequency').notNull().default('weekly'),
  hourOfDayUtc: integer('hour_of_day_utc').notNull().default(3),
  dayOfWeek: integer('day_of_week'),
  dayOfMonth: integer('day_of_month'),
  retentionDays: integer('retention_days').notNull().default(14),
  lastRunAt: timestamp('last_run_at'),
  lastRunStatus: backupJobStatusEnum('last_run_status'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

export type BackupJob = typeof backupJobs.$inferSelect;
export type NewBackupJob = typeof backupJobs.$inferInsert;
export type BackupComponent = typeof backupComponents.$inferSelect;
export type NewBackupComponent = typeof backupComponents.$inferInsert;
export type TenantBackupSchedule = typeof tenantBackupSchedules.$inferSelect;
export type NewTenantBackupSchedule = typeof tenantBackupSchedules.$inferInsert;

// ─── Tenant Backup v2 (ADR-036, migration 0093) ─────────────────────────
// Per-tenant restic repository state + per-mailbox JMAP state + global
// settings. See docs/07-reference/ADR-036-tenant-backup-restic-jmap.md.

export const tenantResticRepoState = pgTable('tenant_restic_repo_state', {
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  // Component name matching backup_components.component. Today only
  // 'files' and 'mailboxes' use restic.
  component: varchar('component', { length: 32 }).notNull(),
  repoUri: varchar('repo_uri', { length: 2000 }).notNull(),
  targetConfigId: varchar('target_config_id', { length: 36 })
    .references(() => backupConfigurations.id, { onDelete: 'set null' }),
  lastSnapshotId: varchar('last_snapshot_id', { length: 64 }),
  lastBackupJobId: varchar('last_backup_job_id', { length: 64 })
    .references(() => backupJobs.id, { onDelete: 'set null' }),
  lastRepoSizeBytes: bigint('last_repo_size_bytes', { mode: 'number' }).notNull().default(0),
  lastSnapshotAt: timestamp('last_snapshot_at'),
  lastRunAt: timestamp('last_run_at'),
  lastCheckStatus: varchar('last_check_status', { length: 32 }),
  lastCheckAt: timestamp('last_check_at'),
  lastCheckError: text('last_check_error'),
  // Phase 1.5 multi-region/DR (migration 0094). Nullable for existing
  // (pre-Phase-1.5) rows; orchestrator stamps with BUNDLE_SCHEMA_VERSION
  // on next backup. See migration 0094 for the rationale.
  bundleSchemaVersion: integer('bundle_schema_version'),
  sourceRegionId: varchar('source_region_id', { length: 63 }),
  drKeyAddedAt: timestamp('dr_key_added_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.component] }),
  index('tenant_restic_repo_state_target_idx').on(table.targetConfigId),
]);

export const tenantJmapState = pgTable('tenant_jmap_state', {
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  mailboxJmapId: varchar('mailbox_jmap_id', { length: 255 }).notNull(),
  mailboxAddress: varchar('mailbox_address', { length: 255 }).notNull(),
  // NULL = no prior state, do a full pull. Persisted ONLY after restic
  // snapshot acks the corresponding backup. At-least-once semantics.
  lastJmapState: text('last_jmap_state'),
  lastSyncedAt: timestamp('last_synced_at'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  primaryKey({ columns: [table.tenantId, table.mailboxJmapId] }),
  index('tenant_jmap_state_tenant_idx').on(table.tenantId, table.lastSyncedAt),
]);

// Single-row global settings for tenant-backup v2. CHECK constraint in
// the migration enforces id=1.
export const tenantBackupV2Settings = pgTable('tenant_backup_v2_settings', {
  id: integer('id').primaryKey().default(1),
  retentionDays: integer('retention_days').notNull().default(30),
  checkIntervalDays: integer('check_interval_days').notNull().default(7),
  // Per-platform-api-pod cap (default 2 after 2026-05-11 OOM fix —
  // see migration 0096). Each restic process budgets ~320 MiB pack
  // buffer + ~200 MiB working set = ~520 MiB, so 2 fit in the 2 GiB
  // pod limit alongside ambient platform-api workload.
  maxConcurrentRestic: integer('max_concurrent_restic').notNull().default(2),
  // Cluster-wide cap (default 4) — enforced via tenant_bundle_in_flight
  // table + advisory-lock-serialised acquire. 0 = unlimited.
  globalMaxInFlight: integer('global_max_in_flight').notNull().default(4),
  // Phase 1.5 multi-region/DR (migration 0094):
  // Override for the auto-derived (slugified PLATFORM_BASE_DOMAIN)
  // region id. NULL = use the derived value.
  regionIdOverride: varchar('region_id_override', { length: 63 }),
  // Encrypted-at-rest 32-byte secret used to derive per-tenant DR
  // recovery passwords (HKDF info=`dr-recovery:${tenantId}`). NULL
  // disables auto-add of the DR key — operator runs Option B
  // (one-shot migration keys) only.
  drRecoveryKeyEncrypted: text('dr_recovery_key_encrypted'),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

// Cluster-wide concurrency gate for restic-stream captures (migration
// 0096). One row per active (bundle, component) capture. Runtime
// acquire/release lives in `modules/tenant-bundles/cluster-concurrency.ts`.
// Row presence + COUNT(*) < global_max_in_flight is the cap check.
// `refreshed_at` heartbeat (every 60s during capture) lets stale rows
// from a crashed pod expire after 5 min so they don't block new
// captures.
export const tenantBundleInFlight = pgTable('tenant_bundle_in_flight', {
  bundleId: varchar('bundle_id', { length: 64 }).notNull(),
  component: varchar('component', { length: 32 }).notNull(),
  podName: varchar('pod_name', { length: 255 }),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  refreshedAt: timestamp('refreshed_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.bundleId, table.component] }),
  index('tenant_bundle_in_flight_refreshed_idx').on(table.refreshedAt),
]);

// External read-only repos for cross-region migration / DR. Operator
// registers a backup_configurations row (S3/SFTP) with read-only IAM
// as a remote source the cross-region restore executor is allowed to
// read from. The registry IS the allowlist.
export const externalBackupRepos = pgTable('external_backup_repos', {
  id: varchar('id', { length: 36 }).primaryKey(),
  targetConfigId: varchar('target_config_id', { length: 36 })
    .notNull()
    .references(() => backupConfigurations.id, { onDelete: 'restrict' }),
  sourceRegionId: varchar('source_region_id', { length: 63 }).notNull(),
  drRecoveryKeyEncrypted: text('dr_recovery_key_encrypted'),
  label: varchar('label', { length: 255 }).notNull(),
  // Hard-defaulted TRUE; CHECK constraint in migration 0094 enforces
  // it at the database layer (`CHECK (read_only = TRUE)`). The Phase 3
  // cross-region restore executor's allowlist guard treats every row in
  // this table as read-only — a future migration that drops the CHECK
  // would silently bypass that guard, so DO NOT remove it without
  // also removing the executor's reliance on this invariant.
  readOnly: boolean('read_only').notNull().default(true),
  lastSeenAt: timestamp('last_seen_at'),
  addedAt: timestamp('added_at').notNull().defaultNow(),
  addedByUserId: varchar('added_by_user_id', { length: 36 })
    .references(() => users.id, { onDelete: 'set null' }),
  notes: text('notes'),
}, (table) => [
  index('external_backup_repos_target_idx').on(table.targetConfigId),
  index('external_backup_repos_region_idx').on(table.sourceRegionId),
]);

export type TenantResticRepoState = typeof tenantResticRepoState.$inferSelect;
export type NewTenantResticRepoState = typeof tenantResticRepoState.$inferInsert;
export type TenantJmapState = typeof tenantJmapState.$inferSelect;
export type NewTenantJmapState = typeof tenantJmapState.$inferInsert;
export type TenantBackupV2Settings = typeof tenantBackupV2Settings.$inferSelect;
export type ExternalBackupRepo = typeof externalBackupRepos.$inferSelect;
export type NewExternalBackupRepo = typeof externalBackupRepos.$inferInsert;

// ─── Private Workers (migration 0076) ─────────────────────────────────────
// Per-tenant tunnel agents. A home box runs the private-worker-agent docker
// container which dials in over WSS to tunnels.${DOMAIN}/c/{slug}/. A frps pod
// in the tenant namespace terminates the tunnel and exposes a Service that
// the existing ingressRoutes target. See docs/04-deployment/PRIVATE_WORKER.md.
// (Enums for this feature are declared near the top of the file alongside
// the other pgEnum declarations because ingressRoutes.targetType references
// ingressTargetTypeEnum and pgEnum forward-references aren't supported.)

export const privateWorkers = pgTable('private_workers', {
  id: varchar('id', { length: 36 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 120 }).notNull(),
  slug: varchar('slug', { length: 60 }).notNull().unique(),
  workerTokenHash: varchar('worker_token_hash', { length: 64 }).notNull(),
  status: privateWorkerStatusEnum('status').notNull().default('pending'),
  exposedPort: integer('exposed_port').notNull(),
  description: text('description'),
  lastSeenAt: timestamp('last_seen_at'),
  lastUsedIp: inet('last_used_ip'),
  bytesIn: bigint('bytes_in', { mode: 'number' }).notNull().default(0),
  bytesOut: bigint('bytes_out', { mode: 'number' }).notNull().default(0),
  createdBy: varchar('created_by', { length: 36 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  revokedAt: timestamp('revoked_at'),
  revokedBy: varchar('revoked_by', { length: 36 }),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('private_workers_tenant_idx').on(table.tenantId),
  index('private_workers_status_idx').on(table.status),
  uniqueIndex('private_workers_tenant_name_uq').on(table.tenantId, table.name),
  // Migration 0089 — backstop for service.ts::allocateExposedPort race.
  // Without this, two concurrent creates can pick the same lowest-free
  // port; with it, the second INSERT fails atomically and the caller
  // retries.
  uniqueIndex('private_workers_tenant_port_uq').on(table.tenantId, table.exposedPort),
]);

export const privateWorkerAudit = pgTable('private_worker_audit', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  privateWorkerId: varchar('private_worker_id', { length: 36 })
    .notNull()
    .references(() => privateWorkers.id, { onDelete: 'cascade' }),
  event: varchar('event', { length: 40 }).notNull(),
  ip: inet('ip'),
  detail: jsonb('detail'),
  occurredAt: timestamp('occurred_at').notNull().defaultNow(),
}, (table) => [
  index('private_worker_audit_worker_idx').on(table.privateWorkerId, table.occurredAt),
  index('private_worker_audit_event_idx').on(table.event, table.occurredAt),
]);

export type PrivateWorker = typeof privateWorkers.$inferSelect;
export type NewPrivateWorker = typeof privateWorkers.$inferInsert;
export type PrivateWorkerAuditRow = typeof privateWorkerAudit.$inferSelect;
export type NewPrivateWorkerAuditRow = typeof privateWorkerAudit.$inferInsert;

// ─── Restore Carts (ADR-034 / migration 0079) ───────────────────────────────

export const restoreJobStatusEnum = pgEnum('restore_job_status', [
  'draft',
  'executing',
  'paused',
  'done',
  'failed',
]);

export const restoreItemTypeEnum = pgEnum('restore_item_type', [
  'files-paths',
  'mailboxes-by-address',
  'deployments-by-id',
  'domains-by-id',
  'config-tables',
]);

export const restoreItemStatusEnum = pgEnum('restore_item_status', [
  'pending',
  'applying',
  'done',
  'failed',
  'skipped',
]);

export const restoreJobs = pgTable('restore_jobs', {
  id: varchar('id', { length: 64 }).primaryKey(),
  tenantId: varchar('tenant_id', { length: 36 })
    .notNull()
    .references(() => tenants.id, { onDelete: 'cascade' }),
  initiatorUserId: varchar('initiator_user_id', { length: 36 })
    .references(() => users.id, { onDelete: 'set null' }),
  status: restoreJobStatusEnum('status').notNull().default('draft'),
  preRestoreSnapshotId: varchar('pre_restore_snapshot_id', { length: 36 }),
  description: text('description'),
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('restore_jobs_tenant_idx').on(table.tenantId),
  index('restore_jobs_status_idx').on(table.status),
  index('restore_jobs_created_idx').on(table.createdAt),
]);

export const restoreItems = pgTable('restore_items', {
  id: varchar('id', { length: 36 }).primaryKey(),
  restoreJobId: varchar('restore_job_id', { length: 64 })
    .notNull()
    .references(() => restoreJobs.id, { onDelete: 'cascade' }),
  // Loose FK to backup_jobs.id — we keep orphan visibility on bundle
  // delete instead of cascade (operator sees the broken reference).
  bundleId: varchar('bundle_id', { length: 64 }).notNull(),
  type: restoreItemTypeEnum('type').notNull(),
  selector: jsonb('selector').$type<Record<string, unknown>>().notNull(),
  label: varchar('label', { length: 255 }),
  seq: integer('seq').notNull(),
  status: restoreItemStatusEnum('status').notNull().default('pending'),
  progressMessage: varchar('progress_message', { length: 500 }),
  sizeBytes: bigint('size_bytes', { mode: 'number' }).notNull().default(0),
  startedAt: timestamp('started_at'),
  finishedAt: timestamp('finished_at'),
  lastError: text('last_error'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('restore_items_job_idx').on(table.restoreJobId),
  index('restore_items_status_idx').on(table.status),
  uniqueIndex('restore_items_seq_unique').on(table.restoreJobId, table.seq),
]);

export type RestoreJob = typeof restoreJobs.$inferSelect;
export type NewRestoreJob = typeof restoreJobs.$inferInsert;
export type RestoreItem = typeof restoreItems.$inferSelect;
export type NewRestoreItem = typeof restoreItems.$inferInsert;

// ─── Top-bar Task Tracker (migration 0090) ────────────────────────────
//
// UI-projection of long-running operations for the chip in the admin /
// tenant panel header. Helper-only writes — see backend/src/modules/tasks/.
// Idempotent on (kind, ref_id); pg_notify trigger emits deltas to
// `tasks_user_<id>` channels for SSE consumers.

export const tasks = pgTable('tasks', {
  id: varchar('id', { length: 36 }).primaryKey(),
  kind: varchar('kind', { length: 64 }).notNull(),
  refId: varchar('ref_id', { length: 64 }),
  scope: varchar('scope', { length: 16 }).notNull(),
  userId: varchar('user_id', { length: 36 }),
  tenantId: varchar('tenant_id', { length: 36 }),
  label: text('label').notNull(),
  status: varchar('status', { length: 16 }).notNull(),
  progressPct: integer('progress_pct'),
  progressText: text('progress_text'),
  target: jsonb('target').$type<Record<string, unknown>>().notNull(),
  errorMessage: text('error_message'),
  details: jsonb('details').$type<Record<string, unknown>>(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  clearedAt: timestamp('cleared_at', { withTimezone: true }),
  parentTaskId: varchar('parent_task_id', { length: 36 }),
}, (table) => [
  // Drizzle's index DSL doesn't model partial indexes; the migration
  // (0090_tasks.sql) declares the partial indexes directly. These are
  // covering indexes used by the schema dump only.
  index('tasks_user_updated_idx').on(table.userId, table.updatedAt),
  index('tasks_tenant_updated_idx').on(table.tenantId, table.updatedAt),
  index('tasks_parent_idx').on(table.parentTaskId),
]);

export type Task = typeof tasks.$inferSelect;
export type NewTask = typeof tasks.$inferInsert;

// ─── Node-health monitor (migration 0092) ────────────────────────────────────
//
// Persistent state for the 5-min node-health reconciler. See
// backend/src/modules/node-health/scheduler.ts for the writer +
// notification-throttling logic.
const stringArray = customType<{ data: string[]; driverData: string }>({
  dataType() { return 'text[]'; },
  toDriver(v: string[]) {
    // Postgres array literal: {a,b,c} with quoting on items containing commas/quotes.
    return '{' + v.map((s) => '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"').join(',') + '}';
  },
  fromDriver(v: unknown) {
    if (Array.isArray(v)) return v as string[];
    if (typeof v !== 'string' || v.length === 0) return [];
    const inner = v.replace(/^\{|\}$/g, '');
    if (inner === '') return [];
    return inner.split(',').map((s) => s.replace(/^"|"$/g, '').replace(/\\"/g, '"').replace(/\\\\/g, '\\'));
  },
});

export const nodeHealthState = pgTable('node_health_state', {
  nodeName: text('node_name').primaryKey(),
  ready: boolean('ready').notNull().default(true),
  pressures: stringArray('pressures').notNull().default(sql`'{}'::text[]`),
  csiDriversPresent: integer('csi_drivers_present').notNull().default(0),
  csiDriversExpected: integer('csi_drivers_expected').notNull().default(0),
  csiDriversMissing: stringArray('csi_drivers_missing').notNull().default(sql`'{}'::text[]`),
  evictionsLastHour: integer('evictions_last_hour').notNull().default(0),
  diskUsedPct: numeric('disk_used_pct', { precision: 5, scale: 2 }),
  severity: varchar('severity', { length: 16 }).notNull().default('normal'),
  lastNotifiedAt: timestamp('last_notified_at', { withTimezone: true }),
  observedAt: timestamp('observed_at', { withTimezone: true }).notNull().defaultNow(),
});

export type NodeHealthState = typeof nodeHealthState.$inferSelect;
export type NewNodeHealthState = typeof nodeHealthState.$inferInsert;
