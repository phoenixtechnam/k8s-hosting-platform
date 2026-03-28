-- Email domains (enable email per hosting domain)
CREATE TABLE IF NOT EXISTS `email_domains` (
  `id` varchar(36) NOT NULL,
  `domain_id` varchar(36) NOT NULL,
  `client_id` varchar(36) NOT NULL,
  `enabled` int NOT NULL DEFAULT 1,
  `dkim_selector` varchar(63) NOT NULL DEFAULT 'default',
  `dkim_private_key_encrypted` text DEFAULT NULL,
  `dkim_public_key` text DEFAULT NULL,
  `max_mailboxes` int NOT NULL DEFAULT 50,
  `max_quota_mb` int NOT NULL DEFAULT 10240,
  `catch_all_address` varchar(255) DEFAULT NULL,
  `mx_provisioned` int NOT NULL DEFAULT 0,
  `spf_provisioned` int NOT NULL DEFAULT 0,
  `dkim_provisioned` int NOT NULL DEFAULT 0,
  `dmarc_provisioned` int NOT NULL DEFAULT 0,
  `spam_threshold_junk` decimal(4,1) NOT NULL DEFAULT 5.0,
  `spam_threshold_reject` decimal(4,1) NOT NULL DEFAULT 10.0,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email_domains_domain_unique` (`domain_id`),
  KEY `email_domains_client_idx` (`client_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Mailboxes (Stalwart reads this table directly for auth via SQL directory)
CREATE TABLE IF NOT EXISTS `mailboxes` (
  `id` varchar(36) NOT NULL,
  `email_domain_id` varchar(36) NOT NULL,
  `client_id` varchar(36) NOT NULL,
  `local_part` varchar(64) NOT NULL,
  `full_address` varchar(255) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `display_name` varchar(255) DEFAULT NULL,
  `quota_mb` int NOT NULL DEFAULT 1024,
  `used_mb` int NOT NULL DEFAULT 0,
  `status` enum('active','disabled') NOT NULL DEFAULT 'active',
  `mailbox_type` enum('mailbox','forward_only') NOT NULL DEFAULT 'mailbox',
  `auto_reply` int NOT NULL DEFAULT 0,
  `auto_reply_subject` varchar(255) DEFAULT NULL,
  `auto_reply_body` text DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `mailboxes_address_unique` (`full_address`),
  KEY `mailboxes_client_idx` (`client_id`),
  KEY `mailboxes_domain_idx` (`email_domain_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Mailbox access mapping (platform users → mailboxes)
CREATE TABLE IF NOT EXISTS `mailbox_access` (
  `id` varchar(36) NOT NULL,
  `user_id` varchar(36) NOT NULL,
  `mailbox_id` varchar(36) NOT NULL,
  `access_level` enum('full','read_only') NOT NULL DEFAULT 'full',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `mailbox_access_unique` (`user_id`, `mailbox_id`),
  KEY `mailbox_access_user_idx` (`user_id`),
  KEY `mailbox_access_mailbox_idx` (`mailbox_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Email aliases / forwarding
CREATE TABLE IF NOT EXISTS `email_aliases` (
  `id` varchar(36) NOT NULL,
  `email_domain_id` varchar(36) NOT NULL,
  `client_id` varchar(36) NOT NULL,
  `source_address` varchar(255) NOT NULL,
  `destination_addresses` json NOT NULL,
  `enabled` int NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `email_aliases_source_unique` (`source_address`),
  KEY `email_aliases_client_idx` (`client_id`),
  KEY `email_aliases_domain_idx` (`email_domain_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- SMTP relay configurations
CREATE TABLE IF NOT EXISTS `smtp_relay_configs` (
  `id` varchar(36) NOT NULL,
  `name` varchar(255) NOT NULL,
  `provider_type` enum('direct','mailgun','postmark') NOT NULL,
  `is_default` int NOT NULL DEFAULT 0,
  `enabled` int NOT NULL DEFAULT 1,
  `smtp_host` varchar(255) DEFAULT NULL,
  `smtp_port` int DEFAULT 587,
  `auth_username` varchar(255) DEFAULT NULL,
  `auth_password_encrypted` varchar(500) DEFAULT NULL,
  `api_key_encrypted` varchar(500) DEFAULT NULL,
  `region` varchar(50) DEFAULT NULL,
  `last_tested_at` timestamp NULL DEFAULT NULL,
  `last_test_status` varchar(50) DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
