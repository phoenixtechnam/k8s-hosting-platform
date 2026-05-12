-- Tracks live rsync migrations of the Stalwart RocksDB local-path PVC
CREATE TABLE IF NOT EXISTS mail_migration_runs (
  id varchar(36) PRIMARY KEY,
  source_node varchar(253) NOT NULL,
  target_node varchar(253) NOT NULL,
  state varchar(32) NOT NULL DEFAULT 'queued',
  current_step varchar(64),
  progress_bytes bigint,
  preflight_job_name varchar(253),
  rsync_job_name varchar(253),
  verify_job_name varchar(253),
  error_message text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  triggered_by varchar(64) NOT NULL DEFAULT 'operator'
);
