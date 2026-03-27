# Phase 1 Roadmap: Single Region MVP (Weeks 1-12)

> **Goal:** Deploy a working hosting platform on Hetzner Frankfurt with first test client migrated by Week 12.
>
> **Scope:** Single region, no geographic sharding yet, no app catalog, no advanced restore features.
>
> **Resources:** Assumes 2-3 people (1 DevOps, 1 Backend, 1 Frontend) or adjust timelines accordingly.
>
> **Success Criteria:**
> - 1 real Plesk customer successfully migrated
> - All core APIs working (create client, manage domains, upload files)
> - Basic monitoring in place (uptime, errors)
> - Zero data loss during migration

---

## Phase 1 Timeline Overview

**Total:** 12 weeks (3 months)
**Team allocation:** Full-time for all 3 people
**Infrastructure cost:** ~€50/month (single Hetzner server)

---

## GitHub Repository Structure

All code lives in a **monorepo**:

```
hosting-platform/
├── .github/
│   ├── workflows/
│   ├── ISSUE_TEMPLATE/
│   │   ├── feature.md
│   │   └── bug.md
│   └── pull_request_template.md
├── backend/                  # Node.js / Fastify management API
├── frontend/
│   ├── admin-panel/          # React 18 + Vite + shadcn/ui
│   └── client-panel/         # React 18 + Vite + shadcn/ui
├── migration-service/        # Plesk extractor + migration tooling
├── k8s/
│   ├── base/                 # Kustomize base manifests
│   └── overlays/
│       ├── staging/
│       └── production/
├── helm/                     # Helm charts for platform services
├── terraform/                # Hetzner VPS provisioning
├── # catalog-images/ removed — workload Dockerfiles live in external catalog repos (ADR-025)
└── scripts/                  # Utility shell scripts
```

See `GITHUB_INTEGRATION_SUMMARY.md` for full GitHub setup instructions including branch protection rules, secrets, and project board.

---

## Prerequisites: External Services (Infrastructure Project)

> **Per ADR-022, DNS, VPN mesh, and IAM are provided by the infrastructure project and must be running before Phase 1 begins.**

The following services are deployed and managed by the separate infrastructure project. Verify they are operational before starting Week 1:

- **PowerDNS** (ns1 primary + ns2 secondary) — authoritative DNS for hosted domains
- **NetBird** WireGuard mesh — admin VPN access to cluster and management plane
- **Dex** OIDC provider — identity and authentication for platform services

---

## Week 1-2: Infrastructure Setup (DevOps Lead)

### Goals
- Provision Hetzner server (4vCPU, 8GB RAM, ~€50/mo)
- Install k3s Kubernetes cluster
- Set up persistent storage (local-path provisioner; Longhorn in Phase 2)
- Configure networking (Ingress, cert-manager)
- Set up external SFTP backup

### GitHub Setup

**Create repository:**

```bash
gh repo create hosting-platform/hosting-platform --private --clone
cd hosting-platform
git checkout -b staging
git push -u origin staging
```

**Create branches & protection rules:**

```bash
# main: requires 2 approvals, all CI checks must pass
gh api repos/hosting-platform/hosting-platform/branches/main/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["backend-ci","frontend-admin-ci","frontend-client-ci"]}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{"required_approving_review_count":2}' \
  --field restrictions=null

# staging: requires 1 approval
gh api repos/hosting-platform/hosting-platform/branches/staging/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["backend-ci"]}' \
  --field required_pull_request_reviews='{"required_approving_review_count":1}' \
  --field restrictions=null
```

**GitHub Teams:**

| Team | Members | Permission |
|------|---------|------------|
| `platform-admins` | Team leads (1-2) | Admin |
| `platform-devs` | All developers | Write |
| `ci-bots` | Machine accounts | Write (for manifest commit-back) |

### Deliverables

**GitHub Issues to Create:**

| # | Title | Label | Owner |
|---|-------|-------|-------|
| 1 | Provision Hetzner VPS (4vCPU/8GB/Debian 13) | `infrastructure` `phase:1` | DevOps |
| 2 | Install k3s single-node cluster (with `--flannel-backend=none`) | `infrastructure` `phase:1` | DevOps |
| 3 | Install Calico CNI (NetworkPolicy enforcement from day one) | `infrastructure` `phase:1` | DevOps |
| 4 | Install NGINX Ingress Controller (DaemonSet, hostPort 80/443) | `infrastructure` `phase:1` | DevOps |
| 5 | Install cert-manager + Let's Encrypt ClusterIssuer | `infrastructure` `phase:1` | DevOps |
| 6 | Install Sealed Secrets controller | `infrastructure` `phase:1` | DevOps |
| 7 | Verify NetBird VPN mesh connectivity to cluster (provided by infrastructure project) | `infrastructure` `phase:1` | DevOps |
| 8 | Verify PowerDNS reachable and API integration working (provided by infrastructure project) | `infrastructure` `phase:1` | DevOps |
| 9 | Configure offsite backup (Restic → Hetzner StorageBox via NetBird mesh) | `infrastructure` `phase:1` | DevOps |
| 10 | Install Prometheus + Alertmanager + Loki (Grafana optional — access via port-forward) | `infrastructure` `phase:1` | DevOps |
| 11 | Install Flux v2 (GitOps controller) | `infrastructure` `phase:1` | DevOps |
| 12 | Take Hetzner server snapshot (pre-workload baseline) | `infrastructure` `phase:1` | DevOps |

> **Phase 1 resource optimization (single-node 4vCPU/8Gi):**
> - **No Longhorn** — Use k3s built-in `local-path` provisioner. Longhorn replication factor 1 adds overhead with zero benefit on one node. Deferred to Phase 2 (multi-node).
> - **No Harbor** — Use GitHub Container Registry or `ctr image import` for pre-built images. Harbor (~1Gi RAM) is too heavy for single-node. Deferred to Phase 2.
> - **Dedicated pods per client** (ADR-024) — Each client gets their own pod in a `client-{id}` namespace. Scale-to-zero via KEDA for idle sites.
> - See `INFRASTRUCTURE_SIZING.md` for the full resource budget.

**GitHub Pull Request Template for Infrastructure:**

```markdown
## Summary
<!-- What infrastructure change does this PR make? -->

## Type
- [ ] New service installation
- [ ] Configuration change
- [ ] Security hardening
- [ ] Upgrade

## Tested on
- [ ] Local (minikube / kind)
- [ ] Staging cluster
- [ ] Production cluster (if already exists)

## Rollback plan
<!-- How do we undo this if something breaks? -->

## Checklist
- [ ] `terraform plan` reviewed (if Terraform change)
- [ ] Secrets managed via Sealed Secrets (not plaintext in manifests)
- [ ] Tested in staging before applying to production
- [ ] Monitoring alerts updated (if new service)
```

### Terraform Code Location

Infrastructure-as-code lives at `terraform/`. Structure:

```
terraform/
├── main.tf                  # Hetzner provider + VPS resource
├── variables.tf             # Input variables (node count, size, region)
├── outputs.tf               # Node IPs, SSH fingerprints
├── environments/
│   ├── staging.tfvars       # Staging: 1 node, 4vCPU/8GB
│   └── production.tfvars    # Production: 1+ nodes, 8vCPU/16GB
└── modules/
    └── hetzner-vps/         # VPS provisioning module
```

Usage:
```bash
terraform init
terraform plan -var-file=environments/staging.tfvars
terraform apply -var-file=environments/staging.tfvars
```

---

## Week 3-4: Management API MVP (Backend Lead)

### Goals
- Build REST API for core operations
- Set up MariaDB database (via Percona MariaDB Operator)
- Implement authentication (JWT + Dex OIDC, Dex provided by infrastructure project)
- Create client CRUD operations
- Create domain CRUD operations

### GitHub Issues

| # | Title | Label | Owner |
|---|-------|-------|-------|
| 13 | Set up Fastify project structure + ESLint + TypeScript | `backend` `phase:1` | Backend |
| 14 | Implement JWT authentication middleware | `backend` `phase:1` | Backend |
| 15 | Write database migration framework (Knex or Drizzle) | `backend` `phase:1` | Backend |
| 16 | Run DATABASE_SCHEMA.md DDL as initial migration | `backend` `phase:1` | Backend |
| 17 | POST/GET/PUT/DELETE /api/v1/admin/clients | `backend` `phase:1` | Backend |
| 18 | POST/GET/PUT/DELETE /api/v1/admin/clients/{id}/domains | `backend` `phase:1` | Backend |
| 19 | POST /api/v1/admin/clients/{id}/namespaces (auto-provision) | `backend` `phase:1` | Backend |
| 20 | GET /api/v1/admin/clients/{id}/status (namespace health) | `backend` `phase:1` | Backend |
| 21 | Implement pagination (cursor-based, per API_PAGINATION_STRATEGY.md) | `backend` `phase:1` | Backend |
| 22 | Implement standard error responses (per API_ERROR_HANDLING.md) | `backend` `phase:1` | Backend |
| 23 | Write unit tests for client + domain services (60% coverage target) | `backend` `testing` `phase:1` | Backend |
| 24 | Write integration tests for client + domain API endpoints | `backend` `testing` `phase:1` | Backend |
| 25 | OpenAPI spec generation from Fastify routes | `backend` `phase:1` | Backend |

### GitHub CI/CD

**File:** `.github/workflows/ci-backend.yml`

Full YAML is in `CICD_PIPELINE_REQUIREMENTS.md §P1.1`. Summary:
- Triggered on push/PR to `main` or `staging` affecting `backend/**`
- Jobs: lint → typecheck → migrations → unit tests → integration tests → Docker build → Trivy scan → push to GHCR (Harbor in Phase 2)

**File:** `backend/package.json`

```json
{
  "name": "platform-backend",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.build.json",
    "start": "node dist/server.js",
    "test": "vitest",
    "test:unit": "vitest run tests/unit",
    "test:integration": "vitest run tests/integration",
    "lint": "eslint src --ext .ts",
    "typecheck": "tsc --noEmit",
    "db:migrate": "knex migrate:latest",
    "db:migrate:rollback": "knex migrate:rollback",
    "db:migrate:rollback:all": "knex migrate:rollback --all",
    "db:seed": "knex seed:run",
    "bench": "tsx tests/benchmarks/run.ts"
  }
}
```

### Database Schema Location

Database schema DDL lives at `backend/migrations/`. Each migration is a numbered file, e.g.:

```
backend/migrations/
├── 001_create_clients.ts
├── 002_create_users.ts
├── 003_create_domains.ts
├── 004_create_workloads.ts
├── 005_create_databases.ts
├── 006_create_backups.ts
├── 007_create_audit_logs.ts
└── 008_create_restore_jobs.ts
```

The canonical schema is documented in `/config/Server Infrastructure/DATABASE_SCHEMA.md`. Migrations must be kept in sync with that document.

---

## Week 5-6: Admin Panel MVP (Frontend Lead)

### Goals
- Build React/Vite admin panel
- Implement client management UI
- Implement domain management UI
- Integrate with API endpoints
- Add basic authentication flow

### GitHub Issues

| # | Title | Label | Owner |
|---|-------|-------|-------|
| 26 | Set up Vite + React 18 + TypeScript + shadcn/ui + Tailwind | `frontend` `phase:1` | Frontend |
| 27 | Implement auth flow (Dex OIDC → JWT → protected routes) | `frontend` `phase:1` | Frontend |
| 28 | Client list page with search + filters (AS.1 spec) | `frontend` `phase:1` | Frontend |
| 29 | Client detail page + edit form | `frontend` `phase:1` | Frontend |
| 30 | Create client wizard (CP.1 spec) | `frontend` `phase:1` | Frontend |
| 31 | Domain list + add domain form | `frontend` `phase:1` | Frontend |
| 32 | Plan management page (CP.2 spec) | `frontend` `phase:1` | Frontend |
| 33 | Dashboard overview (client count, alerts, storage usage) | `frontend` `phase:1` | Frontend |
| 34 | Set up TanStack Query for API data fetching + caching | `frontend` `phase:1` | Frontend |
| 35 | Set up Zustand for auth state | `frontend` `phase:1` | Frontend |
| 36 | Write Vitest tests for client list + form components | `frontend` `testing` `phase:1` | Frontend |

### GitHub CI/CD

**File:** `.github/workflows/ci-frontend.yml`

Full YAML is in `CICD_PIPELINE_REQUIREMENTS.md §P1.2`. Summary:
- Two parallel jobs: `frontend-admin-ci` and `frontend-client-ci`
- Both required as status checks on `main` and `staging` branch protection
- Jobs: lint → typecheck → Vitest tests → Vite build

---

## Week 7-8: Client Panel MVP (Frontend + Backend)

### Goals
- Build client-facing panel
- File manager (upload, download, delete files via FileBrowser)
- Domain list view
- Email account management
- Database management (basic)

### GitHub Issues

| # | Title | Label | Owner |
|---|-------|-------|-------|
| 37 | Client panel: auth flow + dashboard | `frontend` `phase:1` | Frontend |
| 38 | Client panel: domain list + DNS record viewer | `frontend` `phase:1` | Frontend |
| 39 | Client panel: file manager (FileBrowser embed or custom) | `frontend` `phase:1` | Frontend |
| 40 | Client panel: database list + credentials view | `frontend` `phase:1` | Frontend |
| 41 | Client panel: email account list + create/delete mailbox | `frontend` `phase:1` | Frontend |
| 42 | API: GET /api/v1/client/domains (client-scoped domain list) | `backend` `phase:1` | Backend |
| 43 | API: GET /api/v1/client/databases (client-scoped DB list) | `backend` `phase:1` | Backend |
| 44 | API: GET/POST/DELETE /api/v1/client/email/mailboxes | `backend` `phase:1` | Backend |
| 45 | API: GET/POST/DELETE /api/v1/client/files (FileBrowser API integration) | `backend` `phase:1` | Backend |
| 46 | FileBrowser deployment: per-client pod with Longhorn PV mount | `infrastructure` `phase:1` | DevOps |

---

## Week 9-10: Migration Service (Backend + DevOps)

### Goals
- Build Plesk extractor (most common hosting panel)
- Implement file sync (SSH/SFTP)
- Implement database import (MariaDB/PostgreSQL)
- Build migration validator
- Create migration runbook

### GitHub Issues

| # | Title | Label | Owner |
|---|-------|-------|-------|
| 47 | Migration service: Node.js project setup + Plesk API client | `migration` `phase:1` | Backend |
| 48 | Plesk extractor: export domains + DNS records | `migration` `phase:1` | Backend |
| 49 | Plesk extractor: export mailboxes + email content | `migration` `phase:1` | Backend |
| 50 | Plesk extractor: mysqldump all databases | `migration` `phase:1` | Backend |
| 51 | Plesk extractor: rsync all web files via SSH | `migration` `phase:1` | Backend |
| 52 | Migration importer: create client + provision namespace | `migration` `phase:1` | Backend |
| 53 | Migration importer: import databases into MariaDB | `migration` `phase:1` | Backend |
| 54 | Migration importer: import mailboxes into Docker-Mailserver | `migration` `phase:1` | Backend |
| 55 | Migration importer: import web files into Longhorn PV | `migration` `phase:1` | Backend |
| 56 | Migration validator: verify file checksums, DB row counts, DNS records | `migration` `phase:1` | Backend |
| 57 | Write migration runbook (`BACKUP_EXPORT_MIGRATION_GUIDE.md`) | `docs` `phase:1` | Backend |

### Migration Service API

**File:** `migration-service/src/server.ts`

Key endpoints:

```
POST /api/migration/start          — Begin migration job (source: Plesk host/creds, target: client_id)
GET  /api/migration/{job_id}       — Poll job status + step progress
GET  /api/migration/{job_id}/validate — Run post-migration validation checks
POST /api/migration/{job_id}/rollback — Roll back migration (delete provisioned resources)
WS   /ws/migration/{job_id}        — Real-time step progress (same WebSocket pattern as restore)
```

### GitHub CI/CD for Migration Service

**File:** `.github/workflows/ci-migration.yml`

```yaml
name: Migration Service CI

on:
  push:
    branches: [main, staging]
    paths:
      - 'migration-service/**'
  pull_request:
    branches: [main, staging]
    paths:
      - 'migration-service/**'

jobs:
  migration-ci:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    defaults:
      run:
        working-directory: migration-service

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
          cache-dependency-path: migration-service/package-lock.json

      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test
```

---

## Week 11-12: Testing & First Migration

### Goals
- Write comprehensive tests for all APIs
- Load testing (simulated traffic)
- Test first real migration (Plesk customer)
- Fix issues, optimize performance
- Document lessons learned

### GitHub Issues

| # | Title | Label | Owner |
|---|-------|-------|-------|
| 58 | Write end-to-end API tests (full client lifecycle) | `backend` `testing` `phase:1` | Backend |
| 59 | Load test: 50 concurrent clients, all core endpoints < 200ms p50 | `backend` `testing` `phase:1` | Backend |
| 60 | End-to-end frontend test: admin panel (Playwright or Cypress) | `frontend` `testing` `phase:1` | Frontend |
| 61 | Dry-run migration with non-critical Plesk account | `migration` `phase:1` | All |
| 62 | Fix all issues found in dry-run migration | `migration` `phase:1` | All |
| 63 | Perform first production migration (real Plesk customer) | `migration` `phase:1` | All |
| 64 | Verify post-migration: website up, email working, DB accessible | `migration` `phase:1` | All |
| 65 | Document lessons learned in `07-reference/MIGRATION_PLAN.md` | `docs` `phase:1` | All |

### GitHub Release Process

**File:** `.github/workflows/deploy-production.yml`

Full YAML is in `CICD_PIPELINE_REQUIREMENTS.md §P1.5`. Summary:
- Manual dispatch only (`workflow_dispatch`)
- Requires 1 approver in the `production` GitHub Environment
- Requires `reason` input (written to commit message for audit)
- Smoke test after deploy — automatic rollback on failure

For the Week 12 release (v1.0.0):

```bash
# Tag the release after successful production deploy
git tag -a v1.0.0 -m "Phase 1 MVP: first customer migrated"
git push origin v1.0.0

gh release create v1.0.0 \
  --title "Phase 1 MVP" \
  --notes "First production deployment. Core features: client management, domain management, file manager, email, databases, Plesk migration."
```

---

## GitHub Management Best Practices

### Branch Strategy (Git Flow)

```
main          ← production-ready code only; tagged releases
  └── staging ← integration branch; auto-deploys to staging
        └── feature/your-feature   ← individual feature work
        └── fix/your-bugfix        ← bug fixes
        └── infra/your-change      ← infrastructure changes
```

Rules:
- All work happens in feature branches off `staging`
- Feature branches merge into `staging` via PR (1 approval)
- `staging` merges into `main` via PR (2 approvals) only when staging deploy is verified
- Never commit directly to `main` or `staging`
- Delete feature branches after merge

### Pull Request Workflow

1. **Create feature branch from staging:**

   ```bash
   git checkout staging && git pull
   git checkout -b feature/client-search-api
   ```

2. **Commit with meaningful messages:**

   ```bash
   git commit -m "feat(backend): add full-text search to GET /api/v1/admin/clients

   Adds MySQL FULLTEXT index on (company_name, company_email, contact_email).
   Implements ?search= query param with < 500ms performance target.
   Closes #28"
   ```

3. **Push and open PR:**

   ```bash
   git push -u origin feature/client-search-api
   gh pr create --base staging --title "feat: client search API" --body "Closes #28"
   ```

4. **GitHub PR template** (`.github/pull_request_template.md`):

   Template content is in `GITHUB_INTEGRATION_SUMMARY.md`.

5. **Code review & merge:**
   - At least 2 approvals required for main
   - 1 approval required for staging
   - All CI checks must pass

### Issue Tracking

**Issue Labels:**

| Label | Color | Usage |
|-------|-------|-------|
| `backend` | `#0075ca` | Node.js / API work |
| `frontend` | `#e4e669` | React / UI work |
| `infrastructure` | `#d93f0b` | k8s, Terraform, networking |
| `migration` | `#f9d0c4` | Plesk migration tooling |
| `testing` | `#bfd4f2` | Test writing |
| `docs` | `#cfd3d7` | Documentation |
| `priority:high` | `#b60205` | Must be done this sprint |
| `priority:low` | `#0e8a16` | Nice to have |
| `phase:1` | `#1d76db` | Phase 1 scope |
| `phase:2` | `#5319e7` | Phase 2 scope |

**Issue Template:** `.github/ISSUE_TEMPLATE/feature.md` — see `GITHUB_INTEGRATION_SUMMARY.md`.

---

## GitHub Project Management

**Create GitHub Project** for Phase 1:

Go to: `github.com/orgs/hosting-platform/projects/new` → "Board" layout.

Columns: `Backlog` | `This Week` | `In Progress` | `In Review` | `Done`

**Weekly Sync:**

| Day | Activity |
|-----|----------|
| Monday | Pull items from backlog into "This Week"; assign owners; check CI health |
| Wednesday | Review blockers; pair on stuck issues; check open PRs |
| Friday | Merge ready PRs; deploy staging; close completed issues; post weekly update |

---

## Secrets Management (GitHub Secrets)

**Create organization secrets for sensitive data:**

| Secret | Description |
|--------|-------------|
| `KUBECONFIG_B64` | `cat ~/.kube/config \| base64 -w 0` (NetBird mesh IP, not public) |
| `HARBOR_REGISTRY` | Harbor hostname (e.g. `harbor.platform.internal`) |
| `HARBOR_USERNAME` | Harbor robot account username |
| `HARBOR_PASSWORD` | Harbor robot account password/token |
| `NETBIRD_SETUP_KEY` | NetBird reusable setup key for CI runners |
| `SLACK_WEBHOOK_URL` | Slack incoming webhook for deploy notifications |
| `CODECOV_TOKEN` | Codecov upload token |
| `HCLOUD_TOKEN` | Hetzner Cloud API token (for Terraform) |

**Use in workflows:**

```yaml
env:
  DATABASE_URL: ${{ secrets.DB_MIGRATION_URL }}
run: |
  echo "${{ secrets.KUBECONFIG_B64 }}" | base64 -d > ~/.kube/config
```

Full secrets table with rotation schedule is in `CICD_PIPELINE_REQUIREMENTS.md §Security`.

---

## Deployment Strategy

### Week 11: Staging Deployment

1. All Week 1-10 features merged to `staging` branch
2. Staging deploy triggers automatically via `deploy-staging.yml`
3. Team performs manual smoke test:
   - Create a test client via admin panel
   - Add a domain, verify DNS
   - Upload a test file via client panel
   - Create a test mailbox
   - Create a test database
4. Run load test: `gh workflow run load-test.yml -f duration=120 -f vus=10`
5. Fix all issues found; re-test
6. Only proceed to Week 12 once staging is stable for 48 hours

### Week 12: Production Deployment

1. Open PR from `staging` → `main`
2. Two team leads review and approve
3. Merge to `main` — this does **not** auto-deploy (production is manual)
4. Tag release: `git tag v1.0.0 && git push origin v1.0.0`
5. Trigger production deploy:
   ```bash
   gh workflow run deploy-production.yml \
     -f reason="Phase 1 MVP release — first Plesk customer migration" \
     -f image_tag="$(git rev-parse HEAD)"
   ```
6. Approve the deployment in the GitHub Environment gate (1 approver required)
7. Monitor smoke test in Actions logs
8. Verify production health in Grafana: **Platform Operations → Overview**

---

## Dependency Map (Gantt-style)

**Critical Path:** Infrastructure → API → Panels → Testing

```
Weeks 1-2:  [Infrastructure]─────────────────────────────────────────────────
Weeks 3-4:                   [Management API]────────────────────────────────
Weeks 5-6:                                   [Admin Panel]───────────────────
Weeks 7-8:                                                 [Client Panel]────
Weeks 9-10:                  [Migration Service]──────────────────────────────
Weeks 11-12:                                                       [Testing + First Migration]
```

**Parallel Work:**
- While backend builds API (Wk 3-4), frontend builds panels using mock API data (Wk 5-8)
- While both build, DevOps builds migration service (Wk 9-10)
- Everything tested together in weeks 11-12

---

## Risk Mitigations

### Risk 1: API delays block everything
**Mitigation:**
- Frontend can build with mock API data
- Use MSW (Mock Service Worker) for testing
- Create API mocks in week 2

### Risk 2: Database schema changes break migration
**Mitigation:**
- All DB changes through migrations (versioned)
- Test migrations weekly
- Keep rollback procedures documented

### Risk 3: First migration fails, customer loses data
**Mitigation:**
- Test migration with non-critical Plesk account first
- Build comprehensive migration validator
- Run validator before marking migration complete
- Have manual data restore procedure documented

### Risk 4: Performance issues discovered late
**Mitigation:**
- Load test early (week 10)
- Monitor response times in staging
- Set performance budgets (API < 200ms p50)

---

## Phase 1 Success Criteria

- [ ] Hetzner server deployed and stable
- [ ] k3s cluster running with no major issues
- [ ] All API endpoints tested and documented
- [ ] Admin panel has full client + domain management
- [ ] Client panel has file manager, email, databases
- [ ] Plesk migration service extracts all data
- [ ] First Plesk customer successfully migrated with zero data loss
- [ ] 99%+ uptime observed over 48-hour monitoring period
- [ ] All code documented and on GitHub
- [ ] Team can onboard new developer using README.md

---

## Documentation Checklist

**Create in `/docs/` folder (or `/config/Server Infrastructure/`):**

- [ ] `README.md` — Quick start, local dev setup, deployment commands
- [ ] `ARCHITECTURE.md` — High-level system diagram (reference `PLATFORM_ARCHITECTURE.md`)
- [ ] `API.md` — Link to OpenAPI spec + examples (reference `MANAGEMENT_API_SPEC.md`)
- [ ] `MIGRATION_RUNBOOK.md` — Step-by-step Plesk migration guide (reference `BACKUP_EXPORT_MIGRATION_GUIDE.md`)
- [ ] `TROUBLESHOOTING.md` — Common issues and fixes (start with CI/CD section from `CICD_PIPELINE_REQUIREMENTS.md`)

---

## Onboarding New Team Members

When adding a new developer to the project:

1. Add to GitHub org: `gh api orgs/hosting-platform/memberships/{username} --method PUT --field role=member`
2. Add to `platform-devs` team: `gh api orgs/hosting-platform/teams/platform-devs/memberships/{username} --method PUT`
3. Share NetBird setup key (via secure channel — not Slack plaintext)
4. Share `.env.example` files (via 1Password or equivalent)
5. Point to Developer Setup Checklist in `CICD_PIPELINE_REQUIREMENTS.md §Development Environment`
6. Assign first issue: a small, isolated backend or frontend task from the current week's backlog
7. First PR should be reviewed by two team members (good knowledge transfer opportunity)

---

## Communication Channels

**Use GitHub for:**
- Code reviews
- Design discussions (in PRs)
- Technical decisions (issues)
- Progress tracking (project board)

**Use Slack for:**
- Daily standup
- Quick questions
- Urgent issues
- Team announcements

**Sync meetings:**
- Monday morning: Plan week
- Wednesday: Mid-week check-in
- Friday: Review completed work

---

## Summary

By end of Week 12:
- Complete infrastructure on Hetzner (k3s, Longhorn, NGINX, Harbor, Flux, monitoring)
- External services running (PowerDNS, NetBird, Dex — provided by infrastructure project per ADR-022)
- Fully functional API with tests (Node.js/Fastify, MariaDB)
- Admin + client panels with core features (React/Vite/shadcn/ui)
- Plesk migration service
- First customer successfully migrated
- All code on GitHub with CI/CD
- Documentation complete
- Ready for Phase 2 (scale + regional replication)
