# Dex OIDC on dev/staging

Dex is the OIDC issuer used by **dev and staging only** — never production.
It exists to give the platform a reachable OIDC provider during testing
of features that depend on OIDC (admin / client panel SSO, oauth2-proxy
gates for admin-only UIs, per-tenant ingress-route OIDC protection).

The production overlay does not include Dex. CI guard
`scripts/ci-no-dex-in-production.sh` enforces this — see
`.github/workflows/ci-infrastructure.yml` job `no-dex-in-production`.

## Staging deployment

| Field | Value |
|-------|-------|
| Issuer | `https://dex.staging.<DOMAIN>/dex` |
| Discovery | `https://dex.staging.<DOMAIN>/dex/.well-known/openid-configuration` |
| JWKS | `https://dex.staging.<DOMAIN>/dex/keys` |
| Storage | postgres, shared with platform-api `app` database (since 2026-05-06) |
| Replicas | owned by M14 storage-policy reconciler — HA-safe with shared storage |

Manifests live in `k8s/overlays/staging/dex/`:
- `config.yaml` — issuer, storage, staticClients, staticPasswords
- `deployment.yaml` — pod spec + env-var wiring for postgres credentials
- `service.yaml` — ClusterIP, sessionAffinity:ClientIP (defence in depth)

## Static OIDC clients

Three static clients are baked into `config.yaml` with hardcoded secrets.
These are **dev/staging-only credentials**, intentionally simple so the
integration harness can authenticate without out-of-band setup:

| client_id | client_secret | redirect_uri | Used by |
|-----------|---------------|--------------|---------|
| `hosting-platform-admin` | `staging-secret-admin` | `https://admin.<DOMAIN>/api/v1/auth/oidc/callback` | Admin panel SSO via platform `/auth/oidc/*` |
| `hosting-platform-client` | `staging-secret-client` | `https://admin.<DOMAIN>/api/v1/auth/oidc/callback` | Client panel SSO via platform `/auth/oidc/*` |
| `hosting-platform-oauth2-proxy` | `$OAUTH2_PROXY_CLIENT_SECRET` (env-substituted from the `oauth2-proxy-config` Secret created by bootstrap.sh) | `https://admin.<DOMAIN>/oauth2/callback` | Admin-only UIs gated by oauth2-proxy (Longhorn, Stalwart web-admin) |

## Static password test users

`enablePasswordDB: true` plus two pre-hashed `staticPasswords` entries:

| email | password | userID | Typical use |
|-------|----------|--------|-------------|
| `admin@k8s-platform.test` | `admin` | `00000000-0000-0000-0000-000000000001` | Drives the admin-panel OIDC flow in `integration-oidc-dex.sh` |
| `user@k8s-platform.test` | `user` | `00000000-0000-0000-0000-000000000003` | Drives the client-panel OIDC flow in `integration-oidc-dex.sh` |

These users are **only valid against Dex** — the platform-api auto-
provisions them on first login through `findOrCreateOidcUser()` and
assigns the OIDC provider's `default_role` (typically `read_only` for
admin and `client_admin` for client). Behaviour is intentional security
default; do not rebind them to `admin` without an explicit operator
action.

## When Dex breaks

Common symptoms and their causes — all caught at least once during
the May 2026 hardening sprint:

1. **`Unregistered redirect_uri` from Dex** — platform-api emitted
   `http://` because Fastify's `request.protocol` returns the literal
   transport scheme even with `trustProxy: true`. Fixed by reading
   `X-Forwarded-Proto` directly + a force-https fallback for non-local
   hosts. See `backend/src/modules/oidc/routes.ts:resolveScheme`.

2. **`invalid 'state' parameter / not found` in Dex logs** — auth state
   created on Dex pod A is invisible to pod B because per-pod SQLite.
   Fixed by switching `storage.type` to postgres so all replicas share
   state. The previous `replicas:1` workaround has been reverted.

3. **`OIDC_STATE_INVALID` from platform-api** — the platform's own
   PKCE store was an in-memory Map, so `/authorize` and `/callback`
   landing on different platform-api replicas dropped the state. Fixed
   by `0086_oidc_pkce_state.sql` migration which moves the store to
   postgres.

4. **Intermittent 404 on `dex.staging.<DOMAIN>`** — one node's
   nginx-ingress controller missed an Ingress watch update and serves
   a stale `nginx.conf`. Detect and repair with
   `scripts/check-nginx-ingress-drift.sh --repair`.

5. **Bad creds rejected silently** — Dex's static-password connector
   re-renders the login form on bad credentials with no Location
   header (HTTP 200, not 400). The integration harness treats this as
   "Dex login POST returned no Location" and surfaces the row.

## Rotating staging secrets

The `staging-secret-admin` / `staging-secret-client` strings live in
git. Treat them as documentation, not secrets — staging is not a
production environment and these credentials don't grant access to
anything beyond the test users above. To rotate:

1. Edit the `secret:` value in `k8s/overlays/staging/dex/config.yaml`.
2. Update the matching value wherever the platform stores it (admin
   UI → System Settings → OIDC Providers, or DB
   `oidc_providers.client_secret_encrypted`).
3. Push — Flux re-rolls Dex and platform-api refreshes the encrypted
   secret on the next provider write.

`$OAUTH2_PROXY_CLIENT_SECRET` is generated by `bootstrap.sh` per
cluster and lives in the `oauth2-proxy-config` Secret. To rotate, run
the relevant section of bootstrap.sh again or kubectl-edit the Secret
and re-roll Dex + oauth2-proxy.

## See also

- `scripts/integration-oidc-dex.sh` — the regression harness.
- `scripts/ci-no-dex-in-production.sh` — production guard.
- `.github/workflows/ci-infrastructure.yml` — CI wiring.
- Migration `backend/src/db/migrations/0086_oidc_pkce_state.sql` —
  postgres-backed PKCE store on platform-api side.
- `backend/src/modules/oidc/routes.ts` — `resolveScheme()` helper +
  PKCE store wrapper.
