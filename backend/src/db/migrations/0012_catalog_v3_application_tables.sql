-- Migration: Catalog v3 + Application Tables (ADR-025, ADR-026)

-- Extend container_images with new manifest v3 fields
ALTER TABLE container_images ADD COLUMN runtime varchar(50) DEFAULT NULL;
ALTER TABLE container_images ADD COLUMN web_server varchar(50) DEFAULT NULL;
ALTER TABLE container_images ADD COLUMN deployment_strategy varchar(20) DEFAULT NULL;
ALTER TABLE container_images ADD COLUMN container_port int DEFAULT NULL;
ALTER TABLE container_images ADD COLUMN mount_path varchar(500) DEFAULT NULL;
ALTER TABLE container_images ADD COLUMN resource_storage varchar(20) DEFAULT NULL;
ALTER TABLE container_images ADD COLUMN health_check json DEFAULT NULL;
ALTER TABLE container_images ADD COLUMN services json DEFAULT NULL;
ALTER TABLE container_images ADD COLUMN provides json DEFAULT NULL;
ALTER TABLE container_images ADD COLUMN version varchar(50) DEFAULT NULL;
ALTER TABLE container_images ADD COLUMN description text DEFAULT NULL;

-- Add workload_id FK to databases (ADR-026 workload-database binding)
ALTER TABLE `databases` ADD COLUMN workload_id varchar(36) DEFAULT NULL;
CREATE INDEX databases_workload_idx ON `databases`(workload_id);

-- Application repositories (mirrors workload_repositories)
CREATE TABLE application_repositories (
  id varchar(36) PRIMARY KEY,
  name varchar(255) NOT NULL,
  url varchar(500) NOT NULL,
  branch varchar(100) NOT NULL DEFAULT 'main',
  auth_token varchar(500),
  sync_interval_minutes int NOT NULL DEFAULT 60,
  last_synced_at timestamp NULL,
  status enum('active', 'error', 'syncing') NOT NULL DEFAULT 'active',
  last_error text,
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_app_repos_url (url)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Application catalog (synced from application catalog repos)
CREATE TABLE application_catalog (
  id varchar(36) PRIMARY KEY,
  code varchar(100) NOT NULL,
  name varchar(255) NOT NULL,
  version varchar(50),
  description text,
  category varchar(50),
  min_plan varchar(50),
  tenancy json,
  components json,
  networking json,
  volumes json,
  resources json,
  health_check json,
  parameters json,
  tags json,
  status enum('available', 'beta', 'deprecated') NOT NULL DEFAULT 'available',
  source_repo_id varchar(36),
  manifest_url varchar(500),
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_app_catalog_code_repo (code, source_repo_id),
  KEY idx_app_catalog_status (status),
  KEY idx_app_catalog_category (category),
  KEY idx_app_catalog_source_repo (source_repo_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Application instances (deployed per client)
CREATE TABLE application_instances (
  id varchar(36) PRIMARY KEY,
  client_id varchar(36) NOT NULL,
  application_catalog_id varchar(36) NOT NULL,
  name varchar(255) NOT NULL,
  domain_name varchar(255),
  configuration json,
  helm_release_name varchar(255),
  status enum('deploying', 'running', 'stopped', 'failed', 'deleting') NOT NULL DEFAULT 'deploying',
  created_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uk_client_app_name (client_id, name),
  KEY idx_app_instances_client (client_id),
  KEY idx_app_instances_catalog (application_catalog_id),
  KEY idx_app_instances_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Platform settings (key-value store for platform configuration)
CREATE TABLE IF NOT EXISTS platform_settings (
  setting_key varchar(100) PRIMARY KEY,
  setting_value text NOT NULL,
  updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO platform_settings (setting_key, setting_value) VALUES ('auto_update', 'false');
INSERT IGNORE INTO platform_settings (setting_key, setting_value) VALUES ('last_update_check', '');
INSERT IGNORE INTO platform_settings (setting_key, setting_value) VALUES ('latest_version', '');
