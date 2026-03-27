# Quick Start Guide - Kubernetes Web Hosting Platform

> **Start here if you're new to the platform**

Welcome! This guide will help you navigate the documentation and find what you need quickly.

---

## 🎯 What Is This Project?

A **Kubernetes-based web hosting platform** that replaces Plesk with:
- Automated client onboarding and resource management
- Multi-tenant architecture with flexible pricing tiers
- Integrated backup, monitoring, and disaster recovery
- Support for multiple hosting plans and applications
- Migration path from Plesk, cPanel, Virtualmin

**Status:** Complete planning phase, ready for Phase 0 implementation
**Team Size:** 1-2 engineers
**Timeline:** No hard deadline
**Budget:** < $200/month for initial cluster (50-100 clients)
**Cluster:** Single-node k3s, expanding to HA as the business grows

> **Note (ADR-022):** DNS (PowerDNS), VPN mesh (NetBird), and IAM (Dex/OIDC) are **external services**
> provided by a separate infrastructure project. This platform consumes their APIs and exposes
> configuration in the admin panel. See `archived/` for outsourced documentation.

---

## 📍 Where Should I Start?

### By Role

**👷 I'm a Solution Architect**
- [ ] Read: [PLATFORM_ARCHITECTURE.md](01-core/PLATFORM_ARCHITECTURE.md) - Core design
- [ ] Read: [INFRASTRUCTURE_SIZING.md](02-operations/INFRASTRUCTURE_SIZING.md) - Hardware & scaling
- [ ] Read: [SECURITY_ARCHITECTURE.md](03-security/SECURITY_ARCHITECTURE.md) - Security model
- [ ] Read: [DISASTER_RECOVERY.md](05-advanced/DISASTER_RECOVERY.md) - HA & DR strategy
- **Time: 2-3 hours**

**🔧 I'm a DevOps/SRE Engineer**
- [ ] Read: [INFRASTRUCTURE_SIZING.md](02-operations/INFRASTRUCTURE_SIZING.md) - Cluster setup
- [ ] Read: [BACKUP_STRATEGY.md](02-operations/BACKUP_STRATEGY.md) - Backup operations
- [ ] Read: [STORAGE_DATABASES.md](02-operations/STORAGE_DATABASES.md) - Storage & databases
- [ ] Read: [MONITORING_OBSERVABILITY.md](02-operations/MONITORING_OBSERVABILITY.md) - Observability
- [ ] Read: [CICD_PIPELINE_REQUIREMENTS.md](04-deployment/CICD_PIPELINE_REQUIREMENTS.md) - CI/CD setup
- **Time: 1.5-2 hours**

**👨‍💻 I'm a Developer**
- [ ] Read: [PLATFORM_ARCHITECTURE.md](01-core/PLATFORM_ARCHITECTURE.md) - Platform overview
- [ ] Read: [PHASE_1_ROADMAP.md](04-deployment/PHASE_1_ROADMAP.md) - Implementation timeline
- [ ] Read: [GITHUB_INTEGRATION_SUMMARY.md](04-deployment/GITHUB_INTEGRATION_SUMMARY.md) - GitHub setup
- [ ] Read: [CICD_PIPELINE_REQUIREMENTS.md](04-deployment/CICD_PIPELINE_REQUIREMENTS.md) - CI/CD pipeline
- [ ] Read: [CLIENT_PANEL_FEATURES.md](02-operations/CLIENT_PANEL_FEATURES.md) - UI features
- **Time: 1-1.5 hours**

**📊 I'm a Project Manager**
- [ ] Read: [PHASE_1_ROADMAP.md](04-deployment/PHASE_1_ROADMAP.md) - Implementation timeline
- [ ] Read: [TECH_STACK_SUMMARY.md](07-reference/TECH_STACK_SUMMARY.md) - Technology overview
- [ ] Read: [FAQ.md](07-reference/FAQ.md) - Common questions
- **Time: 30 minutes**

### By Topic

**I want to understand the overall platform**
→ [PLATFORM_ARCHITECTURE.md](01-core/PLATFORM_ARCHITECTURE.md)

**I want to know about hosting plans**
→ [HOSTING_PLANS.md](01-core/HOSTING_PLANS.md)

**I want to understand backup operations**
→ [BACKUP_STRATEGY.md](02-operations/BACKUP_STRATEGY.md)

**I want to see the implementation roadmap**
→ [PHASE_1_ROADMAP.md](04-deployment/PHASE_1_ROADMAP.md)

**I want to set up GitHub**
→ [GITHUB_INTEGRATION_SUMMARY.md](04-deployment/GITHUB_INTEGRATION_SUMMARY.md)

**I want security and compliance details**
→ [SECURITY_ARCHITECTURE.md](03-security/SECURITY_ARCHITECTURE.md)

**I want to know about disaster recovery**
→ [DISASTER_RECOVERY.md](05-advanced/DISASTER_RECOVERY.md)

**I need to look up a term**
→ [TERMINOLOGY.md](07-reference/TERMINOLOGY.md)

---

## 📚 Documentation Structure

```
01-core/              Platform design & architecture (11 files)
  ├── PLATFORM_ARCHITECTURE.md    Core design decisions, catalogs, diagrams
  ├── HOSTING_PLANS.md            Plan tier definitions & features
  ├── WORKLOAD_DEPLOYMENT.md      Deployment models & scaling
  ├── SHARED_POD_IMPLEMENTATION.md  Superseded by ADR-024 (historical reference)
  ├── DATABASE_SCHEMA.md          Complete database schema
  ├── DEPENDENCIES_AND_RISKS.md   Dependencies & risk analysis
  ├── EXTERNAL_BILLING_INTEGRATION.md  Billing gateway integration
  ├── BILLING_MODEL_CHANGES.md    Billing model evolution
  ├── DNS_MODE_SELECTION.md       DNS mode guide (Primary/CNAME/Secondary)
  ├── DNS_ZONE_TEMPLATES.md       DNS zone template system
  └── WEB_SERVER_PHP_VERSION_SWITCHING.md  Web server/PHP switching

02-operations/        Day-to-day operations & management (16 files)
  ├── INFRASTRUCTURE_SIZING.md    Cluster sizing, costs, optimization
  ├── BACKUP_STRATEGY.md          Backup types, scheduling, quotas
  ├── BACKUP_INFRASTRUCTURE_IMPLEMENTATION.md  Backup implementation details
  ├── BACKUP_EXPORT_MIGRATION_GUIDE.md  Backup export & migration
  ├── STORAGE_DATABASES.md        Storage, MariaDB, PostgreSQL, Redis
  ├── MONITORING_OBSERVABILITY.md Metrics, dashboards, alerts
  ├── CACHING_STRATEGY.md         Caching architecture
  ├── EVENT_LOGGING_STRATEGY.md   Event logging design
  ├── SLI_SLO_DEFINITION.md       SLI/SLO definitions
  ├── TESTING_STRATEGY.md         Testing approach & coverage
  ├── ADMIN_PANEL_REQUIREMENTS.md Admin panel 100+ features
  ├── CLIENT_PANEL_FEATURES.md    Client UI & self-service
  ├── CLUSTER_MAINTENANCE_AND_UPGRADES.md  Cluster maintenance
  ├── HA_MIGRATION_RUNBOOK.md     HA migration procedures
  ├── NODE_RUNTIME_SPECIFICATION.md  Node.js runtime spec
  └── REQUIREMENTS_UPDATE_SUMMARY.md  Requirements changelog

03-security/          Security & compliance (6 files)
  ├── SECURITY_ARCHITECTURE.md    Auth, RBAC, secrets, WAF
  ├── COMPLIANCE_MATRIX.md        GDPR, PCI-DSS, SOC 2
  ├── AUTHORIZATION_MATRIX.md     Role-based authorization rules
  ├── SECRETS_MANAGEMENT.md       Secrets management strategy
  ├── DATABASE_ACCESS_CONTROL.md  Database user roles & privileges
  └── TLS_CERTIFICATE_MANAGEMENT.md  TLS/SSL certificate strategy

04-deployment/        CI/CD, deployment, infrastructure (13 files)
  ├── CICD_PIPELINE_REQUIREMENTS.md   Complete CI/CD spec
  ├── DEPLOYMENT_PROCESS.md           Harbor, Trivy, Flux v2
  ├── PHASE_1_ROADMAP.md              Week-by-week plan
  ├── GITHUB_INTEGRATION_SUMMARY.md   GitHub setup
  ├── MANAGEMENT_API_SPEC.md          Management API specification
  ├── K3S_DEPLOYMENT_GUIDE.md         k3s cluster setup
  ├── FRESH_INFRASTRUCTURE_PLAN.md    Fresh infrastructure deployment
  ├── FRONTEND_DEPLOYMENT_ARCHITECTURE.md  Frontend deployment
  ├── FRONTEND_INGRESS_CONFIGURATIONS.md   Frontend ingress configs
  ├── API_ERROR_HANDLING.md           API error handling patterns
  ├── API_PAGINATION_STRATEGY.md      API pagination design
  ├── INCIDENT_RESPONSE_RUNBOOK.md    Incident response procedures
  └── SUBSCRIPTION_EXPIRY_NOTIFICATIONS.md  Subscription notifications

05-advanced/          HA, DR, scaling, multi-cloud (6 files)
  ├── DISASTER_RECOVERY.md           HA strategy, failover, testing
  ├── GEOGRAPHIC_SHARDING_SUMMARY.md Multi-region deployment
  ├── MULTI_CLOUD_STRATEGY.md        Multi-cloud & multi-provider
  ├── CONFLICT_RESOLUTION_MATRIX.md  Database conflict resolution
  ├── IPV4_IPV6_REQUIREMENTS.md      Networking requirements
  └── MULTI_REGION_ADMIN_AND_COHOSTING.md  Multi-region admin & co-hosting

06-features/          Feature specifications (16 files)
  ├── APPLICATION_CATALOG.md          App catalog (Moodle, Jitsi, etc.)
  ├── RESTORE_SPECIFICATION.md        Granular backup restore
  ├── EMAIL_SERVICES.md               Email architecture
  ├── EMAIL_ENHANCEMENTS_SPECIFICATION.md  DKIM, DMARC, autodiscover
  ├── EMAIL_SENDING_LIMITS_AND_MONITORING.md  Email rate limiting
  ├── EMAIL_DELIVERABILITY.md         IP pools, PTR, warm-up
  ├── WEBMAIL_ACCESS_SPECIFICATION.md Roundcube multi-domain
  ├── MAILBOX_IMPORT_EXPORT_SPECIFICATION.md  Mailbox import/export
  ├── FILE_TRANSFER_FTP_SFTP_SPECIFICATION.md  SFTP/FTP access
  ├── CUSTOMER_CRON_JOBS.md           Customer cron jobs
  ├── DATABASE_MANAGEMENT_UI_SPECIFICATION.md  Database management UI
  ├── HOSTING_SETTINGS_SPECIFICATION.md  Hosting settings
  ├── PASSWORD_PROTECTED_DIRECTORIES.md  Password-protected dirs
  ├── PHP_COMPOSER_SUPPORT.md         PHP Composer support
  ├── WEB_APPLICATION_FIREWALL_SPECIFICATION.md  WAF (ModSecurity)
  └── AI_WEBSITE_EDITOR.md            AI website editor

07-reference/         Reference materials (7 files)
  ├── TECH_STACK_SUMMARY.md           All technologies at a glance
  ├── TERMINOLOGY.md                  Glossary & definitions
  ├── MIGRATION_PLAN.md               Plesk/cPanel migration strategy
  ├── FAQ.md                          Common questions
  ├── ARCHITECTURE_DECISION_RECORDS.md  ADRs
  ├── IMPLEMENTATION_ANALYSIS_AND_RECOMMENDATIONS.md  Analysis
  └── MARIADB_MIGRATION_SUMMARY.md    MariaDB migration notes

08-admin-panel-mockups/  UI mockups & design system (5 files)
  ├── ADMIN_PANEL_MOCKUP_GUIDE.md     Mockup overview
  ├── KEY_PAGES_SPECIFICATION.md      Page specifications
  ├── INTERACTIVE_MOCKUP_GUIDE.md     Interactive mockup guide
  ├── FILE_MANIFEST.md                File manifest
  └── README.md                       Mockup README
```

---

## Known Documentation Gaps

The following topics are not yet covered by dedicated documentation and should be addressed during implementation:

- **Audit logging strategy** — What events are logged, retention policies, access patterns
- **Rate limiting architecture** — Consolidated view across API, email, and fail2ban layers
- **Customer lifecycle management** — Full onboarding → upgrade → suspension → deletion workflow
- **API versioning strategy** — Backward compatibility, deprecation process
- **Load testing & capacity planning** — Stress test procedures, performance baselines
- **Secrets rotation** — Automated key rotation procedures
- **Staging/pre-prod environment** — Test cluster setup and blue-green deployment

---

## 🎓 Key Concepts

### **Tenancy Models**
- **Single-tenant:** Each customer gets isolated instance (Moodle, Keycloak, etc.)
- **Multi-tenant:** One shared instance serves multiple customers (Nextcloud, Gitea)

### **Hosting Plans (ADR-024: dedicated pods for all)**
- **Starter:** Dedicated pod, resource-limited (~$5-8/mo)
- **Business:** Dedicated pod, higher limits (~$15-25/mo)
- **Premium:** Dedicated pod + database/cache, WAF, support (~$40-60/mo)

### **Backup Strategy**
- **Cluster Backups:** Platform-managed, free to customers
- **Customer Backups:** User-created, counted toward disk quota

### **Workload Model**
- **Dedicated Pods:** One pod per client in `client-{id}` namespace (all plans)
- **Scale-to-Zero:** Pods scale down when idle (KEDA, optional)
- **Plan Upgrades:** ResourceQuota edits, no pod migration

---

## 💡 Key Decisions (Locked In)

✅ **K8s Distribution:** k3s (lightweight, perfect for VPS)  
✅ **Database Operators:** Percona for MariaDB, CloudNativePG for PostgreSQL  
✅ **GitOps:** Flux v2 (lightweight, Kubernetes-native)  
✅ **File Manager:** FileBrowser (lightweight, Go-based)  
✅ **Management API:** Node.js + Express/Fastify  
✅ **SLA:** 99.5% uptime (~4.3 hours downtime/month)  
✅ **Team Size:** 1-2 engineers  
✅ **On-Call:** Business hours only (no 24/7 initially)  
✅ **Scale Target:** 50-100 clients → 300+ at maturity  
✅ **Budget:** < $200/month for initial cluster  

---

## 🚀 What's Next?

### If you're starting implementation:
1. Read [PHASE_1_ROADMAP.md](04-deployment/PHASE_1_ROADMAP.md) - Week-by-week plan
2. Set up GitHub per [GITHUB_INTEGRATION_SUMMARY.md](04-deployment/GITHUB_INTEGRATION_SUMMARY.md)
3. Start Phase 0 - Foundation (K8s cluster setup)

### If you're reviewing the architecture:
1. Start with [PLATFORM_ARCHITECTURE.md](01-core/PLATFORM_ARCHITECTURE.md)
2. Deep-dive into your area (security, operations, deployment, etc.)
3. Check [FAQ.md](07-reference/FAQ.md) for common questions

### If you're troubleshooting/operating:
1. Check [MONITORING_OBSERVABILITY.md](02-operations/MONITORING_OBSERVABILITY.md)
2. See [BACKUP_STRATEGY.md](02-operations/BACKUP_STRATEGY.md) for backup issues
3. Refer to [DISASTER_RECOVERY.md](05-advanced/DISASTER_RECOVERY.md) for failover

---

## 📖 Need More Details?

- **Main architecture:** [PLATFORM_ARCHITECTURE.md](01-core/PLATFORM_ARCHITECTURE.md)
- **All admin panel features:** [ADMIN_PANEL_REQUIREMENTS.md](02-operations/ADMIN_PANEL_REQUIREMENTS.md)
- **Complete restore spec:** [RESTORE_SPECIFICATION.md](06-features/RESTORE_SPECIFICATION.md)
- **All technologies:** [TECH_STACK_SUMMARY.md](07-reference/TECH_STACK_SUMMARY.md)

---

## ❓ Have Questions?

Check [FAQ.md](07-reference/FAQ.md) or look up terms in [TERMINOLOGY.md](07-reference/TERMINOLOGY.md).

**Happy reading!** 📚
