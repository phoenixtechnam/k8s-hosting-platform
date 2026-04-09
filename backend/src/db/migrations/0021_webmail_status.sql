-- Round-4 Phase 2 — track webmail provisioning status per email_domain.
--
-- Background: in round-4 phase 1 the user reported that client
-- 67893794-2e9f-4af6-a9b5-798c33d915eb received a "Webmail
-- provisioning failed" notification even though the webmail Ingress
-- was actually created and serving HTTP. The "failure" was the
-- ensureRouteCertificate path failing in dev (no real DNS for the
-- ACME HTTP-01 challenge), and the notification was technically
-- accurate but misleading because plain-HTTP webmail still worked.
--
-- This migration adds an explicit lifecycle status column so the
-- UI can distinguish:
--
--   pending        — provisioning in progress (Ingress not yet created)
--   ready          — Ingress created with TLS, fully usable
--   ready_no_tls   — Ingress created without TLS (cert issuance failed
--                    or is pending); plain HTTP works, HTTPS does not
--   failed         — provisioning fully failed before the Ingress was
--                    created (e.g. k8s API down, namespace missing)
--
-- The notifyClientWebmailCertFailed event in events.ts has been
-- removed entirely as part of this phase. Cert errors no longer
-- emit a notification — they only set the webmail_status column.
-- Users see the lifecycle in the Settings tab badge instead of
-- a false-alarm "Webmail provisioning failed" notification.
-- See review HIGH-2 in the Phase 2 commit message.

ALTER TABLE email_domains
  ADD COLUMN IF NOT EXISTS webmail_status varchar(16) NOT NULL DEFAULT 'pending';

ALTER TABLE email_domains
  ADD COLUMN IF NOT EXISTS webmail_status_message text;

ALTER TABLE email_domains
  ADD COLUMN IF NOT EXISTS webmail_status_updated_at timestamp;

-- Backfill: any existing email_domains row with webmail enabled
-- predates the column and almost certainly has a working Ingress,
-- so default to 'ready' rather than 'pending' which would
-- re-trigger the reconciler. Rows with webmail_enabled=0 stay at
-- 'pending' (the column default) — no Ingress was ever created
-- for them. (Review MEDIUM-2 fix.)
UPDATE email_domains
   SET webmail_status = 'ready'
 WHERE webmail_status = 'pending'
   AND webmail_enabled = 1;
