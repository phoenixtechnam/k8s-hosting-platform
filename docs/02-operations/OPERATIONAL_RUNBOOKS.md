# Operational Runbooks

> **Audience:** Platform operators (1-2 engineers)
> **Context:** Single-node k3s cluster, external DNS/OIDC/NetBird (ADR-022)

---

## 1. Customer Site Is Down — Triage Flowchart

**Trigger:** Customer reports their website is unreachable, or monitoring detects HTTP 5xx/timeout.

### Step 1: Verify the problem
```bash
# From operator workstation (via NetBird mesh)
curl -I https://customer-domain.com
# Expected: HTTP 200 or 301/302
# If timeout: proceed to Step 2
# If 502/503: proceed to Step 3
# If DNS error: proceed to Step 4
```

### Step 2: Check node health
```bash
kubectl get nodes
# If NotReady: node is down — see DR runbook
kubectl top nodes
# If CPU/memory > 90%: resource exhaustion — see Runbook #3
```

### Step 3: Check pod health
```bash
# All clients have dedicated pods in client-{id} namespace (ADR-024)
kubectl -n client-{id} get pods
kubectl -n client-{id} describe pod <pod-name>
kubectl -n client-{id} logs <pod-name> --tail=50
```

**Common pod issues:**
| Symptom | Cause | Fix |
|---------|-------|-----|
| CrashLoopBackOff | PHP fatal error, bad config | Check logs, fix config, restart |
| OOMKilled | Memory limit exceeded | Increase limits or optimize app |
| Pending | Insufficient resources | Check node capacity, scale down other pods |
| ImagePullBackOff | Registry unreachable | Check GHCR/registry connectivity |

### Step 4: Check DNS resolution
```bash
dig customer-domain.com @8.8.8.8
# If NXDOMAIN: zone missing from PowerDNS
# If wrong IP: A record points to old server

# Check PowerDNS API
curl -H "X-API-Key: $PDNS_API_KEY" \
  "$PDNS_API_URL/api/v1/servers/localhost/zones/customer-domain.com."
```

### Step 5: Check ingress
```bash
kubectl -n ingress get pods
kubectl -n ingress logs <nginx-ingress-pod> --tail=50 | grep customer-domain
# Look for: 502 errors, upstream connection refused, certificate issues
```

### Step 6: Check database
```bash
kubectl -n platform exec -it <mariadb-pod> -- mysql -u root -p -e "SHOW PROCESSLIST;"
# Look for: locked queries, connection limit reached, slow queries
```

---

## 2. Single-Customer Restore from Backup

**Trigger:** Customer requests restore of files, database, or email from a specific backup date.

### Prerequisites
- Identify the backup date and what to restore (files, database, email, or all)
- Ensure the offsite backup server is reachable via NetBird mesh

### Step 1: Mount the offsite backup
```bash
# From admin1 (via NetBird mesh to backup server)
mkdir -p /mnt/backup
sshfs backup@storagebox:/backups /mnt/backup -o IdentityFile=~/.ssh/backup_key

# Navigate to customer's backup
ls /mnt/backup/customers/{client_id}/
# Expected: files/ databases/ email/ config/
```

### Step 2: Restore files (if requested)
```bash
# Copy files to customer's storage path
CUSTOMER_ID="acme-corp"
BACKUP_DATE="2026-03-23"

rsync -av --progress \
  /mnt/backup/customers/$CUSTOMER_ID/$BACKUP_DATE/files/ \
  /storage/customers/$CUSTOMER_ID/

# Fix permissions
chown -R 33:33 /storage/customers/$CUSTOMER_ID/  # www-data
```

### Step 3: Restore database (if requested)
```bash
DB_NAME="customer_${CUSTOMER_ID}"
DUMP_FILE="/mnt/backup/customers/$CUSTOMER_ID/$BACKUP_DATE/databases/$DB_NAME.sql.gz"

# Decrypt if encrypted
openssl enc -aes-256-cbc -d -in $DUMP_FILE.enc -out $DUMP_FILE -pass file:/etc/backup/encryption.key

# Restore
gunzip -c $DUMP_FILE | kubectl -n platform exec -i <mariadb-pod> -- \
  mysql -u root -p$MARIADB_ROOT_PASSWORD $DB_NAME
```

### Step 4: Restore email (if requested)
```bash
# Email data is per-domain in the Docker-Mailserver volume backup
rsync -av \
  /mnt/backup/customers/$CUSTOMER_ID/$BACKUP_DATE/email/ \
  /var/mail/vhosts/$CUSTOMER_DOMAIN/

# Restart Dovecot to pick up restored mailboxes
kubectl -n mail rollout restart deployment/docker-mailserver
```

### Step 5: Verify and cleanup
```bash
# Verify site works
curl -I https://customer-domain.com

# Unmount backup
fusermount -u /mnt/backup

# Log the restore in audit trail
# (Management API should have a POST /api/v1/admin/audit endpoint)
```

---

## 3. Disk Approaching Capacity

**Trigger:** Alert fires when node disk usage exceeds 70%.

### Step 1: Identify largest consumers
```bash
# Overall disk usage
df -h /

# Largest directories
du -sh /var/lib/rancher/k3s/* | sort -rh | head -10
du -sh /var/lib/containerd/* | sort -rh | head -5
du -sh /storage/customers/* | sort -rh | head -10
```

### Step 2: Quick wins (safe to do immediately)

| Action | Command | Expected Savings |
|--------|---------|-----------------|
| Clean containerd images | `crictl rmi --prune` | 2-10 GB |
| Clean k3s container logs | `find /var/log/pods -name "*.log" -mtime +7 -delete` | 1-5 GB |
| Compact Prometheus TSDB | Reduce retention: `--storage.tsdb.retention.time=3d` | 2-5 GB |
| Trim Loki chunks | Reduce retention: `retention_period: 7d` | 1-3 GB |

### Step 3: Customer-level cleanup
```bash
# Find customers exceeding their quota
for dir in /storage/customers/*/; do
  CUSTOMER=$(basename $dir)
  SIZE=$(du -sm "$dir" | cut -f1)
  echo "$CUSTOMER: ${SIZE}MB"
done | sort -t: -k2 -rn | head -20
```

### Step 4: If still critical (>90%)
1. Attach a Hetzner Volume (€0.04/GB/month) as additional storage
2. Move customer data to the new volume
3. Update PVC paths
4. Long-term: add a second node or upgrade to larger instance

---

## 4. External Service Unreachable (DNS/OIDC/NetBird)

**Trigger:** Health check alert fires for PowerDNS API, OIDC provider, or NetBird mesh.

### PowerDNS API unreachable
```bash
# Test connectivity
curl -s -o /dev/null -w "%{http_code}" \
  -H "X-API-Key: $PDNS_API_KEY" \
  "$PDNS_API_URL/api/v1/servers/localhost"
# Expected: 200
```

**Impact:** New domain provisioning and DNS record changes will fail. Existing domains continue to resolve (DNS is cached and served by external ns1/ns2).

**Action:**
1. Check if the infrastructure project's ns1/ns2 are reachable
2. Contact infrastructure project operator
3. Operations queued by circuit breaker will auto-retry when API is back

### OIDC provider unreachable
```bash
curl -s "$OIDC_ISSUER_URL/.well-known/openid-configuration"
```

**Impact:** New logins fail. Existing sessions with valid JWTs continue working (up to 1hr token lifetime). JWKS cache is valid for 1hr.

**Action:**
1. If OIDC is down < 1 hour: no user impact for existing sessions
2. If OIDC is down > 1 hour: JWKS cache expires, ALL authentication fails
3. Emergency: Use break-glass admin account (configured in OIDC provider)
4. Contact infrastructure project operator

### NetBird mesh unreachable
```bash
netbird status
# Check peer connectivity
netbird status --detail
```

**Impact:** Admin cannot SSH to node or access k8s API remotely. The platform itself continues serving customer traffic.

**Action:**
1. If you have physical/console access: connect via Hetzner Cloud Console
2. The platform continues running — this only affects admin access
3. Contact infrastructure project operator

---

## 5. MariaDB Slow Queries Impacting Clients

**Trigger:** Alert fires for high query latency, or multiple customers report slow page loads.

### Step 1: Identify slow queries
```bash
kubectl -n platform exec -it <mariadb-pod> -- mysql -u root -p -e "
  SELECT * FROM information_schema.PROCESSLIST
  WHERE TIME > 5 ORDER BY TIME DESC;
"
```

### Step 2: Check query log
```bash
kubectl -n platform exec -it <mariadb-pod> -- mysql -u root -p -e "
  SELECT start_time, user_host, query_time, rows_examined, db, sql_text
  FROM mysql.slow_log
  ORDER BY start_time DESC LIMIT 20;
"
```

### Step 3: Identify the culprit customer
```bash
# Check which customer database is generating the most load
kubectl -n platform exec -it <mariadb-pod> -- mysql -u root -p -e "
  SELECT db, COUNT(*) as queries, AVG(TIME) as avg_time
  FROM information_schema.PROCESSLIST
  GROUP BY db ORDER BY queries DESC;
"
```

### Step 4: Immediate remediation

| Situation | Action |
|-----------|--------|
| Single long-running query | `KILL <process_id>;` |
| Customer running heavy import | Contact customer, suggest off-peak |
| Missing index | Add index: `CREATE INDEX idx_x ON table(column);` |
| Table lock contention | Check for `ALTER TABLE` or `OPTIMIZE TABLE` running |
| Connection saturation | Check ProxySQL stats: `SELECT * FROM stats.stats_mysql_connection_pool;` |

### Step 5: If database is completely unresponsive
```bash
# Restart MariaDB (last resort — causes brief downtime for all customers)
kubectl -n platform rollout restart statefulset/mariadb

# If pod won't start (disk full, corrupted data):
# 1. Check disk: df -h
# 2. Check MariaDB logs: kubectl -n platform logs mariadb-0 --tail=100
# 3. If corrupted: restore from last backup (see Runbook #2)
```

---

## Quick Reference

| Runbook | When to Use | Severity |
|---------|-------------|----------|
| #1 Site Down | Customer reports outage | P1 |
| #2 Customer Restore | Data recovery request | P2 |
| #3 Disk Capacity | Disk alert at 70%+ | P2 |
| #4 External Service | Health check alert | P1 (OIDC), P2 (DNS/NetBird) |
| #5 Slow Queries | Performance degradation | P1 |
