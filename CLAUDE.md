# CLAUDE.md — Kubernetes Web Hosting Platform

## Project Overview

Kubernetes-based web hosting platform replacing Plesk. Targets 50-100 clients initially on self-managed k3s clusters (Hetzner VPS, <$200/month budget).

**Status:** Phase 1 implementation (12-week MVP)

## Monorepo Structure

```
backend/                  # Node.js/Fastify management API (port 3000)
frontend/
  admin-panel/            # React 18 + Vite + shadcn/ui (port 5173)
  client-panel/           # React 18 + Vite + shadcn/ui (port 5174)
k8s/
  base/                   # Kustomize base manifests
  overlays/               # staging, production overlays
terraform/                # Hetzner VPS provisioning
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

## Conventions

- **API prefix:** `/api/v1/`
- **API response envelope:** `{ data, pagination, error }` (see docs/04-deployment/API_ERROR_HANDLING.md)
- **Pagination:** Cursor-based (base64-encoded opaque cursors)
- **Error codes:** SCREAMING_SNAKE_CASE (see docs/04-deployment/API_ERROR_HANDLING.md)
- **Auth:** JWT Bearer tokens with claims: sub, role (admin|billing|support|read-only), exp, iat
- **File organization:** Feature/module-based (`backend/src/modules/<feature>/`)
- **Immutability:** Prefer new objects over mutation
- **Test coverage target:** 80%+ (Phase 1: 60%+)

## External Dependencies (ADR-022)

These services are managed by a **separate infrastructure project** — this platform consumes their APIs:
- **DNS:** PowerDNS REST API
- **VPN Mesh:** NetBird
- **IAM/Auth:** Dex OIDC provider

## Key Documentation

- Architecture: `docs/01-core/PLATFORM_ARCHITECTURE.md`
- Database schema: `docs/01-core/DATABASE_SCHEMA.md`
- API spec: `docs/04-deployment/MANAGEMENT_API_SPEC.md`
- Error handling: `docs/04-deployment/API_ERROR_HANDLING.md`
- Pagination: `docs/04-deployment/API_PAGINATION_STRATEGY.md`
- Phase 1 roadmap: `docs/04-deployment/PHASE_1_ROADMAP.md`
- ADRs: `docs/07-reference/ARCHITECTURE_DECISION_RECORDS.md`
