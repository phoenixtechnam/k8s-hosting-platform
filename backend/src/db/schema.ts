import {
  pgTable,
  pgEnum,
  varchar,
  text,
  integer,
  numeric,
  bigint,
  boolean,
  timestamp,
  jsonb,
  inet,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

// ─── Enums ───

export const panelEnum = pgEnum('panel', ['admin', 'client']);
export const userStatusEnum = pgEnum('user_status', ['active', 'disabled', 'pending']);
export const regionStatusEnum = pgEnum('region_status', ['active', 'maintenance', 'offline']);
export const planStatusEnum = pgEnum('plan_status', ['active', 'deprecated']);
// Client lifecycle states:
//   active     — running normally
//   pending    — provisioned but not yet migrated / payment pending
//   suspended  — admin paused: workloads scaled to 0, quota near-zero,
//                PVC preserved, billing paused. Reversible via resume.
//   archived   — churned / paid off-boarding: PVC destroyed, snapshot
//                retained per snapshot_retention_days. Reversible via
//                restore (new PVC from snapshot).
//   cancelled  — hard terminated, snapshot also released. Not reversible.
export const clientStatusEnum = pgEnum('client_status', ['active', 'suspended', 'archived', 'pending']);
export const clientStorageTierEnum = pgEnum('client_storage_tier', ['local', 'ha']);
// Active storage-lifecycle operation (null when idle). Separate from
// client.status so the UI can show both "active & resizing" without
// losing the underlying state. Mirrors storage_operations.state for the
// operation currently owning this client.
export const storageLifecycleStateEnum = pgEnum('storage_lifecycle_state', [
  'idle', 'snapshotting', 'quiescing', 'resizing', 'replacing', 'restoring', 'unquiescing', 'archiving', 'failed',
]);
export const storageOperationTypeEnum = pgEnum('storage_operation_type', [
  'snapshot', 'resize', 'suspend', 'resume', 'archive', 'restore',
]);
export const storageSnapshotKindEnum = pgEnum('storage_snapshot_kind', [
  'manual', 'pre-resize', 'pre-suspend', 'pre-archive', 'scheduled',
]);
export const storageSnapshotStatusEnum = pgEnum('storage_snapshot_status', [
  'creating', 'ready', 'expired', 'failed',
]);
export const provisioningStatusEnum = pgEnum('provisioning_status', ['unprovisioned', 'provisioning', 'provisioned', 'failed']);
export const domainStatusEnum = pgEnum('domain_status', ['active', 'pending', 'suspended', 'deleted']);
export const dnsModeEnum = pgEnum('dns_mode', ['primary', 'cname', 'secondary']);
export const dnsProviderTypeEnum = pgEnum('dns_provider_type', ['powerdns', 'rndc', 'cloudflare', 'route53', 'hetzner', 'cloudns', 'mock']);
export const zoneDefaultKindEnum = pgEnum('zone_default_kind', ['Native', 'Master']);
export const catalogRepoStatusEnum = pgEnum('catalog_repo_status', ['active', 'error', 'syncing']);
export const catalogEntryTypeEnum = pgEnum('catalog_entry_type', ['application', 'runtime', 'database', 'service', 'static']);
export const catalogEntryStatusEnum = pgEnum('catalog_entry_status', ['available', 'beta', 'deprecated']);
export const deploymentStatusEnum = pgEnum('deployment_status', ['deploying', 'running', 'stopped', 'failed', 'deleting', 'upgrading', 'pending', 'deleted']);
export const notificationTypeEnum = pgEnum('notification_type', ['info', 'warning', 'error', 'success']);
export const storageTypeEnum = pgEnum('storage_type', ['ssh', 's3']);
export const backupTypeEnum = pgEnum('backup_type', ['auto', 'manual', 'scheduled']);
export const backupStatusEnum = pgEnum('backup_status', ['pending', 'in_progress', 'completed', 'failed']);
export const metricTypeEnum = pgEnum('metric_type', ['cpu_cores', 'memory_gb', 'storage_gb', 'bandwidth_gb']);
export const cronJobTypeEnum = pgEnum('cron_job_type', ['webcron', 'deployment']);
export const httpMethodEnum = pgEnum('http_method', ['GET', 'POST', 'PUT']);
export const lastRunStatusEnum = pgEnum('last_run_status', ['success', 'failed', 'running']);
export const actorTypeEnum = pgEnum('actor_type', ['user', 'system', 'webhook']);
export const provTaskTypeEnum = pgEnum('prov_task_type', ['provision_namespace', 'deploy_workload', 'deprovision']);
export const provTaskStatusEnum = pgEnum('prov_task_status', ['pending', 'running', 'completed', 'failed']);
export const scopeTypeEnum = pgEnum('scope_type', ['global', 'region', 'client']);
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
export const panelScopeEnum = pgEnum('panel_scope', ['admin', 'client']);
export const wwwRedirectEnum = pgEnum('www_redirect', ['none', 'add-www', 'remove-www']);

// ─── Admin & Shared Tables ───

export const users = pgTable('users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  passwordHash: varchar('password_hash', { length: 255 }),
  fullName: varchar('full_name', { length: 255 }).notNull(),
  roleName: varchar('role_name', { length: 50 }).notNull().default('read_only'),
  panel: panelEnum().notNull().default('admin'),
  clientId: varchar('client_id', { length: 36 })
    .references(() => clients.id, { onDelete: 'cascade' }),
  status: userStatusEnum().notNull().default('pending'),
  emailVerifiedAt: timestamp('email_verified_at'),
  lastLoginAt: timestamp('last_login_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  oidcSubject: varchar('oidc_subject', { length: 255 }),
  oidcIssuer: varchar('oidc_issuer', { length: 500 }),
  timezone: varchar('timezone', { length: 50 }),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('users_email_unique').on(table.email),
  uniqueIndex('users_oidc_unique').on(table.oidcIssuer, table.oidcSubject),
]);

export const oidcProviders = pgTable('oidc_providers', {
  id: varchar('id', { length: 36 }).primaryKey(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  issuerUrl: varchar('issuer_url', { length: 500 }).notNull(),
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
  disableLocalAuthClient: integer('disable_local_auth_client').notNull().default(0),
  breakGlassSecretHash: varchar('break_glass_secret_hash', { length: 255 }),
  protectAdminViaProxy: integer('protect_admin_via_proxy').notNull().default(0),
  protectClientViaProxy: integer('protect_client_via_proxy').notNull().default(0),
  breakGlassPath: varchar('break_glass_path', { length: 100 }),
  oauth2ProxyCookieSecretEncrypted: text('oauth2_proxy_cookie_secret_encrypted'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
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
  // Plan-level cap on total mailboxes across all the client's
  // email domains. Can be overridden per-client via
  // clients.max_mailboxes_override.
  maxMailboxes: integer('max_mailboxes').notNull().default(50),
  weeklyAiBudgetCents: integer('weekly_ai_budget_cents').notNull().default(100),
  features: jsonb('features').$type<Record<string, unknown>>(),
  status: planStatusEnum().notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('hosting_plans_code_unique').on(table.code),
]);

// ─── Tenant Tables ───

export const clients = pgTable('clients', {
  id: varchar('id', { length: 36 }).primaryKey(),
  regionId: varchar('region_id', { length: 36 }).notNull(),
  companyName: varchar('company_name', { length: 255 }).notNull(),
  companyEmail: varchar('company_email', { length: 255 }).notNull(),
  contactEmail: varchar('contact_email', { length: 255 }),
  status: clientStatusEnum().notNull().default('pending'),
  kubernetesNamespace: varchar('kubernetes_namespace', { length: 63 }).notNull(),
  planId: varchar('plan_id', { length: 36 }).notNull(),
  cpuLimitOverride: numeric('cpu_limit_override', { precision: 5, scale: 2 }),
  memoryLimitOverride: numeric('memory_limit_override', { precision: 5, scale: 2 }),
  storageLimitOverride: numeric('storage_limit_override', { precision: 10, scale: 2 }),
  maxSubUsersOverride: integer('max_sub_users_override'),
  monthlyPriceOverride: numeric('monthly_price_override', { precision: 10, scale: 2 }),
  // Phase 1 (client-panel email parity round 2): per-customer
  // mailbox count override. null = inherit from the plan's
  // max_mailboxes. Used by the limit check in mailboxes/service.ts.
  maxMailboxesOverride: integer('max_mailboxes_override'),
  // Phase 3.B.3: per-customer email send rate limit (messages/hour).
  // null = inherit the global default from platform_settings key
  // `email_send_rate_limit_default`. Suspended clients are forced to
  // rate=0 at the Stalwart level regardless of this value.
  emailSendRateLimit: integer('email_send_rate_limit'),
  timezone: varchar('timezone', { length: 50 }),
  // M5: per-client worker pinning. NULL = default scheduler picks a
  // node that matches the (implicit) worker constraints (anti-affinity
  // with system pods via the server-only taint). When set, the
  // k8s-deployer passes this through to deployK8sDeployment's
  // workerNodeName parameter (M3), producing a
  // kubernetes.io/hostname nodeSelector.
  workerNodeName: varchar('worker_node_name', { length: 253 }),
  // M7: tenant storage tier. 'local' = longhorn-tenant-local (1 replica);
  // 'ha' = longhorn-tenant-ha (2 replicas). Default 'local' matches
  // migration 0048 and preserves pre-M7 scheduling.
  storageTier: clientStorageTierEnum('storage_tier').notNull().default('local'),
  provisioningStatus: provisioningStatusEnum().notNull().default('unprovisioned'),
  // Active storage-lifecycle op (null when the client isn't being
  // resized/suspended/archived/restored). The storage_operations row
  // carrying full state is referenced by activeStorageOpId.
  storageLifecycleState: storageLifecycleStateEnum('storage_lifecycle_state').notNull().default('idle'),
  activeStorageOpId: varchar('active_storage_op_id', { length: 36 }),
  createdBy: varchar('created_by', { length: 36 }),
  subscriptionExpiresAt: timestamp('subscription_expires_at'),
  // Stamped ONLY by the lifecycle cascades (applySuspended / applyArchived)
  // — used by the auto-archive / auto-delete crons so unrelated admin
  // edits to the client row don't reset the clock. See migration 0044.
  suspendedAt: timestamp('suspended_at'),
  archivedAt: timestamp('archived_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('clients_namespace_unique').on(table.kubernetesNamespace),
  index('clients_region_idx').on(table.regionId),
  index('clients_plan_idx').on(table.planId),
  index('clients_status_idx').on(table.status),
]);

export const domains = pgTable('domains', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 })
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  domainName: varchar('domain_name', { length: 255 }).notNull(),
  deploymentId: varchar('deployment_id', { length: 36 }),
  dnsGroupId: varchar('dns_group_id', { length: 36 }),
  status: domainStatusEnum().notNull().default('pending'),
  dnsMode: dnsModeEnum().notNull().default('cname'),
  masterIp: varchar('master_ip', { length: 45 }),
  verifiedAt: timestamp('verified_at'),
  lastVerifiedAt: timestamp('last_verified_at'),
  sslAutoRenew: integer('ssl_auto_renew').notNull().default(1),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('domains_name_unique').on(table.domainName),
  index('domains_client_idx').on(table.clientId),
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
  volumes: jsonb('volumes').$type<Array<{ local_path: string; container_path: string; description?: string; optional?: boolean }> | null>(),
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
  clientId: varchar('client_id', { length: 36 })
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  catalogEntryId: varchar('catalog_entry_id', { length: 36 }).notNull(),
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
  uniqueIndex('deployments_client_name_unique').on(table.clientId, table.name),
  index('deployments_client_idx').on(table.clientId),
  index('deployments_catalog_entry_idx').on(table.catalogEntryId),
  index('deployments_status_idx').on(table.status),
]);

// ─── Notifications ───

export const notifications = pgTable('notifications', {
  id: varchar('id', { length: 36 }).primaryKey(),
  userId: varchar('user_id', { length: 36 }).notNull(),
  type: notificationTypeEnum().notNull().default('info'),
  title: varchar('title', { length: 255 }).notNull(),
  message: text('message').notNull(),
  resourceType: varchar('resource_type', { length: 50 }),
  resourceId: varchar('resource_id', { length: 36 }),
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
  sshPath: varchar('ssh_path', { length: 500 }),
  s3Endpoint: varchar('s3_endpoint', { length: 500 }),
  s3Bucket: varchar('s3_bucket', { length: 255 }),
  s3Region: varchar('s3_region', { length: 50 }),
  s3AccessKeyEncrypted: varchar('s3_access_key_encrypted', { length: 500 }),
  s3SecretKeyEncrypted: varchar('s3_secret_key_encrypted', { length: 500 }),
  s3Prefix: varchar('s3_prefix', { length: 255 }),
  retentionDays: integer('retention_days').notNull().default(30),
  scheduleExpression: varchar('schedule_expression', { length: 100 }).default('0 2 * * *'),
  enabled: integer('enabled').notNull().default(1),
  // Exactly one row per cluster may have active=true. A partial unique
  // index (`WHERE active=true`) in migration 0045 enforces that. The
  // Longhorn reconciler syncs the active row to BackupTarget/default.
  active: boolean('active').notNull().default(false),
  lastTestedAt: timestamp('last_tested_at'),
  lastTestStatus: varchar('last_test_status', { length: 50 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

// ─── Backup & Metrics Tables ───

export const backups = pgTable('backups', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 })
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
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
  index('backups_client_idx').on(table.clientId),
  index('backups_status_idx').on(table.status),
]);

export const usageMetrics = pgTable('usage_metrics', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 })
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  metricType: metricTypeEnum().notNull(),
  deploymentId: varchar('deployment_id', { length: 36 }),
  value: numeric('value', { precision: 10, scale: 4 }).notNull(),
  measurementTimestamp: timestamp('measurement_timestamp').notNull().defaultNow(),
}, (table) => [
  index('usage_metrics_client_idx').on(table.clientId),
  index('usage_metrics_type_idx').on(table.metricType),
  index('usage_metrics_ts_idx').on(table.measurementTimestamp),
]);


// ─── Cron Jobs & Audit Tables ───

export const cronJobs = pgTable('cron_jobs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 })
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
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
  index('cron_jobs_client_idx').on(table.clientId),
]);

export const auditLogs = pgTable('audit_logs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 }),
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
  index('audit_logs_client_idx').on(table.clientId),
  index('audit_logs_actor_idx').on(table.actorId),
  index('audit_logs_action_idx').on(table.actionType),
  index('audit_logs_created_idx').on(table.createdAt),
]);

// ─── Provisioning Tasks ───

export const provisioningTasks = pgTable('provisioning_tasks', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 })
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
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
  index('provisioning_tasks_client_idx').on(table.clientId),
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
  deploymentId: varchar('deployment_id', { length: 36 }),
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
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('ingress_routes_hostname_path_domain_unique').on(table.hostname, table.path, table.domainId),
  index('ingress_routes_domain_idx').on(table.domainId),
  index('ingress_routes_deployment_idx').on(table.deploymentId),
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
  clientId: varchar('client_id', { length: 36 })
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
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
  index('waf_logs_client_idx').on(table.clientId),
  index('waf_logs_created_idx').on(table.createdAt),
]);

// ─── SSH Keys ───

export const sshKeys = pgTable('ssh_keys', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 })
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  name: varchar('name', { length: 255 }).notNull(),
  publicKey: text('public_key').notNull(),
  keyFingerprint: varchar('key_fingerprint', { length: 255 }).notNull(),
  keyAlgorithm: varchar('key_algorithm', { length: 50 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('ssh_keys_fingerprint_unique').on(table.keyFingerprint),
  uniqueIndex('ssh_keys_client_name_unique').on(table.clientId, table.name),
  index('ssh_keys_client_idx').on(table.clientId),
]);

// ─── SFTP Users ───

export const sftpUsers = pgTable('sftp_users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 })
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
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
  index('sftp_users_client_idx').on(table.clientId),
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
  clientId: varchar('client_id', { length: 36 })
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  event: varchar('event', { length: 50 }).notNull(), // CONNECT, DISCONNECT, FAILED_AUTH
  sourceIp: varchar('source_ip', { length: 45 }).notNull(),
  protocol: varchar('protocol', { length: 10 }).notNull().default('sftp'), // sftp, scp, rsync, ftps
  sessionId: varchar('session_id', { length: 128 }),
  durationSeconds: integer('duration_seconds'),
  bytesTransferred: numeric('bytes_transferred', { precision: 18, scale: 0 }),
  errorMessage: varchar('error_message', { length: 512 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('sftp_audit_client_idx').on(table.clientId, table.createdAt),
  index('sftp_audit_user_idx').on(table.sftpUserId, table.createdAt),
  index('sftp_audit_created_idx').on(table.createdAt),
]);

// ─── Subscription Billing Cycles ───

export const subscriptionBillingCycles = pgTable('subscription_billing_cycles', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 })
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
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
  uniqueIndex('uk_client_cycle').on(table.clientId, table.billingCycleStart),
  index('billing_cycles_client_idx').on(table.clientId),
  index('billing_cycles_status_idx').on(table.status),
]);

// ─── Resource Quotas ───

export const resourceQuotas = pgTable('resource_quotas', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 })
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
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
  uniqueIndex('resource_quotas_client_unique').on(table.clientId),
]);

// ─── Email System ───

export const emailDomains = pgTable('email_domains', {
  id: varchar('id', { length: 36 }).primaryKey(),
  // Migration 0020 — FK + CASCADE from domains so email config is
  // removed atomically when its parent domain is deleted.
  domainId: varchar('domain_id', { length: 36 })
    .notNull()
    .references(() => domains.id, { onDelete: 'cascade' }),
  clientId: varchar('client_id', { length: 36 })
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  enabled: integer('enabled').notNull().default(1),
  // Phase 2c: when true, the backend creates an Ingress for
  // webmail.<domain> in the client's namespace pointing at the shared
  // Roundcube Service via an ExternalName service (roundcube.mail).
  // Default true — every email domain gets webmail access out of the
  // box; operators or client_admins can toggle it off per domain.
  webmailEnabled: integer('webmail_enabled').notNull().default(1),
  // Round-4 Phase 2 — webmail provisioning lifecycle status.
  // Values: 'pending' | 'ready' | 'ready_no_tls' | 'failed'.
  // See migration 0021 for the rationale.
  webmailStatus: varchar('webmail_status', { length: 16 }).notNull().default('pending'),
  webmailStatusMessage: text('webmail_status_message'),
  webmailStatusUpdatedAt: timestamp('webmail_status_updated_at'),
  dkimSelector: varchar('dkim_selector', { length: 63 }).notNull().default('default'),
  dkimPrivateKeyEncrypted: text('dkim_private_key_encrypted'),
  dkimPublicKey: text('dkim_public_key'),
  // NOTE: max_mailboxes + max_quota_mb were removed in migration
  // 0019. Mailbox count is now capped at the plan level via
  // hosting_plans.max_mailboxes + clients.max_mailboxes_override.
  catchAllAddress: varchar('catch_all_address', { length: 255 }),
  mxProvisioned: integer('mx_provisioned').notNull().default(0),
  spfProvisioned: integer('spf_provisioned').notNull().default(0),
  dkimProvisioned: integer('dkim_provisioned').notNull().default(0),
  dmarcProvisioned: integer('dmarc_provisioned').notNull().default(0),
  spamThresholdJunk: numeric('spam_threshold_junk', { precision: 4, scale: 1 }).notNull().default('5.0'),
  spamThresholdReject: numeric('spam_threshold_reject', { precision: 4, scale: 1 }).notNull().default('10.0'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('email_domains_domain_unique').on(table.domainId),
  index('email_domains_client_idx').on(table.clientId),
]);

export const mailboxes = pgTable('mailboxes', {
  id: varchar('id', { length: 36 }).primaryKey(),
  // Migration 0020 — CASCADE from email_domains and clients so
  // mailboxes disappear atomically with their parent.
  emailDomainId: varchar('email_domain_id', { length: 36 })
    .notNull()
    .references(() => emailDomains.id, { onDelete: 'cascade' }),
  clientId: varchar('client_id', { length: 36 })
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
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
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('mailboxes_address_unique').on(table.fullAddress),
  index('mailboxes_client_idx').on(table.clientId),
  index('mailboxes_domain_idx').on(table.emailDomainId),
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
  // Migration 0020 — CASCADE from email_domains and clients.
  emailDomainId: varchar('email_domain_id', { length: 36 })
    .notNull()
    .references(() => emailDomains.id, { onDelete: 'cascade' }),
  clientId: varchar('client_id', { length: 36 })
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  sourceAddress: varchar('source_address', { length: 255 }).notNull(),
  destinationAddresses: jsonb('destination_addresses').$type<string[]>().notNull(),
  enabled: integer('enabled').notNull().default(1),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('email_aliases_source_unique').on(table.sourceAddress),
  index('email_aliases_client_idx').on(table.clientId),
  index('email_aliases_domain_idx').on(table.emailDomainId),
]);

// Phase 2b shipped a per-client custom webmail_domains table + CRUD. Phase
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
  clientId: varchar('client_id', { length: 36 })
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
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
  index('imap_sync_jobs_client_idx').on(table.clientId),
  index('imap_sync_jobs_mailbox_idx').on(table.mailboxId),
]);

// Phase 3 T5.1 — per-client SMTP submission credentials used by
// sendmail-compatible wrappers in workload pods. Stored twice:
// encrypted (for writing to the customer PVC) + bcrypt hash (for
// Stalwart to verify via the directory view).
export const mailSubmitCredentials = pgTable('mail_submit_credentials', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 })
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
  username: varchar('username', { length: 128 }).notNull(),
  passwordEncrypted: text('password_encrypted').notNull(),
  passwordHash: text('password_hash').notNull(),
  note: varchar('note', { length: 255 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  revokedAt: timestamp('revoked_at'),
  lastUsedAt: timestamp('last_used_at'),
}, (table) => [
  index('mail_submit_credentials_client_idx').on(table.clientId),
]);

export const emailDkimKeys = pgTable('email_dkim_keys', {
  id: varchar('id', { length: 36 }).primaryKey(),
  emailDomainId: varchar('email_domain_id', { length: 36 })
    .notNull()
    .references(() => emailDomains.id, { onDelete: 'cascade' }),
  selector: varchar('selector', { length: 63 }).notNull(),
  privateKeyEncrypted: text('private_key_encrypted').notNull(),
  publicKey: text('public_key').notNull(),
  status: varchar('status', { length: 16 }).notNull().default('pending'),
  dnsVerifiedAt: timestamp('dns_verified_at'),
  activatedAt: timestamp('activated_at'),
  retiredAt: timestamp('retired_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('email_dkim_keys_domain_idx').on(table.emailDomainId),
  index('email_dkim_keys_status_idx').on(table.status),
  uniqueIndex('email_dkim_keys_domain_selector_unique').on(table.emailDomainId, table.selector),
]);

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
  clientId: varchar('client_id', { length: 36 })
    .notNull()
    .references(() => clients.id, { onDelete: 'cascade' }),
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
  index('ssl_certs_client_idx').on(table.clientId),
]);

// ─── Platform Settings ───

export const platformSettings = pgTable('platform_settings', {
  key: varchar('setting_key', { length: 100 }).primaryKey(),
  value: text('setting_value').notNull(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

// M13: platform-level storage replication policy. Controls the Longhorn
// replica count for the platform's own StatefulSets (postgres,
// stalwart-mail) — distinct from client_storage_tier (M7) which only
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

// Type exports
export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Client = typeof clients.$inferSelect;
export type NewClient = typeof clients.$inferInsert;
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
export type EmailDkimKey = typeof emailDkimKeys.$inferSelect;
export type NewEmailDkimKey = typeof emailDkimKeys.$inferInsert;
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
  clientPanelUrl: varchar('client_panel_url', { length: 500 }),
  supportEmail: varchar('support_email', { length: 255 }),
  supportUrl: varchar('support_url', { length: 500 }),
  ingressBaseDomain: varchar('ingress_base_domain', { length: 255 }),
  mailHostname: varchar('mail_hostname', { length: 255 }),
  webmailUrl: varchar('webmail_url', { length: 500 }),
  apiRateLimit: integer('api_rate_limit').notNull().default(100),
  currencySymbol: varchar('currency_symbol', { length: 5 }).notNull().default('$'),
  timezone: varchar('timezone', { length: 50 }).notNull().default('UTC'),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

export type SystemSettings = typeof systemSettings.$inferSelect;

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
  clientId: varchar('client_id', { length: 36 }).notNull().references(() => clients.id, { onDelete: 'cascade' }),
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
  clientId: varchar('client_id', { length: 36 }).notNull().references(() => clients.id, { onDelete: 'cascade' }),
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
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('storage_snapshots_client_idx').on(table.clientId),
  index('storage_snapshots_status_idx').on(table.status),
  index('storage_snapshots_expires_idx').on(table.expiresAt),
]);

/**
 * An in-flight or completed lifecycle operation. The state machine is:
 *   pending → (op-specific states) → done | failed
 * All concurrent callers must check `clients.activeStorageOpId IS NULL`
 * before starting a new op (enforced by the orchestrator, not the DB).
 */
export const storageOperations = pgTable('storage_operations', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 }).notNull().references(() => clients.id, { onDelete: 'cascade' }),
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
  createdAt: timestamp('created_at').notNull().defaultNow(),
  completedAt: timestamp('completed_at'),
}, (table) => [
  index('storage_operations_client_idx').on(table.clientId),
  index('storage_operations_state_idx').on(table.state),
  index('storage_operations_created_idx').on(table.createdAt),
]);

// ─── M1 Node-role Taxonomy (migration 0046) ───
//
// Backend mirror of k8s node inventory with platform-specific role +
// config annotations. Source of truth for platform-managed fields (role,
// canHostClientWorkloads); k8s labels are the source of truth for
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
  canHostClientWorkloads: boolean('can_host_client_workloads').notNull().default(true),
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
