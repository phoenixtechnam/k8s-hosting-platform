-- Migration: External DNS server management

CREATE TABLE IF NOT EXISTS `dns_servers` (
  `id` varchar(36) NOT NULL,
  `display_name` varchar(255) NOT NULL,
  `provider_type` enum('powerdns','rndc','cloudflare','route53','hetzner','mock') NOT NULL,
  `connection_config_encrypted` varchar(2000) NOT NULL,
  `zone_default_kind` enum('Native','Master') NOT NULL DEFAULT 'Native',
  `is_default` int NOT NULL DEFAULT 0,
  `enabled` int NOT NULL DEFAULT 1,
  `last_health_check` timestamp,
  `last_health_status` varchar(50),
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `dns_servers_id` PRIMARY KEY(`id`)
);
