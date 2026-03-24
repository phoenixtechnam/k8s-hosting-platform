# Node.js Runtime Specification

**Version:** 1.0  
**Last Updated:** 2026-03-07  
**Status:** Design / Pre-Implementation  
**Audience:** Platform Admins, Operations Team

---

## Overview

This document defines the full runtime contract for Node.js catalog images (`node22`, `node20`) on the platform. It covers the Dockerfile specification, startup contract, port convention, environment variable injection, health check requirements, dependency installation, Kubernetes manifests, and a step-by-step customer deployment guide.

Node.js workloads are **only available on Business and Premium plans** (dedicated pod model). They are not supported on the Starter plan (shared Apache+PHP pods).

---

## Catalog Entries

| Catalog ID | Base Image      | Process Manager | Runtime    | Plan Requirement      | Status |
|------------|-----------------|-----------------|------------|-----------------------|--------|
| `node22`   | node:22-alpine  | PM2             | Node.js 22 | Business or Premium   | Active |
| `node20`   | node:20-alpine  | PM2             | Node.js 20 | Business or Premium   | Active |

---

## 1. Dockerfile Specification

Both catalog images follow the same Dockerfile pattern, differing only in the Node.js major version.

### node22 Dockerfile

```dockerfile
FROM node:22-alpine

# Install PM2 globally as root, then lock down
RUN npm install -g pm2@latest && \
    npm cache clean --force

# Create non-root user
RUN addgroup -S appgroup && adduser -S appuser -G appgroup

# Working directory — platform mounts PV here at runtime
WORKDIR /storage/customers

# PM2 runtime config (embedded fallback — overridden by customer ecosystem.config.js if present)
COPY pm2-defaults.json /etc/platform/pm2-defaults.json

# Expose application port
EXPOSE 3000

# Drop to non-root
USER appuser

# Platform entrypoint: node-entrypoint.sh resolves startup config (see §3)
COPY --chown=appuser:appgroup node-entrypoint.sh /usr/local/bin/node-entrypoint.sh
ENTRYPOINT ["/usr/local/bin/node-entrypoint.sh"]
```

### node20 Dockerfile

Identical to the above with `FROM node:20-alpine`.

### Security Hardening

- Non-root user (`appuser`) at runtime
- No dev tools, no build utilities in the final image
- `npm cache clean --force` after global install
- All packages pinned by digest in Harbor registry (tag: `catalog/node22:<version>-<YYYYMMDD>`)
- Trivy scans run on every build
- Read-only root filesystem (customer files on PV only)

---

## 2. Process Manager: PM2

The platform uses **PM2** as the process manager for all Node.js customer workloads.

**Rationale:** Customer workloads run unattended. PM2 provides:
- Automatic process restart on crash (without pod restart)
- Graceful shutdown on `SIGTERM` (allows Kubernetes rolling updates)
- Log aggregation to stdout/stderr (Loki collection)
- Runtime metrics exposure (optional)

**PM2 is started via `pm2-runtime`**, which runs in the foreground (required for Docker/Kubernetes — `pm2` daemon mode does not work in containers).

---

## 3. Startup Contract

### Entrypoint Logic (`node-entrypoint.sh`)

The platform entrypoint script resolves startup configuration in the following priority order:

```
Priority 1: /storage/customers/{id}/domains/{domain}/public_html/ecosystem.config.js
Priority 2: /storage/customers/{id}/domains/{domain}/public_html/package.json  (uses "start" script)
Priority 3: /etc/platform/pm2-defaults.json  (platform fallback: runs index.js)
```

**Pseudocode:**

```bash
#!/bin/sh
set -e

APP_DIR="${APP_DIR:-/storage/customers/${CUSTOMER_ID}/domains/${PRIMARY_DOMAIN}/public_html}"

if [ -f "$APP_DIR/ecosystem.config.js" ]; then
  exec pm2-runtime "$APP_DIR/ecosystem.config.js"
elif [ -f "$APP_DIR/package.json" ] && node -e "require('$APP_DIR/package.json').scripts.start" 2>/dev/null; then
  exec pm2-runtime --name app npm -- start
else
  exec pm2-runtime /etc/platform/pm2-defaults.json --env production
fi
```

### Customer Requirements

The customer **must** provide one of the following in their `public_html/` directory:

| Option | File | Notes |
|--------|------|-------|
| **A — Recommended** | `ecosystem.config.js` | Full PM2 config; customer controls app name, args, cluster mode |
| **B — Simple** | `package.json` with `"start"` script | Platform runs `npm start` via PM2 |
| **C — Fallback** | neither (platform runs `index.js`) | Only works if entry point is `index.js` |

**Example `ecosystem.config.js`:**

```javascript
module.exports = {
  apps: [{
    name: 'app',
    script: './server.js',    // entry point relative to public_html/
    instances: 1,             // scale within resource limits
    exec_mode: 'fork',        // 'cluster' for multi-core (Premium plan recommended)
    env: {
      NODE_ENV: 'production',
    },
    error_file: '/dev/stderr',
    out_file: '/dev/stdout',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
  }]
};
```

**Example `package.json` (start script):**

```json
{
  "name": "my-app",
  "version": "1.0.0",
  "scripts": {
    "start": "node server.js"
  },
  "dependencies": {
    "express": "^4.18.0"
  }
}
```

---

## 4. Port Convention

The platform enforces a fixed port convention for all Node.js pods:

| Layer | Value | Notes |
|-------|-------|-------|
| Container port | `3000` | App **must** listen on `process.env.PORT` (injected as `3000`) |
| K8s Service port | `80` | `targetPort: 3000` |
| Ingress backend | Service port `80` | NGINX Ingress → Service → Pod |

**The app must bind to `process.env.PORT`, not a hardcoded port.**

```javascript
// Correct — use the injected PORT env var
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
```

---

## 5. Environment Variable Injection

The platform injects environment variables using individual `env[].valueFrom` entries (the platform does **not** use `envFrom` anywhere — see `FRONTEND_DEPLOYMENT_ARCHITECTURE.md` for the canonical pattern).

### Platform-Injected Variables

| Variable | Source | Value |
|----------|--------|-------|
| `PORT` | ConfigMap (`node-runtime-config`) | `3000` |
| `NODE_ENV` | ConfigMap (`node-runtime-config`) | `production` |
| `CUSTOMER_ID` | ConfigMap (`{client}-config`) | Customer namespace ID |
| `PRIMARY_DOMAIN` | ConfigMap (`{client}-config`) | Primary domain name |
| `DATABASE_URL` | Secret (`{client}-db-credentials`) | Full DB connection string |
| `DATABASE_NAME` | Secret (`{client}-db-credentials`) | Database name |
| `DATABASE_USER` | Secret (`{client}-db-credentials`) | Database user |
| `DATABASE_PASSWORD` | Secret (`{client}-db-credentials`) | Database password |
| `REDIS_URL` | Secret (`{client}-redis-credentials`) | Redis connection URL (if applicable) |

### Customer-Defined Variables

Customers can add additional environment variables via the Client Panel:

- **Client Panel → Environment → Add Variable**
- Stored as a Sealed Secret in the client namespace
- Injected into the pod via additional `env[].valueFrom.secretKeyRef` entries
- Pod is restarted when variables change

---

## 6. Health Check Requirements

### Customer App Requirement

The customer app **must** respond to:

```
GET /healthz  →  HTTP 200
```

The response body is ignored — only the HTTP status code matters. A minimal implementation:

```javascript
// Express
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));

// Fastify
fastify.get('/healthz', async () => ({ status: 'ok' }));

// Node.js http (no framework)
if (req.url === '/healthz' && req.method === 'GET') {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ status: 'ok' }));
}
```

### Probe Configuration

Node.js pods use longer initial delays than platform-internal services because application startup (loading modules, connecting to DB) takes more time than a static health endpoint.

| Probe | Path | Port | `initialDelaySeconds` | `periodSeconds` | `failureThreshold` |
|-------|------|------|-----------------------|-----------------|---------------------|
| `livenessProbe` | `/healthz` | `3000` | `30` | `10` | `3` |
| `readinessProbe` | `/healthz` | `3000` | `10` | `5` | `3` |

**Note:** `startupProbe` is not used on this platform.

### What Happens on Probe Failure

- **Readiness failure:** Pod removed from Service endpoints — traffic stops routing to it. Pod stays running.
- **Liveness failure (3 consecutive):** Pod is killed and restarted by Kubernetes. PM2 crash-restart fires first if the process exits; liveness is the final safety net.

---

## 7. npm install Timing

`npm install` does **not** run at pod startup. The container starts with whatever `node_modules/` is present on the PersistentVolume.

### npm install per Deployment Method

| Deployment Method | npm install | Notes |
|-------------------|-------------|-------|
| **Git Deploy** | Runs as post-deploy hook (after rsync) | Enable "Run npm install after deploy" in Client Panel → Git Deploy settings |
| **SFTP Upload** | Customer responsibility | Upload a complete `node_modules/` directory, or upload without it and trigger manual hook |
| **FileBrowser** | Not available automatically | Customer must upload complete `node_modules/` |

### Git Deploy Post-Deploy Hook

When `npm_install_enabled: true` is set in the domain's Git Deploy config, the Git Deploy Service runs:

```bash
# After rsync completes
cd /storage/customers/{id}/domains/{domain}/public_html
npm install --omit=dev --ignore-scripts
```

- `--omit=dev` installs production dependencies only
- `--ignore-scripts` prevents lifecycle scripts from running arbitrary commands
- Output is captured to deployment logs (visible in Client Panel → Deployments)

### Important Notes

- If `node_modules/` is absent at pod startup, the app will fail to start (exit code 1). PM2 will retry; the readiness probe will hold traffic until the app starts successfully.
- Customers using SFTP/FileBrowser should either commit `node_modules/` or use Git Deploy with the npm install hook.
- Do **not** include `node_modules/` in the Git repository — use `.gitignore`. The platform runs `npm install` server-side after clone.

---

## 8. Kubernetes Manifests

Complete manifests for a `node22` customer pod. Replace `{client-id}`, `{domain}`, and `{customer-id}` with actual values.

### Namespace (provisioned at onboarding)

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: client-{client-id}
  labels:
    platform.io/client: "{client-id}"
    platform.io/plan: "business"
```

### ConfigMap

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: {client-id}-node-config
  namespace: client-{client-id}
data:
  PORT: "3000"
  NODE_ENV: "production"
  CUSTOMER_ID: "{customer-id}"
  PRIMARY_DOMAIN: "{domain}"
```

### Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: client-{client-id}
  labels:
    app: web
    platform.io/catalog-image: "node22"
    platform.io/client: "{client-id}"
spec:
  replicas: 1
  selector:
    matchLabels:
      app: web
  template:
    metadata:
      labels:
        app: web
        platform.io/catalog-image: "node22"
    spec:
      serviceAccountName: {client-id}-sa
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
      - name: web
        image: harbor.platform.com/catalog/node22:1.0.0-20260307
        imagePullPolicy: IfNotPresent
        ports:
        - name: http
          containerPort: 3000
        env:
        - name: PORT
          valueFrom:
            configMapKeyRef:
              name: {client-id}-node-config
              key: PORT
        - name: NODE_ENV
          valueFrom:
            configMapKeyRef:
              name: {client-id}-node-config
              key: NODE_ENV
        - name: CUSTOMER_ID
          valueFrom:
            configMapKeyRef:
              name: {client-id}-node-config
              key: CUSTOMER_ID
        - name: PRIMARY_DOMAIN
          valueFrom:
            configMapKeyRef:
              name: {client-id}-node-config
              key: PRIMARY_DOMAIN
        - name: DATABASE_URL
          valueFrom:
            secretKeyRef:
              name: {client-id}-db-credentials
              key: database_url
        - name: DATABASE_NAME
          valueFrom:
            secretKeyRef:
              name: {client-id}-db-credentials
              key: database_name
        - name: DATABASE_USER
          valueFrom:
            secretKeyRef:
              name: {client-id}-db-credentials
              key: database_user
        - name: DATABASE_PASSWORD
          valueFrom:
            secretKeyRef:
              name: {client-id}-db-credentials
              key: database_password
        # Redis — only injected if plan includes Redis
        - name: REDIS_URL
          valueFrom:
            secretKeyRef:
              name: {client-id}-redis-credentials
              key: redis_url
              optional: true
        livenessProbe:
          httpGet:
            path: /healthz
            port: 3000
          initialDelaySeconds: 30
          periodSeconds: 10
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /healthz
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 5
          failureThreshold: 3
        resources:
          requests:
            cpu: 250m
            memory: 256Mi
          limits:
            cpu: 1000m
            memory: 512Mi
        volumeMounts:
        - name: customer-files
          mountPath: /storage/customers/{customer-id}
      volumes:
      - name: customer-files
        persistentVolumeClaim:
          claimName: {client-id}-pvc
```

### Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: web
  namespace: client-{client-id}
  labels:
    app: web
spec:
  type: ClusterIP
  selector:
    app: web
  ports:
  - name: http
    port: 80
    targetPort: 3000
    protocol: TCP
```

### Ingress

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: web-ingress
  namespace: client-{client-id}
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/proxy-read-timeout: "60"
    nginx.ingress.kubernetes.io/proxy-send-timeout: "60"
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - "{domain}"
    - "www.{domain}"
    secretName: {client-id}-tls
  rules:
  - host: "{domain}"
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: web
            port:
              number: 80
  - host: "www.{domain}"
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: web
            port:
              number: 80
```

### Resource Limits by Plan

| Plan | CPU Request | CPU Limit | Memory Request | Memory Limit |
|------|-------------|-----------|----------------|--------------|
| **Business** | `250m` | `1000m` | `256Mi` | `512Mi` |
| **Premium** | `500m` | `2000m` | `512Mi` | `1Gi` |

---

## 9. Plan Requirements

Node.js catalog images are available on **Business and Premium plans only**.

### Switching to Node.js via Client Panel

1. Client Panel → **Settings → Runtime**
2. Select **Node.js 22** or **Node.js 20** from the catalog dropdown
3. Review the compatibility notice (Node.js requires Business/Premium)
4. Click **Apply** — platform triggers zero-downtime pod replacement

### Switching via Management API

```http
PATCH /api/v1/clients/{client-id}
Content-Type: application/json

{
  "catalog_image": "node22"
}
```

**Response:**

```json
{
  "status": "switching",
  "catalog_image": "node22",
  "estimated_completion_seconds": 60,
  "job_id": "job-abc123"
}
```

Poll `GET /api/v1/clients/{client-id}/jobs/job-abc123` for completion status.

### Plan Enforcement

If a Starter plan customer attempts to select a Node.js image:

- **Client Panel:** The Node.js options are grayed out with tooltip: _"Node.js requires Business or Premium plan."_
- **API:** Returns `HTTP 422 Unprocessable Entity` with `error: "catalog_image_not_available_on_plan"`

---

## 10. Customer Deployment Guide

### Prerequisites

- Business or Premium plan active
- Catalog image set to `node22` or `node20`
- Application listens on `process.env.PORT` (default `3000`)
- Application exposes `GET /healthz` returning HTTP 200

---

### Step 1: Prepare Your Application

Ensure your app is production-ready:

```javascript
// server.js — minimal Express example
const express = require('express');
const app = express();

// Required: health check endpoint
app.get('/healthz', (req, res) => res.json({ status: 'ok' }));

// Your application routes
app.get('/', (req, res) => res.send('Hello from Node.js!'));

// Required: use PORT env var
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
```

Add startup config (choose one):

**Option A — `ecosystem.config.js` (recommended):**

```javascript
module.exports = {
  apps: [{
    name: 'app',
    script: './server.js',
    instances: 1,
    exec_mode: 'fork',
    error_file: '/dev/stderr',
    out_file: '/dev/stdout',
  }]
};
```

**Option B — `package.json` start script:**

```json
{
  "scripts": {
    "start": "node server.js"
  }
}
```

---

### Step 2: Switch Catalog Image

1. Client Panel → **Settings → Runtime → Node.js 22**
2. Click **Apply**
3. Wait for pod replacement to complete (approximately 1–3 minutes)
4. Confirm runtime shows **Node.js 22** in the panel

---

### Step 3: Deploy Files

**Via Git Deploy (recommended):**

1. Client Panel → **Domains → {domain} → Git Deploy → Configure**
2. Set repository URL, branch (`main`), and SSH key
3. Enable **"Run npm install after deploy"**
4. Click **Deploy Now** or push to your branch
5. Monitor progress in Client Panel → **Deployments**

**Via SFTP:**

1. Connect via SFTP to `sftp.platform.com` with your credentials
2. Navigate to `domains/{domain}/public_html/`
3. Upload all application files **including `node_modules/`**
   - Or upload without `node_modules/` and trigger npm install manually via Client Panel → Deployments → **Run Hooks**

**Via FileBrowser:**

1. Client Panel → **Files → File Manager**
2. Navigate to `domains/{domain}/public_html/`
3. Upload application files including `node_modules/`

---

### Step 4: Verify Health

```bash
# Check health endpoint responds
curl -I https://{domain}/healthz
# Expected: HTTP/2 200

# Check application is live
curl https://{domain}/
```

In Kubernetes (admin / operations team):

```bash
# Check pod is running and ready
kubectl get pods -n client-{client-id}
# Expected: web-xxxx  1/1  Running  0  2m

# Check health probe status
kubectl describe pod web-xxxx -n client-{client-id}

# View application logs
kubectl logs -f deployment/web -n client-{client-id}
```

---

### Step 5: Set Environment Variables

For database connections and other config:

1. Client Panel → **Settings → Environment Variables**
2. Click **Add Variable** — enter key and value
3. Click **Save** — pod restarts automatically

Platform-provided variables (`PORT`, `NODE_ENV`, `DATABASE_URL`, etc.) are pre-configured and do not need to be set manually.

---

## 11. Troubleshooting

### Pod not starting — `CrashLoopBackOff`

**Symptoms:** `kubectl get pods` shows `CrashLoopBackOff`

**Causes and fixes:**

| Cause | Diagnosis | Fix |
|-------|-----------|-----|
| App crashes on startup | `kubectl logs deployment/web -n client-{id}` | Fix the runtime error in application code |
| Missing `node_modules/` | Logs show `Cannot find module` | Re-deploy via Git Deploy with npm install hook enabled, or upload `node_modules/` via SFTP |
| App not listening on `PORT` | Logs show server on port 8080 or hardcoded port | Change app to use `process.env.PORT` |
| No `start` script and no `ecosystem.config.js` | Logs show `index.js not found` | Add `ecosystem.config.js` or `package.json` with `start` script |

### Pod running but requests return 502/503

**Symptoms:** App pod is `Running` but browser shows 502 Bad Gateway

**Causes and fixes:**

| Cause | Diagnosis | Fix |
|-------|-----------|-----|
| Readiness probe failing | `kubectl describe pod` shows failing readiness | App not responding on `/healthz` — add the endpoint |
| App listening on wrong port | App logs show port other than 3000 | Use `process.env.PORT` |
| App crashed (PM2 restarting) | PM2 logs show repeated restarts | Fix application crash; check `kubectl logs` for error |

### Health check returns non-200

The `/healthz` endpoint must return **HTTP 200**. Any other status code (including 404, 500) will cause the readiness probe to fail and the pod will not receive traffic.

```javascript
// Wrong — returns 404
app.get('/health', (req, res) => res.json({ status: 'ok' }));  // route is /health not /healthz

// Correct
app.get('/healthz', (req, res) => res.status(200).json({ status: 'ok' }));
```

### npm install fails in post-deploy hook

Check deployment logs in Client Panel → **Deployments → [deployment] → Logs** for the full npm error output.

Common issues:
- `package.json` not present in `public_html/` — ensure it is committed to the repo root
- Private package registry requires auth — contact support to configure registry credentials
- `package-lock.json` mismatch — run `npm install` locally and commit the updated lockfile

### Database connection refused

`DATABASE_URL` is injected automatically. If the app cannot connect:

1. Verify the app reads `process.env.DATABASE_URL` (not a hardcoded connection string)
2. Check the database is provisioned: Client Panel → **Databases**
3. Contact support if `DATABASE_URL` appears incorrect

---

## Related Documentation

- **WORKLOAD_DEPLOYMENT.md** — Container catalog overview and shared/dedicated pod architecture
- **HOSTING_PLANS.md** — Plan definitions and resource limits
- **DEPLOYMENT_PROCESS.md** — Git Deploy, SFTP, and FileBrowser deployment methods
- **CLIENT_PANEL_FEATURES.md** — Client Panel UI for runtime switching and environment variables
- **FRONTEND_DEPLOYMENT_ARCHITECTURE.md** — Platform port/health check conventions (reference)
- **STORAGE_DATABASES.md** — Database provisioning per plan
