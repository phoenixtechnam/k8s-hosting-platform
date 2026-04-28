# Notification System Roadmap

Status of the notification system after the 2026-04-28 channel-abstraction
refactor and the label-driven backup-health module.

## Phase 1 — DONE (2026-04-28)

**Channel seam + label-driven backup-health observability shipped.**

- `notifications/channels/` — `NotificationChannel` interface, in-app + email
  channels, channel registry; `notifyUser` iterates active channels instead
  of hardcoding DB+email.
- `notifications/recipients.ts` — `RecipientScope` discriminated union
  (`admin` / `admin_role` / `client` / `user`) + `resolveRecipients(db, scope)`.
- `backup-health/` module — discovers Jobs cluster-wide via the
  `platform.phoenix-host.net/backup-health-watch=true` label; emits one
  notification per failed Job UID (deduplicated via
  `notifications.resourceId=<uid>`); routes admin or client_admin recipients
  per the optional `client-id` label.
- `longhorn-reconciler.ts` — refactored to discover the suspend-list via
  `platform.phoenix-host.net/depends-on=backup-credentials` (replaces the
  hardcoded `BACKUP_CRONJOB_NAMES` constant).
- 6 DR CronJob YAMLs (`k8s/base/backup/*.yaml`) carry both labels.
- `GET /admin/backup-health` — auth-gated rollup endpoint.
- Admin panel: `BackupHealthBanner` (top-of-page warning when any DR cron is
  failing) + `BackupHealthTable` (grouped by category, click-to-expand
  failure-reason rows). Hook polls every 60 s.

## Phase 2 — Production email hardening (TARGET: before production cutover)

**Goal: make email reliable enough to depend on.** Today's email send is
fire-and-forget — failures are silently swallowed, and there's no retry.

- New `notification_deliveries` table:
  `id`, `notification_id`, `channel_id`, `user_id`, `state`
  (`pending` | `sent` | `failed`), `attempts`, `last_error`, `next_retry_at`.
- `delivery-tracker.ts` wraps each `channel.deliver()` in tracking + retry
  scheduling.
- `delivery-retry/scheduler.ts` — periodic reconciler with exponential
  backoff (5 min → 15 min → 1 h → 6 h → 24 h, then dead-letter).
- Email template overhaul: HTML + text alternative, brand styling, an
  unsubscribe link footer (placeholder until Phase 3 lands), and the
  `List-Unsubscribe` header for client compliance.
- SMTP TLS hardening: STARTTLS required, certificate validation.
- Rate limiting: max N emails/hour to a single recipient (prevents loops).
- Bounce handling (basic): catch SMTP 5xx → mark delivery permanently failed
  and surface in the admin "Notification deliveries" view.

Effort: ~6h. Files: schema migration + new module + email-sender hardening.

## Phase 3 — Per-user notification preferences (TARGET: before production cutover)

**Goal: users opt out of email per severity tier.**

- New `notification_preferences` table:
  `user_id`, `channel_id`, `min_severity`, `enabled`.
- Default rows on user creation: `in_app=true (info+)`,
  `email=true (warning+)`, others=`false`.
- `loadPreferences(db, userId)` + `shouldDeliver(prefs, channelId, severity)`
  pure helper.
- Profile UI: "Notification preferences" matrix (channel × severity).
- API: `GET / PATCH /me/notification-preferences`.
- `notifyUser` consults prefs before each `channel.deliver()`.

Effort: ~4h. Files: schema migration + `recipients.ts` extension + profile
page + tests.

## Phase 4 — Slack channel (NICE-TO-HAVE, post-production)

**Goal: prove the channel abstraction with a real third channel.**

- `notifications/channels/slack.ts` — Incoming Webhook URL POST with formatted
  block-kit message.
- Config: `SLACK_WEBHOOK_URL` env (admin scope) and per-user webhook
  (preferences) for client scope.
- Smoke test: dev-mode mock webhook receiver.

Effort: ~2h.

## Phase 5 — Webhook channel (NICE-TO-HAVE, post-production)

**Goal: generic outbound POST for custom integrations.**

- `notifications/channels/webhook.ts` — POSTs notification JSON to a
  configured URL with an HMAC signature header.
- Config: per-user webhook URL + shared secret in preferences.
- Use case: PagerDuty receivers, custom monitoring, Make/Zapier.

Effort: ~2h.

## Phase 6 — SMS / Telegram (LATER, demand-driven)

**Goal: placeholder for future on-call escalation channels.**

- Twilio adapter for SMS.
- Telegram bot adapter.
- Pattern follows Slack (incoming webhook for notifications, no inbound
  message handling).

Effort: ~4h each. Not before production.

## Explicitly NOT planned

- **Event bus / Postgres LISTEN-NOTIFY** — direct in-process calls remain.
- **Outbox pattern** — `notification_deliveries` is a tracking table, not a
  transactional outbox. If platform-api restarts mid-delivery we accept rare
  lost emails (Phase 2 retry catches most).
- **Plugin architecture** — channel registry is a hardcoded array assembled
  from config; third-party extensibility is YAGNI.
- **Per-event subscription model** — preferences are channel × severity, not
  channel × event-type. Granular per-event opt-in lands when (if) users ask.

## Triggers to revisit "do we need a heavier abstraction?"

| Signal | Means it's time for L2/L3 |
|---|---|
| Event helper count >25 with copy-paste | Time for a typed dispatcher |
| Adding a 4th+ channel (after Phase 5) | Time for a typed dispatcher |
| Compliance/audit replay requirements | Time for an outbox |
| Cross-team integrations consuming events | Time for an outbox + public schema |
| Notification fanout > 1000/min | Time for an async queue |
