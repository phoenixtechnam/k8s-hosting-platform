-- Phase 3 T5.1: sendmail compatibility via per-client SMTP submission
-- credentials.
--
-- Traditional web apps (WordPress, PHP mail(), classic CGI scripts)
-- expect `/usr/sbin/sendmail` to exist and accept messages on stdin.
-- In our k8s architecture the mail server is a separate pod, so we
-- ship a `sendmail`-compatible wrapper (msmtp in the base image) that
-- authenticates to Stalwart's submission port (587) using per-client
-- credentials.
--
-- The credentials are stored in this table so the platform can:
--   1. Provision them when a client first enables email
--   2. Rotate them on demand via the admin API
--   3. Expose a Stalwart SQL directory view that authenticates
--      submissions (see migration 0014_stalwart_submit_view.sql)
--
-- The password is stored twice:
--   - `password_encrypted`: the cleartext password encrypted at rest
--     via the platform's OIDC encryption key. This is what gets
--     written to the customer PVC (hidden at `.platform/sendmail-auth`)
--     so pods can authenticate to Stalwart.
--   - `password_hash`: a bcrypt hash consumed by Stalwart through the
--     `stalwart.submit_principals` view. Stalwart never sees the
--     cleartext.
--
-- The `username` is deterministic: `submit-<client_id>` — scoped per
-- customer, not per mailbox, per the user's preference ("per customer
-- if feasible, otherwise per domain"). Rate limits apply at the
-- customer level via the existing [queue.throttle] configuration
-- keyed on the `sender` principal.
--
-- When retired/rotated, the OLD row stays in the table with
-- `revoked_at` set so audit logs can trace who-used-what-when. The
-- active row is the one with the newest `created_at` and
-- `revoked_at IS NULL`.

CREATE TABLE IF NOT EXISTS mail_submit_credentials (
  id varchar(36) PRIMARY KEY,
  client_id varchar(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  username varchar(128) NOT NULL,
  password_encrypted text NOT NULL,
  password_hash text NOT NULL,
  -- Optional note for auditing (rotation reason, etc.)
  note varchar(255),
  created_at timestamp NOT NULL DEFAULT now(),
  revoked_at timestamp,
  last_used_at timestamp
);

CREATE INDEX IF NOT EXISTS mail_submit_credentials_client_idx
  ON mail_submit_credentials (client_id);

CREATE INDEX IF NOT EXISTS mail_submit_credentials_active_idx
  ON mail_submit_credentials (client_id) WHERE revoked_at IS NULL;

-- Username is unique per active credential to make Stalwart's SQL
-- directory view simple. Revoked rows keep their username for audit
-- but cannot collide with a new active credential because the partial
-- unique index excludes them.
CREATE UNIQUE INDEX IF NOT EXISTS mail_submit_credentials_username_active_unique
  ON mail_submit_credentials (username) WHERE revoked_at IS NULL;
