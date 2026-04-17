# Frontend Ingress Configurations

> **Status:** Final
> **Last Updated:** 2026-03-03
> **Purpose:** Complete Kubernetes Ingress examples for different deployment scenarios

---

## Table of Contents

1. [Scenario A: Basic Path-Based Routing](#scenario-a-basic-path-based-routing)
2. [Scenario B: Domain + IP-Based Access](#scenario-b-domain--ip-based-access)
3. [Scenario C: Advanced with Lua](#scenario-c-advanced-with-lua)
4. [Scenario D: Multiple Load Balancers](#scenario-d-multiple-load-balancers)
5. [Testing & Verification](#testing--verification)
6. [Troubleshooting](#troubleshooting)

---

## Scenario A: Basic Path-Based Routing

**Use Case:** Simple deployment with domain access only. Root domain redirects to external website.

### Files

**1. namespace.yaml**

```yaml
apiVersion: v1
kind: Namespace
metadata:
  name: platform
  labels:
    name: platform
```

**2. frontend-deployment.yaml**

```yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: frontend
  namespace: platform
  labels:
    app: frontend
    version: v1
spec:
  replicas: 2
  strategy:
    type: RollingUpdate
    rollingUpdate:
      maxSurge: 1
      maxUnavailable: 0
  selector:
    matchLabels:
      app: frontend
  template:
    metadata:
      labels:
        app: frontend
      annotations:
        prometheus.io/scrape: "true"
        prometheus.io/port: "3000"
        prometheus.io/path: "/metrics"
    spec:
      serviceAccountName: frontend-sa
      securityContext:
        runAsNonRoot: true
        runAsUser: 1000
        fsGroup: 1000
      containers:
      - name: frontend
        image: harbor.platform.com/platform/frontend:latest
        imagePullPolicy: IfNotPresent
        securityContext:
          allowPrivilegeEscalation: false
          readOnlyRootFilesystem: true
          capabilities:
            drop:
            - ALL
        ports:
        - containerPort: 3000
          name: http
          protocol: TCP
        env:
        - name: NODE_ENV
          value: "production"
        - name: REACT_APP_API_URL
          value: "https://api.platform.com"
        - name: REACT_APP_LOG_LEVEL
          value: "error"
        volumeMounts:
        - name: tmp
          mountPath: /tmp
        - name: var-cache
          mountPath: /var/cache
        livenessProbe:
          httpGet:
            path: /health/live
            port: 3000
            scheme: HTTP
          initialDelaySeconds: 15
          periodSeconds: 10
          timeoutSeconds: 5
          failureThreshold: 3
        readinessProbe:
          httpGet:
            path: /health/ready
            port: 3000
            scheme: HTTP
          initialDelaySeconds: 10
          periodSeconds: 5
          timeoutSeconds: 3
          failureThreshold: 2
        resources:
          requests:
            cpu: 100m
            memory: 256Mi
          limits:
            cpu: 500m
            memory: 512Mi
      volumes:
      - name: tmp
        emptyDir: {}
      - name: var-cache
        emptyDir: {}
      affinity:
        podAntiAffinity:
          preferredDuringSchedulingIgnoredDuringExecution:
          - weight: 100
            podAffinityTerm:
              labelSelector:
                matchExpressions:
                - key: app
                  operator: In
                  values:
                  - frontend
              topologyKey: kubernetes.io/hostname
```

**3. frontend-service.yaml**

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
  sessionAffinity: None
```

**4. frontend-ingress-basic.yaml**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: frontend-ingress
  namespace: platform
  annotations:
    # TLS Certificate
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    
    # NGINX Annotations
    nginx.ingress.kubernetes.io/use-regex: "true"
    nginx.ingress.kubernetes.io/rewrite-target: "/$2"
    nginx.ingress.kubernetes.io/add-base-url: "true"
    
    # Security
    nginx.ingress.kubernetes.io/ssl-protocols: "TLSv1.2 TLSv1.3"
    nginx.ingress.kubernetes.io/ssl-ciphers: "HIGH:!aNULL:!MD5"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
    nginx.ingress.kubernetes.io/hsts: "true"
    nginx.ingress.kubernetes.io/hsts-max-age: "31536000"
    nginx.ingress.kubernetes.io/hsts-include-subdomains: "true"
    
    # Root path redirect to external website
    nginx.ingress.kubernetes.io/configuration-snippet: |
      location = / {
        return 301 https://external-website.com;
      }
spec:
  ingressClassName: nginx
  tls:
  - hosts:
    - panel.platform.com
    secretName: frontend-tls-basic
  rules:
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
```

**5. frontend-rbac.yaml**

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: frontend-sa
  namespace: platform

---

apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: frontend-role
  namespace: platform
rules:
- apiGroups: [""]
  resources: ["configmaps"]
  verbs: ["get", "list", "watch"]

---

apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: frontend-rolebinding
  namespace: platform
roleRef:
  apiGroup: rbac.authorization.k8s.io
  kind: Role
  name: frontend-role
subjects:
- kind: ServiceAccount
  name: frontend-sa
  namespace: platform
```

### Deployment

```bash
# 1. Create namespace
kubectl apply -f namespace.yaml

# 2. Create RBAC
kubectl apply -f frontend-rbac.yaml

# 3. Deploy frontend
kubectl apply -f frontend-deployment.yaml
kubectl apply -f frontend-service.yaml

# 4. Deploy ingress
kubectl apply -f frontend-ingress-basic.yaml

# 5. Verify
kubectl get all -n platform
kubectl get ingress -n platform
kubectl describe ingress frontend-ingress -n platform
```

---

## Scenario B: Domain + IP-Based Access

**Use Case:** Allow access via domain (panel.platform.com) and direct IP (1.2.3.4) with proper TLS handling.

### Files

**1. frontend-ingress-domain-and-ip.yaml**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: frontend-ingress
  namespace: platform
  annotations:
    # TLS Certificate
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    
    # NGINX Annotations
    nginx.ingress.kubernetes.io/use-regex: "true"
    nginx.ingress.kubernetes.io/rewrite-target: "/$2"
    
    # Security Headers
    nginx.ingress.kubernetes.io/ssl-protocols: "TLSv1.2 TLSv1.3"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
    nginx.ingress.kubernetes.io/hsts: "true"
    nginx.ingress.kubernetes.io/hsts-max-age: "31536000"
    
    # Custom routing for root path
    nginx.ingress.kubernetes.io/configuration-snippet: |
      # Root path redirect (only for domain, not for IP)
      if ($host = "panel.platform.com") {
        location = / {
          return 301 https://external-website.com;
        }
      }
      
      # For IP-based access, return 404 on root
      if ($host != "panel.platform.com") {
        location = / {
          return 404;
        }
      }
spec:
  ingressClassName: nginx
  tls:
  # Certificate for domain
  - hosts:
    - panel.platform.com
    secretName: frontend-tls-domain
  # Certificate for IP (wildcard DNS subdomain)
  - hosts:
    - "*.panel-ip.k8s-platform.test"
    secretName: frontend-tls-ip
  
  rules:
  # Domain-based routing
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
  
  # IP-based routing (catch-all host)
  # This rule matches ANY hostname/IP not matched above
  - host: ""  # Empty host matches all
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

**2. certificate-domain.yaml**

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: frontend-cert-domain
  namespace: platform
spec:
  secretName: frontend-tls-domain
  duration: 2160h  # 90 days
  renewBefore: 360h  # 15 days before expiry
  commonName: panel.platform.com
  dnsNames:
  - panel.platform.com
  - "*.panel.platform.com"
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
```

**3. certificate-ip.yaml (for DNS-based IP access)**

```yaml
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: frontend-cert-ip
  namespace: platform
spec:
  secretName: frontend-tls-ip
  duration: 2160h  # 90 days
  renewBefore: 360h
  commonName: "*.panel-ip.k8s-platform.test"
  dnsNames:
  - "*.panel-ip.k8s-platform.test"
  issuerRef:
    name: selfsigned-issuer  # Self-signed for local IPs
    kind: Issuer
```

**4. self-signed-issuer.yaml**

```yaml
apiVersion: cert-manager.io/v1
kind: Issuer
metadata:
  name: selfsigned-issuer
  namespace: platform
spec:
  selfSigned:
    crlDistributionPoints: []
```

### DNS Setup for IP Access

```bash
# In your DNS provider or local /etc/hosts:
# Map IP to a subdomain

# Example: If your platform IP is 1.2.3.4
1.2.3.4  admin.panel-ip.k8s-platform.test
1.2.3.4  client.panel-ip.k8s-platform.test
1.2.3.4  panel.platform.com
```

### Deployment

```bash
# Apply everything
kubectl apply -f frontend-rbac.yaml
kubectl apply -f frontend-deployment.yaml
kubectl apply -f frontend-service.yaml
kubectl apply -f self-signed-issuer.yaml
kubectl apply -f certificate-domain.yaml
kubectl apply -f certificate-ip.yaml
kubectl apply -f frontend-ingress-domain-and-ip.yaml

# Verify certificates are issued
kubectl get certificates -n platform
kubectl describe cert frontend-cert-domain -n platform
kubectl describe cert frontend-cert-ip -n platform

# Test
curl -I https://panel.platform.com/admin/
curl -I https://admin.panel-ip.k8s-platform.test/admin/
```

---

## Scenario C: Advanced with Lua

**Use Case:** Dynamic redirect URL without redeploying, custom routing logic, real-time configuration updates.

### Files

**1. frontend-configmap.yaml**

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: frontend-config
  namespace: platform
data:
  root-redirect-url: "https://external-website.com"
  redirect-enabled: "true"
  admin-path: "/admin"
  client-path: "/client"
```

**2. frontend-ingress-lua.yaml**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: frontend-ingress
  namespace: platform
  annotations:
    # TLS
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    
    # Enable Lua scripting
    nginx.ingress.kubernetes.io/enable-lua: "true"
    nginx.ingress.kubernetes.io/lua-shared-dicts: "frontend_config 10m"
    nginx.ingress.kubernetes.io/rewrite-target: "/$2"
    
    # Security
    nginx.ingress.kubernetes.io/ssl-protocols: "TLSv1.2 TLSv1.3"
    nginx.ingress.kubernetes.io/force-ssl-redirect: "true"
    
    # Advanced Lua routing configuration
    nginx.ingress.kubernetes.io/configuration-snippet: |
      # Update shared dictionary from environment (set by controller)
      init_by_lua_block {
        local config = ngx.shared.frontend_config
        config:set("root_redirect_url", os.getenv("ROOT_REDIRECT_URL") or "https://external-website.com")
        config:set("redirect_enabled", os.getenv("REDIRECT_ENABLED") or "true")
      }
      
      # Handle root path with dynamic redirect
      location = / {
        access_by_lua_block {
          local config = ngx.shared.frontend_config
          local enabled = config:get("redirect_enabled")
          
          if enabled == "true" then
            local redirect_url = config:get("root_redirect_url")
            return ngx.redirect(redirect_url, 301)
          else
            ngx.status = 404
            ngx.say("Not Found")
            return ngx.OK
          end
        }
      }
      
      # Log routing decision
      location ~ ^/(admin|client)/ {
        access_by_lua_block {
          local path = ngx.var.uri
          local method = ngx.req.get_method()
          ngx.log(ngx.INFO, "Frontend Access: " .. method .. " " .. path)
        }
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
  - host: ""  # Catch-all for IP access
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

**3. update-redirect-url-job.yaml (Admin API handler)**

This example shows how to update the redirect URL via Management API without redeploying:

```yaml
apiVersion: v1
kind: ConfigMap
metadata:
  name: frontend-config
  namespace: platform
data:
  redirect-url: "https://external-website.com"
---
# This ConfigMap is watched by NGINX controller
# When updated, NGINX controller reloads config and re-initializes Lua state
```

### Update Redirect URL (via API)

```javascript
// Management API endpoint to update redirect URL
// POST /v1/admin/settings/panel-redirect

app.patch('/v1/admin/settings/panel-redirect', async (req, res) => {
  const { redirectUrl, enabled } = req.body;
  
  // Update ConfigMap
  try {
    const k8s = require('@kubernetes/client-node');
    const kc = new k8s.KubeConfig();
    kc.loadFromDefault();
    
    const api = kc.makeApiClient(k8s.CoreV1Api);
    const configMap = await api.readNamespacedConfigMap('frontend-config', 'platform');
    
    configMap.body.data['root-redirect-url'] = redirectUrl;
    configMap.body.data['redirect-enabled'] = enabled ? 'true' : 'false';
    
    await api.patchNamespacedConfigMap(
      'frontend-config',
      'platform',
      configMap.body,
      undefined,
      undefined,
      undefined,
      { headers: { 'Content-Type': 'application/strategic-merge-patch+json' } }
    );
    
    // NGINX controller watches ConfigMap and reloads automatically
    res.json({ success: true, message: 'Redirect URL updated' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

### Deployment

```bash
# Apply configuration
kubectl apply -f frontend-rbac.yaml
kubectl apply -f frontend-deployment.yaml
kubectl apply -f frontend-service.yaml
kubectl apply -f frontend-configmap.yaml
kubectl apply -f frontend-ingress-lua.yaml

# Verify Lua is enabled
kubectl get ingress frontend-ingress -n platform -o yaml | grep lua

# Test
curl -I https://panel.platform.com/  # Should redirect
curl -I https://panel.platform.com/admin/  # Should load admin panel

# Update redirect URL via API (without redeploying)
curl -X PATCH https://api.platform.com/v1/admin/settings/panel-redirect \
  -H "Content-Type: application/json" \
  -d '{"redirectUrl": "https://new-website.com", "enabled": true}'
```

---

## Scenario D: Multiple Load Balancers

**Use Case:** Production setup with separate internal and external load balancers, or geographic routing.

### Files

**1. frontend-ingress-internal.yaml**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: frontend-ingress-internal
  namespace: platform
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/use-regex: "true"
    nginx.ingress.kubernetes.io/rewrite-target: "/$2"
    # Internal ingress annotation (varies by cloud provider)
    cloud.google.com/neg: '{"ingress": true}'
spec:
  ingressClassName: nginx-internal
  tls:
  - hosts:
    - panel-internal.k8s-platform.test
    secretName: frontend-tls-internal
  rules:
  - host: panel-internal.k8s-platform.test
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

**2. frontend-ingress-external.yaml**

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: frontend-ingress-external
  namespace: platform
  annotations:
    cert-manager.io/cluster-issuer: "letsencrypt-prod"
    nginx.ingress.kubernetes.io/use-regex: "true"
    nginx.ingress.kubernetes.io/rewrite-target: "/$2"
    # Rate limiting
    nginx.ingress.kubernetes.io/limit-rps: "100"
    nginx.ingress.kubernetes.io/limit-connections: "10"
spec:
  ingressClassName: nginx-external
  tls:
  - hosts:
    - panel.platform.com
    secretName: frontend-tls-external
  rules:
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
```

### Deployment

```bash
# Deploy both ingress rules
kubectl apply -f frontend-ingress-internal.yaml
kubectl apply -f frontend-ingress-external.yaml

# Verify
kubectl get ingress -n platform
kubectl describe ingress frontend-ingress-external -n platform
```

---

## Testing & Verification

### 1. Basic Connectivity

```bash
# Test domain access (admin)
curl -I https://panel.platform.com/admin/
# Expected: 200 OK (or 301 if redirected to login)

# Test domain access (client)
curl -I https://panel.platform.com/client/
# Expected: 200 OK (or 301 if redirected to login)

# Test root domain redirect
curl -I https://panel.platform.com/
# Expected: 301 Moved Permanently to https://external-website.com/

# Test IP access (if configured)
curl -I https://1.2.3.4/admin/
# Expected: 200 OK
```

### 2. Kubernetes Verification

```bash
# Check ingress status
kubectl get ingress -n platform
kubectl describe ingress frontend-ingress -n platform

# Check service endpoints
kubectl get svc -n platform
kubectl get endpoints frontend -n platform

# Check pods
kubectl get pods -n platform -o wide

# Check logs
kubectl logs -f deployment/frontend -n platform
kubectl logs -f -n ingress-nginx daemonset/ingress-nginx-controller
```

### 3. Certificate Verification

```bash
# Check certificate status
kubectl get certificates -n platform
kubectl describe cert frontend-cert-domain -n platform

# Check secret
kubectl get secret frontend-tls-domain -n platform
kubectl describe secret frontend-tls-domain -n platform

# Verify certificate
echo | openssl s_client -connect panel.platform.com:443 -servername panel.platform.com
```

### 4. NGINX Configuration Check

```bash
# Get NGINX pod name
NGINX_POD=$(kubectl get pods -n ingress-nginx -o name | grep nginx-ingress-controller | head -1)

# View NGINX configuration
kubectl exec -it $NGINX_POD -n ingress-nginx -- cat /etc/nginx/nginx.conf

# Test NGINX configuration
kubectl exec -it $NGINX_POD -n ingress-nginx -- nginx -t

# View specific server block (for your ingress)
kubectl exec -it $NGINX_POD -n ingress-nginx -- grep -A 20 "server_name panel.platform.com"
```

### 5. Performance Testing

```bash
# Load testing with Apache Bench
ab -n 1000 -c 10 https://panel.platform.com/admin/

# Or with wrk (more realistic)
wrk -t4 -c100 -d30s https://panel.platform.com/admin/

# Check response times
curl -w "Time: %{time_total}s\n" https://panel.platform.com/admin/
```

---

## Troubleshooting

### Issue 1: 404 Not Found on /admin/

**Symptoms:**
```
curl -I https://panel.platform.com/admin/
HTTP/1.1 404 Not Found
```

**Solutions:**

1. Check Ingress path regex:
```bash
kubectl get ingress frontend-ingress -n platform -o yaml | grep -A 5 "paths:"
```

2. Verify rewrite target:
```bash
# Should be: nginx.ingress.kubernetes.io/rewrite-target: "/$2"
kubectl get ingress frontend-ingress -n platform -o yaml | grep rewrite
```

3. Check NGINX logs:
```bash
NGINX_POD=$(kubectl get pods -n ingress-nginx -o name | grep controller | head -1)
kubectl logs $NGINX_POD -n ingress-nginx | grep "panel.platform.com"
```

### Issue 2: 301 Redirect Loop on Root

**Symptoms:**
```
curl -I https://panel.platform.com/
HTTP/1.1 301 Moved Permanently
Location: https://external-website.com/
# But external-website.com redirects back
```

**Solution:** Ensure external website is completely different and doesn't redirect back to panel domain.

### Issue 3: IP Access Returns TLS Certificate Error

**Symptoms:**
```
curl https://1.2.3.4/admin/
SSL: CERTIFICATE_VERIFY_FAILED
```

**Solutions:**

1. Option A: Use self-signed certificate for testing:
```bash
curl -k https://1.2.3.4/admin/  # -k ignores cert errors
```

2. Option B: Map IP to DNS name:
```bash
# /etc/hosts
1.2.3.4 panel.k8s-platform.test
curl https://panel.k8s-platform.test/admin/
```

3. Option C: Issue wildcard certificate for IP (not possible with Let's Encrypt):
   - Use self-signed or commercial wildcard cert

### Issue 4: CORS Errors in Browser Console

**Symptoms:**
```
Access to XMLHttpRequest at 'https://api.platform.com/v1/admin/' 
from origin 'https://panel.platform.com' has been blocked by CORS policy
```

**Solution:** Configure CORS in Management API:

```javascript
app.use(cors({
  origin: ['https://panel.platform.com', 'https://1.2.3.4'],
  credentials: true,
  methods: ['GET', 'POST', 'PATCH', 'DELETE'],
}));
```

### Issue 5: Ingress Not Updating After ConfigMap Change

**Symptoms:** Updated ConfigMap but NGINX still uses old config.

**Solution:** Force NGINX reload:

```bash
# Option 1: Restart NGINX controller pods (DaemonSet — restarts on all nodes)
kubectl rollout restart daemonset/ingress-nginx-controller -n ingress-nginx

# Option 2: Trigger automatic reload (if watching ConfigMaps)
kubectl annotate ingress frontend-ingress -n platform \
  kubectl.kubernetes.io/restartedAt="$(date)" --overwrite

# Option 3: Check NGINX controller logs
kubectl logs -f daemonset/ingress-nginx-controller -n ingress-nginx | grep "frontend-ingress"
```

---

## Related Documentation

- **FRONTEND_DEPLOYMENT_ARCHITECTURE.md** - High-level architecture
- **PLATFORM_ARCHITECTURE.md** - System-wide architecture
- **SECURITY_ARCHITECTURE.md** - TLS and security configuration
