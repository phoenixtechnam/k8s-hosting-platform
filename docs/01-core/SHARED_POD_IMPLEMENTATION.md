# Shared Pod Implementation Guide

> **⛔ SUPERSEDED by ADR-024 (2026-03-27):** This document describes the shared pod architecture
> that has been replaced by the dedicated-pod-for-all-clients model. All clients now get dedicated
> pods in their own `client-{id}` namespace regardless of plan tier. This document is retained as
> historical reference only. See `ARCHITECTURE_DECISION_RECORDS.md` → ADR-024 for rationale.

**Document Version:** 1.0
**Last Updated:** 2026-03-01
**Status:** ~~DRAFT — Ready for implementation~~ **SUPERSEDED** (ADR-024, 2026-03-27)
**Audience:** Historical reference only

---

## Overview

**Shared pods** are the foundation of the **Starter plan**, allowing 20-50 lightweight customers to run on a single 2vCPU/4Gi pod while maintaining security isolation and resource fairness.

This document specifies:
- Pod architecture and lifecycle
- Virtual host (VirtualHost) generation and routing
- PHP-FPM pool management and isolation
- ConfigMap structure and updates
- Resource enforcement (CPU/memory limits per customer)
- Lifecycle management (onboarding, scaling, eviction)

**Key Principle:** Shared pods are **NOT** traditional shared hosting. Each customer's files are isolated, but workloads may be co-located for cost efficiency.

---

## Architecture Overview

### Pod Topology

```
┌─────────────────────────────────────────────────────┐
│ Shared Pod: shared-php-01 (2vCPU, 4Gi)              │
├─────────────────────────────────────────────────────┤
│                                                     │
│  NGINX (reverse proxy)                              │
│  ├─ Listens: 0.0.0.0:80, 0.0.0.0:443               │
│  ├─ Certificates: /etc/nginx/certs/{domain}.crt    │
│  └─ Upstream servers:                               │
│      ├─ php-fpm:9001 (customer_001)                │
│      ├─ php-fpm:9002 (customer_002)                │
│      └─ php-fpm:9003 (customer_003)                │
│                                                     │
│  PHP-FPM (application layer)                        │
│  ├─ Pool[9001]: user=acme, listen=/var/run/fpm01  │
│  ├─ Pool[9002]: user=beta, listen=/var/run/fpm02  │
│  └─ Pool[9003]: user=gamma, listen=/var/run/fpm03 │
│                                                     │
│  Storage (single PV, subPath per customer)           │
│  ├─ /storage/customers/acme/domains/*/public_html/ │
│  ├─ /storage/customers/beta/domains/*/public_html/ │
│  └─ /storage/customers/gamma/domains/*/public_html/│
│                                                     │
│  Shared Resources (limited per pool):               │
│  ├─ Memory: 4Gi total / ~1.3Gi per customer        │
│  ├─ CPU: 2 cores / ~666m per customer              │
│  ├─ Connections: 100 per pool                      │
│  └─ Processes: 10 per pool                         │
│                                                     │
└─────────────────────────────────────────────────────┘
```

---

## ConfigMap Structure

### File Location
```
Kubernetes Namespace: hosting
ConfigMap Name: shared-pod-config-<pool_id>
```

> **Note:** Starter clients live in the `hosting` namespace (not individual `client-{id}` namespaces).
> Only Business/Premium clients get dedicated `client-{id}` namespaces. See INFRASTRUCTURE_SIZING.md namespace strategy.

### ConfigMap Data Structure

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: shared-pod-config-pool-01
  namespace: hosting
data:
  # 1. Shared Pod Assignment
  shared_pod_id: "shared-php-01"
  shared_pod_namespace: "hosting"
  
  # 2. Customer Metadata
  customers.json: |
    {
      "customer_001": {
        "id": "customer_001",
        "name": "Acme Corp",
        "domains": ["acme.com", "www.acme.com"],
        "php_version": "8.1",
        "status": "active",
        "added_at": "2025-01-15T10:00:00Z",
        "metrics": {
          "php_pool_port": 9001,
          "php_pool_socket": "/var/run/php-fpm-acme.sock",
          "max_processes": 10,
          "max_memory_mb": 256,
          "max_cpu_cores": 0.3
        },
        "domains_config": {
          "acme.com": {
            "document_root": "/storage/customers/acme/domains/acme.com/public_html",
            "fastcgi_pass": "unix:/var/run/php-fpm-acme.sock",
            "ssl_certificate": "/etc/nginx/certs/acme.com.crt",
            "ssl_key": "/etc/nginx/certs/acme.com.key"
          },
          "www.acme.com": {
            "document_root": "/storage/customers/acme/domains/acme.com/public_html",
            "fastcgi_pass": "unix:/var/run/php-fpm-acme.sock",
            "ssl_certificate": "/etc/nginx/certs/www.acme.com.crt",
            "ssl_key": "/etc/nginx/certs/www.acme.com.key"
          }
        }
      },
      "customer_002": { ... },
      "customer_003": { ... }
    }
  
  # 3. NGINX Configuration Template
  nginx_vhost_template: |
    server {
      listen 80;
      listen 443 ssl http2;
      server_name {{ domain }};
      
      ssl_certificate {{ ssl_cert }};
      ssl_certificate_key {{ ssl_key }};
      ssl_protocols TLSv1.2 TLSv1.3;
      ssl_ciphers HIGH:!aNULL:!MD5;
      ssl_prefer_server_ciphers on;
      
      # Redirect HTTP to HTTPS
      if ($scheme != "https") {
        return 301 https://$server_name$request_uri;
      }
      
      # Security headers
      add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
      add_header X-Content-Type-Options "nosniff" always;
      add_header X-Frame-Options "SAMEORIGIN" always;
      add_header X-XSS-Protection "1; mode=block" always;
      
      # WAF via ModSecurity
      SecRuleEngine On;
      SecDefaultAction "phase:2,deny,status:403,log"
      
      location / {
        root {{ document_root }};
        index index.php index.html;
        
        # Block direct access to sensitive files
        location ~ /\. { deny all; }
        location ~ ~$ { deny all; }
        location ~ (wp-config\.php|.htaccess)$ { deny all; }
        
        # Pass PHP to FPM
        location ~ \.php$ {
          fastcgi_pass {{ fastcgi_pass }};
          fastcgi_index index.php;
          include fastcgi.conf;
          
          # FPM security
          fastcgi_param PHP_VALUE "open_basedir={{ document_root }}";
          fastcgi_param PHP_VALUE "disable_functions=exec,passthru,shell_exec,system";
        }
      }
      
      # Password-protected directories (HTTP Basic Auth)
      # NOTE: Configuration for protected paths is auto-generated by Management API
      # Example protected directory configuration:
      #
      # location ~ ^/admin/ {
      #   auth_basic "Admin Panel";
      #   auth_basic_user_file {{ document_root }}/.htpasswd-admin;
      #   try_files $uri $uri/ /index.php?$query_string;
      #
      #   location ~ \.php$ {
      #     fastcgi_pass {{ fastcgi_pass }};
      #     include fastcgi.conf;
      #     fastcgi_param REMOTE_USER $remote_user;
      #   }
      # }
      
      # Block direct access to .htpasswd files
      location ~ \.htpasswd {
        deny all;
      }
      
      # Access logging
      access_log /var/log/nginx/{{ customer_id }}_access.log combined buffer=32k flush=5s;
      error_log /var/log/nginx/{{ customer_id }}_error.log warn;
    }
  
  # 4. PHP-FPM Pool Template
  php_fpm_pool_template: |
    [{{ pool_name }}]
    user = {{ unix_user }}
    group = {{ unix_group }}
    listen = {{ listen_socket }}
    listen.owner = www-data
    listen.group = www-data
    listen.mode = 0660
    
    # Process management
    pm = dynamic
    pm.max_children = {{ max_processes }}
    pm.start_servers = 2
    pm.min_spare_servers = 1
    pm.max_spare_servers = 3
    pm.process_idle_timeout = 10s
    pm.max_requests = 1000
    
    # Resource limits
    memory_limit = {{ max_memory_mb }}M
    max_execution_time = 30
    
    # Security isolation
    chroot = /var/www/{{ customer_id }}
    chdir = /
    security.limit_extensions = .php
    
    # Environment variables
    env[CUSTOMER_ID] = {{ customer_id }}
    env[PHP_ENV] = production
    
    # Logging
    catch_workers_output = yes
    slowlog = /var/log/php-fpm/{{ customer_id }}_slow.log
    slowlog_timeout = 5s
    
    # Status monitoring
    pm.status_path = /fpm_status
    ping.path = /fpm_ping
    ping.response = pong
  
  # 5. Resource Enforcement Rules
  resource_limits: |
    {
      "starter_plan": {
        "max_customers_per_pod": 50,
        "memory_per_customer_mb": 256,
        "cpu_per_customer": "0.3",
        "php_fpm_processes": 10,
        "php_fpm_connections": 50,
        "max_file_size_mb": 2048,
        "upload_dir_quota_mb": 1024
      }
    }
  
  # 6. Update Timestamp
  last_updated: "2025-03-01T10:00:00Z"
```

---

## Lifecycle Management

### 1. Customer Onboarding to Shared Pod

#### Step 1: Check Pod Capacity
```bash
# Get shared pod utilization
kubectl get resourcequota -n hosting shared-php-01
# Check customers.json for current count
# Verify: count < 50 AND memory_used + 256Mi < 4Gi
```

#### Step 2: Create Unix User and Home Directory
```bash
# In shared pod:
useradd -m -s /bin/false acme
mkdir -p /var/www/acme
chown acme:acme /var/www/acme
chmod 750 /var/www/acme

# Create .htaccess to prevent directory listing
echo "Options -Indexes" > /var/www/acme/.htaccess
```

#### Step 3: Generate PHP-FPM Pool Configuration
```bash
# From ConfigMap template, substitute:
# {{ pool_name }} = acme
# {{ unix_user }} = acme
# {{ unix_group }} = acme
# {{ listen_socket }} = /var/run/php-fpm-acme.sock
# {{ customer_id }} = customer_001
# {{ max_processes }} = 10
# {{ max_memory_mb }} = 256

# Result file: /etc/php/fpm/pool.d/acme.conf
# Then reload: systemctl reload php-fpm
```

#### Step 4: Add to NGINX Configuration
```bash
# For each domain (acme.com, www.acme.com):
# Generate NGINX server block from template
# Substitute:
# {{ domain }} = acme.com
# {{ ssl_cert }} = /etc/nginx/certs/acme.com.crt
# {{ ssl_key }} = /etc/nginx/certs/acme.com.key
# {{ document_root }} = /var/www/acme
# {{ fastcgi_pass }} = unix:/var/run/php-fpm-acme.sock
# {{ customer_id }} = customer_001

# Result file: /etc/nginx/sites-enabled/acme.com.conf
# Then test: nginx -t && systemctl reload nginx
```

#### Step 5: Update ConfigMap
```bash
# Update customers.json with new customer entry
# Add to shared_pod assignment if not present
# Increment last_updated timestamp
kubectl patch configmap php-shared-config -n hosting \
  --type merge \
  -p '{
    "data": {
      "customers.json": "...",
      "last_updated": "2025-03-01T10:05:00Z"
    }
  }'
```

#### Step 6: Verify Connectivity
```bash
# Test FPM pool
curl http://localhost:9001/fpm_ping  # Should return "pong"

# Test NGINX
curl -H "Host: acme.com" http://localhost/  # Should work
curl -k https://acme.com/  # Should work with SSL
```

---

### 2. Domain Addition to Existing Customer

When customer adds a second domain (e.g., shop.acme.com):

#### Step 1: Update ConfigMap
```json
{
  "shop.acme.com": {
    "document_root": "/var/www/acme",
    "fastcgi_pass": "unix:/var/run/php-fpm-acme.sock",
    "ssl_certificate": "/etc/nginx/certs/shop.acme.com.crt",
    "ssl_key": "/etc/nginx/certs/shop.acme.com.key"
  }
}
```

#### Step 2: Generate and Apply NGINX Config
- Generate from template
- Reload NGINX

#### Step 3: Verify
- Test domain points to correct document root
- Verify SSL certificate is valid

---

### 3. Customer Eviction / Removal

When removing a customer (e.g., account closed):

#### Step 1: Stop PHP-FPM Pool
```bash
# Remove /etc/php/fpm/pool.d/acme.conf
# Reload PHP-FPM
systemctl reload php-fpm
```

#### Step 2: Remove NGINX Configuration
```bash
# Remove all server blocks for customer domains
# Reload NGINX
systemctl reload nginx
```

#### Step 3: Backup Customer Data (if needed)
```bash
# Create tarball
tar -czf /backups/acme_final_backup.tar.gz /var/www/acme

# Upload to offsite backup server via SSHFS mount
cp /backups/acme_final_backup.tar.gz /mnt/offsite/customer-backups/acme/
```

#### Step 4: Delete Customer Files
```bash
# Secure wipe
shred -vfz -n 3 /var/www/acme/*
rm -rf /var/www/acme

# Delete user
userdel -r acme  # -r removes home directory
```

#### Step 5: Update ConfigMap
```bash
# Remove customer_001 from customers.json
# Update last_updated
kubectl patch configmap php-shared-config ...
```

---

### Security Hardening (Shared Pods)

Shared pods host multiple clients in one container. Application-level isolation (PHP-FPM pools, open_basedir, POSIX permissions) is the primary defense, but kernel-level controls are required to limit blast radius.

**Mandatory controls:**

| Control | Configuration | Purpose |
|---------|--------------|---------|
| **Seccomp profile** | `RuntimeDefault` (Kubernetes built-in) | Blocks ~44 dangerous syscalls (ptrace, mount, etc.) |
| **AppArmor profile** | Custom `shared-pod-profile` | Restricts /proc access, prevents reading other processes' environment variables |
| **Drop all capabilities** | `drop: [ALL]`, add only `NET_BIND_SERVICE` | Prevents capability-based privilege escalation |
| **Read-only root filesystem** | `readOnlyRootFilesystem: true` | Prevents installing attack tools; writable paths via emptyDir/tmpfs |
| **Non-root user** | `runAsNonRoot: true`, `runAsUser: 33` (www-data) | PHP-FPM master runs as www-data; pools use per-client UIDs |
| **No privilege escalation** | `allowPrivilegeEscalation: false` | Prevents setuid/setgid exploitation |

**PHP-FPM hardening (per client pool):**

| Directive | Value | Purpose |
|-----------|-------|---------|
| `open_basedir` | `/storage/customers/{id}/:/tmp/php-{id}/` | Restrict filesystem access to client's own directory |
| `disable_functions` | `exec,passthru,shell_exec,system,proc_open,popen,curl_multi_exec,parse_ini_file,show_source,pcntl_exec` | Block command execution functions |
| `chroot` | `/storage/customers/{id}/` | Kernel-level filesystem isolation per pool |
| `upload_tmp_dir` | `/tmp/php-{id}/` | Isolated temp directory per client |
| `session.save_path` | `/tmp/php-{id}/sessions/` | Isolated session storage |

**Risk acceptance:** Even with these controls, a kernel-level vulnerability (container escape) in the shared pod could expose all co-tenant clients. This is an accepted trade-off for the Starter tier's cost optimization. Business/Premium tiers use dedicated pods with full namespace isolation.

---

## Resource Enforcement

### CPU and Memory Isolation

**Pod-level limits (Kubernetes):**
```yaml
apiVersion: v1
kind: Pod
metadata:
  name: shared-php-01
spec:
  containers:
  - name: php-fpm
    resources:
      requests:
        cpu: "2"
        memory: "4Gi"
      limits:
        cpu: "2"
        memory: "4Gi"
```

**Per-customer enforcement:**

1. **PHP-FPM Process Limits**
   - `pm.max_children = 10` — Max 10 processes per customer
   - `pm.max_requests = 1000` — Restart worker after 1000 requests
   - `memory_limit = 256M` — Per-process limit in php.ini

2. **Linux cgroup Control**
   ```bash
   # Create cgroup for customer
   cgcreate -g memory:/customer_001
   echo 268435456 > /sys/fs/cgroup/memory/customer_001/memory.limit_in_bytes  # 256Mi
   
   # Assign processes
   cgclassify -g memory:/customer_001 <php-fpm-pids>
   ```

3. **Open File Descriptors Limit**
   ```bash
   ulimit -n 1024  # Per-process limit
   ```

### open_basedir Enforcement

**Critical security feature** — prevents customers from accessing each other's files.

#### In PHP-FPM Configuration
```
# /etc/php/fpm/pool.d/acme.conf
php_value[open_basedir] = /var/www/acme:/tmp:/var/tmp
```

**Verification:**
```bash
# Test from within container
php -r "echo ini_get('open_basedir');"
# Should return: /var/www/acme:/tmp:/var/tmp

# Attempt to access other customer's file
php -r "var_dump(file_get_contents('/var/www/beta/config.php'));"
# Should fail with: "open_basedir restriction in effect"
```

#### Verify in NGINX
```nginx
# NGINX passes php value to FPM
fastcgi_param PHP_VALUE "open_basedir=/var/www/acme:/tmp:/var/tmp";
```

---

## Scaling and Rebalancing

### Scenario: Pod Reaches 90% Capacity

**Current state:** 45 customers, 2.5GB memory used, approaching limits

**Action: Rebalance to new pod**

#### Step 1: Create New Pod
```bash
kubectl apply -f - <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: shared-php-02
  namespace: hosting
spec:
  containers:
  - name: nginx-php-fpm
    image: custom/php-fpm:8.1
    resources:
      requests:
        cpu: "2"
        memory: "4Gi"
      limits:
        cpu: "2"
        memory: "4Gi"
    volumeMounts:
    - name: www
      mountPath: /var/www
  volumes:
  - name: www
    persistentVolumeClaim:
      claimName: shared-storage
EOF
```

#### Step 2: Migrate Customers Gradually
```bash
# For customer_025 through customer_045 (20 customers):
# 1. Update ConfigMap: shared_pod_id = "shared-php-02"
# 2. Copy PHP-FPM config to new pod
# 3. Test FPM pool on new pod
# 4. Update NGINX to point to new pod
# 5. Monitor error rate
# 6. Remove from old pod
```

#### Step 3: Monitor During Migration
```bash
# Watch error rates
kubectl logs -f deployment/php-shared-01 --tail=100

# Check pool utilization
curl http://shared-php-02:9025/fpm_status

# Verify no requests are failing
prometheus query: rate(nginx_http_requests_total{status=~"5.."}[5m])
```

---

## Monitoring and Health Checks

### Health Check Endpoint
```bash
# In NGINX
location /health {
  access_log off;
  return 200 "OK";
}

# Kubernetes health probe
livenessProbe:
  httpGet:
    path: /health
    port: 80
  initialDelaySeconds: 10
  periodSeconds: 10

readinessProbe:
  httpGet:
    path: /health
    port: 80
  initialDelaySeconds: 5
  periodSeconds: 5
```

### FPM Pool Status
```bash
# Check pool status
curl http://localhost:9001/fpm_status
# Returns: pool name, processes, requests, slow log count, etc.

# Example output:
pool:                 acme
process manager:      dynamic
start time:           01/Mar/2025:10:00:00 +0000
start since:          3600
accepted conn:        15432
listen queue:         0
max listen queue:     5
listen queue len:     0
idle processes:       3
active processes:     7
total processes:      10
max active processes: 9
max children reached: 0
slow requests:        2
```

### Metrics to Collect

```
# Per-pod metrics
php_fpm_active_processes
php_fpm_total_processes
php_fpm_max_children_reached
nginx_http_requests_total
nginx_http_request_duration_seconds
nginx_http_requests_errors_total

# Per-customer metrics
customer_cpu_usage_cores
customer_memory_usage_bytes
customer_request_duration_seconds
customer_error_rate
customer_slow_query_count
```

---

## Troubleshooting

### Problem: New Customer Can't Access Domain

**Diagnosis:**
```bash
# 1. Check NGINX config exists and is valid
nginx -t

# 2. Verify FPM pool is running
systemctl status php-fpm
curl http://localhost:9001/fpm_ping

# 3. Check domain is in ConfigMap
kubectl get cm php-shared-config -o json | jq .data.customers.json

# 4. Test directly
curl -H "Host: acme.com" http://localhost/
curl -k https://acme.com/

# 5. Check logs
tail -f /var/log/nginx/customer_001_error.log
tail -f /var/log/php-fpm/customer_001_slow.log
```

**Solutions:**
- Reload NGINX: `systemctl reload nginx`
- Reload PHP-FPM: `systemctl reload php-fpm`
- Restart pod: `kubectl delete pod shared-php-01`

### Problem: Customer Experiencing Slow Performance

**Diagnosis:**
```bash
# 1. Check resource utilization
kubectl top pod shared-php-01

# 2. Check FPM pool status
curl http://localhost:9025/fpm_status  # Port varies per customer

# 3. Check slow logs
tail /var/log/php-fpm/customer_001_slow.log

# 4. Check NGINX error rate
grep "PHP.*504" /var/log/nginx/customer_001_error.log

# 5. Check open file limits
lsof -p <php-fpm-pid> | wc -l
```

**Solutions:**
- Increase FPM processes: `pm.max_children = 15`
- Increase memory limit: `memory_limit = 512M`
- Rebalance to new pod if pod is overloaded
- Contact customer to optimize code/queries

### Problem: PHP-FPM Crashes or Hangs

**Diagnosis:**
```bash
# Check process status
ps aux | grep php-fpm

# Check system logs
journalctl -u php-fpm -n 50

# Check memory pressure
free -h

# Check if processes are stuck
curl http://localhost:9001/fpm_status  # If responsive
# If not responsive, pool has hung
```

**Solutions:**
- Increase PHP memory limit
- Kill stuck processes: `pkill -9 -f php-fpm`
- Restart PHP-FPM: `systemctl restart php-fpm`
- Increase pod memory allocation
- Migrate customer to dedicated pod

---

## Security Considerations

### Isolation Guarantees

| Threat | Mitigation |
|--------|-----------|
| Customer reads other's files | `open_basedir` + Linux permissions |
| Customer modifies other's files | POSIX permissions + `chroot` |
| Customer DoS via CPU | PHP-FPM max processes + Kubernetes CPU limits |
| Customer DoS via memory | `memory_limit` + cgroup limits |
| Customer DoS via connections | `pm.max_children` + connection pooling |
| SQL injection in shared DB | Per-customer database user + column-level encryption |
| XSS between customers | Same-origin policy via separate domains |

### Hardening Checklist

- [ ] Set `open_basedir` for every PHP pool
- [ ] Set `disable_functions` to disable exec, system, shell_exec
- [ ] Use `chroot` to jail PHP processes
- [ ] Set `security.limit_extensions = .php` (no .phtml, .php7, etc.)
- [ ] Disable directory listing (`Options -Indexes`)
- [ ] Disable .htaccess overrides when possible
- [ ] Enable ModSecurity WAF rules
- [ ] Monitor slow logs for SQL injection attempts
- [ ] Rate-limit per-customer requests
- [ ] Enable SELinux or AppArmor if available

---

## Implementation Checklist

### Kubernetes Resources
- [ ] Create shared-php deployment/pod template
- [ ] Create PersistentVolumeClaim for /var/www
- [ ] Create ConfigMap for php-shared-config
- [ ] Create RBAC roles for pod management
- [ ] Set resource quotas and limits

### Container Image
- [ ] Build custom PHP-FPM image with required extensions
- [ ] Install NGINX with ModSecurity
- [ ] Install monitoring agents (Prometheus, Fluent Bit)
- [ ] Expose health check endpoints

### Operational Procedures
- [ ] Write automation for customer onboarding
- [ ] Write automation for customer removal
- [ ] Write runbook for capacity planning/rebalancing
- [ ] Set up monitoring dashboards
- [ ] Create alerting rules for pod capacity

### Testing
- [ ] Test isolation: verify open_basedir works
- [ ] Test resource limits: max out processes/memory
- [ ] Test failover: kill FPM pool, verify recovery
- [ ] Load test: simulate 50 customers with realistic traffic
- [ ] Security test: attempt file access across customers

---

## Related Documents

- [`./PLATFORM_ARCHITECTURE.md`](./PLATFORM_ARCHITECTURE.md) — Overall workload deployment model
- [`./WORKLOAD_DEPLOYMENT.md`](./WORKLOAD_DEPLOYMENT.md) — Other workload types (dedicated, applications)
- [`../02-operations/INFRASTRUCTURE_SIZING.md`](../02-operations/INFRASTRUCTURE_SIZING.md) — Pod sizing and capacity planning
- [`../03-security/SECURITY_ARCHITECTURE.md`](../03-security/SECURITY_ARCHITECTURE.md) — Isolation and hardening

---

**Status:** Ready for implementation  
**Estimated Development Time:** 2-3 weeks (automation + testing)  
**Next Phase:** Implement PowerDNS integration for automatic domain provisioning
