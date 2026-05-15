# Bulwark Webmail

JMAP-native webmail client integrated alongside Roundcube. Tracks
upstream Bulwark (https://bulwarkmail.org/, AGPL-3.0). See ADR-039 for
the design rationale.

## TL;DR for operators

- New tenants default to whichever engine `platform_config.default_webmail_engine`
  points at. Bootstrap default is `roundcube`. Super-admin flips it to
  `bulwark` via the webmail-settings endpoint when ready.
- Existing tenants keep their current webmail until they delete their
  email domain and re-enable it under the new default.
- Roundcube and Bulwark share Stalwart's master-user account
  (`master@master.local`) for client-panel "Open Webmail" handoff.
  Both engines verify JWTs signed with the same platform `JWT_SECRET`.
- Bulwark requires three sibling Deployments in the `mail` namespace:
  `bulwark`, `bulwark-impersonator`, and (dev DinD only)
  `stalwart-url-rewriter`. Production drops the rewriter.

## Architecture

```
   Browser (mailbox owner direct login)
     │
     ▼
   bulwark.${DOMAIN}     ────► Traefik ──► bulwark-impersonator
                                              │     (transparent proxy except /_impersonate)
                                              ▼
                                          bulwark (Next.js SPA + server-side proxy)
                                              │
                                              ▼ JMAP basic-auth
                                          Stalwart mgmt :8080


   Browser (client_admin clicks "Open Webmail" on a tenant mailbox)
     │  (1) POST /api/v1/email/webmail-token { mailbox_id, engine?: 'bulwark' }
     ▼
   platform-api ──► mints HS256 JWT { iss:'platform-api/webmail', mailbox,
                                       jti, tenant_id, actor_user_id, exp:+30s }
     │  (2) returns { webmailUrl: "…/_impersonate?token=<JWT>" }
     ▼
   Browser ────► https://bulwark.${DOMAIN}/_impersonate?token=<JWT>
                                              │
                                              ▼  (impersonator)
                                       verify JWT (HS256, iss, jti dedup, exp, iat)
                                       build "Basic base64(mailbox%master:pwd)"
                                       POST → bulwark /api/auth/stalwart-context
                                       capture Set-Cookie, 303 → /
```

### Components

| Component | Where | Purpose |
|---|---|---|
| `bulwark` Deployment | `mail/bulwark` | The Bulwark Next.js SPA |
| `bulwark-impersonator` Deployment | `mail/bulwark-impersonator` | Reverse-proxy + JWT-signed master-user handoff for client-panel "Open Webmail" |
| `stalwart-url-rewriter` Deployment | `mail/stalwart-url-rewriter` (**dev DinD only**) | Rewrites Stalwart self-reported URLs (port injection, JSON unzip, credentialed CORS) |
| `platform_settings.default_webmail_engine` | `system-db` | `'roundcube'` or `'bulwark'`. Set via webmail-settings update endpoint |
| `bulwark-impersonator-secrets` | `mail` ns | `JWT_SECRET` (shared with platform-api) + `STALWART_MASTER_USER` / `STALWART_MASTER_PASSWORD` |
| `bulwark-secrets` | `mail` ns | Bulwark admin dashboard password + session encryption secret |

## Stalwart prerequisites

Bulwark depends on three pieces of Stalwart 0.16 configuration that
`scripts/bootstrap.sh` applies on first install:

1. **`x:SystemSettings.defaultHostname`** + **`defaultDomainId`** — Stalwart
   embeds these into its JMAP session response (`apiUrl`,
   `downloadUrl`, etc.). If unset, Stalwart falls back to its kernel
   hostname (= pod name) which the browser can't resolve. Set via
   `configure_stalwart_full()`.
2. **`x:Http.usePermissiveCors = true`** — Stalwart 0.16 emits CORS
   headers only on OPTIONS preflights by default; permissive mode
   extends them to every response. Required for the browser-direct
   `/.well-known/jmap` fetch the SPA makes after login.
3. **`master@master.local`** Account with the `System Administrator`
   role (or any role that has the `impersonate` permission). Cleartext
   password lives in `stalwart-admin-creds.adminMasterPassword`
   (matching `bulwark-impersonator-secrets.STALWART_MASTER_PASSWORD`).

The CI guard `scripts/ci-stalwart-hostname-check.sh` asserts #1 is in
place post-deploy.

## JWT format (impersonator)

```jsonc
{
  // header
  "alg": "HS256",
  "typ": "JWT"
}
{
  // payload
  "iss": "platform-api/webmail",     // required, must match impersonator's REQUIRED_ISS
  "mailbox": "alice@example.com",    // required, strict email regex (no %/: chars)
  "jti": "<uuid>",                   // required, single-use within TTL
  "tenant_id": "<client-uuid>",      // for audit trail
  "actor_user_id": "<user-uuid>",    // platform user who minted (audit)
  "iat": 1778834500,                 // required, no future skew >60s
  "exp": 1778834530                  // required, max 300s after iat
}
```

Signed with HS256 using `JWT_SECRET` (the platform-wide secret shared
between platform-api, the impersonator, and Roundcube's jwt_auth
plugin).

## Rejection reasons returned by the impersonator

| HTTP | `reason` | Meaning |
|---|---|---|
| 401 | `malformed` | Token doesn't have three `.`-separated parts |
| 401 | `header_decode` | Header base64 / JSON decode failed |
| 401 | `wrong_alg` | Header `alg` is not `HS256` (rejects `alg: none` attacks) |
| 401 | `wrong_typ` | Header `typ` present and not `JWT` |
| 401 | `sig_decode` | Signature base64 decode failed |
| 401 | `sig_length` | Signature byte length wrong (early reject before timing-safe compare) |
| 401 | `sig_mismatch` | HMAC signature did not match |
| 401 | `payload_decode` | Payload base64 / JSON decode failed |
| 401 | `wrong_iss` | `iss` claim missing or mismatch |
| 401 | `no_iat` | `iat` claim missing |
| 401 | `iat_future` | `iat` is >60s in the future (clock skew attack) |
| 401 | `no_exp` | `exp` claim missing |
| 401 | `expired` | `exp` is in the past |
| 401 | `not_yet_valid` | `nbf` claim present and in the future |
| 401 | `ttl_too_long` | `exp - iat` exceeds `MAX_JWT_TTL_S` (default 300s) |
| 401 | `bad_mailbox` | Missing or fails strict email regex |
| 401 | `no_jti` | Required for replay protection |
| 410 | `token already used` | `jti` already claimed within TTL |
| 405 | (not JSON) | Wrong HTTP method (only `GET` and `HEAD` are allowed) |
| 502 | `upstream` | Bulwark `/api/auth/stalwart-context` POST failed |

Every accept and every reject writes a structured JSON line to the
impersonator's stdout — the platform's log aggregator captures them.
Audit-relevant fields on accept: `jti`, `mailbox`, `tenant_id`,
`actor_user_id`, `bulwark_set_cookie_count`.

## Local DinD operations

```bash
./scripts/local.sh bulwark-up      # apply dev overlay (base/bulwark + base/bulwark-impersonator + stalwart-url-rewriter)
./scripts/local.sh bulwark-status  # pod state + endpoints
./scripts/local.sh bulwark-logs    # tail Bulwark logs
./scripts/local.sh bulwark-down    # remove

# Run full E2E harness (~15s):
./scripts/integration-bulwark-e2e.sh
./scripts/integration-bulwark-e2e.sh --failover     # adds Phase E
./scripts/integration-bulwark-e2e.sh --skip-cors    # quick path
```

Browser endpoints (need `*.k8s-platform.test` resolving to the DinD
host):

- `https://bulwark.k8s-platform.test:2011/` — webmail login
- `https://stalwart.k8s-platform.test:2011/admin/` — Stalwart WebAdmin
  (admin password from `stalwart-admin-creds.adminPassword`)
- Bulwark admin dashboard at `/admin/` — password from
  `bulwark-secrets.ADMIN_PASSWORD`

Default eval mailbox provisioned by the spike:
`eval@k8s-platform.test` / `Bulwark-Eval-2026-Pass!`

## Bulwark version pinning + bump procedure

The image digest is pinned in `k8s/base/bulwark/deployment.yaml`. To
bump:

1. Review the upstream changelog at
   https://github.com/bulwarkmail/webmail/releases
2. Pull the new image locally:
   `docker pull ghcr.io/bulwarkmail/webmail:v1.6.X`
3. Capture the digest:
   `docker inspect --format='{{index .RepoDigests 0}}' ghcr.io/bulwarkmail/webmail:v1.6.X`
4. Update the `image:` field in `k8s/base/bulwark/deployment.yaml`
   AND the version-annotative tag in the comment.
5. Local smoke: `./scripts/local.sh bulwark-up`; run
   `./scripts/integration-bulwark-e2e.sh`.
6. Commit + push; Flux rolls staging; manual stable promotion.

## Known limitations (v1)

- **No per-tenant vanity webmail domains.** All tenants share the
  platform-wide `bulwark.${PLATFORM_BASE_DOMAIN}` URL.
- **No per-tenant branding.** Bulwark's admin-configured logos /
  company name are global.
- **No OIDC SSO from external IdPs.** Authentication is direct
  basic-auth or master-user impersonation. Bulwark's OAuth2 capability
  is unused (would require the platform's IAM story to land first —
  see ADR-039 for why this is intentional).
- **Bulwark settings backup deferred.** Per-account UI prefs (themes,
  draft auto-save) are not currently captured by tenant-backup-v2.
  Mailbox content (emails, calendars, contacts, Sieve) IS captured
  via JMAP — Bulwark is just a UI layer over Stalwart's data.
  See `docs/06-features/BULWARK_DEFERRED_WORK.md`.

## Cross-references

- ADR-039 — architecture decision
- `docs/06-features/BULWARK_DEFERRED_WORK.md` — Phase 7/8 deferrals
- `scripts/integration-bulwark-e2e.sh` — E2E harness
- `scripts/ci-stalwart-hostname-check.sh` — post-deploy guard
- `k8s/base/bulwark/` — production manifest
- `k8s/base/bulwark-impersonator/` — JWT-signed handoff sidecar
- `k8s/overlays/dev/bulwark/` + `k8s/overlays/dev/bulwark-impersonator/` —
  DinD-specific overrides (rewriter, NodePort, dev secrets)
- `memory/project_bulwark_eval_2026_05_15.md` — eval findings (14 items)
