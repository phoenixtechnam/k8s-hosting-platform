-- Phase 3.B.3: per-customer email send rate limits.
--
-- Admin sets a global default via the platform_settings key
-- `email_send_rate_limit_default` (messages per hour, integer).
-- Individual clients can override via clients.email_send_rate_limit
-- (null means inherit the global default).
--
-- Suspended clients (clients.status = 'suspended') are forced to
-- rate=0 at the Stalwart level by the email-outbound reconciler
-- regardless of what email_send_rate_limit is set to, so the only
-- way a suspended client can send is to un-suspend them.
--
-- See backend/src/modules/email-outbound/renderer.ts for how these
-- values render into Stalwart [queue.throttle] rules.

ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS email_send_rate_limit integer;
