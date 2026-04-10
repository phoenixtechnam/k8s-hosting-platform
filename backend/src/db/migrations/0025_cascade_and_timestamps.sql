-- 0025_cascade_and_timestamps.sql
-- F4: Add ON DELETE CASCADE to tables with clientId → clients.id FK
-- M2: Add missing created_at columns
-- M1: Add unique index on mailbox_quota_events(mailbox_id, threshold)

-- ─── F4: ON DELETE CASCADE for clientId foreign keys ───

ALTER TABLE domains DROP CONSTRAINT IF EXISTS domains_client_id_clients_id_fk,
  ADD CONSTRAINT domains_client_id_clients_id_fk FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_client_id_clients_id_fk,
  ADD CONSTRAINT deployments_client_id_clients_id_fk FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

ALTER TABLE backups DROP CONSTRAINT IF EXISTS backups_client_id_clients_id_fk,
  ADD CONSTRAINT backups_client_id_clients_id_fk FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

ALTER TABLE cron_jobs DROP CONSTRAINT IF EXISTS cron_jobs_client_id_clients_id_fk,
  ADD CONSTRAINT cron_jobs_client_id_clients_id_fk FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

ALTER TABLE ssh_keys DROP CONSTRAINT IF EXISTS ssh_keys_client_id_clients_id_fk,
  ADD CONSTRAINT ssh_keys_client_id_clients_id_fk FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

ALTER TABLE subscription_billing_cycles DROP CONSTRAINT IF EXISTS subscription_billing_cycles_client_id_clients_id_fk,
  ADD CONSTRAINT subscription_billing_cycles_client_id_clients_id_fk FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

ALTER TABLE resource_quotas DROP CONSTRAINT IF EXISTS resource_quotas_client_id_clients_id_fk,
  ADD CONSTRAINT resource_quotas_client_id_clients_id_fk FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

ALTER TABLE ssl_certificates DROP CONSTRAINT IF EXISTS ssl_certificates_client_id_clients_id_fk,
  ADD CONSTRAINT ssl_certificates_client_id_clients_id_fk FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

ALTER TABLE usage_metrics DROP CONSTRAINT IF EXISTS usage_metrics_client_id_clients_id_fk,
  ADD CONSTRAINT usage_metrics_client_id_clients_id_fk FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

ALTER TABLE provisioning_tasks DROP CONSTRAINT IF EXISTS provisioning_tasks_client_id_clients_id_fk,
  ADD CONSTRAINT provisioning_tasks_client_id_clients_id_fk FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

ALTER TABLE users DROP CONSTRAINT IF EXISTS users_client_id_clients_id_fk,
  ADD CONSTRAINT users_client_id_clients_id_fk FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE CASCADE;

-- NOTE: audit_logs intentionally NOT cascaded — audit data must persist after client deletion.

-- ─── M2: Add missing created_at columns ───

ALTER TABLE dns_records ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
ALTER TABLE resource_quotas ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();
ALTER TABLE oidc_global_settings ADD COLUMN IF NOT EXISTS created_at TIMESTAMP NOT NULL DEFAULT NOW();

-- ─── M1: Add unique index on mailbox_quota_events ───

CREATE UNIQUE INDEX IF NOT EXISTS mailbox_quota_events_unique ON mailbox_quota_events(mailbox_id, threshold);
