# Workload Deployment

## Overview

The Workload Catalog provides **composable building blocks** — runtimes, databases, and services — that clients assemble into their own development environments (ADR-026). Each workload is a pre-built, hardened, tested container image maintained by the platform admin.

**Workloads are generic runtimes, not pre-installed applications.** Clients upload their own application files via SFTP/Git Deploy and manage their software manually. For managed, pre-configured application stacks (WordPress, Nextcloud, Jitsi, etc.) see the **Application Catalog** (PLATFORM_ARCHITECTURE.md Section 3).

This centralized approach eliminates per-client CI/CD pipelines, simplifies security patching, and provides consistent, isolated environments for every client.

## Deployment Model: Dedicated Pod Per Client (ADR-024)

Every client — regardless of plan tier — gets their own dedicated pod in a `client-{id}` namespace. There is no shared pod model; plan differentiation is achieved through ResourceQuota limits and feature gating.

**How it works:**
- One pod per client running a selected catalog image
- Each client gets their own Kubernetes namespace (`client-{id}`)
- Client's PVC mounted at `/storage/customers/{id}/` (canonical path — see ADR-016)
- Full Kubernetes-native isolation: ResourceQuota, NetworkPolicy, RBAC
- Plan upgrades are ResourceQuota edits — no pod migration required

**Characteristics:**
- Guaranteed CPU/memory limits per plan (enforced via ResourceQuota)
- Dedicated database available as premium add-on (MariaDB StatefulSet in client namespace)
- Scale-to-zero capability via KEDA for idle sites
- Custom PHP/runtime configuration per client
- Full pod-level and namespace-level isolation

## Container Catalog Structure

The catalog is a curated set of pre-built, tested runtime images. Each entry defines a specific runtime, web server, and version combination.

### Available Containers

| Catalog ID | Base Image | Web Server | Runtime | Plan | Status |
| --- | --- | --- | --- | --- | --- |
| `apache-php84` | php:8.4-apache-alpine | Apache 2.4 | PHP 8.4 | All | Active |
| `apache-php83` | php:8.3-apache-alpine | Apache 2.4 | PHP 8.3 | All | Active |
| `apache-php82` | php:8.2-apache-alpine | Apache 2.4 | PHP 8.2 | All | Deprecated |
| `nginx-php84` | custom (nginx + php-fpm) | Nginx | PHP 8.4 | All | Active |
| `nginx-php83` | custom (nginx + php-fpm) | Nginx | PHP 8.3 | All | Active |
| `wordpress-php84` | wordpress:php8.4-apache | Apache 2.4 | PHP 8.4 + WP optimized | All | Active |
| `wordpress-php83` | wordpress:php8.3-apache | Apache 2.4 | PHP 8.3 + WP optimized | All | Active |
| `node22` | node:22-alpine | PM2 | Node.js 22 | Business / Premium only | Active |
| `node20` | node:20-alpine | PM2 | Node.js 20 | Business / Premium only | Active |
| `python312` | python:3.12-slim | Gunicorn | Python 3.12 | All | Active |
| `python311` | python:3.11-slim | Gunicorn | Python 3.11 | All | Active |
| `ruby34` | ruby:3.4-alpine | Puma | Ruby 3.4 | All | Active |
| `dotnet9` | mcr.microsoft.com/dotnet/aspnet:9.0 | Kestrel | .NET 9 | All | Active |
| `java21` | eclipse-temurin:21-jre-alpine | Tomcat/embedded | Java 21 | All | Active |
| `static-nginx` | nginx:alpine | Nginx | Static only | All | Active |
| `static-caddy` | caddy:alpine | Caddy | Static only | All | Active |

**Node.js runtime contract:** `node22` and `node20` use PM2 as the process manager. The app must listen on `process.env.PORT` (injected as `3000`) and expose `GET /healthz` returning HTTP 200. See **NODE_RUNTIME_SPECIFICATION.md** for the full runtime contract, Kubernetes manifests, startup options, and deployment guide.

### Image Contents

Each catalog image includes:

- **Runtime** at pinned version (PHP, Node, Python, etc.)
- **Web server** (Apache, Nginx, Gunicorn, etc.)
- **Common extensions/modules pre-installed**
  - PHP: mysqli, gd, curl, mbstring, opcache, etc.
  - Other runtimes: popular packages for their ecosystem
- **Security hardening**
  - Non-root user
  - Minimal packages (no dev tools)
  - Regular vulnerability scanning
- **Health check endpoint** (`/healthz` or TCP probe)
- **Log output** to stdout/stderr (for Loki collection)
- **Volume mount point** at `/storage/customers/{id}/` for client files (canonical path — see ADR-016)

## Dedicated Pod Provisioning Details

### Per-Client Resources

| Parameter | Value |
| --- | --- |
| Isolation model | One pod per client in `client-{id}` namespace |
| Storage | Per-client PVC mounted at `/storage/customers/{id}/` (canonical path — ADR-016) |
| Resource limits | Enforced via ResourceQuota per namespace (varies by plan) |
| Scale-to-zero | KEDA-based for idle sites (configurable per plan) |
| Database | Optional premium add-on: dedicated MariaDB StatefulSet in client namespace |

### Storage Strategy

**Phase 1 (local-path provisioner, single-node):** One PVC per client in their namespace.

```yaml
# In client-{id} namespace
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: client-storage
  namespace: client-acme
spec:
  accessModes: [ReadWriteOnce]
  resources:
    requests:
      storage: 5Gi  # Varies by plan: Starter 5Gi, Business 20Gi, Premium 50Gi
```

**Phase 2 (Longhorn, multi-node):** Per-client PVCs with Longhorn replication and per-client snapshots.

**Disk quota enforcement:**
- ResourceQuota limits PVC size per namespace
- Monitoring CronJob alerts at 90% usage

### Provisioning Workflow

When a new client is created (any plan):

1. Management API creates `client-{id}` namespace with ResourceQuota matching the plan
2. PVC provisioned in client namespace
3. Pod created with selected catalog image, PVC mounted at `/storage/customers/{id}/`
4. Ingress rule created pointing client's domain to the client pod Service
5. NetworkPolicy applied to isolate client namespace
6. Optional: MariaDB StatefulSet provisioned if database add-on is enabled

### Plan Upgrades

Plan upgrades are ResourceQuota edits — no pod migration required:

1. Admin updates client plan via Management API
2. ResourceQuota in `client-{id}` namespace updated (CPU, memory, storage limits)
3. Pod resource limits adjusted if needed (triggers rolling restart)
4. No data migration, no namespace change, no downtime

## Workload Catalog Repositories (ADR-025)

Workload definitions (Dockerfiles, manifests, metadata) are maintained in **external GitHub repositories**, not in this monorepo. The platform syncs them into the `container_images` table via the workload repository integration.

### Catalog Repository Structure

Each catalog repo contains a `catalog.json` index and per-workload `manifest.json` files:

```
<repo-root>/
├── catalog.json              # Index: array of entries or { workloads: ["apache-php84", ...] }
├── apache-php84/
│   └── manifest.json         # { name, code, type, image, supported_versions, resources, ... }
├── nginx-php84/
│   └── manifest.json
└── ...
```

### Sync Flow

1. Admin registers a catalog repo via `POST /api/v1/admin/workload-repos` (GitHub URL, branch, optional auth token)
2. Platform fetches `catalog.json` → then each workload's `manifest.json` from raw GitHub URLs
3. Container images upserted into `container_images` with `source_repo_id` FK to `workload_repositories`
4. Unique constraint `(code, source_repo_id)` prevents collisions across repos
5. Manual sync: `POST /api/v1/admin/workload-repos/:id/sync`; automatic sync on configured interval (default: 60 min)

**Default catalog:** `https://github.com/phoenixtechnam/hosting-platform-workload-catalog`

### Image Build Pipeline

Image building happens in the **catalog repo's own CI** (not in this platform's CI):

1. Catalog maintainer updates Dockerfile in the catalog repo
2. Catalog repo CI builds, tests (smoke test), and scans (Trivy)
3. Image pushed to registry; `manifest.json` updated with registry URL/tag
4. Platform syncs updated manifest on next interval or manual trigger

### Security & Patching

- Every image is scanned, hardened, and patched by the catalog repo maintainer
- All clients on the same runtime get identical environments
- Upgrade PHP 8.3 → 8.4 for all clients in one operation (update manifest, sync, force-migrate)
- Shared base layers across clients (Docker layer caching on nodes)
- Minimal attack surface due to curated, well-tested images

### Admin Container Lifecycle Management

The admin panel provides full lifecycle control over catalog repos and images:

**Repository management:**

| Action | Description |
| --- | --- |
| **Add repo** | Register an external workload catalog repository |
| **Remove repo** | Unregister a catalog repo and remove its synced images |
| **Sync repo** | Trigger manual sync to fetch latest catalog |
| **View sync status** | Monitor sync state (`active` / `syncing` / `error`) and last error |
| **Restore default** | Re-register the official platform catalog repo |

**Container image management:**

| Action | Description |
| --- | --- |
| **Enable / Disable** | Control which containers are available for new client selection |
| **Deprecate** | Mark a container as end-of-life; show warning to clients using it |
| **Force migrate** | Rolling-update all clients on a deprecated container to a specified replacement |
| **View usage** | See which clients are on which container version |
| **Remove** | Delete a container from catalog (only after 0 clients remain on it) |
| **Rollback** | Revert a container update if issues are discovered |

## Custom Extensions & Modules

For cases where a client needs a PHP extension or system package not in the default image:

| Approach | Complexity | Recommendation |
| --- | --- | --- |
| Include all common extensions in base image | Low | **Default approach** — cover 95% of cases |
| Offer "extended" image variants (e.g., `apache-php84-imagick`) | Medium | For popular extras |
| Init container that installs extras at startup | Medium | Flexible but slower startup |
| Client requests admin to add extension to catalog | Low | Manual but controlled |
| Allow custom Dockerfiles | High | **Not supported** — breaks the model |

**Recommendation:** Ship fat images with all commonly needed extensions pre-installed. The marginal storage cost is low and it eliminates most custom extension requests. For rare cases, create "-extended" image variants.

## Client Container Selection

In the management panel, clients can:

- **View available containers** with version information
- **Switch containers** at any time (triggers pod replacement with new image, preserving PersistentVolume with files)
- **See deprecation warnings** for containers marked end-of-life
- **Request custom extensions** via support ticket

Starter plan clients are limited to Apache+PHP containers. Business/Premium clients can select from any catalog entry (including NGINX, Node.js, Python, etc.).

## Zero-Downtime Switching

Clients can switch between catalog images at any time without downtime:

**Process:**
1. Pre-flight compatibility check (scan .htaccess, PHP code, extensions)
2. Create new pod with target image
3. Wait for health checks to pass
4. Ingress routing updated (traffic switches to new pod)
5. Old pod gracefully shut down
6. Automatic rollback if health checks fail

**Switching Restrictions by Plan:**

| Plan | Can Switch PHP Version | Can Switch Web Server | Restrictions |
|------|------------------------|----------------------|--------------|
| **Starter** | ✅ Yes (Apache only) | ❌ No | Limited to Apache 2.4 + PHP 8.3/8.4 |
| **Business** | ✅ Yes | ✅ Yes | Full flexibility (any catalog image) |
| **Premium** | ✅ Yes | ✅ Yes | Full flexibility (any catalog image) |

**Configuration Migration:**
- Apache → NGINX: Automatic .htaccess to NGINX config conversion
- NGINX → Apache: Generate .htaccess equivalent from location blocks
- PHP version upgrade/downgrade: No config changes needed

**Estimated Switch Time:** 1-3 minutes total (1 minute average)

**Automatic Rollback Triggers:**
- Health checks fail (>2 minutes without readiness)
- Pod crashes after ingress switch
- Error rate exceeds threshold (>5% for 1 minute)
- Total timeout exceeded (>5 minutes)

## Benefits of Curated Catalog

| Benefit | Description |
| --- | --- |
| **Security** | Every image is scanned, hardened, and patched centrally |
| **Consistency** | All clients on the same runtime get identical environments |
| **Efficient updates** | Upgrade PHP 8.3 → 8.4 for all clients in one operation |
| **Full isolation** | Every client gets dedicated pod with namespace-level isolation |
| **Lower resource usage** | Shared base layers across clients (Docker layer caching on nodes) |
| **Simplified support** | Known environments reduce debugging complexity |
| **No build infrastructure** | Eliminates per-client CI/CD pipelines |
| **Simplified scaling** | Add nodes instead of managing per-client infrastructure |

## Integration with Hosting Plans

Each hosting plan configuration specifies which containers are available:

| Plan | Web Mode | Container Options |
| --- | --- | --- |
| **Starter** | Dedicated pod | Apache+PHP (default); clients select PHP version |
| **Business** | Dedicated | Any single catalog entry |
| **Premium** | Dedicated | Any single catalog entry |

Clients can switch containers via the admin panel configuration per HOSTING_PLANS.md: `catalog_image` parameter.

## Related Documentation

- **HOSTING_PLANS.md**: Plan definitions and customization
- **PLATFORM_ARCHITECTURE.md**: Overall platform design and goals
- **STORAGE_DATABASES.md**: Database allocation per plan
- **MONITORING_OBSERVABILITY.md**: Monitoring container health and performance
- **EMAIL_SERVICES.md**: Email services and container integration
- **NODE_RUNTIME_SPECIFICATION.md**: Full Node.js runtime contract (PM2, ports, health checks, manifests, deployment guide)
