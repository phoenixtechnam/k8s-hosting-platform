# Server Infrastructure Plan — Navigation Index

> **Status:** Superseded by organized documentation
> **Note:** This file previously contained the full infrastructure plan (~285KB).
> The content has been reorganized into the `docs/` subdirectories below.

## Where to Find Everything

| Topic | Document |
|-------|----------|
| **Platform Architecture** | [01-core/PLATFORM_ARCHITECTURE.md](01-core/PLATFORM_ARCHITECTURE.md) |
| **Hosting Plans** | [01-core/HOSTING_PLANS.md](01-core/HOSTING_PLANS.md) |
| **Database Schema** | [01-core/DATABASE_SCHEMA.md](01-core/DATABASE_SCHEMA.md) |
| **Workload Deployment** | [01-core/WORKLOAD_DEPLOYMENT.md](01-core/WORKLOAD_DEPLOYMENT.md) |
| **Infrastructure Sizing** | [02-operations/INFRASTRUCTURE_SIZING.md](02-operations/INFRASTRUCTURE_SIZING.md) |
| **Storage & Databases** | [02-operations/STORAGE_DATABASES.md](02-operations/STORAGE_DATABASES.md) |
| **Backup Strategy** | [02-operations/BACKUP_STRATEGY.md](02-operations/BACKUP_STRATEGY.md) |
| **Monitoring** | [02-operations/MONITORING_OBSERVABILITY.md](02-operations/MONITORING_OBSERVABILITY.md) |
| **Security Architecture** | [03-security/SECURITY_ARCHITECTURE.md](03-security/SECURITY_ARCHITECTURE.md) |
| **Fresh Infrastructure Setup** | [04-deployment/FRESH_INFRASTRUCTURE_PLAN.md](04-deployment/FRESH_INFRASTRUCTURE_PLAN.md) |
| **K3s Deployment** | [04-deployment/K3S_DEPLOYMENT_GUIDE.md](04-deployment/K3S_DEPLOYMENT_GUIDE.md) |
| **CI/CD Pipeline** | [04-deployment/CICD_PIPELINE_REQUIREMENTS.md](04-deployment/CICD_PIPELINE_REQUIREMENTS.md) |
| **Disaster Recovery** | [05-advanced/DISASTER_RECOVERY.md](05-advanced/DISASTER_RECOVERY.md) |
| **Geographic Sharding** | [05-advanced/GEOGRAPHIC_SHARDING_SUMMARY.md](05-advanced/GEOGRAPHIC_SHARDING_SUMMARY.md) |
| **Multi-Region Admin** | [05-advanced/MULTI_REGION_ADMIN_AND_COHOSTING.md](05-advanced/MULTI_REGION_ADMIN_AND_COHOSTING.md) |

## Key Decisions (ADR-022)

DNS (PowerDNS), VPN mesh (NetBird), and IAM (Dex/OIDC) are **external services** managed by a separate infrastructure project. This hosting platform consumes their APIs. See [07-reference/ARCHITECTURE_DECISION_RECORDS.md](07-reference/ARCHITECTURE_DECISION_RECORDS.md).

## Quick Start

For implementation, start with [QUICKSTART.md](QUICKSTART.md) or jump to [04-deployment/PHASE_1_ROADMAP.md](04-deployment/PHASE_1_ROADMAP.md).
