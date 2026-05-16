CREATE TYPE "public"."access_level" AS ENUM('full', 'read_only');--> statement-breakpoint
CREATE TYPE "public"."actor_type" AS ENUM('user', 'system', 'webhook');--> statement-breakpoint
CREATE TYPE "public"."backup_component_name" AS ENUM('files', 'mailboxes', 'config', 'secrets');--> statement-breakpoint
CREATE TYPE "public"."backup_component_status" AS ENUM('pending', 'running', 'completed', 'skipped', 'failed');--> statement-breakpoint
CREATE TYPE "public"."backup_initiator" AS ENUM('tenant', 'admin', 'system', 'cluster');--> statement-breakpoint
CREATE TYPE "public"."backup_job_status" AS ENUM('pending', 'running', 'completed', 'partial', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."backup_status" AS ENUM('pending', 'in_progress', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."backup_system_trigger" AS ENUM('pre_resize', 'pre_archive', 'scheduled', 'manual');--> statement-breakpoint
CREATE TYPE "public"."backup_target_kind" AS ENUM('hostpath', 's3', 'ssh');--> statement-breakpoint
CREATE TYPE "public"."backup_type" AS ENUM('auto', 'manual', 'scheduled');--> statement-breakpoint
CREATE TYPE "public"."billing_status" AS ENUM('draft', 'invoiced', 'paid', 'failed');--> statement-breakpoint
CREATE TYPE "public"."catalog_entry_status" AS ENUM('available', 'beta', 'deprecated');--> statement-breakpoint
CREATE TYPE "public"."catalog_entry_type" AS ENUM('application', 'runtime', 'database', 'service', 'static');--> statement-breakpoint
CREATE TYPE "public"."catalog_repo_status" AS ENUM('active', 'error', 'syncing');--> statement-breakpoint
CREATE TYPE "public"."catalog_version_status" AS ENUM('available', 'deprecated', 'eol');--> statement-breakpoint
CREATE TYPE "public"."cron_job_type" AS ENUM('webcron', 'deployment');--> statement-breakpoint
CREATE TYPE "public"."deployment_source" AS ENUM('catalog', 'custom');--> statement-breakpoint
CREATE TYPE "public"."deployment_status" AS ENUM('deploying', 'running', 'stopped', 'failed', 'deleting', 'upgrading', 'pending', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."dns_mode" AS ENUM('primary', 'cname', 'secondary');--> statement-breakpoint
CREATE TYPE "public"."dns_provider_type" AS ENUM('powerdns', 'rndc', 'cloudflare', 'route53', 'hetzner', 'cloudns', 'mock');--> statement-breakpoint
CREATE TYPE "public"."dns_record_type" AS ENUM('A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'NS', 'CAA', 'PTR', 'SOA', 'ALIAS', 'DNAME');--> statement-breakpoint
CREATE TYPE "public"."domain_status" AS ENUM('unverified', 'verified', 'active', 'pending', 'suspended', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."http_method" AS ENUM('GET', 'POST', 'PUT');--> statement-breakpoint
CREATE TYPE "public"."ingress_status" AS ENUM('active', 'pending', 'error');--> statement-breakpoint
CREATE TYPE "public"."ingress_target_type" AS ENUM('deployment', 'private_worker');--> statement-breakpoint
CREATE TYPE "public"."last_run_status" AS ENUM('success', 'failed', 'running');--> statement-breakpoint
CREATE TYPE "public"."mailbox_status" AS ENUM('active', 'disabled');--> statement-breakpoint
CREATE TYPE "public"."mailbox_type" AS ENUM('mailbox', 'forward_only');--> statement-breakpoint
CREATE TYPE "public"."metric_type" AS ENUM('cpu_cores', 'memory_gb', 'storage_gb', 'bandwidth_gb');--> statement-breakpoint
CREATE TYPE "public"."node_role" AS ENUM('server', 'worker');--> statement-breakpoint
CREATE TYPE "public"."notification_type" AS ENUM('info', 'warning', 'error', 'success');--> statement-breakpoint
CREATE TYPE "public"."panel" AS ENUM('admin', 'tenant');--> statement-breakpoint
CREATE TYPE "public"."panel_scope" AS ENUM('admin', 'tenant');--> statement-breakpoint
CREATE TYPE "public"."plan_status" AS ENUM('active', 'deprecated');--> statement-breakpoint
CREATE TYPE "public"."platform_storage_tier" AS ENUM('local', 'ha');--> statement-breakpoint
CREATE TYPE "public"."private_worker_status" AS ENUM('pending', 'active', 'revoked', 'suspended');--> statement-breakpoint
CREATE TYPE "public"."prov_task_status" AS ENUM('pending', 'running', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."prov_task_type" AS ENUM('provision_namespace', 'deploy_workload', 'deprovision');--> statement-breakpoint
CREATE TYPE "public"."provisioning_status" AS ENUM('unprovisioned', 'provisioning', 'provisioned', 'failed');--> statement-breakpoint
CREATE TYPE "public"."region_status" AS ENUM('active', 'maintenance', 'offline');--> statement-breakpoint
CREATE TYPE "public"."restore_item_status" AS ENUM('pending', 'applying', 'done', 'failed', 'skipped');--> statement-breakpoint
CREATE TYPE "public"."restore_item_type" AS ENUM('files-paths', 'mailboxes-by-address', 'deployments-by-id', 'domains-by-id', 'config-tables');--> statement-breakpoint
CREATE TYPE "public"."restore_job_status" AS ENUM('draft', 'executing', 'paused', 'done', 'failed');--> statement-breakpoint
CREATE TYPE "public"."scope_type" AS ENUM('global', 'region', 'tenant');--> statement-breakpoint
CREATE TYPE "public"."smtp_provider_type" AS ENUM('direct', 'mailgun', 'postmark');--> statement-breakpoint
CREATE TYPE "public"."storage_lifecycle_state" AS ENUM('idle', 'snapshotting', 'quiescing', 'resizing', 'replacing', 'restoring', 'unquiescing', 'archiving', 'failed');--> statement-breakpoint
CREATE TYPE "public"."storage_operation_type" AS ENUM('snapshot', 'resize', 'suspend', 'resume', 'archive', 'restore', 'fsck');--> statement-breakpoint
CREATE TYPE "public"."storage_snapshot_kind" AS ENUM('manual', 'pre-resize', 'pre-suspend', 'pre-archive', 'scheduled', 'pre-restore');--> statement-breakpoint
CREATE TYPE "public"."storage_snapshot_status" AS ENUM('creating', 'ready', 'expired', 'failed');--> statement-breakpoint
CREATE TYPE "public"."storage_type" AS ENUM('ssh', 's3');--> statement-breakpoint
CREATE TYPE "public"."tenant_backup_schedule_freq" AS ENUM('daily', 'weekly', 'monthly');--> statement-breakpoint
CREATE TYPE "public"."tenant_lifecycle_hook_run_state" AS ENUM('pending', 'running', 'ok', 'noop', 'failed');--> statement-breakpoint
CREATE TYPE "public"."tenant_lifecycle_transition_kind" AS ENUM('active', 'suspended', 'archived', 'restored', 'deleted');--> statement-breakpoint
CREATE TYPE "public"."tenant_lifecycle_transition_state" AS ENUM('running', 'completed', 'failed_partial', 'failed_blocking');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('active', 'suspended', 'archived', 'pending');--> statement-breakpoint
CREATE TYPE "public"."tenant_storage_tier" AS ENUM('local', 'ha');--> statement-breakpoint
CREATE TYPE "public"."tls_mode" AS ENUM('auto', 'custom', 'none');--> statement-breakpoint
CREATE TYPE "public"."trigger_type" AS ENUM('manual', 'batch', 'forced');--> statement-breakpoint
CREATE TYPE "public"."upgrade_status" AS ENUM('pending', 'backing_up', 'pre_check', 'upgrading', 'health_check', 'rolling_back', 'completed', 'failed', 'rolled_back');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('active', 'disabled', 'pending');--> statement-breakpoint
CREATE TYPE "public"."www_redirect" AS ENUM('none', 'add-www', 'remove-www');--> statement-breakpoint
CREATE TYPE "public"."zone_default_kind" AS ENUM('Native', 'Master');--> statement-breakpoint
CREATE TABLE "ai_models" (
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"provider_id" varchar(100) NOT NULL,
	"model_name" varchar(200) NOT NULL,
	"display_name" varchar(200) NOT NULL,
	"cost_per_1m_input_tokens" numeric(10, 4) DEFAULT '0',
	"cost_per_1m_output_tokens" numeric(10, 4) DEFAULT '0',
	"max_output_tokens" integer DEFAULT 4096 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"admin_only" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_providers" (
	"id" varchar(100) PRIMARY KEY NOT NULL,
	"type" varchar(30) NOT NULL,
	"display_name" varchar(200) NOT NULL,
	"base_url" varchar(500),
	"api_key_enc" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_token_usage" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"deployment_id" varchar(36),
	"model_id" varchar(100) NOT NULL,
	"mode" varchar(20) NOT NULL,
	"tokens_input" integer NOT NULL,
	"tokens_output" integer NOT NULL,
	"instruction" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36),
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
CREATE TABLE "auth_consumed_tokens" (
	"jti" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"purpose" varchar(32) NOT NULL,
	"consumed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_components" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"backup_job_id" varchar(64) NOT NULL,
	"component" "backup_component_name" NOT NULL,
	"artifact_name" varchar(255) NOT NULL,
	"status" "backup_component_status" DEFAULT 'pending' NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"sha256" varchar(64),
	"started_at" timestamp,
	"finished_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
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
	"active" boolean DEFAULT false NOT NULL,
	"last_tested_at" timestamp,
	"last_test_status" varchar(50),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backup_jobs" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"initiator" "backup_initiator" NOT NULL,
	"system_trigger" "backup_system_trigger",
	"status" "backup_job_status" DEFAULT 'pending' NOT NULL,
	"target_kind" "backup_target_kind" NOT NULL,
	"target_uri" varchar(1000) NOT NULL,
	"target_config_id" varchar(36),
	"label" varchar(255),
	"description" text,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"retention_days" integer NOT NULL,
	"expires_at" timestamp,
	"export_mode" varchar(32),
	"export_artifact" varchar(1000),
	"started_at" timestamp,
	"finished_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "backups" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
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
	"version_lock_mode" varchar(20) DEFAULT 'advisory' NOT NULL,
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
	"volumes" jsonb,
	"env_vars" jsonb,
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
CREATE TABLE "cluster_nodes" (
	"name" varchar(253) PRIMARY KEY NOT NULL,
	"display_name" varchar(253),
	"role" "node_role" DEFAULT 'worker' NOT NULL,
	"can_host_tenant_workloads" boolean DEFAULT true NOT NULL,
	"ingress_mode" varchar(8) DEFAULT 'all' NOT NULL,
	"public_ip" "inet",
	"kubelet_version" varchar(32),
	"k3s_version" varchar(32),
	"cpu_millicores" integer,
	"memory_bytes" bigint,
	"storage_bytes" bigint,
	"scheduled_pods" integer,
	"cpu_requests_millicores" integer,
	"memory_requests_bytes" bigint,
	"status_conditions" jsonb,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"notes" text,
	"labels" jsonb,
	"taints" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cron_jobs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
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
CREATE TABLE "custom_deployment_image_audit" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"deployment_id" varchar(36) NOT NULL,
	"image" varchar(500) NOT NULL,
	"resolved_digest" varchar(256),
	"pulled_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_deployment_image_check_cache" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"image_reference" varchar(500) NOT NULL,
	"registry_host" varchar(253) NOT NULL,
	"current_tag" varchar(128) NOT NULL,
	"latest_tag" varchar(128),
	"severity" varchar(16) NOT NULL,
	"reason" text,
	"checked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_deployment_image_credentials" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"deployment_id" varchar(36) NOT NULL,
	"registry_host" varchar(253) NOT NULL,
	"username" varchar(255) NOT NULL,
	"token_cipher" text NOT NULL,
	"token_last_four" varchar(4) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"rotated_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "deployment_network_access_configs" (
	"deployment_id" varchar(36) PRIMARY KEY NOT NULL,
	"mode" varchar(32) DEFAULT 'public' NOT NULL,
	"ziti_provider_id" varchar(36),
	"ziti_service_name" varchar(255),
	"zrok_provider_id" varchar(36),
	"zrok_share_token" varchar(255),
	"pass_identity_headers" boolean DEFAULT true NOT NULL,
	"provisioned" boolean DEFAULT false NOT NULL,
	"public_ingress_suppressed" boolean DEFAULT false NOT NULL,
	"last_error" text,
	"last_reconciled_at" timestamp,
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
	"tenant_id" varchar(36) NOT NULL,
	"catalog_entry_id" varchar(36),
	"source" "deployment_source" DEFAULT 'catalog' NOT NULL,
	"custom_spec" jsonb,
	"name" varchar(63) NOT NULL,
	"domain_name" varchar(255),
	"replica_count" integer DEFAULT 1 NOT NULL,
	"cpu_request" varchar(20) DEFAULT '0.25' NOT NULL,
	"memory_request" varchar(20) DEFAULT '256Mi' NOT NULL,
	"configuration" jsonb,
	"storage_path" varchar(500),
	"helm_release_name" varchar(255),
	"installed_version" varchar(50),
	"target_version" varchar(50),
	"previous_version" varchar(50),
	"auto_upgrade" boolean DEFAULT false NOT NULL,
	"last_upgraded_at" timestamp,
	"last_error" text,
	"status_message" text,
	"current_node_name" varchar(253),
	"deleted_at" timestamp,
	"status" "deployment_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dns_provider_groups" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"name" varchar(255) NOT NULL,
	"is_default" integer DEFAULT 0 NOT NULL,
	"ns_hostnames" jsonb,
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
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dns_servers" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"providerType" "dns_provider_type" NOT NULL,
	"connection_config_encrypted" varchar(2000) NOT NULL,
	"zoneDefaultKind" "zone_default_kind" DEFAULT 'Native' NOT NULL,
	"group_id" varchar(36),
	"role" varchar(20) DEFAULT 'primary' NOT NULL,
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
	"tenant_id" varchar(36) NOT NULL,
	"domain_name" varchar(255) NOT NULL,
	"deployment_id" varchar(36),
	"dns_group_id" varchar(36),
	"status" "domain_status" DEFAULT 'pending' NOT NULL,
	"dnsMode" "dns_mode" DEFAULT 'cname' NOT NULL,
	"master_ip" varchar(45),
	"verified_at" timestamp,
	"last_verified_at" timestamp,
	"verification_cache_at" timestamp with time zone,
	"verification_cache_result" jsonb,
	"ssl_auto_renew" integer DEFAULT 1 NOT NULL,
	"suppress_public_ingress" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_aliases" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"email_domain_id" varchar(36) NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
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
	"tenant_id" varchar(36) NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"webmail_enabled" integer DEFAULT 1 NOT NULL,
	"webmail_status" varchar(16) DEFAULT 'pending' NOT NULL,
	"webmail_status_message" text,
	"webmail_status_updated_at" timestamp,
	"catch_all_address" varchar(255),
	"mx_provisioned" integer DEFAULT 0 NOT NULL,
	"spf_provisioned" integer DEFAULT 0 NOT NULL,
	"dkim_provisioned" integer DEFAULT 0 NOT NULL,
	"dmarc_provisioned" integer DEFAULT 0 NOT NULL,
	"spam_threshold_junk" numeric(4, 1) DEFAULT '5.0' NOT NULL,
	"spam_threshold_reject" numeric(4, 1) DEFAULT '10.0' NOT NULL,
	"stalwart_domain_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "external_backup_repos" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"target_config_id" varchar(36) NOT NULL,
	"source_region_id" varchar(63) NOT NULL,
	"dr_recovery_key_encrypted" text,
	"label" varchar(255) NOT NULL,
	"read_only" boolean DEFAULT true NOT NULL,
	"last_seen_at" timestamp,
	"added_at" timestamp DEFAULT now() NOT NULL,
	"added_by_user_id" varchar(36),
	"notes" text
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
	"max_mailboxes" integer DEFAULT 50 NOT NULL,
	"weekly_ai_budget_cents" integer DEFAULT 100 NOT NULL,
	"default_backup_retention_days" integer DEFAULT 30 NOT NULL,
	"max_backup_retention_days" integer DEFAULT 90 NOT NULL,
	"max_backups" integer DEFAULT 10 NOT NULL,
	"max_backup_size_bytes" bigint DEFAULT 53687091200 NOT NULL,
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
CREATE TABLE "image_reap_log" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"image_name" text NOT NULL,
	"image_id" text,
	"nodes_reclaimed" text[] DEFAULT '{}' NOT NULL,
	"bytes_reclaimed" bigint DEFAULT 0 NOT NULL,
	"triggered_by" text NOT NULL,
	"trigger_ref" text,
	"succeeded" boolean DEFAULT false NOT NULL,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "imap_sync_jobs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"mailbox_id" varchar(36) NOT NULL,
	"source_host" varchar(255) NOT NULL,
	"source_port" integer DEFAULT 993 NOT NULL,
	"source_username" varchar(255) NOT NULL,
	"source_password_encrypted" text NOT NULL,
	"source_ssl" integer DEFAULT 1 NOT NULL,
	"options" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"k8s_job_name" varchar(253),
	"k8s_namespace" varchar(63) DEFAULT 'mail' NOT NULL,
	"log_tail" text,
	"error_message" text,
	"messages_total" integer,
	"messages_transferred" integer,
	"current_folder" varchar(255),
	"last_progress_at" timestamp,
	"pod_phase" varchar(32),
	"pod_message" text,
	"started_at" timestamp,
	"finished_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ingress_auth_configs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"ingress_route_id" varchar(36) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"provider_id" varchar(36) NOT NULL,
	"scopes_override" varchar(500),
	"post_login_redirect_url" varchar(2048),
	"allowed_emails" text,
	"allowed_email_domains" text,
	"allowed_groups" text,
	"claim_rules" jsonb,
	"pass_authorization_header" boolean DEFAULT true NOT NULL,
	"pass_access_token" boolean DEFAULT true NOT NULL,
	"pass_id_token" boolean DEFAULT true NOT NULL,
	"pass_user_headers" boolean DEFAULT true NOT NULL,
	"set_xauthrequest" boolean DEFAULT true NOT NULL,
	"cookie_domain" varchar(255),
	"cookie_refresh_seconds" integer DEFAULT 3600 NOT NULL,
	"cookie_expire_seconds" integer DEFAULT 86400 NOT NULL,
	"last_error" text,
	"last_reconciled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ingress_auth_configs_ingress_route_id_unique" UNIQUE("ingress_route_id")
);
--> statement-breakpoint
CREATE TABLE "ingress_mtls_configs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"ingress_route_id" varchar(36) NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"provider_id" varchar(36),
	"ca_cert_pem_encrypted" text,
	"ca_cert_fingerprint" varchar(64),
	"ca_cert_subject" varchar(500),
	"ca_cert_expires_at" timestamp,
	"verify_mode" varchar(32) DEFAULT 'on' NOT NULL,
	"subject_regex" varchar(500),
	"pass_cert_to_upstream" boolean DEFAULT false NOT NULL,
	"pass_dn_to_upstream" boolean DEFAULT true NOT NULL,
	"last_error" text,
	"last_reconciled_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "ingress_mtls_configs_ingress_route_id_unique" UNIQUE("ingress_route_id")
);
--> statement-breakpoint
CREATE TABLE "ingress_routes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"domain_id" varchar(36) NOT NULL,
	"hostname" varchar(255) NOT NULL,
	"path" varchar(255) DEFAULT '/' NOT NULL,
	"target_type" "ingress_target_type" DEFAULT 'deployment' NOT NULL,
	"deployment_id" varchar(36),
	"private_worker_id" varchar(36),
	"ingress_cname" varchar(255) NOT NULL,
	"node_hostname" varchar(255),
	"is_apex" integer DEFAULT 0 NOT NULL,
	"tlsMode" "tls_mode" DEFAULT 'auto' NOT NULL,
	"status" "ingress_status" DEFAULT 'pending' NOT NULL,
	"force_https" integer DEFAULT 1 NOT NULL,
	"www_redirect" "www_redirect" DEFAULT 'none' NOT NULL,
	"redirect_url" varchar(2048),
	"ip_allowlist" text,
	"rate_limit_rps" integer,
	"rate_limit_connections" integer,
	"rate_limit_burst_multiplier" numeric(4, 1),
	"waf_enabled" integer DEFAULT 0 NOT NULL,
	"waf_owasp_crs" integer DEFAULT 0 NOT NULL,
	"waf_anomaly_threshold" integer DEFAULT 10 NOT NULL,
	"waf_excluded_rules" text,
	"custom_error_codes" varchar(255),
	"custom_error_path" varchar(255),
	"additional_headers" jsonb,
	"service_port" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mail_submit_credentials" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"username" varchar(128) NOT NULL,
	"password_encrypted" text NOT NULL,
	"password_hash" text NOT NULL,
	"note" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	"last_used_at" timestamp
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
CREATE TABLE "mailbox_quota_events" (
	"mailbox_id" varchar(36) NOT NULL,
	"threshold" integer NOT NULL,
	"first_seen_at" timestamp DEFAULT now() NOT NULL,
	"cleared_at" timestamp,
	"notification_id" varchar(36)
);
--> statement-breakpoint
CREATE TABLE "mailboxes" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"email_domain_id" varchar(36) NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
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
	"stalwart_principal_id" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "node_health_state" (
	"node_name" text PRIMARY KEY NOT NULL,
	"ready" boolean DEFAULT true NOT NULL,
	"pressures" text[] DEFAULT '{}'::text[] NOT NULL,
	"csi_drivers_present" integer DEFAULT 0 NOT NULL,
	"csi_drivers_expected" integer DEFAULT 0 NOT NULL,
	"csi_drivers_missing" text[] DEFAULT '{}'::text[] NOT NULL,
	"evictions_last_hour" integer DEFAULT 0 NOT NULL,
	"disk_used_pct" numeric(5, 2),
	"severity" varchar(16) DEFAULT 'normal' NOT NULL,
	"last_notified_at" timestamp with time zone,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"type" "notification_type" DEFAULT 'info' NOT NULL,
	"title" varchar(255) NOT NULL,
	"message" text NOT NULL,
	"resource_type" varchar(50),
	"resource_id" varchar(64),
	"is_read" integer DEFAULT 0 NOT NULL,
	"read_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_global_settings" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"disable_local_auth_admin" integer DEFAULT 0 NOT NULL,
	"disable_local_auth_tenant" integer DEFAULT 0 NOT NULL,
	"break_glass_secret_hash" varchar(255),
	"protect_admin_via_proxy" integer DEFAULT 0 NOT NULL,
	"protect_tenant_via_proxy" integer DEFAULT 0 NOT NULL,
	"break_glass_path" varchar(100),
	"oauth2_proxy_cookie_secret_encrypted" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_pkce_state" (
	"state" text PRIMARY KEY NOT NULL,
	"code_verifier" text NOT NULL,
	"frontend_redirect" text NOT NULL,
	"provider_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oidc_providers" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"display_name" varchar(255) NOT NULL,
	"issuer_url" varchar(500) NOT NULL,
	"tenant_id" varchar(255) NOT NULL,
	"client_secret_encrypted" varchar(500) NOT NULL,
	"panelScope" "panel_scope" NOT NULL,
	"enabled" integer DEFAULT 0 NOT NULL,
	"backchannel_logout_enabled" integer DEFAULT 0 NOT NULL,
	"discovery_metadata" jsonb,
	"display_order" integer DEFAULT 0 NOT NULL,
	"auto_provision" integer DEFAULT 0 NOT NULL,
	"default_role" varchar(50) DEFAULT 'read_only',
	"additional_claims" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "passkey_challenges" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"challenge" "bytea" NOT NULL,
	"purpose" varchar(16) NOT NULL,
	"user_id" varchar(36),
	"panel" varchar(16) NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_settings" (
	"setting_key" varchar(100) PRIMARY KEY NOT NULL,
	"setting_value" text NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform_storage_apply_runs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"tier" varchar(8) NOT NULL,
	"actor_user_id" varchar(36),
	"status" varchar(32) DEFAULT 'running' NOT NULL,
	"patch_outcome_json" jsonb,
	"convergence_json" jsonb
);
--> statement-breakpoint
CREATE TABLE "platform_storage_policy" (
	"id" varchar(16) PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	"system_tier" "platform_storage_tier" DEFAULT 'local' NOT NULL,
	"pinned_by_admin" boolean DEFAULT false NOT NULL,
	"last_applied_at" timestamp with time zone,
	"last_applied_by" varchar(36),
	"ha_recommendation_notified_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "private_worker_audit" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"private_worker_id" varchar(36) NOT NULL,
	"event" varchar(40) NOT NULL,
	"ip" "inet",
	"detail" jsonb,
	"occurred_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "private_workers" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"name" varchar(120) NOT NULL,
	"slug" varchar(60) NOT NULL,
	"worker_token_hash" varchar(64) NOT NULL,
	"status" "private_worker_status" DEFAULT 'pending' NOT NULL,
	"exposed_port" integer NOT NULL,
	"description" text,
	"last_seen_at" timestamp,
	"last_used_ip" "inet",
	"bytes_in" bigint DEFAULT 0 NOT NULL,
	"bytes_out" bigint DEFAULT 0 NOT NULL,
	"created_by" varchar(36),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"revoked_at" timestamp,
	"revoked_by" varchar(36),
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "private_workers_slug_unique" UNIQUE("slug")
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
	"tenant_id" varchar(36) NOT NULL,
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
CREATE TABLE "refresh_tokens" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"family_id" varchar(36) NOT NULL,
	"token_hash" varchar(64) NOT NULL,
	"panel" "panel" NOT NULL,
	"tenant_id" varchar(36),
	"user_agent" varchar(500),
	"ip_address" varchar(64),
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"revoked_reason" varchar(50)
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
	"tenant_id" varchar(36) NOT NULL,
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
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restore_items" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"restore_job_id" varchar(64) NOT NULL,
	"bundle_id" varchar(64) NOT NULL,
	"type" "restore_item_type" NOT NULL,
	"selector" jsonb NOT NULL,
	"label" varchar(255),
	"seq" integer NOT NULL,
	"status" "restore_item_status" DEFAULT 'pending' NOT NULL,
	"progress_message" varchar(500),
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp,
	"finished_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "restore_jobs" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"initiator_user_id" varchar(36),
	"status" "restore_job_status" DEFAULT 'draft' NOT NULL,
	"pre_restore_snapshot_id" varchar(36),
	"description" text,
	"started_at" timestamp,
	"finished_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "route_auth_users" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"dir_id" varchar(36) NOT NULL,
	"username" varchar(255) NOT NULL,
	"password_hash" varchar(255) NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "route_protected_dirs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"route_id" varchar(36) NOT NULL,
	"path" varchar(255) NOT NULL,
	"realm" varchar(255) DEFAULT 'Restricted' NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sftp_audit_log" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"sftp_user_id" varchar(36),
	"tenant_id" varchar(36) NOT NULL,
	"event" varchar(50) NOT NULL,
	"source_ip" varchar(45) NOT NULL,
	"protocol" varchar(10) DEFAULT 'sftp' NOT NULL,
	"session_id" varchar(128),
	"duration_seconds" integer,
	"bytes_transferred" numeric(18, 0),
	"error_message" varchar(512),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sftp_user_ssh_keys" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"sftp_user_id" varchar(36) NOT NULL,
	"ssh_key_id" varchar(36) NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sftp_users" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"username" varchar(100) NOT NULL,
	"password_hash" varchar(255),
	"description" varchar(255),
	"enabled" integer DEFAULT 1 NOT NULL,
	"home_path" varchar(512) DEFAULT '/' NOT NULL,
	"allow_write" integer DEFAULT 1 NOT NULL,
	"allow_delete" integer DEFAULT 0 NOT NULL,
	"ip_whitelist" text,
	"max_concurrent_sessions" integer DEFAULT 3 NOT NULL,
	"last_login_at" timestamp,
	"last_login_ip" varchar(45),
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
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
	"tenant_id" varchar(36) NOT NULL,
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
	"tenant_id" varchar(36) NOT NULL,
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
CREATE TABLE "storage_operations" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"op_type" "storage_operation_type" NOT NULL,
	"state" "storage_lifecycle_state" DEFAULT 'idle' NOT NULL,
	"progress_pct" integer DEFAULT 0 NOT NULL,
	"progress_message" text,
	"params" jsonb,
	"snapshot_id" varchar(36),
	"rolled_back" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"triggered_by_user_id" varchar(36),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "storage_snapshots" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"kind" "storage_snapshot_kind" NOT NULL,
	"status" "storage_snapshot_status" DEFAULT 'creating' NOT NULL,
	"archive_path" varchar(500) NOT NULL,
	"size_bytes" numeric(20, 0) DEFAULT '0' NOT NULL,
	"sha256" varchar(64),
	"expires_at" timestamp,
	"label" text,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "subscription_billing_cycles" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
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
CREATE TABLE "system_backup_runs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"kind" varchar(32) NOT NULL,
	"status" varchar(32) DEFAULT 'pending' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"size_bytes" bigint,
	"sha256" varchar(64),
	"error_envelope" jsonb,
	"operator_user_id" varchar(36),
	"operator_ip" varchar(45),
	"operator_user_agent" varchar(500),
	"manifest" jsonb,
	"payload" "bytea",
	"source_namespace" varchar(63),
	"source_cluster" varchar(63),
	"source_database" varchar(63),
	"target_config_id" varchar(36),
	"bundle_id" varchar(64),
	"artifact_name" varchar(255),
	"job_name" varchar(63),
	"download_token_hash" varchar(64),
	"download_token_raw" varchar(256),
	"download_url_expires_at" timestamp with time zone,
	"downloaded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_pg_dump_schedules" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"source_namespace" varchar(63) NOT NULL,
	"source_cluster" varchar(63) NOT NULL,
	"source_database" varchar(63) NOT NULL,
	"target_config_id" varchar(36) NOT NULL,
	"cron_schedule" varchar(64) NOT NULL,
	"retention_days" integer DEFAULT 30 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_run_id" varchar(36),
	"next_run_at" timestamp with time zone,
	"operator_user_id" varchar(36),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_settings" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"platform_name" varchar(255) DEFAULT 'Hosting Platform' NOT NULL,
	"admin_panel_url" varchar(500),
	"tenant_panel_url" varchar(500),
	"support_email" varchar(255),
	"support_url" varchar(500),
	"ingress_base_domain" varchar(255),
	"mail_hostname" varchar(255),
	"webmail_url" varchar(500),
	"api_rate_limit" integer DEFAULT 100 NOT NULL,
	"currency_symbol" varchar(5) DEFAULT '$' NOT NULL,
	"timezone" varchar(50) DEFAULT 'UTC' NOT NULL,
	"allow_host_ports_server" boolean DEFAULT false NOT NULL,
	"allow_host_ports_worker" boolean DEFAULT false NOT NULL,
	"new_server_hosts_tenant_workloads" boolean DEFAULT true NOT NULL,
	"custom_deployments_enabled" boolean DEFAULT true NOT NULL,
	"custom_deployments_allow_compose" boolean DEFAULT true NOT NULL,
	"custom_deployments_allow_private_registries" boolean DEFAULT true NOT NULL,
	"custom_deployments_image_pull_audit" boolean DEFAULT true NOT NULL,
	"custom_deployments_scan_on_pull" boolean DEFAULT false NOT NULL,
	"custom_deployments_warn_unpinned_tags" boolean DEFAULT true NOT NULL,
	"image_gc_high_threshold" integer DEFAULT 70 NOT NULL,
	"image_gc_low_threshold" integer DEFAULT 60 NOT NULL,
	"image_gc_min_ttl_minutes" integer DEFAULT 60 NOT NULL,
	"last_known_platform_ips" jsonb,
	"notify_dns_failures_via_email" boolean DEFAULT false NOT NULL,
	"mail_snapshot_schedule" varchar(100),
	"mail_snapshot_backup_store_id" varchar(36),
	"mail_snapshot_last_run_stats" jsonb,
	"mail_datastore_type" varchar(20) DEFAULT 'postgres' NOT NULL,
	"mail_rocksdb_node_name" varchar(253),
	"mail_primary_node" varchar(253),
	"mail_secondary_node" varchar(253),
	"mail_tertiary_node" varchar(253),
	"mail_active_node" varchar(253),
	"mail_dr_state" varchar(32) DEFAULT 'healthy' NOT NULL,
	"mail_auto_failover_enabled" boolean DEFAULT false NOT NULL,
	"mail_failover_threshold_seconds" integer DEFAULT 300 NOT NULL,
	"mail_last_failover_at" timestamp with time zone,
	"mail_port_exposure_mode" varchar(32) DEFAULT 'allServerNodes' NOT NULL,
	"mail_datastore_pvc_size_gi" integer DEFAULT 20 NOT NULL,
	"mail_archive_schedule_interval" varchar(16) DEFAULT 'off' NOT NULL,
	"mail_archive_schedule_hour_utc" integer DEFAULT 2 NOT NULL,
	"mail_archive_schedule_weekday_utc" integer DEFAULT 0 NOT NULL,
	"mail_archive_last_scheduled_run_at" timestamp with time zone,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_wal_archive_state" (
	"cluster_namespace" varchar(63) NOT NULL,
	"cluster_name" varchar(63) NOT NULL,
	"target_config_id" varchar(36) NOT NULL,
	"retention_days" integer DEFAULT 30 NOT NULL,
	"destination_path" varchar(1024) NOT NULL,
	"enabled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"operator_user_id" varchar(36),
	"archive_timeout" varchar(16),
	"base_backup_schedule" varchar(64),
	"base_backup_retention_days" integer,
	CONSTRAINT "system_wal_archive_state_cluster_namespace_cluster_name_pk" PRIMARY KEY("cluster_namespace","cluster_name")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"kind" varchar(64) NOT NULL,
	"ref_id" varchar(64),
	"scope" varchar(16) NOT NULL,
	"user_id" varchar(36),
	"tenant_id" varchar(36),
	"label" text NOT NULL,
	"status" varchar(16) NOT NULL,
	"progress_pct" integer,
	"progress_text" text,
	"target" jsonb NOT NULL,
	"error_message" text,
	"details" jsonb,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"cleared_at" timestamp with time zone,
	"parent_task_id" varchar(36)
);
--> statement-breakpoint
CREATE TABLE "tenant_backup_schedules" (
	"tenant_id" varchar(36) PRIMARY KEY NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"frequency" "tenant_backup_schedule_freq" DEFAULT 'weekly' NOT NULL,
	"hour_of_day_utc" integer DEFAULT 3 NOT NULL,
	"day_of_week" integer,
	"day_of_month" integer,
	"retention_days" integer DEFAULT 14 NOT NULL,
	"last_run_at" timestamp,
	"last_run_status" "backup_job_status",
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_backup_v2_settings" (
	"id" integer PRIMARY KEY DEFAULT 1 NOT NULL,
	"retention_days" integer DEFAULT 30 NOT NULL,
	"check_interval_days" integer DEFAULT 7 NOT NULL,
	"max_concurrent_restic" integer DEFAULT 2 NOT NULL,
	"global_max_in_flight" integer DEFAULT 4 NOT NULL,
	"region_id_override" varchar(63),
	"dr_recovery_key_encrypted" text,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_bundle_in_flight" (
	"bundle_id" varchar(64) NOT NULL,
	"component" varchar(32) NOT NULL,
	"pod_name" varchar(255),
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_bundle_in_flight_bundle_id_component_pk" PRIMARY KEY("bundle_id","component")
);
--> statement-breakpoint
CREATE TABLE "tenant_certificates" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"provider_id" varchar(36) NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"serial_hex" varchar(64) NOT NULL,
	"cert_pem_encrypted" text NOT NULL,
	"cert_fingerprint_sha256" varchar(64) NOT NULL,
	"subject_cn" varchar(255) NOT NULL,
	"subject_full" varchar(500) NOT NULL,
	"issued_at" timestamp DEFAULT now() NOT NULL,
	"expires_at" timestamp NOT NULL,
	"revoked_at" timestamp,
	"revocation_reason" varchar(64),
	"revoked_by_user_id" varchar(36),
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_jmap_state" (
	"tenant_id" varchar(36) NOT NULL,
	"mailbox_jmap_id" varchar(255) NOT NULL,
	"mailbox_address" varchar(255) NOT NULL,
	"last_jmap_state" text,
	"last_synced_at" timestamp,
	"last_error" text,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_jmap_state_tenant_id_mailbox_jmap_id_pk" PRIMARY KEY("tenant_id","mailbox_jmap_id")
);
--> statement-breakpoint
CREATE TABLE "tenant_lifecycle_hook_runs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"transition_id" varchar(36) NOT NULL,
	"hook_name" varchar(64) NOT NULL,
	"hook_order" integer NOT NULL,
	"blocking" varchar(8) NOT NULL,
	"state" "tenant_lifecycle_hook_run_state" DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"last_error" jsonb,
	"started_at" timestamp,
	"completed_at" timestamp,
	"next_attempt_at" timestamp
);
--> statement-breakpoint
CREATE TABLE "tenant_lifecycle_transitions" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"transition_kind" "tenant_lifecycle_transition_kind" NOT NULL,
	"from_status" varchar(32),
	"to_status" varchar(32) NOT NULL,
	"triggered_by_user_id" varchar(36),
	"state" "tenant_lifecycle_transition_state" DEFAULT 'running' NOT NULL,
	"started_at" timestamp DEFAULT now() NOT NULL,
	"completed_at" timestamp,
	"namespace" varchar(63),
	"detail" jsonb
);
--> statement-breakpoint
CREATE TABLE "tenant_mesh_proxy_state" (
	"tenant_id" varchar(36) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"provisioned" boolean DEFAULT false NOT NULL,
	"last_provisioned_at" timestamp,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "tenant_mtls_providers" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"name" varchar(120) NOT NULL,
	"ca_cert_pem_encrypted" text NOT NULL,
	"ca_key_pem_encrypted" text,
	"ca_cert_fingerprint" varchar(64) NOT NULL,
	"ca_cert_subject" varchar(500) NOT NULL,
	"ca_cert_expires_at" timestamp NOT NULL,
	"can_issue" boolean DEFAULT false NOT NULL,
	"crl_number" bigint DEFAULT 0 NOT NULL,
	"crl_pem" text,
	"crl_last_generated_at" timestamp,
	"next_serial_seq" bigint DEFAULT 1 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_oauth2_proxy_state" (
	"tenant_id" varchar(36) PRIMARY KEY NOT NULL,
	"cookie_secret_encrypted" text NOT NULL,
	"provisioned" boolean DEFAULT false NOT NULL,
	"last_provisioned_at" timestamp,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "tenant_oidc_providers" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"name" varchar(120) NOT NULL,
	"issuer_url" varchar(500) NOT NULL,
	"oauth_client_id" varchar(255) NOT NULL,
	"oauth_client_secret_encrypted" text NOT NULL,
	"auth_method" varchar(32) DEFAULT 'client_secret_basic' NOT NULL,
	"response_type" varchar(32) DEFAULT 'code' NOT NULL,
	"use_pkce" boolean DEFAULT true NOT NULL,
	"default_scopes" varchar(500) DEFAULT 'openid profile email' NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_restic_repo_state" (
	"tenant_id" varchar(36) NOT NULL,
	"component" varchar(32) NOT NULL,
	"repo_uri" varchar(2000) NOT NULL,
	"target_config_id" varchar(36),
	"last_snapshot_id" varchar(64),
	"last_backup_job_id" varchar(64),
	"last_repo_size_bytes" bigint DEFAULT 0 NOT NULL,
	"last_snapshot_at" timestamp,
	"last_run_at" timestamp,
	"last_check_status" varchar(32),
	"last_check_at" timestamp,
	"last_check_error" text,
	"bundle_schema_version" integer,
	"source_region_id" varchar(63),
	"dr_key_added_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_restic_repo_state_tenant_id_component_pk" PRIMARY KEY("tenant_id","component")
);
--> statement-breakpoint
CREATE TABLE "tenant_ziti_providers" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"name" varchar(120) NOT NULL,
	"controller_url" varchar(500) NOT NULL,
	"enrollment_jwt_encrypted" text,
	"cert_expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_zrok_accounts" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"name" varchar(120) NOT NULL,
	"controller_url" varchar(500) NOT NULL,
	"account_email" varchar(255) NOT NULL,
	"account_token_encrypted" text NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"region_id" varchar(36) NOT NULL,
	"name" varchar(255) NOT NULL,
	"contact_name" varchar(255),
	"primary_email" varchar(255) NOT NULL,
	"secondary_email" varchar(255),
	"phone_e164" varchar(16),
	"billing_street_address" varchar(500),
	"billing_postal_address" varchar(500),
	"billing_city" varchar(200),
	"billing_country" varchar(100),
	"status" "tenant_status" DEFAULT 'pending' NOT NULL,
	"kubernetes_namespace" varchar(63) NOT NULL,
	"private_worker_shared_secret" varchar(64),
	"plan_id" varchar(36) NOT NULL,
	"cpu_limit_override" numeric(5, 2),
	"memory_limit_override" numeric(5, 2),
	"storage_limit_override" numeric(10, 2),
	"max_sub_users_override" integer,
	"monthly_price_override" numeric(10, 2),
	"max_mailboxes_override" integer,
	"email_send_rate_limit" integer,
	"timezone" varchar(50),
	"node_name" varchar(253),
	"storage_tier" "tenant_storage_tier" DEFAULT 'local' NOT NULL,
	"provisioningStatus" "provisioning_status" DEFAULT 'unprovisioned' NOT NULL,
	"storage_lifecycle_state" "storage_lifecycle_state" DEFAULT 'idle' NOT NULL,
	"active_storage_op_id" varchar(36),
	"created_by" varchar(36),
	"subscription_expires_at" timestamp,
	"suspended_at" timestamp,
	"archived_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "usage_metrics" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"metricType" "metric_type" NOT NULL,
	"deployment_id" varchar(36),
	"value" numeric(10, 4) NOT NULL,
	"measurement_timestamp" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_passkeys" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"user_id" varchar(36) NOT NULL,
	"credential_id" "bytea" NOT NULL,
	"public_key" "bytea" NOT NULL,
	"sign_count" integer DEFAULT 0 NOT NULL,
	"transports" jsonb,
	"aaguid" varchar(36),
	"nickname" varchar(100) NOT NULL,
	"backup_eligible" boolean DEFAULT false NOT NULL,
	"backed_up" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone
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
	"tenant_id" varchar(36),
	"status" "user_status" DEFAULT 'pending' NOT NULL,
	"email_verified_at" timestamp,
	"last_login_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"oidc_subject" varchar(255),
	"oidc_issuer" varchar(500),
	"timezone" varchar(50),
	"passkey_mode" varchar(16),
	"passkey_user_handle" "bytea",
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waf_logs" (
	"id" varchar(36) PRIMARY KEY NOT NULL,
	"route_id" varchar(36) NOT NULL,
	"tenant_id" varchar(36) NOT NULL,
	"rule_id" varchar(50) NOT NULL,
	"severity" varchar(20) NOT NULL,
	"message" text NOT NULL,
	"request_uri" text,
	"request_method" varchar(10),
	"source_ip" varchar(45),
	"matched_data" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_models" ADD CONSTRAINT "ai_models_provider_id_ai_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."ai_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_token_usage" ADD CONSTRAINT "ai_token_usage_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_token_usage" ADD CONSTRAINT "ai_token_usage_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_token_usage" ADD CONSTRAINT "ai_token_usage_model_id_ai_models_id_fk" FOREIGN KEY ("model_id") REFERENCES "public"."ai_models"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_consumed_tokens" ADD CONSTRAINT "auth_consumed_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_components" ADD CONSTRAINT "backup_components_backup_job_id_backup_jobs_id_fk" FOREIGN KEY ("backup_job_id") REFERENCES "public"."backup_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_jobs" ADD CONSTRAINT "backup_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backup_jobs" ADD CONSTRAINT "backup_jobs_target_config_id_backup_configurations_id_fk" FOREIGN KEY ("target_config_id") REFERENCES "public"."backup_configurations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backups" ADD CONSTRAINT "backups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cron_jobs" ADD CONSTRAINT "cron_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_deployment_image_audit" ADD CONSTRAINT "custom_deployment_image_audit_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_deployment_image_credentials" ADD CONSTRAINT "custom_deployment_image_credentials_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_network_access_configs" ADD CONSTRAINT "deployment_network_access_configs_deployment_id_deployments_id_fk" FOREIGN KEY ("deployment_id") REFERENCES "public"."deployments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_network_access_configs" ADD CONSTRAINT "deployment_network_access_configs_ziti_provider_id_tenant_ziti_providers_id_fk" FOREIGN KEY ("ziti_provider_id") REFERENCES "public"."tenant_ziti_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployment_network_access_configs" ADD CONSTRAINT "deployment_network_access_configs_zrok_provider_id_tenant_zrok_accounts_id_fk" FOREIGN KEY ("zrok_provider_id") REFERENCES "public"."tenant_zrok_accounts"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deployments" ADD CONSTRAINT "deployments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dns_records" ADD CONSTRAINT "dns_records_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "domains" ADD CONSTRAINT "domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_aliases" ADD CONSTRAINT "email_aliases_email_domain_id_email_domains_id_fk" FOREIGN KEY ("email_domain_id") REFERENCES "public"."email_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_aliases" ADD CONSTRAINT "email_aliases_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_domains" ADD CONSTRAINT "email_domains_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_domains" ADD CONSTRAINT "email_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_backup_repos" ADD CONSTRAINT "external_backup_repos_target_config_id_backup_configurations_id_fk" FOREIGN KEY ("target_config_id") REFERENCES "public"."backup_configurations"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "external_backup_repos" ADD CONSTRAINT "external_backup_repos_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imap_sync_jobs" ADD CONSTRAINT "imap_sync_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "imap_sync_jobs" ADD CONSTRAINT "imap_sync_jobs_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingress_auth_configs" ADD CONSTRAINT "ingress_auth_configs_ingress_route_id_ingress_routes_id_fk" FOREIGN KEY ("ingress_route_id") REFERENCES "public"."ingress_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingress_auth_configs" ADD CONSTRAINT "ingress_auth_configs_provider_id_tenant_oidc_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."tenant_oidc_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingress_mtls_configs" ADD CONSTRAINT "ingress_mtls_configs_ingress_route_id_ingress_routes_id_fk" FOREIGN KEY ("ingress_route_id") REFERENCES "public"."ingress_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingress_mtls_configs" ADD CONSTRAINT "ingress_mtls_configs_provider_id_tenant_mtls_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."tenant_mtls_providers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ingress_routes" ADD CONSTRAINT "ingress_routes_domain_id_domains_id_fk" FOREIGN KEY ("domain_id") REFERENCES "public"."domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mail_submit_credentials" ADD CONSTRAINT "mail_submit_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_access" ADD CONSTRAINT "mailbox_access_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailbox_quota_events" ADD CONSTRAINT "mailbox_quota_events_mailbox_id_mailboxes_id_fk" FOREIGN KEY ("mailbox_id") REFERENCES "public"."mailboxes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_email_domain_id_email_domains_id_fk" FOREIGN KEY ("email_domain_id") REFERENCES "public"."email_domains"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mailboxes" ADD CONSTRAINT "mailboxes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "passkey_challenges" ADD CONSTRAINT "passkey_challenges_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_worker_audit" ADD CONSTRAINT "private_worker_audit_private_worker_id_private_workers_id_fk" FOREIGN KEY ("private_worker_id") REFERENCES "public"."private_workers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "private_workers" ADD CONSTRAINT "private_workers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provisioning_tasks" ADD CONSTRAINT "provisioning_tasks_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_quotas" ADD CONSTRAINT "resource_quotas_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_items" ADD CONSTRAINT "restore_items_restore_job_id_restore_jobs_id_fk" FOREIGN KEY ("restore_job_id") REFERENCES "public"."restore_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_jobs" ADD CONSTRAINT "restore_jobs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "restore_jobs" ADD CONSTRAINT "restore_jobs_initiator_user_id_users_id_fk" FOREIGN KEY ("initiator_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_auth_users" ADD CONSTRAINT "route_auth_users_dir_id_route_protected_dirs_id_fk" FOREIGN KEY ("dir_id") REFERENCES "public"."route_protected_dirs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "route_protected_dirs" ADD CONSTRAINT "route_protected_dirs_route_id_ingress_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."ingress_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sftp_audit_log" ADD CONSTRAINT "sftp_audit_log_sftp_user_id_sftp_users_id_fk" FOREIGN KEY ("sftp_user_id") REFERENCES "public"."sftp_users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sftp_audit_log" ADD CONSTRAINT "sftp_audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sftp_user_ssh_keys" ADD CONSTRAINT "sftp_user_ssh_keys_sftp_user_id_sftp_users_id_fk" FOREIGN KEY ("sftp_user_id") REFERENCES "public"."sftp_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sftp_user_ssh_keys" ADD CONSTRAINT "sftp_user_ssh_keys_ssh_key_id_ssh_keys_id_fk" FOREIGN KEY ("ssh_key_id") REFERENCES "public"."ssh_keys"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sftp_users" ADD CONSTRAINT "sftp_users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssh_keys" ADD CONSTRAINT "ssh_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ssl_certificates" ADD CONSTRAINT "ssl_certificates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_operations" ADD CONSTRAINT "storage_operations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_operations" ADD CONSTRAINT "storage_operations_snapshot_id_storage_snapshots_id_fk" FOREIGN KEY ("snapshot_id") REFERENCES "public"."storage_snapshots"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "storage_snapshots" ADD CONSTRAINT "storage_snapshots_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "subscription_billing_cycles" ADD CONSTRAINT "subscription_billing_cycles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_backup_schedules" ADD CONSTRAINT "tenant_backup_schedules_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_certificates" ADD CONSTRAINT "tenant_certificates_provider_id_tenant_mtls_providers_id_fk" FOREIGN KEY ("provider_id") REFERENCES "public"."tenant_mtls_providers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_certificates" ADD CONSTRAINT "tenant_certificates_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_jmap_state" ADD CONSTRAINT "tenant_jmap_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_lifecycle_hook_runs" ADD CONSTRAINT "tenant_lifecycle_hook_runs_transition_id_tenant_lifecycle_transitions_id_fk" FOREIGN KEY ("transition_id") REFERENCES "public"."tenant_lifecycle_transitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_mesh_proxy_state" ADD CONSTRAINT "tenant_mesh_proxy_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_mtls_providers" ADD CONSTRAINT "tenant_mtls_providers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_oauth2_proxy_state" ADD CONSTRAINT "tenant_oauth2_proxy_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_oidc_providers" ADD CONSTRAINT "tenant_oidc_providers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_restic_repo_state" ADD CONSTRAINT "tenant_restic_repo_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_restic_repo_state" ADD CONSTRAINT "tenant_restic_repo_state_target_config_id_backup_configurations_id_fk" FOREIGN KEY ("target_config_id") REFERENCES "public"."backup_configurations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_restic_repo_state" ADD CONSTRAINT "tenant_restic_repo_state_last_backup_job_id_backup_jobs_id_fk" FOREIGN KEY ("last_backup_job_id") REFERENCES "public"."backup_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_ziti_providers" ADD CONSTRAINT "tenant_ziti_providers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_zrok_accounts" ADD CONSTRAINT "tenant_zrok_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_metrics" ADD CONSTRAINT "usage_metrics_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_passkeys" ADD CONSTRAINT "user_passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waf_logs" ADD CONSTRAINT "waf_logs_route_id_ingress_routes_id_fk" FOREIGN KEY ("route_id") REFERENCES "public"."ingress_routes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waf_logs" ADD CONSTRAINT "waf_logs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_idx" ON "audit_logs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_idx" ON "audit_logs" USING btree ("actor_id");--> statement-breakpoint
CREATE INDEX "audit_logs_action_idx" ON "audit_logs" USING btree ("action_type");--> statement-breakpoint
CREATE INDEX "audit_logs_created_idx" ON "audit_logs" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "auth_consumed_tokens_expires_idx" ON "auth_consumed_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "backup_components_job_component_artifact_unique" ON "backup_components" USING btree ("backup_job_id","component","artifact_name");--> statement-breakpoint
CREATE INDEX "backup_components_job_idx" ON "backup_components" USING btree ("backup_job_id");--> statement-breakpoint
CREATE INDEX "backup_components_status_idx" ON "backup_components" USING btree ("status");--> statement-breakpoint
CREATE INDEX "backup_jobs_tenant_idx" ON "backup_jobs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "backup_jobs_status_idx" ON "backup_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "backup_jobs_initiator_idx" ON "backup_jobs" USING btree ("initiator");--> statement-breakpoint
CREATE INDEX "backup_jobs_expires_idx" ON "backup_jobs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "backups_tenant_idx" ON "backups" USING btree ("tenant_id");--> statement-breakpoint
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
CREATE INDEX "cluster_nodes_role_idx" ON "cluster_nodes" USING btree ("role");--> statement-breakpoint
CREATE INDEX "cluster_nodes_last_seen_idx" ON "cluster_nodes" USING btree ("last_seen_at");--> statement-breakpoint
CREATE INDEX "cron_jobs_tenant_idx" ON "cron_jobs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "custom_deployment_image_audit_deployment_idx" ON "custom_deployment_image_audit" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "custom_deployment_image_audit_pulled_idx" ON "custom_deployment_image_audit" USING btree ("pulled_at");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_deployment_image_audit_deployment_digest_unique" ON "custom_deployment_image_audit" USING btree ("deployment_id","resolved_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_deployment_image_check_cache_key_unique" ON "custom_deployment_image_check_cache" USING btree ("image_reference","registry_host","current_tag");--> statement-breakpoint
CREATE INDEX "custom_deployment_image_check_cache_checked_idx" ON "custom_deployment_image_check_cache" USING btree ("checked_at");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_deployment_image_credentials_deployment_unique" ON "custom_deployment_image_credentials" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "deployment_network_access_ziti_idx" ON "deployment_network_access_configs" USING btree ("ziti_provider_id");--> statement-breakpoint
CREATE INDEX "deployment_network_access_zrok_idx" ON "deployment_network_access_configs" USING btree ("zrok_provider_id");--> statement-breakpoint
CREATE INDEX "idx_deploy_upgrades_deployment" ON "deployment_upgrades" USING btree ("deployment_id","status");--> statement-breakpoint
CREATE INDEX "idx_deploy_upgrades_status" ON "deployment_upgrades" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deployments_tenant_name_unique" ON "deployments" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "deployments_tenant_idx" ON "deployments" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "deployments_catalog_entry_idx" ON "deployments" USING btree ("catalog_entry_id");--> statement-breakpoint
CREATE INDEX "deployments_status_idx" ON "deployments" USING btree ("status");--> statement-breakpoint
CREATE INDEX "deployments_source_idx" ON "deployments" USING btree ("source");--> statement-breakpoint
CREATE INDEX "dns_records_domain_idx" ON "dns_records" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "dns_records_type_idx" ON "dns_records" USING btree ("recordType");--> statement-breakpoint
CREATE UNIQUE INDEX "domains_name_unique" ON "domains" USING btree ("domain_name");--> statement-breakpoint
CREATE INDEX "domains_tenant_idx" ON "domains" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "domains_status_idx" ON "domains" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "email_aliases_source_unique" ON "email_aliases" USING btree ("source_address");--> statement-breakpoint
CREATE INDEX "email_aliases_tenant_idx" ON "email_aliases" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "email_aliases_domain_idx" ON "email_aliases" USING btree ("email_domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "email_domains_domain_unique" ON "email_domains" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "email_domains_tenant_idx" ON "email_domains" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "email_domains_stalwart_domain_idx" ON "email_domains" USING btree ("stalwart_domain_id") WHERE "email_domains"."stalwart_domain_id" is not null;--> statement-breakpoint
CREATE INDEX "external_backup_repos_target_idx" ON "external_backup_repos" USING btree ("target_config_id");--> statement-breakpoint
CREATE INDEX "external_backup_repos_region_idx" ON "external_backup_repos" USING btree ("source_region_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hosting_plans_code_unique" ON "hosting_plans" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "hosting_settings_domain_unique" ON "hosting_settings" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "imap_sync_jobs_tenant_idx" ON "imap_sync_jobs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "imap_sync_jobs_mailbox_idx" ON "imap_sync_jobs" USING btree ("mailbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ingress_routes_hostname_path_domain_unique" ON "ingress_routes" USING btree ("hostname","path","domain_id");--> statement-breakpoint
CREATE INDEX "ingress_routes_domain_idx" ON "ingress_routes" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "ingress_routes_deployment_idx" ON "ingress_routes" USING btree ("deployment_id");--> statement-breakpoint
CREATE INDEX "ingress_routes_private_worker_idx" ON "ingress_routes" USING btree ("private_worker_id");--> statement-breakpoint
CREATE INDEX "mail_submit_credentials_tenant_idx" ON "mail_submit_credentials" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_access_unique" ON "mailbox_access" USING btree ("user_id","mailbox_id");--> statement-breakpoint
CREATE INDEX "mailbox_access_user_idx" ON "mailbox_access" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "mailbox_access_mailbox_idx" ON "mailbox_access" USING btree ("mailbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mailbox_quota_events_unique" ON "mailbox_quota_events" USING btree ("mailbox_id","threshold");--> statement-breakpoint
CREATE INDEX "mailbox_quota_events_open_idx" ON "mailbox_quota_events" USING btree ("mailbox_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mailboxes_address_unique" ON "mailboxes" USING btree ("full_address");--> statement-breakpoint
CREATE INDEX "mailboxes_tenant_idx" ON "mailboxes" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "mailboxes_domain_idx" ON "mailboxes" USING btree ("email_domain_id");--> statement-breakpoint
CREATE INDEX "mailboxes_stalwart_principal_idx" ON "mailboxes" USING btree ("stalwart_principal_id") WHERE "mailboxes"."stalwart_principal_id" is not null;--> statement-breakpoint
CREATE INDEX "notifications_user_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_read_idx" ON "notifications" USING btree ("is_read");--> statement-breakpoint
CREATE INDEX "notifications_created_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "passkey_challenges_expires_idx" ON "passkey_challenges" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "passkey_challenges_user_idx" ON "passkey_challenges" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "private_worker_audit_worker_idx" ON "private_worker_audit" USING btree ("private_worker_id","occurred_at");--> statement-breakpoint
CREATE INDEX "private_worker_audit_event_idx" ON "private_worker_audit" USING btree ("event","occurred_at");--> statement-breakpoint
CREATE INDEX "private_workers_tenant_idx" ON "private_workers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "private_workers_status_idx" ON "private_workers" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "private_workers_tenant_name_uq" ON "private_workers" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE UNIQUE INDEX "private_workers_tenant_port_uq" ON "private_workers" USING btree ("tenant_id","exposed_port");--> statement-breakpoint
CREATE INDEX "protected_dirs_domain_idx" ON "protected_directories" USING btree ("domain_id");--> statement-breakpoint
CREATE UNIQUE INDEX "protected_dir_users_unique" ON "protected_directory_users" USING btree ("directory_id","username");--> statement-breakpoint
CREATE INDEX "protected_dir_users_dir_idx" ON "protected_directory_users" USING btree ("directory_id");--> statement-breakpoint
CREATE INDEX "provisioning_tasks_tenant_idx" ON "provisioning_tasks" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "provisioning_tasks_status_idx" ON "provisioning_tasks" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "rbac_roles_name_unique" ON "rbac_roles" USING btree ("name");--> statement-breakpoint
CREATE UNIQUE INDEX "refresh_tokens_hash_unique" ON "refresh_tokens" USING btree ("token_hash");--> statement-breakpoint
CREATE INDEX "refresh_tokens_user_idx" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_family_idx" ON "refresh_tokens" USING btree ("family_id");--> statement-breakpoint
CREATE INDEX "refresh_tokens_expires_idx" ON "refresh_tokens" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "regions_code_unique" ON "regions" USING btree ("code");--> statement-breakpoint
CREATE UNIQUE INDEX "resource_quotas_tenant_unique" ON "resource_quotas" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "restore_items_job_idx" ON "restore_items" USING btree ("restore_job_id");--> statement-breakpoint
CREATE INDEX "restore_items_status_idx" ON "restore_items" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "restore_items_seq_unique" ON "restore_items" USING btree ("restore_job_id","seq");--> statement-breakpoint
CREATE INDEX "restore_jobs_tenant_idx" ON "restore_jobs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "restore_jobs_status_idx" ON "restore_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "restore_jobs_created_idx" ON "restore_jobs" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "route_auth_users_dir_username" ON "route_auth_users" USING btree ("dir_id","username");--> statement-breakpoint
CREATE INDEX "route_auth_users_dir_idx" ON "route_auth_users" USING btree ("dir_id");--> statement-breakpoint
CREATE INDEX "route_protected_dirs_route_idx" ON "route_protected_dirs" USING btree ("route_id");--> statement-breakpoint
CREATE UNIQUE INDEX "route_protected_dirs_route_path" ON "route_protected_dirs" USING btree ("route_id","path");--> statement-breakpoint
CREATE INDEX "sftp_audit_tenant_idx" ON "sftp_audit_log" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "sftp_audit_user_idx" ON "sftp_audit_log" USING btree ("sftp_user_id","created_at");--> statement-breakpoint
CREATE INDEX "sftp_audit_created_idx" ON "sftp_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sftp_user_ssh_keys_unique" ON "sftp_user_ssh_keys" USING btree ("sftp_user_id","ssh_key_id");--> statement-breakpoint
CREATE INDEX "sftp_user_ssh_keys_user_idx" ON "sftp_user_ssh_keys" USING btree ("sftp_user_id");--> statement-breakpoint
CREATE INDEX "sftp_user_ssh_keys_key_idx" ON "sftp_user_ssh_keys" USING btree ("ssh_key_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sftp_users_username_unique" ON "sftp_users" USING btree ("username");--> statement-breakpoint
CREATE INDEX "sftp_users_tenant_idx" ON "sftp_users" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "sftp_users_expires_idx" ON "sftp_users" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_keys_fingerprint_unique" ON "ssh_keys" USING btree ("key_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "ssh_keys_tenant_name_unique" ON "ssh_keys" USING btree ("tenant_id","name");--> statement-breakpoint
CREATE INDEX "ssh_keys_tenant_idx" ON "ssh_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "ssl_certs_domain_unique" ON "ssl_certificates" USING btree ("domain_id");--> statement-breakpoint
CREATE INDEX "ssl_certs_tenant_idx" ON "ssl_certificates" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "storage_operations_tenant_idx" ON "storage_operations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "storage_operations_state_idx" ON "storage_operations" USING btree ("state");--> statement-breakpoint
CREATE INDEX "storage_operations_created_idx" ON "storage_operations" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "storage_snapshots_tenant_idx" ON "storage_snapshots" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "storage_snapshots_status_idx" ON "storage_snapshots" USING btree ("status");--> statement-breakpoint
CREATE INDEX "storage_snapshots_expires_idx" ON "storage_snapshots" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_tenant_cycle" ON "subscription_billing_cycles" USING btree ("tenant_id","billing_cycle_start");--> statement-breakpoint
CREATE INDEX "billing_cycles_tenant_idx" ON "subscription_billing_cycles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "billing_cycles_status_idx" ON "subscription_billing_cycles" USING btree ("status");--> statement-breakpoint
CREATE UNIQUE INDEX "system_pg_dump_schedules_unique_target" ON "system_pg_dump_schedules" USING btree ("source_namespace","source_cluster","source_database");--> statement-breakpoint
CREATE INDEX "system_wal_archive_state_target_idx" ON "system_wal_archive_state" USING btree ("target_config_id");--> statement-breakpoint
CREATE INDEX "tasks_user_updated_idx" ON "tasks" USING btree ("user_id","updated_at");--> statement-breakpoint
CREATE INDEX "tasks_tenant_updated_idx" ON "tasks" USING btree ("tenant_id","updated_at");--> statement-breakpoint
CREATE INDEX "tasks_parent_idx" ON "tasks" USING btree ("parent_task_id");--> statement-breakpoint
CREATE INDEX "tenant_bundle_in_flight_refreshed_idx" ON "tenant_bundle_in_flight" USING btree ("refreshed_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_certificates_provider_serial_unique" ON "tenant_certificates" USING btree ("provider_id","serial_hex");--> statement-breakpoint
CREATE INDEX "tenant_certificates_provider_idx" ON "tenant_certificates" USING btree ("provider_id");--> statement-breakpoint
CREATE INDEX "tenant_certificates_tenant_idx" ON "tenant_certificates" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tenant_certificates_expires_idx" ON "tenant_certificates" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "tenant_jmap_state_tenant_idx" ON "tenant_jmap_state" USING btree ("tenant_id","last_synced_at");--> statement-breakpoint
CREATE INDEX "tenant_lifecycle_hook_runs_transition_idx" ON "tenant_lifecycle_hook_runs" USING btree ("transition_id","hook_order");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_lifecycle_hook_runs_uniq_idx" ON "tenant_lifecycle_hook_runs" USING btree ("transition_id","hook_name");--> statement-breakpoint
CREATE INDEX "tenant_lifecycle_hook_runs_retry_idx" ON "tenant_lifecycle_hook_runs" USING btree ("next_attempt_at") WHERE state = 'failed' AND next_attempt_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX "tenant_lifecycle_transitions_tenant_idx" ON "tenant_lifecycle_transitions" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE INDEX "tenant_lifecycle_transitions_state_idx" ON "tenant_lifecycle_transitions" USING btree ("state") WHERE state IN ('running', 'failed_blocking');--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_mesh_proxy_state_pk" ON "tenant_mesh_proxy_state" USING btree ("tenant_id","kind");--> statement-breakpoint
CREATE INDEX "tenant_mtls_providers_tenant_idx" ON "tenant_mtls_providers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tenant_restic_repo_state_target_idx" ON "tenant_restic_repo_state" USING btree ("target_config_id");--> statement-breakpoint
CREATE INDEX "tenant_ziti_providers_tenant_idx" ON "tenant_ziti_providers" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "tenant_zrok_accounts_tenant_idx" ON "tenant_zrok_accounts" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_namespace_unique" ON "tenants" USING btree ("kubernetes_namespace");--> statement-breakpoint
CREATE INDEX "tenants_region_idx" ON "tenants" USING btree ("region_id");--> statement-breakpoint
CREATE INDEX "tenants_plan_idx" ON "tenants" USING btree ("plan_id");--> statement-breakpoint
CREATE INDEX "tenants_status_idx" ON "tenants" USING btree ("status");--> statement-breakpoint
CREATE INDEX "usage_metrics_tenant_idx" ON "usage_metrics" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "usage_metrics_type_idx" ON "usage_metrics" USING btree ("metricType");--> statement-breakpoint
CREATE INDEX "usage_metrics_ts_idx" ON "usage_metrics" USING btree ("measurement_timestamp");--> statement-breakpoint
CREATE UNIQUE INDEX "user_passkeys_credential_id_unique" ON "user_passkeys" USING btree ("credential_id");--> statement-breakpoint
CREATE INDEX "user_passkeys_user_idx" ON "user_passkeys" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "uk_user_role_scope" ON "user_roles" USING btree ("user_id","role_id","scopeType","scope_id");--> statement-breakpoint
CREATE INDEX "user_roles_user_idx" ON "user_roles" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "user_roles_role_idx" ON "user_roles" USING btree ("role_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_oidc_unique" ON "users" USING btree ("oidc_issuer","oidc_subject");--> statement-breakpoint
CREATE INDEX "waf_logs_route_idx" ON "waf_logs" USING btree ("route_id");--> statement-breakpoint
CREATE INDEX "waf_logs_tenant_idx" ON "waf_logs" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "waf_logs_created_idx" ON "waf_logs" USING btree ("created_at");