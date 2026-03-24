import {
  mysqlTable,
  varchar,
  text,
  int,
  decimal,
  timestamp,
  json,
  mysqlEnum,
  uniqueIndex,
  index,
} from 'drizzle-orm/mysql-core';

// ─── Admin & Shared Tables ───

export const users = mysqlTable('users', {
  id: varchar('id', { length: 36 }).primaryKey(),
  email: varchar('email', { length: 255 }).notNull(),
  passwordHash: varchar('password_hash', { length: 255 }),
  fullName: varchar('full_name', { length: 255 }).notNull(),
  status: mysqlEnum('status', ['active', 'disabled', 'pending']).notNull().default('pending'),
  emailVerifiedAt: timestamp('email_verified_at'),
  lastLoginAt: timestamp('last_login_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
}, (table) => [
  uniqueIndex('users_email_unique').on(table.email),
]);

export const rbacRoles = mysqlTable('rbac_roles', {
  id: varchar('id', { length: 36 }).primaryKey(),
  name: varchar('name', { length: 50 }).notNull(),
  description: text('description'),
  isSystemRole: int('is_system_role').notNull().default(0),
  permissions: json('permissions').$type<string[]>(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('rbac_roles_name_unique').on(table.name),
]);

export const regions = mysqlTable('regions', {
  id: varchar('id', { length: 36 }).primaryKey(),
  code: varchar('code', { length: 50 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  provider: varchar('provider', { length: 50 }).notNull(),
  kubernetesApiEndpoint: varchar('kubernetes_api_endpoint', { length: 500 }),
  status: mysqlEnum('status', ['active', 'maintenance', 'offline']).notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('regions_code_unique').on(table.code),
]);

export const hostingPlans = mysqlTable('hosting_plans', {
  id: varchar('id', { length: 36 }).primaryKey(),
  code: varchar('code', { length: 50 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  description: text('description'),
  cpuLimit: decimal('cpu_limit', { precision: 5, scale: 2 }).notNull(),
  memoryLimit: decimal('memory_limit', { precision: 5, scale: 2 }).notNull(),
  storageLimit: decimal('storage_limit', { precision: 10, scale: 2 }).notNull(),
  monthlyPriceUsd: decimal('monthly_price_usd', { precision: 10, scale: 2 }).notNull(),
  features: json('features').$type<Record<string, unknown>>(),
  status: mysqlEnum('status', ['active', 'deprecated']).notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('hosting_plans_code_unique').on(table.code),
]);

// ─── Tenant Tables ───

export const clients = mysqlTable('clients', {
  id: varchar('id', { length: 36 }).primaryKey(),
  regionId: varchar('region_id', { length: 36 }).notNull(),
  companyName: varchar('company_name', { length: 255 }).notNull(),
  companyEmail: varchar('company_email', { length: 255 }).notNull(),
  contactEmail: varchar('contact_email', { length: 255 }),
  status: mysqlEnum('status', ['active', 'suspended', 'cancelled', 'pending']).notNull().default('pending'),
  kubernetesNamespace: varchar('kubernetes_namespace', { length: 63 }).notNull(),
  planId: varchar('plan_id', { length: 36 }).notNull(),
  createdBy: varchar('created_by', { length: 36 }),
  subscriptionExpiresAt: timestamp('subscription_expires_at'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
}, (table) => [
  uniqueIndex('clients_namespace_unique').on(table.kubernetesNamespace),
  index('clients_region_idx').on(table.regionId),
  index('clients_plan_idx').on(table.planId),
  index('clients_status_idx').on(table.status),
]);

export const domains = mysqlTable('domains', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 }).notNull(),
  domainName: varchar('domain_name', { length: 255 }).notNull(),
  workloadId: varchar('workload_id', { length: 36 }),
  status: mysqlEnum('status', ['active', 'pending', 'suspended', 'deleted']).notNull().default('pending'),
  dnsMode: mysqlEnum('dns_mode', ['primary', 'cname', 'secondary']).notNull().default('cname'),
  verifiedAt: timestamp('verified_at'),
  sslAutoRenew: int('ssl_auto_renew').notNull().default(1),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
}, (table) => [
  uniqueIndex('domains_name_unique').on(table.domainName),
  index('domains_client_idx').on(table.clientId),
  index('domains_status_idx').on(table.status),
]);

export const workloads = mysqlTable('workloads', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  containerImageId: varchar('container_image_id', { length: 36 }),
  replicaCount: int('replica_count').notNull().default(1),
  cpuRequest: varchar('cpu_request', { length: 20 }).notNull().default('100m'),
  memoryRequest: varchar('memory_request', { length: 20 }).notNull().default('128Mi'),
  status: mysqlEnum('status', ['running', 'stopped', 'pending', 'failed']).notNull().default('pending'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
}, (table) => [
  index('workloads_client_idx').on(table.clientId),
  index('workloads_status_idx').on(table.status),
]);

export const databases = mysqlTable('databases', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 }).notNull(),
  name: varchar('name', { length: 63 }).notNull(),
  databaseType: mysqlEnum('database_type', ['mysql', 'postgresql']).notNull().default('mysql'),
  username: varchar('username', { length: 63 }).notNull(),
  passwordHash: varchar('password_hash', { length: 255 }).notNull(),
  port: int('port').notNull().default(3306),
  status: mysqlEnum('status', ['active', 'creating', 'deleting', 'failed']).notNull().default('creating'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
}, (table) => [
  uniqueIndex('databases_name_unique').on(table.name),
  index('databases_client_idx').on(table.clientId),
]);

// ─── Backup & Metrics Tables ───

export const backups = mysqlTable('backups', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 }).notNull(),
  backupType: mysqlEnum('backup_type', ['auto', 'manual', 'scheduled']).notNull().default('manual'),
  resourceType: varchar('resource_type', { length: 50 }).notNull().default('full'),
  resourceId: varchar('resource_id', { length: 36 }),
  storagePath: varchar('storage_path', { length: 500 }),
  sizeBytes: int('size_bytes'),
  status: mysqlEnum('status', ['pending', 'in_progress', 'completed', 'failed']).notNull().default('pending'),
  completedAt: timestamp('completed_at'),
  expiresAt: timestamp('expires_at'),
  notes: text('notes'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('backups_client_idx').on(table.clientId),
  index('backups_status_idx').on(table.status),
]);

export const usageMetrics = mysqlTable('usage_metrics', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 }).notNull(),
  metricType: mysqlEnum('metric_type', ['cpu_cores', 'memory_gb', 'storage_gb', 'bandwidth_gb']).notNull(),
  workloadId: varchar('workload_id', { length: 36 }),
  value: decimal('value', { precision: 10, scale: 4 }).notNull(),
  measurementTimestamp: timestamp('measurement_timestamp').notNull().defaultNow(),
}, (table) => [
  index('usage_metrics_client_idx').on(table.clientId),
  index('usage_metrics_type_idx').on(table.metricType),
  index('usage_metrics_ts_idx').on(table.measurementTimestamp),
]);

export const containerImages = mysqlTable('container_images', {
  id: varchar('id', { length: 36 }).primaryKey(),
  code: varchar('code', { length: 50 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  imageType: varchar('image_type', { length: 50 }).notNull(),
  registryUrl: varchar('registry_url', { length: 500 }).notNull(),
  digest: varchar('digest', { length: 255 }),
  supportedVersions: json('supported_versions').$type<string[]>(),
  status: mysqlEnum('status', ['active', 'deprecated']).notNull().default('active'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  uniqueIndex('container_images_code_unique').on(table.code),
]);

// ─── Cron Jobs & Audit Tables ───

export const cronJobs = mysqlTable('cron_jobs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 }).notNull(),
  name: varchar('name', { length: 255 }).notNull(),
  schedule: varchar('schedule', { length: 100 }).notNull(),
  command: text('command').notNull(),
  enabled: int('enabled').notNull().default(1),
  lastRunAt: timestamp('last_run_at'),
  lastRunStatus: mysqlEnum('last_run_status', ['success', 'failed', 'running']),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow().onUpdateNow(),
}, (table) => [
  index('cron_jobs_client_idx').on(table.clientId),
]);

export const auditLogs = mysqlTable('audit_logs', {
  id: varchar('id', { length: 36 }).primaryKey(),
  clientId: varchar('client_id', { length: 36 }),
  actionType: varchar('action_type', { length: 50 }).notNull(),
  resourceType: varchar('resource_type', { length: 50 }).notNull(),
  resourceId: varchar('resource_id', { length: 36 }),
  actorId: varchar('actor_id', { length: 36 }).notNull(),
  actorType: mysqlEnum('actor_type', ['user', 'system', 'webhook']).notNull().default('user'),
  httpMethod: varchar('http_method', { length: 10 }),
  httpPath: varchar('http_path', { length: 500 }),
  httpStatus: int('http_status'),
  changes: json('changes').$type<Record<string, unknown>>(),
  ipAddress: varchar('ip_address', { length: 45 }),
  createdAt: timestamp('created_at').notNull().defaultNow(),
}, (table) => [
  index('audit_logs_client_idx').on(table.clientId),
  index('audit_logs_actor_idx').on(table.actorId),
  index('audit_logs_action_idx').on(table.actionType),
  index('audit_logs_created_idx').on(table.createdAt),
]);

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
export type ContainerImage = typeof containerImages.$inferSelect;
export type CronJob = typeof cronJobs.$inferSelect;
export type NewCronJob = typeof cronJobs.$inferInsert;
export type AuditLog = typeof auditLogs.$inferSelect;
