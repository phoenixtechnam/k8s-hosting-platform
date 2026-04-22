# CLAUDE.md — Kubernetes Web Hosting Platform

## Project Overview

Kubernetes-based web hosting platform replacing Plesk. Targets 50-100 clients initially on self-managed k3s clusters (Hetzner VPS, <$200/month budget).

**Status:** Phase 1 implementation (12-week MVP)

## Monorepo Structure

```
packages/
  api-contracts/          # Shared Zod schemas + TypeScript types (SINGLE SOURCE OF TRUTH)
backend/                  # Node.js/Fastify management API (port 3000)
frontend/
  admin-panel/            # React 18 + Vite + shadcn/ui (port 5173)
  client-panel/           # React 18 + Vite + shadcn/ui (port 5174)
k8s/
  base/                   # Kustomize base manifests
  overlays/               # dev, production overlays
scripts/                  # Utility scripts
docs/                     # Architecture docs, ADRs, specs (read-only reference)
```

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Backend | Node.js 22 + Fastify 4 + TypeScript 5 |
| ORM | Drizzle ORM (MariaDB dialect) |
| Database | MariaDB 10.6+ (primary), Redis 7 (cache) |
| Frontend | React 18 + Vite + TypeScript + Tailwind CSS + shadcn/ui |
| State | TanStack Query (server), Zustand (client) |
| Testing | Vitest + React Testing Library + Playwright |
| Auth | External Dex OIDC + JWT (Bearer tokens) |
| CI/CD | GitHub Actions + Flux v2 |
| Container Registry | GHCR (Phase 1), Harbor (Phase 2) |
| K8s | k3s + Calico CNI + NGINX Ingress |

## Build & Dev Commands

### Backend (`backend/`)
```bash
npm run dev              # Start dev server with hot-reload
npm run build            # TypeScript compile
npm run lint             # ESLint
npm run typecheck        # tsc --noEmit
npm run test             # Vitest (all tests)
npm run test:unit        # Unit tests only
npm run test:integration # Integration tests (requires DB)
npm run db:migrate       # Run database migrations
npm run db:generate      # Generate migration from schema changes
```

### Smoke Tests (after deploy)
```bash
./scripts/smoke-test.sh          # Run against local stack
```

### Frontend Admin (`frontend/admin-panel/`)
```bash
npm run dev              # Vite dev server (port 5173)
npm run build            # Production build
npm run lint             # ESLint
npm run typecheck        # tsc --noEmit
npm run test             # Vitest
```

### Frontend Client (`frontend/client-panel/`)
```bash
npm run dev              # Vite dev server (port 5174)
npm run build            # Production build
npm run lint             # ESLint
npm run typecheck        # tsc --noEmit
npm run test             # Vitest
```

### Local Development (Docker Compose)
```bash
docker compose up -d     # Start MariaDB, Redis, MailHog
docker compose down      # Stop services
```

## Shared API Contracts (CRITICAL)

**All API types are defined in `packages/api-contracts/`** — the single source of truth.

```
packages/api-contracts/src/
  shared.ts           # PaginationParams (limit max: 100), response envelopes
  auth.ts             # Login, password change, profile update schemas
  clients.ts          # Client CRUD schemas + response types
  domains.ts          # Domain CRUD schemas + response types
  databases.ts        # Database CRUD schemas + response types
  workload-repos.ts   # Workload catalog repository management (ADR-025)
  container-images.ts # Container image definitions synced from catalog repos
  sftp-users.ts       # SFTP user CRUD, connection info, audit log schemas
  index.ts            # Re-exports everything
```

**Rules:**
1. ALL API input/output types MUST be defined in `@k8s-hosting/api-contracts`
2. Backend validates with Zod schemas imported from this package
3. Frontend uses `z.infer<typeof schema>` types from this package
4. NEVER define API types locally in backend `schema.ts` or frontend `types/api.ts`
5. `PaginationParams` enforces `limit <= 100` — frontends import MAX_PAGE_LIMIT
6. Response field names are camelCase (Drizzle ORM convention)
7. `apiFetch` only sets `Content-Type: application/json` when `options.body` exists

**After deploy, run `./scripts/smoke-test.sh` to verify API compatibility.**

## Conventions

- **API prefix:** `/api/v1/`
- **API response envelope:** `{ data, pagination, error }` (see docs/04-deployment/API_ERROR_HANDLING.md)
- **Pagination:** Cursor-based, limit max 100 (enforced by `MAX_PAGE_LIMIT` in api-contracts)
- **Error codes:** SCREAMING_SNAKE_CASE (see docs/04-deployment/API_ERROR_HANDLING.md)
- **Auth:** JWT Bearer tokens with claims: sub, role (admin|billing|support|read-only), exp, iat
- **File organization:** Feature/module-based (`backend/src/modules/<feature>/`)
- **Immutability:** Prefer new objects over mutation
- **Test coverage target:** 80%+ (Phase 1: 70%+)

## Admin-only UIs (Longhorn, Stalwart, future)

Every Ingress that exposes an admin-only web UI (Longhorn dashboard, Stalwart web-admin, etc.) MUST:

1. Be labelled `platform.phoenix-host.net/admin-ui: "true"` on `metadata.labels`
2. Be included via an overlay that lists exactly one of these Kustomize components:
   - `k8s/components/admin-auth-gate-cookie` → gate by `platform_session` cookie
   - `k8s/components/admin-auth-gate-oauth2` → gate by oauth2-proxy + Dex OIDC

The choice is per-overlay. When oauth2-proxy is enabled for the admin panel, switch the overlay to `admin-auth-gate-oauth2` — every admin-only UI will pick up the oauth2 gate simultaneously.

`./scripts/ci-admin-auth-check.sh` (wired into Infrastructure CI) fails the build if an Ingress has the admin-ui label but no gate annotation.

## External Dependencies (ADR-022, ADR-025, ADR-026)

These services are managed by **separate projects** — this platform consumes their APIs:
- **DNS:** PowerDNS REST API (ADR-022)
- **VPN Mesh:** NetBird (ADR-022)
- **IAM/Auth:** Dex OIDC provider (ADR-022)
- **Workload Catalog:** Composable runtimes/databases/services via `manifest.json` (ADR-025) — default: `https://github.com/phoenixtechnam/hosting-platform-workload-catalog`
- **Application Catalog:** Managed app stacks via Helm charts (ADR-026, Phase 2) — `https://github.com/phoenixtechnam/hosting-platform-application-catalog`

**Two catalogs (ADR-026):** Workloads = composable building blocks (generic PHP, Node.js, MariaDB). Applications = self-contained managed stacks (WordPress, Nextcloud, Jitsi). Workloads share databases; applications bundle their own.

## Key Documentation

- Architecture: `docs/01-core/PLATFORM_ARCHITECTURE.md`
- Database schema: `docs/01-core/DATABASE_SCHEMA.md`
- API spec: `docs/04-deployment/MANAGEMENT_API_SPEC.md`
- Error handling: `docs/04-deployment/API_ERROR_HANDLING.md`
- Pagination: `docs/04-deployment/API_PAGINATION_STRATEGY.md`
- Phase 1 roadmap: `docs/04-deployment/PHASE_1_ROADMAP.md`
- ADRs: `docs/07-reference/ARCHITECTURE_DECISION_RECORDS.md`
