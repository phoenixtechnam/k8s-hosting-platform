# DNS Provider Integration

## Architecture

The platform supports multiple external DNS servers via a **provider adapter pattern**. Each DNS server is configured in the admin panel with connection credentials, and domains are automatically provisioned across all active servers.

```
Platform API → DNS Provider Adapter → External DNS Server
                ├── MockProvider      (testing/staging)
                ├── PowerDnsProvider   (PowerDNS v4/v5 API)
                ├── RndcProvider       (BIND9 via rndc — planned)
                ├── CloudflareProvider (planned)
                └── Route53Provider   (planned)
```

## Provider Interface

```typescript
interface DnsProviderAdapter {
  testConnection(): Promise<{ status: 'ok' | 'error'; message?: string }>
  listZones(): Promise<DnsZone[]>
  getZone(name: string): Promise<DnsZone | null>
  createZone(name: string, kind: 'Native' | 'Master'): Promise<DnsZone>
  deleteZone(name: string): Promise<void>
  listRecords(zone: string): Promise<DnsRecord[]>
  createRecord(zone: string, record: DnsRecordInput): Promise<DnsRecord>
  updateRecord(zone: string, recordId: string, record: Partial<DnsRecordInput>): Promise<DnsRecord>
  deleteRecord(zone: string, recordId: string): Promise<void>
}
```

## Supported Providers

### PowerDNS (v4 / v5)

**Connection config:**
```json
{
  "api_url": "http://powerdns:8081",
  "api_key": "your-api-key",
  "server_id": "localhost",
  "api_version": "v4"
}
```

**Zone types:**
- `Native` — single-server setup (no replication, simplest)
- `Master` — primary server that replicates to secondaries

**API endpoints used:**
- `GET /api/v1/servers/{server_id}/zones` — list zones
- `POST /api/v1/servers/{server_id}/zones` — create zone
- `GET /api/v1/servers/{server_id}/zones/{zone_id}` — get zone with records
- `PATCH /api/v1/servers/{server_id}/zones/{zone_id}` — update records (RRSets)
- `DELETE /api/v1/servers/{server_id}/zones/{zone_id}` — delete zone

### Mock Provider (Testing)

In-memory DNS storage for staging/testing. No external dependencies.
Enabled by default in `NODE_ENV=test` and `NODE_ENV=development`.

### BIND9 via rndc (Planned)

Uses `rndc` commands over network to manage BIND9 zones and `nsupdate` for dynamic record updates.

## BIND9 rndc Setup Guide

### Prerequisites
- BIND9 installed and running on the DNS server
- Network connectivity from platform server to BIND9 server (TCP port 953)

### Step 1: Generate rndc Key

On the BIND9 server:
```bash
rndc-confgen -a -k platform-key -A hmac-sha256
cat /etc/bind/rndc.key
```

This outputs:
```
key "platform-key" {
    algorithm hmac-sha256;
    secret "BASE64-SECRET-HERE";
};
```

### Step 2: Configure BIND9 to Accept rndc

Edit `/etc/bind/named.conf.local`:
```
include "/etc/bind/rndc.key";

controls {
    inet 0.0.0.0 port 953 allow { PLATFORM_SERVER_IP; } keys { "platform-key"; };
};
```

### Step 3: Allow Dynamic Updates

For each zone that the platform should manage, add `allow-update`:
```
zone "example.com" {
    type master;
    file "/var/lib/bind/db.example.com";
    allow-update { key "platform-key"; };
};
```

### Step 4: Restart BIND9
```bash
systemctl restart named
```

### Step 5: Configure in Platform

In the admin panel → Settings → DNS Servers → Add Server:
- Provider: BIND9 (rndc)
- Server Host: `dns-server.example.com`
- rndc Key Name: `platform-key`
- rndc Key Algorithm: `hmac-sha256`
- rndc Key Secret: (the base64 secret from Step 1)

## Domain → DNS Server Flow

1. **Admin configures DNS servers** in Settings → DNS Servers
2. **Admin creates a domain** → platform provisions the zone on **all active admin-defined DNS servers**
3. If the zone already exists on a server, it's reused (no duplicate creation)
4. **DNS records** created via the domain detail page are synced to all linked DNS servers
5. **Future:** Client-defined DNS servers (user panel, Phase 2)

## Database Schema

```sql
dns_servers:
  id, display_name, provider_type, connection_config_encrypted,
  zone_default_kind ('Native'|'Master'), is_default, enabled,
  last_health_check, last_health_status, created_at, updated_at
```
