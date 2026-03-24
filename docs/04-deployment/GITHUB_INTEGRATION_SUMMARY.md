# GitHub Integration Summary

> Complete guide for managing the hosting platform project on GitHub.

---

## What Was Created

### New Documentation Files (This Session)

1. **PHASE_1_ROADMAP.md**
   - Week-by-week implementation plan (Weeks 1-12)
   - GitHub repository structure (monorepo layout)
   - GitHub Actions CI/CD pipelines (all workflows)
   - Branch strategy and PR workflow
   - Dependency mapping and resource allocation
   - Deliverables for each week

2. **CONFLICT_RESOLUTION_MATRIX.md**
   - Defines conflict resolution for every database table
   - Conflict types (last-write-wins, business logic, local wins, delete wins, disable wins)
   - SQL triggers and PostgreSQL implementation
   - Test cases for conflict resolution
   - Monitoring & alerting strategies

---

## Quick Start: Getting Code on GitHub

### Step 1: Create GitHub Organization

1. Go to https://github.com/organizations/new
2. Name it `hosting-platform` (or your chosen org name)
3. Set visibility to **Private**
4. Add billing (free tier is fine for up to 3 private repos with Actions minutes)

### Step 2: Create Main Repository

```bash
# From your local machine (after installing gh CLI)
gh auth login
gh repo create hosting-platform/hosting-platform \
  --private \
  --description "Kubernetes-based web hosting platform" \
  --clone
```

Repository should be a **monorepo** with this layout:

```
hosting-platform/
├── .github/
│   ├── workflows/            # All CI/CD pipeline YAML files
│   ├── ISSUE_TEMPLATE/
│   │   ├── feature.md
│   │   └── bug.md
│   └── pull_request_template.md
├── backend/                  # Node.js / Fastify management API
├── frontend/
│   ├── admin-panel/          # React admin panel (Vite)
│   └── client-panel/         # React client panel (Vite)
├── migration-service/        # Plesk extractor + migration tooling
├── k8s/                      # Kubernetes manifests (Kustomize overlays)
│   ├── base/
│   ├── overlays/
│   │   ├── staging/
│   │   └── production/
├── helm/                     # Helm charts for platform services
├── terraform/                # Infrastructure-as-code (Hetzner VPS provisioning)
├── catalog-images/           # Dockerfiles for workload catalog images
├── scripts/                  # Utility shell scripts (setup, backup, rotate secrets)
└── docs/                     # Additional documentation (if not in /config/)
```

### Step 3: Configure Branch Protection

Set up branch protection rules in **Settings → Branches**:

**`main` branch:**
- Require pull request before merging: ✅
- Require approvals: **2**
- Dismiss stale pull request approvals when new commits are pushed: ✅
- Require status checks to pass before merging: ✅
  - `backend-ci`
  - `frontend-admin-ci`
  - `frontend-client-ci`
- Require branches to be up to date before merging: ✅
- Include administrators: ✅
- Allow force pushes: ❌
- Allow deletions: ❌

**`staging` branch:**
- Require pull request before merging: ✅
- Require approvals: **1**
- Require status checks to pass: ✅ (same checks as main)
- Allow force pushes: ❌

```bash
# Via gh CLI
gh api repos/hosting-platform/hosting-platform/branches/main/protection \
  --method PUT \
  --field required_status_checks='{"strict":true,"contexts":["backend-ci","frontend-admin-ci","frontend-client-ci"]}' \
  --field enforce_admins=true \
  --field required_pull_request_reviews='{"required_approving_review_count":2,"dismiss_stale_reviews":true}' \
  --field restrictions=null
```

### Step 4: Set Up GitHub Secrets

Navigate to **Settings → Secrets and variables → Actions** and create these repository secrets:

| Secret Name | Description | Example Value |
|-------------|-------------|---------------|
| `KUBECONFIG_B64` | Base64-encoded kubeconfig for k3s cluster (via NetBird mesh) | `cat ~/.kube/config \| base64 -w 0` |
| `HARBOR_REGISTRY` | Harbor registry hostname | `harbor.platform.internal` |
| `HARBOR_USERNAME` | Harbor push credentials username | `ci-robot` |
| `HARBOR_PASSWORD` | Harbor push credentials password | `<harbor-robot-token>` |
| `STAGING_KUBECONFIG_B64` | Kubeconfig for staging cluster (if separate) | Same as above for staging |
| `NETBIRD_SETUP_KEY` | NetBird setup key for CI runner VPN access | `<netbird-setup-key>` |
| `DB_MIGRATION_URL` | Database connection URL for migration tests | `mysql://user:pass@host:3306/db` |
| `SLACK_WEBHOOK_URL` | Slack webhook for deployment notifications | `https://hooks.slack.com/...` |
| `CODECOV_TOKEN` | Codecov upload token for coverage reports | `<codecov-token>` |

**To encode kubeconfig for GitHub:**

```bash
# Export your k3s kubeconfig and encode it
# Note: replace the server URL with the NetBird mesh IP of your control plane
cat ~/.kube/config | base64 -w 0
# Paste the output as the value of KUBECONFIG_B64
```

### Step 5: Enable GitHub Actions

GitHub Actions is enabled by default on new repos. Confirm it is active at:
**Settings → Actions → General → Allow all actions and reusable workflows**

Set workflow permissions to: **Read and write permissions** (required for Flux manifest commits).

---

## Repository Structure (Copy-Paste Ready)

### .gitignore

```gitignore
# Node / npm
node_modules/
dist/
.env
.env.*
*.env
npm-debug.log*
yarn-error.log*

# Terraform
.terraform/
*.tfstate
*.tfstate.backup
*.tfvars
.terraform.lock.hcl

# Kubernetes / Helm
*.kubeconfig
kubeconfig
/k8s/overlays/production/secrets/
/helm/secrets/

# Sealed Secrets source files (keep only sealed versions)
*-secret.yaml
!*-sealed-secret.yaml

# OS
.DS_Store
Thumbs.db

# IDE
.vscode/
.idea/
*.swp

# Build outputs
build/
coverage/
.nyc_output/

# Docker
.docker/

# Logs
*.log
logs/
```

---

## GitHub Actions Workflows (Ready to Use)

All workflow files go in `.github/workflows/`. See `CICD_PIPELINE_REQUIREMENTS.md` for full YAML content of each pipeline.

### 1. Backend CI Pipeline (`ci-backend.yml`)

Triggers: push/PR to `main` or `staging` affecting `backend/**`. Runs lint, type-check, unit tests, integration tests, Docker build, Trivy scan, push to Harbor. See `CICD_PIPELINE_REQUIREMENTS.md §P1.1`.

### 2. Frontend CI Pipeline (`ci-frontend.yml`)

Triggers: push/PR to `main` or `staging` affecting `frontend/**`. Runs lint, type-check, Vitest unit tests, Vite build. Two jobs: `frontend-admin-ci` and `frontend-client-ci` (required status checks). See `CICD_PIPELINE_REQUIREMENTS.md §P1.2`.

### 3. Terraform Validation (`terraform-validate.yml`)

Triggers: push/PR affecting `terraform/**`. Runs `terraform fmt`, `terraform validate`, `terraform plan` (dry-run against Hetzner). See `CICD_PIPELINE_REQUIREMENTS.md §P1.3`.

### 4. Deploy to Staging (`deploy-staging.yml`)

Triggers: push to `staging` branch (after CI passes). Builds image, pushes to Harbor, updates Flux manifest in `k8s/overlays/staging/`, commits back — Flux auto-applies within 5 minutes. See `CICD_PIPELINE_REQUIREMENTS.md §P1.4`.

### 5. Deploy to Production (`deploy-production.yml`)

Triggers: manual dispatch only (`workflow_dispatch`) with environment approval gate. Updates `k8s/overlays/production/` manifest — Flux auto-applies. Requires 1 approver in the `production` GitHub Environment. See `CICD_PIPELINE_REQUIREMENTS.md §P1.5`.

---

## Pull Request & Issue Templates

### `.github/pull_request_template.md`

```markdown
## Summary

<!-- What does this PR do? 1-3 bullet points. -->

- 

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup
- [ ] Documentation
- [ ] Infrastructure / CI

## Related issues

Closes #

## Testing

- [ ] Unit tests added / updated
- [ ] Integration tests added / updated
- [ ] Tested manually (describe steps)
- [ ] No tests needed (explain why)

## Checklist

- [ ] Code follows project style (lint passes)
- [ ] No console.log() or debug code left behind
- [ ] No new dependencies without justification in PR description
- [ ] Database migrations are reversible
- [ ] API changes are documented (OpenAPI updated)
- [ ] Error handling is comprehensive
- [ ] No secrets in code
- [ ] Performance: no N+1 queries, indexes added where needed
```

### `.github/ISSUE_TEMPLATE/feature.md`

```markdown
---
name: Feature request
about: New functionality or enhancement
labels: enhancement
---

## Summary

<!-- One sentence: what should this do? -->

## Motivation

<!-- Why is this needed? What problem does it solve? -->

## Acceptance criteria

- [ ] 
- [ ] 
- [ ] 

## Notes / Design

<!-- Architecture notes, API changes, schema changes, etc. -->

## Phase

- [ ] Phase 1 (MVP)
- [ ] Phase 1.5
- [ ] Phase 2
- [ ] Phase 3
```

### `.github/ISSUE_TEMPLATE/bug.md`

```markdown
---
name: Bug report
about: Something is broken
labels: bug
---

## Summary

<!-- One sentence: what is broken? -->

## Steps to reproduce

1. 
2. 
3. 

## Expected behaviour

## Actual behaviour

## Environment

- Branch / commit:
- Node.js version:
- Browser (if frontend):

## Logs / screenshots

<!-- Paste relevant logs or attach screenshots -->
```

---

## GitHub Secrets Needed

| Secret Name | How to generate |
|-------------|----------------|
| `KUBECONFIG_B64` | `cat ~/.kube/config \| base64 -w 0` — replace server URL with NetBird mesh IP first |
| `HARBOR_USERNAME` / `HARBOR_PASSWORD` | Create a robot account in Harbor: **Administration → Robot Accounts → New Robot Account** with push/pull permissions |
| `NETBIRD_SETUP_KEY` | In NetBird dashboard: **Setup Keys → Create Key** (type: Reusable, for CI runners) |
| `SLACK_WEBHOOK_URL` | In Slack: **Apps → Incoming Webhooks → Add to workspace** |
| `CODECOV_TOKEN` | Sign in at codecov.io with GitHub, select the repo, copy the upload token |

---

## GitHub Project Board Setup

Create a GitHub Project for Phase 1 at **github.com/orgs/hosting-platform/projects/new** (use the "Board" layout).

**Columns:**

| Column | Purpose |
|--------|---------|
| **Backlog** | All created issues not yet scheduled |
| **This Week** | Issues assigned to current week's sprint |
| **In Progress** | Actively being worked on (limit: 2 per person) |
| **In Review** | PR open, awaiting review |
| **Done** | Merged and closed this week |

**Automation Rules:**

| Trigger | Action |
|---------|--------|
| Issue opened | → Move to **Backlog** |
| PR opened | → Move linked issue to **In Review** |
| PR merged | → Move linked issue to **Done** |
| Issue closed manually | → Move to **Done** |

**Labels to create:**

```
backend       #0075ca
frontend      #e4e669
infrastructure #d93f0b
migration     #f9d0c4
testing       #bfd4f2
docs          #cfd3d7
priority:high #b60205
priority:low  #0e8a16
phase:1       #1d76db
phase:2       #5319e7
```

---

## Weekly Workflow

### Monday: Planning

1. Review **This Week** column — move incomplete items to top of backlog or re-assign
2. Pull top-priority items from backlog into **This Week** (no more than 3 per person)
3. Create any missing issues for the week's goals (from `PHASE_1_ROADMAP.md`)
4. Check CI status — fix any broken pipelines before starting new work
5. Sync meeting: review blockers, assign ownership

### Wednesday: Mid-week Check-in

1. Review **In Progress** — anything stuck? Needs pairing?
2. Check open PRs — any stale reviews?
3. Run `gh pr list --repo hosting-platform/hosting-platform` to see all open PRs
4. Check GitHub Actions failures: `gh run list --status failure`
5. 15-minute sync: blockers only

### Friday: Review & Close

1. Merge all ready PRs (staging merges first, then to main after staging deploy verified)
2. Move all merged items to **Done**
3. Run staging deploy manually and smoke-test
4. Post weekly summary in Slack: `#platform-dev`
5. Close completed issues

```bash
# Useful end-of-week commands
gh run list --limit 10                              # Recent workflow runs
gh pr list --state open                             # All open PRs
gh issue list --label "phase:1" --state open        # Open Phase 1 issues
```

---

## Monitoring GitHub Actions

**Check workflow runs:**

```bash
# List recent runs
gh run list --repo hosting-platform/hosting-platform --limit 20

# Watch a specific run in real time
gh run watch <run-id>

# View logs for a failed run
gh run view <run-id> --log-failed

# Re-run failed jobs only
gh run rerun <run-id> --failed-only
```

**Check test coverage:**

- Coverage reports uploaded to Codecov
- View at: https://codecov.io/gh/hosting-platform/hosting-platform
- Coverage badge in README.md

---

## Code Review Checklist

**Reviewer should verify:**

- [ ] Code follows style guide (checked by linter in CI)
- [ ] Tests added/updated (verified by test coverage)
- [ ] No console.log() or debug code left behind
- [ ] No new dependencies without justification
- [ ] Database migrations are reversible
- [ ] API changes documented
- [ ] Error handling is comprehensive
- [ ] Security: no secrets in code, proper auth/validation
- [ ] Performance: no obvious N+1 queries, proper indexing

**Example review comment:**

```
This looks good overall. One concern: the `getClientById` call on line 42 
runs inside a loop — for N clients this will be N+1 queries. 
Consider using a single JOIN or a `whereIn` instead.
```

---

## Summary

You now have everything needed to:

- Create a GitHub repository with correct monorepo structure
- Set up branch protection (main: 2 approvals, staging: 1 approval)
- Configure all required GitHub Secrets
- Use pull_request and issue templates
- Set up a project board with automation
- Run CI/CD pipelines (see `CICD_PIPELINE_REQUIREMENTS.md` for full YAML)
- Track weekly progress with a structured Monday/Wednesday/Friday cadence

**Next steps:**

1. Create repository on GitHub
2. Copy `.github/workflows/` YAML from `CICD_PIPELINE_REQUIREMENTS.md`
3. Set up repository secrets (table above)
4. Create GitHub Project board with columns and automation
5. Create first batch of issues for Week 1 (from `PHASE_1_ROADMAP.md §Week 1-2`)
6. Assign team members
7. Start building
