# CI/CD & Deployment Process

## Overview

The platform uses three distinct deployment pipelines:

1. **Platform Service Pipeline** — CI/CD for management API, controllers, platform services
2. **Catalog Image Pipeline** — Build and publish container catalog images  
3. **Client Site Deployment** — Three methods for clients to deploy code (no container build)

## Container Registry

### Harbor Registry

| Decision | Value |
| --- | --- |
| **Registry** | **Harbor** (self-hosted, Trivy scanning) |
| Image tagging scheme | `catalog/<id>:<version>-<YYYYMMDD>` (e.g., `catalog/apache-php84:1.2.0-20260227`) |
| **Vulnerability scan** | **Trivy** (on every build, integrated with Harbor) |
| Retention policy | Keep last 5 versions per catalog entry |
| Image signing | **Skip for MVP** (cosign/supply chain security deferred to Phase 2) |

## Platform Service Pipeline

CI/CD for the platform services themselves (management API, controllers, DNS controller, etc.).

| Stage | Tool / Action |
| --- | --- |
| Source control | GitHub or Gitea (self-hosted option) |
| **CI runner** | **Gitea Actions** (if self-hosted) or **GitHub Actions** |
| Build | Docker multi-stage builds |
| Test | Unit + integration tests |
| **Image scan** | **Trivy** (integrated with Harbor) |
| Image push | To Harbor registry |
| **Deploy** | **Flux v2** (GitOps) |
| Rollout strategy | Rolling update (platform services) |

### Deployment Process

1. **Code commit** pushed to GitHub/Gitea `main` branch
2. **CI workflow triggered** (GitHub Actions or Gitea Actions)
3. **Tests run** (unit, integration, lint)
4. **Docker image built** (multi-stage Dockerfile)
5. **Trivy scan** runs (vulnerability scanning)
6. **Image pushed** to Harbor registry with tag `<version>-<date>`
7. **Manifest updated** in Git repository (Flux watches this)
8. **Flux detects change** and automatically deploys new version
9. **Rolling update** starts (new pods created, old pods gradually terminated)
10. **Health checks** verify new pods are healthy
11. **Traffic slowly shifted** to new pods (if using canary deployments)
12. **Rollback available** by reverting Git commit (Flux auto-syncs)

## Catalog Image Pipeline

CI/CD for building and publishing workload catalog images (PHP, Node, Python, Ruby, etc.).

### Pipeline Stages

| Stage | Action |
| --- | --- |
| **Trigger** | Admin updates Dockerfile in platform Git repo (branch or main) |
| **Build** | CI builds image using pinned base images |
| **Test** | Run smoke test with sample app (verify image works) |
| **Scan** | Trivy scans for vulnerabilities |
| **Push** | Image pushed to Harbor with tag `catalog/<id>:<version>-<date>` |
| **Catalog update** | Admin enables new image in catalog via Management API |
| **Client notification** | Clients with old version see upgrade available warning in panel |
| **Migration** | Admin can force-migrate all clients on old image (rolling update) |

### Deprecation Workflow

When a catalog image reaches end-of-life:

1. **Admin marks deprecated** in Management API
2. **Clients see warning** in their control panel
3. **No automatic upgrade** (client chooses when to upgrade)
4. **Optional force-migrate** (admin can schedule rolling update)
5. **Removed after grace period** (e.g., 6 months after deprecation)

## Client Site Deployment — Three Methods

Clients deploy code by placing files in their PersistentVolume. The dedicated container serves whatever files are in the volume. **No container builds happen per-client.** See **ADR-016** for the full architectural decision and canonical file path layout.

All three methods work identically for all clients — every client has a dedicated pod in their `client-{id}` namespace (ADR-024). All methods access the same underlying filesystem:

```
/storage/customers/{customer_id}/
├── domains/
│   ├── example.com/public_html/        ← document root for www.example.com
│   ├── dev.example.com/public_html/    ← document root for dev subdomain
│   └── blog.example.com/public_html/   ← document root for blog
├── shared/                              ← files shared across all domains
├── tmp/                                 ← temporary files
└── backups/                             ← customer-created backup downloads
```

### Method 1: SFTP Upload

Traditional file upload via SFTP client (FileZilla, WinSCP, terminal, etc.):

1. Client connects via SFTP to the SFTP gateway
2. Gateway maps client credentials to their PersistentVolume (chroot to `/storage/customers/{id}/`)
3. **All domains and subdomains visible** — client navigates to `domains/{domain}/public_html/`
4. Files uploaded directly to the volume mount
5. Files are immediately live (volume is mounted in web pod)
6. No build step — traditional shared hosting experience

### Method 2: Git Pull (Git Deploy Service)

Pull-based file deployment from any external Git repository. **Per-domain configuration** — each domain can have its own repo, branch, and deploy path.

**Setup (one-time per domain):**
1. Client configures in panel: repository URL, branch (e.g., `main`), authentication (SSH key or access token)
2. Platform generates a webhook URL for the domain
3. Client adds webhook URL to GitHub/GitLab/Gitea/Bitbucket repository settings

**Deploy flow:**
1. Client pushes to configured branch in their Git repository
2. Git provider sends webhook to platform endpoint: `POST /api/v1/webhooks/git-deploy/{webhook_secret}`
3. Git Deploy Service authenticates webhook, extracts branch from payload
4. Service runs: `git clone --depth 1 --branch {branch} {repo_url}` into temp directory
5. Service runs: `rsync --archive --delete {temp}/. /storage/customers/{id}/domains/{domain}/public_html/`
6. Optional post-deploy hooks execute (e.g., `composer install`, `npm install`)
7. Deployment logged to `deployment_history` table; visible in client panel
8. Rollback available: click any previous deployment in history → "Re-deploy this commit"

**Manual trigger (no webhook needed):**
- Client clicks "Deploy Now" button in client panel
- Or calls API: `POST /api/v1/domains/{domain_id}/deploy`

**Branch-based staging-to-production:**
- `dev.example.com` → pulls from `develop` branch
- `example.com` → pulls from `main` branch
- Customer merges `develop` → `main` → production auto-deploys

### Method 3: Web File Manager (FileBrowser)

Browser-based file management through control panel:

1. Client logs into management panel and clicks "File Manager"
2. **FileBrowser** opens showing the client's full PV (all domains, subdomains, shared files)
3. Upload, edit (syntax-highlighted code editor), delete, rename, **copy, move** files
4. Changes are live immediately (same PV as SFTP)

**This is the primary staging-to-production tool.** Client selects files in `domains/dev.example.com/public_html/`, copies them to `domains/example.com/public_html/`, and they're immediately live.

### No Staging Automation (By Design)

The platform follows a **traditional hosting model** (like cPanel/Plesk). There is no automated staging-to-production pipeline. Promotion is manual:

- **FileBrowser/SFTP:** Copy files from dev webroot to production webroot
- **Git:** Merge dev branch to main branch; webhook auto-deploys

This is intentional — see ADR-016 for rationale.

## Client Onboarding Automation

When a new client is provisioned via the management panel, the Management API orchestrates full namespace setup.

### All Plans (Common Steps)

1. Create `client-{name}` namespace
2. Apply NetworkPolicy (default-deny + allow ingress + allow shared services)
3. Create PersistentVolumeClaim for site files
4. Create database and user on shared MariaDB/PostgreSQL instance
5. Create Redis ACL user on shared Redis (with key prefix restriction)
6. Create Ingress rule for client domain(s)
7. Create cert-manager Certificate resource — strategy depends on DNS mode:
   - **Primary or Secondary DNS mode** → create **wildcard** `Certificate` via `letsencrypt-wildcard` ClusterIssuer (DNS-01); covers `*.domain` + apex `domain`; secret: `{client-id}-{domain-slug}-wildcard-tls`
   - **CNAME mode** → create **single-domain** `Certificate` via `letsencrypt-prod` ClusterIssuer (HTTP-01) per hostname; secret: `{client-id}-{hostname-slug}-tls`
   - Subdomains default to inheriting the parent wildcard (Primary/Secondary) or getting their own single-domain cert (CNAME); customer can override per-subdomain in Client Panel
   - See `03-security/TLS_CERTIFICATE_MANAGEMENT.md` for full cert selection logic and YAML templates
8. Create DNS records via DNS controller
9. Generate SFTP credentials, store in namespace Secret
10. Store DB credentials in namespace Secret
11. Link OIDC account (client can log into panel)
12. Provision email account(s) on Docker-Mailserver (if `max_email_accounts > 0`)
13. Auto-generate application password for each email account, store in namespace Secret (admin-readable)
14. Create webmail Ingress (e.g., `webmail.client.com`) if `webmail_domain` set
15. Send welcome email with credentials and panel URL

### All Plans (Additional Steps — ADR-024: dedicated pod per client)

13. Apply ResourceQuota and LimitRange based on hosting plan
14. Create ServiceAccount with namespace-scoped RBAC
15. Deploy dedicated web pod using **client-selected catalog image**
16. _(Premium only)_ Provision dedicated Redis pod in client namespace
17. _(Premium/Custom only)_ Optional: provision dedicated MariaDB StatefulSet in client namespace (database is a premium add-on)

## GitOps for Platform

The platform deployment process uses **GitOps principles** for all infrastructure and platform service deployments.

| Decision | Value |
| --- | --- |
| GitOps controller | **Flux v2** (lightweight, GitOps-native, more flexible than ArgoCD) |
| Repository structure | Monorepo with per-service Helm charts + per-client overlays |
| Deployment method | Helm charts for platform services; Kustomize overlays for client namespaces |
| Rollback mechanism | Flux auto-sync rollback or manual Git revert |

### Flux Workflow

1. **Admin pushes manifests** to Git repository
2. **Flux controller watches repository** (configurable sync interval, typically 5 minutes)
3. **Flux detects changes** in Git
4. **Flux applies manifests** to cluster (via `helm install` or `kustomize build`)
5. **Cluster state matches Git state** (source of truth)
6. **Rollback via Git revert** (revert commit, Flux automatically syncs)

## Security in CI/CD

### Secrets Management in Pipelines

- **GitHub/Gitea Secrets:** Store sensitive values (API keys, registry credentials)
- **No hardcoded secrets** in Dockerfile or manifests
- **Sealed Secrets for K8s:** Secrets committed to Git encrypted
- **Temporary credentials:** Use time-limited tokens for CI/CD runners

### Image Signing (Phase 2)

- **cosign for image signing** (defer to Phase 2)
- **Verify image signatures** before deployment
- **Supply chain security** for production deployments

### Code Review Process

- **Pull requests required** before merge to main
- **CI must pass** (tests, linting, scanning)
- **At least one review required** before merge
- **Branch protection rules** enforce these requirements

## Rollback Procedures

### Platform Service Rollback

**If deployment breaks production:**

1. **Quick rollback:** Revert commit in Git → Flux automatically syncs old version
2. **Manual rollback:** `flux suspend kustomization <name>` → Manual deploy of previous version
3. **Disaster recovery:** If Flux is broken, manually apply manifests with `kubectl apply -f`

### Catalog Image Rollback

1. **Admin marks current image as deprecated** in Management API
2. **Select replacement image** (older version)
3. **Initiate rolling update** of all affected clients
4. **New pods spin up** with old image, old pods terminate

### Client Deployment Rollback

**SFTP / FileBrowser uploads:**
- Client manually re-uploads previous version of files
- Or restores from backup (admin panel or client panel restore feature)

**Git Pull deployment:**
- Client clicks "Re-deploy" on a previous deployment in the deployment history
- Or reverts commit in Git repo → triggers webhook → re-syncs older version
- Deployment history preserves commit SHA for every deploy

## Deployment Monitoring

### What's Monitored

| Metric | Alert Threshold |
| --- | --- |
| **Deployment failure** | Alert immediately if deployment pod fails |
| **Pod health** | Alert if pod doesn't become healthy in 5 minutes |
| **Image scan failure** | Alert if Trivy finds critical vulnerability |
| **Registry sync** | Alert if Harbor is out of sync with Trivy |
| **Client deployment timeout** | Alert if client deployment takes > 2 minutes |

### Logs & Debugging

- **Platform deployment logs:** `kubectl logs -f deployment/flux-system-controller` (Flux logs)
- **Image build logs:** Available in CI runner (GitHub Actions/Gitea Actions)
- **Client deployment logs:** Available via Management API / client panel
- **Registry logs:** Available in Harbor UI

## Related Documentation

- **SECURITY_ARCHITECTURE.md**: Secrets management and image signing in CI/CD
- **INFRASTRUCTURE_SIZING.md**: Resource requirements for CI/CD runners
- **MONITORING_OBSERVABILITY.md**: Deployment and image scan monitoring
- **CLIENT_PANEL_FEATURES.md**: Client deployment UI in management panel
