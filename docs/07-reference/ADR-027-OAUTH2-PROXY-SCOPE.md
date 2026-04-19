# ADR-027: OAuth2-Proxy Scope — Platform Panels Only

**Status:** Accepted · 2026-04-19
**Supersedes:** implicit assumption in `backend/src/modules/oidc/ingress-proxy-manager.ts` that "protected domains" could include customer apps.
**Follow-ups:** See "Future extension" section — not implemented.

---

## Context

The platform runs a single oauth2-proxy Deployment behind the in-cluster
Service `oauth2-proxy.platform.svc.cluster.local:4180`. Two separate
questions around scope kept surfacing during design discussions:

1. Is oauth2-proxy meant to protect only the platform's own panels
   (admin / client), or should it also gate customer-deployed
   applications?
2. If a customer's app ever rides behind oauth2-proxy, does the cookie
   secret sharing with admin/client-panel sessions compromise tenant
   isolation?

This ADR records the answer we committed to in the 2026-04-19 domain
consolidation work.

---

## Decision

**OAuth2-proxy is scoped to the platform's own admin and client panels
only.** Customer-deployed applications are out of scope for this
instance.

Specifically:

- `backend/src/modules/oidc/ingress-proxy-manager.ts` toggles auth
  annotations only on the platform ingress resources that serve
  `admin.<base>` and `client.<base>`.
- `backend/src/modules/system-settings/ingress-reconciler.ts` emits
  a `/oauth2` prefix path rule per protected panel host, so callbacks
  land on the panel's own domain (transparent per-panel pattern), not
  a shared `oauth2.<base>`.
- Dex has two redirect URIs — one per panel — registered under a single
  OIDC client (`hosting-platform-oauth2-proxy`).
- No code path exists today that adds oauth2-proxy auth annotations to
  a customer application's ingress.

---

## Consequences

### Positive
- **Simpler trust model.** All sessions inside the oauth2-proxy cookie
  domain (`.<base>`) belong to platform operators or customer admins
  who've logged into the platform's own panels. No third-party app
  traffic is inside that trust boundary.
- **Single cookie secret.** Admin and client panels share the cookie
  secret; this is safe because both panels trust the same set of
  subjects (operators and customers already authenticate there).
- **Transparent UX.** Callback URL is on the panel's own domain
  (`https://admin.<base>/oauth2/callback`) — the operator never sees
  a separate `oauth2.<base>` hostname.

### Negative
- Customers who want SSO in front of their own apps must implement it
  themselves (via their app's own OIDC library, Authelia sidecar, etc.)
  — the platform does not provide a click-to-enable equivalent.
- Two Dex redirect URIs per OIDC client — not zero, but a small and
  fixed cost.

---

## Why not also protect customer apps?

Shared oauth2-proxy + shared cookie secret + multiple customer apps is
not safe without isolation measures we do not yet implement:

1. **Session leakage between tenants.** oauth2-proxy signs its session
   cookie (`_platform_oauth2`) with a single `OAUTH2_PROXY_COOKIE_SECRET`.
   If customer A and customer B both delegate auth to the same
   oauth2-proxy and both ingresses set the cookie on `.<base>`, then a
   session cookie valid for customer A's app is cryptographically valid
   for customer B's app on the same domain. Tenant isolation gone.

2. **Callback URL ambiguity.** oauth2-proxy derives the callback host
   from `X-Forwarded-Host` at request time. That works for two panels
   under operator control (we verified both are in Dex's allow-list),
   but doesn't scale — each new customer domain would need manual
   registration at Dex, or we'd have to make the allow-list wildcard
   (security sensitive).

3. **Operational blast radius.** A single oauth2-proxy outage would
   take down every customer app that delegated auth to it. Per-tenant
   isolation prevents that.

---

## Future extension (NOT YET IMPLEMENTED)

If we later decide to offer oauth2-proxy protection to customer apps,
the design MUST address:

- **Per-tenant cookie secret.** Either one oauth2-proxy Deployment per
  tenant (most isolated, most k8s resources), or a single oauth2-proxy
  with per-host cookie scoping — oauth2-proxy supports `--cookie-domain`
  but only one value per instance, so "shared instance, per-tenant
  cookie" requires upstream work.
- **Per-tenant Dex client.** Rather than one OIDC client with N
  redirect URIs, each tenant would get its own `client_id` so scopes
  and claims can differ. Auto-provisioning on tenant creation would
  need to be wired.
- **Meta-router.** A proxy in front of the per-tenant oauth2-proxy
  instances routing by `Host:` header to the right backend. Adds
  latency and a single point of failure — needs thought.
- **UI.** The admin panel would gain a "Protect with OIDC" toggle on
  customer app ingresses, mirroring the panel-level toggle but
  targeting a per-tenant config row.

Estimated work for the future extension: 2-4 weeks of focused design
+ implementation + security review. Not on the near-term roadmap.

---

## Related

- `backend/src/modules/oidc/ingress-proxy-manager.ts` — current annotation
  syncer.
- `backend/src/modules/system-settings/ingress-reconciler.ts` — emits the
  `/oauth2` path rule on protected panel hosts.
- `k8s/overlays/dev/dex/config.yaml` — shows the two-redirect-URI pattern
  per-panel.
- `ADR-022-IAM-SEPARATION.md` — why Dex itself is not tenant-scoped.
