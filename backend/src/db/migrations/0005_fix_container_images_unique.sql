-- Migration: Change container_images unique constraint from code-only to (code, source_repo_id)
-- This allows the same workload code from different repositories

DROP INDEX `container_images_code_unique` ON `container_images`;

CREATE UNIQUE INDEX `container_images_code_repo_unique` ON `container_images` (`code`, `source_repo_id`);
