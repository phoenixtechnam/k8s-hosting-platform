-- Migration: Add exposes JSON column to container_images

ALTER TABLE `container_images` ADD COLUMN `exposes` json;
