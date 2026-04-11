-- 0029_route_level_settings.sql
-- Add route-level ingress settings to ingress_routes,
-- create route_auth_users and waf_logs tables.

-- ── Redirect settings ──────────────────────────────────────────────────────

ALTER TABLE ingress_routes ADD COLUMN force_https integer NOT NULL DEFAULT 1;
ALTER TABLE ingress_routes ADD COLUMN www_redirect varchar(20) NOT NULL DEFAULT 'none';
ALTER TABLE ingress_routes ADD COLUMN redirect_url varchar(500);

-- ── Security settings ──────────────────────────────────────────────────────

ALTER TABLE ingress_routes ADD COLUMN basic_auth_enabled integer NOT NULL DEFAULT 0;
ALTER TABLE ingress_routes ADD COLUMN basic_auth_realm varchar(255);
ALTER TABLE ingress_routes ADD COLUMN ip_allowlist text;
ALTER TABLE ingress_routes ADD COLUMN rate_limit_rps integer;
ALTER TABLE ingress_routes ADD COLUMN rate_limit_connections integer;
ALTER TABLE ingress_routes ADD COLUMN rate_limit_burst_multiplier integer;

-- ── WAF settings ───────────────────────────────────────────────────────────

ALTER TABLE ingress_routes ADD COLUMN waf_enabled integer NOT NULL DEFAULT 1;
ALTER TABLE ingress_routes ADD COLUMN waf_owasp_crs integer NOT NULL DEFAULT 1;
ALTER TABLE ingress_routes ADD COLUMN waf_anomaly_threshold integer NOT NULL DEFAULT 10;
ALTER TABLE ingress_routes ADD COLUMN waf_excluded_rules text;

-- ── Advanced settings ──────────────────────────────────────────────────────

ALTER TABLE ingress_routes ADD COLUMN custom_error_codes varchar(100);
ALTER TABLE ingress_routes ADD COLUMN custom_error_path varchar(500);
ALTER TABLE ingress_routes ADD COLUMN additional_headers jsonb;

-- ── Route auth users table ─────────────────────────────────────────────────

CREATE TABLE route_auth_users (
  id varchar(36) PRIMARY KEY,
  route_id varchar(36) NOT NULL REFERENCES ingress_routes(id) ON DELETE CASCADE,
  username varchar(100) NOT NULL,
  password_hash varchar(255) NOT NULL,
  enabled integer NOT NULL DEFAULT 1,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX route_auth_users_route_idx ON route_auth_users(route_id);
CREATE UNIQUE INDEX route_auth_users_route_username ON route_auth_users(route_id, username);

-- ── WAF logs table ─────────────────────────────────────────────────────────

CREATE TABLE waf_logs (
  id varchar(36) PRIMARY KEY,
  route_id varchar(36) NOT NULL REFERENCES ingress_routes(id) ON DELETE CASCADE,
  client_id varchar(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  rule_id varchar(50) NOT NULL,
  severity varchar(20) NOT NULL,
  message text NOT NULL,
  request_uri text,
  request_method varchar(10),
  source_ip varchar(45),
  matched_data text,
  created_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX waf_logs_route_idx ON waf_logs(route_id, timestamp);
CREATE INDEX waf_logs_client_idx ON waf_logs(client_id);
