# Frequently Asked Questions (FAQ)

## General Platform Questions

### Q: What is this platform?

**A:** A modern, Kubernetes-based web hosting platform designed to replace legacy cPanel/Plesk systems. It provides shared hosting, dedicated hosting, email, DNS, SSL certificates, and application deployment with 99.5% uptime SLA.

### Q: Who is this platform for?

**A:** Hosting companies, managed service providers, or enterprises wanting to build their own web hosting platform. The MVP serves 50-100 clients on minimal infrastructure (~$35-60/month), scaling to 300+ clients with HA.

### Q: What makes this different from cPanel/Plesk?

**A:** Modern cloud-native architecture (Kubernetes), declarative infrastructure (GitOps), containerized workloads, lower operational overhead, no licensing costs, open-source components, horizontal scalability.

### Q: Is this open source?

**A:** No. The management API and panels are proprietary, but all underlying infrastructure components are open source (k3s, Kubernetes, Prometheus, Loki, etc.). No expensive licenses required.

---

## Technical Architecture Questions

### Q: Why Kubernetes instead of traditional Linux servers?

**A:** Kubernetes provides:
- **Declarative infrastructure** — describe desired state, controller enforces it
- **Horizontal scaling** — add nodes instead of vertical scaling (bigger servers)
- **Automatic failover** — pods restart on node failure
- **Resource efficiency** — bin packing, shared infrastructure
- **Native multi-tenancy** — namespaces isolate clients
- **Standard tooling** — Kubernetes is industry standard

### Q: What's k3s and why use it over full Kubernetes?

**A:** k3s is a lightweight Kubernetes distribution (~50% less control plane memory). Perfect for VPS/bare metal where resources are constrained. Still 100% Kubernetes-compatible.

### Q: Can I run this on my own infrastructure?

**A:** Yes! The platform runs on any Linux server or VPS (Hetzner, OVH, Linode, etc.). No cloud provider lock-in.

### Q: Do I need a managed Kubernetes service (EKS, GKE, AKS)?

**A:** No. Self-managed k3s works fine and costs less. Managed services add ~$70-100/month overhead.

### Q: How does this handle scaling?

**A:** Horizontal scaling by adding worker nodes. Vertical scaling (bigger instances) not recommended. Shared pod architecture handles 50-100 Starter clients per worker node.

---

## Storage & Database Questions

### Q: How is data stored and backed up?

**A:** 
- **Local:** Longhorn block storage for site files; media/branding on Longhorn PV
- **Backups:** Daily automated backups (cluster-managed), included free in all plans
- **Customer backups:** Optional, counted against storage quota
- **Offsite:** Daily SSHFS mount → direct write to external backup server (no local copy, zero disk consumed)

### Q: What if I lose the cluster?

**A:** Two options:
1. **Restore from backup:** Velero snapshot on offsite server allows recovery in ~4 hours
2. **With HA enabled:** Automatic failover to replica (< 5 seconds downtime)

### Q: Can clients access their databases directly?

**A:** Yes. Shared MariaDB/PostgreSQL instances provide per-client users with credentials. Access via standard clients (phpMyAdmin, pgAdmin, etc.). Dedicated databases available for Premium clients.

### Q: How many databases can a client have?

**A:** Unlimited on shared instances. Each client gets dedicated user(s). If dedicated database needed, upgrade to Premium/Custom plan.

---

## Hosting Plans & Pricing Questions

### Q: What are the three hosting plans?

**A:**
- **Starter:** Shared pod, shared database/cache, 1 domain, 7-day backups, $5.99/mo
- **Business:** Dedicated pod, shared database/cache, 5 domains, 14-day backups, $19.99/mo
- **Premium:** Dedicated pod/database/cache, unlimited domains, 30-day backups, WAF, $49.99/mo

### Q: Can I customize plans?

**A:** Yes, fully. Every parameter (CPU, memory, storage, backup retention, features) is configurable per-client via overrides, without changing their plan.

### Q: How does shared pod work for Starter?

**A:** Multiple Starter clients share Apache+PHP pods via Apache VirtualHost configuration. Each client gets isolated document root via PHP-FPM pools with `open_basedir` restriction. Efficient and secure.

### Q: Can a client upgrade/downgrade?

**A:** Yes. Changing plans applies new defaults but preserves per-client overrides. Upgrade/downgrade happens immediately with zero downtime (for web, zero downtime; for databases, brief connection interrupt if migrating data).

### Q: What are the total costs for 100 clients?

**A:** Approximately:
- Infrastructure: $35-60/mo (1 control plane + 1 worker)
- Email (Docker-Mailserver): Minimal overhead
- Monitoring: Minimal overhead
- **Total:** ~$50-100/mo for 100 clients

### Q: What's the revenue from 100 Starter clients?

**A:** If all Starter: 100 × $5.99 = ~$600/mo. Profit = revenue - costs = ~$500-550/mo (excellent unit economics for MVP).

---

## Security & Compliance Questions

### Q: Is data encrypted?

**A:** Yes.
- **At rest:** AES-256 (optional for databases)
- **In transit:** TLS everywhere (HTTPS, database connections, service-to-service)
- **Backups:** Encrypted before write to offsite server (SSHFS mount)

### Q: What about GDPR compliance?

**A:** MVP has basic security controls. GDPR-specific features (DPA, right-to-deletion automation, data portability) deferred to Phase 2. See **COMPLIANCE_MATRIX.md**.

### Q: Can clients encrypt their own data?

**A:** Phase 2 feature. MVP uses platform-managed encryption. Customer-controlled encryption keys available in Phase 2.

### Q: What about PCI-DSS / HIPAA / SOC 2?

**A:** Not required for MVP. Platform can add these as customers request them. PCI-DSS only needed if accepting card payments (use Stripe instead).

### Q: How do you prevent one client from accessing another's data?

**A:** Multiple layers:
1. **Kubernetes namespaces** — separate resources
2. **NetworkPolicy** — pods can't reach each other
3. **RBAC** — client can only access their namespace
4. **Database isolation** — separate user + database per client
5. **Storage isolation** — separate PersistentVolumes per client
6. **Network segmentation** — client pods only reach ingress + shared services

---

## Deployment & CI/CD Questions

### Q: How do clients deploy code?

**A:** Three methods, all zero-build:
1. **SFTP:** Upload files directly (traditional hosting experience)
2. **Git:** Push to repo, webhook triggers sync to PersistentVolume
3. **Web file manager:** Browser-based file upload/edit

### Q: Do you support container builds?

**A:** No. Clients select from admin-curated catalog images. No custom Dockerfiles. This simplifies operations and security.

### Q: Can clients run custom code?

**A:** Only in catalog images. Clients can run PHP, Node, Python, Ruby, .NET, Java in dedicated pods, but can't supply custom images. Security & management trade-off.

### Q: How are catalog images updated?

**A:** Admin updates Dockerfile, CI builds + scans image, pushed to Harbor, catalog updated. Clients see "upgrade available" notice. Can force migrate all clients to new version.

### Q: Can I automate client onboarding?

**A:** Yes. Management API fully automates provisioning:
1. Namespace creation
2. Database + user creation
3. DNS records
4. TLS certificates
5. SFTP credentials
6. Email accounts
7. Ingress + networking

Takes ~5-10 seconds per client.

---

## Email & Communication Questions

### Q: Is email self-hosted or external?

**A:** Self-hosted Docker-Mailserver (Postfix + Dovecot) with Roundcube webmail. No external email provider required. Optional hybrid: use SendGrid/Mailgun for sending if volume is high.

### Q: How many email accounts per client?

**A:** Configurable per plan. Starter: 0-1, Business: 5, Premium: unlimited.

### Q: Can clients access email via IMAP/SMTP?

**A:** Yes. Standard Dovecot IMAP + Postfix SMTP. Clients get credentials to configure Thunderbird, Outlook, Apple Mail, mobile clients, etc.

### Q: How do app passwords work?

**A:** System-generated 32-character high-entropy passwords for email accounts. Clients create multiple per account (phone, desktop, integrations). Admin can view in plaintext for support. All actions logged.

### Q: Can clients log in with Google/Apple?

**A:** Yes (optional). OIDC integration allows passwordless login to Roundcube webmail if enabled.

---

## Monitoring & Observability Questions

### Q: What happens if something breaks?

**A:** Multiple layers of monitoring:
1. **Prometheus** collects metrics every 15 seconds
2. **Alertmanager** detects anomalies, sends alerts
3. **Loki** aggregates logs from all pods
4. **Grafana** dashboards show real-time status

Alerts go to admin (email + SMS, PagerDuty in Phase 2).

### Q: Can clients see their metrics?

**A:** Yes. Each client panel shows:
- Storage usage (files + databases)
- Bandwidth
- HTTP errors / latency
- Last backup
- Current container version

### Q: How long are logs retained?

**A:**
- Client access logs: 30 days
- Platform service logs: 90 days
- Security/audit logs: 1 year
- Backup logs: 90 days

### Q: Can I export metrics for billing?

**A:** Yes. Metrics available via Prometheus API. Can generate invoices based on storage used, bandwidth, etc.

---

## Disaster Recovery & HA Questions

### Q: What if the cluster dies?

**A:** Recovery time depends on HA level:
- **No HA (MVP):** 4 hours (manual restore from backup)
- **With HA:** Automatic failover (< 5 seconds)

Backups stored offsite, can rebuild cluster from scratch.

### Q: Do I need HA?

**A:** Not initially. MVP runs on single control plane + 1 worker. HA optional, enables when:
- Single node can't handle load (~100 clients)
- Unplanned downtime is unacceptable
- Budget justifies cost (~$50/month incremental)

### Q: What if my data center goes down?

**A:** With offsite backups, you can:
1. Stand up cluster in different region
2. Restore from offsite SFTP backup
3. Resume operations (RTO: ~4 hours)

Multi-region active-active failover available in Phase 3 (complex setup).

### Q: How often should I test backups?

**A:** Recommendation: monthly restores of sample backups, quarterly full cluster restore to staging environment. Never trust untested backups!

---

## Cost & Business Questions

### Q: What's the total cost for the platform?

**A:** MVP:
- **Infrastructure:** $35-60/month (1 CP + 1 worker, storage)
- **Development:** One-time (management API + panels)
- **Operations:** 1-2 engineers (salary, not included)
- **Third-party services:** None (all self-hosted)

No licensing costs (all open source).

### Q: Can I make money on this?

**A:** Yes. Example: 100 Starter clients @ $5.99 = $600/mo revenue, ~$50/mo costs = $550/mo profit. Healthy unit economics for MVP.

### Q: What's the price/margin per client?

**A:**
- **Starter:** $5.99/mo, margin ~$5.50/mo (92%)
- **Business:** $19.99/mo, margin ~$18/mo (90%)
- **Premium:** $49.99/mo, margin ~$49/mo (98%)

High margins if you have volume (costs are fixed, revenue variable).

### Q: At what scale does HA make sense?

**A:** HA costs ~$50-100/month extra (3x worker nodes, replicated database). Breaks even when:
- You lose a node and want automatic failover (saves 4 hours recovery time)
- Uptime SLA worth more than ~$50/month to customers

Recommend: HA at 100-150 clients (revenue ~$800-1200/mo).

### Q: Can I run this as a white-label reseller?

**A:** Yes. Fully branded admin + client panels, custom branding (logo, colors, domain), separate customers.

---

## Operational Questions

### Q: How much time to operate this?

**A:** MVP: ~10-20 hours/week for 100-300 clients (monitoring, support, updates, backups). With HA: ~30 hours/week. Scales superlinearly (more clients = more support tickets).

### Q: What about customer support?

**A:** MVP supports business hours only (no 24/7 on-call). Support tiers:
- **Starter:** Self-service (knowledge base, email)
- **Business:** Email support, 24-hour response
- **Premium:** Email + phone support, 4-hour response

### Q: Can I automate support tickets?

**A:** Partially. Implement chatbot for common FAQs, automated responses for status checks, integration with ticketing system (Jira, etc.) for internal routing.

---

## Getting Started

### Q: Where do I start?

**A:** See **QUICKSTART.md** for navigation by role:
- **Architects:** PLATFORM_ARCHITECTURE.md
- **DevOps/SRE:** INFRASTRUCTURE_SIZING.md, DEPLOYMENT_PROCESS.md, DISASTER_RECOVERY.md
- **Developers:** TECH_STACK_SUMMARY.md, CLIENT_PANEL_FEATURES.md
- **Product Managers:** HOSTING_PLANS.md, APPLICATION_CATALOG.md

### Q: What's the roadmap?

**A:** See **PLATFORM_ARCHITECTURE.md** → Phase 1/2/3 breakdown.
- **Phase 1 (MVP):** Core hosting, email, backups, monitoring
- **Phase 2 (Scale):** HA, GDPR, multi-cloud, advanced apps
- **Phase 3 (Enterprise):** SOC 2, HIPAA, multi-region, custom integrations

### Q: How long to build this?

**A:** Rough estimate:
- **MVP (Phase 1):** 4-6 months (one experienced engineer)
- **Phase 2:** 6-8 months (scale features, GDPR, HA)
- **Phase 3:** Ongoing (enterprise features, compliance, integrations)

### Q: Can I fork this and build my own?

**A:** This is documentation + design. You'll need to implement the management API and panels. Use the QUICKSTART + architecture docs as a guide. Reuse open-source components (k3s, Flux, etc.).

---

## Related Documentation

- **QUICKSTART.md**: Navigation entry point
- **PLATFORM_ARCHITECTURE.md**: Detailed explanations
- **TECH_STACK_SUMMARY.md**: Technology decisions
- **TERMINOLOGY.md**: Glossary of terms
