-- Migration: RBAC panel enforcement, client user support

-- Add panel and client_id to users
ALTER TABLE `users` ADD COLUMN `panel` enum('admin','client') NOT NULL DEFAULT 'admin' AFTER `role_name`;
ALTER TABLE `users` ADD COLUMN `client_id` varchar(36) AFTER `panel`;
CREATE INDEX `users_client_idx` ON `users` (`client_id`);

-- Add max_sub_users to hosting_plans
ALTER TABLE `hosting_plans` ADD COLUMN `max_sub_users` int NOT NULL DEFAULT 3 AFTER `monthly_price_usd`;

-- Add new roles
INSERT IGNORE INTO `rbac_roles` (`id`, `name`, `permissions`, `created_at`)
VALUES
  (UUID(), 'super_admin', '["*"]', NOW()),
  (UUID(), 'client_admin', '["own:*"]', NOW()),
  (UUID(), 'client_user', '["own:read"]', NOW());

-- Upgrade existing admin user to super_admin
UPDATE `users` SET `role_name` = 'super_admin' WHERE `role_name` = 'admin' AND `panel` = 'admin';
