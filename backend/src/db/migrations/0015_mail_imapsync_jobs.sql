-- Phase 3 T2.1: imapsync job runner.
--
-- Tracks one-shot Kubernetes Jobs that migrate mail FROM an external
-- IMAP server INTO an existing platform mailbox. The standard way to
-- onboard customers from existing mail providers (Gmail, Outlook,
-- legacy hosting, etc.).
--
-- The platform never stores the source mailbox PASSWORD in plain
-- form. It is encrypted at rest with the same OIDC_ENCRYPTION_KEY
-- helper used by mail-submit, then injected into the per-job
-- Kubernetes Secret which mounts as env vars inside the imapsync
-- container. After the Job is created the Secret is patched with
-- an ownerReference pointing at the Job's UID so K8s garbage
-- collection removes the Secret automatically when the Job is
-- deleted (TTL sweep, operator delete, or reconciler cleanup).
-- The reconciler also runs an explicit deleteNamespacedSecret on
-- its 404 cleanup path as a defense-in-depth measure.
--
-- Destination authentication uses Stalwart's `master` user via the
-- `<mailbox>%master` convention + MASTER_SECRET. This avoids storing
-- the mailbox cleartext password and matches the Roundcube SSO
-- pattern (see migration 0004_stalwart_directory.sql).
--
-- Lifecycle:
--   pending  → row inserted, K8s Job not yet created
--   running  → Job created, imapsync container active
--   succeeded → exit 0; final log_tail captured
--   failed   → exit ≠ 0 OR Job became Failed; error_message + log_tail
--   cancelled → operator-initiated DELETE; K8s Job + Secret removed

CREATE TABLE IF NOT EXISTS imap_sync_jobs (
  id varchar(36) PRIMARY KEY,
  client_id varchar(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  mailbox_id varchar(36) NOT NULL REFERENCES mailboxes(id) ON DELETE CASCADE,
  source_host varchar(255) NOT NULL,
  source_port integer NOT NULL DEFAULT 993,
  source_username varchar(255) NOT NULL,
  source_password_encrypted text NOT NULL,
  source_ssl integer NOT NULL DEFAULT 1,
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(16) NOT NULL DEFAULT 'pending',
  k8s_job_name varchar(253),
  k8s_namespace varchar(63) NOT NULL DEFAULT 'mail',
  log_tail text,
  error_message text,
  started_at timestamp,
  finished_at timestamp,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS imap_sync_jobs_client_idx
  ON imap_sync_jobs (client_id, created_at DESC);

CREATE INDEX IF NOT EXISTS imap_sync_jobs_mailbox_idx
  ON imap_sync_jobs (mailbox_id, created_at DESC);

-- Partial index — used by the reconciler to find jobs that still
-- need polling. Excludes terminal states so it stays small.
CREATE INDEX IF NOT EXISTS imap_sync_jobs_active_idx
  ON imap_sync_jobs (status) WHERE status IN ('pending', 'running');

-- Concurrency safeguard: at most ONE running/pending sync per
-- mailbox. The partial unique index makes the safeguard a hard DB
-- constraint, not just an application-level check, so two concurrent
-- POST requests can't both succeed.
CREATE UNIQUE INDEX IF NOT EXISTS imap_sync_jobs_mailbox_active_unique
  ON imap_sync_jobs (mailbox_id) WHERE status IN ('pending', 'running');
