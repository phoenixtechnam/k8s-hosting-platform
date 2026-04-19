-- Migration 0040: per-user timezone for display preferences.
-- Platform-wide default lives in system_settings.timezone (0039); this
-- column lets each user override it in their User Settings page.
-- Nullable — NULL means "fall back to system default".

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "timezone" VARCHAR(50);
