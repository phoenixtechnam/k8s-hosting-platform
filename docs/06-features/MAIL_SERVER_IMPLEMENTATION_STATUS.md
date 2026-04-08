# Mail Server Implementation — Status & Roadmap

**Document Version:** 1.0
**Last Updated:** 2026-04-07
**Status:** ACTIVE — Phase 1 in preparation
**Audience:** Backend, frontend, and DevOps engineers working on the platform's email subsystem
**Architecture reference:** [ADR-026 — Email System](../07-reference/ADR-026-EMAIL-SYSTEM.md)

> This document is the **single index** for mail-server implementation work. Feature specs in `docs/06-features/EMAIL_*` describe the *target* behaviour; this doc tracks *what is built today, what is missing, and the order in which the gaps will be closed*.

---

## 1. Current State (snapshot)

### 1.1 Database (PostgreSQL — `backend/src/db/schema.ts`)

| Table | Purpose | Notes |
|---|---|---|
| `email_domains` | Per-domain email enable flag, DKIM keypair (private encrypted), max mailboxes/quota, catch-all, spam thresholds, DNS provisioning flags | Single DKIM key per domain (no rotation history) |
| `mailboxes` | Mail accounts: `local_part`, `full_address`, bcrypt `password_hash`, quota, status, auto-reply | `used_mb` not currently populated |
| `mailbox_access` | Sub-user → mailbox grants (`full` / `read_only`) | Used for client_user role |
| `email_aliases` | `source_address` → `destination_addresses[]` forwarding | JSONB destinations |
| `smtp_relay_configs` | Outbound relay configs (direct / mailgun / postmark) with encrypted credentials | Adapter pattern, has default-flag |

### 1.2 Backend modules (`backend/src/modules/`)

| Module | Capabilities |
|---|---|
| `email-domains/` | Enable / disable email per domain; generates RSA-2048 DKIM keypair; auto-provisions MX / A / SPF / DKIM / DMARC records via existing DNS adapters |
| `mailboxes/` | CRUD; bcrypt password hashing (cost 12); access management; webmail SSO JWT generator (`generateWebmailToken`) |
| `email-aliases/` | CRUD on forwarding rules |
| `smtp-relay/` | CRUD on relay configs; adapter pattern (`direct`, `mailgun`, `postmark`); connection test; encrypted credentials via `oidc/crypto` |

All four modules are wired into `backend/src/app.ts` under `/api/v1/`.

### 1.3 Frontend

| File | Coverage |
|---|---|
| `frontend/admin-panel/src/pages/EmailManagement.tsx` | Tabs: email domains list (DKIM/SPF/MX/DMARC status badges), SMTP relay CRUD + test |
| `frontend/client-panel/src/pages/Email.tsx` | Tabs: mailboxes (create / delete / open webmail), aliases & forwarding |
| `frontend/admin-panel/src/hooks/use-email.ts` (and client equivalent) | TanStack Query hooks for all email endpoints |

### 1.4 Kubernetes manifests (`k8s/base/`)

| File | Status | Notes |
|---|---|---|
| `stalwart-deployment.yaml` | **Draft / not wired** | Targets non-existent `platform-system` namespace; SQL queries are MySQL syntax; uses deprecated `stalwartlabs/mail-server` image; not referenced from `kustomization.yaml` |
| `roundcube-deployment.yaml` | **Draft / not wired** | Same namespace issue; not in kustomization; no JWT auth plugin configured |

**Real namespaces in use:** `platform`, `monitoring`, `hosting`, `hosting-platform` (local k3s init). The `mail` namespace from the docs and `platform-system` namespace from the draft manifests **do not exist**.

### 1.5 Documentation already shipped

| Doc | Topic |
|---|---|
| `docs/07-reference/ADR-026-EMAIL-SYSTEM.md` | Architecture decision: Stalwart + Roundcube + adapter relay |
| `docs/06-features/EMAIL_SERVICES.md` | Component overview (originally drafted around docker-mailserver — partly out of date relative to ADR-026) |
| `docs/06-features/EMAIL_ENHANCEMENTS_SPECIFICATION.md` | DKIM rotation, autodiscover, SRV, sendmail, service enable/disable specs (reference for Phase 3–4) |
| `docs/06-features/EMAIL_DELIVERABILITY.md` | IP pools, PTR, warm-up, reputation guidance |
| `docs/06-features/EMAIL_SENDING_LIMITS_AND_MONITORING.md` | Per-account rate limit specs |
| `docs/06-features/WEBMAIL_ACCESS_SPECIFICATION.md` | Roundcube multi-domain access |
| `docs/06-features/MAILBOX_IMPORT_EXPORT_SPECIFICATION.md` | Migration tooling |

---

## 2. Decision Reference

### 2.1 Mail server: Stalwart Mail Server

- **Image:** `stalwartlabs/stalwart:v0.15.5` (released 2026-02-14) on Docker Hub and GHCR
- **NOT** the deprecated `stalwartlabs/mail-server` repo (frozen at v0.11.8)
- Single binary, RocksDB local store, PostgreSQL SQL directory backend
- bcrypt verification is **automatic** (auto-detected from `$2a$/$2b$/$2y$` prefix) — zero extra config to validate the existing `mailboxes.password_hash`
- Master user mode supports `<mailbox>%<master>` SSO syntax for Roundcube
- Built-in Prometheus exporter at `/metrics/prometheus`
- Built-in WebAdmin UI on the management HTTP listener (default 8080)
- **Multi-tenancy is Enterprise-only** — Community Edition cannot enforce per-tenant isolation; the platform's own provisioning layer enforces tenant boundaries instead

### 2.2 Webmail: Roundcube

- Separate deployment, runs Apache+PHP-FPM
- Authenticates against Stalwart via IMAP using either:
  - Direct user password (Phase 1)
  - Master-user delegation `mailbox%master` after JWT verification (Phase 2)

### 2.3 Outbound strategy

- Hetzner blocks outbound port 25 by default for new accounts; unblock requires 1+ month account age + paid first invoice + manual approval
- **Default approach:** require an SMTP relay (Mailgun / Postmark / SES) so production never depends on direct port-25 egress; adapter framework already exists

### 2.4 DNS provisioning

- Already implemented via existing DNS provider adapters (PowerDNS in this project, with hosts auto-resolved through `dns-servers` module)
- Records currently auto-created: MX, A (`mail.<domain>`), SPF, DKIM, DMARC
- **Missing for Phase 4:** SRV records for autodiscover, MTA-STS TXT, optional TLS-RPT

---

## 3. Gap Analysis (current vs target)

| Gap | Severity | Phase |
|---|---|---|
| Stalwart manifest uses non-existent namespace, MySQL SQL syntax, deprecated image | 🔴 Critical | 1 |
| RocksDB PVC not provisioned | 🔴 Critical | 1 |
| TLS cert delivery (cert-manager → Stalwart file mount) | 🔴 Critical | 1 |
| LoadBalancer Service for SMTP/IMAP ports | 🔴 Critical | 1 |
| Hetzner port-25 unblock + PTR records | 🔴 Critical | 1 (operational, not code) |
| Master user setup for Roundcube SSO | 🟡 Medium | 2 |
| Custom Roundcube JWT plugin (consume `generateWebmailToken`) | 🟡 Medium | 2 |
| Multi webmail-domain ingress | 🟢 Low | 2 |
| SMTP relay rendered into Stalwart `[queue.outbound]` config | 🟡 Medium | 3 |
| DKIM key rotation (`email_dkim_keys` table + cron) | 🟡 Medium | 3 |
| Per-mailbox sending limits enforced + visible | 🟡 Medium | 3 |
| Bounce-at-SMTP integration test | 🟢 Low | 3 |
| Autodiscover XML endpoint + SRV records + MTA-STS | 🟡 Medium | 4 |
| Website sendmail (per-pod auth + audit log) | 🟡 Medium | 4 |
| Service enable/disable (SUSPEND vs DELETE) | 🟢 Low | 4 |
| Prometheus scrape + Grafana dashboard 23498 | 🟢 Low | 5 |
| `mailboxes.used_mb` quota sync from Stalwart | 🟢 Low | 5 |
| Mailbox import (IMAPSync) + export (Stalwart backup) | 🟢 Low | 5 |

---

## 4. Roadmap

### Phase 1 — Boot Stalwart (MVP) ✅ *Complete (2026-04-07)*
**Goal:** A k3s pod running Stalwart v0.15.5, reachable on all mail ports, passing send+receive E2E test.

**Delivered:**
- `k8s/base/stalwart/` — namespace, configmap, statefulset, service, networkpolicy, kustomization
  - Image `stalwartlabs/stalwart:v0.15.5` (current release, Feb 2026)
  - Single 20 Gi PVC at `/opt/stalwart` on `local-path` StorageClass
  - Storage: RocksDB for data/fts/lookup + filesystem for blobs (`type = "fs"`, depth 2)
  - Directory: `internal` (Phase 1); SQL directory pointing at platform `mailboxes` table planned for Phase 2
  - Master user + fallback admin configured via `stalwart-secrets` Secret (env-var injection via `%{env:NAME}%`)
  - TLS auto-generated self-signed (Stalwart built-in); cert-manager mount planned for production
  - TCP liveness/readiness/startup probes
  - `terminationGracePeriodSeconds: 90`
  - 10 mail ports + 8080 management exposed
- `k8s/overlays/dev/stalwart/` — standalone dev overlay
  - Service type patched LoadBalancer → NodePort (30025..30995)
  - NetworkPolicy removed (DinD k3s has no enforcer)
  - Plaintext bcrypt dev secrets
  - Independent of auto-generated `k8s/overlays/dev/kustomization.yaml`
- `docker-compose.local.yml` — mail port mappings on `k3s-server` container (2025..2995 → 30025..30995)
- `scripts/local.sh` — `mail-up`, `mail-down`, `mail-status`, `mail-logs`, `mail-test` commands
- `scripts/smoke-test.sh` — TCP probes + banner probes on all mail ports; opt-in E2E send+retrieve via `MAIL_E2E=1`
- `docs/04-deployment/MAIL_SERVER_OPERATIONS.md` — full operations runbook
- Removed legacy draft: `k8s/base/stalwart-deployment.yaml`

**Deployed + tested on local DinD k3s:**
- Pod `stalwart-mail-0` reaches `Ready` in ~30 s
- All 10 listeners start (SMTP 25, SMTPS 465, Submission 587, IMAP 143, IMAPS 993, POP3 110, POP3S 995, Sieve 4190, HTTP-mgmt 8080, HTTPS 443)
- Smoke test: 24 existing + 7 mail probes = **31 passed, 0 failed**
- E2E test (`MAIL_E2E=1`): full SMTPS submission + IMAPS retrieval round-trip = **32 passed, 0 failed**

**Operational prerequisites for production (documented, not blocking):**
- Hetzner port 25 unblock — **request filed 2026-04-07, awaiting approval**
- Production PTR records — set during production deploy
- Hetzner Cloud Firewall rules — included in `MAIL_SERVER_OPERATIONS.md` §2.3
- cert-manager-mounted TLS for the production hostname

**Exit criteria met:** Stalwart boots, listens on all ports, accepts SMTPS submission with authenticated local user, delivers to IMAP, returns mail body intact.

**Not in Phase 1 (pushed to Phase 2+):**
- SQL directory integration with platform `mailboxes` table
- Real-password accounts from platform provisioning
- Roundcube deployment
- Network policies (dev has none; production manifests include a NetworkPolicy but it's untested)
- Hetzner port-25 unblock follow-through

### Phase 2a — SQL Directory Integration ✅ *Complete (2026-04-08)*
**Goal:** Make mailboxes created via the backend CRUD APIs immediately usable by Stalwart without any manual admin-API provisioning.

**Delivered:**
- `backend/src/db/migrations/0004_stalwart_directory.sql` — `stalwart` Postgres schema with 4 views (principals, emails, domains, alias_expansion) projected from `mailboxes` / `email_domains` / `email_aliases`. Plus a dedicated read-only `stalwart_reader` role created as `NOLOGIN` with `search_path` pinned to `stalwart` and `REVOKE ALL ON SCHEMA public` for defense-in-depth.
- `k8s/base/stalwart/configmap.yaml` — `[store.pg]` PostgreSQL data store with `$1` query placeholders; `[directory.sql]` bound to it; `[storage] directory = "sql"`. Query trick: the `members` query must still consume `$1` even though it returns no rows (Stalwart passes the parameter regardless).
- `k8s/overlays/dev/stalwart/platform-postgres.yaml` — `Service` + `Endpoints` bridge that lets k3s pods reach the docker-compose postgres container. The Endpoints IP is patched dynamically at deploy time by `scripts/local.sh _patch_postgres_bridge`, which looks up the postgres container's current IP on the project's docker network.
- `scripts/local.sh` — `_patch_postgres_bridge` (runtime IP discovery + kubectl patch) and `_bootstrap_stalwart_reader` (sets the dev-only LOGIN password after migrations, since the migration creates the role NOLOGIN so dev secrets cannot reach production via the SQL migration runner).
- `scripts/smoke-test.sh` — new `MAIL_E2E_SQL=1` block that uses the real backend API to provision a client → domain → email-domain → mailbox chain, then authenticates to Stalwart with those credentials and completes an SMTPS submit + IMAPS fetch round-trip. Auto-skips the legacy `MAIL_E2E=1` (internal-directory) path since it's incompatible with SQL directory mode.
- `k8s/base/stalwart/networkpolicy.yaml` — egress to 5432 tightened from `to: []` (anywhere) to `namespaceSelector: mail` only.

**Verification:**
- 33 of 33 smoke tests pass with `MAIL_E2E_SQL=1`
- End-to-end proven: platform API creates mailbox → Stalwart reads it via SQL directory → SMTPS auth succeeds → IMAPS fetch retrieves the delivered message
- Suspended/deleted domains excluded from the `stalwart.domains` view so mail for quarantined clients is rejected at the edge
- `stalwart_reader` denied access to all non-`stalwart` tables (verified via `SELECT FROM users` → "permission denied")

**Deferred to Phase 2b/production hardening:**
- TLS between Stalwart and Postgres is disabled in the base ConfigMap (dev runs unencrypted). Production overlay must flip `[store.pg.tls] enable = true` and remove `allow-invalid-certs`.
- `VRFY` cross-client address enumeration is possible via the unscoped `verify` query — to be scoped/disabled in Phase 3 outbound hardening.
- `expand` query has a hardcoded `LIMIT 50` that silently truncates large mailing lists.

### Phase 2b — Webmail SSO + Custom Webmail Domains ✅ *Complete (2026-04-08)*
**Goal:** Click "Open webmail" on any mailbox in the client panel → land inside Roundcube authenticated as that mailbox, with no password prompt, using either the shared platform webmail hostname or a per-client custom hostname.

**Delivered:**
- `k8s/base/roundcube/` — standalone Roundcube deployment in the `mail` namespace: Deployment, Service, PVC (1Gi RWO for SQLite sessions), ConfigMap for extra config, ConfigMap-from-file for the jwt_auth plugin source, secret.example.yaml template. Uses the official `roundcube/roundcubemail:1.6.10-apache` image; the plugin is copied into the install dir asynchronously by a wrapper script, and the startupProbe blocks Pod Ready until `/var/www/html/plugins/jwt_auth/jwt_auth.php` exists (closes the emptyDir race).
- `k8s/base/roundcube/jwt_auth.php` — custom Roundcube plugin (~200 LOC PHP) implementing JWT SSO:
  - HS256 verification with constant-time `hash_equals`, `alg` checked BEFORE HMAC, `exp` required unconditionally, `iat` future-skew check (60s tolerance)
  - On valid JWT, calls `$rcmail->login($mailbox%master, $master_pw, $host)` directly (NOT a POST-form redirect — Roundcube's session layer rejects writes to `$_SESSION['temp']` from startup hooks)
  - Mirrors index.php's post-login sequence: `session->remove('temp')`, `regenerate_id(false)`, `set_auth_cookie()`, `log_login()`, `login_after` hook, then 302 → `/?_task=mail`
  - Displays the clean mailbox address in the Roundcube UI via `on_logged_in` hook (strips the `%master` Stalwart suffix)
- `k8s/overlays/dev/roundcube/` — standalone dev overlay (independent of the auto-generated dev overlay): NodePort patch 30017, plaintext dev secrets matching the backend `JWT_SECRET` and Stalwart master password.
- `backend/src/db/migrations/0005_webmail_domains.sql` + `backend/src/db/schema.ts` — `webmail_domains` table with unique indexes on `client_id` and `hostname`, tracking Ingress + Certificate provisioning state.
- `backend/src/modules/webmail-domains/` — CRUD service + routes:
  - Provisions a k8s Ingress + cert-manager Certificate pointing at the shared Roundcube Service when a client adds a custom webmail hostname
  - Deletes Ingress + Certificate + TLS secret on removal, attempts all three teardown steps even if one fails (so operators aren't left with orphans)
  - Collision-resistant resource naming: `webmail-<41-char slug>-<8-char sha256>` so two long hostnames with an identical 41-char prefix get distinct Ingress/Cert/Secret names (eliminates the silent-overwrite risk)
  - Friendly 409 on unique-violation races (catches Postgres `23505` and rewrites to `DUPLICATE_ENTRY`)
  - Graceful no-k8s mode (leaves rows in `pending`, not `failed`, when `KUBECONFIG_PATH` is unreachable)
  - k8s client created once at plugin registration, not per-request; logs a warning if kubeconfig can't be loaded
- `packages/api-contracts/src/webmail-domains.ts` — Zod schemas with RFC 1123 hostname validation **and** a reserved-TLD denylist (`.local`, `.localhost`, `.internal`, `.intranet`, `.lan`, `.corp`, `.home`, `.invalid`, `.test`, `.example`, `.localdomain`) — prevents the "row stuck in `active` with `certificate_provisioned=0`" footgun where a user adds a hostname that cert-manager can never issue a public ACME cert for.
- `backend/src/modules/mailboxes/service.ts` — `generateWebmailToken` rewritten:
  - Signs with a dedicated `WEBMAIL_JWT_SECRET` (falls back to `JWT_SECRET` for dev), **independent** of the fastify-jwt API secret — a leak of either secret cannot forge the other class of token
  - Custom ~15-line HS256 signer via `crypto.createHmac` (avoids coupling to fastify-jwt's secret binding)
  - 30s token lifetime (was 120s) — minimises risk from logs/history/Referer headers
  - Resolves the SSO URL: if the client has an `active` row in `webmail_domains`, uses `https://<hostname>`; otherwise falls back to `WEBMAIL_URL` env or the hardcoded platform default
  - Returns a full URL (`…/?_task=login&_jwt=…`) so the frontend can open it directly
- `backend/src/modules/webmail-domains/service.test.ts` — 34 unit tests covering CRUD happy paths, race conditions (pg 23505), ingress 409 replace, cert failure non-fatal, no-k8s mode, rollback errors, delete partial-failure, hostname validation (including reserved-TLD rejection)
- `backend/src/modules/mailboxes/service.test.ts` — extended with 8 new `generateWebmailToken` tests covering URL construction, dedicated secret precedence, token structure, missing-secret error, and unauthorized access
- `docker-compose.local.yml` — host port 2017 → k3s NodePort 30017
- `scripts/local.sh` — `webmail-up`, `webmail-down`, `webmail-status`, `webmail-logs` commands
- `scripts/smoke-test.sh` — new `WEBMAIL_E2E=1` block that provisions a client/user/mailbox chain, exercises `POST /email/webmail-token`, verifies the JWT shape and 30s lifetime, then hits the real Roundcube container through its NodePort to confirm the SSO flow ends on `/?_task=mail`
- `frontend/client-panel/src/pages/Email.tsx` — fixed the stale `${webmailUrl}/sso.php?token=...` format (no such endpoint); now opens `result.data.webmailUrl` directly with `noopener,noreferrer`

**Verification:**
- **1016 backend unit tests pass** (108 files) including 34 new webmail-domains tests and 8 extended generateWebmailToken tests
- **Full backend + client-panel + admin-panel typecheck clean**
- **38 smoke tests pass** against live local stack with `MAIL_E2E_SQL=1 WEBMAIL_E2E=1` — the 5 new webmail assertions prove end-to-end: `POST /email/webmail-token` returns a well-formed URL, the JWT decodes with correct claims and 30s lifetime, and a GET to the Roundcube NodePort authenticates via the jwt_auth plugin and lands on `/?_task=mail` with `roundcube_sessid` + `roundcube_sessauth` cookies set
- Manually verified via curl: a client_user with mailbox access → webmail-token → Roundcube SSO → authenticated mail UI (title `Roundcube Webmail :: Inbox`, 36 KB HTML with `compose`, `logout`, `inbox` markers)

**Deferred to Phase 2c / production hardening:**
- **Admin UI for managing custom webmail domains** — backend CRUD API is live at `/api/v1/clients/:clientId/webmail-domains` but no frontend consumer yet
- **Admin UI for configuring the default webmail URL** — currently driven by the `WEBMAIL_URL` env var on the backend container; Phase 2c will expose this as a setting in `tls-settings` or a new `webmail-settings` module
- **TLS trust store for in-cluster IMAP** — the dev overlay disables `verify_peer` in `imap_conn_options` / `smtp_conn_options` because Stalwart's dev cert is self-signed. Production overlays MUST either mount a CA bundle and re-enable verification, or configure Stalwart to serve a cert signed by the platform cluster-issuer.
- **`use_https = true` + `proxy_whitelist` in the production overlay** — dev is HTTP-only over NodePort; production must trust `X-Forwarded-Proto` from the nginx ingress so session cookies get the `Secure` flag.
- **Split JWT secrets in the production k8s Secret** — dev overlay still uses the shared `JWT_SECRET` value for `JWT_AUTH_SECRET`; production **must** generate an independent `WEBMAIL_JWT_SECRET` and set both on the backend container and the Roundcube secret.
- **Per-endpoint rate limit on `POST /email/webmail-token`** — currently only covered by the global 100/min per-user limit; Phase 2c will add a tighter 5/min per-user limit to reduce token farming risk after credential compromise.
- **Retry / force-delete endpoint for `failed` or `deleting` webmail_domains rows** — currently operators must resolve k8s issues manually then call DELETE again; a `POST /webmail-domains/:id/retry` would close this gap.
- **Pinned image digest + minimal-caps securityContext** — currently pulls `roundcube/roundcubemail:1.6.10-apache` (mutable tag) and runs with default capabilities because the apache prefork MPM needs setgid/setuid; Phase 2c should rebuild the image from a pre-baked Dockerfile that runs fully as `www-data` so all capabilities can be dropped.
- **SQLite RWO session backend** — Roundcube stores sessions in a 1Gi RWO PVC, so the Deployment uses `strategy: Recreate` which causes hard downtime on every rollout and invalidates all active sessions. Phase 2c could migrate sessions to a shared Postgres DSN.

### Phase 3 — Outbound Hardening
1. Stalwart `[queue.outbound]` rendered from `smtp_relay_configs`
2. New `email_dkim_keys` table + rotation cron + grace period
3. Stalwart `[queue.throttle]` rendered from per-mailbox / per-domain limits
4. Bounce-at-SMTP test coverage

### Phase 4 — Autodiscover, Sendmail, Lifecycle
1. New backend module `email-autodiscover/`:
   - `GET /.well-known/autoconfig.xml`
   - `POST /Autodiscover/Autodiscover.xml`
   - `GET /.well-known/mta-sts.txt`
2. Extend `dns-provisioning.ts` with SRV and MTA-STS records
3. Per-pod sendmail auth (msmtp/ssmtp injection) + `email_sendmail_audit_log`
4. `email_service_config` table; SUSPEND/DELETE flows; admin and client APIs

### Phase 5 — Observability, Quota Sync, Import/Export
1. ServiceMonitor scraping `/metrics/prometheus`
2. Grafana dashboard 23498 deployment
3. `used_mb` reconciliation cron via Stalwart REST API
4. IMAPSync job runner for migrations
5. `MAIL_SERVER_OPERATIONS.md` runbook (Hetzner unblock, PTR, relay, DKIM rotation, blocklist remediation)

---

## 5. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Hetzner port-25 unblock takes days and may be denied | Use SMTP relay by default; structure config so direct outbound is opt-in once unblock is granted |
| Single Stalwart pod = SPOF | Acceptable for ≤100 clients; Stalwart Enterprise + FoundationDB for HA in a later phase |
| RocksDB PVC is `ReadWriteOnce` — blocks horizontal scaling | Same as above; document the constraint |
| Spamhaus public DNSBLs return error from Hetzner IP space (since 2025-02-19) | Migrate to Spamhaus DQS or use Stalwart's built-in scoring; tracked in Phase 3 |
| Multi-tenancy is Enterprise-only | Enforce isolation at the platform layer (clientId scoping in API); document that admin sees all mailboxes |
| DKIM keys are file-based, not directory-backed | Phase 3 cron writes per-domain key files into a Secret; reload via Stalwart admin API |
| New IPs commonly listed on PBL/UCEPROTECT | Warm-up plan in Phase 5 ops runbook; relay-by-default avoids the issue at MVP |
| Frequent abuse complaints can lock the entire Hetzner IP | Per-tenant suspension must complete inside 24h — design hooks in Phase 4 |
| `database.yaml` k8s manifest still references MariaDB while backend is on PostgreSQL | Out of scope for this work, but flagged: the manifest base is partially stale and the actual deployment may use a different mechanism (verify before any infra change) |

---

## 6. Decisions (final, recorded 2026-04-07)

These decisions were made during Phase 1 planning. Future engineers should understand why the code looks the way it does.

| # | Decision | Final answer |
|---|---|---|
| D1 | Phase scope for first iteration | **Phase 1 only**, then re-plan. Phase 1 unblocks everything else. |
| D2 | Kubernetes namespace | **`mail`** — clean isolation, matches docs. |
| D3 | Storage architecture | **RocksDB (data/fts/lookup) + filesystem blobs (`type = "fs"`)** on a dedicated PVC. Platform Postgres is NOT used for mail data — only read-only for the SQL directory in Phase 2+. Migration paths documented in `MAIL_SERVER_OPERATIONS.md` §5 (local-path → hcloud-volumes → NFS → S3 blobs), all zero-code-change via StorageClass swap. |
| D4 | Initial PVC size | **20 Gi** on `local-path` (dev and prod). Expansion is manual for now (admin-panel UI deferred to Phase 5). Per-mailbox quotas enforced via Stalwart's `quota` field. |
| D5 | TLS certificate source | **cert-manager + mounted Secret** for production (Phase 2 addition). Phase 1 relies on Stalwart's auto-generated self-signed cert for dev. |
| D6 | Outbound port 25 strategy | **Direct outbound** (user has requested Hetzner unblock). Commercial relay adapters (Mailgun, Postmark, SES) supported via existing `smtp_relay_configs` module — wired into Stalwart `[queue.outbound]` in Phase 3. |
| D7 | Master user secret storage | **K8s Secret** in dev (plaintext bcrypt). Sealed-secrets/SOPS in production. Vault later. |
| D8 | Multi-tenancy approach | **Community Edition + platform-layer isolation** via API `clientId` scoping. Defer Enterprise until isolation gaps cause real problems. |
| D9 | Roundcube SSO mechanism (Phase 2) | **Custom JWT plugin** (~50 LOC PHP). Option of building own webmail later — JWT issuer (`generateWebmailToken`) is reusable regardless of frontend. |
| D10 | Mail egress IP architecture | **Dedicated Hetzner Floating IP** in production for quarantine-friendliness. Worker-node relay adapter planned for Phase 3 (third relay type: `worker_node`). |
| D11 | Local dev story | **Full Stalwart on DinD k3s.** Mail ports exposed via docker-compose on `k3s-server` container (host 2025..2995 → NodePort 30025..30995). Smoke test probes in-container by default to be resilient to remote-Docker host networking. |
| D12 | Phase 1 database migrations | **None.** Schema changes begin in Phase 2 (SQL directory views, webmail domains). |

---

## 7. Open Questions for Future Phases

- How does the existing `notifications/email-sender.ts` (which appears to send platform notifications) interact with Stalwart? Should it relay through Stalwart or keep using its current SMTP target?
- Do we need DAV (CalDAV/CardDAV/WebDAV) endpoints in the same Stalwart deployment, or expose them later?
- Will the same Stalwart pod serve mail for the platform's own domains (e.g. admin notifications) or only for client domains?
- Should `mail.<clientdomain>.com` be a CNAME to `mail.platform.com` rather than an A record per client? (Cleaner ops; SNI handles certs.)

---

## 8. Change Log

| Date | Change |
|---|---|
| 2026-04-07 | Initial document — captured current state, gap analysis, roadmap, Stalwart v0.15.5 + Hetzner research findings |
| 2026-04-07 | **Phase 1 complete.** Stalwart deployed to local DinD k3s; TCP + E2E SMTP→IMAP round-trip tests green (32/32 in smoke test with `MAIL_E2E=1`). All 12 decisions finalized. Operations runbook written (`docs/04-deployment/MAIL_SERVER_OPERATIONS.md`). Hetzner port 25 unblock request filed. |
| 2026-04-08 | **Phase 2a complete.** Stalwart now reads its account directory from platform PostgreSQL via read-only views (`stalwart` schema). Backend-created mailboxes authenticate in Stalwart without any admin-API provisioning step. Smoke test adds `MAIL_E2E_SQL=1` path exercising the full backend→Stalwart flow (33/33 pass). Critical security fixes applied: `stalwart_reader` role created `NOLOGIN` with explicit `REVOKE ALL ON SCHEMA public` + `search_path = stalwart` pin. NetworkPolicy egress on 5432 scoped to the `mail` namespace. |
