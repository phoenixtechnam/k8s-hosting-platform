# Migration Plan

## Overview

Phased migration strategy from legacy hosting panels (Plesk, cPanel, Virtualmin) to the Kubernetes platform. Both platforms run in parallel during transition. Clients migrated in batches starting with low-risk sites.

## Migration Phases

| Phase | Name | Scope | Est. Duration | Notes |
| --- | --- | --- | --- | --- |
| 0 | **Foundation** | K8s cluster setup, networking, storage, shared DB/Redis | **4-8 weeks** (1-2 eng) | Infrastructure baseline |
| 1 | **Platform Services** | Management API/UI, catalog service, ingress, cert-manager, DNS, monitoring | **8-12 weeks** (1-2 eng) | MVP management platform |
| 2 | **Migration Service** | Build Migration Service for Plesk, cPanel, Virtualmin; test against live panels | **6-10 weeks** (1-2 eng) | Data extraction & import |
| 3 | **Catalog Build** | Build and test all required workload container images | **4-6 weeks** (1-2 eng) | PHP, Node, Python, Ruby runtimes |
| 4 | **Pilot Migration** | Migrate 5-10 low-risk client sites from Plesk/cPanel/Virtualmin; validate workflows | **2-4 weeks** (1-2 eng) | Real-world testing |
| 5 | **Batch Migration** | Migrate remaining clients in batches of 10-20 (panels mixed or grouped) | **4-12 weeks** (depends on batch sizes) | Operational phase |
| 6 | **Email Migration** | Migrate self-hosted email clients; configure external provider integrations | **2-4 weeks** (concurrent) | Self-hosted or external |
| 7 | **Legacy Panel Decommission** | Final client cutover; shut down Plesk/cPanel/Virtualmin servers | **1-2 weeks** (cleanup) | Post-migration |
| **Total** | | | **32-58 weeks (8-14 months)** with 1-2 engineers | No hard deadline; phases can overlap |

## Per-Client Migration Checklist

### Automated via Migration Service

All panels (Plesk, cPanel, Virtualmin):

- [ ] Authenticate to source panel
- [ ] Identify client's current runtime (PHP version, Node version, etc.)
- [ ] Determine target plan based on source resource usage
- [ ] Pre-flight validation:
  - [ ] Check storage quota availability
  - [ ] Check database size compatibility
  - [ ] Check email account count within plan limits
  - [ ] Verify PHP version compatibility with K8s catalog images
  - [ ] Test SSH/API connectivity to source panel
- [ ] Select appropriate catalog container image
- [ ] Extract all data from source panel:
  - [ ] Site files (via SFTP/rsync)
  - [ ] Database dump (via mysqldump/pg_dump)
  - [ ] Email accounts + mail data
  - [ ] SSL certificates
  - [ ] DNS records
  - [ ] .htaccess, php.ini, configuration files
  - [ ] Cron jobs (as scripts)
  - [ ] Add-on domains (if applicable)

### K8s Platform Creation

- [ ] Provision client namespace on K8s
- [ ] Create PersistentVolumeClaim for site files
- [ ] **(Starter)** Mount PV into shared pod pool, generate VirtualHost config
- [ ] **(Business/Premium)** Deploy dedicated web pod with matched catalog image
- [ ] Create Ingress rules for all client domains (primary + add-ons)
- [ ] Provision SSL certificates via cert-manager (Let's Encrypt)
- [ ] Create database + user on shared MariaDB/PostgreSQL instance
- [ ] Create email accounts on Docker-Mailserver

### Data Import

- [ ] Import site files to PersistentVolume
- [ ] Import database dump to shared instance
- [ ] Import email maildir data to Dovecot
- [ ] Apply DNS records via PowerDNS API
- [ ] Import SSL certificates (if available) or use Let's Encrypt

### Verification

- [ ] HTTP health check on each domain (verify site loads)
- [ ] Database connectivity test
- [ ] Email account login test (IMAP + SMTP + Roundcube)
- [ ] DNS propagation check
- [ ] Compare source vs. destination (file count, DB size, email accounts)

### Post-Migration Setup

- [ ] Provision SFTP access and share new credentials
- [ ] Set up OIDC account for management panel access
- [ ] Configure webmail domain (if client had webmail on source)
- [ ] Set up OIDC for email (if client wants Google/Apple login)
- [ ] Create initial backups
- [ ] Send welcome email with new access credentials

### Monitoring & Finalization

- [ ] Monitor for 48 hours post-migration (watch logs, error rates)
- [ ] Check DNS: client updates registrar nameservers (or auto-update if delegated)
- [ ] Verify traffic routing to K8s ingress
- [ ] Mark client as migrated in migration tracker
- [ ] Optionally remove from source panel (Plesk/cPanel/Virtualmin) or keep as fallback

## Rollback Plan

If a client migration fails:

1. DNS reverted to point back to Plesk/cPanel server
2. Client restored on legacy panel (original data preserved until migration confirmed)
3. Issue investigated and resolved before retry
4. Legacy servers maintained as fallback until all migrations confirmed stable

## Multi-Panel Native Migration Support

**Design Principle:** Support native migration from Plesk, cPanel, and Virtualmin without requiring clients to manually export/import data. Automated, panel-specific migration tools extract data directly from source panels.

### Supported Migration Sources

| Source Panel | Supported Versions | Data Extracted | API/Access Method |
| --- | --- | --- | --- |
| **Plesk** | 18.0+ | Sites, databases, emails, DNS, SSL certs, file permissions | Plesk RPC API, SSH file sync |
| **cPanel** | 94+ | Accounts, databases, emails, addon domains, SSL, DNS | cPanel API, CPAN modules, file sync |
| **Virtualmin** | 6.0+ | Virtual servers, databases, emails, DNS, SSL certs | Virtualmin API, SSH, file sync |

### Common Data Extracted from All Panels

| Data Type | How It's Extracted |
| --- | --- |
| **Website files** | Via SFTP/SSH rsync or panel-provided backup export |
| **Databases** | mysqldump (MariaDB) or pg_dump (PostgreSQL) via SSH |
| **Email accounts** | Exported via API + mail data via SFTP (maildir/mbox) |
| **SSL certificates** | Extracted from panel certificate store |
| **DNS records** | Exported via API or zone file export |
| **Domain info** | Domain names, registrar info, nameservers |
| **File ownership** | Unix user/group/permissions metadata |
| **Configuration** | .htaccess, php.ini overrides, cron jobs (extracted as scripts) |

## Plesk-Specific Migration

### Source

Plesk RPC API + SSH file access

### Workflow

1. **Authenticate to Plesk**: Provide RPC API credentials (admin or reseller account)
2. **Discover clients**: Query Plesk API for list of subscriptions/domains to migrate
3. **Select clients**: Admin selects which clients to migrate in this batch
4. **Pre-flight checks**:
   - Verify database size fits destination
   - Verify storage quota available on destination
   - Verify email accounts count within plan limits
   - Test SSH connectivity to Plesk server
5. **Extract data**:
   - API call: Get domain, database, email, DNS, SSL info
   - SSH rsync: Copy `/var/www/vhosts/{domain}/*` to temp staging area
   - SSH command: mysqldump per database
   - SSH command: Backup mail data from `/var/vmail`
6. **Transform data**:
   - Parse Plesk-specific configuration files (.htaccess, php.ini overrides)
   - Convert Plesk DNS records to standard format
   - Extract SSL certificate + key
   - Identify PHP version, required extensions
7. **Map to K8s resources**:
   - Determine target plan (Starter/Business/Premium based on resource usage)
   - Select appropriate catalog image (Apache+PHP version)
   - Generate namespace configuration
8. **Create K8s resources**:
   - Create client namespace
   - Create PersistentVolumeClaim
   - Deploy pod (shared or dedicated based on plan)
   - Create Ingress rules for all domains
   - Create cert-manager Certificate for SSL
9. **Import data**:
   - Copy files to PV
   - Create database + user on shared instance
   - Import database dump
   - Create email accounts on Docker-Mailserver
   - Import mail data to Dovecot maildir
   - Apply DNS records via PowerDNS API
10. **Post-import verification**:
    - HTTP health check on each domain
    - Database connectivity test
    - Email account login test (IMAP + SMTP)
    - DNS propagation check
11. **DNS cutover**:
    - Update client's domain registrar nameservers (or provide instructions)
    - Monitor DNS propagation
    - Verify traffic routing to K8s ingress
12. **Cleanup**:
    - Verify client data in K8s platform
    - Remove temporary staging files
    - Mark client as migrated in migration tracker

## cPanel-Specific Migration

### Source

cPanel API v2 + SSH file access

### Workflow

1. **Authenticate to cPanel**: Provide root SSH key or API token
2. **Discover accounts**: Query cPanel API for list of accounts
3. **Select accounts**: Admin selects which accounts to migrate
4. **Pre-flight checks**: Same as Plesk
5. **Extract data**:
   - API call: Get account info, databases, email accounts, SSL, add-on domains
   - SSH rsync: Copy `/home/{user}/public_html/*` to staging
   - SSH rsync: Copy `/home/{user}/public_html` for add-on domains
   - SSH command: mysqldump per database
   - SSH command: Backup `/home/{user}/mail` directories
   - Extract .htaccess, php.ini overrides
6. **Transform data**:
   - Parse cPanel account metadata
   - Convert addon domains to K8s domains
   - Extract PHP version, custom configuration
7. **Map to K8s resources**: Same as Plesk
8. **Create K8s resources**: Same as Plesk
9. **Import data**: Same as Plesk
10. **Post-import verification**: Same as Plesk
11. **DNS cutover**: Same as Plesk
12. **Cleanup**: Same as Plesk

## Virtualmin-Specific Migration

### Source

Virtualmin API + SSH file access

### Workflow

Similar to cPanel but adapted for Virtualmin:

1. **Authenticate to Virtualmin**: Provide SSH access
2. **Discover virtual servers**: Query Virtualmin for list of servers
3. **Select servers**: Admin selects which servers to migrate
4. **Pre-flight checks**: Same as others
5. **Extract data**:
   - API call or config file parsing for domain/database/email info
   - SSH rsync: Copy `/home/{user}/public_html/*` to staging
   - SSH command: mysqldump/pg_dump per database
   - SSH command: Backup mail data
6. **Transform data**: Extract Virtualmin-specific configuration
7-12. **Map, create, import, verify, cutover, cleanup**: Same as others

## Migration Timeline Example

**Scenario: 100 clients, 1-2 engineers, phases overlap**

- **Weeks 1-8:** Phases 0 (Foundation) + start Phase 1 (Platform Services)
- **Weeks 5-16:** Phase 1 (Platform Services) + start Phase 2 (Migration Service)
- **Weeks 10-20:** Phase 2 (Migration Service) + Phase 3 (Catalog Build)
- **Weeks 16-22:** Phase 4 (Pilot Migration) — test with 5-10 customers
- **Weeks 20-40:** Phase 5 (Batch Migration) — migrate 5-10 clients/week
- **Weeks 35-45:** Phase 6 (Email Migration) — concurrent
- **Weeks 45-48:** Phase 7 (Decommission) — shut down legacy servers

**Total: ~12 months** for full migration of 100 clients with 1-2 engineers.

## Cost of Migration

### One-Time Implementation Costs

- **Migration Service development:** 6-10 weeks engineer time (~$30-50k)
- **Testing & validation:** 2-4 weeks engineer time (~$10-20k)
- **Documentation & training:** 2-4 weeks engineer time (~$10-20k)
- **Infrastructure (K8s cluster):** ~$1-2k (hardware purchase or VPS setup)
- **Total setup:** ~$50-100k

### Per-Client Migration Costs

- **Automated via Migration Service:** ~15-30 minutes per client (most effort is upfront automation)
- **Manual support (if needed):** ~1-2 hours per client
- **Cost per client:** ~$0 (after Migration Service built) to ~$100-200 (if manual support needed)

### Ongoing Operational Costs

- **Infrastructure:** ~$50-100/month (scales with client count)
- **Operations:** 0.5 FTE for 50-100 clients, 1-2 FTE for 300+ clients
- **Support:** Covered by customer subscription

## Related Documentation

- **QUICKSTART.md**: Entry point
- **PLATFORM_ARCHITECTURE.md**: Target architecture details
- **DEPLOYMENT_PROCESS.md**: How to deploy on K8s
- **DISASTER_RECOVERY.md**: Backup and restore for migrations
