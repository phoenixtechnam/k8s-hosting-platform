# NetBird Signal Server - Configuration Correction

## Issue Identified

During initial deployment, we incorrectly configured NetBird Signal server to use a separate domain (`netbird-signal.phoenix-host.net`) and route through Traefik on port 443.

## Why This Was Wrong

**NetBird Signal Server Architecture:**
- Signal is a WebRTC signaling server for peer-to-peer connection negotiation
- Clients connect **directly** to the signal server on port 10000 (TCP)
- Signal does **NOT** need to be behind an HTTPS reverse proxy
- Signal does **NOT** need its own domain or SSL certificate

**What signal actually does:**
- Coordinates peer-to-peer connection setup between NetBird clients
- Exchanges WebRTC Session Description Protocol (SDP) offers/answers
- Facilitates ICE candidate exchange for NAT traversal
- Works on port 10000, not port 443

## Correct Configuration

### management.json
```json
{
  "Signal": {
    "Proto": "http",
    "URI": "23.88.111.142:10000"  // Direct IP:port, not domain
  }
}
```

### docker-compose.yml
```yaml
signal:
  image: netbirdio/signal:0.28.0
  ports:
    - "10000:10000"  # Direct port exposure
  # NO Traefik labels needed
  # NO separate domain
  # NO SSL certificate
```

### management service environment
```yaml
environment:
  NETBIRD_SIGNAL_ENDPOINT: "23.88.111.142:10000"  # Not netbird-signal.domain:443
```

## What We Changed

**Removed:**
- ❌ `netbird-signal.phoenix-host.net` DNS record (unnecessary)
- ❌ `netbird-signal.phoenix-host.net` SSL certificate (wasted)
- ❌ Traefik labels on signal service
- ❌ Signal routing through Traefik reverse proxy

**Updated:**
- ✅ Signal endpoint to use direct IP:10000
- ✅ Signal protocol to "http" (not "https")
- ✅ Removed domain from signal configuration

## Certificates Actually Needed

For a complete NetBird deployment, you only need:

✅ **One certificate:** `netbird.phoenix-host.net`
- Used for Management API (HTTPS on port 443 via Traefik)
- Used for Dashboard UI (HTTPS on port 443 via Traefik)

❌ **Not needed:** `netbird-signal.phoenix-host.net`
- Signal uses port 10000 directly
- No HTTPS needed for signal traffic

## Updated Bootstrap Guide

When using the certificate bootstrap method, only request certificate for the main domain:

```yaml
whoami:
  labels:
    - "traefik.enable=true"
    - "traefik.http.routers.whoami.rule=Host(`netbird.phoenix-host.net`)"
    - "traefik.http.routers.whoami.entrypoints=websecure"
    - "traefik.http.routers.whoami.tls.certresolver=letsencrypt"
    # NO signal domain label needed
```

## Why This Matters

**Benefits of correct configuration:**
- ✅ One less certificate to manage (saves rate limits)
- ✅ Simpler configuration (fewer moving parts)
- ✅ Correct architecture (signal on dedicated port)
- ✅ Better performance (no unnecessary reverse proxy hop)

**Let's Encrypt rate limits:**
- 50 certificates per domain per week
- By removing unnecessary certificates, we preserve our rate limit budget

## Verification

**Check signal is accessible directly:**
```bash
# Signal should respond on port 10000
telnet 23.88.111.142 10000

# Should NOT be behind Traefik
curl https://netbird-signal.phoenix-host.net  # Should NOT work
```

**Check only one certificate needed:**
```bash
# Only netbird.phoenix-host.net should be in acme.json
cat /opt/netbird/acme.json | python3 -c 'import json, sys; data=json.load(sys.stdin); [print(cert["domain"]["main"]) for cert in data["letsencrypt"]["Certificates"]]'

# Expected output:
# netbird.phoenix-host.net
```

## For Future Deployments

**When deploying NetBird on additional servers (ns2, admin1):**
1. Only request certificate for `netbird.domain.com`
2. Signal endpoint: Use direct IP:10000
3. No Traefik configuration for signal service
4. Signal port 10000 must be open in firewall (TCP/UDP)

## Lesson Learned

**Always verify the actual architecture of services before assuming they need HTTPS/Traefik:**
- Not all services need SSL certificates
- Not all services should be behind reverse proxies
- Some services (like WebRTC signaling) work better with direct connections
- Read the upstream documentation carefully before adding abstractions

This is a common mistake when deploying modern applications - assuming everything needs to be behind HTTPS when some components are designed for direct, low-latency connections.
