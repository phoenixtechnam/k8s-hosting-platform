-- Phase 2 streamline (2026-05-15): default mail port exposure to allServerNodes.
--
-- The 'thisNodeOnly' mode hijacks port 80 on the active Stalwart node
-- (Service externalIPs conflict with CNI portmap) and only forwards mail
-- traffic via the single node where Stalwart is running. The haproxy
-- DaemonSet path (allServerNodes) uses ClusterIP+PROXY-v2 with the
-- proxy-networks reconciler keeping the trust list current — production-
-- ready since the Phase 1 streamline.
--
-- 'thisNodeOnly' remains in the schema for debugging single-node installs
-- via the admin API; the operator UI no longer surfaces the toggle by default.
--
-- This migration changes the DEFAULT only — existing rows are left
-- untouched. Operators on the legacy thisNodeOnly mode can flip via
-- PATCH /admin/mail/port-exposure (now in the Advanced section of the
-- mail page) without an unannounced behaviour change at upgrade time.

ALTER TABLE system_settings
  ALTER COLUMN mail_port_exposure_mode SET DEFAULT 'allServerNodes';
