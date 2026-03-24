# Secrets Management & Rotation Policy

**Status:** Pre-Phase 1 Planning  
**Last Updated:** March 3, 2026  
**Owner:** Security & DevOps Team

## Overview

Secure secrets management protects:
- **Database credentials** (MariaDB, PostgreSQL passwords)
- **API tokens** (GitHub, Stripe, external services)
- **Cryptographic keys** (encryption, signing, TLS certificates)
- **OIDC provider secrets** (Dex client secrets, etc.)
- **SSH keys** (cluster access — via NetBird mesh only)
- **NetBird credentials** (setup keys, management API tokens, OIDC client secret)
- **PowerDNS API keys** (zone management API authentication on ns1/ns2)

---

## Secrets Taxonomy

### Critical (Rotate Weekly)

```
- Kubernetes cluster admin token
- Database root passwords (MariaDB, PostgreSQL)
- OIDC provider client secrets (Dex, Google, GitHub)
- TLS private keys (certificates)
- API signing keys
- JWT secret keys
```

### High Priority (Rotate Monthly)

```
- Database service account passwords
- Email SMTP credentials
- Redis authentication tokens
- External API keys (Stripe, Chargebee, DNS provider)
- SSH keys for cluster access (admin access via NetBird mesh only)
- NetBird setup keys (pre-authenticated break-glass tokens)
- NetBird OIDC client secret (Dex integration)
- PowerDNS API keys (ns1 primary, ns2 secondary)
```

### Medium Priority (Rotate Quarterly)

```
- Application-level API tokens
- Third-party service credentials
- Webhook signing secrets
- Encryption keys for non-critical data
```

### Low Priority (Rotate Annually)

```
- Public/internal CA certificates
- Development API tokens
- Testing credentials
```

---

## Secrets Storage: Sealed Secrets (K3s Native)

### Why Sealed Secrets

- ✅ Built-in to Kubernetes
- ✅ Encrypts secrets at rest
- ✅ Tied to cluster identity
- ✅ Simple rotation policy
- ✅ GitOps-friendly (secrets in Git, encrypted)

### Sealed Secrets Setup

```yaml
# Install Sealed Secrets controller
kubectl apply -f https://github.com/bitnami-labs/sealed-secrets/releases/download/v0.18.0/controller.yaml

# Verify installation
kubectl get pods -n kube-system | grep sealed-secrets

# Extract public key (for CI/CD)
kubeseal -f /dev/null -w sealing-key.crt --fetch-cert
```

### Example: Sealed Database Secret

```yaml
# Unsealed secret (never commit to Git)
apiVersion: v1
kind: Secret
metadata:
  name: db-credentials
  namespace: client-123
type: Opaque
data:
  username: <base64-encoded-username>   # e.g., echo -n "db_user" | base64
  password: <base64-encoded-password>   # e.g., echo -n "$(openssl rand -base64 32)" | base64

# Seal the secret
kubeseal -f secret.yaml -w sealed-secret.yaml

# Result: sealed-secret.yaml (safe to commit)
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: db-credentials
  namespace: client-123
spec:
  encryptedData:
    password: AgB9e2x4Ny9P...
    username: AgCfh3x7Q2...
```

### In Flux Pipeline

```yaml
# flux/clusters/production/client-123/kustomization.yaml
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization
resources:
  - sealed-database-secret.yaml
  - sealed-api-tokens.yaml
  - deployment.yaml
```

---

## Rotation Strategy

### Weekly Rotation (Critical Secrets)

```bash
#!/bin/bash
# rotate-critical-secrets.sh - Run every Sunday 2 AM

# 1. Rotate Kubernetes admin token
kubectl create serviceaccount new-admin -n kube-system
kubectl create clusterrolebinding new-admin-binding \
  --clusterrole=cluster-admin --serviceaccount=kube-system:new-admin
NEW_TOKEN=$(kubectl get secret -n kube-system \
  $(kubectl get secret -n kube-system | grep new-admin | awk '{print $1}') \
  -o jsonpath='{.data.token}' | base64 --decode)

# 2. Update sealed secret with new token
OLD_TOKEN=$(kubeseal -d sealed-admin-token.yaml | jq -r .data.token)
kubectl patch secret admin-token -p \
  '{"data":{"token":"'$(echo -n $NEW_TOKEN | base64 -w0)'"}}'

# 3. Delete old service account
kubectl delete serviceaccount old-admin -n kube-system

# 4. Log rotation
echo "$(date): Rotated admin token" >> /var/log/secrets-rotation.log
```

### Monthly Rotation (High Priority)

```bash
# rotate-high-priority-secrets.sh - Run 1st of month

# MariaDB service account password
mariadb -u root -p$MARIADB_ROOT_PASSWORD -e \
  "ALTER USER 'app_user'@'%' IDENTIFIED BY '$(openssl rand -base64 32)';"

# Update sealed secrets with new credentials
# Restart affected deployments to pick up new secrets
kubectl rollout restart deployment/app-service -n production
```

### Quarterly Rotation (Medium Priority)

```bash
# rotate-medium-priority-secrets.sh - Run quarterly (Jan, Apr, Jul, Oct)

# Rotate external API keys
# 1. Create new API key in Stripe/Chargebee
# 2. Update sealed secret with new key
# 3. Deploy and test
# 4. Revoke old key after validation
```

### Certificate Rotation (Automated)

```yaml
# cert-manager handles TLS certificate rotation automatically
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: platform-tls
  namespace: platform
spec:
  secretName: platform-tls-secret
  duration: 2160h  # 90 days
  renewBefore: 720h  # 30 days before expiry
  commonName: platform.example.com
  issuerRef:
    name: letsencrypt-prod
    kind: ClusterIssuer
```

**ACME Provider Configuration:**

Three ClusterIssuers are deployed. See `TLS_CERTIFICATE_MANAGEMENT.md` for the full certificate strategy (wildcard vs. single-domain, DNS-01 vs. HTTP-01, subdomain assignment, custom cert CSR workflow).

```yaml
# ── 1. Wildcard issuer (DNS-01 only) ──────────────────────────────────────────
# Used for: authoritative domains (Primary + Secondary DNS mode)
# Issues:   *.domain.com + domain.com wildcard certificates
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-wildcard
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@platform.com
    privateKeySecretRef:
      name: letsencrypt-wildcard-key
    solvers:
    - dns01:
        webhook:
          groupName: acme.platform.com
          solverName: powerdns
          config:
            apiUrl: http://ns1.platform.com:8081
            apiKeySecretRef:
              name: powerdns-api-key
              key: api-key

---
# ── 2. Single-domain issuer (HTTP-01 primary, DNS-01 fallback) ─────────────────
# Used for: CNAME-mode domains, non-authoritative hostnames
# Issues:   single-domain certificates per hostname
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@platform.com
    privateKeySecretRef:
      name: letsencrypt-prod-key
    solvers:
    - http01:
        ingress:
          class: nginx
    - dns01:
        webhook:
          groupName: acme.platform.com
          solverName: powerdns
          config:
            apiUrl: http://ns1.platform.com:8081
            apiKeySecretRef:
              name: powerdns-api-key
              key: api-key

---
# ── 3. Fallback: ZeroSSL (free ACME-compatible CA) ────────────────────────────
# Used when Let's Encrypt is unavailable or rate-limited
# HTTP-01 only (ZeroSSL DNS-01 requires separate webhook config if needed)
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: zerossl-prod
spec:
  acme:
    server: https://acme.zerossl.com/v2/DV90
    email: admin@platform.com
    externalAccountBinding:
      keyID: <zerossl-eab-kid>
      keySecretRef:
        name: zerossl-eab-hmac
        key: secret
    privateKeySecretRef:
      name: zerossl-prod-key
    solvers:
    - http01:
        ingress:
          class: nginx
```

**Failover procedure:** If Let's Encrypt is unavailable, update Certificate resources to reference `zerossl-prod` issuer. Can be automated via a monitoring alert + script that patches Certificate resources when Let's Encrypt health check fails. Note: ZeroSSL does not support wildcard certificates via DNS-01 in the default configuration — wildcard certs will remain on Let's Encrypt until restored.

---

## Secrets in CI/CD (GitHub Actions)

### GitHub Secrets Storage

Store secrets as encrypted environment variables:

```yaml
# .github/workflows/deploy.yml
name: Deploy

on: [push]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3

      # Use GitHub secrets (encrypted)
      - name: Deploy to Kubernetes
        env:
          KUBECONFIG: ${{ secrets.KUBECONFIG }}
          DB_PASSWORD: ${{ secrets.DB_PASSWORD }}
          STRIPE_API_KEY: ${{ secrets.STRIPE_API_KEY }}
        run: |
          kubectl apply -f manifests/
```

### GitHub Secrets Management

```bash
# Create/update secret in GitHub
gh secret set DB_PASSWORD --body "new-password"

# List secrets
gh secret list

# Delete secret
gh secret delete OLD_KEY
```

### Rotate GitHub Secrets

```bash
#!/bin/bash
# Rotate all GitHub secrets monthly

SECRETS=("DB_PASSWORD" "API_TOKEN" "ENCRYPTION_KEY")

for secret in "${SECRETS[@]}"; do
  NEW_VALUE=$(openssl rand -base64 32)
  gh secret set $secret --body "$NEW_VALUE"
  echo "Rotated $secret"
done
```

---

## Application-Level Secrets

### Environment Variables (12-Factor App)

```typescript
// config/secrets.ts

interface SecretsConfig {
  database: {
    host: string;
    port: number;
    username: string;
    password: string;
  };
  jwt: {
    secret: string;
    expiresIn: string;
  };
  oidc: {
    clientId: string;
    clientSecret: string;
    discoveryUrl: string;
  };
  stripe: {
    apiKey: string;
    webhookSecret: string;
  };
}

export const getSecretsConfig = (): SecretsConfig => {
  // Load from K8s secret mounted as environment variables
  return {
    database: {
      host: process.env.DB_HOST!,
      port: parseInt(process.env.DB_PORT || '3306'),
      username: process.env.DB_USER!,
      password: process.env.DB_PASSWORD!  // From Sealed Secret
    },
    jwt: {
      secret: process.env.JWT_SECRET!,
      expiresIn: process.env.JWT_EXPIRES || '24h'
    },
    oidc: {
      clientId: process.env.OIDC_CLIENT_ID!,
      clientSecret: process.env.OIDC_CLIENT_SECRET!,  // From Sealed Secret
      discoveryUrl: process.env.OIDC_DISCOVERY_URL!
    },
    stripe: {
      apiKey: process.env.STRIPE_API_KEY!,
      webhookSecret: process.env.STRIPE_WEBHOOK_SECRET!
    }
  };
};

// Usage in application
const config = getSecretsConfig();
const db = new Database(config.database);
const jwt = new JwtService(config.jwt.secret);
```

### Mount Secrets in Pod

```yaml
# deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: app-service
spec:
  template:
    spec:
      containers:
      - name: app
        image: app:latest
        env:
          # Reference sealed secret
          - name: DB_PASSWORD
            valueFrom:
              secretKeyRef:
                name: db-credentials
                key: password
          - name: OIDC_CLIENT_SECRET
            valueFrom:
              secretKeyRef:
                name: oidc-secrets
                key: clientSecret
          - name: STRIPE_API_KEY
            valueFrom:
              secretKeyRef:
                name: external-api-keys
                key: stripe
```

---

## Secrets Best Practices

### DO ✅

- ✅ Store in Sealed Secrets (K8s native)
- ✅ Encrypt at rest (AES-256)
- ✅ Use strong random values (>= 256 bits)
- ✅ Rotate on schedule
- ✅ Audit all secret access
- ✅ Use separate secrets per environment
- ✅ Limit secret scope (app needs minimal access)
- ✅ Use service accounts for app identity
- ✅ Implement secret versioning
- ✅ Test rotation before deploying

### DON'T ❌

- ❌ Don't commit secrets to Git (even encrypted in application code)
- ❌ Don't use weak passwords (>= 16 characters)
- ❌ Don't share secrets via email/Slack
- ❌ Don't log secrets in application output
- ❌ Don't store multiple secrets in same file
- ❌ Don't disable secret rotation
- ❌ Don't give applications admin-level access
- ❌ Don't hardcode secrets in container image
- ❌ Don't use same secret across environments

---

## Secret Versioning & Rollback

### Versioned Sealed Secrets

```yaml
# secrets/db-credentials-v1.yaml
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: db-credentials-v1
spec:
  encryptedData:
    password: AgBxyz...

# secrets/db-credentials-v2.yaml (new version)
apiVersion: bitnami.com/v1alpha1
kind: SealedSecret
metadata:
  name: db-credentials-v2
spec:
  encryptedData:
    password: AgByza...

# Deployment uses versioned secret
env:
  - name: DB_PASSWORD
    valueFrom:
      secretKeyRef:
        name: db-credentials-v2  # Current version
        key: password
```

### Rollback if Rotation Fails

```bash
# If new secret causes issues, rollback to previous version
kubectl patch deployment app-service -p \
  '{"spec":{"template":{"spec":{"containers":[{"name":"app","env":[{"name":"DB_PASSWORD","valueFrom":{"secretKeyRef":{"name":"db-credentials-v1"}}}]}]}}}}'
```

---

## Secrets Audit Trail

### Log All Secret Access

```typescript
// middleware/secrets-audit.ts

export const auditSecretAccess = async (secretName: string, actor: string) => {
  await logEvent({
    event_type: 'SECURITY_SECRET_ACCESSED',
    severity: 'INFO',
    actor: { id: actor },
    resource: { type: 'secret', id: secretName },
    timestamp: new Date()
  });
};

// Intercept secret retrieval
kubeseal.onSecretAccess = (secretName, actor) => {
  auditSecretAccess(secretName, actor);
};
```

### Alert on Suspicious Secret Access

```bash
# Alert if secret accessed outside rotation window
if [[ $(date +%H:%M) != "02:00" ]] && [[ $SECRET == "admin-token" ]]; then
  echo "ALERT: Unexpected admin-token access at $(date)" | mail -s "Security Alert" security@example.com
fi
```

---

## Emergency Secret Rotation

### Incident Response: Leaked Secret

```bash
#!/bin/bash
# emergency-rotate-secret.sh <secret-name>

SECRET_NAME=$1
TIMESTAMP=$(date +%Y%m%d-%H%M%S)

echo "EMERGENCY: Rotating secret $SECRET_NAME at $TIMESTAMP"

# 1. Generate new value
NEW_VALUE=$(openssl rand -base64 32)

# 2. Update sealed secret immediately
kubectl patch secret $SECRET_NAME -p \
  '{"data":{"value":"'$(echo -n $NEW_VALUE | base64 -w0)'"}}'

# 3. Force all pods to restart (pick up new secret)
kubectl rollout restart deployment/app-service -n production

# 4. Wait for rollout to complete
kubectl rollout status deployment/app-service -n production

# 5. Revoke old secret (external services)
# Manual step: revoke in Stripe, GitHub, DNS provider, etc.

# 6. Log incident
echo "$TIMESTAMP: EMERGENCY rotation of $SECRET_NAME" >> /var/log/security-incidents.log

# 7. Notify team
echo "Secret $SECRET_NAME rotated. Old secret requires manual revocation." \
  | mail -s "EMERGENCY: Secret Rotated" security@example.com
```

---

## Secrets Scanning (Pre-commit)

### Pre-commit Hook

```yaml
# .pre-commit-config.yaml
repos:
  - repo: https://github.com/Yelp/detect-secrets
    rev: v1.4.0
    hooks:
      - id: detect-secrets
        args: ['--allow-verified-usage']
        exclude: ^docs/

# Setup
pre-commit install
pre-commit run --all-files
```

### GitHub Actions Secret Scanning

```yaml
# Enable built-in secret scanning
name: Secrets Detection
on: [push, pull_request]
jobs:
  secrets:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: trufflesecurity/trufflehog@main
        with:
          path: ./
          base: ${{ github.event.repository.default_branch }}
```

---

## Secrets Backup & Recovery

### Sealed Secrets Sealing Key Backup

```bash
# Backup sealing key (CRITICAL)
kubectl get secret -n kube-system \
  -l sealedsecrets.bitnami.com/status=active \
  -o yaml > sealed-secrets-backup.yaml

# Encrypt backup
gpg --symmetric sealed-secrets-backup.yaml

# Store in secure location (offline or vault)
# Required for disaster recovery
```

### Restore Sealed Secrets After Cluster Rebuild

```bash
# 1. Install Sealed Secrets
kubectl apply -f https://github.com/bitnami-labs/sealed-secrets/releases/download/v0.18.0/controller.yaml

# 2. Restore sealing key from backup
kubectl apply -f <(gpg --decrypt sealed-secrets-backup.yaml.gpg)

# 3. Verify key loaded
kubectl get secret -n kube-system | grep sealed-secrets-key

# 4. Reapply sealed secrets (they will decrypt with restored key)
kubectl apply -f sealed-secrets/
```

---

## Testing

```typescript
describe('Secrets Management', () => {
  it('should load secrets from environment', () => {
    const config = getSecretsConfig();
    expect(config.database.password).toBeDefined();
    expect(config.jwt.secret).toBeDefined();
  });

  it('should not log sensitive values', () => {
    const config = getSecretsConfig();
    const logOutput = JSON.stringify(config);
    expect(logOutput).not.toContain(config.database.password);
  });

  it('should rotate secrets without downtime', async () => {
    // 1. Deploy with v1 secret
    await deploy('sealed-secret-v1.yaml');
    
    // 2. Create v2 secret
    await createNewSecret('v2');
    
    // 3. Update deployment to use v2
    await updateDeployment('sealed-secret-v2.yaml');
    
    // 4. Verify no connection errors during transition
    const errors = await monitorErrorLogs(1000 * 60);  // 1 minute
    expect(errors.connectionErrors).toBe(0);
  });

  it('should audit secret access', async () => {
    const secretName = 'db-credentials';
    const actor = 'deployment-controller';
    
    await auditSecretAccess(secretName, actor);
    
    const auditLog = await getAuditLog(secretName);
    expect(auditLog).toContainObject({
      event_type: 'SECURITY_SECRET_ACCESSED',
      resource: { id: secretName },
      actor: { id: actor }
    });
  });
});
```

---

## Checklist

- [ ] Set up Sealed Secrets in K3s cluster
- [ ] Extract and backup sealing key
- [ ] Create rotation schedule (weekly critical, monthly high-priority)
- [ ] Implement rotation scripts
- [ ] Audit all secret access
- [ ] Set up secret scanning in CI/CD
- [ ] Document emergency rotation procedure
- [ ] Train team on secrets management
- [ ] Test rotation with prod-like data
- [ ] Test disaster recovery (sealing key backup/restore)

---

## References

- Sealed Secrets GitHub: https://github.com/bitnami-labs/sealed-secrets
- Kubernetes Secrets: https://kubernetes.io/docs/concepts/configuration/secret/
- OWASP Secrets Management: https://owasp.org/www-project-secrets-management/
- cert-manager: https://cert-manager.io/
