# Database Access Control Matrix

**Document Version:** 1.0  
**Last Updated:** 2026-03-01  
**Status:** DRAFT — Ready for implementation  
**Audience:** Database administrators, security engineers, compliance officers

---

## Overview

This document defines:
- **Database users and roles** — Who can access what
- **Privilege levels** — Per-user capabilities (read, write, schema modification, etc.)
- **Isolation boundaries** — How customer data is protected from other customers
- **Audit logging** — How all access is tracked and audited
- **Incident response** — What to do if credentials are compromised
- **Rotation procedures** — Automated password rotation and key management

**Principle:** Least privilege — Every user has minimum access needed for their role.

---

## Database Architecture Overview

### MariaDB (Percona)

```
Master: percona-mysql-0.percona-mysql.hosting.svc.cluster.local:3306
Replicas: percona-mysql-1, percona-mysql-2
Purpose: Customer databases, shared tenant isolation
Backup: Automated daily, 30-day retention
```

### PostgreSQL (CloudNativePG)

```
Primary: postgres-primary.hosting.svc.cluster.local:5432
Replicas: postgres-replica-1, postgres-replica-2
Purpose: Platform metadata, PowerDNS zones, OIDC state
Backup: Automated daily, 30-day retention
```

---

## User and Role Hierarchy

### Level 1: System Administrators

**Role:** `dba_admin`  
**Access:** Full access to all databases and all customers

**MariaDB Users:**
```sql
mysql> CREATE USER 'dba-admin'@'k8s-internal' IDENTIFIED BY '...';
mysql> GRANT ALL PRIVILEGES ON *.* TO 'dba-admin'@'k8s-internal' WITH GRANT OPTION;
mysql> GRANT SUPER ON *.* TO 'dba-admin'@'k8s-internal';
```

**PostgreSQL Users:**
```sql
postgres=# CREATE USER dba_admin WITH SUPERUSER PASSWORD '...';
```

**Users:** alice@company.com, bob@company.com (on-call only)

**Access Method:** VPN only, SSH key in YubiKey  
**Audit:** All queries logged  
**Rotation:** Password rotated monthly, emergency rotation on access termination

---

### Level 2: Application Service Accounts

These accounts are used by the platform's own services.

#### 2A: Management API Account

**Role:** Create/modify customer databases, read platform metadata  
**MariaDB User:** `management_api`

```sql
CREATE USER 'management_api'@'management-api.hosting.svc.cluster.local' 
  IDENTIFIED BY '...';

-- Database creation (scoped to customer databases only)
GRANT CREATE, ALTER, DROP ON `customer_%`.* TO 'management_api'@'management-api.hosting.svc.cluster.local';

-- Customer database privileges (can modify any customer DB)
GRANT ALL PRIVILEGES ON `customer_%`.* TO 'management_api'@'management-api.hosting.svc.cluster.local';

-- Platform metadata (read)
GRANT SELECT ON `platform`.* TO 'management_api'@'management-api.hosting.svc.cluster.local';
```

**PostgreSQL User:** `management_api`

```sql
CREATE ROLE management_api LOGIN PASSWORD '...';
GRANT ALL PRIVILEGES ON DATABASE platform TO management_api;
GRANT CREATE ON SCHEMA public TO management_api;
```

**Credential Storage:** Kubernetes Secret `management-api-db-credentials`  
**Rotation:** Automated, every 90 days (using Sealed Secrets + CronJob)

#### 2B: Backup Service Account

**Role:** Read all databases for backup, write to backup storage  
**MariaDB User:** `backup_service`

```sql
CREATE USER 'backup_service'@'backup-pod.hosting.svc.cluster.local' 
  IDENTIFIED BY '...';

-- Read-only access to all databases
GRANT SELECT, LOCK TABLES ON *.* TO 'backup_service'@'backup-pod.hosting.svc.cluster.local';
GRANT RELOAD, REPLICATION CLIENT ON *.* TO 'backup_service'@'backup-pod.hosting.svc.cluster.local';
```

**PostgreSQL User:** `backup_service`

```sql
CREATE ROLE backup_service LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE platform TO backup_service;
GRANT USAGE ON SCHEMA public TO backup_service;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO backup_service;
```

**Credential Storage:** Kubernetes Secret `backup-db-credentials`  
**Rotation:** Automated, every 90 days

#### 2C: Monitoring Account

**Role:** Read-only access for health checks and metrics  
**MariaDB User:** `monitoring`

```sql
CREATE USER 'monitoring'@'prometheus.monitoring.svc.cluster.local' 
  IDENTIFIED BY '...';

-- Minimal read access
GRANT SELECT ON `performance_schema`.* TO 'monitoring'@'prometheus.monitoring.svc.cluster.local';
GRANT REPLICATION CLIENT ON *.* TO 'monitoring'@'prometheus.monitoring.svc.cluster.local';
```

**PostgreSQL User:** `monitoring`

```sql
CREATE ROLE monitoring LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE platform TO monitoring;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO monitoring;
```

**Credential Storage:** Kubernetes Secret `monitoring-db-credentials`  
**Rotation:** Automated, every 90 days

---

### Level 3: Customer Database Users

Each customer has isolated database user(s).

#### 3A: MariaDB Customer User

**Pattern:** `customer_<id>_app`  
**Database:** `customer_<id>`  
**Privileges:** SELECT, INSERT, UPDATE, DELETE (no DROP, ALTER, CREATE)

```sql
CREATE USER 'customer_001_app'@'shared-php-01.hosting.svc.cluster.local' 
  IDENTIFIED BY '...';

GRANT SELECT, INSERT, UPDATE, DELETE ON `customer_001`.* 
  TO 'customer_001_app'@'shared-php-01.hosting.svc.cluster.local';

-- REVOKE dangerous operations
REVOKE DROP, ALTER, CREATE ON `customer_001`.* 
  FROM 'customer_001_app'@'shared-php-01.hosting.svc.cluster.local';
```

**Access Restrictions:**
- Can only access `customer_001` database
- Cannot see other customer databases
- Cannot modify schema (no CREATE TABLE)
- Cannot drop tables
- Cannot access MariaDB system tables

#### 3B: PostgreSQL Customer User

```sql
CREATE ROLE customer_001_app LOGIN PASSWORD '...';
GRANT CONNECT ON DATABASE platform TO customer_001_app;

-- Schema isolation: customer_001 only
GRANT USAGE ON SCHEMA customer_001 TO customer_001_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA customer_001 TO customer_001_app;

-- Revoke structural modifications
REVOKE CREATE ON SCHEMA customer_001 FROM customer_001_app;
REVOKE ALTER ON SCHEMA customer_001 FROM customer_001_app;
```

**Credential Rotation:** Every 30 days (automated)  
**Distribution:** Provided to customer via Management API, encrypted in transit (HTTPS)

---

## Privilege Matrix

| User | Database | SELECT | INSERT | UPDATE | DELETE | CREATE | ALTER | DROP | GRANT | Comments |
|------|----------|--------|--------|--------|--------|--------|-------|------|-------|----------|
| dba_admin | All | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | Emergency access only |
| management_api | customer_* | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | Platform service |
| management_api | platform | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | Read-only |
| backup_service | All | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | Backup only |
| monitoring | performance_schema | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | Metrics only |
| customer_app | customer_X | ✅ | ✅ | ✅ | ✅ | ❌ | ❌ | ❌ | ❌ | Per-customer |
| customer_backup | customer_X | ✅ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ | Per-customer backup |

---

## Isolation Boundaries

### MariaDB Isolation

**File-level isolation:**
```bash
# Each customer database is isolated at file level
ls -la /var/lib/mysql/
drwxr-x--- customer_001/
drwxr-x--- customer_002/
drwxr-x--- customer_003/
```

**Query-level isolation — Verify with:**
```sql
-- From customer_001_app user:
USE customer_001;
SELECT * FROM users;  -- ✅ Works

USE customer_002;  -- ❌ Error: Access denied for user 'customer_001_app'@'...'
SELECT * FROM users;

SELECT * FROM mysql.user;  -- ❌ Error: Access denied
```

**Row-level isolation (optional):**
If customers share a table (e.g., `shared_users`), enforce row-level security:
```sql
CREATE POLICY customer_isolation 
  ON shared_users 
  USING (customer_id = CURRENT_USER_ID);
```

### PostgreSQL Isolation

**Schema-level isolation:**
```sql
-- Customer 001 can only see customer_001 schema
SET search_path TO customer_001;
SELECT * FROM users;  -- ✅ Works

SELECT * FROM customer_002.users;  -- ❌ Error: permission denied
```

**Row-level security (Postgres 9.5+):**
```sql
-- For shared tables across customers
ALTER TABLE orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY customer_row_isolation 
  ON orders 
  FOR ALL 
  USING (customer_id = current_setting('app.current_customer_id')::int);
```

---

## Audit Logging

### MariaDB Audit Plugin

**Enable General Query Log (for critical accounts):**
```sql
-- For dba_admin and management_api only (not all customers)
SET GLOBAL general_log = 'OFF';  -- Normally off (performance impact)
SET GLOBAL log_output = 'TABLE';  -- Write to mysql.general_log

-- Enable only for specific user
mysql> CREATE TABLE audit_log LIKE mysql.general_log;
mysql> CREATE TRIGGER audit_trigger 
  BEFORE INSERT ON mysql.general_log 
  FOR EACH ROW 
  BEGIN 
    INSERT INTO audit_log VALUES (NOW(), NEW.user_host, NEW.command_type, NEW.argument);
  END;
```

**Better: Use Percona Server Audit Plugin**
```sql
INSTALL PLUGIN audit_log SONAME 'audit_log.so';

SET GLOBAL audit_log_events = 'Connect,Query_ddl,Query_dml';
SET GLOBAL audit_log_file = '/var/log/mysql/audit.log';
SET GLOBAL audit_log_rotations = 10;  -- Keep 10 audit logs
SET GLOBAL audit_log_compression = 'GZIP';

-- Audit only high-risk users
SET GLOBAL audit_log_filter = "{ \"filter\": { \"log\": true, \"filter\": { \"or\": [ { \"id\": \"dba_admin\" }, { \"id\": \"management_api\" } ] } } }";
```

### PostgreSQL Audit Logging (pgAudit)

```sql
CREATE EXTENSION IF NOT EXISTS pgaudit;

SET pgaudit.log = 'ALL,DDL,DML';
SET pgaudit.log_statement = on;
SET pgaudit.log_parameter = on;
SET pgaudit.role = 'audit_role';

-- Log to file
ALTER SYSTEM SET log_destination = 'stderr';
ALTER SYSTEM SET log_statement = 'all';
SELECT pg_reload_conf();
```

**Log output:**
```
2025-03-01 10:15:32.123 UTC [12345] dba_admin@platform LOG: AUDIT: SESSION,1,1,DDL,ALTER TABLE,,,"ALTER TABLE users ADD COLUMN email VARCHAR(255);",<none>
2025-03-01 10:20:15.456 UTC [12346] customer_001_app@customer_001 LOG: AUDIT: SESSION,1,2,DML,UPDATE,,,"UPDATE users SET name='John' WHERE id=5;",<none>
```

### Centralized Log Aggregation

**All database audit logs → Fluent Bit → Loki:**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: fluent-bit-config
data:
  database-audit.conf: |
    [INPUT]
    Name              tail
    Tag               mariadb.audit
    Path              /var/log/mariadb/audit.log
    Parser            json
    DB                /var/lib/fluent-bit/state-mariadb.db
    
    [INPUT]
    Name              tail
    Tag               postgres.audit
    Path              /var/log/postgresql/postgresql.log
    Parser            postgres
    DB                /var/lib/fluent-bit/state-postgres.db
    
    [OUTPUT]
    Name              loki
    Match             *.audit
    Host              loki.monitoring.svc.cluster.local
    Port              3100
    Labels            job=database-audit
    Auto_Kubernetes_Labels on
```

**Queries in Grafana (LogQL):**
```
# All admin access in last 24 hours
{job="database-audit"} |= "dba_admin" | logfmt

# All SELECT queries from customer_001_app
{job="database-audit"} |= "customer_001_app" |= "SELECT"

# All DDL changes (CREATE, ALTER, DROP)
{job="database-audit"} |~ "CREATE|ALTER|DROP"
```

### Audit Retention

- **Critical users (admin, management_api):** 1 year
- **Customer users:** 90 days
- **Monitoring/backup users:** 30 days
- **Immutability:** Logs written to immutable storage (Loki with offsite backup, append-only on backup server)

---

## Credential Management and Rotation

### Automated Rotation (90 days)

**CronJob in Kubernetes:**
```yaml
apiVersion: batch/v1
kind: CronJob
metadata:
  name: db-credential-rotation
  namespace: hosting
spec:
  # Every Sunday at 2 AM UTC
  schedule: "0 2 * * 0"
  jobTemplate:
    spec:
      template:
        spec:
          serviceAccountName: db-credential-rotator
          containers:
          - name: rotator
            image: mysql:8.0
            env:
            - name: MYSQL_HOST
              value: percona-mysql-0.percona-mysql.hosting.svc.cluster.local
            - name: MYSQL_ROOT_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: mysql-root-credentials
                  key: password
            command:
            - /bin/bash
            - -c
            - |
              # Rotate management_api password
              NEW_PASSWORD=$(openssl rand -base64 32)
              mysql -h$MYSQL_HOST -uroot -p$MYSQL_ROOT_PASSWORD \
                -e "ALTER USER 'management_api'@'management-api.hosting.svc.cluster.local' \
                IDENTIFIED BY '$NEW_PASSWORD';"
              
              # Update Kubernetes Secret
              kubectl patch secret management-api-db-credentials -n hosting \
                -p '{"data":{"password":"'$(echo -n $NEW_PASSWORD | base64)'"}}'
              
              # Restart management-api pods to pick up new password
              kubectl rollout restart deployment/management-api -n hosting
              
              # Log rotation
              echo "Rotated management_api password at $(date)" >> /var/log/rotation.log
          restartPolicy: OnFailure
```

### Emergency Password Reset

**Procedure if credentials compromised:**

```bash
#!/bin/bash
# Emergency credential reset for compromised account

CUSTOMER_ID=$1
DB_USER="customer_${CUSTOMER_ID}_app"
DB_HOST="shared-php-01.hosting.svc.cluster.local"

# Step 1: Generate new password
NEW_PASSWORD=$(openssl rand -base64 32)

# Step 2: Update database
mysql -h percona-mysql-0 -uroot -p$ROOT_PASS \
  -e "ALTER USER '${DB_USER}'@'${DB_HOST}' IDENTIFIED BY '$NEW_PASSWORD';"

# Step 3: Invalidate old password immediately (force change on next login)
mysql -h percona-mysql-0 -uroot -p$ROOT_PASS \
  -e "ALTER USER '${DB_USER}'@'${DB_HOST}' PASSWORD EXPIRE;"

# Step 4: Kill all existing connections from this user
mysql -h percona-mysql-0 -uroot -p$ROOT_PASS \
  -e "SELECT CONCAT('KILL ', id, ';') FROM information_schema.processlist 
      WHERE user='${DB_USER}' INTO OUTFILE '/tmp/kill.sql';"
mysql -h percona-mysql-0 -uroot -p$ROOT_PASS < /tmp/kill.sql

# Step 5: Update Kubernetes Secret with new password
kubectl patch secret customer-${CUSTOMER_ID}-db-credentials \
  -p '{"data":{"password":"'$(echo -n $NEW_PASSWORD | base64)'"}}'

# Step 6: Notify customer
cat > notification.txt << EOF
SECURITY ALERT: Your database credentials have been rotated due to a security incident.

New credentials:
  Host: percona-mysql-0.percona-mysql.hosting.svc.cluster.local
  Username: ${DB_USER}
  Password: [will be provided separately]
  Database: customer_${CUSTOMER_ID}

Old password has been invalidated. You must update your application configuration immediately.

Contact security@company.com with questions.
EOF

# Step 7: Log incident
logger "SECURITY: Database credentials reset for customer_${CUSTOMER_ID}"
echo "Emergency reset complete at $(date)" >> /var/log/security-events.log
```

---

## Privilege Escalation Prevention

### Role Hierarchy Lock

Prevent customers from creating new users or modifying privileges:

```sql
-- MariaDB
REVOKE GRANT OPTION ON customer_001.* FROM customer_001_app@'%';
REVOKE CREATE USER ON *.* FROM customer_001_app@'%';
REVOKE SUPER ON *.* FROM customer_001_app@'%';

-- PostgreSQL
REVOKE CREATEROLE FROM customer_001_app;
REVOKE CREATEDB FROM customer_001_app;

-- Verify (should return empty)
SHOW GRANTS FOR customer_001_app@'%';
SELECT * FROM information_schema.role_table_grants 
  WHERE grantee = 'customer_001_app';
```

### Separation of Duties

- **Database creation:** Only management_api user
- **Database backup:** Only backup_service user
- **Database repair:** Only dba_admin user
- **Customer app access:** Only customer_*_app user

---

## Incident Response

### Scenario: Compromised Customer Credentials

**Step-by-step response:**

1. **Immediate action (< 5 min)**
   ```bash
   # Kill all connections from compromised user
   # (See "Emergency Password Reset" section above)
   ```

2. **Investigation (< 30 min)**
   ```sql
   -- Check what queries were executed with compromised account
   SELECT * FROM audit_log 
   WHERE user = 'customer_001_app' 
   AND timestamp > DATE_SUB(NOW(), INTERVAL 24 HOUR)
   ORDER BY timestamp DESC;
   
   -- Look for unusual queries:
   -- - SELECT from other customer's data
   -- - DROP/ALTER/CREATE commands
   -- - INSERT into audit tables
   ```

3. **Recovery (< 1 hour)**
   ```bash
   # Determine if data was accessed/modified
   # If SELECT only: No action beyond credential reset
   # If INSERT/UPDATE/DELETE: Restore from backup to before incident time
   # If DROP/ALTER: Database rollback required
   
   # Reset customer credentials (see above)
   # Notify customer of breach
   # File security incident report
   ```

4. **Post-incident**
   - Audit log review
   - PIR meeting
   - Customer communication
   - Potential compliance notification (if PII accessed)

---

## Compliance Requirements

### SOC 2 Type II

- ✅ All database access logged
- ✅ Admin access (dba_admin) separated from customer access
- ✅ Automatic credential rotation (90 days)
- ✅ Audit logs retained 1 year
- ✅ Unused accounts disabled after 90 days

### GDPR

- ✅ Customer data segregation enforced at database level
- ✅ Right to access: Can query customer_X database for specific user
- ✅ Right to delete: Can DELETE FROM users WHERE customer_id = X
- ✅ Audit trail: All data access logged

### PCI-DSS (if handling payment cards)

- ✅ Privilege separation (dba_admin ≠ customer_app)
- ✅ Automatic password rotation
- ✅ Strong passwords (32-char random)
- ✅ Audit logging enabled
- ✅ Access restricted to VPN only

---

## Implementation Checklist

- [ ] Create MariaDB users for all roles
- [ ] Create PostgreSQL users for all roles
- [ ] Implement automated credential rotation
- [ ] Set up audit logging for all databases
- [ ] Centralize logs to Loki (via Promtail; queried through Grafana)
- [ ] Test privilege isolation (try cross-customer access)
- [ ] Verify customer cannot escalate privileges
- [ ] Write emergency credential reset procedure
- [ ] Create monitoring dashboard for failed login attempts
- [ ] Test backup can restore with proper isolation
- [ ] Document all users and their purposes
- [ ] Schedule quarterly access review

---

## Related Documents

- [`../03-security/SECURITY_ARCHITECTURE.md`](../03-security/SECURITY_ARCHITECTURE.md) — Overall security framework
- [`../02-operations/BACKUP_STRATEGY.md`](../02-operations/BACKUP_STRATEGY.md) — Backup procedures
- [`./INCIDENT_RESPONSE_RUNBOOK.md`](./INCIDENT_RESPONSE_RUNBOOK.md) — Response to credential compromise

---

**Status:** Ready for implementation  
**Estimated Implementation Time:** 2-3 days  
**Next Phase:** Update existing security documentation with integration details
