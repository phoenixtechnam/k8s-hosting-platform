CREATE TYPE "public"."access_level" AS ENUM('full', 'read_only');--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('user', 'system', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."backup_status" AS ENUM('pending', 'in_progress', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."backup_type" AS ENUM('auto', 'manual', 'scheduled');--> statement-breakpoint
CREATE TYPE "public"."billing_status" AS ENUM('draft', 'invoiced', 'paid', 'failed');--> statement-breakpoint
CREATE TYPE "public"."catalog_entry_status" AS ENUM('available', 'beta', 'deprecated');--> statement-breakpoint
CREATE TYPE "public"."catalog_entry_type" AS ENUM('application', 'runtime', 'database', 'service', 'static');--> statement-breakpoint
CREATE TYPE "public"."catalog_repo_status" AS ENUM('active', 'error', 'syncing');--> statement-breakpoint
CREATE TYPE "public"."catalog_version_status" AS ENUM('available', 'deprecated', 'eol');--> statement-breakpoint
CREATE TYPE "public"."client_status" AS ENUM('active', 'suspended', 'cancelled', 'pending');--> statement-breakpoint
CREATE TYPE "public"."cron_job_type" AS ENUM('webcron', 'deployment');--> statement-breakpoint
CREATE TYPE "public"."deployment_status" AS ENUM('deploying', 'running', 'stopped', 'failed', 'deleting', 'upgrading', 'pending', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."dns_mode" AS ENUM('primary', 'cname', 'secondary');--> statement-breakpoint
CREATE TYPE "public"."dns_provider_type" AS ENUM('powerdns', 'rndc', 'cloudflare', 'route53', 'hetzner', 'mock');--> statement-breakpoint
CREATE TYPE "public"."dns_record_type" AS ENUM('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS');--> statement-breakpoint
CREATE TYPE "public"."domain_status" AS ENUM('active', 'pending', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."http_method" AS ENUM('GET', 'POST', 'PUT');--> statement-breakpoint
CREATE TYPE "public"."ingress_status" AS ENUM('active', 'pending', 'error');--> statement-breakpoint
CREATE TYPE "public"."last_run_status" AS ENUM('success', 'failed', 'running');--> statement-breakpoint
CREATE TYPE "public"."mailbox_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."mailbox_type" AS ENUM('mailbox', 'forward_only');--> statement-breakpoint
CREATE TYPE "public"."metric_type" AS ENUM('cpu_cores', 'memory_gb', 'storage_gb', 'bandwidth_gb');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('info', 'warning', 'error', 'success');--> statement-breakpoint
CREATE TYPE "public"."panel" AS ENUM('admin', 'client');--> statement-breakpoint
CREATE TYPE "public"."panel_scope" AS ENUM('admin', 'client');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('active', 'deprecated');--> statement-breakpoint
CREATE TYPE "public"."prov_task_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."prov_task_type" AS ENUM('provision_namespace', 'deploy_workload', 'deprovision');--> statement-breakpoint
CREATE TYPE "public"."provisioning_status" AS ENUM('unprovisioned', 'provisioning', 'provisioned', 'failed');--> statement-breakpoint
CREATE TYPE "public"."region_status" AS ENUM('active', 'maintenance', 'offline');--> statement-breakpoint
CREATE TYPE "public"."scope_type" AS ENUM('global', 'region', 'client');--> statement-breakpoint
CREATE TYPE "public"."smtp_provider_type" AS ENUM('direct', 'mailgun', 'postmark');--> statement-breakpoint
CREATE TYPE "public"."storage_type" AS ENUM('ssh', 's3');--> statement-breakpoint
CREATE TYPE "public"."tls_mode" AS ENUM('auto', 'custom', 'none');--> statement-breakpoint
CREATE TYPE "public"."trigger_type" AS ENUM('manual', 'batch', 'forced');--> statement-breakpoint
CREATE TYPE "public"."upgrade_status" AS ENUM('pending', 'backing_up', 'pre_check', 'upgrading', 'health_check', 'rolling_back', 'completed', 'failed', 'rolled_back');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled', 'pending');--> statement-breakpoint
CREATE TYPE "public"."zone_default_kind" AS ENUM('Native', 'Master');--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client_id" varchar(36),
	"action_type" varchar(50) NOT NULL,
	"resource_type" varchar(50) NOT NULL,
	"resource_id" varchar(36),
	"actor_id" varchar(36) NOT NULL,
	"actorType" "actor_type" DEFAULT 'user' NOT NULL,
	"http_method" varchar(10),
	"http_path" varchar(500),
	"http_status" integer,
	"changes" jsonb,
	"ip_address" varchar(45),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_configurations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"storageType" "storage_type" NOT NULL,
	"ssh_host" varchar(255),
	"ssh_port" integer DEFAULT 22,
	"ssh_user" varchar(100),
	"ssh_key_encrypted" text,
	"ssh_path" varchar(500),
	"s3_endpoint" varchar(500),
	"s3_bucket" varchar(255),
	"s3_region" varchar(50),
	"s3_access_key_encrypted" varchar(500),
	"s3_secret_key_encrypted" varchar(500),
	"s3_prefix" varchar(255),
	"retention_days" integer DEFAULT 30 NOT NULL,
	"schedule_expression" varchar(100) DEFAULT '0 2 * * *',
	"enabled" integer DEFAULT 1 NOT NULL,
	"last_tested_at" timestamp,
	"last_test_status" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client_id" varchar(36) NOT NULL,
	"backupType" "backup_type" DEFAULT 'manual' NOT NULL,
	"resource_type" varchar(50) DEFAULT 'full' NOT NULL,
	"resource_id" varchar(36),
	"storage_path" varchar(500),
	"size_bytes" integer,
	"status" "backup_status" DEFAULT 'pending' NOT NULL,
	"completed_at" timestamp,
	"expires_at" timestamp,
	"notes" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_entries" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"code" varchar(100) NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" "catalog_entry_type" NOT NULL,
	"version" varchar(50),
	"latest_version" varchar(50),
	"default_version" varchar(50),
	"description" text,
	"url" varchar(500),
	"documentation" varchar(500),
	"category" varchar(50),
	"min_plan" varchar(50),
	"tenancy" jsonb,
	"components" jsonb,
	"networking" jsonb,
	"volumes" jsonb,
	"resources" jsonb,
	"health_check" jsonb,
	"parameters" jsonb,
	"tags" jsonb,
	"runtime" varchar(50),
	"web_server" varchar(50),
	"image" varchar(500),
	"has_dockerfile" integer DEFAULT 0 NOT NULL,
	"deployment_strategy" varchar(20),
	"services" jsonb,
	"provides" jsonb,
	"env_vars" jsonb,
	"status" "catalog_entry_status" DEFAULT 'available' NOT NULL,
	"featured" integer DEFAULT 0 NOT NULL,
	"popular" integer DEFAULT 0 NOT NULL,
	"source_repo_id" varchar(36),
	"manifest_url" varchar(500),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_entry_versions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"catalog_entry_id" varchar(36) NOT NULL,
	"version" varchar(50) NOT NULL,
	"is_default" integer DEFAULT 0 NOT NULL,
	"eol_date" varchar(10),
	"components" jsonb,
	"upgrade_from" jsonb,
	"breaking_changes" text,
	"env_changes" jsonb,
	"migration_notes" text,
	"min_resources" jsonb,
	"status" "catalog_version_status" DEFAULT 'available' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "catalog_repositories" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"url" varchar(500) NOT NULL,
	"branch" varchar(100) DEFAULT 'main' NOT NULL,
	"auth_token" varchar(500),
	"sync_interval_minutes" integer DEFAULT 60 NOT NULL,
	"last_synced_at" timestamp,
	"status" "catalog_repo_status" DEFAULT 'active' NOT NULL,
	"last_error" text,
	"local_cache_path" varchar(500),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clients" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"region_id" varchar(36) NOT NULL,
	"company_name" varchar(255) NOT NULL,
	"company_email" varchar(255) NOT NULL,
	"contact_email" varchar(255),
	"status" "client_status" DEFAULT 'pending' NOT NULL,
	"kubernetes_namespace" varchar(63) NOT NULL,
	"plan_id" varchar(36) NOT NULL,
	"cpu_limit_override" numeric(5, 2),
	"memory_limit_override" numeric(5, 2),
	"storage_limit_override" numeric(10, 2),
	"max_sub_users_override" integer,
	"monthly_price_override" numeric(10, 2),
	"provisioningStatus" "provisioning_status" DEFAULT 'unprovisioned' NOT NULL,
	"created_by" varchar(36),
	"subscription_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cron_jobs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client_id" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"type" "cron_job_type" DEFAULT 'webcron' NOT NULL,
	"schedule" varchar(100) NOT NULL,
	"command" text,
	"url" varchar(2000),
	"httpMethod" "http_method" DEFAULT 'GET',
	"deployment_id" varchar(36),
	"enabled" integer DEFAULT 1 NOT NULL,
	"last_run_at" timestamp,
	"lastRunStatus" "last_run_status",
	"last_run_duration_ms" integer,
	"last_run_response_code" integer,
	"last_run_output" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployment_upgrades" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"deployment_id" varchar(36) NOT NULL,
	"from_version" varchar(50) NOT NULL,
	"to_version" varchar(50) NOT NULL,
	"status" "upgrade_status" DEFAULT 'pending' NOT NULL,
	"triggered_by" varchar(36) NOT NULL,
	"triggerType" "trigger_type" DEFAULT 'manual' NOT NULL,
	"backup_id" varchar(36),
	"progress_pct" integer DEFAULT 0 NOT NULL,
	"status_message" text,
	"error_message" text,
	"helm_values" jsonb,
	"rollback_helm_values" jsonb,
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deployments" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client_id" varchar(36) NOT NULL,
	"catalog_entry_id" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"domain_name" varchar(255),
	"replica_count" integer DEFAULT 1 NOT NULL,
	"cpu_request" varchar(20) DEFAULT '0.25' NOT NULL,
	"memory_request" varchar(20) DEFAULT '256Mi' NOT NULL,
	"configuration" jsonb,
	"resource_suffix" varchar(8) DEFAULT '' NOT NULL,
	"helm_release_name" varchar(255),
	"installed_version" varchar(50),
	"target_version" varchar(50),
	"last_upgraded_at" timestamp,
	"last_error" text,
	"deleted_at" timestamp,
	"status" "deployment_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dns_records" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"domain_id" varchar(36) NOT NULL,
	"recordType" "dns_record_type" NOT NULL,
	"record_name" varchar(253),
	"record_value" varchar(1000),
	"ttl" integer DEFAULT 3600 NOT NULL,
	"priority" integer,
	"weight" integer,
	"port" integer,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dns_servers" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"providerType" "dns_provider_type" NOT NULL,
	"connection_config_encrypted" varchar(2000) NOT NULL,
	"zoneDefaultKind" "zone_default_kind" DEFAULT 'Native' NOT NULL,
	"is_default" integer DEFAULT 0 NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"last_health_check" timestamp,
	"last_health_status" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "domains" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client_id" varchar(36) NOT NULL,
	"domain_name" varchar(255) NOT NULL,
	"deployment_id" varchar(36),
	"status" "domain_status" DEFAULT 'pending' NOT NULL,
	"dnsMode" "dns_mode" DEFAULT 'cname' NOT NULL,
	"master_ip" varchar(45),
	"verified_at" timestamp,
	"last_verified_at" timestamp,
	"ssl_auto_renew" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_aliases" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"email_domain_id" varchar(36) NOT NULL,
	"client_id" varchar(36) NOT NULL,
	"source_address" varchar(255) NOT NULL,
	"destination_addresses" jsonb NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_domains" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"domain_id" varchar(36) NOT NULL,
	"client_id" varchar(36) NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"dkim_selector" varchar(63) DEFAULT 'default' NOT NULL,
	"dkim_private_key_encrypted" text,
	"dkim_public_key" text,
	"max_mailboxes" integer DEFAULT 50 NOT NULL,
	"max_quota_mb" integer DEFAULT 10240 NOT NULL,
	"catch_all_address" varchar(255),
	"mx_provisioned" integer DEFAULT 0 NOT NULL,
	"spf_provisioned" integer DEFAULT 0 NOT NULL,
	"dkim_provisioned" integer DEFAULT 0 NOT NULL,
	"dmarc_provisioned" integer DEFAULT 0 NOT NULL,
	"spam_threshold_junk" numeric(4, 1) DEFAULT '5.0' NOT NULL,
	"spam_threshold_reject" numeric(4, 1) DEFAULT '10.0' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosting_plans" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"code" varchar(50) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"cpu_limit" numeric(5, 2) NOT NULL,
	"memory_limit" numeric(5, 2) NOT NULL,
	"storage_limit" numeric(10, 2) NOT NULL,
	"monthly_price_usd" numeric(10, 2) NOT NULL,
	"max_sub_users" integer DEFAULT 3 NOT NULL,
	"features" jsonb,
	"status" "plan_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosting_settings" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"domain_id" varchar(36) NOT NULL,
	"redirect_www" integer DEFAULT 0 NOT NULL,
	"redirect_https" integer DEFAULT 1 NOT NULL,
	"forward_external" varchar(500),
	"webroot_path" varchar(500) DEFAULT '/var/www/html' NOT NULL,
	"hosting_enabled" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingress_routes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"domain_id" varchar(36) NOT NULL,
	"hostname" varchar(255) NOT NULL,
	"deployment_id" varchar(36),
	"ingress_cname" varchar(255) NOT NULL,
	"node_hostname" varchar(255),
	"is_apex" integer DEFAULT 0 NOT NULL,
	"tlsMode" "tls_mode" DEFAULT 'auto' NOT NULL,
	"status" "ingress_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailbox_access" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"mailbox_id" varchar(36) NOT NULL,
	"accessLevel" "access_level" DEFAULT 'full' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"email_domain_id" varchar(36) NOT NULL,
	"client_id" varchar(36) NOT NULL,
	"local_part" varchar(64) NOT NULL,
	"full_address" varchar(255) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"display_name" varchar(255),
	"quota_mb" integer DEFAULT 1024 NOT NULL,
	"used_mb" integer DEFAULT 0 NOT NULL,
	"status" "mailbox_status" DEFAULT 'active' NOT NULL,
	"mailboxType" "mailbox_type" DEFAULT 'mailbox' NOT NULL,
	"auto_reply" integer DEFAULT 0 NOT NULL,
	"auto_reply_subject" varchar(255),
	"auto_reply_body" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"type" "notification_type" DEFAULT 'info' NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"resource_type" varchar(50),
	"resource_id" varchar(36),
	"is_read" integer DEFAULT 0 NOT NULL,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_global_settings" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"disable_local_auth_admin" integer DEFAULT 0 NOT NULL,
	"disable_local_auth_client" integer DEFAULT 0 NOT NULL,
	"break_glass_secret_hash" varchar(255),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_providers" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"issuer_url" varchar(500) NOT NULL,
	"client_id" varchar(255) NOT NULL,
	"client_secret_encrypted" varchar(500) NOT NULL,
	"panelScope" "panel_scope" NOT NULL,
	"enabled" integer DEFAULT 0 NOT NULL,
	"backchannel_logout_enabled" integer DEFAULT 0 NOT NULL,
	"discovery_metadata" jsonb,
	"display_order" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"setting_key" varchar(100) PRIMARY KEY NOT NULL,
	"setting_value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protected_directories" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"domain_id" varchar(36) NOT NULL,
	"path" varchar(500) NOT NULL,
	"realm" varchar(255) DEFAULT 'Restricted Area' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "protected_directory_users" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"directory_id" varchar(36) NOT NULL,
	"username" varchar(255) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "provisioning_tasks" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client_id" varchar(36) NOT NULL,
	"type" "prov_task_type" NOT NULL,
	"status" "prov_task_status" DEFAULT 'pending' NOT NULL,
	"current_step" varchar(100),
	"total_steps" integer DEFAULT 0 NOT NULL,
	"completed_steps" integer DEFAULT 0 NOT NULL,
	"steps_log" jsonb,
	"error_message" text,
	"started_by" varchar(36),
	"started_at" timestamp,
	"completed_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "rbac_roles" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(50) NOT NULL,
	"description" text,
	"is_system_role" integer DEFAULT 0 NOT NULL,
	"permissions" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "regions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"code" varchar(50) NOT NULL,
	"name" varchar(255) NOT NULL,
	"provider" varchar(50) NOT NULL,
	"kubernetes_api_endpoint" varchar(500),
	"status" "region_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_quotas" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client_id" varchar(36) NOT NULL,
	"cpu_cores_limit" numeric(5, 2),
	"memory_gb_limit" integer,
	"storage_gb_limit" integer,
	"bandwidth_gb_limit" integer,
	"cpu_cores_current" numeric(5, 2) DEFAULT '0',
	"memory_gb_current" integer DEFAULT 0,
	"storage_gb_current" integer DEFAULT 0,
	"cpu_warning_threshold" numeric(5, 2) DEFAULT '80',
	"memory_warning_threshold" integer DEFAULT 80,
	"storage_warning_threshold" integer DEFAULT 80,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "smtp_relay_configs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"providerType" "smtp_provider_type" NOT NULL,
	"is_default" integer DEFAULT 0 NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"smtp_host" varchar(255),
	"smtp_port" integer DEFAULT 587,
	"auth_username" varchar(255),
	"auth_password_encrypted" varchar(500),
	"api_key_encrypted" varchar(500),
	"region" varchar(50),
	"last_tested_at" timestamp,
	"last_test_status" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ssh_keys" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client_id" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"public_key" text NOT NULL,
	"key_fingerprint" varchar(255) NOT NULL,
	"key_algorithm" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ssl_certificates" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"domain_id" varchar(36) NOT NULL,
	"client_id" varchar(36) NOT NULL,
	"certificate" text NOT NULL,
	"private_key_encrypted" text NOT NULL,
	"ca_bundle" text,
	"issuer" varchar(500),
	"subject" varchar(500),
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_billing_cycles" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client_id" varchar(36) NOT NULL,
	"billing_cycle_start" timestamp NOT NULL,
	"billing_cycle_end" timestamp NOT NULL,
	"plan_id" varchar(36) NOT NULL,
	"base_price_usd" numeric(10, 2),
	"overages_price_usd" numeric(10, 2) DEFAULT '0',
	"total_price_usd" numeric(10, 2) NOT NULL,
	"status" "billing_status" DEFAULT 'draft' NOT NULL,
	"external_billing_id" varchar(255),
	"invoice_number" varchar(50),
	"paid_at" timestamp,
	"invoiced_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_metrics" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"client_id" varchar(36) NOT NULL,
	"metricType" "metric_type" NOT NULL,
	"deployment_id" varchar(36),
	"value" numeric(10, 4) NOT NULL,
	"measurement_timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_roles" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"role_id" varchar(36) NOT NULL,
	"scopeType" "scope_type" DEFAULT 'global' NOT NULL,
	"scope_id" varchar(36),
	"assigned_by" varchar(36),
	"assigned_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"email" varchar(255) NOT NULL,
	"password_hash" varchar(255),
	"full_name" varchar(255) NOT NULL,
	"role_name" varchar(50) DEFAULT 'read_only' NOT NULL,
	"panel" "panel" DEFAULT 'admin' NOT NULL,
	"client_id" varchar(36),
	"status" "user_status" DEFAULT 'pending' NOT NULL,
	"email_verified_at" timestamp,
	"last_login_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"oidc_subject" varchar(255),
	"oidc_issuer" varchar(500),
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "audit_logs_client_idx" ON "audit_logs" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action_type");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "backups_client_idx" ON "backups" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "backups_status_idx" ON "backups" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_entries_code_repo_unique" ON "catalog_entries" USING btree ("code","source_repo_id");--> statement-breakpoint
CREATE INDEX "catalog_entries_type_idx" ON "catalog_entries" USING btree ("type");--> statement-breakpoint
CREATE INDEX "catalog_entries_status_idx" ON "catalog_entries" USING btree ("status");--> statement-breakpoint
CREATE INDEX "catalog_entries_category_idx" ON "catalog_entries" USING btree ("category");--> statement-breakpoint
CREATE INDEX "catalog_entries_source_repo_idx" ON "catalog_entries" USING btree ("source_repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_catalog_entry_version" ON "catalog_entry_versions" USING btree ("catalog_entry_id","version");--> statement-breakpoint
CREATE INDEX "idx_catalog_versions_entry" ON "catalog_entry_versions" USING btree ("catalog_entry_id");--> statement-breakpoint
CREATE INDEX "idx_catalog_versions_status" ON "catalog_entry_versions" USING btree ("catalog_entry_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "catalog_repos_url_unique" ON "catalog_repositories" USING btree ("url");--> statement-breakpoint
CREATE UNIQUE INDEX "clients_namespace_unique" ON "clients" USING btree ("kubernetes_namespace");--> statement-breakpoint
CREATE INDEX "clients_region_idx" ON "clients" USING btree ("region_id");--> statement-breakpoint
CREATE INDEX "clients_plan_idx" ON "clients" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "clients_status_idx" ON "clients" USING btree ("status");--> statement-breakpoint
CREATE INDEX "cron_jobs_client_idx" ON "cron_jobs" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "idx_deploy_upgrades_deployment" ON "deployment_upgrades" USING btree ("deployment_id","status");--> statement-breakpoint
CREATE INDEX "idx_deploy_upgrades_status" ON "deployment_upgrades" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_client_name_unique" ON "deployments" USING btree ("client_id","name");--> statement-breakpoint
CREATE INDEX "deployments_client_idx" ON "deployments" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "deployments_catalog_entry_idx" ON "deployments" USING btree ("catalog_entry_id");--> statement-breakpoint
CREATE INDEX "deployments_status_idx" ON "deployments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "dns_records_domain_idx" ON "dns_records" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "dns_records_type_idx" ON "dns_records" USING btree ("recordType");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_name_unique" ON "domains" USING btree ("domain_name");--> statement-breakpoint
CREATE INDEX "domains_client_idx" ON "domains" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "domains_status_idx" ON "domains" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "email_aliases_source_unique" ON "email_aliases" USING btree ("source_address");--> statement-breakpoint
CREATE INDEX "email_aliases_client_idx" ON "email_aliases" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "email_aliases_domain_idx" ON "email_aliases" USING btree ("email_domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_domains_domain_unique" ON "email_domains" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "email_domains_client_idx" ON "email_domains" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hosting_plans_code_unique" ON "hosting_plans" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "hosting_settings_domain_unique" ON "hosting_settings" USING btree ("domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ingress_routes_hostname_unique" ON "ingress_routes" USING btree ("hostname");--> statement-breakpoint
CREATE INDEX "ingress_routes_domain_idx" ON "ingress_routes" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "ingress_routes_deployment_idx" ON "ingress_routes" USING btree ("deployment_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_access_unique" ON "mailbox_access" USING btree ("user_id","mailbox_id");--> statement-breakpoint
CREATE INDEX "mailbox_access_user_idx" ON "mailbox_access" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mailbox_access_mailbox_idx" ON "mailbox_access" USING btree ("mailbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_address_unique" ON "mailboxes" USING btree ("full_address");--> statement-breakpoint
CREATE INDEX "mailboxes_client_idx" ON "mailboxes" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "mailboxes_domain_idx" ON "mailboxes" USING btree ("email_domain_id");--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_read_idx" ON "notifications" USING btree ("is_read");--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "protected_dirs_domain_idx" ON "protected_directories" USING btree ("domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "protected_dir_users_unique" ON "protected_directory_users" USING btree ("directory_id","username");--> statement-breakpoint
CREATE INDEX "protected_dir_users_dir_idx" ON "protected_directory_users" USING btree ("directory_id");--> statement-breakpoint
CREATE INDEX "provisioning_tasks_client_idx" ON "provisioning_tasks" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "provisioning_tasks_status_idx" ON "provisioning_tasks" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "rbac_roles_name_unique" ON "rbac_roles" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "regions_code_unique" ON "regions" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_quotas_client_unique" ON "resource_quotas" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_keys_fingerprint_unique" ON "ssh_keys" USING btree ("key_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_keys_client_name_unique" ON "ssh_keys" USING btree ("client_id","name");--> statement-breakpoint
CREATE INDEX "ssh_keys_client_idx" ON "ssh_keys" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ssl_certs_domain_unique" ON "ssl_certificates" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "ssl_certs_client_idx" ON "ssl_certificates" USING btree ("client_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_client_cycle" ON "subscription_billing_cycles" USING btree ("client_id","billing_cycle_start");--> statement-breakpoint
CREATE INDEX "billing_cycles_client_idx" ON "subscription_billing_cycles" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "billing_cycles_status_idx" ON "subscription_billing_cycles" USING btree ("status");--> statement-breakpoint
CREATE INDEX "usage_metrics_client_idx" ON "usage_metrics" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "usage_metrics_type_idx" ON "usage_metrics" USING btree ("metricType");--> statement-breakpoint
CREATE INDEX "usage_metrics_ts_idx" ON "usage_metrics" USING btree ("measurement_timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_user_role_scope" ON "user_roles" USING btree ("user_id","role_id","scopeType","scope_id");--> statement-breakpoint
CREATE INDEX "user_roles_user_idx" ON "user_roles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_roles_role_idx" ON "user_roles" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_oidc_unique" ON "users" USING btree ("oidc_issuer","oidc_subject");