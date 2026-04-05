import {
  pgTable,
  pgEnum,
  varchar,
  text,
  integer,
  numeric,
  timestamp,
  jsonb,
  uniqueIndex,
  index,
} from 'drizzle-orm/pg-core';

// ─── Enums ───

export const panelEnum = pgEnum('panel', ['admin', 'client']);
export const userStatusEnum = pgEnum('user_status', ['active', 'disabled', 'pending']);
export const regionStatusEnum = pgEnum('region_status', ['active', 'maintenance', 'offline']);
export const planStatusEnum = pgEnum('plan_status', ['active', 'deprecated']);
export const clientStatusEnum = pgEnum('client_status', ['active', 'suspended', 'cancelled', 'pending']);
export const provisioningStatusEnum = pgEnum('provisioning_status', ['unprovisioned', 'provisioning', 'provisioned', 'failed']);
export const domainStatusEnum = pgEnum('domain_status', ['active', 'pending', 'suspended', 'deleted']);
export const dnsModeEnum = pgEnum('dns_mode', ['primary', 'cname', 'secondary']);
export const dnsProviderTypeEnum = pgEnum('dns_provider_type', ['powerdns', 'rndc', 'cloudflare', 'route53', 'hetzner', 'mock']);
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

// ─── Admin & Shared Tables ───

export const users = pgTable('users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  passwordHash: varchar('password_hash', { length: 255 }),
  fullName: varchar('full_name', { length: 255 }).notNull(),
  roleName: varchar('role_name', { length: 50 }).notNull().default('read_only'),
  panel: panelEnum().notNull().default('admin'),
  clientId: varchar('client_id', { length: 36 }),
  status: userStatusEnum().notNull().default('pending'),
  emailVerifiedAt: timestamp('email_verified_at'),
  lastLoginAt: timestamp('last_login_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  oidcSubject: varchar('oidc_subject', { length: 255 }),
  oidcIssuer: varchar('oidc_issuer', { length: 500 }),
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
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

export const oidcGlobalSettings = pgTable('oidc_global_settings', {
  id: varchar('id', { length: 36 }).primaryKey(),
  disableLocalAuthAdmin: integer('disable_local_auth_admin').notNull().default(0),
  disableLocalAuthClient: integer('disable_local_auth_client').notNull().default(0),
  breakGlassSecretHash: varchar('break_glass_secret_hash', { length: 255 }),
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
  provisioningStatus: provisioningStatusEnum().notNull().default('unprovisioned'),
  createdBy: varchar('created_by', { length: 36 }),
  subscriptionExpiresAt: timestamp('subscription_expires_at'),
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
  clientId: varchar('client_id', { length: 36 }).notNull(),
  domainName: varchar('domain_name', { length: 255 }).notNull(),
  deploymentId: varchar('deployment_id', { length: 36 }),
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

// ─── DNS Servers (External Providers) ───

export const dnsServers = pgTable('dns_servers', {
  id: varchar('id', { length: 36 }).primaryKey(),
  displayName: varchar('display_name', { length: 255 }).notNull(),
  providerType: dnsProviderTypeEnum().notNull(),
  connectionConfigEncrypted: varchar('connection_config_encrypted', { length: 2000 }).notNull(),
  zoneDefaultKind: zoneDefaultKindEnum().notNull().default('Native'),
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
  components: jsonb('components').$type<Array<{ name: string; type: string; image: string; ports?: Array<{ port: number; protocol: string; ingress?: boolean }>; optional?: boolean; schedule?: string }> | null>(),
  networking: jsonb('networking').$type<{ ingress_ports: Array<{ port: number; protocol: string; tls: boolean; description?: string }>; host_ports?: Array<{ port: number; protocol: string; component: string; description: string }>; websocket?: boolean } | null>(),
  volumes: jsonb('volumes').$type<Array<{ local_path: string; container_path: string; description?: string; optional?: boolean }> | null>(),
  resources: jsonb('resources').$type<{ recommended: { cpu: string; memory: string; storage?: string }; minimum: { cpu: string; memory: string; storage?: string } } | null>(),
  healthCheck: jsonb('health_check').$type<{ path?: string | null; command?: string[] | null; port?: number | null; initial_delay_seconds: number; period_seconds: number } | null>(),
  parameters: jsonb('parameters').$type<Array<{ key: string; label: string; type: string; default?: unknown; required?: boolean; description?: string }> | null>(),
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
  clientId: varchar('client_id', { length: 36 }).notNull(),
  catalogEntryId: varchar('catalog_entry_id', { length: 36 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  domainName: varchar('domain_name', { length: 255 }),
  replicaCount: integer('replica_count').notNull().default(1),
  cpuRequest: varchar('cpu_request', { length: 20 }).notNull().default('0.25'),
  memoryRequest: varchar('memory_request', { length: 20 }).notNull().default('256Mi'),
  configuration: jsonb('configuration').$type<Record<string, unknown> | null>(),
  resourceSuffix: varchar('resource_suffix', { length: 8 }).notNull().default(''),
  helmReleaseName: varchar('helm_release_name', { length: 255 }),
  installedVersion: varchar('installed_version', { length: 50 }),
  targetVersion: varchar('target_version', { length: 50 }),
  lastUpgradedAt: timestamp('last_upgraded_at'),
  lastError: text('last_error'),
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
  lastTestedAt: timestamp('last_tested_at'),
  lastTestStatus: varchar('last_test_status', { length: 50 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
});

// ─── Backup & Metrics Tables ───

export const backups = pgTable('backups', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 }).notNull(),
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
  clientId: varchar('client_id', { length: 36 }).notNull(),
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
  clientId: varchar('client_id', { length: 36 }).notNull(),
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
  clientId: varchar('client_id', { length: 36 }).notNull(),
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
  domainId: varchar('domain_id', { length: 36 }).notNull(),
  recordType: dnsRecordTypeEnum().notNull(),
  recordName: varchar('record_name', { length: 253 }),
  recordValue: varchar('record_value', { length: 1000 }),
  ttl: integer('ttl').notNull().default(3600),
  priority: integer('priority'),
  weight: integer('weight'),
  port: integer('port'),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  index('dns_records_domain_idx').on(table.domainId),
  index('dns_records_type_idx').on(table.recordType),
]);

// ─── Ingress Routes ───

export const ingressRoutes = pgTable('ingress_routes', {
  id: varchar('id', { length: 36 }).primaryKey(),
  domainId: varchar('domain_id', { length: 36 }).notNull(),
  hostname: varchar('hostname', { length: 255 }).notNull(),
  deploymentId: varchar('deployment_id', { length: 36 }),
  ingressCname: varchar('ingress_cname', { length: 255 }).notNull(),
  nodeHostname: varchar('node_hostname', { length: 255 }),
  isApex: integer('is_apex').notNull().default(0),
  tlsMode: tlsModeEnum().notNull().default('auto'),
  status: ingressStatusEnum().notNull().default('pending'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('ingress_routes_hostname_unique').on(table.hostname),
  index('ingress_routes_domain_idx').on(table.domainId),
  index('ingress_routes_deployment_idx').on(table.deploymentId),
]);

export type IngressRoute = typeof ingressRoutes.$inferSelect;

// ─── SSH Keys ───

export const sshKeys = pgTable('ssh_keys', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 }).notNull(),
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

// ─── Subscription Billing Cycles ───

export const subscriptionBillingCycles = pgTable('subscription_billing_cycles', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 }).notNull(),
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
  clientId: varchar('client_id', { length: 36 }).notNull(),
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
  updatedAt: timestamp('updated_at').notNull().defaultNow().$onUpdate(() => new Date()),
}, (table) => [
  uniqueIndex('resource_quotas_client_unique').on(table.clientId),
]);

// ─── Email System ───

export const emailDomains = pgTable('email_domains', {
  id: varchar('id', { length: 36 }).primaryKey(),
  domainId: varchar('domain_id', { length: 36 }).notNull(),
  clientId: varchar('client_id', { length: 36 }).notNull(),
  enabled: integer('enabled').notNull().default(1),
  dkimSelector: varchar('dkim_selector', { length: 63 }).notNull().default('default'),
  dkimPrivateKeyEncrypted: text('dkim_private_key_encrypted'),
  dkimPublicKey: text('dkim_public_key'),
  maxMailboxes: integer('max_mailboxes').notNull().default(50),
  maxQuotaMb: integer('max_quota_mb').notNull().default(10240),
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
  emailDomainId: varchar('email_domain_id', { length: 36 }).notNull(),
  clientId: varchar('client_id', { length: 36 }).notNull(),
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
  mailboxId: varchar('mailbox_id', { length: 36 }).notNull(),
  accessLevel: accessLevelEnum().notNull().default('full'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('mailbox_access_unique').on(table.userId, table.mailboxId),
  index('mailbox_access_user_idx').on(table.userId),
  index('mailbox_access_mailbox_idx').on(table.mailboxId),
]);

export const emailAliases = pgTable('email_aliases', {
  id: varchar('id', { length: 36 }).primaryKey(),
  emailDomainId: varchar('email_domain_id', { length: 36 }).notNull(),
  clientId: varchar('client_id', { length: 36 }).notNull(),
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
  clientId: varchar('client_id', { length: 36 }).notNull(),
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
