# TLS Certificate Strategy

Phase 2c introduced a unified certificate provisioning story that covers
every TLS-terminating endpoint the platform serves: hosted apps (ingress
routes), webmail, and — eventually in Phase 3 — Stalwart's mail server
hostname.

## Goals

1. **One place to decide cert policy.** Previously, cert-manager
   Certificate CRs were created both explicitly from
   `ingress-routes/routes.ts` and implicitly via the
   `cert-manager.io/cluster-issuer` annotation on the Ingress. These
   two paths could conflict. Phase 2c collapses them into a single
   `backend/src/modules/certificates/` module that owns all Certificate
   lifecycle operations.

2. **Wildcard per customer domain when possible.** A single
   `*.acme.com + acme.com` cert covers apex, www, mail, webmail,
   autodiscover, and any future subdomain we introduce — no
   per-hostname Certificate churn, no ACME rate-limit pressure as new
   features ship.

3. **Graceful fallback.** When a wildcard is not possible
   (dnsMode=cname, dnsMode=secondary, or primary-mode with a DNS
   provider that has no cert-manager solver), per-hostname HTTP-01
   certs still work exactly as they did in Phase 2b. Nothing breaks.

4. **Zero operator decisions per domain.** The backend picks the right
   ClusterIssuer automatically from `(dnsMode, providerType,
   wildcardRequested, environment)`. Operators configure ClusterIssuers
   once at cluster bootstrap.

## The decision matrix

The selector lives in `backend/src/modules/certificates/issuer-selector.ts`.

| Environment | dnsMode | Provider supports DNS-01 solver | Wildcard requested | → Issuer | Challenge | Wildcard |
|---|---|---|---|---|---|---|
| development | * | * | * | `local-ca-issuer` | CA | yes (unused) |
| staging | * | * | * | `letsencrypt-staging-http01` | HTTP-01 | no |
| production | primary | yes (powerdns) | yes | `letsencrypt-prod-dns01-powerdns` | DNS-01 | **yes** |
| production | primary | yes (powerdns) | no | `letsencrypt-prod-http01` | HTTP-01 | no |
| production | primary | no (cloudflare, route53, …) | * | `letsencrypt-prod-http01` | HTTP-01 | no |
| production | cname | * | * | `letsencrypt-prod-http01` | HTTP-01 | no |
| production | secondary | * | * | `letsencrypt-prod-http01` | HTTP-01 | no |

**Why secondary mode falls back to HTTP-01 even though the original
cert-manager code returned `dns01`**: secondary zones are read-only
AXFR replicas. The platform can serve records but can't add
`_acme-challenge` TXT records for DNS-01. The old behaviour was a
latent bug — Phase 2c fixes it.

**Why only PowerDNS is on the DNS-01 allowlist**: Phase 2c ships one
cert-manager solver: RFC2136 pointed at a PowerDNS instance. Cloudflare,
Route53, and Hetzner all have off-the-shelf cert-manager solvers that
could be added — just extend the allowlist in
`authority.ts DNS01_SOLVER_PROVIDERS` and provision the matching
ClusterIssuer + Secret.

## ClusterIssuers

Four ClusterIssuers ship in version control:

- `k8s/base/cert-manager/clusterissuer-letsencrypt-http01.yaml` — production,
  HTTP-01 via nginx ingress. Default for `cname`/`secondary` mode and for
  `primary` mode domains whose DNS provider doesn't have a DNS-01 solver.
- `k8s/base/cert-manager/clusterissuer-letsencrypt-staging-http01.yaml` —
  LE staging, used for testing ACME issuance without hitting production
  rate limits.
- `k8s/base/cert-manager/clusterissuer-letsencrypt-dns01-powerdns.yaml` —
  production, DNS-01 via RFC2136 against the platform's PowerDNS. Used
  for wildcard issuance when `dnsMode=primary` and a PowerDNS server is
  in the domain's DNS provider group.
- `k8s/overlays/dev/cert-manager/` — self-signed local CA chain
  (`selfsigned-bootstrap` → `local-ca` → `local-ca-issuer`). Used for
  local dev so the backend can exercise the Certificate CR code path
  without reaching the real Let's Encrypt ACME server.

### Operator setup

**Let's Encrypt email address** — the manifests ship with
`operator@example.com`. Override with an overlay patch or
`kubectl apply` so renewal-failure notifications reach a real inbox.

**PowerDNS RFC2136 TSIG key** — required for wildcard DNS-01 to work.
Create once at cluster bootstrap:

```bash
# Inside PowerDNS
pdnsutil generate-tsig-key cert-manager-tsig hmac-sha256
pdnsutil activate-tsig-key <zone> cert-manager-tsig master

# In the cluster
kubectl create secret generic powerdns-tsig-key \
  -n cert-manager \
  --from-literal=tsig-secret-key='<base64 key>'
```

The `letsencrypt-prod-dns01-powerdns` ClusterIssuer references
`powerdns-tsig-key` in the `cert-manager` namespace. If the Secret is
missing, cert-manager will mark Certificates that select this issuer as
Pending until the operator fixes it — the backend detects this and
surfaces the status in the admin UI.

## Certificate naming

`backend/src/modules/certificates/service.ts certificateNameFor()` and
`tlsSecretNameFor()`:

- Non-wildcard: `<slug>-cert` / `<slug>-tls` (matches the legacy
  `domainToSecretName` output so existing secrets don't need migration)
- Wildcard: `<slug>-wildcard-cert` / `<slug>-wildcard-tls`
- Slug is `hostname.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 50)`
- Final names capped at 63 chars (DNS-1123 label max)

## Per-route provisioning flow

When an `ingress-route` row with a `deploymentId` is created or updated:

1. `ingress-routes/routes.ts` calls
   `certificates.ensureDomainCertificate(domainId)` → writes the
   domain-level Certificate CR (wildcard or apex, depending on
   selector).
2. `domains/k8s-ingress.ts reconcileIngress` rebuilds the client's
   `{namespace}-ingress`. For each route, it calls
   `certificates.ensureRouteCertificate(domainId, hostname)` to resolve
   the correct secret name:
   - If the domain has a wildcard cert that covers the hostname
     (apex or single-label subdomain), reuse the shared secret
   - Otherwise, create a per-hostname Certificate CR and return its
     own secret
3. The Ingress TLS section deduplicates secrets so a wildcard shared
   by many hostnames appears as a single entry.

## Webmail (Phase 2c.5)

Every email domain with `webmail_enabled=true` gets a
`webmail.<domain>` Ingress in the client's namespace, pointing at the
shared Roundcube Service in the `mail` namespace via an ExternalName
Service in the client's namespace. TLS secret resolution goes through
the same `ensureRouteCertificate` path, so webmail gets the wildcard
cert for free when one is available, or a per-hostname HTTP-01 cert
otherwise.

`webmail_enabled` defaults to `true` on new email domains. Operators
can toggle per domain via the admin panel Email Management table.

## Stalwart (deferred)

Phase 2c does NOT yet mount a real cert into Stalwart. The dev overlay
uses Stalwart's auto-generated self-signed cert and the Roundcube
`imap_conn_options` config disables peer verification. Production
hardening is tracked in `MAIL_SERVER_IMPLEMENTATION_STATUS.md` Phase 3
items:

- Mount the platform's wildcard secret (when available) into Stalwart
  via a volume mount and update the `[certificate.*]` block in the
  Stalwart TOML ConfigMap
- Configure Stalwart's SNI-aware cert selection (Enterprise-only today)
  once per-customer mail hostnames become a requirement
- Re-enable `verify_peer = true` in Roundcube's TLS config

Until then, the global mail hostname (`mail.platform.com`) continues to
use Stalwart's self-signed cert and email clients accept it because
the CNAME chain is transparent.

## Migration from Phase 2b

The Phase 2b per-hostname Certificate CRs that existing clients already
have will be replaced on the first reconcile after upgrading to Phase
2c. `reconcileIngress` re-runs `ensureRouteCertificate` for every
route, which:

- Creates the new domain-level Certificate CR (and wildcard, if
  applicable) as a side effect
- Updates the Ingress TLS section to reference the new secret names
- Leaves the old per-hostname Certificates and secrets in place until
  the next `deleteDomainCertificate` call (on domain deletion)

Operators can manually clean up stale Certificates with
`kubectl delete certificate` if desired, but it's not required —
cert-manager will ignore them.

## DNS authority gate (bonus fix)

`backend/src/modules/dns-servers/authority.ts canManageDnsZone()` is
the new single source of truth for "can the platform write records in
this zone?". It gates:

- `dns-records/service.ts syncRecordToProviders` — previously tried to
  write records on `cname`-mode domains and silently failed, spamming
  logs with warnings. Now short-circuits with a single info line.
- `email-domains/dns-provisioning.ts provisionEmailDns` — same silent-
  failure bug, now fixed. An email domain provisioned on a cname-mode
  customer domain no longer claims `mxProvisioned=1` when in fact no
  MX record was written.
- `certificates/issuer-selector.ts canIssueWildcardCert` — the
  "wildcard possible" check is built on top of `canManageDnsZone`.

## RBAC

`k8s/base/rbac.yaml platform-api` ClusterRole now has:

- `cert-manager.io/certificates`: get/list/watch/create/update/patch/delete
- `cert-manager.io/issuers`, `cert-manager.io/clusterissuers`:
  get/list/watch (read-only — operators provision these, the backend
  just reads to validate)

This was missing in Phase 2b. Every previous call to
`k8s.custom.createNamespacedCustomObject({ group: 'cert-manager.io', … })`
would have failed in production. The RBAC fix is included in the
commit that introduced the certificates module.
