-- Migration 0039: System and client timezone support

ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "timezone" VARCHAR(50) NOT NULL DEFAULT 'UTC';
ALTER TABLE "clients" ADD COLUMN IF NOT EXISTS "timezone" VARCHAR(50);
