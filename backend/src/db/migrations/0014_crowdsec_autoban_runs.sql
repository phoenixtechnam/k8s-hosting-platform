-- F3 — Audit table for WAF auto-ban evaluator decisions.
--
-- Every tick of the autoban scheduler (60s) groups new waf_logs rows
-- since the last watermark by source_ip + evaluates threshold/severity/
-- excluded-rule filters. For each IP that triggers a ban (or is skipped
-- for a documented reason), we write one row here. The admin UI shows
-- the most-recent 50 rows as a "what the auto-ban did" timeline.
--
-- Watermark advance: the most-recent waf_logs.id processed is stored in
-- platform_settings under security.crowdsec.autoban_watermark_id so a
-- platform-api restart doesn't re-evaluate already-seen events. Tracked
-- here as source-of-truth for human inspection.

CREATE TABLE IF NOT EXISTS "crowdsec_autoban_runs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "triggered_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "source_ip" VARCHAR(45) NOT NULL,
  "hostname" VARCHAR(255),
  "rule_ids" JSONB NOT NULL,
  "event_count" INTEGER NOT NULL CHECK ("event_count" >= 0),
  "window_seconds" INTEGER NOT NULL CHECK ("window_seconds" > 0),
  "ban_duration" VARCHAR(16) NOT NULL,
  "ban_id" BIGINT,
  "outcome" VARCHAR(32) NOT NULL CHECK ("outcome" IN (
    'banned',                  -- ban successfully added to LAPI
    'skipped_allowlisted',     -- source_ip is in CrowdSec allowlist (F2)
    'skipped_excluded_rule',   -- only excluded rule IDs in the batch
    'skipped_already_banned',  -- LRU shows we banned this IP within the last 5 min
    'skipped_below_threshold', -- recorded for visibility — count < threshold
    'failed'                   -- addBan threw — outcome_detail has why
  )),
  "outcome_detail" TEXT
);

CREATE INDEX "crowdsec_autoban_runs_triggered_at_idx" ON "crowdsec_autoban_runs" ("triggered_at" DESC);
CREATE INDEX "crowdsec_autoban_runs_source_ip_idx" ON "crowdsec_autoban_runs" ("source_ip");
