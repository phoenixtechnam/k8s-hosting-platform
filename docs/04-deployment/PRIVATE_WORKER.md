# Private Worker

Per-client tunnel agents that let a client expose a service running outside the cluster (home box, NAS, GPU machine, on-prem VPS) under their platform-issued ingress, with all the ingress features they already get for in-cluster deployments.

## What it is

A **single Docker container** the client runs anywhere they have outbound HTTPS, plus a **per-client cluster-side proxy pod** that terminates the tunnel inside the client's namespace and exposes the remote service via a normal `Service` that ingress routes can target.

Not a Kubernetes node. Not a catalog entry. A standalone platform feature, sibling to `sftp-users`, `domains`, `mailboxes`.

## Use cases

- Expose a home GPU inference endpoint as `gpu.bobs-tenant.com`
- Front a self-hosted database / NAS / IoT bridge with platform TLS + DNS + access control
- Migrate gradually from on-prem to platform-hosted (run the legacy backend at home behind the platform's ingress until cut-over)

## What it deliberately is **not**

- A k3s worker join path (the original design was scrapped — too much surface for too little value)
- A way to run arbitrary platform workloads on the home box (private worker hosts one service the client controls, full stop)
- A replacement for catalog deployments — the catalog stays the model for "code the platform runs"

---

## Architecture

```
┌────────────────┐       wss://tunnels.${DOMAIN}/c/{slug}/
│ Home docker    │──────────────────────────────────────────────┐
│ container      │                                              │
│ (private-      │  outbound TCP/443, NAT/CGNAT-friendly        │
│  worker-agent) │                                              │
└────────────────┘                                              │
                                                                ▼
                                  ┌──────────────────────────────────────┐
                                  │   NGINX-ingress (platform-system)    │
                                  │   - Anchor Ingress: tunnels.${DOMAIN}│
                                  │     (one cert via existing flow)     │
                                  │   - Per-client path-rule Ingresses   │
                                  │     /c/{slug}/(.*) → ExternalName    │
                                  └──────────────────┬───────────────────┘
                                                     │ rewrite /c/{slug}/ → /
                                                     │ WebSocket Upgrade
                                                     ▼
                                  ┌──────────────────────────────────────┐
                                  │   ExternalName Service               │
                                  │   tunnel-{slug}.platform-system →    │
                                  │   private-worker-server.{client-ns}  │
                                  └──────────────────┬───────────────────┘
                                                     │
                                                     ▼
                                  ┌──────────────────────────────────────┐
                                  │   Client namespace                   │
                                  │   ┌───────────────────────────────┐  │
                                  │   │ private-worker-server pod     │  │
                                  │   │ (frps in WebSocket mode)      │  │
                                  │   │ counts toward client quota    │  │
                                  │   └───────────────┬───────────────┘  │
                                  │                   │                  │
                                  │   ┌───────────────▼───────────────┐  │
                                  │   │ Service: pw-{worker-id}       │  │
                                  │   │ ClusterIP, port = exposed     │  │
                                  │   │ ↑ ingressRoutes target        │  │
                                  │   └───────────────────────────────┘  │
                                  └──────────────────────────────────────┘
                                                     ▲
                                                     │
                                                     │ tenant ingress
                                                     │ (existing flow)
                                                     │
                                  ┌──────────────────┴───────────────────┐
                                  │   external user → app.bob.tld        │
                                  └──────────────────────────────────────┘
```

### Two distinct ingress paths

1. **Tunnel dial-in** (`tunnels.${DOMAIN}/c/{slug}/`) — the home agent's outbound WebSocket lands here. Single FQDN for all clients; URL path is the routing key. One cert, one DNS record.
2. **Tenant traffic** (`app.bob.tld` or whatever the client's domain is) — flows through the existing ingress chain unchanged. The Service it targets happens to be backed by the frp-server pod, but the ingress doesn't know or care.

Every existing ingress feature (rate limit, oauth2-proxy auth_request, mTLS, redirects, protected paths, claim-based access control) applies to path 2 unchanged because the cluster-side termination is a normal Service.

### Network access modes

`network_access_mode` (`public | ziti | zrok`) is orthogonal to private-worker. The mode controls *how external users reach the Service*; private-worker controls *what the Service is backed by*. They compose:

- public ingress + private-worker backend
- ziti tunneler + private-worker backend
- zrok share + private-worker backend

The existing `deployment-network-access/reconciler.ts` will be extended to recognize a `private_worker_id` as a target the same way it recognizes a `deployment_id`.

---

## Single-token model

The home agent is **stateless**. One credential lives in an environment variable:

```bash
docker run -e PRIVATE_WORKER_TOKEN=pwt_<base64url-blob> \
  ghcr.io/phoenixtechnam/private-worker-agent:latest
```

The blob is base64url-encoded JSON:

```json
{
  "v": 1,
  "slug": "bobs-slug",
  "server_url": "wss://tunnels.example.com/c/bobs-slug/",
  "secret": "<32-bytes-base64url>",
  "expose": [
    { "name": "web", "local": "127.0.0.1:8080", "remote_port": 8080 }
  ]
}
```

`docker compose down/up`, `docker pull && restart`, Watchtower auto-updates — all work without manual re-enrollment because nothing was persisted on the host.

### Why one token, not two

The earlier two-token model (single-use enrollment + persistent auth) assumed the home agent had durable state. It doesn't. `docker compose down -v` would have nuked the auth token volume and broken the tunnel. We collapse to one credential matching the Cloudflare Tunnel / ngrok / Tailscale-authkey UX.

### Token properties

| Property | Value |
|---|---|
| Per-client shared secret | `clients.private_worker_shared_secret` — frps 0.62 supports one `auth.token` per server, and we run one frps pod per client, so all workers under the same client share a single auth secret |
| Format | base64url-encoded JSON blob the agent reads from the `PRIVATE_WORKER_TOKEN` env var |
| Storage at rest | Plaintext in DB (DB is encrypted at rest); SHA-256 hash also stored on each `private_workers` row for forward compat with future per-worker auth via frps webhook plugin |
| Display | Once, on creation; never re-shown |
| Per-worker revocation | DB row marked `revoked` → reconciler removes the worker's port from frps `allowPorts` → frpc proxy registration is rejected within ~30s |
| Per-worker rotation | **v1 limitation**: rotates the shared per-client secret, invalidating every sibling worker. UI shows a warning before confirming. v2 will add per-worker tokens via frps webhook plugin. |

### Defense in depth

| Layer | Mechanism |
|---|---|
| Transport | TLS 1.2+ at NGINX-ingress; one cert for `tunnels.${DOMAIN}` |
| Auth | Token validated by frps on every control-plane message |
| Rate limit | NGINX-ingress: 5 failed handshakes/min/IP on `/c/{slug}/`; 10/min on management endpoints |
| Network policy | frp-server pod ingress allowed only from nginx-ingress namespace; egress only kube-DNS |
| Authorization | Token scoped to one `private_worker_id`; reconciler renders frps config so the token only services that worker's proxies |
| Observability | `last_seen_at`, `last_used_ip`, audit log of mint/revoke/validate-fail/ip-change events |
| Revocation SLA | <30s from operator click to dropped connection |

Optional Phase 2 hardenings: cluster cert pinning at agent, mutual TLS (replace bearer with client cert), agent image signing, geo allowlist on dial-in.

---

## Schema

Migration `0076_private_workers.sql` adds two tables and one enum:

```sql
CREATE TYPE private_worker_status AS ENUM ('pending','active','revoked','suspended');

CREATE TABLE private_workers (
  id                 varchar(36) PRIMARY KEY,
  client_id          varchar(36) NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  name               varchar(120) NOT NULL,
  slug               varchar(60) NOT NULL UNIQUE,
  worker_token_hash  varchar(64) NOT NULL,           -- SHA-256 of secret portion
  status             private_worker_status NOT NULL DEFAULT 'pending',
  exposed_port       integer NOT NULL,               -- internal cluster port the Service listens on
  description        text,
  last_seen_at       timestamp,
  last_used_ip       inet,
  bytes_in           bigint NOT NULL DEFAULT 0,
  bytes_out          bigint NOT NULL DEFAULT 0,
  created_by         varchar(36),
  created_at         timestamp NOT NULL DEFAULT now(),
  revoked_at         timestamp,
  revoked_by         varchar(36),
  updated_at         timestamp NOT NULL DEFAULT now()
);
CREATE INDEX private_workers_client_id_idx ON private_workers(client_id);
CREATE UNIQUE INDEX private_workers_client_name_uq ON private_workers(client_id, name);

CREATE TABLE private_worker_audit (
  id                 bigserial PRIMARY KEY,
  private_worker_id  varchar(36) NOT NULL REFERENCES private_workers(id) ON DELETE CASCADE,
  event              varchar(40) NOT NULL,           -- mint|rotate|revoke|freeze|unfreeze|validate-fail|ip-change|connect|disconnect
  ip                 inet,
  detail             jsonb,
  occurred_at        timestamp NOT NULL DEFAULT now()
);
CREATE INDEX private_worker_audit_worker_idx ON private_worker_audit(private_worker_id, occurred_at DESC);
```

Polymorphic ingress target (separate migration if not already present):

```sql
CREATE TYPE ingress_target_type AS ENUM ('deployment','private_worker');

ALTER TABLE ingress_routes
  ADD COLUMN target_type ingress_target_type NOT NULL DEFAULT 'deployment',
  ADD COLUMN private_worker_id varchar(36) REFERENCES private_workers(id) ON DELETE CASCADE,
  ALTER COLUMN deployment_id DROP NOT NULL,
  ADD CONSTRAINT ingress_routes_target_xor CHECK (
    (target_type = 'deployment' AND deployment_id IS NOT NULL AND private_worker_id IS NULL)
    OR
    (target_type = 'private_worker' AND private_worker_id IS NOT NULL AND deployment_id IS NULL)
  );
```

---

## Components

### Backend module `backend/src/modules/private-workers/`

| File | Responsibility |
|---|---|
| `service.ts` | `createPrivateWorker`, `listPrivateWorkers`, `getPrivateWorker`, `rotatePrivateWorker`, `revokePrivateWorker`, `freezePrivateWorker`. Token mint, hash (SHA-256), audit-log writes. Throws `ApiError` on validation failures. |
| `routes.ts` | `/api/v1/clients/:clientId/private-workers` — CRUD + rotate + revoke + freeze. Auth via existing `authenticate + requireClientRoleByMethod + requireClientAccess` chain. |
| `internal-routes.ts` | `/api/v1/internal/private-workers/connect-event` — frps server posts connect/disconnect events here for telemetry (`last_seen_at`, `last_used_ip`, audit). Internal auth shared-secret. |
| `reconciler.ts` | Per-client K8s materialisation. Idempotent. Ref-counted on `private_workers` rows for that client. Creates: ConfigMap (frps.toml), Secret (per-worker tokens), ClusterIP Service per worker, Deployment for the frps pod, ExternalName Service in `platform-system`, per-client Ingress with path rule. Mirrors `deployment-network-access/reconciler.ts` upsert helpers. |

### Lifecycle hook

`backend/src/modules/client-lifecycle/hooks/db-private-workers.ts`:

| Transition | Action |
|---|---|
| `suspended` | Set all rows `status='suspended'`. Reconciler scales frps Deployment to 0 replicas. Existing connection drops; agent retries fail. |
| `restored` | Set rows back to `status='active'`. Reconciler scales replicas to 1. |
| `archived` | Tear down per-client Ingress + ExternalName + frps Deployment. Rows kept for restore. |
| `deleted` | Hard-delete `private_workers` rows. Cluster cleanup via `registerClusterScopedRefsCleanupHook` extension. |

### Cluster-side artefacts

Per-client (in `client-{slug}` namespace):

```
Deployment   private-worker-server   (1 replica, ~25m CPU req / 64Mi RAM limit)
ConfigMap    private-worker-server-config   (frps.toml templated from DB)
Secret       private-worker-tokens   (per-worker secrets)
Service      pw-{worker-id}   (ClusterIP, one per worker, exposed_port)
NetworkPolicy frp-server-allow-ingress + frp-server-deny-egress-default
```

Per-client (in `platform-system`):

```
Ingress       tunnel-{slug}   (host: tunnels.${DOMAIN}, path: /c/{slug}/(.*))
Service       tunnel-{slug}   (ExternalName → private-worker-server.client-{slug}.svc.cluster.local)
```

Cluster-wide (in `platform-system`):

```
Ingress       tunnel-anchor   (host: tunnels.${DOMAIN}, owns tls: cert)
Certificate   tunnels-${DOMAIN}   (HTTP-01 by default; DNS-01 if wired)
```

### Agent image `images/private-worker-agent/`

```
Dockerfile          Alpine + frpc binary + entrypoint.sh
entrypoint.sh       decode PRIVATE_WORKER_TOKEN env, render frpc.toml, exec frpc -c /etc/frp/frpc.toml
README.md           Operator usage
```

Image runs as non-root (uid 1000), no persistent volume needed, exposes `:7400` for `frpc` admin/health on localhost only.

### Frontend

**Client panel** — `frontend/client-panel/src/pages/PrivateWorkers.tsx`:
- Table list (name, slug, status, last seen, exposed port)
- Create modal (name + exposed port + optional description)
- One-time token modal (token shown once + "Copy docker-compose snippet" + "Copy `docker run` command")
- Detail drawer (status, last-seen, last-used-ip, bytes in/out, audit log, rotate, revoke)
- Status badge color coding (active=green, pending=amber, revoked=red, suspended=grey)

**Admin panel** — extend client-detail tabs with "Private Workers" panel showing the same data read-only + admin override revoke.

---

## CI/CD

`.github/workflows/ci-private-worker-agent.yml` mirrors `ci-sftp-gateway.yml`:

- Triggers: push to main on `images/private-worker-agent/**`, PR, manual dispatch
- Job: build, Trivy scan (SARIF upload), push on main only
- Tags: `:<short-sha>`, `:latest` on default branch
- Flux ImagePolicy in `clusters/staging/private-worker-agent.yaml` watches `:<sha>` tag pattern; auto-promotes to staging
- Production tag pattern is `:v*` semver; manual promotion via tag push

The platform-api itself has no new CI flow — backend changes ride the existing `ci-backend.yml`. Same for admin/client panel changes.

---

## E2E test harness

`scripts/integration-private-worker.sh`:

```
Phase 1 — provision
  1. Login as admin
  2. Create client, wait for namespace ready
  3. POST /api/v1/clients/:cid/private-workers {name, exposed_port}
  4. Capture token from response (one-time)
  5. Verify reconciler created: ConfigMap, Secret, Deployment, Service in client ns
  6. Verify per-client Ingress + ExternalName in platform-system

Phase 2 — agent dial-in
  7. Spawn local docker container with PRIVATE_WORKER_TOKEN env (sample echo HTTP server bundled)
  8. Wait until private_workers.last_seen_at is updated (poll, 60s timeout)
  9. Assert frps logs show successful WebSocket Upgrade

Phase 3 — user-visible traffic
  10. Create ingressRoute targeting the private_worker_id with hostname `pw-{slug}.${TENANT_BASE}`
  11. Wait for cert issuance (poll until 200 OK on https://pw-{slug}.${TENANT_BASE})
  12. curl https://pw-{slug}.${TENANT_BASE}/healthz → assert response body matches the local echo server's marker
  13. openssl s_client -connect pw-{slug}.${TENANT_BASE}:443 → assert cert CN matches host

Phase 4 — revoke
  14. POST /api/v1/clients/:cid/private-workers/:wid/revoke
  15. Wait until home agent's connection drops (poll docker logs for disconnect)
  16. curl https://pw-{slug}.${TENANT_BASE}/healthz → assert 502 Bad Gateway

Phase 5 — teardown
  17. Delete private_worker
  18. Verify cluster-side resources removed
  19. Stop docker agent
  20. Delete client
```

User-visible assertions per memory `feedback_assert_user_visible_only.md`: every phase ends with curl/openssl on a real endpoint, not just controller-state polls.

`scripts/local-private-worker-sample.sh` runs phases 1, 2, 7-12 against the local Unraid+DinD k3s for dev iteration.

---

## Lifecycle quirks

- **Suspended clients**: frps Deployment scales to 0; the home agent's connection drops; the agent will keep retrying with backoff. UI surfaces "client suspended" rather than "tunnel offline" so the operator's instinct is correct.
- **Archived clients**: cluster resources fully torn down. Restoring archives re-creates from DB rows. Token hash survives, so the home agent reconnects without re-enrollment when restored.
- **Deleted clients**: `private_workers` rows hard-deleted via cascade from `clients`. Audit-log rows preserved per-row via FK cascade — deleting the worker deletes its audit, but the client-deletion audit captures the lifecycle event.
- **Ingress route delete with `private_worker_id`**: the worker survives. Deleting the worker auto-deletes any `ingress_routes` referencing it via FK cascade.

---

## Scalability

| Per-client cost (1 active worker) | Value |
|---|---|
| Pod | 1 frps Deployment, 1 replica |
| CPU request | 25m |
| Memory request | 64Mi |
| Service objects | 1 ClusterIP (client ns) + 1 ExternalName (platform-system) |
| Ingress objects | 1 in platform-system |
| Idle frps RAM | ~5Mi (well below 64Mi limit) |

| Per-cluster cost | Value |
|---|---|
| Anchor Ingress | 1 |
| Certificate | 1 (`tunnels.${DOMAIN}`) |
| DNS records | 1 A/AAAA for `tunnels.${DOMAIN}` |
| Controller flags | 0 |
| Wildcards | 0 |

At 100 clients with 1 worker each: ~100 pods, ~2.5 CPU, ~6.4 GiB RAM. At 1000 clients: ~1000 pods, ~25 CPU, ~64 GiB RAM. Quota-isolated — heavy users pay their own way.

Multiple workers per client share the same frps pod via multi-proxy frpc/frps config — adding worker N to an existing client adds zero pods, just one Service object and a config entry. Pod count scales with `clients with at least one active worker`, not `total workers`.

---

## Alternatives considered

| Option | Why rejected |
|---|---|
| Full k3s worker join from home | Wrong shape: home boxes are bad K8s nodes (latency, NAT, no public IP, abuse-IP risk). Solving the actual use case is much narrower. |
| Per-client subdomain `frp-{slug}.tunnels.${DOMAIN}` + per-tunnel cert | N HTTP-01 certs, LE rate-limit pressure, more cert-manager work. Single FQDN + path routing is strictly simpler. |
| SSL passthrough at NGINX-ingress | Incompatible with HTTP-01 issuance on the same hostname. Forces DNS-01 / wildcard, which the platform deliberately doesn't require. |
| Wildcard cert via DNS-01 | Requires platform DNS API access (PowerDNS et al.). Not all installs have it. HTTP-01 per-FQDN works everywhere. |
| Catalog entry kind `private-worker` | Pollutes external `hosting-platform-workload-catalog` repo with platform-internal tunnel infrastructure. Category leak. |
| Shared multi-tenant frps pod in `platform-system` | Crosses tenant trust boundary; doesn't count toward client quota; creates a system-namespace component the user explicitly rejected. |
| Two-token model (single-use enrollment + persistent auth) | Requires durable state on the home box. Breaks `docker compose down/up` and image updates. |

---

## Future work (post-v1)

- Graceful token rotation with dual-token grace window (24h overlap)
- Mutual TLS (replace bearer with X.509 client cert)
- Cluster cert pinning at agent (catches MITM with rogue LE cert)
- Agent image signed with cosign; entrypoint verifies before launching child workload
- Geo / IP allowlist on enrollment
- Multi-replica frps with sticky-session for sub-second failover
- "Tunnel pool" abstraction — multiple home boxes back the same Service for HA
- Per-tunnel bandwidth metering for billing

---

## References

- [ADR-022 — DNS, NetBird, IAM are external](../07-reference/ARCHITECTURE_DECISION_RECORDS.md)
- [ADR-025 / ADR-026 — Catalog scope](../07-reference/ARCHITECTURE_DECISION_RECORDS.md) (private worker is deliberately *not* a catalog entry)
- [ADR-033 — Client lifecycle hook registry](../07-reference/ADR-033-client-lifecycle-hook-registry.md)
- [Cluster firewall](./CLUSTER_NETWORK.md) — peer-IP allowlist; tunnel-server pod inherits client-namespace policy
- [Network access modes](./NETWORK_ACCESS.md) — orthogonal to private worker; composes via `target_type` polymorphism
