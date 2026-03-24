# Event Logging & Audit Strategy

**Status:** Pre-Phase 1 Planning  
**Last Updated:** March 3, 2026  
**Owner:** Security & Compliance Team

## Overview

Comprehensive event logging ensures:
- **Compliance** - GDPR, PCI-DSS, SOC 2 audit trails
- **Debugging** - Trace issues across system components
- **Security** - Detect and investigate suspicious activity
- **Analytics** - Understand usage patterns

---

## Event Taxonomy

### Categories

#### 1. Authentication Events (AUTH)

| Event | Code | Severity | Fields |
| --- | --- | --- | --- |
| Login Success | `AUTH_LOGIN_SUCCESS` | INFO | user_id, ip, user_agent, mfa |
| Login Failed | `AUTH_LOGIN_FAILED` | WARNING | email, ip, reason |
| Token Refresh | `AUTH_TOKEN_REFRESH` | DEBUG | user_id |
| Logout | `AUTH_LOGOUT` | DEBUG | user_id |
| Password Changed | `AUTH_PASSWORD_CHANGED` | INFO | user_id, actor_id |
| Password Reset | `AUTH_PASSWORD_RESET` | INFO | user_id, actor_id |
| Email Verified | `AUTH_EMAIL_VERIFIED` | DEBUG | user_id |
| MFA Enabled | `AUTH_MFA_ENABLED` | INFO | user_id, mfa_method |
| MFA Disabled | `AUTH_MFA_DISABLED` | WARNING | user_id, actor_id |
| Account Locked | `AUTH_ACCOUNT_LOCKED` | WARNING | user_id, reason |

#### 2. Authorization Events (AUTHZ)

| Event | Code | Severity | Fields |
| --- | --- | --- | --- |
| Permission Granted | `AUTHZ_PERMISSION_GRANTED` | DEBUG | user_id, permission, scope |
| Permission Denied | `AUTHZ_PERMISSION_DENIED` | INFO | user_id, permission, resource_id |
| Role Assigned | `AUTHZ_ROLE_ASSIGNED` | INFO | user_id, role_id, scope |
| Role Revoked | `AUTHZ_ROLE_REVOKED` | INFO | user_id, role_id, scope |
| Privilege Escalation | `AUTHZ_PRIVILEGE_ESCALATION` | CRITICAL | user_id, from_role, to_role |

#### 3. Resource Management Events (RESOURCE)

| Event | Code | Severity | Fields |
| --- | --- | --- | --- |
| Client Created | `RESOURCE_CLIENT_CREATED` | INFO | client_id, created_by, plan |
| Client Updated | `RESOURCE_CLIENT_UPDATED` | INFO | client_id, changed_fields |
| Client Suspended | `RESOURCE_CLIENT_SUSPENDED` | WARNING | client_id, reason |
| Client Deleted | `RESOURCE_CLIENT_DELETED` | WARNING | client_id, deleted_by |
| Workload Created | `RESOURCE_WORKLOAD_CREATED` | INFO | workload_id, client_id |
| Workload Updated | `RESOURCE_WORKLOAD_UPDATED` | INFO | workload_id, changed_fields |
| Workload Deleted | `RESOURCE_WORKLOAD_DELETED` | INFO | workload_id |
| Workload Started | `RESOURCE_WORKLOAD_STARTED` | DEBUG | workload_id |
| Workload Stopped | `RESOURCE_WORKLOAD_STOPPED` | DEBUG | workload_id |
| Domain Created | `RESOURCE_DOMAIN_CREATED` | INFO | domain_id, domain_name |
| Domain Verified | `RESOURCE_DOMAIN_VERIFIED` | INFO | domain_id |
| Database Created | `RESOURCE_DATABASE_CREATED` | INFO | database_id, type |
| Database Deleted | `RESOURCE_DATABASE_DELETED` | INFO | database_id |
| Backup Created | `RESOURCE_BACKUP_CREATED` | INFO | backup_id, resource_type |
| Backup Restored | `RESOURCE_BACKUP_RESTORED` | WARNING | backup_id, restored_to |

#### 4. Data Access Events (DATA)

| Event | Code | Severity | Fields |
| --- | --- | --- | --- |
| Data Exported | `DATA_EXPORT` | WARNING | resource_type, count, format, exported_by |
| Data Imported | `DATA_IMPORT` | WARNING | resource_type, count, imported_by |
| Bulk Delete | `DATA_BULK_DELETE` | WARNING | resource_type, count, deleted_by |
| Sensitive Data Accessed | `DATA_SENSITIVE_ACCESSED` | INFO | field_name, accessed_by, access_type |

#### 5. Configuration Events (CONFIG)

| Event | Code | Severity | Fields |
| --- | --- | --- | --- |
| Plan Changed | `CONFIG_PLAN_CHANGED` | INFO | client_id, from_plan, to_plan |
| Settings Updated | `CONFIG_SETTINGS_UPDATED` | INFO | setting_name, from_value, to_value |
| Webhook Added | `CONFIG_WEBHOOK_ADDED` | INFO | webhook_id, events |
| Webhook Deleted | `CONFIG_WEBHOOK_DELETED` | INFO | webhook_id |
| Branding Updated | `CONFIG_BRANDING_UPDATED` | INFO | client_id, changed_fields |

#### 6. System Events (SYSTEM)

| Event | Code | Severity | Fields |
| --- | --- | --- | --- |
| Backup Completed | `SYSTEM_BACKUP_COMPLETED` | DEBUG | backup_id, duration_ms, size_bytes |
| Backup Failed | `SYSTEM_BACKUP_FAILED` | ERROR | backup_id, error_reason |
| Database Migration | `SYSTEM_DB_MIGRATION` | INFO | migration_id, duration_ms |
| API Error | `SYSTEM_API_ERROR` | ERROR | endpoint, error_code, error_msg |
| Rate Limit Hit | `SYSTEM_RATE_LIMIT_HIT` | WARNING | client_id, limit_type |
| Certificate Renewed | `SYSTEM_CERT_RENEWED` | INFO | domain_id |

#### 7. Security Events (SECURITY)

| Event | Code | Severity | Fields |
| --- | --- | --- | --- |
| SQL Injection Detected | `SECURITY_SQL_INJECTION` | CRITICAL | endpoint, query_param |
| Cross-Site Scripting | `SECURITY_XSS_DETECTED` | CRITICAL | endpoint, payload |
| DDoS Detected | `SECURITY_DDOS_DETECTED` | CRITICAL | source_ip, request_rate |
| Suspicious API Usage | `SECURITY_SUSPICIOUS_API` | WARNING | client_id, reason |
| Failed MFA Attempts | `SECURITY_MFA_FAILED` | WARNING | user_id, attempt_count |
| Unauthorized Access Attempt | `SECURITY_UNAUTHORIZED_ACCESS` | WARNING | resource_id, ip_address |
| Certificate Error | `SECURITY_CERT_ERROR` | ERROR | domain, error_type |

#### 8. Integration Events (INTEGRATION)

| Event | Code | Severity | Fields |
| --- | --- | --- | --- |
| Billing Sync | `INTEGRATION_BILLING_SYNC` | INFO | sync_id, records_processed |
| DNS Update | `INTEGRATION_DNS_UPDATE` | INFO | domain_id, record_count |
| External API Call | `INTEGRATION_API_CALL` | DEBUG | api_name, status_code |
| Webhook Delivery | `INTEGRATION_WEBHOOK_DELIVERY` | DEBUG | webhook_id, status |

---

## Log Entry Structure

```json
{
  "id": "evt-123456",
  "timestamp": "2026-01-15T10:30:45.123Z",
  "event_type": "RESOURCE_WORKLOAD_CREATED",
  "category": "RESOURCE",
  "severity": "INFO",
  "actor": {
    "id": "user-123",
    "type": "user",
    "email": "admin@example.com",
    "ip_address": "192.168.1.1",
    "user_agent": "Mozilla/5.0..."
  },
  "client_id": "client-456",
  "resource": {
    "type": "workload",
    "id": "workload-789",
    "name": "my-app",
    "changes": {
      "before": null,
      "after": {
        "name": "my-app",
        "status": "pending"
      }
    }
  },
  "action": {
    "type": "create",
    "status": "success",
    "error": null
  },
  "metadata": {
    "api_endpoint": "POST /api/workloads",
    "request_id": "req-xyz",
    "duration_ms": 234,
    "tags": ["api", "workload"]
  }
}
```

---

## Log Capture Points

### 1. Authentication Layer

```typescript
// Login endpoint
app.post('/auth/login', async (req, reply) => {
  try {
    const user = await authenticate(req.body);
    
    await logEvent({
      event_type: 'AUTH_LOGIN_SUCCESS',
      severity: 'INFO',
      actor: { id: user.id, type: 'user' },
      action: { type: 'login', status: 'success' }
    });
    
    return { token: generateToken(user) };
  } catch (error) {
    await logEvent({
      event_type: 'AUTH_LOGIN_FAILED',
      severity: 'WARNING',
      action: { type: 'login', status: 'failure', error: error.message }
    });
    throw error;
  }
});
```

### 2. Authorization Middleware

```typescript
app.use(async (request, reply, next) => {
  const requiredPermission = getRequiredPermission(request.path);
  const hasPermission = checkPermission(
    request.user,
    requiredPermission
  );

  if (!hasPermission) {
    await logEvent({
      event_type: 'AUTHZ_PERMISSION_DENIED',
      severity: 'INFO',
      actor: { id: request.user.id },
      resource: { type: 'endpoint', id: request.path },
      action: { type: 'access', status: 'failure' }
    });
    
    throw new ApiError('INSUFFICIENT_PERMISSIONS', ..., 403);
  }
});
```

### 3. Resource Operations

```typescript
app.post('/api/workloads', authorize('workloads:create:own'), async (req, reply) => {
  const workload = await createWorkload(req.body, req.user.tenant_id);

  await logEvent({
    event_type: 'RESOURCE_WORKLOAD_CREATED',
    severity: 'INFO',
    actor: { id: req.user.id },
    client_id: req.user.tenant_id,
    resource: {
      type: 'workload',
      id: workload.id,
      name: workload.name,
      changes: { before: null, after: workload }
    },
    action: { type: 'create', status: 'success' }
  });

  return workload;
});
```

### 4. Data Access

```typescript
app.get('/api/clients/:id/export', authorize('clients:export:own'), async (req, reply) => {
  const data = await exportClient(req.params.id, req.query.format);

  await logEvent({
    event_type: 'DATA_EXPORT',
    severity: 'WARNING',
    actor: { id: req.user.id },
    resource: {
      type: 'client',
      id: req.params.id
    },
    metadata: {
      format: req.query.format,
      data_size: data.length
    }
  });

  return data;
});
```

---

## Retention Policy

| Event Type | Retention | Storage |
| --- | --- | --- |
| Authentication | 1 year | Hot (active database) |
| Authorization | 1 year | Hot |
| Resource Changes | 7 years | Hot (first 90 days), Cold (archive after) |
| Data Access | 1 year | Hot (90 days), Archive (rest) |
| Security Events | 2 years | Hot (first year), Cold (second year) |
| System Events | 90 days | Hot |

### Archive Strategy

```bash
# Monthly archive job
Events older than 90 days → offsite backup server (cold storage)
Keep searchable index in hot database for 1 year
Move to long-term archive (offsite server deep archive) after 1 year
```

---

## Querying & Analysis

### Sample Queries

```sql
-- Recent login failures (security investigation)
SELECT * FROM audit_logs
WHERE event_type = 'AUTH_LOGIN_FAILED'
  AND timestamp > DATE_SUB(NOW(), INTERVAL 24 HOUR)
ORDER BY timestamp DESC;

-- Who accessed sensitive data
SELECT * FROM audit_logs
WHERE event_type LIKE 'DATA_%'
  AND client_id = 'client-123'
  AND timestamp > DATE_SUB(NOW(), INTERVAL 30 DAY);

-- Workload creation timeline
SELECT
  actor_id,
  COUNT(*) as count,
  DATE(timestamp) as date
FROM audit_logs
WHERE event_type = 'RESOURCE_WORKLOAD_CREATED'
  AND client_id = 'client-123'
GROUP BY DATE(timestamp), actor_id;

-- Failed operations (errors)
SELECT * FROM audit_logs
WHERE action_status = 'failure'
  AND timestamp > DATE_SUB(NOW(), INTERVAL 7 DAY)
ORDER BY severity DESC, timestamp DESC;
```

---

## Log Querying API

```
GET /api/audit-logs?
  event_type=RESOURCE_WORKLOAD_CREATED
  &severity=INFO,WARNING,ERROR
  &actor_id=user-123
  &resource_type=workload
  &from=2026-01-01&to=2026-01-31
  &limit=50

Response:
{
  "data": [
    {
      "id": "evt-123456",
      "timestamp": "2026-01-15T10:30:45Z",
      "event_type": "RESOURCE_WORKLOAD_CREATED",
      ...
    }
  ],
  "pagination": {...}
}
```

---

## Compliance & Export

### GDPR Data Subject Access

```typescript
// User requests all their data
app.post('/api/gdpr/data-export/:user_id', authorize('users:gdpr:own'), async (req, reply) => {
  const events = await getAuditLogs({
    actor_id: req.params.user_id,
    all_time: true
  });

  const report = {
    data_subject: req.params.user_id,
    export_date: new Date().toISOString(),
    events: events,
    count: events.length
  };

  await logEvent({
    event_type: 'DATA_GDPR_EXPORT',
    severity: 'WARNING',
    resource: { type: 'user', id: req.params.user_id }
  });

  return report;
});
```

### Audit Report Generation

```sql
-- Monthly audit report for compliance
SELECT
  event_type,
  severity,
  COUNT(*) as count,
  COUNT(DISTINCT actor_id) as unique_actors,
  COUNT(DISTINCT client_id) as unique_clients
FROM audit_logs
WHERE timestamp >= DATE_TRUNC('month', NOW())
GROUP BY event_type, severity
ORDER BY count DESC;
```

---

## Performance Optimization

### Partitioning

```sql
-- Partition by client_id and month for fast queries
CREATE TABLE audit_logs (
  ...
) PARTITION BY RANGE (YEAR_MONTH(timestamp)) (
  PARTITION p_202601 VALUES LESS THAN (202602),
  PARTITION p_202602 VALUES LESS THAN (202603),
  ...
);
```

### Indexing

```sql
-- Composite indexes for common queries
CREATE INDEX idx_event_timestamp ON audit_logs (event_type, timestamp DESC);
CREATE INDEX idx_actor_client ON audit_logs (actor_id, client_id, timestamp DESC);
CREATE INDEX idx_resource ON audit_logs (resource_type, resource_id);
```

### Caching

```typescript
// Cache recent events for dashboard
const recentEvents = await cache.get('audit:recent:24h');
if (!recentEvents) {
  recentEvents = await db.auditLogs.find({
    timestamp: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
  }).limit(100);
  await cache.set('audit:recent:24h', recentEvents, { ttl: 300 });
}
```

---

## Security Considerations

### Prevent Log Tampering

```sql
-- Immutable audit logs (PostgreSQL)
CREATE TABLE audit_logs (
  ...
) WITH (security_definer = true);

-- Prevent DELETE operations
REVOKE DELETE ON audit_logs FROM app_user;
REVOKE UPDATE ON audit_logs FROM app_user;

-- Only append-only writes
GRANT INSERT ON audit_logs TO app_user;
```

### Redact Sensitive Data

```typescript
// Don't log passwords, tokens, keys
const redactedLog = {
  ...event,
  metadata: {
    ...event.metadata,
    api_token: '***REDACTED***',
    password: '***REDACTED***'
  }
};
```

---

## Monitoring & Alerts

### Alert Rules

```yaml
Alert: High Failed Login Rate
Rule: COUNT(AUTH_LOGIN_FAILED) > 10 in 5 minutes
Severity: CRITICAL
Action: Notify security team, temporarily block IP

Alert: Unusual API Usage
Rule: API request rate > 1000/minute for client
Severity: WARNING
Action: Notify ops team, log suspicious event

Alert: Privilege Escalation
Rule: Any AUTHZ_PRIVILEGE_ESCALATION event
Severity: CRITICAL
Action: Immediate notification to admins
```

---

## Dashboard Metrics

```
Real-time Security Dashboard:
- Login failures (last hour): 23 (🔴 ALERT if > 50)
- Failed permission checks: 156
- Unusual API usage: 3 clients
- Security events (critical): 0
- Data exports (last 24h): 12
- Bulk operations: 5
```

---

## Testing

```typescript
describe('Event Logging', () => {
  it('should log successful login', async () => {
    await login(validCredentials);
    const events = await getEvents({ event_type: 'AUTH_LOGIN_SUCCESS' });
    expect(events).toHaveLength(1);
  });

  it('should redact sensitive data', async () => {
    const event = await getEvent(eventId);
    expect(event.metadata.api_token).toBe('***REDACTED***');
  });

  it('should partition logs by month', async () => {
    // Verify old logs are in archive table
    expect(await getOldLogs()).toHaveLength(0);
    expect(await getArchivedLogs()).toBeGreaterThan(0);
  });
});
```

---

## Checklist

- [ ] Define all event types and taxonomy
- [ ] Implement log capture middleware
- [ ] Create audit_logs table with partitioning
- [ ] Add log retention policy
- [ ] Implement log querying API
- [ ] Set up log archival process
- [ ] Add compliance export functionality
- [ ] Configure monitoring and alerts
- [ ] Create security dashboard
- [ ] Test log immutability
- [ ] Performance test log queries

---

## References

- GDPR Article 33 (Notification of Personal Data Breach): https://gdpr-info.eu/art-33-gdpr/
- PCI-DSS Requirement 10 (Logging & Monitoring): https://www.pcisecuritystandards.org/
- SOC 2 Audit Logging: https://www.aicpa.org/interestareas/informationmanagement/soce2
