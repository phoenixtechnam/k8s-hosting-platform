# NetBird Certificate Bootstrap Guide

## Problem

NetBird Management has a circular dependency when using self-hosted authentication:
- Management server requires valid SSL certificates to start
- Management server needs to fetch JWKS from `https://netbird.domain/.well-known/jwks.json`
- But that endpoint is served by the Management server itself
- Result: Can't start until it validates JWKS, but JWKS isn't available until it starts

## Solution: Pre-Generate Certificates with Temporary Container

**Before deploying NetBird**, obtain valid Let's Encrypt certificates using Traefik with a temporary "hello world" container. Once certificates are in `acme.json`, Traefik will reuse them for the actual NetBird services.

### Step 1: Deploy Temporary Container

Add a temporary service to your NetBird `docker-compose.yml`:

```yaml
services:
  # ... other services ...

  # Temporary whoami service to trigger certificate generation
  whoami:
    image: traefik/whoami:latest
    container_name: netbird-whoami
    restart: unless-stopped
    networks:
      - netbird
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.whoami.rule=Host(`netbird.phoenix-host.net`)"
      - "traefik.http.routers.whoami.entrypoints=websecure"
      - "traefik.http.routers.whoami.tls.certresolver=letsencrypt"
      - "traefik.http.services.whoami.loadbalancer.server.port=80"
```

### Step 2: Ensure Traefik Can Access PowerDNS API

Traefik needs network access to PowerDNS for DNS-01 ACME challenges:

```yaml
services:
  traefik:
    # ... other config ...
    environment:
      PDNS_API_URL: "http://powerdns-nginx:8081"
      PDNS_API_KEY: "{{ powerdns_api_key }}"
    networks:
      - netbird
      - powerdns_external  # Connect to PowerDNS network

networks:
  netbird:
    driver: bridge
  powerdns_external:
    external: true
    name: powerdns_powerdns_external
```

### Step 3: Start Traefik and Whoami

```bash
cd /opt/netbird
rm -f acme.json  # Start fresh
touch acme.json
chmod 600 acme.json
docker compose up -d traefik whoami
```

### Step 4: Wait for Certificate Generation

DNS-01 challenge takes 30-60 seconds:

```bash
# Wait for certificates
sleep 60

# Check certificate generation
docker logs netbird-traefik 2>&1 | grep -i certificate

# Verify certificates exist in acme.json
cat acme.json | python3 -c 'import json, sys; data=json.load(sys.stdin); [print(f"✓ {cert[\"domain\"][\"main\"]}") for cert in data["letsencrypt"]["Certificates"]]'
```

Expected output:
```
✓ netbird.phoenix-host.net
```

### Step 5: Extract Certificates (Optional)

If NetBird needs certificate files directly:

```bash
cd /opt/netbird
mkdir -p certs

cat acme.json | python3 << 'PYTHON'
import json, sys, base64
data = json.load(sys.stdin)
for cert_data in data["letsencrypt"]["Certificates"]:
    domain = cert_data["domain"]["main"]
    cert = base64.b64decode(cert_data["certificate"]).decode()
    key = base64.b64decode(cert_data["key"]).decode()
    with open(f"certs/{domain}.crt", "w") as f:
        f.write(cert)
    with open(f"certs/{domain}.key", "w") as f:
        f.write(key)
    print(f"Extracted: {domain}")
PYTHON

chmod 600 certs/*.key
```

### Step 6: Verify HTTPS Works

Test that Traefik is serving with valid certificates:

```bash
curl -I https://netbird.phoenix-host.net
# Should return HTTP/2 200 or 502 (backend not ready yet)

# Check certificate details
echo | openssl s_client -connect netbird.phoenix-host.net:443 -servername netbird.phoenix-host.net 2>/dev/null | openssl x509 -noout -subject -dates
```

### Step 7: Remove Whoami, Deploy NetBird

Once certificates are obtained:

```bash
# Stop and remove whoami
docker compose down whoami

# Remove whoami from docker-compose.yml
# (or comment it out for future use)

# Start NetBird Management
docker compose up -d management
```

**Traefik will automatically reuse the existing certificates** from `acme.json` for the NetBird Management service. No new ACME challenge is needed.

## Why This Works

1. **Traefik stores certificates in `acme.json`** - Once obtained, certificates are reused for any service requesting the same domain
2. **DNS-01 challenge doesn't require running backend** - Only PowerDNS API access is needed
3. **Certificates are valid for 90 days** - Traefik handles automatic renewal
4. **Certificate reuse is instant** - No waiting when reconfiguring services

## Verification Checklist

Before removing whoami and deploying NetBird:

- [ ] `acme.json` exists and is not empty
- [ ] Certificates for the domain are in `acme.json`
- [ ] HTTPS access works: `curl -I https://netbird.phoenix-host.net` returns valid response
- [ ] Certificate is from Let's Encrypt (not self-signed)
- [ ] Certificate valid for 90 days
- [ ] PowerDNS API accessible from Traefik container

## Troubleshooting

### Certificate not generating

**Check PowerDNS API access:**
```bash
docker exec netbird-traefik wget -O- --timeout=5 http://powerdns-nginx:8081/api/v1/servers/localhost
```

Should return JSON, not timeout or 401.

**Check Traefik logs:**
```bash
docker logs netbird-traefik 2>&1 | grep -iE 'certificate|acme|error'
```

Common issues:
- `context deadline exceeded` - Traefik can't reach PowerDNS API (check network connectivity)
- `401 Unauthorized` - PowerDNS API key missing or wrong
- `rate limited` - Too many failed attempts, wait 1 hour

### Whoami returns 404

Check Traefik dashboard to see if service is registered:
```bash
docker logs netbird-traefik 2>&1 | grep whoami
```

Ensure labels are correct and container is on the right network.

## Ansible Integration

For automated deployment, add this as a pre-task before NetBird deployment:

```yaml
- name: Generate certificates with temporary whoami container
  block:
    - name: Deploy whoami for certificate generation
      docker_compose:
        project_src: /opt/netbird
        services:
          - traefik
          - whoami
        state: present

    - name: Wait for certificate generation
      wait_for:
        timeout: 90
      
    - name: Verify certificates exist
      command: >
        python3 -c "import json; data=json.load(open('/opt/netbird/acme.json'));
        exit(0 if len(data['letsencrypt']['Certificates']) >= 2 else 1)"
      register: cert_check
      failed_when: cert_check.rc != 0

    - name: Stop whoami
      docker_compose:
        project_src: /opt/netbird
        services:
          - whoami
        state: absent
```

## Certificate Renewal

Traefik automatically renews certificates 30 days before expiry. The whoami container is NOT needed for renewal - Traefik will use DNS-01 challenge directly.

**Manual renewal test:**
```bash
# Delete certificate from acme.json
# Traefik will automatically request a new one
docker compose restart traefik
```

## Security Notes

- `acme.json` contains private keys - keep permissions at 600
- Certificates are domain-validated only (DV)
- Let's Encrypt rate limits: 50 certificates per domain per week
- Failed authorization limit: 5 failures per hour per hostname
