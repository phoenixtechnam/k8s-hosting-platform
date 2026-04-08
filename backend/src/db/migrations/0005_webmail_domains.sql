-- Phase 2b: per-client custom webmail hostname.
--
-- Roundcube serves all clients from a single deployment. Each client can
-- optionally set a custom hostname like `webmail.client-a.com`. The
-- backend creates a k8s Ingress + cert-manager Certificate when a row is
-- inserted, and deletes them on row removal.
--
-- One hostname per client (unique on client_id) for MVP. Phase 2c can
-- relax this and add a status enum, ownership verification, etc.
--
-- See backend/src/modules/webmail-domains/ for the service layer.

CREATE TABLE IF NOT EXISTS webmail_domains (
  id varchar(36) PRIMARY KEY,
  client_id varchar(36) NOT NULL,
  hostname varchar(255) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'pending',
  ingress_provisioned integer NOT NULL DEFAULT 0,
  certificate_provisioned integer NOT NULL DEFAULT 0,
  created_at timestamp NOT NULL DEFAULT now(),
  updated_at timestamp NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS webmail_domains_client_unique
  ON webmail_domains (client_id);

CREATE UNIQUE INDEX IF NOT EXISTS webmail_domains_hostname_unique
  ON webmail_domains (hostname);
