# Compliance & Regulatory Matrix

## Overview

This document maps platform features and capabilities to common compliance and regulatory requirements. Most requirements are **out of scope for the MVP** but can be implemented in Phase 2 as customer needs dictate.

## Regulatory Applicability

| Requirement | Applies? | Trigger | Notes |
| --- | --- | --- | --- |
| **GDPR** | **Likely** | Hosting EU client data | Data residency, right to deletion, DPIA |
| **CCPA/CPRA** | Possible | Hosting CA client data | Similar to GDPR, privacy disclosures |
| **HIPAA** | Unlikely | Healthcare client data | BAA required, end-to-end encryption, audit logs |
| **PCI-DSS** | **Not required (MVP)** | Payment processing | Defer until accepting card payments |
| **SOC 2** | **Not required (MVP)** | Enterprise contracts | Defer until enterprise customers require |
| **FedRAMP** | Not applicable | US government | Unlikely unless contracted by federal agencies |
| **ISO 27001** | Not required | Enterprise contracts | Defer until enterprise customers require |

## GDPR Compliance (If Applicable)

### Overview

General Data Protection Regulation applies if:
- Hosting data of EU residents
- Processing personal data of individuals in the EU
- Offering services to EU residents

### Requirements Matrix

| Requirement | MVP Status | Phase 2 | Implementation |
| --- | --- | --- | --- |
| **Data Processing Agreement (DPA)** | Out of scope | Available | Contract template with data processing terms |
| **Privacy Policy** | Deferred | Required | Publicly available, customer consent obtained |
| **Data Residency** | Optional | Supported | All data stored in single region (configurable) |
| **Right to Erasure** | Deferred | Required | Ability to delete all customer data + backups |
| **Data Portability** | Deferred | Required | Export customer data in machine-readable format |
| **Breach Notification** | Manual | Automated | Notify authorities within 72 hours if breach |
| **Audit Logging** | Basic | Enhanced | Comprehensive audit trail of all data access |
| **Encryption at Rest** | Partial | Full | Encrypt all data at rest with customer-controlled keys (optional) |
| **Encryption in Transit** | Yes | Yes | TLS everywhere, no plaintext data transfer |
| **Subprocessor Disclosure** | Manual | Automated | List all third-party processors (cloud providers, email, etc.) |

### GDPR Implementation Checklist

**MVP (Out of Scope):**
- [ ] Data Processing Agreement
- [ ] Privacy Policy (basic)
- [ ] Breach notification procedures documented

**Phase 2 (To Implement):**
- [ ] Data Processing Agreement template
- [ ] Right to deletion automation
- [ ] Data portability export tools
- [ ] Breach notification automation (72-hour timer)
- [ ] Comprehensive audit logging
- [ ] Optional customer-controlled encryption keys

### GDPR Right to Erasure (Right to Deletion) Procedure

**Requirement:** GDPR Article 17 — Customers and data subjects have right to have personal data deleted within 30 days.

**Scope:** Applies to all customers in EU or hosting EU resident data.

#### Step 1: Receive Deletion Request

Customer submits request via:
- Support ticket: "Delete my account and all associated data"
- GDPR data subject request: "[Email] requests deletion of personal data"
- Legal notice: Formal right-to-deletion request

**Procedure:**
```
1. Support logs request in ticketing system with timestamp
2. Verify identity (if data subject vs. customer)
3. Create incident: "GDPR_DELETION_REQUEST_[CUSTOMER_ID]"
4. Start 30-day countdown timer
5. Send confirmation: "Deletion request received. Will complete by [DATE]."
```

#### Step 2: Audit What Data Exists

Before deleting, determine scope:

```sql
-- All customer data to be deleted
SELECT COUNT(*) FROM customer_001.*;  -- All databases
ls -la /mnt/customer_001_storage/;    -- All files
kubectl get pvc | grep customer-001;  -- All persistent volumes
```

**Data to be deleted:**
- Customer databases (MariaDB, PostgreSQL)
- File storage (site files, uploads)
- Email accounts and mailboxes
- Backups created by customer
- DNS zones associated with customer domains
- Application logs mentioning customer ID

**Data NOT deleted (business need):**
- Cluster-managed backups (dated > 1 year before deletion request)
- Audit logs showing what customer did (anonymized if GDPR applies)
- Billing records (tax/legal requirement, anonymized)

#### Step 3: Execute Deletion

**Process:**

```bash
#!/bin/bash
CUSTOMER_ID=$1
DELETION_DATE=$(date)

# 1. Stop customer services
kubectl patch ingress customer-$CUSTOMER_ID --type merge \
  -p '{"spec":{"rules":[]}}'  # Remove all routes

# 2. Create pre-deletion backup for legal hold (7 years)
tar -czf /legal-hold/customer-$CUSTOMER_ID-deletion-$DELETION_DATE.tar.gz \
  /mnt/customer_${CUSTOMER_ID}_storage/

# 3. Delete Kubernetes namespace
kubectl delete namespace customer-$CUSTOMER_ID --grace-period=30

# 4. Delete databases
mysql -e "DROP DATABASE IF EXISTS customer_$CUSTOMER_ID;"
psql -c "DROP DATABASE IF EXISTS customer_$CUSTOMER_ID;"

# 5. Delete file storage
rm -rf /mnt/customer_${CUSTOMER_ID}_storage/

# 6. Delete email accounts
kubectl exec docker-mailserver-0 -- \
  /var/mail-state/etc/localpart --delete customer-$CUSTOMER_ID

# 7. Delete DNS zones
curl -X DELETE -H "X-API-Key: $API_KEY" \
  http://powerdns-master:8081/api/v1/zones/customer-domain-$CUSTOMER_ID

# 8. Delete backups created by customer
# (cluster backups handled by retention policy)
rm -rf /mnt/offsite/customer-backups/customer-$CUSTOMER_ID/

# 9. Verify deletion
echo "Verifying customer_$CUSTOMER_ID deletion..."
mysql -e "SHOW DATABASES LIKE 'customer_$CUSTOMER_ID';"  # Should return nothing
ls /mnt/customer_${CUSTOMER_ID}_storage 2>&1 | grep "No such file"  # Should error
kubectl get namespace customer-$CUSTOMER_ID 2>&1 | grep "not found"  # Should error

# 10. Log completion
echo "Customer_$CUSTOMER_ID deletion complete at $DELETION_DATE" >> /var/log/gdpr-deletions.log
```

#### Step 4: Verify Deletion

**Verification checklist:**

```
□ Database schemas dropped
  mysql> SHOW DATABASES;  -- customer_001 NOT in list

□ File storage deleted
  ls /mnt/customer_001_storage/  → No such file or directory

□ Kubernetes namespace deleted
  kubectl get ns | grep customer-001  → NOT in output

□ Email accounts deleted
  kubectl exec docker-mailserver -- list-mail-users | grep customer  → NOT in output

□ DNS zones deleted
  curl http://powerdns-master:8081/api/v1/zones | grep customer-001  → NOT in output

□ Customer backups deleted (but cluster backups remain)
  ls /mnt/offsite/customer-backups/ | grep customer-001  → NOT in output

□ No recent logs with customer ID
  grep -r "customer_001" /var/log/ --exclude="*year+1*"  → No results

□ Billing records anonymized (if present)
  SELECT * FROM invoices WHERE customer_id = 001;  → customer_id field is NULL or "DELETED"
```

**Failure scenarios and recovery:**

| Issue | Resolution |
|-------|-----------|
| Database won't drop (stuck transactions) | Kill all connections first: `SHOW PROCESSLIST`, then `KILL connection_id;` |
| File storage won't delete (permission denied) | Run with sudo, then verify permissions: `ls -la /mnt/customer_001_storage/` |
| DNS zone won't delete (zone locked) | Force-delete: `curl -X DELETE ...?force=true` |
| Namespace stuck in "Terminating" | `kubectl delete ns customer-001 --grace-period=0 --force` |
| Backup files locked (file in use) | Wait for backup CronJob to finish, then delete files |

#### Step 5: Document and Report

**Create GDPR Deletion Report:**

```
GDPR Deletion Report
Customer ID: customer_001
Deletion Date: 2025-03-01
Deletion Type: Full account deletion
Request Date: 2025-02-01
Completion Date: 2025-03-01 14:30 UTC
Duration: 29 days

Data Deleted:
  - Database: customer_001 (size: 500 MB)
  - File storage: /mnt/customer_001_storage (size: 2.1 GB)
  - Email accounts: 5 accounts deleted
  - DNS zones: 3 zones deleted
  - Customer backups: 12 backups deleted
  Total deleted: 2.65 GB

Data Retained (for compliance):
  - Cluster backups: 1 backup from 2024-01-15 (pre-request date, legal hold)
  - Billing records: Anonymized (customer_id = NULL)
  - Audit logs: Entries referencing customer_001 deleted

Verification: ✅ All deletion verified, no customer data recoverable

Signature: [Admin name], [Date]
```

**Send to customer:**

```
Subject: GDPR Data Deletion Completed

Dear [Customer Name],

Your deletion request submitted on [DATE] has been completed as of [DATE].

Deleted:
- All databases and files associated with your account
- Email accounts and mailboxes
- DNS zones
- Backups you created

Retained (for compliance):
- Billing records (anonymized, required for tax purposes)
- Automated infrastructure backups from before your deletion request
  (these will be automatically deleted per our retention policy on [DATE])

You may no longer use our services with this account.

If you have questions, contact: support@company.com

— Compliance Team
```

#### Step 6: Audit Log Retention

**Deletion audit trail:**

```
2025-03-01 14:00:00 UTC | Deletion request received | customer_001
2025-03-01 14:05:00 UTC | Deletion authorized | support_staff_name
2025-03-01 14:30:00 UTC | Deletion executed | deletion_automation_service
2025-03-01 14:35:00 UTC | Deletion verified | ops_engineer_name
2025-03-01 15:00:00 UTC | Deletion reported to customer | support_automation
```

**Log retention:** Keep deletion audit logs for 3 years (legal requirement)

#### Handling Backups After Deletion

**Cluster-managed backups (automatic, platform responsibility):**

1. **Backup created BEFORE deletion request** (e.g., 2025-02-28)
   - Deletion requested: 2025-02-01
   - Backup predates request
   - Keep per retention policy (7 days for Starter)
   - Deleted: 2025-03-06

2. **Backup created AFTER deletion authorized** (e.g., 2025-03-01)
   - NOT created (customer namespace deleted)
   - Not an issue

3. **Backup in offsite storage**
   - Same retention policy as local backup
   - Deleted on same schedule

**Customer-created backups:**
- Deleted immediately in Step 3
- Removed from both local and offsite storage

#### Exception: Legal Hold

**If customer is in litigation:**

```
Legal hold email from legal@company.com:

"Place customer_001 on legal hold. Do NOT execute deletion requests
until hold is lifted. Retain all data in secure, immutable storage.
Hold expires: 2025-12-31"

Procedure:
1. Cancel any pending deletion requests
2. Flag customer account: status = "LEGAL_HOLD"
3. Document hold in GDPR tracking system
4. When hold lifted, process deletion normally
```

## CCPA/CPRA (California Privacy Rights Act)

### Applicability

Applies if hosting data of California residents. Similar to GDPR with some differences:
- **Right to Know:** Customers must know what data is collected
- **Right to Delete:** Delete personal information upon request
- **Right to Opt-Out:** Opt-out of data sales/sharing
- **Right to Correct:** Correct inaccurate information
- **Right to Limit:** Limit use of sensitive personal information

### Implementation

Similar to GDPR but simpler:
- Privacy policy disclosing data practices
- Data deletion capability (per GDPR implementation)
- No "sales" of customer data (platform doesn't sell data)
- Audit trail (per GDPR implementation)

## HIPAA (Healthcare Data)

### Applicability

Applies if hosting Protected Health Information (PHI) from healthcare providers, health plans, healthcare clearinghouses.

### Requirements (High-Level)

| Component | Requirement |
| --- | --- |
| **Business Associate Agreement (BAA)** | Required for all third-party service providers |
| **Access Controls** | Authentication, authorization, audit logs |
| **Encryption** | At rest (AES-256) and in transit (TLS) |
| **Audit Logs** | Track all access to PHI |
| **Breach Notification** | Notify affected individuals if PHI is breached |
| **Data Integrity** | Detect unauthorized modification of PHI |
| **Disaster Recovery** | RTO/RPO targets, backup verification |
| **Compliance Reporting** | Annual compliance audits, documentation |

### Implementation Status

**MVP:** HIPAA is **out of scope**

**Phase 2 (If Needed):**
- Healthcare-focused contractual terms (BAA)
- Enhanced encryption (customer-controlled keys)
- Compliance audit framework (HIPAA-specific audit log format)
- Disaster recovery testing (HIPAA-required frequency)

## PCI-DSS (Payment Card Industry Data Security Standard)

### Applicability

Applies if:
- Processing, storing, or transmitting credit card data directly
- Accepting card payments on behalf of clients
- Hosting payment systems

### PCI-DSS MVP Status

**Out of scope for MVP** — Platform doesn't process payments directly. Defer until:
- Business model includes payment processing
- Customers request payment integration
- SaaS platform needs to accept card payments

### Phase 2 Implementation

If payment processing added:
- Partner with PCI-compliant payment processor (Stripe, PayPal, etc.)
- **Never store card data locally** (all payments handled by processor)
- Implement tokenization for recurring payments
- PCI compliance certification or attestation of compliance (AOC)
- Quarterly penetration testing
- Annual compliance assessment

## SOC 2 Compliance

### Applicability

SOC 2 Type II certification needed if:
- Enterprise customers require it
- SaaS platform targets enterprise market
- Customers have security/compliance requirements

### SOC 2 Areas

| Area | Focus |
| --- | --- |
| **Security** | Controls to prevent unauthorized access |
| **Availability** | Systems designed for specified uptime |
| **Processing Integrity** | Data processing is complete and accurate |
| **Confidentiality** | Data is protected from unauthorized disclosure |
| **Privacy** | Personal data handling per stated policies |

### SOC 2 MVP Status

**Out of scope for MVP** — Defer until enterprise customers require

### Phase 2 Implementation

If enterprise contracts require SOC 2:
1. **Engage auditor** (Big 4 accounting firm or SOC 2 specialist)
2. **Document controls** — security, availability, operations
3. **Evidence collection** — audit logs, testing results, procedures
4. **Run audit period** — typically 6-12 months of evidence
5. **Receive certification** — Type II report (post-audit) valid for 1 year

**Estimated cost:** $50k-200k+ depending on firm and scope

## Data Security & Privacy Features

### Currently Implemented (MVP)

| Feature | Status | Details |
| --- | --- | --- |
| **TLS encryption** | ✅ Yes | All traffic encrypted in transit |
| **Audit logging** | ✅ Basic | All API calls logged, 1-year retention |
| **Access control** | ✅ Yes | RBAC, namespace isolation, NetworkPolicy |
| **Data isolation** | ✅ Yes | Per-client namespaces, network policies |
| **Backup encryption** | ✅ Yes | AES-256 at rest |
| **Secrets management** | ✅ Yes | Sealed Secrets, no hardcoded secrets |
| **Intrusion detection** | ✅ Yes | fail2ban, WAF (optional) |
| **Container security** | ✅ Yes | Image scanning, hardened images |
| **Database security** | ✅ Yes | Per-client databases, access control |
| **SFTP/SSH security** | ✅ Yes | Key-based auth, no password access |

### To Implement (Phase 2)

| Feature | Rationale |
| --- | --- |
| **Customer-controlled encryption keys** | Required for HIPAA, enhances data security |
| **Enhanced audit logging** | GDPR/SOC 2 compliance |
| **Data residency controls** | GDPR/localization requirements |
| **Right-to-deletion automation** | GDPR compliance |
| **Breach notification** | GDPR/CCPA compliance |
| **Data portability export** | GDPR compliance |
| **Customer-side key rotation** | Enhanced security posture |
| **Compliance reporting dashboard** | Audit preparation |

## Compliance Documentation

### Required (MVP)

- [ ] **Privacy Policy** — publicly available, lists data collection and use
- [ ] **Terms of Service** — customer agreements
- [ ] **Data Processing Practices** — document how customer data is handled

### Recommended (MVP)

- [ ] **Security Policies** — incident response, access control, password policies
- [ ] **Backup & Recovery Plan** — RTO/RPO targets, testing schedule
- [ ] **Incident Response Plan** — breach notification, legal notification

### Required for Compliance (Phase 2)

- [ ] **Data Processing Agreement (DPA)** — for GDPR compliance
- [ ] **Compliance Audit Trail** — comprehensive logging for audits
- [ ] **Compliance Gap Assessment** — identify gaps for each regulation
- [ ] **Risk Assessment** — DPIA (Data Protection Impact Assessment) for GDPR

## Compliance Roadmap

### Phase 1 (MVP) — Foundation
- ✅ Basic security controls (encryption, access control, logging)
- ✅ Privacy policy and documentation
- ✅ Audit logging and retention
- ❌ Formal compliance certifications

### Phase 2 (Post-MVP) — GDPR Ready
- Implement GDPR requirements (if serving EU customers)
- Data residency options
- Right-to-deletion automation
- Enhanced audit logging
- Data Processing Agreement

### Phase 3 (Scale) — Enterprise Ready
- SOC 2 Type II certification
- HIPAA compliance (if healthcare customers)
- PCI-DSS compliance (if payment processing)
- Multi-region compliance
- Customer-controlled encryption keys

## Compliance Contacts & Resources

### For GDPR Questions
- **GDPR Text:** https://gdpr-info.eu/
- **GDPR for SaaS:** https://www.gdpr.eu/
- **DPA Template:** Available from GDPR.eu or legal counsel

### For SOC 2 Questions
- **SOC 2 Overview:** https://www.aicpa.org/interestareas/informationmanagement/sodreport.html
- **Auditor Directory:** Big 4 firms (Deloitte, PwC, EY, KPMG) or specialized SOC 2 firms

### For HIPAA Questions
- **HIPAA Text:** https://www.hhs.gov/hipaa/index.html
- **Business Associate Agreement:** HHS provides sample BAA
- **HIPAA for SaaS:** Consult healthcare compliance attorney

## Related Documentation

- **SECURITY_ARCHITECTURE.md**: Security controls and encryption
- **STORAGE_DATABASES.md**: Data storage and backup security
- **BACKUP_STRATEGY.md**: Backup and recovery procedures
- **MONITORING_OBSERVABILITY.md**: Audit logging and compliance monitoring
