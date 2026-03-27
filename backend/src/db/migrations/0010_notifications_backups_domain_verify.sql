-- Notifications table
CREATE TABLE IF NOT EXISTS `notifications` (
  `id` varchar(36) NOT NULL,
  `user_id` varchar(36) NOT NULL,
  `type` enum('info','warning','error','success') NOT NULL DEFAULT 'info',
  `title` varchar(255) NOT NULL,
  `message` text NOT NULL,
  `resource_type` varchar(50) DEFAULT NULL,
  `resource_id` varchar(36) DEFAULT NULL,
  `is_read` int NOT NULL DEFAULT 0,
  `read_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  KEY `notifications_user_idx` (`user_id`),
  KEY `notifications_read_idx` (`is_read`),
  KEY `notifications_created_idx` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Backup configurations table
CREATE TABLE IF NOT EXISTS `backup_configurations` (
  `id` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `storage_type` enum('ssh','s3') NOT NULL,
  `ssh_host` varchar(255) DEFAULT NULL,
  `ssh_port` int DEFAULT 22,
  `ssh_user` varchar(100) DEFAULT NULL,
  `ssh_key_encrypted` text DEFAULT NULL,
  `ssh_path` varchar(500) DEFAULT NULL,
  `s3_endpoint` varchar(500) DEFAULT NULL,
  `s3_bucket` varchar(255) DEFAULT NULL,
  `s3_region` varchar(50) DEFAULT NULL,
  `s3_access_key_encrypted` varchar(500) DEFAULT NULL,
  `s3_secret_key_encrypted` varchar(500) DEFAULT NULL,
  `s3_prefix` varchar(255) DEFAULT NULL,
  `retention_days` int NOT NULL DEFAULT 30,
  `schedule_expression` varchar(100) DEFAULT '0 2 * * *',
  `enabled` int NOT NULL DEFAULT 1,
  `last_tested_at` timestamp NULL DEFAULT NULL,
  `last_test_status` varchar(50) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Add master_ip and last_verified_at to domains
ALTER TABLE `domains` ADD COLUMN `master_ip` varchar(45) DEFAULT NULL;
ALTER TABLE `domains` ADD COLUMN `last_verified_at` timestamp NULL DEFAULT NULL;
