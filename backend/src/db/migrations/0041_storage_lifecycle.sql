-- Storage lifecycle: snapshots, operations, client state extensions.
--
-- Adds:
--   - Two new tables: storage_snapshots, storage_operations.
--   - Four new enums for snapshot kind/status, op type, and lifecycle state.
--   - Two new columns on clients: storage_lifecycle_state, active_storage_op_id.
--   - Extends client_status enum with 'archived'.
--
-- Idempotent against a fresh DB. On an existing DB the enum add + column
-- adds are no-ops if already present.

-- ─── Enum additions / creations ─────────────────────────────────────────

ALTER TYPE client_status ADD VALUE IF NOT EXISTS 'archived';

DO $$
BEGIN
  CREATE TYPE storage_lifecycle_state AS ENUM (
    'idle', 'snapshotting', 'quiescing', 'replacing', 'restoring', 'unquiescing', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;

DO $$
BEGIN
  CREATE TYPE storage_operation_type AS ENUM (
    'snapshot', 'resize', 'suspend', 'resume', 'archive', 'restore'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;

DO $$
BEGIN
  CREATE TYPE storage_snapshot_kind AS ENUM (
    'manual', 'pre-resize', 'pre-suspend', 'pre-archive', 'scheduled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;

DO $$
BEGIN
  CREATE TYPE storage_snapshot_status AS ENUM (
    'creating', 'ready', 'expired', 'failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END$$;

-- ─── clients table extensions ──────────────────────────────────────────

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS storage_lifecycle_state storage_lifecycle_state NOT NULL DEFAULT 'idle',
  ADD COLUMN IF NOT EXISTS active_storage_op_id varchar(36);

-- ─── storage_snapshots ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS storage_snapshots (
  id varchar(36) PRIMARY KEY,
  client_id varchar(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  kind storage_snapshot_kind NOT NULL,
  status storage_snapshot_status NOT NULL DEFAULT 'creating',
  archive_path varchar(500) NOT NULL,
  size_bytes numeric(20, 0) NOT NULL DEFAULT 0,
  sha256 varchar(64),
  expires_at timestamp,
  label text,
  last_error text,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS storage_snapshots_client_idx ON storage_snapshots(client_id);
CREATE INDEX IF NOT EXISTS storage_snapshots_status_idx ON storage_snapshots(status);
CREATE INDEX IF NOT EXISTS storage_snapshots_expires_idx ON storage_snapshots(expires_at);

-- ─── storage_operations ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS storage_operations (
  id varchar(36) PRIMARY KEY,
  client_id varchar(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  op_type storage_operation_type NOT NULL,
  state storage_lifecycle_state NOT NULL DEFAULT 'idle',
  progress_pct integer NOT NULL DEFAULT 0,
  progress_message text,
  params jsonb,
  snapshot_id varchar(36) REFERENCES storage_snapshots(id) ON DELETE SET NULL,
  rolled_back integer NOT NULL DEFAULT 0,
  last_error text,
  triggered_by_user_id varchar(36),
  created_at timestamp NOT NULL DEFAULT now(),
  completed_at timestamp
);

CREATE INDEX IF NOT EXISTS storage_operations_client_idx ON storage_operations(client_id);
CREATE INDEX IF NOT EXISTS storage_operations_state_idx ON storage_operations(state);
CREATE INDEX IF NOT EXISTS storage_operations_created_idx ON storage_operations(created_at);
