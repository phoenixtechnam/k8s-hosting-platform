# ADR-040: SYSTEM Tenant + Reserved Platform Hostnames

**Status:** Accepted (2026-05-18)
**Author:** Sebastian Buchweitz

## Context

The platform needed a stable home for two things that don't fit into
the customer-tenant model:

1. **The apex domain itself.** Until now, nothing prevented an admin
   from accidentally creating a customer tenant claiming the platform
   apex, or pointing a customer's CNAME at `admin.<apex>`. The platform
   had no row in the `domains` table representing its own apex.
2. **Transactional mailbox addresses** (`noreply@<apex>`, `postmaster@`,
   `abuse@`, future `notifications@`). Once a transactional-email
   send subsystem ships, these addresses need to live somewhere
   queryable through the existing mail-admin code path. Inventing a
   parallel "platform mailbox" concept outside the tenant model
   would force every existing mail flow (Stalwart reconciler, JMAP
   sync, mailbox quotas, SFTP, backups) to grow a special-case branch.

The chosen direction: **a SYSTEM tenant is just a tenant.** It runs
on the smallest hosting plan with per-tenant overrides, has its own
k8s namespace (`tenant-system`), and is provisioned and reconciled by
exactly the same machinery as any customer. The only differences are:

* `tenants.is_system = TRUE` (a single boolean, partial-unique-indexed
  so at most one row can be SYSTEM)
* Suspend / archive / delete are blocked at three layers (service,
  lifecycle hook, schedulers)
* It owns the apex `domains` row
* The set of *platform-reserved* subdomains (`admin.<apex>`,
  `mail.<apex>`, etc.) is computed at runtime and refused for *any*
  tenant — including SYSTEM in its non-master role

The transactional-email send/queue/template machinery itself is
explicitly **out of scope** of this ADR — only mailbox *addresses*
are reserved here, deferred to a separate future project.

## Decision

### 1. Data model

Migration `0008_system_tenant.sql`:

```sql
ALTER TABLE tenants ADD COLUMN is_system BOOLEAN NOT NULL DEFAULT FALSE;
CREATE UNIQUE INDEX tenants_only_one_system_idx
  ON tenants (is_system) WHERE is_system = TRUE;
```

The partial unique index DB-enforces the "at most one SYSTEM row"
invariant — even a hand-crafted direct SQL `INSERT … is_system=TRUE`
fails with a clean constraint violation if a row already exists.

### 2. Bootstrap

`backend/src/modules/system-tenant/`:

* `slug.ts` — constants:
  * `SYSTEM_TENANT_NAME = 'SYSTEM'`
  * `SYSTEM_TENANT_NAMESPACE = 'tenant-system'` (deterministic, not
    random-suffixed)
  * `systemTenantEmail(apex)` → `_system@<apex>` — leading underscore
    so it can't collide with a future operator-published `system@`
    alias.
* `service.ts:ensureSystemTenant(db, baseDomain)` — idempotent. On a
  fresh install: picks the smallest plan by `monthly_price_usd ASC`,
  applies overrides (`maxMailboxesOverride=10`, `maxSubUsersOverride=10`,
  `storageLimitOverride='2'` GiB), inserts the apex domain row, and
  creates the SYSTEM `tenant_admin` user with a random unrecoverable
  password (admin reaches SYSTEM via impersonation, not direct login).
* `service.ts:ensureSystemApexDomain` + `ensureSystemAdminUser` —
  self-healing helpers called from `ensureSystemTenant`. Re-running
  after operator hand-deletion of either row restores it.
* `bootstrap.ts:bootstrapSystemTenant(db, opts)` — top-level entry.
  Resolves the base domain via priority `opts.baseDomain` →
  `system_settings.ingress_base_domain` → `PLATFORM_BASE_DOMAIN` env
  → dev default. Called from:
  * `backend/src/server.ts` startup (self-healing on every boot)
  * `POST /api/v1/internal/system-tenant/ensure` (operator-facing, gated by `PLATFORM_INTERNAL_TOKEN`)

### 3. Protection layers

Three layers of defense, in order:

1. **Service layer** (`backend/src/modules/system-tenant/guards.ts`):
   `assertNotSystem(tenant, action)` throws
   `ApiError('SYSTEM_TENANT_PROTECTED', 409)` with structured
   `operatorError` envelope. Called from:
   * `tenants/service.ts:updateTenant` (status → suspended / archived,
     `subscription_expires_at` writes)
   * `tenants/service.ts:deleteTenant`
   * `tenants/bulk.ts:bulkUpdateTenantStatus` + `bulkDeleteTenants`
     push SYSTEM into the per-row `failed[]` array with the same
     reason instead of failing the whole batch.
2. **Lifecycle hook** (`tenant-lifecycle/hooks/system-tenant-guard.ts`):
   `order: 1` (runs first), `blocking: 'abort'`, `maxAttempts: 1`,
   `transitions: ['suspended', 'archived', 'deleted']`. Returns
   `failed` with a full envelope when the target is SYSTEM, halting
   the transition with state `failed_blocking`. Defense-in-depth — if
   a future code path dispatches a transition without going through
   the service-layer guards, the hook still catches it. The audit
   trail in `tenant_lifecycle_hook_runs` records the rejection reason.
3. **SQL filters** on the auto-trigger schedulers:
   * `subscriptions/expiry-checker.ts` adds `eq(tenants.isSystem, false)`
     to the candidate query — even if operator hand-writes a past
     `subscription_expires_at` via direct SQL, the cron never picks
     up SYSTEM.
   * `storage-lifecycle/scheduler.ts` adds the same filter to both
     auto-archive (`status='suspended' > N days`) and auto-delete
     (`status='archived' > N days`) queries.

CI guard `scripts/ci-system-tenant-check.sh` greps for the
`is_system = false` filters in those schedulers so a future refactor
can't silently drop them.

### 4. Reserved platform hostnames

`backend/src/modules/system-tenant/reserved-subdomains.ts`:
`getReservedPlatformHostnames(db)` composes the reserved set at
runtime from four sources, cached 5s:

1. Static config helpers in `backend/src/config/domains.ts` — `admin`,
   `tenant`, `mail`, `stalwart`, `dex`, `webmail` against the resolved apex
2. `platform_settings` URL keys (`longhorn_url`, `stalwart_admin_url`,
   `default_webmail_url`, `mail_server_hostname`) — hostname extracted
   from the URL; only counted when it's a subdomain of the apex
3. Static deny list: `traefik`, `master`, `tunnels`, `suspended`,
   `bulwark`, `roundcube`, `api`, `ingress`, `cluster`, `longhorn`
4. The apex itself

The 5s TTL means operator edits to platform URLs in the existing
Settings → Platform URLs page propagate into the reserved set within
5s — no separate "Reserved Hostnames" admin UI is needed, the URL
settings page already owns the canonical source.

Enforced at:

* `domains/service.ts:createDomain` — throws
  `RESERVED_PLATFORM_HOSTNAME` (HTTP 409) with operator-friendly
  envelope. SYSTEM's own apex insert bypasses by going through
  `ensureSystemApexDomain`'s direct DB insert (not `createDomain`).
* `dns-records/service.ts:createDnsRecord` — `assertNotReservedHostname`
  helper blocks (a) records whose effective FQDN matches a reserved
  hostname and (b) CNAME/A/AAAA records whose *target* matches a
  reserved hostname (CNAME-hijack defense).

### 5. UI

`frontend/admin-panel/src/`:

* `pages/Tenants.tsx` — SYSTEM row gets an amber "SYSTEM" pill, its
  bulk-select checkbox is `disabled`, and the "select all" toggle
  operates on `selectableTenants = tenants.filter(t => !t.isSystem)`
  so SYSTEM is never included.
* `pages/TenantDetail.tsx` — Suspend, Reactivate, Archive, Restore,
  and Delete buttons all hide on SYSTEM. The `LifecycleStatusControl`
  shows a `(locked)` indicator instead of the "Change…" button. A
  prominent amber banner explains what the SYSTEM tenant is and why
  the destructive actions aren't available.
* `components/ui/BulkActionBar.tsx:SelectCheckbox` — extended with
  `disabled` + `aria-label` props.

## Operator implications

* The SYSTEM tenant appears in the Clients page like any other
  tenant. Admins can provision websites and mailboxes under the apex
  through the normal flows — the namespace `tenant-system` is real
  and gets the same NetworkPolicy + ResourceQuota as any tenant.
* Any attempt to suspend / archive / delete SYSTEM via UI is hidden;
  any direct API call returns 409 `SYSTEM_TENANT_PROTECTED` with a
  structured remediation message.
* Setting `subscription_expires_at` on SYSTEM is also rejected (would
  otherwise let the expiry cron auto-suspend it).
* If operator accidentally deletes the SYSTEM row via direct SQL, the
  next backend startup re-creates it via `bootstrapSystemTenant` (and
  re-stamps the apex domain + admin user if those are also missing).
  The partial unique index ensures only one SYSTEM row can ever exist.
* Operator-exported platform state (via `export-import/service.ts`)
  *excludes* SYSTEM + its apex domain — each install creates its own.
  Import defensively skips any `tenant.isSystem === true` rows in the
  bundle.

## Reserved hostname examples

Given `PLATFORM_BASE_DOMAIN=cloud.example`:

| Hostname | Reserved? | Why |
|---|---|---|
| `cloud.example` | yes | apex (owned by SYSTEM only) |
| `admin.cloud.example` | yes | config: adminHost |
| `mail.cloud.example` | yes | config: mailHost |
| `webmail.cloud.example` | yes | config: webmailHost |
| `longhorn.cloud.example` | yes | static deny list |
| `master.cloud.example` | yes | static deny list |
| `bulwark.cloud.example` | yes | static deny list |
| `lh.cloud.example` | yes (if operator points longhorn_url here) | platform_settings URL key |
| `customer.cloud.example` | no | not platform-reserved |
| `admin.acme.com` | no | not under the platform apex |

## Future work

* Cluster Ingress label scan (`platform.phoenix-host.net/admin-ui=true`)
  as an *additional* source — picks up any future admin-only UI added
  via a Kustomize component without code changes here. Deferred
  because the four existing sources cover every platform-owned
  hostname today.
* Transactional email send/queue subsystem will live in a separate
  ADR; the SYSTEM tenant + reserved `_system@<apex>` mailbox space
  are the prerequisite that makes that work clean.
