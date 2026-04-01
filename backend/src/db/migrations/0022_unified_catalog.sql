-- Unified catalog migration: consolidates workload + application catalog systems
-- into catalog_repositories, catalog_entries, deployments tables.
-- This is a CLEAN BREAK — old tables are dropped, no data migration.

-- ─── New Tables ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS `catalog_repositories` (
  `id` varchar(36) PRIMARY KEY,
  `name` varchar(255) NOT NULL,
  `url` varchar(500) NOT NULL,
  `branch` varchar(100) NOT NULL DEFAULT 'main',
  `auth_token` varchar(500),
  `sync_interval_minutes` int NOT NULL DEFAULT 60,
  `last_synced_at` timestamp NULL,
  `status` enum('active','error','syncing') NOT NULL DEFAULT 'active',
  `local_cache_path` varchar(500),
  `last_error` text,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX `catalog_repos_url_unique` (`url`)
);

CREATE TABLE IF NOT EXISTS `catalog_entries` (
  `id` varchar(36) PRIMARY KEY,
  `code` varchar(100) NOT NULL,
  `name` varchar(255) NOT NULL,
  `type` enum('application','runtime','database','service','static') NOT NULL,
  `version` varchar(50),
  `latest_version` varchar(50),
  `default_version` varchar(50),
  `description` text,
  `url` varchar(500),
  `documentation` varchar(500),
  `category` varchar(50),
  `min_plan` varchar(50),
  `tenancy` json,
  `components` json,
  `networking` json,
  `volumes` json,
  `resources` json,
  `health_check` json,
  `parameters` json,
  `tags` json,
  `runtime` varchar(50),
  `web_server` varchar(50),
  `image` varchar(500),
  `has_dockerfile` int NOT NULL DEFAULT 0,
  `deployment_strategy` varchar(20),
  `services` json,
  `provides` json,
  `env_vars` json,
  `status` enum('available','beta','deprecated') NOT NULL DEFAULT 'available',
  `featured` int NOT NULL DEFAULT 0,
  `popular` int NOT NULL DEFAULT 0,
  `source_repo_id` varchar(36),
  `manifest_url` varchar(500),
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX `catalog_entries_code_repo_unique` (`code`, `source_repo_id`),
  INDEX `catalog_entries_type_idx` (`type`),
  INDEX `catalog_entries_status_idx` (`status`),
  INDEX `catalog_entries_category_idx` (`category`),
  INDEX `catalog_entries_source_repo_idx` (`source_repo_id`)
);

CREATE TABLE IF NOT EXISTS `deployments` (
  `id` varchar(36) PRIMARY KEY,
  `client_id` varchar(36) NOT NULL,
  `catalog_entry_id` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `domain_name` varchar(255),
  `replica_count` int NOT NULL DEFAULT 1,
  `cpu_request` varchar(20) NOT NULL DEFAULT '0.25',
  `memory_request` varchar(20) NOT NULL DEFAULT '256Mi',
  `configuration` json,
  `helm_release_name` varchar(255),
  `installed_version` varchar(50),
  `target_version` varchar(50),
  `last_upgraded_at` timestamp NULL,
  `status` enum('deploying','running','stopped','failed','deleting','upgrading','pending') NOT NULL DEFAULT 'pending',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX `deployments_client_name_unique` (`client_id`, `name`),
  INDEX `deployments_client_idx` (`client_id`),
  INDEX `deployments_catalog_entry_idx` (`catalog_entry_id`),
  INDEX `deployments_status_idx` (`status`)
);

CREATE TABLE IF NOT EXISTS `catalog_entry_versions` (
  `id` varchar(36) PRIMARY KEY,
  `catalog_entry_id` varchar(36) NOT NULL,
  `version` varchar(50) NOT NULL,
  `is_default` int NOT NULL DEFAULT 0,
  `eol_date` varchar(10),
  `components` json,
  `upgrade_from` json,
  `breaking_changes` text,
  `env_changes` json,
  `migration_notes` text,
  `min_resources` json,
  `status` enum('available','deprecated','eol') NOT NULL DEFAULT 'available',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE INDEX `uk_catalog_entry_version` (`catalog_entry_id`, `version`),
  INDEX `idx_catalog_versions_entry` (`catalog_entry_id`),
  INDEX `idx_catalog_versions_status` (`catalog_entry_id`, `status`)
);

CREATE TABLE IF NOT EXISTS `deployment_upgrades` (
  `id` varchar(36) PRIMARY KEY,
  `deployment_id` varchar(36) NOT NULL,
  `from_version` varchar(50) NOT NULL,
  `to_version` varchar(50) NOT NULL,
  `status` enum('pending','backing_up','pre_check','upgrading','health_check','rolling_back','completed','failed','rolled_back') NOT NULL DEFAULT 'pending',
  `triggered_by` varchar(36) NOT NULL,
  `trigger_type` enum('manual','batch','forced') NOT NULL DEFAULT 'manual',
  `backup_id` varchar(36),
  `progress_pct` int NOT NULL DEFAULT 0,
  `status_message` text,
  `error_message` text,
  `helm_values` json,
  `rollback_helm_values` json,
  `started_at` timestamp NULL,
  `completed_at` timestamp NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX `idx_deploy_upgrades_deployment` (`deployment_id`, `status`),
  INDEX `idx_deploy_upgrades_status` (`status`, `created_at`)
);

-- ─── Update existing tables to use deploymentId ─────────────────────────────

ALTER TABLE `domains` CHANGE COLUMN `workload_id` `deployment_id` varchar(36);

ALTER TABLE `ingress_routes` CHANGE COLUMN `workload_id` `deployment_id` varchar(36);
ALTER TABLE `ingress_routes` DROP INDEX `ingress_routes_workload_idx`;
ALTER TABLE `ingress_routes` ADD INDEX `ingress_routes_deployment_idx` (`deployment_id`);

ALTER TABLE `usage_metrics` CHANGE COLUMN `workload_id` `deployment_id` varchar(36);

-- ─── Drop old tables ────────────────────────────────────────────────────────

DROP TABLE IF EXISTS `application_upgrades`;
DROP TABLE IF EXISTS `application_versions`;
DROP TABLE IF EXISTS `application_instances`;
DROP TABLE IF EXISTS `application_catalog`;
DROP TABLE IF EXISTS `application_repositories`;
DROP TABLE IF EXISTS `workloads`;
DROP TABLE IF EXISTS `container_images`;
DROP TABLE IF EXISTS `workload_repositories`;
