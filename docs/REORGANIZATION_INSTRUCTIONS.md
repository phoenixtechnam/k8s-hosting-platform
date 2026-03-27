# Documentation Reorganization - Completion Instructions

> **Status: COMPLETED** (2026-03-24)
> All root-level files have been moved to subdirectories. Cross-references updated.
> Storage paths standardized to `/storage/customers/{id}/` per ADR-016.
> This file is retained for historical reference only.

## What Has Been Done ✅

1. **Directory structure created:**
   - `01-core/`, `02-operations/`, `03-security/`, `04-deployment/`, `05-advanced/`, `06-features/`, `07-reference/`

2. **QUICKSTART.md created:**
   - Entry point for all users
   - Navigation by role and topic
   - Located at: `./QUICKSTART.md`

## What Needs to Be Done (Manual Instructions)

### Step 1: Extract Core Architecture Files (2-3 hours)

#### 1.1 Create `01-core/PLATFORM_ARCHITECTURE.md` (40 KB)
- **Source:** INFRASTRUCTURE_PLAN.md sections 0-4 (lines 1-520)
- **Contents:**
  - Section 0: Architectural Decisions (0.1-0.8) - all tech decisions
  - Section 1: Overview & Goals (1.1-1.6) - purpose, success criteria, constraints
  - Section 2: Workload Container Catalog (2.1-2.8) - concept, structure, lifecycle
  - Section 3: Application Catalog (3.1-3.9) - concept, definitions, entries
  - Section 4: Architecture Diagrams (4.1-4.5) - service inventory, communication patterns

**How to extract:**
1. Open INFRASTRUCTURE_PLAN.md in editor
2. Select lines 1-520
3. Copy and paste into new file: `01-core/PLATFORM_ARCHITECTURE.md`
4. Add header: `# Platform Architecture - Kubernetes Web Hosting Platform`
5. Update internal references (section numbers → file names)

#### 1.2 Create `01-core/HOSTING_PLANS.md` (10 KB)
- **Source:** INFRASTRUCTURE_PLAN.md section 0.8 (lines 110-119) + referenced sections
- **Contents:**
  - Pricing model overview
  - Plan tier definitions (Starter, Business, Premium)
  - Resource allocations per plan
  - Feature matrix
  - Per-client overrides

#### 1.3 Create `01-core/WORKLOAD_DEPLOYMENT.md` (8 KB)
- **Source:** INFRASTRUCTURE_PLAN.md sections 2.3, 4.3-4.4, 5.2
- **Contents:**
  - Dedicated pod architecture (all plans, ADR-024)
  - Container selection process
  - Scale-to-zero (KEDA) strategy
  - Pod resource limits

### Step 2: Extract Operations Files (3-4 hours)

#### 2.1 Create `02-operations/INFRASTRUCTURE_SIZING.md` (20 KB)
- **Source:** INFRASTRUCTURE_PLAN.md section 5 (Compute, Networking & Cost)
- **Contents:**
  - K8s cluster topology (initial, growth, HA)
  - Network strategy (CNI, Ingress, Load Balancer, DNS)
  - Resource sizing & cost estimates
  - HA upgrade paths
  - Cost optimization strategies

#### 2.2 Create `02-operations/BACKUP_STRATEGY.md` (15 KB)
- **Source:** INFRASTRUCTURE_PLAN.md section 6.4 + 6.4.1
- **Contents:**
  - Cluster-managed backups
  - Customer-created backups
  - Backup types (Full, Incremental, Differential)
  - Backup storage quota & accounting
  - Offsite SFTP/SSH disaster recovery
  - Restore procedures (link to RESTORE_SPECIFICATION.md)

#### 2.3 Create `02-operations/STORAGE_DATABASES.md` (15 KB)
- **Source:** INFRASTRUCTURE_PLAN.md section 6 (excluding 6.4.1)
- **Contents:**
  - Storage architecture (Longhorn)
  - Database strategy (MariaDB, PostgreSQL, shared instances)
  - Database operators (Percona, CloudNativePG)
  - Redis caching layer
  - Database backups & replication

#### 2.4 Create `02-operations/MONITORING_OBSERVABILITY.md` (12 KB)
- **Source:** INFRASTRUCTURE_PLAN.md section 10
- **Contents:**
  - Metrics (Prometheus)
  - Dashboards (Grafana)
  - Logs (Loki)
  - Alerts (Alertmanager)
  - Tracing (Tempo - Phase 2)
  - SLOs & SLIs
  - On-call procedures (business hours only)

#### 2.5 Create `02-operations/EMAIL_SERVICES.md` (8 KB)
- **Source:** INFRASTRUCTURE_PLAN.md section 11
- **Contents:**
  - Email architecture
  - Docker-Mailserver setup
  - Roundcube webmail
  - OIDC authentication for email
  - App passwords

#### 2.6 Create `02-operations/CLIENT_PANEL_FEATURES.md` (12 KB)
- **Source:** INFRASTRUCTURE_PLAN.md section 9.5
- **Contents:**
  - Client dashboard
  - Domain & site management
  - Files & deployment (SFTP, Git, file manager)
  - Database management
  - Email accounts
  - Applications (add-ons)
  - Backups & granular restore

#### 2.7 Move `ADMIN_PANEL_REQUIREMENTS.md` to `02-operations/`
```bash
mv ADMIN_PANEL_REQUIREMENTS.md 02-operations/
```

### Step 3: Extract Security & Advanced Files (2-3 hours)

#### 3.1 Create `03-security/SECURITY_ARCHITECTURE.md` (10 KB)
- **Source:** INFRASTRUCTURE_PLAN.md section 7
- **Contents:**
  - Authentication (OIDC)
  - Authorization (RBAC)
  - Network security (NetworkPolicy, fail2ban, WAF)
  - Container security (Pod Security Standards)
  - Secrets management
  - TLS/HTTPS

#### 3.2 Create `03-security/COMPLIANCE_MATRIX.md` (5 KB)
- **Source:** INFRASTRUCTURE_PLAN.md section 7.8 + custom content
- **Contents:**
  - GDPR requirements
  - PCI-DSS (if needed)
  - SOC 2 (Phase 2+)
  - Data retention policies
  - Audit logging requirements
  - Compliance checklist

#### 3.3 Create `04-deployment/DEPLOYMENT_PROCESS.md` (8 KB)
- **Source:** INFRASTRUCTURE_PLAN.md section 8
- **Contents:**
  - Container registry (Harbor)
  - Image scanning (Trivy)
  - GitOps workflow (Flux v2)
  - Deployment strategies
  - Rollback procedures

#### 3.4 Create `04-deployment/` (move existing files)
```bash
mv CICD_PIPELINE_REQUIREMENTS.md 04-deployment/
mv PHASE_1_ROADMAP.md 04-deployment/
mv GITHUB_INTEGRATION_SUMMARY.md 04-deployment/
```

#### 3.5 Create `05-advanced/DISASTER_RECOVERY.md` (10 KB)
- **Source:** INFRASTRUCTURE_PLAN.md section 12
- **Contents:**
  - HA strategy (optional, incremental)
  - Backup & restore procedures
  - Failover procedures
  - DR testing & drills
  - MTTR targets

#### 3.6 Move advanced files to `05-advanced/`
```bash
mv GEOGRAPHIC_SHARDING_SUMMARY.md 05-advanced/
mv MULTI_CLOUD_STRATEGY.md 05-advanced/
mv CONFLICT_RESOLUTION_MATRIX.md 05-advanced/
mv IPV4_IPV6_REQUIREMENTS.md 05-advanced/
```

### Step 4: Extract Feature Files (1-2 hours)

#### 4.1 Create `06-features/APPLICATION_CATALOG.md` (8 KB)
- **Source:** INFRASTRUCTURE_PLAN.md section 3 (3.3-3.9)
- **Contents:**
  - Application catalog entries
  - Moodle LMS, Gibbon LMS, Keycloak configs
  - Resource requirements per app
  - Tenancy models
  - Application lifecycle management
  - Resource customization per deployment

#### 4.2 Move `RESTORE_SPECIFICATION.md` to `06-features/`
```bash
mv RESTORE_SPECIFICATION.md 06-features/
```

### Step 5: Create Reference Files (1-2 hours)

#### 5.1 Create `07-reference/TECH_STACK_SUMMARY.md` (5 KB)
**Contents:**
```markdown
# Technology Stack Summary

## Kubernetes & Infrastructure
- Distribution: k3s
- Base OS: Debian 13
- Container Runtime: containerd
- CNI: Flannel → Calico
- Ingress: NGINX
- Traffic Routing: DNS-based ingress (NGINX DaemonSet + PowerDNS multi-A, ADR-014)
- DNS: PowerDNS

## Security & Authentication
- OIDC Provider: Dex
- Secrets: Sealed Secrets
- WAF: ModSecurity + OWASP CRS v4
- Intrusion Detection: fail2ban

## Storage & Databases
- Block Storage: Longhorn
- Media/Branding: Longhorn PV
- MariaDB Operator: Percona
- PostgreSQL Operator: CloudNativePG
- Cache: Redis

## Monitoring & Observability
- Metrics: Prometheus
- Dashboards: Grafana
- Logs: Loki
- Alerts: Alertmanager
- Tracing: Tempo (Phase 2)

## CI/CD & Registry
- Registry: Harbor
- Scanning: Trivy
- GitOps: Flux v2
- CI Runner: GitHub Actions / Gitea Actions

## Management Panels
- API: Node.js + Express/Fastify
- Frontend: React 18+ with TypeScript
- Build Tool: Vite
- Styling: Tailwind CSS
- Component Library: shadcn/ui
- State Management: TanStack Query + Zustand

## File Management
- SFTP Gateway: OpenSSH
- Web File Manager: FileBrowser
- Git Deploy: Webhook-based

## Email Stack
- MTA/IMAP: Docker-Mailserver (Postfix + Dovecot)
- Webmail: Roundcube
- Authentication: OIDC (Google/Apple)
```

#### 5.2 Create `07-reference/TERMINOLOGY.md` (5 KB)
**Create glossary of key terms:**
- Tenancy (single-tenant, multi-tenant)
- PVC, PV, StorageClass
- Namespace (client isolation)
- Helm Chart
- CNI, Ingress, Service
- Workload Container Catalog
- Application Catalog
- Dedicated Pod (all plans, ADR-024)
- Scale-to-Zero
- etc.

#### 5.3 Create `07-reference/FAQ.md` (5 KB)
**Common questions and answers:**
- "What's the difference between Workload Catalog and Application Catalog?"
- "How is data isolated between customers?"
- "What's the upgrade path from Starter to Business?"
- "How are backups handled?"
- "What happens if a node fails?"
- etc.

#### 5.4 Extract `07-reference/MIGRATION_PLAN.md` (8 KB)
- **Source:** INFRASTRUCTURE_PLAN.md section 13
- Copy section 13 to new file

### Step 6: Finalization (1-2 hours)

#### 6.1 Update `README.md`
Add new section at top:

```markdown
## 🚀 New Documentation Structure

This documentation has been reorganized for clarity. See **[QUICKSTART.md](QUICKSTART.md)** for where to start.

### Directory Organization
- **01-core/** - Platform architecture & design
- **02-operations/** - Running the platform
- **03-security/** - Security & compliance
- **04-deployment/** - CI/CD & deployment
- **05-advanced/** - HA, DR, multi-cloud
- **06-features/** - Feature specifications
- **07-reference/** - Tech stack, glossary, migration

See **[QUICKSTART.md](QUICKSTART.md)** for role-based navigation paths.
```

#### 6.2 Verify File Structure
```bash
# Should show all files in subdirectories
find . -type f -name "*.md" | sort
```

### Step 7: Verification (30 minutes)

#### 7.1 Checksum Verification
1. Count lines in old INFRASTRUCTURE_PLAN.md: `wc -l INFRASTRUCTURE_PLAN.md`
2. Count lines in extracted files: `find . -name "*.md" -exec wc -l {} + | tail -1`
3. Verify total matches (or close to it - some content may be in new summary files)

#### 7.2 Link Verification
1. Search for section references (e.g., "Section 5.2")
2. Update to file references (e.g., "INFRASTRUCTURE_SIZING.md")
3. Test that all links work

#### 7.3 Test Navigation
1. Start at QUICKSTART.md
2. Follow navigation paths for different roles
3. Verify all links are valid

## Summary

- **Total Files to Create:** 17 new files
- **Total Files to Move:** 9 existing files
- **Total Time:** 10-14 hours
- **No Content Loss:** All 3,322 lines of INFRASTRUCTURE_PLAN.md are preserved in new structure

## Bash Commands for Moving Files

```bash
# Navigate to the Server Infrastructure directory first
cd ./  # (or wherever the directory is)

# Move deployment files
mv CICD_PIPELINE_REQUIREMENTS.md 04-deployment/
mv PHASE_1_ROADMAP.md 04-deployment/
mv GITHUB_INTEGRATION_SUMMARY.md 04-deployment/

# Move advanced files
mv GEOGRAPHIC_SHARDING_SUMMARY.md 05-advanced/
mv MULTI_CLOUD_STRATEGY.md 05-advanced/
mv CONFLICT_RESOLUTION_MATRIX.md 05-advanced/
mv IPV4_IPV6_REQUIREMENTS.md 05-advanced/

# Move operations & features files
mv ADMIN_PANEL_REQUIREMENTS.md 02-operations/
mv RESTORE_SPECIFICATION.md 06-features/

# Verify structure
ls -la
find . -type d -maxdepth 1 | grep "^\./" | sort
```

## Questions?

If you need help with any specific file extraction, refer back to this document for the source sections in INFRASTRUCTURE_PLAN.md.

Good luck! 📚
