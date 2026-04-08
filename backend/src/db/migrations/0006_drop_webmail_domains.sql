-- Phase 2c: architectural pivot — drop per-client custom webmail domains.
--
-- Phase 2b introduced a `webmail_domains` table + CRUD API that let each
-- client pick an arbitrary hostname for their Roundcube webmail. On
-- reflection this was the wrong abstraction for the project's scale
-- (50-100 clients, <$200/mo budget): it added a whole class of failure
-- modes (stuck rows, naming collisions, reserved-TLD validation, silent
-- overwrites), a CRUD surface area, and operational burden for a feature
-- that almost no client at this scale actually asks for.
--
-- Phase 2c replaces it with a derived convention: every enabled email
-- domain automatically gets `webmail.<domain>` served by the shared
-- Roundcube Service, behind an Ingress in the client's own namespace.
-- The hostname is derived, not user-input; there's nothing for a client
-- or admin to misconfigure.
--
-- See:
--   - docs/06-features/MAIL_SERVER_IMPLEMENTATION_STATUS.md (Phase 2c section)
--   - docs/06-features/TLS_CERTIFICATE_STRATEGY.md (unified cert story)

DROP INDEX IF EXISTS webmail_domains_client_unique;
DROP INDEX IF EXISTS webmail_domains_hostname_unique;
DROP TABLE IF EXISTS webmail_domains;
