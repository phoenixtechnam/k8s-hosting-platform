ALTER TABLE `users` ADD COLUMN `role_name` varchar(50) NOT NULL DEFAULT 'read-only' AFTER `full_name`;
