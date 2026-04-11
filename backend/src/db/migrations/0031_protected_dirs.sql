-- 0031_protected_dirs.sql
-- Introduce per-directory password protection on ingress routes.
-- Moves basic auth from the route level to individual directory entries,
-- each with its own realm and set of auth users.

-- ── New table: route_protected_dirs ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS route_protected_dirs (
  id varchar(36) PRIMARY KEY,
  route_id varchar(36) NOT NULL REFERENCES ingress_routes(id) ON DELETE CASCADE,
  path varchar(255) NOT NULL,
  realm varchar(255) NOT NULL DEFAULT 'Restricted',
  enabled integer NOT NULL DEFAULT 1,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS route_protected_dirs_route_idx ON route_protected_dirs(route_id);
CREATE UNIQUE INDEX IF NOT EXISTS route_protected_dirs_route_path ON route_protected_dirs(route_id, path);

-- ── Re-parent auth users: add dir_id, drop route_id ─────────────────────────

ALTER TABLE route_auth_users ADD COLUMN IF NOT EXISTS dir_id varchar(36) REFERENCES route_protected_dirs(id) ON DELETE CASCADE;
-- Note: existing auth users will have null dir_id (orphaned from migration)
ALTER TABLE route_auth_users ALTER COLUMN route_id DROP NOT NULL;

-- Drop old indexes and create new dir-scoped ones
DROP INDEX IF EXISTS route_auth_users_route_username;
DROP INDEX IF EXISTS route_auth_users_route_username_unique;
DROP INDEX IF EXISTS route_auth_users_route_idx;
CREATE UNIQUE INDEX IF NOT EXISTS route_auth_users_dir_username ON route_auth_users(dir_id, username);
CREATE INDEX IF NOT EXISTS route_auth_users_dir_idx ON route_auth_users(dir_id);

-- ── Remove basic auth columns from ingress_routes ────────────────────────────

ALTER TABLE ingress_routes DROP COLUMN IF EXISTS basic_auth_enabled;
ALTER TABLE ingress_routes DROP COLUMN IF EXISTS basic_auth_realm;
