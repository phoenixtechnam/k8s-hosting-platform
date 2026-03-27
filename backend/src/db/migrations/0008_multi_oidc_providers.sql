-- Migration: Replace single oidc_settings with multi-provider support + global auth settings

CREATE TABLE IF NOT EXISTS `oidc_providers` (
  `id` varchar(36) NOT NULL,
  `display_name` varchar(255) NOT NULL,
  `issuer_url` varchar(500) NOT NULL,
  `client_id` varchar(255) NOT NULL,
  `client_secret_encrypted` varchar(500) NOT NULL,
  `panel_scope` enum('admin','client') NOT NULL,
  `enabled` int NOT NULL DEFAULT 0,
  `backchannel_logout_enabled` int NOT NULL DEFAULT 0,
  `discovery_metadata` json,
  `display_order` int NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `oidc_providers_id` PRIMARY KEY(`id`)
);

CREATE TABLE IF NOT EXISTS `oidc_global_settings` (
  `id` varchar(36) NOT NULL,
  `disable_local_auth_admin` int NOT NULL DEFAULT 0,
  `disable_local_auth_client` int NOT NULL DEFAULT 0,
  `break_glass_secret_hash` varchar(255),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `oidc_global_settings_id` PRIMARY KEY(`id`)
);

-- Migrate existing oidc_settings data to oidc_providers (if any)
INSERT IGNORE INTO `oidc_providers` (`id`, `display_name`, `issuer_url`, `client_id`, `client_secret_encrypted`, `panel_scope`, `enabled`, `backchannel_logout_enabled`, `discovery_metadata`)
SELECT `id`, 'SSO Provider', `issuer_url`, `client_id`, `client_secret_encrypted`, 'admin', `enabled`, `backchannel_logout_enabled`, `discovery_metadata`
FROM `oidc_settings`;

-- Migrate global settings
INSERT IGNORE INTO `oidc_global_settings` (`id`, `disable_local_auth_admin`, `disable_local_auth_client`)
SELECT UUID(), `disable_local_auth`, 0
FROM `oidc_settings`
LIMIT 1;
