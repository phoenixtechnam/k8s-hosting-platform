-- Migration: Add provisioning_tasks table for async K8s provisioning

CREATE TABLE `provisioning_tasks` (
  `id` VARCHAR(36) NOT NULL PRIMARY KEY,
  `client_id` VARCHAR(36) NOT NULL,
  `type` ENUM('provision_namespace', 'deploy_workload', 'deprovision') NOT NULL,
  `status` ENUM('pending', 'running', 'completed', 'failed') NOT NULL DEFAULT 'pending',
  `current_step` VARCHAR(100),
  `total_steps` INT NOT NULL DEFAULT 0,
  `completed_steps` INT NOT NULL DEFAULT 0,
  `steps_log` JSON,
  `error_message` TEXT,
  `started_by` VARCHAR(36),
  `started_at` TIMESTAMP NULL,
  `completed_at` TIMESTAMP NULL,
  `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `provisioning_tasks_client_idx` (`client_id`),
  INDEX `provisioning_tasks_status_idx` (`status`)
);

-- Add provisioning_status to clients table
ALTER TABLE `clients` ADD COLUMN `provisioning_status` ENUM('unprovisioned', 'provisioning', 'provisioned', 'failed') NOT NULL DEFAULT 'unprovisioned';
