-- System Backup, Phase 1: secrets-bundle export runs.
--
-- One row per export attempt. The age-encrypted bundle (small —
-- typically <100KB for the platform-namespace Secrets list) is stored
-- inline as bytea, then scrubbed after a successful download or once
-- the signed-URL TTL elapses (whichever comes first). The row itself
-- survives for audit — only the cleartext-equivalent payload column
-- is wiped.
--
-- See backend/src/modules/system-backup/ for the service + routes.

CREATE TABLE IF NOT EXISTS system_backup_runs (
  id                       VARCHAR(36)  PRIMARY KEY,
  -- 'secrets' for now; future: 'pgdump', 'stalwart-blob', 'longhorn-snap'.
  kind                     VARCHAR(32)  NOT NULL,
  -- 'pending' → 'running' → 'succeeded' | 'failed'.
  status                   VARCHAR(32)  NOT NULL DEFAULT 'pending',
  started_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at              TIMESTAMPTZ,
  size_bytes               BIGINT,
  sha256                   VARCHAR(64),
  -- Operator-error envelope JSONB so the UI can render <ErrorPanel>.
  -- See backend/src/shared/operator-error.ts.
  error_envelope           JSONB,
  -- Audit: who triggered the export.
  operator_user_id         VARCHAR(36),
  operator_ip              VARCHAR(45),
  operator_user_agent      VARCHAR(500),
  -- Inventory of {namespace,name} pairs included in the bundle.
  -- JSONB so we can render it in the UI without re-decrypting.
  manifest                 JSONB,
  -- Encrypted bundle payload, age-encrypted to the operator recipient.
  -- Wiped (set NULL + size 0) after first successful download or TTL.
  payload                  BYTEA,
  -- One-time HMAC token (sha256-hashed; never store raw token at rest).
  -- See modules/system-backup/download-token.ts.
  download_token_hash      VARCHAR(64),
  download_url_expires_at  TIMESTAMPTZ,
  downloaded_at            TIMESTAMPTZ,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now()
);

-- Most-recent-first listing in the admin UI is by created_at.
CREATE INDEX IF NOT EXISTS system_backup_runs_created_idx
  ON system_backup_runs(created_at DESC);

-- Token lookup on the download route. WHERE clause keeps the index
-- tiny: only undownloaded, unexpired rows are candidates. The
-- download route still validates expiry + downloaded_at IS NULL
-- inside the lookup (defence in depth), but the partial index keeps
-- the hot path fast.
CREATE INDEX IF NOT EXISTS system_backup_runs_token_idx
  ON system_backup_runs(download_token_hash)
  WHERE download_token_hash IS NOT NULL AND downloaded_at IS NULL;

-- Status filter for the admin UI ("show running exports").
CREATE INDEX IF NOT EXISTS system_backup_runs_status_idx
  ON system_backup_runs(status);
