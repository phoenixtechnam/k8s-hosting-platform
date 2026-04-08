-- Phase 2c.5: derived webmail access for every enabled email domain.
--
-- Every email domain gets webmail.domain by default. The backend
-- provisions a k8s Ingress in the client own namespace (cross-
-- namespace pointing at the shared Roundcube Service via ExternalName)
-- and references the wildcard or per-hostname TLS secret from the
-- certificates module.
--
-- Setting defaults to 1 so existing rows get webmail-on automatically
-- on next reconcile. Operators can toggle per-domain via the admin UI
-- if a client does not want webmail for a particular domain.

ALTER TABLE email_domains
  ADD COLUMN IF NOT EXISTS webmail_enabled integer NOT NULL DEFAULT 1;
