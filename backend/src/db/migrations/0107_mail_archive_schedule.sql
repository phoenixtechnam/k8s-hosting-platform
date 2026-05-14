-- Adds operator-configurable schedule for the mail archive orchestrator.
--
-- Scope: minimum-viable. Operators choose between four intervals and
-- (for daily/weekly) the UTC hour to fire. No arbitrary cron strings —
-- archive cadence is rarely finer than hourly/daily/weekly in practice
-- and a fixed enum makes the next-fire calculation trivial without
-- pulling in a cron-parser dependency.
--
-- Fields:
--   mail_archive_schedule_interval    — 'off' | 'hourly' | 'daily' | 'weekly'
--   mail_archive_schedule_hour_utc    — 0..23, used for daily/weekly only
--   mail_archive_schedule_weekday_utc — 0..6 (Sunday..Saturday), weekly only
--   mail_archive_last_scheduled_run_at— last time the in-process scheduler
--                                       fired startMailArchive(). Manually-
--                                       triggered runs DO NOT update this.
ALTER TABLE system_settings
  ADD COLUMN IF NOT EXISTS mail_archive_schedule_interval varchar(16)
    NOT NULL DEFAULT 'off' CHECK (mail_archive_schedule_interval IN ('off','hourly','daily','weekly')),
  ADD COLUMN IF NOT EXISTS mail_archive_schedule_hour_utc integer
    NOT NULL DEFAULT 2 CHECK (mail_archive_schedule_hour_utc >= 0 AND mail_archive_schedule_hour_utc <= 23),
  ADD COLUMN IF NOT EXISTS mail_archive_schedule_weekday_utc integer
    NOT NULL DEFAULT 0 CHECK (mail_archive_schedule_weekday_utc >= 0 AND mail_archive_schedule_weekday_utc <= 6),
  ADD COLUMN IF NOT EXISTS mail_archive_last_scheduled_run_at timestamptz;
