# Service Level Indicators & Objectives (SLI/SLO)

**Status:** Pre-Phase 1 Planning  
**Last Updated:** March 3, 2026  
**Owner:** DevOps & Reliability Team

## Overview

SLI/SLO framework ensures platform meets customer expectations:
- **SLI (Indicator):** Measurable metric of system behavior
- **SLO (Objective):** Target value for SLI (e.g., 99.5% uptime)
- **SLO Budget:** Error budget = (1 - SLO%) × total time

---

## Platform SLO Target

### Overall SLO: 99.5%

**What this means:**
- Maximum 3.6 hours downtime per month
- Maximum 43 minutes downtime per week
- Maximum 8.6 minutes downtime per day

**Error Budget:** 10,800 minutes / year (180 hours)

---

## Service Level Indicators (SLIs)

### 1. Availability

**Definition:** Percentage of successful requests (non-5xx errors)

```
SLI = (Successful Requests) / (Total Requests) × 100
Target SLO: 99.5%
```

**Implementation:**
```
prometheus_query: rate(http_requests_total{status=~"[45].."} [5m])
Alert threshold: < 99.5% over 5 minutes
```

### 2. Latency (API Response Time)

**Definition:** Percentage of requests meeting latency target

```
SLI = (Requests < 500ms) / (Total Requests) × 100
Target SLO:
  - p50: < 100ms
  - p95: < 500ms
  - p99: < 1000ms
```

**Implementation:**
```
prometheus_query: histogram_quantile(0.95, http_request_duration_ms)
Alert threshold: p95 > 500ms for 5 minutes
```

### 3. Database Availability

**Definition:** Percentage of successful database connections

```
SLI = (Successful DB Connections) / (Total DB Connection Attempts) × 100
Target SLO: 99.9%
```

**Implementation:**
```
prometheus_query: rate(db_connection_errors_total [5m])
Alert threshold: > 0.1% errors over 5 minutes
```

### 4. Kubernetes Cluster Health

**Definition:** Percentage of available nodes

```
SLI = (Available Nodes) / (Total Nodes) × 100
Target SLO: 99.9%
```

**Implementation:**
```
prometheus_query: kube_node_status_allocatable
Alert threshold: < 99.9% nodes available
```

### 5. Certificate Validity

**Definition:** Percentage of valid TLS certificates

```
SLI = (Valid Certificates) / (Total Certificates) × 100
Target SLO: 100%
```

**Implementation:**
```
prometheus_query: ssl_certificate_expiry_days
Alert threshold: < 14 days before expiry (CRITICAL)
```

---

## Error Budget & Alerting

### Monthly Error Budget

**99.5% SLO = 10,800 minutes error budget/year**

```
Month       | Days | Minutes | Error Budget | Downtime Allowed
January     | 31   | 44640   | 223.2        | 3h 43min
February    | 28   | 40320   | 201.6        | 3h 22min
March       | 31   | 44640   | 223.2        | 3h 43min
April       | 30   | 43200   | 216          | 3h 36min
...
```

### Alert Strategy Based on Error Budget

```yaml
# Phase 1: Healthy (> 50% error budget remaining)
- Alert severity: INFO
- Actions: Log, track

# Phase 2: Warning (25-50% error budget remaining)
- Alert severity: WARNING
- Actions: Notify on-call, schedule review

# Phase 3: Critical (< 25% error budget remaining)
- Alert severity: CRITICAL
- Actions: Page on-call, freeze deployments, investigate

# Phase 4: Exhausted (< 5% remaining)
- Alert severity: CRITICAL
- Actions: Page on-call immediately, stop all deployments, focus on stability

# Budget Reset
- Monthly: Budget resets 1st of month
- If downtime < error budget: good month
- If downtime > error budget: SLO breach - postmortem required
```

### Burn Rate Alerts

```yaml
# Alert if burning error budget too fast
alerts:
  - name: HighErrorRateBurnRate
    condition: |
      error_rate > ((1 - 0.995) * 60 minutes) * 10  # 10x burn rate
    duration: 5 minutes
    severity: CRITICAL
    action: Page on-call
    description: "Error budget burning at 10x expected rate"

  - name: MediumErrorRateBurnRate
    condition: |
      error_rate > ((1 - 0.995) * 60 minutes) * 5   # 5x burn rate
    duration: 15 minutes
    severity: WARNING
    action: Notify team
    description: "Error budget burning at 5x expected rate"
```

---

## SLO by Service

### API Service

```
Availability (uptime): 99.5%
  Error budget: 2.16 hours/month

Latency (p95): < 500ms
  Error budget: 2.16 hours/month

Throughput: 1000 req/sec minimum
  Error budget: When unable to serve 1000 req/sec

Database connectivity: 99.9%
  Error budget: 43 minutes/month
```

### Workload Management Service

```
Pod deployment success rate: 99.5%
  Error budget: 2.16 hours/month

Container image pull success: 99.8%
  Error budget: 52 minutes/month

Health check reliability: 99.9%
  Error budget: 43 minutes/month
```

### Storage Service

```
Offsite backup server availability: 99.9%
  Error budget: 43 minutes/month

Backup success rate: 99.5%
  Error budget: 2.16 hours/month

Restore success rate: 99.0%
  Error budget: 7.2 hours/month
```

### DNS Service

```
PowerDNS availability: 99.95%
  Error budget: 21.6 minutes/month

DNS query response time: < 50ms (p95)
  Error budget: 2.16 hours/month
```

---

## Measuring SLIs

### Prometheus Queries

```promql
# API Availability
rate(http_requests_total{job="api", status=~"[45].."}[5m])

# API Latency p95
histogram_quantile(0.95, rate(http_request_duration_ms_bucket[5m]))

# Database Connection Success Rate
rate(db_connections_successful_total[5m]) / rate(db_connections_attempted_total[5m])

# Pod Ready Percentage
kube_pod_status_ready / count(kube_pod_info)

# Backup Success Rate
rate(backup_success_total[1d]) / rate(backup_attempts_total[1d])
```

### Grafana Dashboards

Create dashboards showing:
- Current SLO status (% towards budget)
- Error budget burn rate
- Individual SLI metrics
- Historical trends
- Alert status

---

## SLO Compliance & Reporting

### Monthly SLO Report

```
Platform SLO Report - March 2026
================================

Availability: 99.87% ✅ (Target: 99.5%)
  - Uptime: 44,568 / 44,640 minutes
  - Downtime: 72 minutes
  - Error budget: 223.2 minutes (72 used, 151.2 remaining)

Latency (p95): 420ms ✅ (Target: < 500ms)
  - Requests meeting latency: 99.8%
  - Error budget: 223.2 minutes (45 used, 178.2 remaining)

Database Availability: 99.95% ✅ (Target: 99.9%)
  - Connection errors: 2 out of 4000+
  - Error budget: 43.2 minutes (0.7 used, 42.5 remaining)

Overall SLO Status: ✅ HEALTHY
  - All targets met
  - Error budget status: 89% remaining
  - Next review: April 1, 2026

Incidents This Month:
  - None causing SLO breach
```

### SLO Tracking

```sql
-- Track SLO compliance over time
SELECT
  DATE(date) as date,
  (SUM(uptime_seconds) / SUM(total_seconds)) * 100 as availability_pct,
  PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY response_time_ms) as p95_latency,
  db_success_rate,
  CASE 
    WHEN (SUM(uptime_seconds) / SUM(total_seconds)) >= 0.995 THEN '✅ PASS'
    ELSE '❌ FAIL'
  END as slo_status
FROM metrics
GROUP BY DATE(date)
ORDER BY date DESC;
```

---

## Incident Response & SLO Breach

### SLO Breach Procedure

1. **Detect:** Alert fires when SLO conditions violated
2. **Notify:** Page on-call immediately
3. **Respond:** Begin incident response (see runbook)
4. **Mitigate:** Focus on restoring service ASAP
5. **Investigate:** Root cause analysis post-incident
6. **Review:** Postmortem within 24 hours

### Postmortem Template

```markdown
# SLO Breach Postmortem

## Incident Summary
- **Date:** March 15, 2026
- **Duration:** 45 minutes
- **Impact:** API unavailable, 500 affected clients
- **SLO Status:** Exceeded error budget by 5 minutes

## Timeline
- 14:30: Database connection pool exhaustion detected
- 14:31: Alerts fired (availability dropped to 0%)
- 14:32: On-call engineer paged
- 14:35: Connection pool recycled, service recovered
- 14:45: Confirmed stable, investigation began

## Root Cause
A database query (daily report generation) was running synchronously
during peak hours, exhausting the connection pool.

## Resolution
- Moved report generation to async queue
- Added query timeout limits (5 minutes max)
- Increased connection pool from 20 to 50

## Prevention
- Implement SLI monitoring on database queries
- Circuit breaker pattern for expensive operations
- Load testing for expected peak traffic

## Lessons Learned
- Async patterns essential for long-running operations
- Connection pooling must be monitored and right-sized
```

---

## SLO Development

### Phase 1 SLO Targets

```
Availability:     99.5% (3.6 hours/month downtime)
Latency (p95):    < 500ms
Database health:  99.9%
Throughput:       1000 req/sec

Error budget:     ~10,800 minutes/year
```

### Phase 2 (Future) SLO Improvements

```
Availability:     99.9% (43 minutes/month downtime)
Latency (p95):    < 300ms
Database health:  99.95%
Throughput:       5000 req/sec

Introduces multi-region failover capability
```

### Phase 3+ (Future)

```
Availability:     99.99% (4.3 minutes/month downtime)
Latency (p95):    < 100ms
Database health:  99.99%
Throughput:       10,000 req/sec

Requires advanced HA, multi-region, auto-scaling
```

---

## Error Budget Decision Framework

### Should We Deploy?

| Error Budget | Decision | Rationale |
| --- | --- | --- |
| > 50% | ✅ GO | Safe to deploy, continue normal deployment schedule |
| 25-50% | ⚠️ CAUTION | Deploy only critical features, increased risk |
| 10-25% | 🛑 HOLD | Deploy only critical fixes, no new features |
| < 10% | 🔴 FREEZE | No deployments except emergency hotfixes |

### Example Decision

```
Current error budget: 30% remaining (65 minutes)
Time until reset: 2 weeks
Burn rate: 5 minutes/day

Question: Can we deploy feature X?
Answer: ⚠️ CAUTION

Rationale: Only 65 minutes safe errors left, feature introduces
0.1% error risk. If failed, would consume 6 minutes of budget.
Acceptable since we have 2 weeks to recover.
```

---

## SLI Collection & Automation

### Instrumentation

Every endpoint must track:
- Request count (labeled by endpoint, method, status)
- Response time (histogram)
- Error details (error code, message)

```typescript
// Express middleware
app.use((req, res, next) => {
  const start = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - start;
    const status = res.statusCode;

    // Prometheus metrics
    httpRequestTotal.labels(req.path, req.method, status).inc();
    httpRequestDuration.labels(req.path, req.method).observe(duration);

    // Log for analysis
    console.log({
      endpoint: req.path,
      method: req.method,
      status,
      duration_ms: duration,
      timestamp: new Date().toISOString()
    });
  });

  next();
});
```

---

## Testing SLO Achievement

```typescript
describe('SLO Compliance', () => {
  it('should achieve 99.5% availability under normal load', async () => {
    const iterations = 10000;
    let successCount = 0;

    for (let i = 0; i < iterations; i++) {
      try {
        await makeRequest('/api/workloads');
        successCount++;
      } catch (e) {
        // Expected some failures
      }
    }

    const availability = successCount / iterations;
    expect(availability).toBeGreaterThanOrEqual(0.995);
  });

  it('should maintain p95 latency < 500ms', async () => {
    const durations: number[] = [];

    for (let i = 0; i < 1000; i++) {
      const start = Date.now();
      await makeRequest('/api/workloads');
      const duration = Date.now() - start;
      durations.push(duration);
    }

    const p95 = getPercentile(durations, 95);
    expect(p95).toBeLessThan(500);
  });
});
```

---

## Checklist

- [ ] Define SLO targets for each service
- [ ] Implement SLI measurement (Prometheus)
- [ ] Set up error budget tracking
- [ ] Create Grafana dashboards
- [ ] Configure burn rate alerts
- [ ] Establish postmortem process
- [ ] Document deployment decision framework
- [ ] Monitor SLO compliance monthly
- [ ] Review SLO targets quarterly
- [ ] Test SLO achievement under load

---

## References

- Google SRE Book - SLOs: https://sre.google/sre-book/service-level-objectives/
- DORA Metrics: https://cloud.google.com/blog/products/devops-sre/using-the-four-keys-to-measure-devops-performance
- Prometheus Monitoring: https://prometheus.io/
- SLO Calculation Tools: https://slo.cloud/
