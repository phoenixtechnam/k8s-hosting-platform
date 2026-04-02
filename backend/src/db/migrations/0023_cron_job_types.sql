-- 0023_cron_job_types.sql
-- Add dual cron job types: webcron (HTTP URL) and deployment (K8s command)

ALTER TABLE `cron_jobs`
  ADD COLUMN `type` enum('webcron','deployment') NOT NULL DEFAULT 'webcron' AFTER `name`,
  ADD COLUMN `url` varchar(2000) DEFAULT NULL AFTER `command`,
  ADD COLUMN `http_method` enum('GET','POST','PUT') DEFAULT 'GET' AFTER `url`,
  ADD COLUMN `deployment_id` varchar(36) DEFAULT NULL AFTER `http_method`,
  ADD COLUMN `last_run_duration_ms` int DEFAULT NULL AFTER `last_run_status`,
  ADD COLUMN `last_run_response_code` int DEFAULT NULL AFTER `last_run_duration_ms`,
  ADD COLUMN `last_run_output` text DEFAULT NULL AFTER `last_run_response_code`,
  MODIFY COLUMN `command` text DEFAULT NULL;
