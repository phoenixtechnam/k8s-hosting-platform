-- Optimize frequently queried columns
CREATE INDEX IF NOT EXISTS idx_domains_domain_name ON domains(domain_name);
CREATE INDEX IF NOT EXISTS idx_mailboxes_full_address ON mailboxes(full_address);
CREATE INDEX IF NOT EXISTS idx_email_domains_enabled ON email_domains(enabled);
CREATE INDEX IF NOT EXISTS idx_container_images_status ON container_images(status);
CREATE INDEX IF NOT EXISTS idx_container_images_source ON container_images(source_repo_id);
CREATE INDEX IF NOT EXISTS idx_notifications_user_read ON notifications(user_id, is_read);
CREATE INDEX IF NOT EXISTS idx_workloads_client_status ON workloads(client_id, status);
