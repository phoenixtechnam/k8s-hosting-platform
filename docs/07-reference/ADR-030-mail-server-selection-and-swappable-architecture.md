# ADR-030 — Mail Server Selection & Swappable-Architecture Feasibility

| | |
|---|---|
| **Status** | Accepted (hold on Stalwart v0.15.5; re-evaluate per trigger conditions below) |
| **Date** | 2026-04-23 |
| **Deciders** | Platform team |
| **Supersedes** | Implicit Stalwart-default in ADR-026 / MAIL_SERVER_OPERATIONS docs |
| **Consulted** | docs-lookup agent, upstream release notes, GitHub issue trackers (see Appendix) |

## 1. Context

The platform ships Stalwart Mail Server (v0.15.5-pinned as of 2026-04-23) to serve multi-tenant client mail. Four upstream releases in 12 months introduced breaking changes:

- v0.13 (2025-07): MTA rewrite.
- v0.14 (2025-10): DB schema break.
- v0.15 (2025-12): Directory backends removed; REST API → JMAP.
- v0.16 (2026-04-20, 3 days ago): TOML config removed, CLI rewritten, ARC removed, config moved fully into a DB-backed store populated via `stalwart apply` JSON plans.

Each break has cost us real work. The v0.16 jump is still unshipped in our cluster — we're pinned to v0.15.5 as an interim fix (see task #183). We also added a new hard requirement during staging deploy review: **OIDC / SASL XOAUTH2 login for IMAP, SMTP, POP3, AND the webmail UI**, so tenants can SSO into mail with the same Dex OIDC session that gates the admin panel.

This ADR evaluates the full 2026-current field of self-hostable mail servers + webmail, scores each on our integration requirements, and decides whether to stay, switch, or re-architect toward a swappable-component stack. A research agent gathered the evidence in April 2026; sources are cited inline and in the appendix.

## 2. Requirements

Ranked, with bucketed weights. Any candidate failing a **MUST** is excluded regardless of other strengths.

| Req | Weight | Notes |
|---|---|---|
| Self-hostable, no per-seat license cost | MUST | AGPL / GPL / MIT / Apache acceptable; SELv1 acceptable for non-paid tiers only |
| K8s-deployable via manifests or Helm (not docker-compose-locked) | MUST | Mailcow disqualified on this alone |
| **OIDC/XOAUTH2 login at protocol layer (IMAP/SMTP at minimum)** | HIGH | NEW requirement |
| OIDC login at webmail UI | HIGH | Most candidates have this; differentiator where protocol-level OIDC is missing |
| Postgres-backed user directory OR swappable directory layer | HIGH | Platform runs Postgres; platform owns user provisioning |
| Multi-tenant — client domain isolation, per-domain quotas | HIGH | 50-100 clients, each with N mailboxes |
| Active upstream (release in last 6 months, maintainer responsive) | HIGH | Maddy/Mailpile/Mox fail this |
| Programmable admin API (REST or JMAP) for platform backend to create/delete mailboxes | MEDIUM | We currently use SQL views + `stalwart-cli` for queue ops |
| Built-in spam filter OR clean rspamd integration | MEDIUM | Cost: ops burden for a second pod |
| HA-friendly (stateless SMTP, active-passive OK) | MEDIUM | Tier 1 HA (DNS-RR) sufficient for staging; tier 3 matters at production cutover |
| Protocol breadth: SMTP + IMAP + POP3 + (JMAP nice-to-have) + Sieve | MEDIUM | Most candidates deliver everything but JMAP |
| Migration cost from current Stalwart integration | MEDIUM | ~46 platform migrations + SQL views + CronJobs + Ingresses reference Stalwart |
| Maintenance burden (pod count, config surface, release churn) | LOW | All things being equal, less is better |

## 3. Current Stalwart integration surface

This is the *contract* a drop-in replacement would need to match. Before committing to a candidate we need to know what we'd rewrite:

### 3.1 SQL views (Postgres-backed directory)

`backend/src/db/migrations/0004_stalwart_directory.sql` + `0014_stalwart_submit_view.sql` create:

- `stalwart.principals` — one row per mailbox (plus submit-credential shadow rows). Columns: `name`, `type`, `secret`, `description`, `quota`.
- `stalwart.emails` — primary address per account. Columns: `address`, `name`, `type`.
- `stalwart.domains` — local domain list. Column: `name`.
- `stalwart.alias_expansion` — alias target mapping.
- Read-only role `stalwart_reader` with SELECT on the `stalwart` schema only.

Stalwart's TOML `[store.pg.query]` names these explicitly: `name`, `members`, `recipients`, `emails`, `verify`, `expand`, `domains`. Any replacement must produce equivalents.

### 3.2 `stalwart-cli` invocations from the platform backend

`backend/src/modules/mail-admin/service.ts`:
- `stalwart-cli queue list` → queue UI in admin panel.
- `stalwart-cli server database-maintenance` → pre-snapshot quiesce (dr CronJob).

### 3.3 Direct HTTP API

Same module:
- `/api/queue/messages` via k8s Service-proxy pattern.
- `/metrics/prometheus` for OpenMetrics.
- `/api/oauth` for the password-rotation poll.

### 3.4 Admin UI proxy

`k8s/overlays/staging/stalwart/webadmin-ingress.yaml`: `mail-admin.staging.phoenix-host.net` → `stalwart-mail-mgmt:8080`, gated by `admin-auth-gate-cookie` component.

### 3.5 Kubernetes resources

- StatefulSet `stalwart-mail` with a Longhorn RWO PVC.
- CronJobs: `stalwart-backup` (pre-snapshot quiesce), `stalwart-cert-reload` (cert-manager rotation pickup).
- Service ClusterIP + externalIPs on single-node staging.
- NetworkPolicy opening :25/465/587/143/993/110/995/4190 ingress.

### 3.6 Frontend / backend modules tied to Stalwart

Across `backend/src/modules/`: `mail-admin`, `mail-imapsync`, `mail-stats`, `mail-submit`, `email-domains`, `email-dkim`, `email-outbound`, `email-aliases`, `email-autodiscover`, `mailboxes`, `webmail-settings`, `certificates`. 11 modules reference Stalwart by name or URL. Most would work unchanged against any RFC-compliant IMAP/SMTP server fronted by our directory views; a handful (`mail-admin`, `webmail-settings`, parts of `certificates`) need adapter rewrites.

## 4. Candidate survey

From the research agent's April 2026 dossier. I retain only the top 10 candidates; obvious non-starters (Mailpile abandoned, Haraka SMTP-only, Exim no OIDC roadmap, Poste.io closed-source) are omitted.

### 4.1 Stalwart (incumbent)

AGPL-3.0 + SELv1. v0.16.0 (2026-04-20). Active (12.5k★). **OIDC: yes**, OAUTHBEARER + XOAUTH2 on IMAP/POP3/SMTP/JMAP, OIDC in WebUI (since Jan 2025). Multi-tenancy: basic in CE; full delegated admin + branding in Enterprise. K8s: community Helm chart (olsontechllc) + official docs. HA: FoundationDB + NATS cluster possible but untested at our scale. **Drop-in cost: zero — we're on it.** Deal-breaker surfaced here: 4 breaking releases in 12 months (see §1); maintainer signals the churn is ending at 1.0 but that's unverified.

### 4.2 Apache James 3.9.0 (strongest challenger)

Apache 2.0. v3.9.0 (2025-09-25). ASF governance (low bus-factor). **OIDC: first-class** — `XUserAuthenticationStrategy` (proxy-header trust) + `JWTAuthenticationStrategy` (direct JWT validation) cover IMAP + SMTP + JMAP. A worked OIDC example (`examples/oidc/`) ships Keycloak + Apisix + LDAP via docker-compose. Postgres variant since 3.9. Distributed variant with Cassandra/S3/OpenSearch/RabbitMQ gives real active-active HA. No Helm chart; `apache/james:*` Docker images. Weakness: Java 21 + JVM operational profile; no built-in webmail (pair with Roundcube/SOGo). **This is the only candidate that matches Stalwart on protocol-level OIDC and exceeds it on HA maturity.**

### 4.3 Mailu

MIT. 2024.06 with 2026 patches. **Official Helm chart** (v2.7.0) — the only docker-first distro with a real K8s story. Built on Postfix + Dovecot + rspamd + Roundcube/SnappyMail. **OIDC: webmail + admin UI only** (header-auth via Keycloak/Authentik/Vouch reverse proxy). IMAP/SMTP themselves use Mailu-native tokens or app-passwords — the underlying Dovecot *could* do XOAUTH2 but Mailu's config DSL doesn't expose it. Postgres or MariaDB backend. Multi-domain yes, delegated admin yes. **Closest operationally-clean fit for K8s; fails the "OIDC at protocol layer" hard requirement.**

### 4.4 Postfix + Dovecot 2.4 + rspamd (assemble-yourself)

Mixed licenses (IBM PL / GPL). Mature components with decades of deployment. Dovecot 2.4 CE (2025) ships first-class OAuth2 passdb with `openid_configuration_url` discovery, `oauthbearer` + `xoauth2` SASL mechs, and JWT local validation. Postfix 3.x delegates to Dovecot via `smtpd_sasl_type=dovecot`. **OIDC: yes, and the most flexible and best-documented path in the ecosystem.** No unified Helm chart; roll your own 3-pod deployment. HA: Dovecot director for IMAP, Postfix MX fan-out for SMTP. Postgres-backed directory via `virtual_alias_maps` + Dovecot `userdb`/`passdb`. **Lowest long-term maintenance, highest initial assembly cost.**

### 4.5 docker-mailserver (DMS)

MIT. v15.1.0 (2025-08). 18.2k★. Postfix + Dovecot + rspamd, configured by env + files. OAuth2 on IMAP + SMTP via Dovecot (`ENABLE_OAUTH2=1` + introspection URL). **Docs explicitly flag OAuth2 as WIP; accepts tokens but requires users pre-provisioned in DMS.** Community Helm chart at `docker-mailserver/docker-mailserver-helm`. Reasonable middle ground if you accept "OIDC auth works, user lifecycle is separate." We already have our own provisioning API, so the gap matters less.

### 4.6 Mailcow

GPL-3.0. 2026-03b release (monthly cadence). Polished. **K8s: explicit non-starter** — dockerapi container requires Docker socket access. OIDC: webmail/admin UI only (same gap as Mailu). XOAUTH2 not built into their Dovecot (issue #6673 still open). **Disqualified by K8s incompatibility.**

### 4.7 Modoboa 2.8.2

ISC. v2.8.2 (2026-04-08). Django/Vue admin wrapping Postfix + Dovecot. OIDC on admin UI. IMAP/SMTP OIDC possible via Dovecot underneath but not bundled. No Helm chart. Good if admin UX matters and we want to own the auth integration at the Dovecot layer. Smaller community than Mailu.

### 4.8 Mox

MIT. Go. **Last release v0.0.15 (2025-04-18) — no 2026 release.** Single maintainer. OAuth2/OIDC on roadmap, unimplemented. **Disqualified** on activity + OIDC.

### 4.9 Maddy

GPL-3.0. Last feature release 0.9.3 (April 2024); security patch April 2026 only. **No OIDC, no OAuth2, no roadmap entry.** IMAP storage still labelled "beta" in the README. Viable as MTA-only paired with Dovecot, redundant given Postfix exists. **Disqualified.**

### 4.10 Carbonio CE / iRedMail

Carbonio CE (AGPL-3.0 core, commercial paid tier): LDAP/AD only in free; SAML paid-only; **no OIDC in CE**. iRedMail: maintainers publicly declined OIDC. **Both disqualified** on the OIDC requirement.

### 4.11 Cyrus IMAP

BSD. 3.10.x (2025). Mature. **cyrus-sasl lacks native OAUTHBEARER / XOAUTH2** (only 3rd-party moriyoshi plugin). **Disqualified.**

## 5. Webmail survey

| Name | OIDC | K8s | Notes |
|---|---|---|---|
| **Roundcube 1.7 (RC6 Mar-2026)** | First-class (generic OAuth2 → OIDC discovery + JWKS in 1.7) | Official Docker images; common Helm charts | Best fit; already referenced in our repo history. |
| SOGo | Generic-OIDC + Keycloak-specific | Ships with Mailcow/iRedMail | CalDAV/CardDAV groupware bonus. |
| SnappyMail | Partial; maintainer says "not perfect yet" | Docker images | UX modern, OIDC weak. |
| Cypht | Gmail/O365 only (no generic OIDC) | Docker images | Multi-account aggregator; not our fit. |
| Nextcloud Mail | NC login via OIDC; app itself IMAP-password | Helm chart | Only if Nextcloud is already in-stack. |
| Stalwart embedded SPA | OIDC in v0.16 WebUI | Tied to Stalwart pod | Only usable as-is if we stay on Stalwart. |

## 6. Feature/compatibility/maintainability matrix

Weights: H=High, M=Medium, L=Low, —=fails MUST.

| Candidate | K8s | Postgres | OIDC protocol | OIDC webmail | Multi-tenant | HA | Active | Drop-in cost¹ | Overall |
|---|---|---|---|---|---|---|---|---|---|
| **Stalwart v0.16** | H | H | **H** | H | M (CE) | M | H (churny) | zero | **H** |
| **Apache James 3.9** | M (Docker only) | H (new PG variant) | **H** | via Roundcube | H | **H** | H (ASF) | ~30-50h | **H** |
| **Postfix+Dovecot 2.4+rspamd** | M (3 pods, DIY) | H | **H** | via Roundcube | H | H (director) | H (mature) | ~50-80h | **H** |
| **Mailu** | **H (Helm)** | H | L (web only) | H | H | M | H | ~20-30h | M |
| **docker-mailserver** | M (community Helm) | via Dovecot SQL | M (WIP) | via Roundcube | M (file-config) | L | H | ~25-40h | M |
| **Modoboa 2.8** | L | H | L (web only) | H | H | L | H | ~30-45h | L |
| **Mailcow** | — | — | — | — | — | — | — | — | **EXCLUDED** (K8s) |
| **Mox** | — | — | — | — | — | — | — | — | **EXCLUDED** (OIDC + stale) |
| **Maddy** | — | — | — | — | — | — | — | — | **EXCLUDED** (OIDC + stale) |
| **Carbonio CE** | — | — | — | — | — | — | — | — | **EXCLUDED** (OIDC) |
| **iRedMail** | — | — | — | — | — | — | — | — | **EXCLUDED** (OIDC) |
| **Cyrus IMAP** | — | — | — | — | — | — | — | — | **EXCLUDED** (OIDC) |

¹ *Drop-in cost = rewriting our SQL views, admin UI proxy, CronJobs, and backend modules to fit the new server. Soft estimates — label accordingly.*

**After exclusions, the contenders are three:** Stalwart (stay), Apache James (switch), Postfix+Dovecot (switch + DIY).

## 7. Swappable-architecture feasibility

> **"Can we build a thin abstraction so the mail server is swappable?"**

Short answer: **partial yes** for the directory + HTTP admin API layer, **no** for the mail-data layer. Details below.

### 7.1 What's already portable

- **SQL directory views** (§3.1) are *already* an abstraction layer. Any mail server with a Postgres userdb/passdb backend can consume them — Stalwart reads them via custom queries, Dovecot reads them via `userdb sql` + `passdb sql`, James reads them via `org.apache.james.user.jdbc`. The queries differ per server but the *underlying tables* (`mailboxes`, `email_domains`, `domains`, `mail_submit_credentials`) are ours. **No abstraction work needed — the views are the abstraction.**
- **Platform CRUD** (mailboxes, email-domains, aliases) is mostly RFC-agnostic. We write to `mailboxes`, the mail server discovers via the view layer. Zero rewrite per swap.

### 7.2 What's partially portable

- **Admin ops API** (`mail-admin` module): `/api/queue/messages`, `/metrics/prometheus`, `stalwart-cli queue list`. Stalwart-specific endpoints and CLI. A thin adapter interface could abstract these:

  ```ts
  interface MailAdminBackend {
    listQueue(): Promise<QueueEntry[]>
    getMetrics(): Promise<PrometheusPayload>
    databaseMaintenance(): Promise<void>
  }

  class StalwartAdminBackend implements MailAdminBackend { /* current impl */ }
  class PostfixAdminBackend  implements MailAdminBackend { /* postqueue, mailq */ }
  class JamesAdminBackend    implements MailAdminBackend { /* JMAP quota + webadmin API */ }
  ```

  Scope: ~400 lines of TypeScript per backend. **Feasible, ~4-8h per backend.**

- **Webmail UI gate**: Today the `mail-admin` subdomain points to Stalwart's embedded SPA. For non-Stalwart options this becomes a Roundcube pod behind the same cookie gate. One kustomize overlay change per env. **Trivial to abstract via ingress label convention.**

### 7.3 What's NOT portable

- **Mail data storage format**. Stalwart: RocksDB + blob store. Dovecot: maildir or mdbox. Cyrus: cyrus-dirs. James: S3 + Cassandra (distributed) or Postgres (single-cluster). **There is no universal mail-data format.** Swapping servers means:
  - Old user exports via IMAP (standard) → new user imports via IMAP (standard).
  - Tools like `imapsync` / `doveadm backup` handle this but it's per-mailbox migration, not instant config swap.
  - For ongoing parallel-running (dual-write to both servers during migration) — unsupported by any mail server; forget it.

- **DKIM keys**. Stalwart signs with its internal DKIM key; Postfix uses `opendkim` or `rspamd`. Keys themselves are portable (RSA/Ed25519 PEM), but the server-specific config is not. ~2-4h rewrite per swap.

- **Sieve scripts**. Stalwart's Sieve implementation, Dovecot's Pigeonhole, and James's variant differ in extensions supported. Portable in 90% of cases, edge scripts need per-server testing.

### 7.4 Cost of building the abstraction vs switching outright

| Path | Up-front | Per-swap | Maintenance |
|---|---|---|---|
| Today (no abstraction) | 0h | ~30-80h per swap | Low — no extra layer |
| Build thin adapter layer (adminBackend interface + webmail-proxy convention) | ~12-20h | ~8-12h per swap | Low-med — interface to maintain |
| Build full "mailserver plugin system" (Dex-style providers) | ~40-60h | ~4-6h per swap | High — generalised abstractions rot |

**Verdict:** build the **thin adapter** the first time we actually swap. Premature abstraction today would:
1. Be based on one mail server's semantics (Stalwart), so the abstraction would leak its assumptions.
2. Add operational surface with no immediate payoff.

*If and only if* we decide to migrate away from Stalwart in the next 6-12 months, the adapter work becomes justified **as part of** that migration, not ahead of it.

## 8. Decision

### 8.1 Choice: **Stay on Stalwart v0.15.5 for now. Re-evaluate at production cutover OR on any trigger condition below.**

### 8.2 Rationale

- **Stalwart meets the OIDC requirement** — the new hard requirement that precipitated this review. It's the only candidate with OAUTHBEARER + XOAUTH2 on all protocols + OIDC in WebUI *in the free tier*, with no assembly.
- **Zero migration cost vs 30-80h** for any realistic switch.
- **Platform has ~3 test tenants** — no real users being impacted by Stalwart's churn.
- **The v0.16 cliff is THE thing to ride out.** Maintainer's public signal: config model is stabilising as v1.0 approaches. If that pans out, we bought cheap stability by pinning v0.15.5 for ~3 months while upstream settles.
- **None of the alternatives are strictly better** for our specific intersection of (OIDC, K8s-native, Postgres-backed, multi-tenant, no assembly, active upstream):
  - Apache James matches OIDC + exceeds on HA, but costs ~30-50h to swap AND introduces a JVM into our ops profile.
  - Postfix+Dovecot matches OIDC + is most mature, but costs ~50-80h of assembly + 3-pod ops burden.
  - Mailu is K8s-native but fails OIDC-at-protocol.

### 8.3 Trigger conditions that flip this decision

If any of the following occurs, re-open this ADR:

1. **Stalwart v0.17 or v0.18 introduces another config-format break** within 12 months of v0.16. This would falsify the "churn is ending" hypothesis. → Plan controlled migration to **Apache James 3.x** (first choice) or **Postfix+Dovecot** (second choice).
2. **Stalwart ships a security CVE and upstream fix takes >30 days**. Mail-protocol CVEs are high-impact; Stalwart's response time under pressure is unproven. → Migrate to Postfix+Dovecot (best CVE response times in the ecosystem).
3. **Platform scales past 50 active client domains** and we see either (a) Stalwart RocksDB performance issues, (b) multi-tenancy pain (CE delegated-admin gaps), or (c) tier-3 HA becomes a hard requirement. → Migrate to Apache James (distributed variant has the HA story).
4. **Stalwart goes fully commercial** (AGPL+SELv1 dual-licensed, risk is real). → Migrate to any AGPL-or-freer option from the matrix.
5. **We take on a client whose compliance regime requires audit-trail features Stalwart doesn't provide** (e.g., regulated mail retention, eDiscovery workflows). → Evaluate Apache James (has these) or enterprise-flavoured Postfix+Cyrus.

### 8.4 Decision on swappable-architecture

**Don't build it yet.** Build the thin adapter interface (§7.4 option 2) ONLY during the migration project itself, if a trigger fires. Premature abstraction would codify Stalwart's semantics into a "neutral" interface that isn't actually neutral.

**In the meantime**, keep the SQL-views-as-directory pattern clean — it's already the strongest portability layer in the stack.

## 9. Concrete next actions

None required immediately. This ADR is a **hold** decision.

Optional, low-effort prep work that preserves future flexibility:

1. **Pin Stalwart image by digest**, not by tag (`stalwartlabs/stalwart:v0.15.5@sha256:…`). Protects against tag-reassignment. ~15min.
2. **Audit `stalwart-cli` callsites** in `backend/src/modules/mail-admin/`: document each call's *semantic* purpose in a comment so a future adapter implementor knows what to reproduce. ~30min.
3. **Smoke-test a parallel Roundcube 1.7 pod** pointing at our staging Stalwart via IMAPS. If Roundcube + Dex works end-to-end, we have a proven OIDC-at-webmail path regardless of mail server. ~2-4h. *Nice-to-have, not required.*
4. **Schedule a calendar reminder for 2026-10-23** (6 months) to re-read this ADR and check trigger conditions. No work, just a check-in.

## 10. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Stalwart v0.17 breaks config again within 6 months | Medium | High | Migration plan pre-staged under §8.3 trigger #1 |
| Stalwart goes closed-source / commercial-only | Low | High | SELv1 terms allow current free-tier use indefinitely for non-commercial + small commercial; AGPL-3 portion guarantees we can fork v0.15.5 as "Stalwart Community" |
| Apache James 3.x releases a breaking 4.0 during our hold period | Medium | Low | Apache's breaking changes are signposted 12+ months in advance; would re-evaluate naturally |
| A client requires OIDC-on-IMAP and Stalwart's implementation has bugs | Medium | Medium | We can test end-to-end before any client goes live; fall-back = app-passwords, which is the ecosystem reality anyway (see OIDC reality check below) |
| Swappable architecture is urgently needed later and isn't built | Low | Medium | Build it when we need it — §7.4 shows it's a 12-20h incremental scope, not a re-platform |

## 11. OIDC/XOAUTH2 reality check (important context)

The research dossier made one observation that every candidate evaluation needs to acknowledge:

> **The client side is a bigger blocker than the server side.** Thunderbird hardcodes a list of known OAuth providers. Apple Mail only does OAuth for Gmail/O365. Outlook's generic OAuth story is worse. **Even with a perfect OIDC-capable server, most end-user mail clients will fall back to app-passwords.** Stalwart, Mailcow, and DMS all ship "app-password" features specifically because realistic end-state is OIDC for webmail + app-passwords for fat clients.

Implication for this decision: the OIDC requirement's value is **concentrated at the webmail layer** (where we control the client). At the protocol layer, we're ticking a box for tenants who want it and have client software that supports it — which today is a small minority. **This slightly weakens the case for switching away from Stalwart purely for OIDC reasons**, because Mailu + Roundcube 1.7 with Dex would give us 90% of the realistic benefit (webmail OIDC) at the cost of losing the 10% case (IMAP XOAUTH2).

We're still voting to keep Stalwart's 100%-coverage approach, because:
- It doesn't cost us anything extra.
- If a tenant eventually does want OIDC-on-IMAP with a supporting client (Mutt, neomutt, K-9 Mail, Evolution, FairEmail all do), we can deliver without app-passwords.

But it means option #3 in §9 (Roundcube 1.7 smoke-test) is the highest-leverage "prep work" — it de-risks the webmail-OIDC path independent of Stalwart's lifecycle.

## Appendix A — Sources (retrieved 2026-04-23)

**Stalwart:** https://stalw.art/blog/stalwart-0-16/ · https://github.com/stalwartlabs/stalwart/blob/main/CHANGELOG.md · https://stalw.art/docs/auth/backend/oidc/ · https://github.com/olsontechllc/stalwart-chart

**Apache James:** https://james.apache.org/james/update/2025/09/25/james-3.9.0.html · https://github.com/apache/james-project/blob/master/examples/oidc/README.md

**Mailcow:** https://mailcow.email/posts/2026/release-2026-03/ · https://github.com/mailcow/mailcow-dockerized/issues/6673

**Mailu:** https://github.com/Mailu/helm-charts · https://mailu.io/2024.06/releases.html

**docker-mailserver:** https://docker-mailserver.github.io/docker-mailserver/latest/config/account-management/supplementary/oauth2/ · https://github.com/docker-mailserver/docker-mailserver-helm

**Modoboa:** https://modoboa.org/en/blog/release-modoboa-281/

**Mox / Maddy:** https://github.com/mjl-/mox/releases · https://github.com/foxcpp/maddy/releases

**Postfix+Dovecot:** https://doc.dovecot.org/main/core/config/auth/databases/oauth2.html · https://doc.dovecot.org/main/howto/sasl/postfix.html · https://blog.linux-ng.de/2025/10/12/oauth-oidc-for-dovecot-and-postfix/

**Webmail:** https://roundcube.net/news/2026/03/29/security-updates-1.7-rc6-1.6.15-1.5.15 · https://github.com/roundcube/roundcubemail/wiki/Configuration:-OAuth2 · https://github.com/the-djmaze/snappymail/discussions/1677

## Appendix B — Changelog

- **2026-04-23** — Initial ADR. Decision: hold on Stalwart v0.15.5; triggers documented.
