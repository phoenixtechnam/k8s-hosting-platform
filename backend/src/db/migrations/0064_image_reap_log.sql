-- Migration 0064: image reap log
-- Records every image removal attempt triggered by the eager reaper,
-- manual purge, or the disk-pressure watcher.
CREATE TABLE image_reap_log (
  id BIGSERIAL PRIMARY KEY,
  image_name TEXT NOT NULL,
  image_id TEXT,                           -- sha256:... when known
  nodes_reclaimed TEXT[] NOT NULL DEFAULT '{}',
  bytes_reclaimed BIGINT NOT NULL DEFAULT 0,
  triggered_by TEXT NOT NULL,              -- 'deployment_delete' | 'manual_purge' | 'pressure_watcher'
  trigger_ref TEXT,                        -- deployment_id | actor_id | node_name
  succeeded BOOLEAN NOT NULL DEFAULT FALSE,
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_image_reap_log_created_at ON image_reap_log (created_at DESC);
CREATE INDEX idx_image_reap_log_image ON image_reap_log (image_name);
