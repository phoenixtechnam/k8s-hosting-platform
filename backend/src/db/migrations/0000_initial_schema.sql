-- 0000_initial_schema.sql
-- Initial schema for k8s-hosting-platform
-- Compatible with MariaDB 10.6+

CREATE TABLE IF NOT EXISTS `users` (
  `id` varchar(36) NOT NULL,
  `email` varchar(255) NOT NULL,
  `password_hash` varchar(255),
  `full_name` varchar(255) NOT NULL,
  `status` enum('active','disabled','pending') NOT NULL DEFAULT 'pending',
  `email_verified_at` timestamp NULL,
  `last_login_at` timestamp NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `users_email_unique` (`email`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `rbac_roles` (
  `id` varchar(36) NOT NULL,
  `name` varchar(50) NOT NULL,
  `description` text,
  `is_system_role` int NOT NULL DEFAULT 0,
  `permissions` json,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `rbac_roles_name_unique` (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `regions` (
  `id` varchar(36) NOT NULL,
  `code` varchar(50) NOT NULL,
  `name` varchar(255) NOT NULL,
  `provider` varchar(50) NOT NULL,
  `kubernetes_api_endpoint` varchar(500),
  `status` enum('active','maintenance','offline') NOT NULL DEFAULT 'active',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `regions_code_unique` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `hosting_plans` (
  `id` varchar(36) NOT NULL,
  `code` varchar(50) NOT NULL,
  `name` varchar(255) NOT NULL,
  `description` text,
  `cpu_limit` decimal(5,2) NOT NULL,
  `memory_limit` decimal(5,2) NOT NULL,
  `storage_limit` decimal(10,2) NOT NULL,
  `monthly_price_usd` decimal(10,2) NOT NULL,
  `features` json,
  `status` enum('active','deprecated') NOT NULL DEFAULT 'active',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `hosting_plans_code_unique` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `clients` (
  `id` varchar(36) NOT NULL,
  `region_id` varchar(36) NOT NULL,
  `company_name` varchar(255) NOT NULL,
  `company_email` varchar(255) NOT NULL,
  `contact_email` varchar(255),
  `status` enum('active','suspended','cancelled','pending') NOT NULL DEFAULT 'pending',
  `kubernetes_namespace` varchar(63) NOT NULL,
  `plan_id` varchar(36) NOT NULL,
  `created_by` varchar(36),
  `subscription_expires_at` timestamp NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `clients_namespace_unique` (`kubernetes_namespace`),
  INDEX `clients_region_idx` (`region_id`),
  INDEX `clients_plan_idx` (`plan_id`),
  INDEX `clients_status_idx` (`status`),
  CONSTRAINT `clients_region_fk` FOREIGN KEY (`region_id`) REFERENCES `regions` (`id`),
  CONSTRAINT `clients_plan_fk` FOREIGN KEY (`plan_id`) REFERENCES `hosting_plans` (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `domains` (
  `id` varchar(36) NOT NULL,
  `client_id` varchar(36) NOT NULL,
  `domain_name` varchar(255) NOT NULL,
  `workload_id` varchar(36),
  `status` enum('active','pending','suspended','deleted') NOT NULL DEFAULT 'pending',
  `dns_mode` enum('primary','cname','secondary') NOT NULL DEFAULT 'cname',
  `verified_at` timestamp NULL,
  `ssl_auto_renew` int NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `domains_name_unique` (`domain_name`),
  INDEX `domains_client_idx` (`client_id`),
  INDEX `domains_status_idx` (`status`),
  CONSTRAINT `domains_client_fk` FOREIGN KEY (`client_id`) REFERENCES `clients` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `workloads` (
  `id` varchar(36) NOT NULL,
  `client_id` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `container_image_id` varchar(36),
  `replica_count` int NOT NULL DEFAULT 1,
  `cpu_request` varchar(20) NOT NULL DEFAULT '100m',
  `memory_request` varchar(20) NOT NULL DEFAULT '128Mi',
  `status` enum('running','stopped','pending','failed') NOT NULL DEFAULT 'pending',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `workloads_client_idx` (`client_id`),
  INDEX `workloads_status_idx` (`status`),
  CONSTRAINT `workloads_client_fk` FOREIGN KEY (`client_id`) REFERENCES `clients` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `databases` (
  `id` varchar(36) NOT NULL,
  `client_id` varchar(36) NOT NULL,
  `name` varchar(63) NOT NULL,
  `database_type` enum('mysql','postgresql') NOT NULL DEFAULT 'mysql',
  `username` varchar(63) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `port` int NOT NULL DEFAULT 3306,
  `status` enum('active','creating','deleting','failed') NOT NULL DEFAULT 'creating',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `databases_name_unique` (`name`),
  INDEX `databases_client_idx` (`client_id`),
  CONSTRAINT `databases_client_fk` FOREIGN KEY (`client_id`) REFERENCES `clients` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `container_images` (
  `id` varchar(36) NOT NULL,
  `code` varchar(50) NOT NULL,
  `name` varchar(255) NOT NULL,
  `image_type` varchar(50) NOT NULL,
  `registry_url` varchar(500),
  `digest` varchar(255),
  `supported_versions` json,
  `status` enum('active','deprecated') NOT NULL DEFAULT 'active',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `container_images_code_unique` (`code`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `backups` (
  `id` varchar(36) NOT NULL,
  `client_id` varchar(36) NOT NULL,
  `backup_type` enum('auto','manual','scheduled') NOT NULL DEFAULT 'manual',
  `resource_type` varchar(50) NOT NULL DEFAULT 'full',
  `resource_id` varchar(36),
  `storage_path` varchar(500),
  `size_bytes` int,
  `status` enum('pending','in_progress','completed','failed') NOT NULL DEFAULT 'pending',
  `completed_at` timestamp NULL,
  `expires_at` timestamp NULL,
  `notes` text,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `backups_client_idx` (`client_id`),
  INDEX `backups_status_idx` (`status`),
  CONSTRAINT `backups_client_fk` FOREIGN KEY (`client_id`) REFERENCES `clients` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `usage_metrics` (
  `id` varchar(36) NOT NULL,
  `client_id` varchar(36) NOT NULL,
  `metric_type` enum('cpu_cores','memory_gb','storage_gb','bandwidth_gb') NOT NULL,
  `workload_id` varchar(36),
  `value` decimal(10,4) NOT NULL,
  `measurement_timestamp` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `usage_metrics_client_idx` (`client_id`),
  INDEX `usage_metrics_type_idx` (`metric_type`),
  INDEX `usage_metrics_ts_idx` (`measurement_timestamp`),
  CONSTRAINT `usage_metrics_client_fk` FOREIGN KEY (`client_id`) REFERENCES `clients` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `cron_jobs` (
  `id` varchar(36) NOT NULL,
  `client_id` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `schedule` varchar(100) NOT NULL,
  `command` text NOT NULL,
  `enabled` int NOT NULL DEFAULT 1,
  `last_run_at` timestamp NULL,
  `last_run_status` enum('success','failed','running'),
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `cron_jobs_client_idx` (`client_id`),
  CONSTRAINT `cron_jobs_client_fk` FOREIGN KEY (`client_id`) REFERENCES `clients` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `audit_logs` (
  `id` varchar(36) NOT NULL,
  `client_id` varchar(36),
  `action_type` varchar(50) NOT NULL,
  `resource_type` varchar(50) NOT NULL,
  `resource_id` varchar(36),
  `actor_id` varchar(36) NOT NULL,
  `actor_type` enum('user','system','webhook') NOT NULL DEFAULT 'user',
  `http_method` varchar(10),
  `http_path` varchar(500),
  `http_status` int,
  `changes` json,
  `ip_address` varchar(45),
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  INDEX `audit_logs_client_idx` (`client_id`),
  INDEX `audit_logs_actor_idx` (`actor_id`),
  INDEX `audit_logs_action_idx` (`action_type`),
  INDEX `audit_logs_created_idx` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
