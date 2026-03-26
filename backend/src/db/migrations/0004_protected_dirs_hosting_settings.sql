-- Migration: Add protected_directories, protected_directory_users, hosting_settings tables

CREATE TABLE IF NOT EXISTS `protected_directories` (
  `id` varchar(36) NOT NULL,
  `domain_id` varchar(36) NOT NULL,
  `path` varchar(500) NOT NULL,
  `realm` varchar(255) NOT NULL DEFAULT 'Restricted Area',
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `protected_directories_id` PRIMARY KEY(`id`)
);

CREATE INDEX `protected_dirs_domain_idx` ON `protected_directories` (`domain_id`);

CREATE TABLE IF NOT EXISTS `protected_directory_users` (
  `id` varchar(36) NOT NULL,
  `directory_id` varchar(36) NOT NULL,
  `username` varchar(255) NOT NULL,
  `password_hash` varchar(255) NOT NULL,
  `enabled` int NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `protected_directory_users_id` PRIMARY KEY(`id`),
  CONSTRAINT `protected_dir_users_unique` UNIQUE(`directory_id`,`username`)
);

CREATE INDEX `protected_dir_users_dir_idx` ON `protected_directory_users` (`directory_id`);

CREATE TABLE IF NOT EXISTS `hosting_settings` (
  `id` varchar(36) NOT NULL,
  `domain_id` varchar(36) NOT NULL,
  `redirect_www` int NOT NULL DEFAULT 0,
  `redirect_https` int NOT NULL DEFAULT 1,
  `forward_external` varchar(500),
  `webroot_path` varchar(500) NOT NULL DEFAULT '/var/www/html',
  `hosting_enabled` int NOT NULL DEFAULT 1,
  `created_at` timestamp NOT NULL DEFAULT (now()),
  `updated_at` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `hosting_settings_id` PRIMARY KEY(`id`),
  CONSTRAINT `hosting_settings_domain_unique` UNIQUE(`domain_id`)
);
