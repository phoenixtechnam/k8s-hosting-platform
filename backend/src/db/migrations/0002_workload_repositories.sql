CREATE TABLE IF NOT EXISTS `workload_repositories` (
  `id` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `url` varchar(500) NOT NULL,
  `branch` varchar(100) NOT NULL DEFAULT 'main',
  `auth_token` varchar(500) NULL,
  `sync_interval_minutes` int NOT NULL DEFAULT 60,
  `last_synced_at` timestamp NULL,
  `status` enum('active','error','syncing') NOT NULL DEFAULT 'active',
  `last_error` text NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `workload_repos_url_unique` (`url`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE `container_images` ADD COLUMN `source_repo_id` varchar(36) NULL AFTER `status`;
ALTER TABLE `container_images` ADD COLUMN `manifest_url` varchar(500) NULL AFTER `source_repo_id`;
ALTER TABLE `container_images` ADD COLUMN `has_dockerfile` tinyint NOT NULL DEFAULT 0 AFTER `manifest_url`;
ALTER TABLE `container_images` ADD COLUMN `min_plan` varchar(50) NULL AFTER `has_dockerfile`;
ALTER TABLE `container_images` ADD COLUMN `resource_cpu` varchar(20) NULL AFTER `min_plan`;
ALTER TABLE `container_images` ADD COLUMN `resource_memory` varchar(20) NULL AFTER `resource_cpu`;
ALTER TABLE `container_images` ADD COLUMN `env_vars` json NULL AFTER `resource_memory`;
ALTER TABLE `container_images` ADD COLUMN `tags` json NULL AFTER `env_vars`;
