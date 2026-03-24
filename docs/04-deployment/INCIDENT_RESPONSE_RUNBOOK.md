# Incident Response Runbook

**Document Version:** 1.0  
**Last Updated:** 2026-03-01  
**Status:** DRAFT — Ready for implementation  
**Audience:** On-call engineers, operations team, incident commanders

---

## Overview

This runbook defines procedures for responding to incidents affecting the Kubernetes Web Hosting Platform. It covers:
- On-call rotation and escalation paths
- Incident severity classification
- Response procedures (detection → diagnosis → recovery)
- Communication templates for customers
- Post-incident review process

**On-Call Schedule:** Business hours only (MVP) — no 24/7 on-call initially. Rotating 1-week primary responsibility.  
**Escalation Path:** On-call → Team Lead → Engineering Manager → CTO  
**SLA Targets:** P1: 15min response (business hours), P2: 1hr, P3: 4hrs  
**Note:** 24/7 on-call rotation planned for Phase 2 when team size and customer base justify it. Critical alerts (P1) outside business hours rely on automated alerting to personal devices (PagerDuty).

---

## On-Call Rotation and Contact Information

### On-Call Schedule

**Primary On-Call:** Responds to all alerts, owns incident response  
**Secondary On-Call:** Escalation point if primary is unavailable  
**Manager On-Call:** Final escalation for business/customer decisions

```
Week 1 (Feb 28 - Mar 6):
  Primary:   alice@company.com (Slack: @alice)
  Secondary: bob@company.com   (Slack: @bob)
  Manager:   charlie@company.com (Slack: @charlie)

Week 2 (Mar 7 - Mar 13):
  Primary:   bob@company.com
  Secondary: charlie@company.com
  Manager:   alice@company.com
```

**Update:** Rotation managed in PagerDuty (https://company.pagerduty.com)

### Escalation Path

```
Alert triggered
       ↓
PagerDuty pages primary on-call
       ↓
[Primary responds within 5 minutes]
       ↓
      YES ─→ Incident Commander takes lead
       ↓
       NO (5 min elapsed)
       ↓
PagerDuty pages secondary on-call
       ↓
[Secondary responds within 5 minutes]
       ↓
      YES ─→ Incident Commander takes lead
       ↓
       NO (10 min elapsed)
       ↓
PagerDuty pages manager on-call
       ↓
Manager escalates to engineering team
```

### Communication During Incidents

- **Primary channel:** Slack #incidents (mandatory for all on-call)
- **Customer notification:** See "Notification Templates" section
- **Status page:** https://status.company.com (auto-updated from incidents)
- **Post-incident:** Incident review meeting scheduled within 24 hours

---

## Incident Severity Classification

| Level | Name | SLA Response | SLA Resolution | Criteria |
|-------|------|--------------|-----------------|----------|
| **P1** | Critical | 15 minutes | 1 hour | Total platform down, data loss, security breach |
| **P2** | Major | 1 hour | 4 hours | Service degradation, single customer down, 10%+ error rate |
| **P3** | Minor | 4 hours | 24 hours | Single feature broken, <1% error rate, workaround available |
| **P4** | Trivial | 24 hours | 1 week | Documentation, cosmetic, affects < 100 users |

### Severity Examples

**P1 Incidents:**
- All clusters down (unable to serve any traffic)
- Database corruption affecting multiple customers
- Security breach (credentials exposed, unauthorized access)
- Data loss affecting 10+ customers
- Payment/billing system down

**P2 Incidents:**
- Single region unavailable (Starter customers unable to access)
- Single customer database down
- NGINX reverse proxy failing, 30% error rate
- Authentication (OIDC) failures for 1-2 hours
- Email service down

**P3 Incidents:**
- Single domain not resolving (PowerDNS lag)
- Backup job failing for one customer
- API slow (response time > 2sec)
- One container catalog image unavailable
- Non-critical monitoring down

**P4 Incidents:**
- Typo in documentation
- Missing non-essential feature
- Cosmetic UI bug
- Spam in system logs

---

## Response Procedures by Incident Type

### 1. Total Platform Outage (P1)

**Detection:** Downtime alert, multiple customers calling in, status page red

**Timeline:**

| Time | Action | Owner |
|------|--------|-------|
| T+0 | Alert fires in PagerDuty → On-call notified | Monitoring system |
| T+1 | On-call joins Slack #incidents, assesses situation | Primary on-call |
| T+2 | On-call starts incident in incident management tool, gathers logs | Primary on-call |
| T+3 | Possible root causes identified → Begin targeted investigation | Primary on-call |
| T+5 | If still unknown, page secondary on-call for help | Primary on-call |
| T+10 | Page manager if not yet resolved | Secondary on-call |
| T+15 | Post first customer notification (see templates) | Manager on-call |
| T+30 | Status page update: "Investigating" | Incident Commander |
| T+60 | Target resolution time reached — escalate further if needed | Manager on-call |

**Root Cause Examples & Recovery:**

1. **Kubernetes API Server Down**
   ```bash
   # Check API server status
   kubectl get nodes  # May fail
   
   # If API is down, manually check node status
   ssh node1 "systemctl status kubelet"
   
   # Restart API server
   kubectl delete pod -n kube-system kube-apiserver-node1
   # (New pod will start automatically)
   
   # Verify cluster is healthy
   kubectl cluster-info
   kubectl get nodes
   kubectl get pods --all-namespaces
   ```

2. **Etcd Database Corruption**
   ```bash
   # Check etcd health
   kubectl -n kube-system get pods | grep etcd
   kubectl -n kube-system logs -f etcd-node1
   
   # If corrupted, restore from backup
   kubectl -n kube-system exec -it etcd-node1 -- etcdctl --endpoints=127.0.0.1:2379 member list
   
   # Restore from snapshot
   ETCD_DATA_DIR=/var/lib/etcd
   etcdctl snapshot restore /backups/etcd-$(date +%Y%m%d).db \
     --data-dir=$ETCD_DATA_DIR
   systemctl restart etcd
   ```

3. **All Nodes Out of Memory**
   ```bash
   # Check node memory
   kubectl top nodes
   kubectl describe node node1 | grep -i memory
   
   # Evict non-critical pods to free memory
   kubectl delete deployment --namespace monitoring prometheus
   # (Non-critical monitoring, can be restarted)
   
   # Kill stuck processes
   kubectl delete pods -n hosting shared-php-01
   # (Pod will restart, existing connections will reconnect)
   
   # Add more memory or new nodes
   aws ec2 modify-instance-attribute --instance-id i-1234567890 --instance-type m5.2xlarge
   ```

---

### 2. Database Failure (P1-P2)

**Detection:** DB connection errors, SQL query timeouts, replication lag alerts

**Timeline:**

| Time | Action |
|------|--------|
| T+0 | Alert "Database unreachable" fires |
| T+1 | Check database pod status and logs |
| T+5 | Determine: primary down? replication lag? connection pool exhausted? |
| T+10 | If primary down: failover to replica. If lag: wait or force sync. |
| T+15 | Verify customers can connect, post notification |

**Procedures:**

1. **Primary Database Down (MariaDB)**
   ```bash
   # Check primary status
   kubectl get pod -n hosting percona-mysql-0 -o yaml
   
   # Check pod logs
   kubectl logs -f pod/percona-mysql-0
   
   # If pod crashed, check disk space
   df -h /var/lib/mysql
   
   # If healthy, restart pod
   kubectl delete pod percona-mysql-0 -n hosting
   # (StatefulSet will restart it)
   
   # If truly down, failover to secondary
   kubectl exec -it percona-mysql-1 -c mysql -- mysql -u root -p$ROOT_PASS \
     -e "STOP SLAVE; SET GLOBAL read_only=OFF;"
   
   # Update connection string in all apps to point to secondary
   # (Perform rolling restart of app deployments)
   kubectl rollout restart deployment/management-api
   ```

2. **High Replication Lag**
   ```bash
   # Check replication status
   kubectl exec -it percona-mysql-1 -c mysql -- mysql -u root -p$ROOT_PASS \
     -e "SHOW SLAVE STATUS\G"
   
   # Check seconds_behind_master
   # If > 3600 seconds (1 hour), issue warning to customers
   
   # If > 86400 seconds (24 hours), block writes to primary
   # and failover to secondary
   
   # Cause: typically slow queries, apply thread can't keep up
   # Solution: 
   # 1. Kill long-running queries on primary
   # 2. Check slow query log
   # 3. Wait for secondary to catch up
   # 4. Monitor with: SHOW SLAVE STATUS\G (check Seconds_Behind_Master)
   ```

3. **Connection Pool Exhausted**
   ```bash
   # Check active connections
   kubectl exec -it percona-mysql-0 -c mysql -- mysql -u root -p$ROOT_PASS \
     -e "SHOW STATUS WHERE variable_name = 'Threads_connected';"
   
   # If close to max_connections (default 100):
   # Kill idle connections
   kubectl exec -it percona-mysql-0 -c mysql -- mysql -u root -p$ROOT_PASS \
     -e "SELECT * FROM INFORMATION_SCHEMA.PROCESSLIST WHERE COMMAND='Sleep' LIMIT 5;"
   
   # Increase max_connections
   kubectl patch statefulset percona-mysql -n hosting --type merge \
     -p '{"spec":{"template":{"spec":{"containers":[{"name":"mysql","env":[{"name":"MYSQL_MAX_CONNECTIONS","value":"200"}]}]}}}}'
   
   # Restart pods with new limit
   kubectl rollout restart statefulset/percona-mysql
   ```

---

### 3. DNS Failures (P2-P3)

**Detection:** Zone doesn't resolve, PowerDNS API errors, customer reports "domain not working"

**Procedure:**

```bash
# PowerDNS runs in Docker Compose on ns1 (23.88.111.142) and ns2 (89.167.125.29).
# SSH to these nodes via NetBird WireGuard mesh.

# Step 1: Verify zone exists on ns1
dig @23.88.111.142 customer.com A +short

# If no response, check zone exists in ns1 API (run on ns1 via NetBird mesh SSH)
curl -H "X-API-Key: $PDNS_API_KEY" http://127.0.0.1:8081/api/v1/zones/customer.com.

# Check PowerDNS container status on ns1
ssh admin@23.88.111.142  # via NetBird mesh
docker compose -f /opt/powerdns/docker-compose.yml ps
docker compose -f /opt/powerdns/docker-compose.yml logs pdns --tail=50

# Step 2: If zone exists on ns1 but not on ns2, trigger NOTIFY:
# (run on ns1)
docker compose -f /opt/powerdns/docker-compose.yml exec pdns \
  pdns_control notify customer.com.

# Check ns2 received the zone (< 5 seconds)
dig @89.167.125.29 customer.com A +short

# Step 3: If still failing, restart containers
ssh admin@23.88.111.142
docker compose -f /opt/powerdns/docker-compose.yml restart pdns

ssh admin@89.167.125.29
docker compose -f /opt/powerdns/docker-compose.yml restart pdns
```

---

### 4. Authentication/OIDC Failures (P2)

**Detection:** Users can't log in, "Invalid token" errors in logs, OIDC provider timeout

**Procedure:**

```bash
# Check Dex pod status
kubectl get pod -n auth dex-0 -o yaml
kubectl logs -f pod/dex-0 -n auth

# Test Dex health
curl -s http://dex.auth.svc.cluster.local:5556/.well-known/openid-configuration | jq .

# If Dex failing:
# Check database (PostgreSQL)
kubectl logs -f pod/postgres-auth-0 -n auth

# Restart Dex
kubectl delete pod dex-0 -n auth

# If tokens failing:
# Check signing keys
kubectl get secret dex-keys -n auth -o yaml | grep -A 5 keys

# Rotate keys if compromised
kubectl delete secret dex-keys -n auth
# Dex will auto-generate new ones on startup
```

---

### 5. Email Service Failures (P2)

**Detection:** "Mail delivery failed", bounce-back emails, "SMTP connection refused"

**Procedure:**

```bash
# Check Docker-Mailserver pod
kubectl get pod -n hosting docker-mailserver-0
kubectl logs -f pod/docker-mailserver-0 -n hosting

# Check SMTP connectivity
kubectl exec -it docker-mailserver-0 -n hosting -- \
  telnet localhost 25  # Should connect

# Test mail delivery
echo "test" | kubectl exec -i docker-mailserver-0 -n hosting -- \
  sendmail test@example.com

# Check mail queue
kubectl exec -it docker-mailserver-0 -n hosting -- \
  sendmail -q -Ac -C/etc/ssmtp/ssmtp.conf

# If stuck in queue, flush it
kubectl exec -it docker-mailserver-0 -n hosting -- \
  postqueue -f

# If isolated to one domain, check DNS
dig @23.88.111.142 customer.com MX  # Should return mail server (ns1)

# Restart mail server
kubectl delete pod docker-mailserver-0 -n hosting
```

---

## Customer Notification Templates

### Template 1: Initial Notification (P1)

**Send within 15 minutes of detection**

```
Subject: ⚠️ URGENT: Service Degradation - We're Investigating

Dear Valued Customer,

We've detected an issue affecting our platform. We are actively investigating and working on a fix.

Impact: [SELECT ONE]
- Your website may be slow or intermittently unavailable
- Your email service may be delayed
- Your databases may be unreachable
- [SPECIFIC TO YOUR ACCOUNT]

Current Status: Investigating root cause
Estimated Resolution: Within 1 hour

We will update you every 15 minutes with progress. If you have urgent questions, 
please contact support@company.com (Response time: < 30 minutes).

Thank you for your patience.

— Operations Team
```

### Template 2: Update Notification (P1, 30 min in)

```
Subject: Update: Service Investigation - Still Working On It

Dear Customer,

We've made progress identifying the issue. Initial findings point to 
[BRIEF DESCRIPTION, e.g., "database replication lag"].

What We're Doing Now:
1. [Action 1]
2. [Action 2]
3. [Action 3]

Estimated Resolution: [NEW TIME ESTIMATE, e.g., "30 minutes from now"]

We appreciate your patience. Next update in 15 minutes.

— Operations Team
```

### Template 3: Resolution Notification (P1)

```
Subject: ✅ RESOLVED: Service Restored - Full Details Coming

Dear Customer,

The issue has been **RESOLVED as of [TIME] UTC**.

What Happened:
[BRIEF EXPLANATION OF ROOT CAUSE - 2-3 sentences max]

Impact:
- Downtime: [DURATION]
- Affected Customers: [NUMBER or "All"]
- Data Loss: [YES/NO with details]

Resolution:
- We [ACTION TAKEN TO FIX]
- Service is now fully operational

Next Steps:
- If you experienced data issues, please contact us for recovery assistance
- We will post a full incident report at status.company.com within 24 hours
- We will offer [CREDIT/DISCOUNT] for the downtime

Thank you for your patience and understanding.

— Operations Team
```

### Template 4: Post-Incident Report (P1, within 24 hours)

```
Subject: Incident Report - [DATE] Outage

Dear Customer,

Please find attached the detailed incident report for [INCIDENT NAME].

Summary:
- Incident Duration: HH:MM
- Root Cause: [DETAILED EXPLANATION]
- Impact: [SERVICES, CUSTOMERS, DATA AFFECTED]
- Preventive Measures: [WHAT WE'RE DOING TO PREVENT RECURRENCE]

Timeline:
[T+0] Incident detected
[T+15] Root cause identified
[T+30] Fix deployed
[T+45] All services restored

We sincerely apologize for the disruption to your business.

Questions? Reply to support@company.com

— Operations Team
```

---

## Post-Incident Review (PIR) Process

### Timing
- **P1:** Review meeting within 24 hours
- **P2:** Review meeting within 72 hours
- **P3:** Document in Slack, no meeting required
- **P4:** No review required

### Attendees (P1)
- Incident Commander
- On-call engineer who responded
- Manager on-call
- Product/Engineering Lead
- Optional: Customer representative if large outage

### Review Meeting (30-60 minutes)

**Agenda:**

1. **Incident Summary** (5 min)
   - Timeline and duration
   - Services affected
   - Customers impacted

2. **Root Cause Analysis** (15 min)
   - What was the actual problem?
   - Why did monitoring not catch it earlier?
   - How did it escalate?

3. **Resolution** (5 min)
   - What steps fixed it?
   - Could we have fixed it faster?

4. **Preventive Actions** (20 min)
   - What will prevent this in future?
   - New monitoring?
   - Code changes?
   - Runbook improvements?
   - Training needed?

5. **Action Items** (10 min)
   - Assign owners
   - Set deadlines
   - Track in JIRA

### PIR Report Template

```markdown
# Incident Report: [INCIDENT NAME]

**Date:** 2025-03-01  
**Duration:** 45 minutes  
**Severity:** P1 - Critical  
**Incident Commander:** alice@company.com

## Summary
[2-3 sentences describing what happened]

## Timeline
- 14:00 UTC: Alert fired for database connection failures
- 14:05 UTC: On-call identified issue in Percona MariaDB
- 14:15 UTC: Root cause identified: primary database out of disk
- 14:20 UTC: Temporary fix: deleted old binary logs
- 14:25 UTC: Database recovered, services back online
- 14:45 UTC: All customers confirmed functional

## Root Cause
MariaDB primary ran out of disk space due to excessive binary logs.
Cleanup script was disabled 3 months ago but not re-enabled.

## Impact
- 45-minute outage affecting all customers
- $500 estimated cost of lost revenue
- No data loss

## What Went Well
- Monitoring detected immediately (< 2 min)
- Team responded quickly and communicated well
- Clear escalation path worked

## What We Should Improve
- Disk space monitoring was not alerting (alert threshold was 95%)
- Runbook for disk space was not readily available
- Cleanup script disable was not documented

## Preventive Actions
| Action | Owner | Deadline |
|--------|-------|----------|
| Implement disk space alerts at 80% full | DevOps | 2025-03-08 |
| Create and test disk space runbook | alice@company.com | 2025-03-08 |
| Audit all automated scripts for "disabled" status | bob@company.com | 2025-03-15 |
| Add disk space check to weekly health report | charlie@company.com | 2025-03-08 |

## Lessons Learned
- Automated cleanup scripts are critical and must have redundancy
- Alert thresholds were too conservative (95% → 80%)
- Need quarterly runbook reviews to ensure accuracy
```

---

## Escalation and Decision Making

### Decision Authority by Severity

| Decision | P1 | P2 | P3 |
|----------|----|----|-----|
| **Notify customers** | On-call → Manager | On-call | Support team |
| **Service degradation acceptable?** | Manager + CTO | On-call | On-call |
| **Roll back changes** | On-call | On-call | On-call |
| **Take service offline** | Manager + CTO | Manager | On-call |
| **Customer credit/compensation** | CTO | Manager | Support lead |
| **External communication** | CEO | Manager | Support team |

### Example Escalation Scenario

```
On-call detects database failure affecting 30% of customers.
↓
On-call begins recovery (within 10 minutes) ← P2 SLA
↓
Still failing after 20 minutes?
→ Page secondary on-call for assistance
↓
Still failing after 40 minutes?
→ Page manager on-call
→ Manager evaluates: Is recovery too slow? Consider failover to backup cluster.
↓
Still failing after 60 minutes?
→ Page CTO
→ CTO may decide: "Roll back last deployment" or "Fail over entire region"
→ CTO personally calls affected customers to explain
```

---

## On-Call Setup and Tools

### Required Tools
1. **PagerDuty** — On-call scheduling and alerting
2. **Slack** — #incidents channel for coordination
3. **Status Page** — https://status.company.com for customer visibility
4. **Incident Management** — JIRA or similar for tracking
5. **Monitoring** — Prometheus + Grafana dashboards
6. **Logs** — Loki + Grafana centralized logging (see `02-operations/MONITORING_OBSERVABILITY.md`)

### On-Call Checklist

**Before your shift starts:**
- [ ] Confirm PagerDuty shows you as on-call
- [ ] Join Slack #incidents channel
- [ ] Review recent incidents and PRs
- [ ] Know the escalation numbers
- [ ] Have laptop and phone charged

**During your shift:**
- [ ] Monitor #incidents and PagerDuty
- [ ] Keep phone with you
- [ ] If paged, respond within 5 minutes
- [ ] Document all actions in Slack for handoff
- [ ] Check status page updates

**Before handing off:**
- [ ] Brief incoming on-call on any open issues
- [ ] Document status in Slack thread
- [ ] Ensure all tools are accessible to next person

---

## Example Incident Walkthrough

**Scenario:** P2 incident, API slow response times

```
14:00 — Prometheus alert "API response time > 2 sec" triggers
        PagerDuty pages alice (primary on-call)

14:02 — Alice gets notification, joins Slack #incidents
        Posts: "🚨 P2: API slow - investigating"

14:03 — Alice checks Grafana dashboard
        Observes: CPU at 95%, memory at 80%, requests per second normal
        Conclusion: Resource constrained, not traffic surge

14:05 — Alice checks pod status
        $ kubectl top pods -n hosting
        Finds: management-api-0 using 90% of allocated CPU
        
14:07 — Alice reviews recent logs
        $ kubectl logs -f pod/management-api-0 -n hosting | grep -i error
        Sees: Lots of "database connection timeout" errors
        
14:09 — Alice checks database status
        $ kubectl exec -it percona-mysql-0 -c mysql -- \
          mysql -e "SHOW STATUS WHERE variable_name = 'Threads_connected';"
        Result: 95 connections (out of 100 max) — PROBLEM FOUND!
        
14:11 — Alice identifies cause: management-api connection pool misconfigured
        Each pod opened 25 connections instead of expected 5
        
14:12 — Alice updates #incidents: "Root cause found: connection pool leak
        Deploying fix now"
        
14:15 — Alice patches deployment:
        $ kubectl set env deployment/management-api \
          -n hosting DB_POOL_SIZE=5 --record
        Deployment automatically does rolling restart
        
14:18 — Alice monitors metrics: CPU drops to 30%, response time < 100ms
        Incident resolved!
        
14:20 — Alice posts in #incidents: "✅ Resolved - connection pool reduced.
        Will add monitoring and create incident review."
        
14:30 — Customer notification email sent:
        "Brief service degradation resolved, investigating root cause"
        
Next day — PIR meeting scheduled, action items assigned
```

---

## NetBird VPN Failure Runbook

**Severity:** P3 (unless admin access is actively needed during another incident → escalate to P2)

### Detection
- Alert: `NetBirdPrimaryDown` — Management API health check fails on Hetzner VPS
- Alert: `NetBirdSignalDown` — Signal server unreachable (check both primary and secondary)
- Alert: `NetBirdAllRelaysDown` — Both TURN/Relay servers unreachable
- Manual: `netbird status` on admin workstation shows "Disconnected"

### Diagnosis

```bash
# Check NetBird status on admin workstation
netbird status

# Check if WireGuard tunnel is up (P2P persists without server)
sudo wg show

# Ping cluster node via mesh IP (if tunnel is up, this works even without NetBird servers)
ping <cp-node-netbird-ip>
```

### Recovery Steps

**If primary (Hetzner) is down:**
1. Existing tunnels should still work (WireGuard P2P). Verify with `sudo wg show`.
2. Agents auto-failover to secondary Signal/TURN on home server.
3. If management dashboard is needed: access home server dashboard.
4. Investigate/restore Hetzner VPS (reboot, check Docker containers, check disk space).

**If secondary (home) is also down:**
1. Existing P2P tunnels still work. Admin access via already-established mesh is fine.
2. New peer connections cannot be established until at least one Signal server is restored.
3. Restore either server. Priority: Hetzner (closer to cluster).

**If no tunnel exists (new admin workstation or tunnel expired):**
1. Use pre-authenticated NetBird setup key (stored offline) to bootstrap connection.
2. If setup key is expired: generate new one from home server management (if accessible).
3. **Last resort:** Temporarily open SSH (port 22) on Hetzner Cloud Console web UI → SSH to node → fix NetBird → close port 22.

### Post-Recovery
- Verify all mesh peers reconnected: check NetBird dashboard
- Verify backup SSHFS mount can reach backup server via mesh
- Document cause of outage
- If setup key was used: rotate it

---

## Related Documents

- [`../02-operations/MONITORING_OBSERVABILITY.md`](../02-operations/MONITORING_OBSERVABILITY.md) — Alerting rules and thresholds
- [`../05-advanced/DISASTER_RECOVERY.md`](../05-advanced/DISASTER_RECOVERY.md) — Disaster recovery procedures
- [`./DEPLOYMENT_PROCESS.md`](./DEPLOYMENT_PROCESS.md) — Rollback procedures
- [`../03-security/SECURITY_ARCHITECTURE.md`](../03-security/SECURITY_ARCHITECTURE.md) — Security incident procedures, NetBird architecture, break-glass procedure

---

**Status:** Ready for implementation  
**Next Steps:** Set up PagerDuty, define on-call schedule, deploy NetBird infrastructure, customize templates for your team

