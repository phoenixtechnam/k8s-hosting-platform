# CI/CD Pipeline Requirements Specification

> **Complete CI/CD pipeline specification for development and ongoing operations**
>
> **Covers:** Initial development (Phases 1-2), ongoing maintenance, deployment strategies, monitoring
>
> **Status:** Production-ready specification

---

## Table of Contents

1. [Overview & Goals](#overview)
2. [Development Environment](#dev-environment)
3. [Phase 1 CI/CD (Weeks 1-12)](#phase-1-cicd)
4. [Phase 1.5 CI/CD Enhancements (Week 13)](#phase-15-cicd)
5. [Phase 2 CI/CD (Weeks 14-16)](#phase-2-cicd)
6. [Ongoing Development CI/CD](#ongoing-cicd)
7. [Deployment Strategies](#deployment)
8. [Monitoring & Observability](#monitoring)
9. [Security & Compliance](#security)
10. [Troubleshooting & Rollback](#troubleshooting)

---

## Overview & Goals

### Purpose

Automated CI/CD pipeline to:
- Catch bugs early (automated tests)
- Ensure code quality (linting, type checking)
- Automate deployments (reduce manual errors)
- Enable rapid iteration (fast feedback)
- Support team scaling (reproducible builds)
- Maintain stability (automated rollbacks)

### Key Principles

1. **Fail Fast:** Detect issues as early as possible
2. **Automate Everything:** Minimal manual intervention
3. **Immutable Deployments:** Same artifact deployed everywhere
4. **Rollback Ready:** Always able to revert to previous version
5. **Observable:** Full visibility into pipeline and deployments
6. **Secure:** Secrets managed, no credentials in code

### Success Metrics

| Metric | Phase 1 Target | Ongoing Target |
|--------|---|---|
| **Test Coverage** | 60%+ | 80%+ |
| **Build Time** | < 10 min | < 8 min |
| **Deploy Time** | < 5 min | < 3 min |
| **Test Pass Rate** | 95%+ | 99%+ |
| **Deploy Frequency** | 2x/week | 5x/week |
| **MTTR (recovery)** | < 30 min | < 15 min |
| **Zero-Downtime Deploy** | No (Phase 1) | Yes (Phase 2+) |

---

## Development Environment

### Phase 1: Local Development Setup

**Docker Compose for Local Dev:**

```yaml
# docker-compose.yml — local development environment
version: "3.9"
services:
  backend:
    build:
      context: ./backend
      dockerfile: Dockerfile.dev
    ports:
      - "3000:3000"
    volumes:
      - ./backend:/app
      - /app/node_modules
    environment:
      NODE_ENV: development
      DATABASE_URL: mysql://platform:platform@mariadb:3306/platform_dev
      REDIS_URL: redis://redis:6379
    depends_on:
      - mariadb
      - redis

  admin-panel:
    build:
      context: ./frontend/admin-panel
      dockerfile: Dockerfile.dev
    ports:
      - "5173:5173"
    volumes:
      - ./frontend/admin-panel:/app
      - /app/node_modules
    environment:
      VITE_API_URL: http://localhost:3000

  client-panel:
    build:
      context: ./frontend/client-panel
      dockerfile: Dockerfile.dev
    ports:
      - "5174:5174"
    volumes:
      - ./frontend/client-panel:/app
      - /app/node_modules
    environment:
      VITE_API_URL: http://localhost:3000

  mariadb:
    image: mariadb:10.11
    ports:
      - "3306:3306"
    environment:
      MYSQL_ROOT_PASSWORD: root
      MYSQL_DATABASE: platform_dev
      MYSQL_USER: platform
      MYSQL_PASSWORD: platform
    volumes:
      - mariadb-data:/var/lib/mysql
      - ./backend/migrations:/docker-entrypoint-initdb.d

  redis:
    image: redis:7-alpine
    ports:
      - "6379:6379"

  mailhog:
    image: mailhog/mailhog
    ports:
      - "1025:1025"   # SMTP
      - "8025:8025"   # Web UI

volumes:
  mariadb-data:
```

**Local Development Commands:**

```bash
# Start all services
docker compose up -d

# Watch backend logs
docker compose logs -f backend

# Run backend tests
docker compose exec backend npm test

# Run database migrations
docker compose exec backend npm run db:migrate

# Seed development data
docker compose exec backend npm run db:seed

# Run frontend (admin panel) dev server
docker compose up admin-panel

# Lint all code
npm run lint --workspaces

# Build all for production
npm run build --workspaces

# Stop all
docker compose down
```

### Phase 1: Developer Setup Checklist

```markdown
## New Developer Setup

- [ ] Clone repo: `gh repo clone hosting-platform/hosting-platform`
- [ ] Install Node.js LTS (v22+): `nvm install --lts`
- [ ] Install Docker + Docker Compose
- [ ] Install kubectl: `brew install kubectl` or equivalent
- [ ] Install k9s (optional Kubernetes TUI): `brew install k9s`
- [ ] Install gh CLI: `brew install gh && gh auth login`
- [ ] Copy `.env.example` to `.env` in `backend/` and `frontend/*/`
- [ ] Start local dev: `docker compose up -d`
- [ ] Run migrations: `docker compose exec backend npm run db:migrate`
- [ ] Seed dev data: `docker compose exec backend npm run db:seed`
- [ ] Open admin panel: http://localhost:5173
- [ ] Open client panel: http://localhost:5174
- [ ] Connect to NetBird mesh (get setup key from team lead)
- [ ] Verify kubectl access: `kubectl get nodes`
```

---

## Phase 1 CI/CD (Weeks 1-12)

### P1.1 Backend CI Pipeline

**File:** `.github/workflows/ci-backend.yml`

```yaml
name: Backend CI

on:
  push:
    branches: [main, staging]
    paths:
      - 'backend/**'
      - '.github/workflows/ci-backend.yml'
  pull_request:
    branches: [main, staging]
    paths:
      - 'backend/**'

concurrency:
  group: backend-ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  backend-ci:
    name: Backend CI
    runs-on: ubuntu-latest
    timeout-minutes: 15

    services:
      mariadb:
        image: mariadb:10.11
        env:
          MYSQL_ROOT_PASSWORD: root
          MYSQL_DATABASE: platform_test
          MYSQL_USER: platform
          MYSQL_PASSWORD: platform
        ports:
          - 3306:3306
        options: --health-cmd="mysqladmin ping" --health-interval=10s --health-timeout=5s --health-retries=3

      redis:
        image: redis:7-alpine
        ports:
          - 6379:6379
        options: --health-cmd="redis-cli ping" --health-interval=10s --health-timeout=5s --health-retries=3

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
          cache-dependency-path: backend/package-lock.json

      - name: Install dependencies
        working-directory: backend
        run: npm ci

      - name: Lint
        working-directory: backend
        run: npm run lint

      - name: Type check
        working-directory: backend
        run: npm run typecheck

      - name: Run database migrations
        working-directory: backend
        run: npm run db:migrate
        env:
          DATABASE_URL: mysql://platform:platform@localhost:3306/platform_test

      - name: Run unit tests
        working-directory: backend
        run: npm run test:unit -- --coverage
        env:
          DATABASE_URL: mysql://platform:platform@localhost:3306/platform_test
          REDIS_URL: redis://localhost:6379
          NODE_ENV: test

      - name: Run integration tests
        working-directory: backend
        run: npm run test:integration
        env:
          DATABASE_URL: mysql://platform:platform@localhost:3306/platform_test
          REDIS_URL: redis://localhost:6379
          NODE_ENV: test

      - name: Upload coverage to Codecov
        uses: codecov/codecov-action@v4
        with:
          token: ${{ secrets.CODECOV_TOKEN }}
          directory: backend/coverage
          flags: backend

      - name: Build Docker image
        working-directory: backend
        run: |
          docker build -t ${{ secrets.HARBOR_REGISTRY }}/platform/backend:${{ github.sha }} .

      - name: Scan image with Trivy
        uses: aquasecurity/trivy-action@master
        with:
          image-ref: ${{ secrets.HARBOR_REGISTRY }}/platform/backend:${{ github.sha }}
          format: table
          exit-code: 1
          severity: CRITICAL,HIGH
          ignore-unfixed: true

      - name: Push to Harbor
        if: github.event_name == 'push'
        run: |
          echo "${{ secrets.HARBOR_PASSWORD }}" | docker login ${{ secrets.HARBOR_REGISTRY }} -u ${{ secrets.HARBOR_USERNAME }} --password-stdin
          docker push ${{ secrets.HARBOR_REGISTRY }}/platform/backend:${{ github.sha }}
          docker tag ${{ secrets.HARBOR_REGISTRY }}/platform/backend:${{ github.sha }} \
                     ${{ secrets.HARBOR_REGISTRY }}/platform/backend:latest
          docker push ${{ secrets.HARBOR_REGISTRY }}/platform/backend:latest
```

---

### P1.2 Frontend CI Pipeline

**File:** `.github/workflows/ci-frontend.yml`

```yaml
name: Frontend CI

on:
  push:
    branches: [main, staging]
    paths:
      - 'frontend/**'
      - '.github/workflows/ci-frontend.yml'
  pull_request:
    branches: [main, staging]
    paths:
      - 'frontend/**'

concurrency:
  group: frontend-ci-${{ github.ref }}
  cancel-in-progress: true

jobs:
  frontend-admin-ci:
    name: Admin Panel CI
    runs-on: ubuntu-latest
    timeout-minutes: 10
    defaults:
      run:
        working-directory: frontend/admin-panel

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
          cache-dependency-path: frontend/admin-panel/package-lock.json

      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Type check
        run: npm run typecheck

      - name: Run tests
        run: npm run test -- --coverage --reporter=verbose

      - name: Build
        run: npm run build
        env:
          VITE_API_URL: https://api.platform.internal

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          token: ${{ secrets.CODECOV_TOKEN }}
          directory: frontend/admin-panel/coverage
          flags: frontend-admin

  frontend-client-ci:
    name: Client Panel CI
    runs-on: ubuntu-latest
    timeout-minutes: 10
    defaults:
      run:
        working-directory: frontend/client-panel

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up Node.js
        uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
          cache-dependency-path: frontend/client-panel/package-lock.json

      - name: Install dependencies
        run: npm ci

      - name: Lint
        run: npm run lint

      - name: Type check
        run: npm run typecheck

      - name: Run tests
        run: npm run test -- --coverage --reporter=verbose

      - name: Build
        run: npm run build
        env:
          VITE_API_URL: https://api.platform.internal

      - name: Upload coverage
        uses: codecov/codecov-action@v4
        with:
          token: ${{ secrets.CODECOV_TOKEN }}
          directory: frontend/client-panel/coverage
          flags: frontend-client
```

---

### P1.3 Deploy to Staging

**File:** `.github/workflows/deploy-staging.yml`

Triggered automatically on push to `staging` branch after CI passes.

```yaml
name: Deploy to Staging

on:
  push:
    branches: [staging]

concurrency:
  group: deploy-staging
  cancel-in-progress: false   # never cancel an in-flight deploy

jobs:
  deploy-staging:
    name: Deploy to Staging
    runs-on: ubuntu-latest
    timeout-minutes: 20
    environment: staging

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up kubectl
        uses: azure/setup-kubectl@v3
        with:
          version: 'v1.29.0'

      - name: Connect to NetBird mesh
        run: |
          curl -fsSL https://pkgs.netbird.io/install.sh | sh
          netbird up --setup-key ${{ secrets.NETBIRD_SETUP_KEY }} --management-url https://netbird.platform.internal
          sleep 10   # allow mesh to establish

      - name: Configure kubeconfig
        run: |
          mkdir -p ~/.kube
          echo "${{ secrets.STAGING_KUBECONFIG_B64 }}" | base64 -d > ~/.kube/config
          chmod 600 ~/.kube/config

      - name: Verify cluster access
        run: kubectl get nodes

      - name: Login to Harbor
        run: |
          echo "${{ secrets.HARBOR_PASSWORD }}" | docker login ${{ secrets.HARBOR_REGISTRY }} \
            -u ${{ secrets.HARBOR_USERNAME }} --password-stdin

      - name: Update image tag in dev overlay
        run: |
          IMAGE="${{ secrets.HARBOR_REGISTRY }}/platform/backend:${{ github.sha }}"
          sed -i "s|image: .*platform/backend:.*|image: ${IMAGE}|g" \
            k8s/overlays/dev/backend-deployment-patch.yaml

      - name: Commit updated manifest
        run: |
          git config user.name "ci-bot"
          git config user.email "ci@platform.internal"
          git add k8s/overlays/dev/
          git diff --staged --quiet || git commit -m "chore: update dev backend image to ${{ github.sha }}"
          git push

      - name: Wait for Flux to reconcile
        run: |
          # Flux syncs every 5 minutes; wait up to 10 minutes for rollout
          kubectl wait deployment/backend-api \
            -n platform \
            --for=condition=Available \
            --timeout=600s

      - name: Smoke test staging
        run: |
          STAGING_URL="https://api.staging.platform.internal"
          STATUS=$(curl -sf -o /dev/null -w "%{http_code}" ${STAGING_URL}/health)
          if [ "$STATUS" != "200" ]; then
            echo "Smoke test failed: GET /health returned ${STATUS}"
            exit 1
          fi
          echo "Smoke test passed: ${STATUS}"

      - name: Notify Slack on failure
        if: failure()
        run: |
          curl -X POST ${{ secrets.SLACK_WEBHOOK_URL }} \
            -H 'Content-type: application/json' \
            --data '{"text":"⚠️ Staging deploy FAILED for commit ${{ github.sha }}. See: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}"}'
```

---

### P1.5 Deploy to Production (Manual)

**File:** `.github/workflows/deploy-production.yml`

Manual dispatch only, requires approval from the `production` GitHub Environment.

```yaml
name: Deploy to Production

on:
  workflow_dispatch:
    inputs:
      image_tag:
        description: 'Image tag to deploy (default: latest staging sha)'
        required: false
        default: ''
      reason:
        description: 'Deployment reason (for audit trail)'
        required: true

concurrency:
  group: deploy-production
  cancel-in-progress: false

jobs:
  deploy-production:
    name: Deploy to Production
    runs-on: ubuntu-latest
    timeout-minutes: 20
    environment: production   # requires 1 approver configured in GitHub Environments

    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Determine image tag
        id: tag
        run: |
          TAG="${{ inputs.image_tag }}"
          if [ -z "$TAG" ]; then
            # Default to the latest commit on main
            TAG="${{ github.sha }}"
          fi
          echo "tag=${TAG}" >> $GITHUB_OUTPUT

      - name: Set up kubectl
        uses: azure/setup-kubectl@v3
        with:
          version: 'v1.29.0'

      - name: Connect to NetBird mesh
        run: |
          curl -fsSL https://pkgs.netbird.io/install.sh | sh
          netbird up --setup-key ${{ secrets.NETBIRD_SETUP_KEY }} --management-url https://netbird.platform.internal
          sleep 10

      - name: Configure kubeconfig
        run: |
          mkdir -p ~/.kube
          echo "${{ secrets.KUBECONFIG_B64 }}" | base64 -d > ~/.kube/config
          chmod 600 ~/.kube/config

      - name: Verify cluster access
        run: kubectl get nodes

      - name: Pre-deploy: record current image tag
        id: pre_deploy
        run: |
          CURRENT=$(kubectl get deployment backend-api -n platform \
            -o jsonpath='{.spec.template.spec.containers[0].image}')
          echo "previous_image=${CURRENT}" >> $GITHUB_OUTPUT
          echo "Previous image: ${CURRENT}"

      - name: Update image tag in production overlay
        run: |
          IMAGE="${{ secrets.HARBOR_REGISTRY }}/platform/backend:${{ steps.tag.outputs.tag }}"
          sed -i "s|image: .*platform/backend:.*|image: ${IMAGE}|g" \
            k8s/overlays/production/backend-deployment-patch.yaml

      - name: Commit updated manifest
        run: |
          git config user.name "ci-bot"
          git config user.email "ci@platform.internal"
          git add k8s/overlays/production/
          git diff --staged --quiet || git commit -m "chore: deploy backend ${{ steps.tag.outputs.tag }} to production — ${{ inputs.reason }}"
          git push

      - name: Wait for Flux to reconcile
        run: |
          kubectl wait deployment/backend-api \
            -n platform \
            --for=condition=Available \
            --timeout=600s

      - name: Smoke test production
        run: |
          PROD_URL="https://api.platform.internal"
          STATUS=$(curl -sf -o /dev/null -w "%{http_code}" ${PROD_URL}/health)
          if [ "$STATUS" != "200" ]; then
            echo "Production smoke test FAILED: ${STATUS}"
            # Automatic rollback
            IMAGE="${{ steps.pre_deploy.outputs.previous_image }}"
            sed -i "s|image: .*platform/backend:.*|image: ${IMAGE}|g" \
              k8s/overlays/production/backend-deployment-patch.yaml
            git add k8s/overlays/production/
            git commit -m "chore: automatic rollback — smoke test failed after deploy ${{ steps.tag.outputs.tag }}"
            git push
            exit 1
          fi
          echo "Production smoke test passed: ${STATUS}"

      - name: Notify Slack on success
        if: success()
        run: |
          curl -X POST ${{ secrets.SLACK_WEBHOOK_URL }} \
            -H 'Content-type: application/json' \
            --data "{\"text\":\"✅ Production deploy complete: backend ${{ steps.tag.outputs.tag }} — ${{ inputs.reason }}\"}"

      - name: Notify Slack on failure
        if: failure()
        run: |
          curl -X POST ${{ secrets.SLACK_WEBHOOK_URL }} \
            -H 'Content-type: application/json' \
            --data "{\"text\":\"🚨 Production deploy FAILED: ${{ steps.tag.outputs.tag }} — automatic rollback attempted. See: ${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}\"}"
```

---

## Phase 1.5 CI/CD Enhancements (Week 13)

### P1.5.1 Performance Benchmarking

**Add to backend CI pipeline** (after tests pass):

```yaml
      - name: Performance benchmark
        working-directory: backend
        run: npm run bench
        env:
          DATABASE_URL: mysql://platform:platform@localhost:3306/platform_test
          REDIS_URL: redis://localhost:6379
        # Fails CI if any endpoint regresses beyond 20% of baseline
        # Baseline stored in backend/benchmarks/baseline.json
```

`backend/benchmarks/baseline.json` stores p50/p95/p99 latency per endpoint. The `npm run bench` script compares against baseline and exits non-zero on regression.

---

### P1.5.2 Database Migration Testing

**File:** `.github/workflows/db-migration-test.yml`

```yaml
name: Database Migration Test

on:
  pull_request:
    paths:
      - 'backend/migrations/**'

jobs:
  migration-test:
    name: Test DB Migrations (up + down)
    runs-on: ubuntu-latest
    timeout-minutes: 10

    services:
      mariadb:
        image: mariadb:10.11
        env:
          MYSQL_ROOT_PASSWORD: root
          MYSQL_DATABASE: platform_migration_test
          MYSQL_USER: platform
          MYSQL_PASSWORD: platform
        ports:
          - 3306:3306
        options: --health-cmd="mysqladmin ping" --health-interval=10s --health-timeout=5s --health-retries=3

    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '22'
          cache: 'npm'
          cache-dependency-path: backend/package-lock.json

      - name: Install dependencies
        working-directory: backend
        run: npm ci

      - name: Run migrations up
        working-directory: backend
        run: npm run db:migrate
        env:
          DATABASE_URL: mysql://platform:platform@localhost:3306/platform_migration_test

      - name: Run migrations down (rollback all)
        working-directory: backend
        run: npm run db:migrate:rollback:all
        env:
          DATABASE_URL: mysql://platform:platform@localhost:3306/platform_migration_test

      - name: Run migrations up again (verify idempotency)
        working-directory: backend
        run: npm run db:migrate
        env:
          DATABASE_URL: mysql://platform:platform@localhost:3306/platform_migration_test
```

---

### P1.5.3 Load Testing (Optional)

**File:** `.github/workflows/load-test.yml`

```yaml
name: Load Test (Staging)

on:
  workflow_dispatch:
    inputs:
      duration:
        description: 'Test duration in seconds'
        default: '60'
      vus:
        description: 'Virtual users'
        default: '10'

jobs:
  load-test:
    name: k6 Load Test
    runs-on: ubuntu-latest
    timeout-minutes: 15
    environment: staging

    steps:
      - uses: actions/checkout@v4

      - name: Install k6
        run: |
          sudo gpg -k
          sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg \
            --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
          echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" \
            | sudo tee /etc/apt/sources.list.d/k6.list
          sudo apt-get update && sudo apt-get install k6

      - name: Connect to NetBird mesh
        run: |
          curl -fsSL https://pkgs.netbird.io/install.sh | sh
          netbird up --setup-key ${{ secrets.NETBIRD_SETUP_KEY }} --management-url https://netbird.platform.internal
          sleep 10

      - name: Run load test
        run: |
          k6 run \
            --vus ${{ inputs.vus }} \
            --duration ${{ inputs.duration }}s \
            --env BASE_URL=https://api.staging.platform.internal \
            backend/tests/load/main.js

      - name: Upload results
        uses: actions/upload-artifact@v4
        with:
          name: k6-results
          path: k6-results.json
```

---

## Phase 2 CI/CD (Weeks 14-16)

### P2.1 Automated Canary Deployments

**File:** `.github/workflows/deploy-canary.yml`

```yaml
name: Canary Deploy

on:
  push:
    branches: [main]

jobs:
  canary:
    name: Canary Deploy (10% traffic)
    runs-on: ubuntu-latest
    environment: production-canary

    steps:
      - uses: actions/checkout@v4

      - name: Deploy canary (10% traffic weight via NGINX Ingress)
        run: |
          # Update canary deployment image
          kubectl set image deployment/backend-api-canary \
            backend=${{ secrets.HARBOR_REGISTRY }}/platform/backend:${{ github.sha }} \
            -n platform

          # Set NGINX Ingress canary weight to 10%
          kubectl annotate ingress backend-ingress -n platform \
            nginx.ingress.kubernetes.io/canary="true" \
            nginx.ingress.kubernetes.io/canary-weight="10" \
            --overwrite

      - name: Monitor canary for 10 minutes
        run: |
          sleep 600
          # Check error rate via Prometheus query
          ERROR_RATE=$(curl -s "http://prometheus.platform.internal:9090/api/v1/query" \
            --data-urlencode 'query=rate(http_requests_total{job="backend-api-canary",status=~"5.."}[5m]) / rate(http_requests_total{job="backend-api-canary"}[5m]) * 100' \
            | jq '.data.result[0].value[1]' -r)
          echo "Canary error rate: ${ERROR_RATE}%"
          if (( $(echo "$ERROR_RATE > 1" | bc -l) )); then
            echo "Error rate above 1% — rolling back canary"
            kubectl annotate ingress backend-ingress -n platform \
              nginx.ingress.kubernetes.io/canary-weight="0" --overwrite
            exit 1
          fi

      - name: Promote canary to 100%
        if: success()
        run: |
          kubectl set image deployment/backend-api \
            backend=${{ secrets.HARBOR_REGISTRY }}/platform/backend:${{ github.sha }} \
            -n platform
          kubectl annotate ingress backend-ingress -n platform \
            nginx.ingress.kubernetes.io/canary="false" --overwrite
```

---

### P2.2 GitOps with Flux v2

**File:** `.github/workflows/gitops-sync.yml`

```yaml
name: GitOps Flux Sync

on:
  push:
    branches: [main]
    paths:
      - 'k8s/**'
      - 'helm/**'

jobs:
  flux-reconcile:
    name: Trigger Flux Reconciliation
    runs-on: ubuntu-latest

    steps:
      - name: Connect to NetBird mesh
        run: |
          curl -fsSL https://pkgs.netbird.io/install.sh | sh
          netbird up --setup-key ${{ secrets.NETBIRD_SETUP_KEY }} --management-url https://netbird.platform.internal
          sleep 10

      - name: Configure kubeconfig
        run: |
          mkdir -p ~/.kube
          echo "${{ secrets.KUBECONFIG_B64 }}" | base64 -d > ~/.kube/config
          chmod 600 ~/.kube/config

      - name: Install Flux CLI
        run: curl -s https://fluxcd.io/install.sh | sudo bash

      - name: Force Flux reconciliation
        run: |
          flux reconcile kustomization platform --with-source
          flux reconcile kustomization platform-services --with-source

      - name: Wait for Flux to complete
        run: |
          flux get kustomizations --watch --timeout=5m
```

---

### P2.3 Security Scanning (SAST & DAST)

**File:** `.github/workflows/security-scanning.yml`

```yaml
name: Security Scanning

on:
  schedule:
    - cron: '0 2 * * 1'   # Every Monday at 02:00 UTC
  push:
    branches: [main]

jobs:
  sast:
    name: SAST (Semgrep)
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
      - uses: returntocorp/semgrep-action@v1
        with:
          config: >-
            p/default
            p/nodejs
            p/owasp-top-ten
          generateSarif: '1'

      - name: Upload SARIF to GitHub Security
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: semgrep.sarif

  dependency-audit:
    name: Dependency Audit
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4

      - name: Audit backend dependencies
        working-directory: backend
        run: npm audit --audit-level=high

      - name: Audit frontend admin dependencies
        working-directory: frontend/admin-panel
        run: npm audit --audit-level=high

      - name: Audit frontend client dependencies
        working-directory: frontend/client-panel
        run: npm audit --audit-level=high

  trivy-repo-scan:
    name: Trivy Repository Scan
    runs-on: ubuntu-latest

    steps:
      - uses: actions/checkout@v4
      - uses: aquasecurity/trivy-action@master
        with:
          scan-type: 'fs'
          scan-ref: '.'
          format: 'sarif'
          output: 'trivy-results.sarif'
          severity: 'CRITICAL,HIGH'

      - name: Upload Trivy SARIF
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: trivy-results.sarif
```

---

## Ongoing Development CI/CD

### Continuous Deployment Policy

**After Phase 1 (Week 13+):**

- All merges to `main` branch trigger automatic deploy to dev environment
- Dev deploy runs smoke tests; failure blocks the deploy and notifies Slack
- Production deploys remain **manual** (`workflow_dispatch`) until Phase 2 canary is proven stable
- Production deploys require 1 Environment Approver (configured in GitHub Settings → Environments → production)
- All production deploys include `reason` in the dispatch input — written to commit message for audit trail

### Deployment Frequency Targets

| Phase | Frequency | Strategy | Risk |
|-------|-----------|----------|------|
| **Phase 1** | 2x/week | Manual staging→prod | High |
| **Phase 1.5** | 5x/week | Auto to staging, manual to prod | Medium |
| **Phase 2+** | 10x/week | Auto to staging, canary to prod | Low |
| **Mature** | 20+x/week | Full CI/CD, auto canary→prod | Very Low |

---

## Monitoring & Observability

### CI/CD Metrics Dashboard

**Track in Prometheus + Grafana:**

| Metric | Source | Alert Threshold |
|--------|--------|-----------------|
| Pipeline success rate (7d) | GitHub Actions API → Prometheus exporter | < 90% → warning |
| Mean build duration (backend CI) | GitHub Actions API | > 12 min → warning |
| Mean deploy duration (staging) | GitHub Actions API | > 8 min → warning |
| Deployment frequency (deploys/week) | GitHub Actions API | < 1/week → warning |
| Failed production deploys (30d) | GitHub Actions API | > 0 → alert |
| Test coverage (backend) | Codecov API | < 60% → warning |

Grafana dashboard: **Platform Operations → CI/CD Overview** (import from `k8s/base/grafana/dashboards/cicd.json`).

### Deployment Log Tracking

**File:** `.github/workflows/log-metrics.yml`

```yaml
name: Log Deploy Metrics

on:
  workflow_run:
    workflows: ["Deploy to Staging", "Deploy to Production"]
    types: [completed]

jobs:
  log-metrics:
    runs-on: ubuntu-latest
    steps:
      - name: Send metrics to Prometheus Pushgateway
        run: |
          RESULT="${{ github.event.workflow_run.conclusion }}"
          WORKFLOW="${{ github.event.workflow_run.name }}"
          DURATION=$(( $(date -d "${{ github.event.workflow_run.updated_at }}" +%s) - \
                        $(date -d "${{ github.event.workflow_run.created_at }}" +%s) ))
          cat <<EOF | curl -s --data-binary @- \
            http://pushgateway.platform.internal:9091/metrics/job/github_actions
          # TYPE github_deploy_duration_seconds gauge
          github_deploy_duration_seconds{workflow="${WORKFLOW}",result="${RESULT}"} ${DURATION}
          EOF
```

---

## Security & Compliance

### Secrets Management

**GitHub Secrets Required:**

| Secret | Scope | Rotation |
|--------|-------|----------|
| `KUBECONFIG_B64` | Repository | When k3s cluster cert rotates (90 days) |
| `STAGING_KUBECONFIG_B64` | Repository | When staging cluster cert rotates |
| `HARBOR_USERNAME` | Repository | Monthly |
| `HARBOR_PASSWORD` | Repository | Monthly |
| `HARBOR_REGISTRY` | Repository | Rarely (registry URL change only) |
| `NETBIRD_SETUP_KEY` | Repository | Quarterly (reusable key) |
| `SLACK_WEBHOOK_URL` | Repository | If Slack app is reinstalled |
| `CODECOV_TOKEN` | Repository | Annually or on compromise |
| `HCLOUD_TOKEN` | Repository | Quarterly |
| `DB_MIGRATION_URL` | Repository | On DB password rotation |

**Best Practices:**

- Never commit secrets to git
- Use GitHub Secrets for all credentials
- Rotate secrets on the schedule above
- Audit secret access in GitHub audit log: **Org Settings → Audit log → filter: action:secret**
- Use machine accounts (robot accounts) for CI/CD — not personal tokens
- Revoke secrets for departed team members within 24 hours

### RBAC & Access Control

| Role | Permissions |
|------|-------------|
| **Admin** | Full repo access, can approve production deploys, can manage secrets |
| **Maintainer** | Merge PRs to staging, trigger staging deploys, read secrets (not write) |
| **Developer** | Push to feature branches, open PRs, read CI logs |
| **CI Bot** | Write access to `k8s/overlays/**` only (for manifest commit-back) |

GitHub Environment protection for `production`:
- Required reviewers: list 1-2 team leads
- Deployment branches: `main` only
- Wait timer: 0 minutes (approval is the gate)

---

## Troubleshooting & Rollback

### Common CI/CD Issues

| Issue | Symptom | Resolution | Phase |
|-------|---------|-----------|-------|
| **Flaky tests** | Tests fail randomly | Add retry logic, increase timeout | 1.5 |
| **Slow builds** | Build takes > 15 min | Cache dependencies, parallel jobs | 1.5 |
| **Memory leaks** | OOM errors in tests | Profile code, increase runner memory | 2 |
| **Deployment conflicts** | Multiple deploys queued | Queue deployments, lock mechanism | 2 |
| **Secret rotation** | Old token still in use | Rotate monthly, audit access | 1 |
| **Failed health checks** | Deployment hangs | Increase timeout, improve checks | 1.5 |
| **Harbor push fails** | `unauthorized: authentication required` | Rotate `HARBOR_PASSWORD` secret | 1 |
| **NetBird mesh timeout** | kubectl: connection refused | Check NetBird setup key is valid, re-enroll runner | 1 |
| **Flux not reconciling** | Manifest updated but deploy stalled | Run `flux reconcile kustomization platform --with-source` | 2 |

### Rollback Procedures

**Automatic Rollback:**

The production deploy workflow (`P1.5`) includes an automatic rollback step: if the smoke test fails after deployment, the workflow reverts the manifest to the previous image tag and pushes the commit — Flux picks it up within 5 minutes.

**Manual Rollback:**

```bash
# 1. Find the last known-good commit
git log k8s/overlays/production/ --oneline

# 2. Revert the manifest to a prior image tag
git revert <bad-commit-sha>
git push origin main
# Flux reconciles within 5 minutes

# 3. Or: directly patch the deployment image (immediate, bypasses Flux)
kubectl set image deployment/backend-api \
  backend=harbor.platform.internal/platform/backend:<good-sha> \
  -n platform
# Then update the manifest to match (so Flux doesn't revert your change)
```

**Emergency stop (suspend Flux):**

```bash
# Stop Flux from reconciling while you investigate
flux suspend kustomization platform
kubectl set image deployment/backend-api backend=<safe-image> -n platform
# After investigation:
flux resume kustomization platform
```

### Post-Incident Review

After any failed deployment:

1. Check workflow logs: `gh run view <run-id> --log-failed`
2. Check pod events: `kubectl describe pod -l app=backend-api -n platform`
3. Check application logs: `kubectl logs -l app=backend-api -n platform --previous`
4. Check Loki for errors: Grafana → Explore → `{namespace="platform", app="backend-api"} |= "error"`
5. Write a brief incident note in the relevant GitHub Issue
6. If smoke test triggered rollback: verify rollback succeeded with `kubectl get deployment backend-api -n platform -o jsonpath='{.spec.template.spec.containers[0].image}'`

---

## Summary: CI/CD Maturity Levels

### Phase 1: MVP (Weeks 1-12)
- Basic CI (lint, test, build) — `ci-backend.yml`, `ci-frontend.yml`
- Manual deployments to staging after CI passes — `deploy-staging.yml`
- Manual deployments to production (workflow_dispatch + approval) — `deploy-production.yml`
- Smoke test + automatic rollback on production failures

### Phase 1.5: Enhanced (Week 13+)
- Automated staging deployments
- Database migration testing — `db-migration-test.yml`
- Load testing — `load-test.yml`
- Performance benchmarking in CI
- Improved monitoring (Pushgateway metrics)

### Phase 2: Advanced (Weeks 14-16)
- Canary deployments — `deploy-canary.yml`
- GitOps (Flux v2) — `gitops-sync.yml`
- Security scanning (SAST/DAST) — `security-scanning.yml`
- Automated rollbacks based on error rate monitoring

### Phase 3+: Mature
- Fully automated deployments
- Multi-region deployments
- Blue-green deployments
- Chaos engineering
- FinOps integration
- Full observability (OpenTelemetry)

---

**Status:** Complete CI/CD specification ready for implementation
