-- Migration: Add OIDC settings table and OIDC fields to users

CREATE TABLE IF NOT EXISTS `oidc_settings` (
  `id` varchar(36) NOT NULL,
  `issuer_url` varchar(500) NOT NULL,
  `client_id` varchar(255) NOT NULL,
  `client_secret_encrypted` varchar(500) NOT NULL,
  `enabled` int NOT NULL DEFAULT 0,
  `disable_local_auth` int NOT NULL DEFAULT 0,
  `discovery_metadata` json,
  `jwks_cache` json,
  `jwks_cached_at` timestamp,
  `backchannel_logout_enabled` int NOT NULL DEFAULT 0,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `oidc_settings_id` PRIMARY KEY(`id`)
);

ALTER TABLE `users` ADD COLUMN `oidc_subject` varchar(255) AFTER `updated_at`;
ALTER TABLE `users` ADD COLUMN `oidc_issuer` varchar(500) AFTER `oidc_subject`;
