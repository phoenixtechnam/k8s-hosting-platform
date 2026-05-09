# 2026-05-09 — Editable mail-server hostname

The platform Settings → Mail Server input is now editable. Operators
can rename the SMTP/IMAP banner hostname without a snapshot+rebootstrap
maintenance window — see
`backend/src/modules/webmail-settings/service.ts:applyMailServerHostnameToStalwart`
for the JMAP-driven implementation.

Side-effects of a successful rename:

1. Stalwart's `SystemSettings.defaultHostname` is updated via the JMAP
   admin API — drives both inbound listener banners and outbound EHLO.
2. The Stalwart Domain row's `subjectAlternativeNames` map gains the
   new hostname's prefix; ACME re-issues the cert covering it.
3. The `stalwart-mail` Deployment is rolling-restarted so the listener
   pods read the new SystemSettings on boot.

Operator-side coordination still required:

- DNS MX + A records pointing at the cluster
- Reverse DNS / FCrDNS at the IP-provider level

Audit trail: every successful rename inserts an `audit_logs` row with
`action_type='platform_settings.mail_hostname_rename'` capturing the
previous + new hostname + actor.

E2E coverage: `scripts/integration-staging.sh scenario_mail_hostname_rename`
and `scenario_webmail_url_change`.
