-- Migration: Add missing schema tables (user_roles, dns_records, ssh_keys, subscription_billing_cycles, resource_quotas)

CREATE TABLE IF NOT EXISTS `user_roles` (
  `id` varchar(36) NOT NULL,
  `user_id` varchar(36) NOT NULL,
  `role_id` varchar(36) NOT NULL,
  `scope_type` enum('global','region','client') NOT NULL DEFAULT 'global',
  `scope_id` varchar(36),
  `assigned_by` varchar(36),
  `assigned_at` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `user_roles_id` PRIMARY KEY(`id`),
  CONSTRAINT `uk_user_role_scope` UNIQUE(`user_id`,`role_id`,`scope_type`,`scope_id`)
);

CREATE INDEX `user_roles_user_idx` ON `user_roles` (`user_id`);
CREATE INDEX `user_roles_role_idx` ON `user_roles` (`role_id`);

CREATE TABLE IF NOT EXISTS `dns_records` (
  `id` varchar(36) NOT NULL,
  `domain_id` varchar(36) NOT NULL,
  `record_type` enum('A','AAAA','CNAME','MX','TXT','SRV','NS') NOT NULL,
  `record_name` varchar(253),
  `record_value` varchar(1000),
  `ttl` int NOT NULL DEFAULT 3600,
  `priority` int,
  `weight` int,
  `port` int,
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `dns_records_id` PRIMARY KEY(`id`)
);

CREATE INDEX `dns_records_domain_idx` ON `dns_records` (`domain_id`);
CREATE INDEX `dns_records_type_idx` ON `dns_records` (`record_type`);

CREATE TABLE IF NOT EXISTS `ssh_keys` (
  `id` varchar(36) NOT NULL,
  `client_id` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `public_key` text NOT NULL,
  `key_fingerprint` varchar(255) NOT NULL,
  `key_algorithm` varchar(50),
  `created_at` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `ssh_keys_id` PRIMARY KEY(`id`),
  CONSTRAINT `ssh_keys_fingerprint_unique` UNIQUE(`key_fingerprint`),
  CONSTRAINT `ssh_keys_client_name_unique` UNIQUE(`client_id`,`name`)
);

CREATE INDEX `ssh_keys_client_idx` ON `ssh_keys` (`client_id`);

CREATE TABLE IF NOT EXISTS `subscription_billing_cycles` (
  `id` varchar(36) NOT NULL,
  `client_id` varchar(36) NOT NULL,
  `billing_cycle_start` timestamp NOT NULL,
  `billing_cycle_end` timestamp NOT NULL,
  `plan_id` varchar(36) NOT NULL,
  `base_price_usd` decimal(10,2),
  `overages_price_usd` decimal(10,2) DEFAULT '0',
  `total_price_usd` decimal(10,2) NOT NULL,
  `status` enum('draft','invoiced','paid','failed') NOT NULL DEFAULT 'draft',
  `external_billing_id` varchar(255),
  `invoice_number` varchar(50),
  `paid_at` timestamp,
  `invoiced_at` timestamp,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `subscription_billing_cycles_id` PRIMARY KEY(`id`),
  CONSTRAINT `uk_client_cycle` UNIQUE(`client_id`,`billing_cycle_start`)
);

CREATE INDEX `billing_cycles_client_idx` ON `subscription_billing_cycles` (`client_id`);
CREATE INDEX `billing_cycles_status_idx` ON `subscription_billing_cycles` (`status`);

CREATE TABLE IF NOT EXISTS `resource_quotas` (
  `id` varchar(36) NOT NULL,
  `client_id` varchar(36) NOT NULL,
  `cpu_cores_limit` decimal(5,2),
  `memory_gb_limit` int,
  `storage_gb_limit` int,
  `bandwidth_gb_limit` int,
  `cpu_cores_current` decimal(5,2) DEFAULT '0',
  `memory_gb_current` int DEFAULT 0,
  `storage_gb_current` int DEFAULT 0,
  `cpu_warning_threshold` decimal(5,2) DEFAULT '80',
  `memory_warning_threshold` int DEFAULT 80,
  `storage_warning_threshold` int DEFAULT 80,
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `resource_quotas_id` PRIMARY KEY(`id`),
  CONSTRAINT `resource_quotas_client_unique` UNIQUE(`client_id`)
);
