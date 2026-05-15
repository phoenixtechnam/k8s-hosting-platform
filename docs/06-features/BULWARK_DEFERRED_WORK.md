# Bulwark Webmail — Deferred Work (ADR-039 Phase 7 + Phase 8)

The Bulwark integration M0 (ADR-039 Phases 0–6, 9, 10, 11) ships:

- Production base manifest with single `/app/data` PVC + reloader.
- Stalwart `defaultHostname` seeded by bootstrap (Phase 2 + CI guard).
- Stalwart `usePermissiveCors=true` set by bootstrap (Phase 3).
- `bulwark-impersonator` sidecar with HS256 JWT verify + master-auth
  injection + jti replay protection + audit logging (Phase 4).
- Platform-api `POST /api/v1/email/webmail-token` engine-aware
  (Phase 5) + client-panel hook engine override (Phase 6).
- `scripts/integration-bulwark-e2e.sh` (27 phases) (Phase 9).
- `platform_config.default_webmail_engine` (Phase 10).
- Docs + ADR-039 (Phase 11).

Two roadmap phases are deliberately deferred to M+1 because their
minimal implementations would inflate the scope past the v1 target,
and the v1 functional surface works without them.

## Phase 7 — Backups + GDPR data export of Bulwark per-user settings

**What's missing:**
Bulwark writes per-account UI preferences to
`/app/data/settings/<account>.enc` (encrypted with `SESSION_SECRET`).
These files store theme choice, sidebar layout, draft auto-save,
notification preferences, etc. They are **NOT** mailbox content —
mailbox content (emails, calendar events, contacts, Sieve scripts)
lives in Stalwart and is captured by `project_tenant_backup_v2_*`
via JMAP.

**Impact of the gap:**
On tenant restore, the user's mailbox content is fully recovered but
their UI prefs (theme, sidebar, etc.) reset to defaults. Sieve filters,
identities, and signatures are stored server-side in Stalwart so they
survive. The user experiences ~30 seconds of UI re-customisation pain;
no data loss.

**Why it's not blocking:**
Per-account settings files are 100–500 bytes each. A 1000-mailbox
tenant has ~500 KB of state. The 6-month Roundcube deprecation
window (Phase 10) gives plenty of time to wire this up if customer
feedback demands it.

**Implementation sketch:**
1. Add a JMAP-style endpoint to the impersonator (or a sidecar in
   the Bulwark pod) that returns the entire `/app/data/settings/`
   tree as a tar archive when authenticated with master credentials.
2. Wire it into `tenant-backup-v2-phase2` capture-jmap.py the same
   way mailbox content is captured.
3. Restore reverses the tar extraction.

## Phase 8 — Lifecycle hook for Bulwark settings purge on `archived` transition

**What's missing:**
When a client transitions to `archived` (`client_lifecycle/cascades.applyArchived`),
all Stalwart accounts under the client's email domains are destroyed.
The orphaned Bulwark `/app/data/settings/<destroyed-account>.enc`
files remain on disk.

**Impact of the gap:**
Orphan files. Each is sub-1KB; even a high-churn install accumulates
megabytes. The files are encrypted with the platform `SESSION_SECRET`
and contain no recoverable user content (PII would require the
destroyed Stalwart account's JMAP session). GDPR's right-to-erasure
covers personal data; encrypted UI preferences linked to a destroyed
account ID are debatable as personal data, but conservative reading
says yes.

**Why it's not blocking:**
- The destroyed account can never authenticate again (Stalwart 401s).
- Encrypted files for an unrecoverable account are not actively
  readable.
- Cleanup can be batched on a weekly cron.

**Implementation sketch:**
Two paths:
1. **kubectl exec approach** — backend hook execs into the
   impersonator pod and `rm /app/data/settings/<account>.enc`.
   Requires extending platform-api's ClusterRole with `pods/exec`
   in `mail` ns. Same pattern as `scripts/admin-password-reset.sh`.
2. **Sidecar admin endpoint** — add `DELETE /__impersonator/settings/:account`
   to the bulwark-impersonator script, gated behind an
   `X-Admin-Token` header that the operator provisions in the
   impersonator secret. Backend hook curls this with the token.
   Cleaner from a permissions standpoint but adds an endpoint that
   must be defended.

Recommend path 2 if/when this is built — keeps the impersonator
as the single point of integration with Bulwark's data and avoids
extending platform-api's k8s RBAC.

**Kill switch when implemented:** `LIFECYCLE_HOOK_BULWARK_SETTINGS_PURGE=disable`.

## When to revisit

Pull these forward to a milestone if:

- A customer reports lost-UI-preferences after restore (Phase 7).
- The platform's `tenant-data-coverage-contract.md` (ADR-035) starts
  failing the orphan-files lint (Phase 8).
- A GDPR audit flags retained encrypted preferences as personal data
  (Phase 8 — escalation path: implement it).
