-- Phase 1.5 of tenant-backup-v2 (ADR-036, multi-region/DR section):
-- region tagging, DR recovery key, external read-only repo registry,
-- bundle schema version on per-repo state.

-- ─── tenant_backup_v2_settings: region + DR recovery ────────────────────
-- region_id_override is operator-set when the auto-derived value
-- (slugified PLATFORM_BASE_DOMAIN) needs to be different (e.g. when
-- two clusters share a domain but the operator wants distinct tags).
ALTER TABLE tenant_backup_v2_settings
  ADD COLUMN IF NOT EXISTS region_id_override VARCHAR(63);

-- Encrypted-at-rest 32-byte secret used to derive a per-tenant
-- DR-recovery password (HKDF info=`dr-recovery:${clientId}`).
-- After every successful backup for a (clientId, component) the
-- orchestrator runs `restic key add` so the same DR password also
-- opens the repo. Region B operator receives this key out-of-band
-- and reproduces the password deterministically.
--
-- NULL = DR auto-add disabled (operator runs Option B / one-shot
-- migration keys only).
ALTER TABLE tenant_backup_v2_settings
  ADD COLUMN IF NOT EXISTS dr_recovery_key_encrypted TEXT;

-- ─── tenant_restic_repo_state: schema version + source region ───────────
-- bundle_schema_version is the BUNDLE_SCHEMA_VERSION value that was in
-- effect when this repo's most recent snapshot was taken. Restore code
-- refuses to restore a snapshot with bundle_schema_version > local
-- (forward-incompat).
--
-- Reviewer #11 LOW: existing rows from migration 0093 (Phase 1 only)
-- predate the multi-region tag schema, so we MUST NOT default them to
-- 2 — they have no `bundle-version=2` tag on their snapshots, and the
-- restore-side code uses this column as the authoritative answer to
-- "what is on the wire". Per ADR-036 explicit decision, no backwards
-- compatibility with legacy bundles: existing Phase-1 snapshots are
-- deleted at cutover. We still default new rows (column NULL on
-- existing rows; orchestrator writes the right version on next backup).
ALTER TABLE tenant_restic_repo_state
  ADD COLUMN IF NOT EXISTS bundle_schema_version INT;

-- Source region of this repo. For repos created locally this is the
-- local region id. Set on cross-region restored rows so admin UI can
-- show "originally backed up in region X".
ALTER TABLE tenant_restic_repo_state
  ADD COLUMN IF NOT EXISTS source_region_id VARCHAR(63);

-- Tracks whether the DR-recovery key has already been added to this
-- per-tenant repo via `restic key add`. Set after a successful add;
-- skipped on subsequent backups. Cleared by the rotation sweeper when
-- DR_RECOVERY_KEY rotates.
ALTER TABLE tenant_restic_repo_state
  ADD COLUMN IF NOT EXISTS dr_key_added_at TIMESTAMPTZ;

-- ─── external_backup_repos: Region B's mounted view of Region A repos ───
--
-- Operator registers a backup_configurations row (S3/SFTP) as an
-- external read-only mount. The cross-region restore executor only
-- accepts source repos that have an entry here — the registry IS the
-- allowlist.
--
-- read_only is hard-defaulted TRUE; there is no UI path to flip it.
-- A "writable external" would conflict with the source region's
-- ownership of forget/prune cadence.
CREATE TABLE IF NOT EXISTS external_backup_repos (
  id                          VARCHAR(36) PRIMARY KEY,
  -- The backup_configurations row that holds the read access creds
  -- (S3 read-only IAM key, or an SFTP key restricted to read).
  target_config_id            VARCHAR(36) NOT NULL
    REFERENCES backup_configurations(id) ON DELETE RESTRICT,
  -- Source region id as it appears in the snapshot tags. Operator
  -- enters at registration time; verified against actual snapshot
  -- tags on first list operation.
  source_region_id            VARCHAR(63) NOT NULL,
  -- Encrypted DR-recovery key handed off out-of-band. NULL only when
  -- the operator is using Option B (one-shot keys per migration).
  dr_recovery_key_encrypted   TEXT,
  -- Free-text label for the admin UI ("eu-fsn1 archive", "DR mirror").
  label                       VARCHAR(255) NOT NULL,
  read_only                   BOOLEAN NOT NULL DEFAULT TRUE
    CHECK (read_only = TRUE),
  -- Wall-clock of the last successful `restic snapshots` against this
  -- repo. NULL = never reached. Updated by the registration probe and
  -- by every cross-region restore.
  last_seen_at                TIMESTAMPTZ,
  added_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
  added_by_user_id            VARCHAR(36)
    REFERENCES users(id) ON DELETE SET NULL,
  notes                       TEXT
);

CREATE INDEX IF NOT EXISTS external_backup_repos_target_idx
  ON external_backup_repos (target_config_id);
CREATE INDEX IF NOT EXISTS external_backup_repos_region_idx
  ON external_backup_repos (source_region_id);
