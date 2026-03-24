# Frontend Deployment Architecture

> **Status:** Final
> **Last Updated:** 2026-03-03
> **Frontend Stack:** React 18+, Tailwind CSS, TypeScript
> **Deployment:** Single K8s Deployment + Configurable Ingress Routing

---

## Overview

The admin and client panels run as **a single React application** deployed on a single address/port, with **path-based routing** (`/admin/*`, `/client/*`) to differentiate between them. The deployment supports **three access methods**:

1. **Domain-based:** `https://panel.platform.com/admin/` and `https://panel.platform.com/client/`
2. **IP-based:** `https://1.2.3.4/admin/` and `https://1.2.3.4/client/`
3. **Root domain redirect:** `https://panel.platform.com/` → Configurable external website

## Architecture

### Single React SPA with Dual Entry Points

```
Frontend Application
├── /admin/*                    → Admin Panel (175+ features)
│   ├── Dashboard
│   ├── Clients Management
│   ├── Billing & Plans
│   ├── Support
│   └── ... (all admin routes)
│
├── /client/*                   → Client Panel (40+ features)
│   ├── Dashboard
│   ├── Domains
│   ├── Databases
│   ├── Files
│   └── ... (all client routes)
│
└── /                           → Redirect to external website
    └── (Configurable via environment variable)
```

### Deployment Model

```
┌─────────────────────────────────────────┐
│     Kubernetes Cluster (Ingress)        │
├─────────────────────────────────────────┤
│                                         │
│  ┌─────────────────────────────────┐   │
│  │    NGINX Ingress Controller     │   │
│  └─────────────────────────────────┘   │
│                  │                      │
│   ┌──────────────┼──────────────┐      │
│   │              │              │      │
│   ▼              ▼              ▼      │
│ /admin/    /client/        / (root)    │
│   │              │              │      │
│   └──────────────┴──────────────┘      │
│              │                         │
│              ▼                         │
│   ┌──────────────────────────┐        │
│   │  Frontend Service        │        │
│   │  (React SPA - Port 3000) │        │
│   └──────────────────────────┘        │
│                                         │
└─────────────────────────────────────────┘
        │
        ▼ (Separate Kubernetes Service)
┌─────────────────────────────────────────┐
│   Management API Service (Port 5000)    │
│   - /v1/admin/* endpoints               │
│   - /v1/client/* endpoints              │
└─────────────────────────────────────────┘
```

### Request Flow

#### Domain-Based Access
```
1. User visits: https://panel.platform.com/admin/
   ↓
2. NGINX Ingress matches:
   - Host: panel.platform.com
   - Path: /admin/* (regex match)
   ↓
3. Routes to Frontend Service:3000
   ↓
4. React app loads with role=admin
   ↓
5. API calls: https://api.platform.com/v1/admin/* (CORS enabled)
```

#### IP-Based Access
```
1. User visits: https://1.2.3.4/admin/
   ↓
2. NGINX Ingress matches:
   - Host: * (any host/IP)
   - Path: /admin/* (regex match)
   ↓
3. Routes to Frontend Service:3000
   ↓
4. React app loads with role=admin (detected from path)
   ↓
5. API calls: https://1.2.3.4/api/v1/admin/* (or absolute API domain)
```

#### Root Domain Access
```
1. User visits: https://panel.platform.com/
   ↓
2. NGINX Ingress matches:
   - Host: panel.platform.com
   - Path: / (exact or root match)
   ↓
3. NGINX responds with HTTP 301/302 redirect to:
   https://external-website.com (configured in Ingress annotation)
   ↓
4. Browser follows redirect to external site
```

---

## Kubernetes Configuration

### Frontend Deployment

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  namespace: platform
  labels:
    app: frontend
spec:
  replicas: 2  # HA
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
    spec:
      serviceAccountName: frontend-sa
      containers:
      - name: frontend
        image: harbor.platform.com/platform/frontend:latest
        imagePullPolicy: IfNotPresent
        ports:
        - containerPort: 3000
          name: http
        env:
        - name: REACT_APP_API_URL
          value: "https://api.platform.com"  # Absolute URL for consistency
        - name: REACT_APP_ENVIRONMENT
          value: "production"
        - name: ROOT_REDIRECT_URL
          value: "https://external-website.com"  # Configurable
        livenessProbe:
          httpGet:
            path: /health
            port: 3000
          initialDelaySeconds: 10
          periodSeconds: 10
        readinessProbe:
          httpGet:
            path: /
            port: 3000
          initialDelaySeconds: 5
          periodSeconds: 5
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 512Mi
```

### Frontend Service

```yaml
apiVersion: v1
kind: Service
metadata:
  name: frontend
  namespace: platform
  labels:
    app: frontend
spec:
  type: ClusterIP
  selector:
    app: frontend
  ports:
  - name: http
    port: 80
    targetPort: 3000
    protocol: TCP
```

### Ingress Configuration (Path-Based Routing)

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: frontend-ingress
  namespace: platform
  annotations:
    # NGINX Ingress annotations
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/use-regex: "true"
    nginx.ingress.kubernetes.io/rewrite-target: "/$2"
    
    # Root path redirect (configurable)
    nginx.ingress.kubernetes.io/configuration-snippet: |
      location = / {
        return 301 https://external-website.com;
      }
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - panel.platform.com
    - "*.platform.com"  # For IP-based access via DNS
    secretName: frontend-tls
  rules:
  # Domain-based routing: panel.platform.com
  - host: panel.platform.com
    http:
      paths:
      - path: /admin(/|$)(.*)
        pathType: ImplementationSpecific
        backend:
          service:
            name: frontend
            port:
              number: 80
      - path: /client(/|$)(.*)
        pathType: ImplementationSpecific
        backend:
          service:
            name: frontend
            port:
              number: 80
  
  # IP-based routing: catch-all for any host (including IPs)
  - host: "*"  # Matches any hostname or IP
    http:
      paths:
      - path: /admin(/|$)(.*)
        pathType: ImplementationSpecific
        backend:
          service:
            name: frontend
            port:
              number: 80
      - path: /client(/|$)(.*)
        pathType: ImplementationSpecific
        backend:
          service:
            name: frontend
            port:
              number: 80
```

### Alternative: Advanced Ingress with Lua Scripting (Optional)

For more sophisticated routing logic, you can use NGINX Lua annotations:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: frontend-ingress-advanced
  namespace: platform
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/enable-lua: "true"
    nginx.ingress.kubernetes.io/lua-shared-dicts: "redirect_urls 10m"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      # Shared dictionary for redirect URLs (can be updated without redeployment)
      local redirect_urls = ngx.shared.redirect_urls
      local root_url = redirect_urls:get("root_url") or "https://external-website.com"
      
      location = / {
        return 301 root_url
      }
      
      location ~^/(admin|client)/ {
        proxy_pass http://frontend:80;
      }
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - panel.platform.com
    secretName: frontend-tls
  rules:
  - host: panel.platform.com
    http:
      paths:
      - path: /
        pathType: Prefix
        backend:
          service:
            name: frontend
            port:
              number: 80
```

---

## IP-Based Access Configuration

### Option 1: Direct IP Access (No DNS Required)

NGINX Ingress automatically handles IP-based access. Simply configure:

```bash
# Get cluster IP or load balancer IP
kubectl get svc -n ingress-nginx nginx-ingress-controller

# Users can access:
# https://1.2.3.4/admin/
# https://1.2.3.4/client/
```

**Requirement:** SSL certificate must be valid for the IP address (use wildcard or SAN cert).

**Certificate Configuration:**

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: frontend-cert
  namespace: platform
spec:
  secretName: frontend-tls
  duration: 2160h  # 90 days
  renewBefore: 360h  # 15 days
  commonName: panel.platform.com
  dnsNames:
  - panel.platform.com
  - "*.panel.platform.com"
  # Optional: Add IP if cert provider supports it (most don't for Let's Encrypt)
  # ipAddresses:
  # - 1.2.3.4
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
```

**Important Note:** Let's Encrypt doesn't issue certificates for IP addresses. For IP-based HTTPS access:

- **Option A:** Use a self-signed cert for IP access (warning in browser)
- **Option B:** Use a wildcard DNS domain (`*.platform.com` → `1.2.3.4`) and issue cert for the domain
- **Option C:** Use HAProxy/Traefik with dynamic routing in front of NGINX

### Option 2: DNS-Based IP Access (Recommended for Production)

```bash
# DNS A record
panel.platform.com. IN A 1.2.3.4
*.panel.platform.com. IN A 1.2.3.4

# Users can access:
# https://panel.platform.com/admin/
# https://panel.platform.com/client/
# https://any-subdomain.platform.com/admin/  (catches all via wildcard)
```

---

## Root Domain Redirect Configuration

### Option 1: Static Configuration (Simple)

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: frontend-config
  namespace: platform
data:
  root-redirect-url: "https://external-website.com"
  redirect-enabled: "true"
```

**Update Frontend Deployment:**

```yaml
env:
- name: ROOT_REDIRECT_URL
  valueFrom:
    configMapKeyRef:
      name: frontend-config
      key: root-redirect-url
- name: REDIRECT_ENABLED
  valueFrom:
    configMapKeyRef:
      name: frontend-config
      key: redirect-enabled
```

**Update Ingress:**

```yaml
annotations:
  nginx.ingress.kubernetes.io/configuration-snippet: |
    location = / {
      return 301 https://external-website.com;
    }
```

### Option 2: Dynamic Configuration (Admin Control)

Create an API endpoint to update the redirect URL without redeploying:

**Management API Endpoint:**

```
PATCH /v1/admin/settings/panel-redirect
Content-Type: application/json

{
  "redirect_url": "https://new-website.com",
  "enabled": true
}
```

**Implementation:**

1. Store redirect URL in ConfigMap or database
2. NGINX Lua script reads from shared dictionary
3. Admin API updates ConfigMap/dict
4. Lua script picks up changes without restart

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: frontend-ingress
  namespace: platform
  annotations:
    nginx.ingress.kubernetes.io/enable-lua: "true"
    nginx.ingress.kubernetes.io/lua-shared-dicts: "config 1m"
    nginx.ingress.kubernetes.io/configuration-snippet: |
      location = / {
        access_by_lua_block {
          local config = ngx.shared.config
          local redirect_url = config:get("root_redirect_url") or "https://external-website.com"
          return ngx.redirect(redirect_url, 301)
        }
      }
```

---

## React Frontend Implementation

### Routing Structure

```typescript
// src/App.tsx
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import AdminLayout from './layouts/AdminLayout';
import ClientLayout from './layouts/ClientLayout';
import LoginPage from './pages/LoginPage';
import ProtectedRoute from './components/ProtectedRoute';

function App() {
  const [user, setUser] = useState<User | null>(null);
  const [role, setRole] = useState<'admin' | 'client' | null>(null);

  // Detect role from URL path on initial load
  useEffect(() => {
    const pathRole = window.location.pathname.startsWith('/admin') 
      ? 'admin' 
      : window.location.pathname.startsWith('/client') 
      ? 'client' 
      : null;
    
    if (pathRole) {
      setRole(pathRole);
    }
  }, []);

  return (
    <Router>
      <Routes>
        <Route path="/login" element={<LoginPage onLogin={(u, r) => { setUser(u); setRole(r); }} />} />
        
        <Route path="/admin/*" element={
          <ProtectedRoute user={user} requiredRole="admin">
            <AdminLayout />
          </ProtectedRoute>
        } />
        
        <Route path="/client/*" element={
          <ProtectedRoute user={user} requiredRole="client">
            <ClientLayout />
          </ProtectedRoute>
        } />
        
        <Route path="/" element={<Navigate to={role === 'admin' ? '/admin/dashboard' : '/client/dashboard'} />} />
      </Routes>
    </Router>
  );
}

export default App;
```

### ProtectedRoute Component

```typescript
// src/components/ProtectedRoute.tsx
import { Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

interface Props {
  children: React.ReactNode;
  requiredRole: 'admin' | 'client';
  user?: User | null;
}

export default function ProtectedRoute({ children, requiredRole, user }: Props) {
  const { user: authUser, role, isLoading } = useAuth();
  const currentUser = user || authUser;

  if (isLoading) {
    return <LoadingSpinner />;
  }

  if (!currentUser) {
    return <Navigate to="/login" />;
  }

  if (role !== requiredRole) {
    return <Navigate to={role === 'admin' ? '/admin/dashboard' : '/client/dashboard'} />;
  }

  return <>{children}</>;
}
```

### API Client Configuration

```typescript
// src/api/client.ts
import axios from 'axios';

// Use absolute URL for API to work with both domain and IP access
const API_URL = process.env.REACT_APP_API_URL || 'https://api.platform.com';

export const apiClient = axios.create({
  baseURL: API_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  withCredentials: true,  // Include cookies for CORS
});

// Automatically add role to requests
apiClient.interceptors.request.use((config) => {
  const role = window.location.pathname.startsWith('/admin') ? 'admin' : 'client';
  config.headers['X-Panel-Role'] = role;
  return config;
});
```

### Environment Variables

```bash
# .env.production
REACT_APP_API_URL=https://api.platform.com
REACT_APP_ENVIRONMENT=production
REACT_APP_LOG_LEVEL=error
REACT_APP_ENABLE_SENTRY=true
```

---

## CORS Configuration

Since the frontend and API may be on different domains, configure CORS:

**Management API (Express/Fastify):**

```javascript
// Note: Implementation uses Fastify (see ADR-011). Express example retained for conceptual reference.
import cors from 'cors';

app.use(cors({
  origin: [
    'https://panel.platform.com',
    'https://admin.platform.com',
    'https://client.platform.com',
    `https://${process.env.CLUSTER_IP}`,  // Restrict to actual cluster IP, never use wildcard regex
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Panel-Role', 'X-Idempotency-Key'],
  maxAge: 86400, // 24 hours
}));
```

**Fastify (canonical implementation):**

```javascript
import { fastifyCors } from '@fastify/cors';

fastify.register(fastifyCors, {
  origin: [
    'https://panel.platform.com',
    'https://admin.platform.com',
    'https://client.platform.com',
    `https://${process.env.CLUSTER_IP}`,  // Restrict to actual cluster IP
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE', 'PUT', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Panel-Role', 'X-Idempotency-Key'],
  maxAge: 86400,
});
```

> **Security note:** Never use a regex pattern like `/^https:\/\/\d+\.\d+\.\d+\.\d+$/` in production — it allows CORS from any IP address. Always restrict to the specific cluster IP via environment variable.

---

## Access Control Matrix

| Access Method | Admin Panel | Client Panel | Root Redirect |
|---|---|---|---|
| `https://panel.platform.com/admin/` | ✅ Yes | ❌ No | ❌ No |
| `https://panel.platform.com/client/` | ❌ No | ✅ Yes | ❌ No |
| `https://panel.platform.com/` | ❌ No | ❌ No | ✅ Yes (redirect) |
| `https://1.2.3.4/admin/` | ✅ Yes | ❌ No | ❌ No |
| `https://1.2.3.4/client/` | ❌ No | ✅ Yes | ❌ No |
| `https://1.2.3.4/` | ❌ No | ❌ No | ⚠️ Blocked (no redirect) |

---

## Health Check Endpoints

For monitoring and load balancer health checks:

**Frontend Health Endpoints:**

```
GET /health                    → Returns 200 if app is ready
GET /health/live              → Returns 200 if pod is alive
GET /health/ready             → Returns 200 if app dependencies are ready
```

**React Implementation:**

```typescript
// src/routes/health.ts
import { Router } from 'express';

const router = Router();

router.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

router.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'alive' });
});

router.get('/health/ready', async (req, res) => {
  try {
    // Check API connectivity
    await apiClient.get('/v1/health');
    res.status(200).json({ status: 'ready' });
  } catch (err) {
    res.status(503).json({ status: 'not ready', error: err.message });
  }
});

export default router;
```

---

## Deployment Steps

### 1. Build Docker Image

```dockerfile
# Dockerfile
FROM node:18-alpine AS builder

WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:18-alpine

WORKDIR /app
COPY --from=builder /app/build ./build
COPY --from=builder /app/server.js ./server.js
COPY package*.json ./
RUN npm ci --only=production

EXPOSE 3000
CMD ["node", "server.js"]
```

**Build and Push:**

```bash
docker build -t harbor.platform.com/platform/frontend:latest .
docker push harbor.platform.com/platform/frontend:latest
```

### 2. Deploy to Kubernetes

```bash
# Apply configuration
kubectl apply -f frontend-deployment.yaml
kubectl apply -f frontend-service.yaml
kubectl apply -f frontend-ingress.yaml

# Verify
kubectl get pods -n platform
kubectl get svc -n platform
kubectl get ingress -n platform

# Monitor logs
kubectl logs -f deployment/frontend -n platform
```

### 3. Test Access

```bash
# Domain-based access
curl -I https://panel.platform.com/admin/
curl -I https://panel.platform.com/client/
curl -I https://panel.platform.com/

# IP-based access (after DNS or /etc/hosts entry)
curl -I https://1.2.3.4/admin/
curl -I https://1.2.3.4/client/
```

---

## Configuration Summary

| Component | Value | Notes |
|---|---|---|
| **Frontend Port** | 3000 | Internal container port |
| **Service Port** | 80 | Internal K8s service port |
| **External Protocol** | HTTPS | TLS via cert-manager |
| **Admin Path** | `/admin/*` | Regex match, rewrite to `/$2` |
| **Client Path** | `/client/*` | Regex match, rewrite to `/$2` |
| **Root Path** | `/` | Redirect to external URL |
| **IP Access** | Enabled | Via NGINX catch-all host rule |
| **API Domain** | api.platform.com | Separate from frontend (CORS) |
| **CORS Origins** | panel.platform.com, IPs | Configurable in API |

---

## Monitoring & Observability

### Prometheus Metrics

```yaml
# ServiceMonitor for Frontend
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: frontend-monitor
  namespace: platform
spec:
  selector:
    matchLabels:
      app: frontend
  endpoints:
  - port: http
    path: /metrics
    interval: 30s
```

### Grafana Dashboards

- Frontend Response Time (by path: /admin, /client, /)
- Request Rate by Path
- Error Rate by HTTP Status Code
- Pod CPU/Memory Usage
- TLS Certificate Expiration

### Alerts

```yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: frontend-alerts
  namespace: platform
spec:
  groups:
  - name: frontend
    rules:
    - alert: FrontendHighErrorRate
      expr: rate(http_requests_total{status=~"5.."}[5m]) > 0.05
      for: 5m
      annotations:
        summary: "Frontend error rate > 5%"
    
    - alert: FrontendTLSCertExpiring
      expr: certmanager_certificate_expiration_timestamp_seconds - time() < 7*24*3600
      annotations:
        summary: "Frontend TLS certificate expiring in < 7 days"
```

---

## Troubleshooting

### Issue: IP-based access returns 404

**Solution:** Ensure NGINX Ingress has a catch-all host rule (`host: "*"` or `host: ""`)

### Issue: Root redirect not working

**Solution:** Check Ingress configuration-snippet annotation, verify NGINX controller has lua enabled

### Issue: CORS errors when accessing from IP

**Solution:** Update API CORS configuration to include the IP address or use a wildcard pattern

### Issue: 301 redirect loop on root

**Solution:** Ensure redirect URL is different from panel domain, check Ingress rewrite rules

---

## Related Documentation

- **MANAGEMENT_API_SPEC.md** - API endpoint specifications
- **SECURITY_ARCHITECTURE.md** - OIDC authentication
- **PLATFORM_ARCHITECTURE.md** - Overall system architecture
- **ADMIN_PANEL_REQUIREMENTS.md** - Admin panel features
- **CLIENT_PANEL_FEATURES.md** - Client panel features
