-- Deployment-scoped resource naming + soft-delete + error tracking

-- Add resource suffix for K8s resource naming (6-char hex from deployment UUID)
ALTER TABLE `deployments` ADD COLUMN `resource_suffix` varchar(8) NOT NULL DEFAULT '' AFTER `memory_request`;

-- Add soft-delete support
ALTER TABLE `deployments` ADD COLUMN `deleted_at` timestamp NULL AFTER `last_upgraded_at`;

-- Add error tracking
ALTER TABLE `deployments` ADD COLUMN `last_error` text NULL AFTER `last_upgraded_at`;

-- Extend status enum to include 'deleted'
ALTER TABLE `deployments` MODIFY COLUMN `status` enum('deploying','running','stopped','failed','deleting','upgrading','pending','deleted') NOT NULL DEFAULT 'pending';

-- Backfill resource_suffix for existing deployments (use first 6 chars of id)
UPDATE `deployments` SET `resource_suffix` = SUBSTRING(`id`, 1, 6) WHERE `resource_suffix` = '';
