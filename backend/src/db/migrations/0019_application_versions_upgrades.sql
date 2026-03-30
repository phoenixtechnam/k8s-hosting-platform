-- Migration: Add application version lifecycle + upgrade tracking tables
-- Adds multi-version support to application catalog and rolling upgrade orchestration

-- Add version metadata columns to application_catalog
ALTER TABLE `application_catalog`
  ADD COLUMN `latest_version` VARCHAR(50) NULL AFTER `version`,
  ADD COLUMN `default_version` VARCHAR(50) NULL AFTER `latest_version`;

-- Backfill: copy existing version into latest_version
UPDATE `application_catalog` SET `latest_version` = `version` WHERE `version` IS NOT NULL;

-- Add version tracking columns to application_instances
ALTER TABLE `application_instances`
  ADD COLUMN `installed_version` VARCHAR(50) NULL AFTER `helm_release_name`,
  ADD COLUMN `target_version` VARCHAR(50) NULL AFTER `installed_version`,
  ADD COLUMN `last_upgraded_at` TIMESTAMP NULL AFTER `target_version`;

-- Extend instance status enum to include 'upgrading'
ALTER TABLE `application_instances`
  MODIFY COLUMN `status` ENUM('deploying','running','stopped','failed','deleting','upgrading') NOT NULL DEFAULT 'deploying';

-- Create application_versions table
CREATE TABLE IF NOT EXISTS `application_versions` (
  `id` VARCHAR(36) NOT NULL,
  `application_catalog_id` VARCHAR(36) NOT NULL,
  `version` VARCHAR(50) NOT NULL,
  `is_default` INT NOT NULL DEFAULT 0,
  `eol_date` VARCHAR(10) NULL,
  `components` JSON NULL,
  `upgrade_from` JSON NULL,
  `breaking_changes` TEXT NULL,
  `env_changes` JSON NULL,
  `migration_notes` TEXT NULL,
  `min_resources` JSON NULL,
  `status` ENUM('available','deprecated','eol') NOT NULL DEFAULT 'available',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_app_version` (`application_catalog_id`, `version`),
  KEY `idx_app_versions_catalog` (`application_catalog_id`),
  KEY `idx_app_versions_status` (`application_catalog_id`, `status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Create application_upgrades table
CREATE TABLE IF NOT EXISTS `application_upgrades` (
  `id` VARCHAR(36) NOT NULL,
  `instance_id` VARCHAR(36) NOT NULL,
  `from_version` VARCHAR(50) NOT NULL,
  `to_version` VARCHAR(50) NOT NULL,
  `status` ENUM('pending','backing_up','pre_check','upgrading','health_check','rolling_back','completed','failed','rolled_back') NOT NULL DEFAULT 'pending',
  `triggered_by` VARCHAR(36) NOT NULL,
  `trigger_type` ENUM('manual','batch','forced') NOT NULL DEFAULT 'manual',
  `backup_id` VARCHAR(36) NULL,
  `progress_pct` INT NOT NULL DEFAULT 0,
  `status_message` TEXT NULL,
  `error_message` TEXT NULL,
  `helm_values` JSON NULL,
  `rollback_helm_values` JSON NULL,
  `started_at` TIMESTAMP NULL,
  `completed_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `idx_app_upgrades_instance` (`instance_id`, `status`),
  KEY `idx_app_upgrades_status` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
