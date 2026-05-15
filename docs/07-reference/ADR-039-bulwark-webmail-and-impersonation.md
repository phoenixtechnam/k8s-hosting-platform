# ADR-039 — Bulwark Webmail Integration + JWT-Signed Impersonation Flow

**Status:** Accepted · 2026-05-15
**Supersedes / related:** Co-exists with `k8s/base/roundcube/` until Phase 10 of the integration roadmap retires it. Companion to ADR-030 (mail-server-selection-and-swappable-architecture), ADR-033 (client-lifecycle-hook-registry).

## Context

The platform ships Roundcube as its webmail of record. Roundcube is a PHP application with an in-cluster `jwt_auth` plugin that allows the client-panel to mint short-lived JWTs and hand a user into any mailbox in their tenant without re-prompting for a password (impersonation via Stalwart's master-user feature, IMAP path).

Two real shortcomings of the Roundcube path drove a webmail re-evaluation:

1. **IMAP-only auth path.** Stalwart 0.16 is JMAP-first; our backend invests heavily in JMAP (`x:Account/*`, `x:Domain/*`, Email/changes, Blob/upload — see findings in `project_stalwart_mail_2026_05_03.md` and `project_tenant_backup_v2_jmap_restore_2026_05_11.md`). Roundcube re-implements its mail UX through Stalwart's IMAP gateway, which adds a translation layer and limits feature parity with the JMAP-native bits (calendars, contacts, filenode).
2. **Feature ceiling.** Roundcube's UX is well-trodden but dated. Bulwark (https://bulwarkmail.org/, AGPL-3, Next.js 16) provides a single SPA covering mail + calendars + contacts + files + Sieve rules with a JMAP-native data layer that already matches Stalwart's capability map.

The 2026-05-15 local DinD evaluation (see `project_bulwark_eval_2026_05_15.md`) proved Bulwark works end-to-end against Stalwart 0.16 — both basic-auth direct login and OIDC SSO via Dex — with a small URL-rewriter + CORS sidecar to bridge two Stalwart 0.16 limitations (apiUrl hostname + credentialed CORS).

This ADR locks the production integration model.

## Decision

### Coexist with Roundcube; flip default in M+1

`platform_config.default_webmail_engine ∈ { 'roundcube', 'bulwark' }`. New tenants inherit the default; existing tenants keep their assignment unless an operator migrates. A 6-month deprecation window precedes the deletion of `k8s/base/roundcube/`.

### Single shared Bulwark deployment

One HA Bulwark Deployment in the `mail` namespace, fronted by a platform-wide `webmail.${PLATFORM_BASE_DOMAIN}` ingress. **Not per-tenant.** Bulwark is stateless beyond its `/app/data` PVCs (admin config + per-user settings). Per-tenant ingress + vanity webmail domains + per-tenant branding are deliberately **out of scope** for v1 — see "Out of scope" below.

### Authentication model: dual path, no external IdP dependency

The platform's broader IAM story (ADR-022) is "DNS / NetBird / IAM are external; we consume them" — and the production platform IAM has not been built yet. Bulwark therefore must work **without** any external OIDC provider. External OIDC remains optional for environments that have it; it does not gate webmail.

Two distinct user paths:

| Path | Who | How |
|---|---|---|
| **Direct mailbox login** | The mailbox owner | Browser → `https://webmail.${DOMAIN}/` → Bulwark login form → email + password → Bulwark `/api/auth/stalwart-context` → Stalwart JMAP basic-auth → session cookie set |
| **Client-panel impersonation** | `client_admin` of the tenant that owns the target mailbox (or `super_admin`) | Client-panel → platform-api `POST /api/v1/webmail/impersonate { mailboxId }` → JWT minted → browser redirect to `https://webmail.${DOMAIN}/_impersonate?token=...` → `bulwark-impersonator` sidecar verifies JWT → injects `target%master:masterpwd` master-auth header → server-side POST to Bulwark's `/api/auth/stalwart-context` → session cookie forwarded to browser → 302 to `/` |

Platform users (admin / client panel auth) and mailbox users (Stalwart accounts) remain **separate identity domains**. The impersonation flow's permission check is `client_admin` of the tenant that owns the mailbox; the JWT carries `{ target_mailbox, tenant_id, actor_user_id, exp:+60s, jti:<uuid> }` signed with the platform `JWT_SECRET`. This mirrors the existing Roundcube `jwt_auth.php` model — only the verifying component moves from a PHP plugin to a Node.js sidecar.

### Why Stalwart master-user auth (and not OIDC)

A 2026-05-15 spike confirmed Stalwart 0.16 JMAP supports the `<target>%<master>:<master_pwd>` Basic-auth syntax (same as its IMAP). Bulwark's `/api/auth/stalwart-context` accepts the `%`-formatted username unchanged. The combination needs:

- a Stalwart Admin account named `master@${defaultDomain}` (auto-created at bootstrap)
- the password stored in `stalwart-secrets.MASTER_SECRET` (cleartext + a bcrypt hash that Stalwart stores)
- the `bulwark-impersonator` sidecar in `mail` namespace mounting `stalwart-secrets.MASTER_SECRET` + the platform `JWT_SECRET`

The Stalwart admin account has the `impersonate` permission via the built-in `System Administrator` role (id `e` in our dev cluster). No new role definition is required.

This approach is **strictly simpler** than the OIDC alternatives we considered:

- No Stalwart `oidcAuth` external-trust wiring (was HIGH-RISK in the original roadmap — Stalwart 0.16's OIDC backend is undocumented in our codebase, may require source-spelunking).
- No external IdP dependency. Works on a fresh self-hosted install.
- No Dex-in-production debate. Dex remains dev/staging-only per `project_dex_deployment_scope.md`.
- One trust boundary: Stalwart trusts its own issued sessions; platform-api trusts itself via `JWT_SECRET`. No third party.

The door is left open for future migration to a unified external OIDC IdP — Bulwark already supports `OAUTH_ISSUER_URL` for any RFC-7517 issuer — but that is **not** v1 scope.

### Per-mailbox replay protection

The impersonator sidecar maintains an in-process LRU cache keyed by JWT `jti` with a 60-second TTL. Reuse of a `jti` returns 410 Gone. The 60-second JWT expiry plus single-use enforcement keeps the attack window tight. A multi-replica race (different replica accepts the second use within the TTL) is treated as acceptable — the JWT is signed, the operation is logged in the audit table, and the window is short enough that the practical exploit value is near-zero. If Phase 11 review concludes otherwise, the `jti` ledger moves to platform Postgres (1 row, 60s lifetime).

## Out of scope for v1

- **Per-tenant vanity webmail domains** (`webmail.<clientdomain>` ingresses spawned by the email-domains module). Roundcube has this; Bulwark does not. Customers who specifically need a tenant-branded webmail URL stay on Roundcube. Add later if demand warrants.
- **Per-tenant branding** (Bulwark's branding model is global — single logo, single company name). Same rationale.
- **OIDC SSO** (Dex / external IdP) for webmail. Bulwark supports it; the platform doesn't ship a production IdP yet. Wire if/when the platform IAM story lands.
- **Embedded iframe AUTO_SSO**. The plain-redirect impersonation flow is simpler, has the same end-user effect, and avoids postMessage cross-origin complications + Bulwark's `EMBEDDED_MODE` quirks.

## Accepted trade-offs

- Mailbox UX is platform-branded, not tenant-branded. Tenants accept this in exchange for a working JMAP-native UX. Documented in operator-facing docs.
- The `bulwark-impersonator` sidecar adds one hop per webmail session bootstrap (`<5 ms` server-side; the user sees a single 302). Acceptable cost; the alternative is a Bulwark fork that adds the impersonation endpoint upstream — out of scope.
- Bulwark is single-vendor with active development (v1.6.x as of 2026-05-15). Pin by `@sha256:` digest with a monthly cadence bump driven by the operator. Document the version-bump procedure.
- The 60-second JWT expiry plus single-use replay protection accepts a multi-replica race window. Documented above.

## Production wiring requirements

1. `scripts/bootstrap.sh` provisions the Stalwart `master@${defaultDomain}` user with the `System Administrator` role and the password from `stalwart-secrets.MASTER_SECRET`. (Same provisioning step Roundcube already needs.)
2. `scripts/bootstrap.sh` sets Stalwart's `x:SystemSettings.defaultHostname` to the public mail hostname after first start (Phase 2 of the integration roadmap). Removes the URL-rewriter dependency.
3. `JWT_SECRET` (32+ char) shared between `platform-api` and `bulwark-impersonator` Deployments via a single Kubernetes Secret. Already present in dev (`dev-secrets.yaml`) — production operator-provisioned.
4. `webmail.${PLATFORM_BASE_DOMAIN}` DNS record points at the cluster LB. Same as the current Roundcube hostname.
5. Bulwark `/app/data` is a 1Gi RWO PVC with `fsGroup: 1000` so all four required subdirectories (`admin/`, `settings/`, `telemetry/`, `version-check/`) are writable.
6. Bulwark image pinned by SHA256 digest. Operator-driven bumps.

## Verification gates

- Phase 0 spike (2026-05-15): Stalwart 0.16 master-user auth works via JMAP using `<target>%<master>:<master_pwd>` syntax. Bulwark's `/api/auth/stalwart-context` accepts this header. End-to-end `Mailbox/get` against the target's account returns the expected 5 folders.
- Phase 9 CI harness: `scripts/integration-bulwark-e2e.sh` covers basic-auth login, impersonation success, JWT rejection (expired / wrong-signature / replayed / unauthorized-actor), and pod-kill failover.

## Bulwark version pinning

The integration tracks Bulwark v1.6.x, current `v1.6.5` (May 13, 2026). Image digest stored in `k8s/base/bulwark/deployment.yaml`. Bumps follow:

1. Review upstream changelog at github.com/bulwarkmail/webmail
2. Pull + inspect new image (`docker pull ghcr.io/bulwarkmail/webmail:v1.6.X`)
3. `docker inspect --format='{{index .RepoDigests 0}}'` for the digest
4. Update `image:` field in the deployment manifest
5. Local DinD smoke (`./scripts/local.sh bulwark-up`); E2E harness (`./scripts/integration-bulwark-e2e.sh`)
6. Merge to main → Flux rolls staging → manual stable promotion

## References

- Bulwark project: https://bulwarkmail.org/ (AGPL-3.0)
- Stalwart 0.16 master-user feature: confirmed via 2026-05-15 spike, `<target>%<master>` JMAP Basic-auth syntax
- Roundcube's existing pattern: `k8s/base/roundcube/jwt_auth.php` + `k8s/base/roundcube/secret.example.yaml`
- ADR-022: external IAM consumption
- ADR-030: mail-server-selection-and-swappable-architecture
- ADR-033: client-lifecycle hook registry (impersonator settings purge wires through here)
- `project_bulwark_eval_2026_05_15.md`: 14 findings from the local DinD evaluation (rewriter quirks, CORS, gzip, hostname JMAP property, etc.)
