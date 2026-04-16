-- Migration 0038: AI budget, default provider, admin-only flag, currency symbol

-- Add admin_only and is_default to ai_models
ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "admin_only" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ai_models" ADD COLUMN IF NOT EXISTS "is_default" BOOLEAN NOT NULL DEFAULT false;

-- Add currency symbol to system_settings
ALTER TABLE "system_settings" ADD COLUMN IF NOT EXISTS "currency_symbol" VARCHAR(5) NOT NULL DEFAULT '$';

-- Add weekly AI budget to hosting_plans (in cents to avoid floating point)
ALTER TABLE "hosting_plans" ADD COLUMN IF NOT EXISTS "weekly_ai_budget_cents" INTEGER NOT NULL DEFAULT 100;

-- Add weekly AI budget override per client
ALTER TABLE "resource_quotas" ADD COLUMN IF NOT EXISTS "weekly_ai_budget_cents" INTEGER;
