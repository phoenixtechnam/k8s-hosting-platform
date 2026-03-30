-- Ingress routes: per-hostname routing with CNAME-chain architecture
-- Decouples DNS records from HTTP routing. Each hostname gets its own
-- Ingress rule + TLS certificate, mapped to a workload Service.

CREATE TABLE IF NOT EXISTS `ingress_routes` (
  `id` VARCHAR(36) NOT NULL,
  `domain_id` VARCHAR(36) NOT NULL,
  `hostname` VARCHAR(255) NOT NULL,
  `workload_id` VARCHAR(36) DEFAULT NULL,
  `ingress_cname` VARCHAR(255) NOT NULL,
  `node_hostname` VARCHAR(255) DEFAULT NULL,
  `is_apex` TINYINT(1) NOT NULL DEFAULT 0,
  `tls_mode` ENUM('auto', 'custom', 'none') NOT NULL DEFAULT 'auto',
  `status` ENUM('active', 'pending', 'error') NOT NULL DEFAULT 'pending',
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `ingress_routes_hostname_unique` (`hostname`),
  KEY `ingress_routes_domain_idx` (`domain_id`),
  KEY `ingress_routes_workload_idx` (`workload_id`),
  KEY `ingress_routes_status_idx` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Platform ingress settings (defaults for local DinD)
INSERT IGNORE INTO `platform_settings` (`key`, `value`) VALUES
  ('ingress_base_domain', 'ingress.localhost'),
  ('ingress_default_ipv4', '127.0.0.1');
