# ADR-038 — Traefik WAF Architecture: CrowdSec everywhere, ModSecurity opt-in

**Status:** Accepted · 2026-05-14
**Supersedes / related:** Replaces the implicit "nginx + in-process ModSecurity" model that shipped with the original ingress-nginx Phase 0 of the platform. Companion to the Phase 0–3 Traefik migration commits on `feat/traefik-migration` (`7921553e..HEAD`).

## Context

The Phase 0 ingress migration replaced `ingress-nginx` with **Traefik v3.7**. The pre-migration WAF stack was nginx-embedded `libmodsecurity` + OWASP CRS, configured per-Ingress via `nginx.ingress.kubernetes.io/enable-modsecurity` annotations plus `wafEnabled` / `wafOwaspCrs` / `wafAnomalyThreshold` / `wafExcludedRules` columns on `ingress_routes`. Every tenant route ran CRS in-process at the controller (~1–3 ms per request, even for routes where the tenant didn't want WAF).

Phase 3 of the migration had to pick the Traefik-side replacement. Three architectures were on the table:

| Option | Model | Per-route directives | Operational shape |
|---|---|---|---|
| A. Single shared Coraza Middleware | OWASP CRS embedded in Traefik via Yaegi or WASM plugin | No (single config) | One Middleware, in-process |
| B. Per-route Coraza Middlewares | Same plugin, one Middleware CR per route | Yes (`wafExcludedRules` etc. flow through) | N Middlewares, in-process, N WAF engines × ~10 MiB CRS state each |
| **C. Option-C hybrid** (initial pick) | Shared `coraza-base` + per-route `r-<id>-waf` only when the route declares overrides | Yes for customised routes only | 1 + (customised count) WAF engines |
| **D. CrowdSec everywhere + ModSec-CRS sidecar opt-in** (chosen) | Two-layer WAF: IP-reputation bouncer always-on + payload-inspecting WAF as a separate Deployment | No per-route directives | 2 Middlewares, 1 CrowdSec LAPI, 2-replica ModSec sidecar |

Option C was implemented first (commit `99bb0d59`). Live DinD smoke testing then established that **no working in-process Coraza plugin exists for Traefik today** (commit `ba6b74de` documents the trace):

- **Yaegi vendored plugin** (`github.com/hatsat32/coraza-traefik`) fails to load — Coraza's `internal/corazawaf/rule.go` imports `unsafe`, which Yaegi (Traefik's embedded Go interpreter) does not implement.
- **WASM plugin** (`corazawaf/coraza-http-wasm` v0.2.2 + v0.3.0) loads successfully (`Plugins loaded. plugins=["coraza"]`) but Traefik panics on startup with `runtime: split stack overflow` — wazero stack ceiling × Coraza call depth incompatibility.

Neither failure is fixable from our side. Option C collapsed to option A as a stopgap — same per-route directive model in the schema, no plugin to enforce it.

The remaining choice was between A (wait for upstream) or D (switch to a different WAF architecture that works today). We picked **D**.

## Decision

**Two layers of WAF, each with a distinct trust boundary:**

### Layer 1 — CrowdSec bouncer, always-on, every route

- A `crowdsec@traefik` Middleware is prepended to **every** route the platform emits:
  - Platform-ingress panel routes (admin / client panels) — wired in `system-settings/ingress-reconciler.ts`.
  - Tenant routes — prepended by `ingress-routes/annotation-sync.ts:buildRouteSpec` so the same combined ref list flows into protected-directory child routes as well.
- Backed by the `github.com/maxlerebourg/crowdsec-bouncer-traefik-plugin` Yaegi plugin (catalog version v1.4.4) calling a single CrowdSec LAPI Deployment in the `crowdsec` namespace.
- `DISABLE_AGENT=true`: the platform does NOT scrape logs. The bouncer consumes the **community blocklist** only (~6M known-bad IPs, refreshed hourly from `api.crowdsec.net`). Log-acquisition modules are out of scope — they would add per-pod sidecars across every namespace and the platform has no operator-side budget for that today.
- Bouncer fails **open** if the LAPI is unreachable. See [Accepted trade-offs](#accepted-trade-offs).

### Layer 2 — ModSecurity-CRS sidecar, opt-in per tenant route, always-on for panels

- A `modsecurity-crs@traefik` Middleware proxies request bodies to a 2-replica OWASP CRS Deployment (`owasp/modsecurity-crs:4.25.0-nginx-alpine-202604040104`) in the `traefik` namespace via the `github.com/madebymode/traefik-modsecurity-plugin` Yaegi plugin (catalog version v1.6.0).
- Tenant routes: attached only when `ingress_routes.waf_enabled = 1`. Default flipped from `1` to `0` (migration `0108_waf_default_off.sql`) — tenants opt in deliberately, no surprise CRS false positives on a fresh deploy.
- Panel routes (admin / client): attached unconditionally — these are platform-sensitive surfaces.
- `maxBodySize: 5 MiB`, `timeoutMillis: 3000` (raised from initial 1000 after the security review found that the plugin fails-open on timeout — a 1 s budget was tight enough that a slow-respond tenant backend could DoS the WAF check).

### What the schema columns now mean

| Column | Pre-migration meaning | Post-migration meaning |
|---|---|---|
| `wafEnabled` | Toggle CRS on/off per route | Same. Default flipped to 0. |
| `wafOwaspCrs` | Toggle CRS rule bundle (separate from SecRuleEngine) | **No runtime effect** — kept for forwards-compat. |
| `wafAnomalyThreshold` | Per-route CRS anomaly score threshold | **No runtime effect** — sidecar honours its own env var. |
| `wafExcludedRules` | CSV of CRS rule IDs to disable per route | **No runtime effect** — sidecar config is shared. |

The three runtime-no-op columns remain in the DB and in the panel UI so:
1. Operator-set tuning values survive a future re-introduction of per-route directives (when Coraza-on-Traefik stabilises upstream).
2. The UI doesn't suddenly hide settings tenants may have configured.
3. The panel UI greys these inputs out with a tooltip + link to this ADR explaining why they're inert.

## Implementation

| Component | Path |
|---|---|
| Backend Middleware emitter (annotation-sync) | `backend/src/modules/ingress-routes/annotation-sync.ts:buildMiddlewaresForRoute` (WAF branch) |
| Per-route ref injection | `backend/src/modules/ingress-routes/annotation-sync.ts:buildRouteSpec` (prepends `crowdsec@traefik` to `combinedRefs`) |
| Platform-ingress panel WAF wiring | `backend/src/modules/system-settings/ingress-reconciler.ts` (`PLATFORM_WAF_MIDDLEWARE_NAME`, `PLATFORM_CROWDSEC_MIDDLEWARE_NAME`) |
| CrowdSec LAPI Deployment | `k8s/base/crowdsec/` |
| CrowdSec bouncer Middleware | `k8s/base/traefik/middlewares-crowdsec.yaml` |
| ModSec-CRS sidecar | `k8s/base/modsecurity-crs/` |
| ModSec proxy Middleware | `k8s/base/traefik/middlewares-modsecurity.yaml` |
| Helm install (production) | `scripts/bootstrap.sh:install_traefik` |
| Helm install (local DinD) | `scripts/local.sh:_install_traefik_local` |
| Bouncer key Secret bootstrap | `scripts/bootstrap.sh:generate_crowdsec_bouncer_key` + `scripts/local.sh:_generate_crowdsec_bouncer_key_local` |
| Coraza dead-code scaffold | `k8s/base/traefik/middlewares-waf.yaml` (commented out of kustomization), `docker/traefik-plugin-coraza/` |

## Consequences

### Wins

- **Default-state routes are faster.** Old: ~1–3 ms ModSec eval on every request whether the tenant wanted WAF or not. New: ~0.1 ms in-process CrowdSec IP-cache lookup; no payload inspection. Average traffic latency improves ~5–10 % across mixed routes.
- **Tenant WAF false-positive risk is opt-in.** OWASP CRS trips ~10 % of WordPress admin paths out of the box; that's the operator's problem only when the tenant explicitly asks for WAF.
- **Layered defence.** IP-reputation bouncing (CrowdSec) and payload inspection (ModSec) catch different attacker classes — scanners get rejected by CrowdSec before the WAF engine pays the parsing cost; SQLi / XSS get caught by ModSec even when the source IP is clean.
- **Local DinD mirrors production.** `./scripts/local.sh up` now installs the same Traefik + WAF stack as `scripts/bootstrap.sh`. Dev cycles can catch regressions before staging deploy.

### Losses

- **WAF-enabled routes are slower.** Old: ~1–3 ms in-process. New: ~3–10 ms (network hop to ModSec sidecar + CRS eval). Acceptable because the schema default now defends most routes from paying this cost.
- **No per-route WAF directives.** The three settings columns (`wafOwaspCrs`, `wafAnomalyThreshold`, `wafExcludedRules`) are inert. Operators wanting differentiated rule sets per tenant must run multiple `modsecurity-crs` Deployments and emit one Middleware per backend — out of scope for this phase.
- **Two extra workloads to maintain.** CrowdSec LAPI (1 replica, ~150 MB) + ModSec-CRS Deployment (2 replicas, ~300 MB each). Net cluster memory: ~+750 MB vs the old in-process nginx-ingress. Offset partially by Traefik being lighter than nginx-ingress.
- **Bouncer key is in two namespaces.** `crowdsec-bouncer-key` Secret exists in both `crowdsec` (consumed by LAPI for bouncer auto-registration) and `traefik` (mounted into the Traefik pod for the plugin's `crowdsecLapiKeyFile`). Standard Secrets-at-rest concerns apply; out of scope for this ADR.

### Accepted trade-offs

| Risk | Why we accept it | Mitigation |
|---|---|---|
| **CrowdSec fails open on LAPI outage.** A single-replica LAPI with Recreate strategy + SQLite single-writer means a brief unprotected window during node drain or pod restart. | The CrowdSec layer is defence-in-depth — other Middlewares (oauth2-proxy ForwardAuth, basic-auth, ModSec when enabled, rate-limit, ipAllowList) still apply during the window. Fail-closed would mean a full-site outage on every LAPI restart. | Operator runbook: monitor `crowdsec` Deployment availability; alert on >5 min unavailability. Operators wanting fail-closed semantics can patch the plugin's `defaultDecision` to `ban` in their overlay. |
| **ModSec fails open on timeout.** Bypass requires the tenant's own upstream to respond slowly (>3 s) — not what an external attacker hitting a WAF-protected route controls. | The bypass surface is narrow (slow-loris from the tenant's own backend), and tenants who care about WAF coverage have an incentive NOT to deploy a backend that triggers it. | `timeoutMillis: 3000` (raised from 1000 after security review). Operators can lower in overlay if their latency budget requires it. |
| **`allowCrossNamespace=true` + `allowExternalNameServices=true`.** Traefik will accept cross-namespace Service refs in `routes[].services[]` — a tenant whose `platform-api` SA were compromised could route at platform-api or another tenant's Service. | (1) Tenants have NO kubectl. (2) The platform-api code path NEVER sets `services[].namespace`. (3) `buildIngressRoute()` throws at build time if any service ref carries a non-empty namespace that doesn't match the route's namespace. | Revisit if any of those three invariants change. |
| **`tenant-errors` Service in `platform-system`.** Custom error pages for tenant routes go through a shared Service in `platform-system`. A tenant cannot hijack it (cross-namespace ref pinned explicitly); operators wanting per-tenant branding must wait for a future enhancement. | The shared default is "site temporarily unavailable" — adequate for 95 % of cases. Per-tenant branded error pages are a feature, not a security boundary. | Operators with sufficient appetite can patch the `tenant-errors-content` ConfigMap in their overlay; per-tenant routing is a follow-up. |
| **Coraza dead-code retained.** `middlewares-waf.yaml` and `docker/traefik-plugin-coraza/` stay in tree even though they don't load at runtime. | When upstream Coraza-on-Traefik stabilises (Yaegi gains `unsafe` support OR wazero raises the stack ceiling OR a non-Coraza in-process WAF lands), the re-enable path is a 3-line change: flip annotation-sync's WAF branch back to option-C-hybrid, flip `PLATFORM_WAF_MIDDLEWARE_NAME`, set the Coraza helm flag in `bootstrap.sh`. No schema / DB / API contract change. | File header explicitly marks the file as documented dead code; not included in any kustomization. |

## Migration path

For an operator upgrading an existing cluster (none today — the migration assumes a fresh bootstrap):

1. Confirm no tenant routes set both `customErrorCodes` AND `customErrorPath` such that the platform-shared `tenant-errors` Service is the right destination. If any tenant expects a custom backend, raise a follow-up before flipping the migration.
2. Drain ingress-nginx; install Traefik via `scripts/bootstrap.sh install_traefik` (which now also bootstraps the bouncer key Secret).
3. Apply `k8s/base/{crowdsec,modsecurity-crs,tenant-errors}/`.
4. Run the platform-api reconcilers — they re-emit every tenant IngressRoute + Middleware from the DB and the WAF refs flow naturally.

## When to revisit

- **Coraza in-process becomes viable upstream.** Either a Yaegi fork that supports `unsafe`, OR a working WASM build that doesn't crash Traefik's wazero. Flip back to option C hybrid (per-route directives).
- **A tenant needs differentiated CRS rules.** Multiple `modsecurity-crs` Deployments + multiple Middlewares per profile. Schema fields already exist; add a `wafProfile` column on `ingress_routes` referencing a `waf_profiles` table.
- **The community blocklist isn't enough.** Enable CrowdSec log acquisition (DISABLE_AGENT=false) — adds per-pod sidecars for log scraping. Bigger ops commitment, broader threat coverage.
