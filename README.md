# K8s Hosting Platform

Kubernetes-based web hosting platform replacing Plesk. Runs on self-managed k3s clusters (Hetzner VPS), targeting 50-100 clients initially at under $200/month infrastructure cost.

## Architecture

```
                         ┌─────────────────────────────────────────────┐
                         │              Hetzner VPS Cluster            │
                         │                                             │
   Internet ──► 80/443 ──┤  ┌──────────────┐    ┌──────────────────┐  │
                         │  │ NGINX Ingress │───►│ Client Workloads │  │
                         │  │  (DaemonSet)  │    │  (per-namespace) │  │
                         │  └──────────────┘    └──────────────────┘  │
                         │                                             │
                         │  ┌──────────────┐    ┌──────────────────┐  │
                         │  │  Management   │    │    MariaDB +     │  │
                         │  │  API (Fastify)│───►│  Redis (shared)  │  │
                         │  └──────────────┘    └──────────────────┘  │
                         │                                             │
                         │  ┌──────────────┐    ┌──────────────────┐  │
                         │  │ Admin Panel   │    │  Monitoring      │  │
                         │  │ Client Panel  │    │  (Prometheus +   │  │
                         │  │ (React/Vite)  │    │   Grafana + Loki)│  │
                         │  └──────────────┘    └──────────────────┘  │
                         └─────────────────────────────────────────────┘
                                          │
                          ┌───────────────┼───────────────┐
                          ▼               ▼               ▼
                    ┌──────────┐   ┌──────────┐   ┌──────────┐
                    │ PowerDNS │   │  NetBird  │   │ Dex OIDC │
                    │ (DNS API)│   │ (VPN mesh)│   │  (Auth)  │
                    └──────────┘   └──────────┘   └──────────┘
                         External services (separate infra project)
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| Kubernetes | k3s + Calico CNI + NGINX Ingress |
| Backend | Node.js 22, Fastify 4, TypeScript 5, Drizzle ORM |
| Database | MariaDB 10.6+ (primary), Redis 7 (cache) |
| Frontend | React 18, Vite, Tailwind CSS, shadcn/ui |
| State | TanStack Query (server), Zustand (client) |
| Auth | External Dex OIDC + JWT Bearer tokens |
| Secrets | Sealed Secrets (GitOps-friendly) |
| CI/CD | GitHub Actions + Flux v2 |
| TLS | cert-manager + Let's Encrypt |
| Monitoring | Prometheus + Grafana + Loki |

### External Services (ADR-022)

DNS (PowerDNS), VPN mesh (NetBird), and IAM (Dex OIDC) are managed by a separate infrastructure project. This platform consumes their APIs.

## Repository Structure

```
backend/                  # Node.js/Fastify management API (port 3000)
frontend/
  admin-panel/            # React admin UI (port 5173)
  client-panel/           # React client UI (port 5174)
k8s/
  base/                   # Kustomize base manifests
  overlays/               # staging, production overlays
terraform/                # Hetzner VPS provisioning
catalog-images/           # Dockerfiles for workload types (nginx, apache, node, wordpress)
scripts/                  # bootstrap.sh, provision, install scripts
docs/                     # Architecture docs, ADRs, specs
```

## Server Deployment

### One-Command Bootstrap

SSH into a fresh **Debian 12+** or **Ubuntu 22.04+** server and run:

```bash
curl -fsSL https://raw.githubusercontent.com/phoenixtechnam/k8s-hosting-platform/main/scripts/bootstrap.sh | bash
```

Or clone first:

```bash
git clone https://github.com/phoenixtechnam/k8s-hosting-platform.git
cd k8s-hosting-platform
./scripts/bootstrap.sh
```

This installs and configures everything in one pass:

1. **Server hardening** - SSH lockdown, nftables firewall, fail2ban
2. **k3s + Calico CNI** - Kubernetes cluster with network policy enforcement
3. **Platform components** - NGINX Ingress, cert-manager (Let's Encrypt), Sealed Secrets, Prometheus/Grafana/Loki, Flux v2
4. **Platform manifests** - Namespaces, RBAC, network policies, resource quotas

### Options

```bash
./scripts/bootstrap.sh --skip-monitoring   # Save RAM on small servers
./scripts/bootstrap.sh --skip-flux         # Skip GitOps controller
./scripts/bootstrap.sh --skip-hardening    # Skip if SSH/firewall already done
```

### Adding Worker Nodes

On the control plane, get the join token:

```bash
cat /var/lib/rancher/k3s/server/node-token
```

On the worker node:

```bash
./scripts/bootstrap.sh --role worker --server <CONTROL_PLANE_IP> --token <TOKEN>
```

Workers get the same security hardening but only install k3s as an agent. Platform components run on the control plane only.

### Post-Bootstrap: Remote kubectl Access

```bash
scp root@<SERVER_IP>:/etc/rancher/k3s/k3s.yaml ./kubeconfig.yaml
sed -i "s/127.0.0.1/<SERVER_IP>/g" kubeconfig.yaml
export KUBECONFIG=./kubeconfig.yaml
kubectl get nodes
```

## Local Development

### Prerequisites

- Node.js 22+
- Docker + Docker Compose (for MariaDB, Redis)

### Setup

```bash
git clone https://github.com/phoenixtechnam/k8s-hosting-platform.git
cd k8s-hosting-platform
npm install
docker compose up -d          # Start MariaDB + Redis
```

### Development Servers

```bash
npm run dev -w backend                    # API on port 3000
npm run dev -w @k8s-hosting/admin-panel   # Admin UI on port 5173
npm run dev -w @k8s-hosting/client-panel  # Client UI on port 5174
```

### Testing

```bash
npm run test -w backend                    # Backend unit tests
npm run test:integration -w backend        # Integration tests (requires DB)
npm run test -w @k8s-hosting/admin-panel   # Admin panel tests
npm run test -w @k8s-hosting/client-panel  # Client panel tests
```

### Linting & Type Checking

```bash
npm run lint -w backend
npm run typecheck -w backend
npm run lint -w @k8s-hosting/admin-panel
npm run typecheck -w @k8s-hosting/admin-panel
```

## CI/CD

GitHub Actions run on every push to `main`/`staging`:

| Workflow | Checks |
|----------|--------|
| Backend CI | Lint, typecheck, unit tests, integration tests (MariaDB + Redis), coverage |
| Admin Panel CI | Lint, typecheck, tests, build |
| Client Panel CI | Lint, typecheck, tests, build |
| Infrastructure CI | Terraform validate, Kustomize build, shellcheck, Docker build |

## Documentation

| Document | Location |
|----------|----------|
| Architecture | `docs/01-core/PLATFORM_ARCHITECTURE.md` |
| Database Schema | `docs/01-core/DATABASE_SCHEMA.md` |
| API Spec | `docs/04-deployment/MANAGEMENT_API_SPEC.md` |
| Error Handling | `docs/04-deployment/API_ERROR_HANDLING.md` |
| Phase 1 Roadmap | `docs/04-deployment/PHASE_1_ROADMAP.md` |
| ADRs | `docs/07-reference/ARCHITECTURE_DECISION_RECORDS.md` |

## License

Private repository.
