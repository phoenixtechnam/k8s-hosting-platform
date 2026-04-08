# Mail Server Operations Runbook

**Phase:** 1 (MVP) — Stalwart Mail Server on k3s
**Audience:** DevOps / platform operators
**Companion doc:** [MAIL_SERVER_IMPLEMENTATION_STATUS.md](../06-features/MAIL_SERVER_IMPLEMENTATION_STATUS.md)

> This runbook covers day-0 bring-up, day-1 operations, and known migration procedures for the Stalwart mail stack. It is intentionally terse — each section is a cookbook you copy from, not a tutorial.

---

## 1. Component Summary

| Component | Version | Namespace | Workload |
|---|---|---|---|
| Stalwart Mail Server | `stalwartlabs/stalwart:v0.15.5` | `mail` | `StatefulSet/stalwart-mail` |
| Data store (metadata, FTS, lookup, sessions) | RocksDB | `mail` | `PVC data-stalwart-mail-0` |
| Blob store (message bodies) | filesystem (`type = "fs"`, depth 2) | `mail` | same PVC |
| Account directory | `internal` (Phase 1) → `sql` (Phase 2+) | `mail` | same RocksDB |
| Management HTTP + Prometheus | `:8080` internal | `mail` | `Service/stalwart-mail-mgmt` (ClusterIP) |
| Public mail listeners | 25/465/587/143/993/110/995/4190 | `mail` | `Service/stalwart-mail` (LoadBalancer in prod, NodePort in dev) |

All manifests live in `k8s/base/stalwart/`. Dev overlay at `k8s/overlays/dev/stalwart/`.

---

## 2. Hetzner Prerequisites (production)

These are **one-time account-level** actions that must be completed before a production mail deployment works end-to-end.

### 2.1 Request outbound port 25 unblock

- New Hetzner Cloud accounts have ports **25 and 465 blocked outbound** by default.
- Eligibility: account **≥ 1 month old** AND **first invoice paid**.
- File at: **Console → your Project → Limits → Request**. Describe the use case, expected volume, per-domain rate limits, and your abuse contact.
- Scope: **per-account / per-project**, applies to all current and future servers.
- Turnaround: hours → several business days, case-by-case.
- **Fallback if denied:** configure a commercial SMTP relay (Mailgun/Postmark/SES) in `smtp_relay_configs` and flip `storage.outbound` to always route through it. Phase 3 wires this into Stalwart's `[queue.outbound]`.
- Status tracking: note the request date in this runbook (or a Linear/Jira ticket) so you can escalate if it stalls.

### 2.2 Set reverse DNS (PTR) records

Mandatory for deliverability. Every IP that sends mail needs a PTR that forward-resolves back to the same IP (**FCrDNS**).

```hcl
# Terraform — hetznercloud/hcloud provider
resource "hcloud_rdns" "mail_v4" {
  server_id  = hcloud_server.mail.id
  ip_address = hcloud_server.mail.ipv4_address
  dns_ptr    = "mail.phoenix-host.net"
}

resource "hcloud_rdns" "mail_v6" {
  server_id  = hcloud_server.mail.id
  ip_address = hcloud_server.mail.ipv6_address
  dns_ptr    = "mail.phoenix-host.net"
}
```

Or via CLI:

```bash
hcloud server set-rdns <server-id> --ip <ipv4> --hostname mail.phoenix-host.net
hcloud server set-rdns <server-id> --ip <ipv6> --hostname mail.phoenix-host.net
```

**Never leave the default `*.your-server.de` rDNS on a mail-sending IP** — it is blocklisted by many filters.

### 2.3 Hetzner Cloud Firewall for mail ports

```hcl
resource "hcloud_firewall" "mail" {
  name = "mail-edge"
  rule { direction = "in"; protocol = "tcp"; port = "25";   source_ips = ["0.0.0.0/0", "::/0"]; description = "SMTP" }
  rule { direction = "in"; protocol = "tcp"; port = "465";  source_ips = ["0.0.0.0/0", "::/0"]; description = "SMTPS" }
  rule { direction = "in"; protocol = "tcp"; port = "587";  source_ips = ["0.0.0.0/0", "::/0"]; description = "Submission" }
  rule { direction = "in"; protocol = "tcp"; port = "143";  source_ips = ["0.0.0.0/0", "::/0"]; description = "IMAP" }
  rule { direction = "in"; protocol = "tcp"; port = "993";  source_ips = ["0.0.0.0/0", "::/0"]; description = "IMAPS" }
  rule { direction = "in"; protocol = "tcp"; port = "110";  source_ips = ["0.0.0.0/0", "::/0"]; description = "POP3" }
  rule { direction = "in"; protocol = "tcp"; port = "995";  source_ips = ["0.0.0.0/0", "::/0"]; description = "POP3S" }
  rule { direction = "in"; protocol = "tcp"; port = "4190"; source_ips = ["0.0.0.0/0", "::/0"]; description = "ManageSieve (optional)" }
  rule { direction = "in"; protocol = "icmp"; source_ips = ["0.0.0.0/0", "::/0"]; description = "ICMP (no port field!)" }
}
```

⚠️ **Do NOT set `port` on ICMP rules** — terraform-provider-hcloud issue #415 causes recreate-on-every-apply.

### 2.4 Spamhaus DNSBL workaround (since 2025-02-19)

Spamhaus public DNSBL mirrors return an error for queries originating from Hetzner IP space. If Stalwart queries Spamhaus at runtime for spam scoring, those lookups fail silently. Two options:

1. **Migrate to Spamhaus DQS** (Data Query Service) — register a free key and configure Stalwart's DNSBL section to use `<key>.dqs.spamhaus.net` instead of the public mirrors.
2. **Skip Spamhaus entirely** — rely on Stalwart's built-in Bayesian classifier + DKIM/SPF/DMARC verification, and document the trade-off.

This is a Phase 3 concern; Phase 1 doesn't run Spamhaus lookups.

---

## 3. Day-0: First Deploy

### 3.1 Local dev (DinD k3s)

**Prerequisites:** `./scripts/local.sh up` with the local stack healthy, including the `k3s-server` container.

The local overlay uses:
- `local-path` StorageClass
- NodePort service (30025..30995)
- `internal` directory (no platform Postgres needed)
- Plaintext dev secrets (bcrypt hashes baked into `k8s/overlays/dev/stalwart/secret.yaml`)
- Hostname `mail.dind.local`

```bash
# Deploy
./scripts/local.sh mail-up

# Verify
./scripts/local.sh mail-status

# Tail logs
./scripts/local.sh mail-logs

# Smoke test
bash scripts/smoke-test.sh                 # TCP + banner probes
MAIL_E2E=1 bash scripts/smoke-test.sh      # includes end-to-end send+receive
```

**Host port mappings** (via `docker-compose.local.yml` on the `k3s-server` container):

| Protocol | Host port | NodePort | Container port |
|---|---|---|---|
| SMTP | 2025 | 30025 | 25 |
| SMTPS | 2465 | 30465 | 465 |
| Submission | 2587 | 30587 | 587 |
| IMAP | 2143 | 30143 | 143 |
| IMAPS | 2993 | 30993 | 993 |
| POP3 | 2110 | 30110 | 110 |
| POP3S | 2995 | 30995 | 995 |

> On most DinD/remote-docker setups, the host port mappings are only reachable from the Docker host itself, not from sibling containers. The smoke test defaults to in-container NodePort probes (`MAIL_PROBE_MODE=k3s`) to be deterministic. To probe via the published host ports, set `MAIL_PROBE_MODE=host`.

**Dev credentials (never use in production):**
- `admin` / `stalwart-dev-admin` — WebAdmin UI + admin API
- `master` / `stalwart-dev-master` — Roundcube SSO master (Phase 2)

### 3.1b Bootstrapping the `stalwart_reader` PostgreSQL role (Phase 2a)

The Drizzle migration `0004_stalwart_directory.sql` creates the `stalwart_reader` role with `NOLOGIN` and **no password**. A committed password in a SQL migration would reach production environments via the standard migration runner, so the login step is deliberately separated.

**Local dev:** `scripts/local.sh mail-up` calls `_bootstrap_stalwart_reader` automatically, which sets the LOGIN + dev password (`stalwart-dev-reader-pw`) that matches `k8s/overlays/dev/stalwart/secret.yaml`.

**Production:** run once, after migrations:

```bash
# 1) Pick a strong password and store it in your secret manager
PG_STALWART_PW="$(openssl rand -base64 32)"

# 2) Set the password in Postgres
kubectl exec -n platform statefulset/platform-postgres -- \
  psql -U platform -d hosting_platform -c \
  "ALTER ROLE stalwart_reader WITH LOGIN PASSWORD '$PG_STALWART_PW';"

# 3) Store the same value in the Stalwart secret
kubectl patch secret stalwart-secrets -n mail \
  --type=merge \
  -p="{\"stringData\":{\"STALWART_DB_PASSWORD\":\"$PG_STALWART_PW\"}}"

# 4) Roll the Stalwart StatefulSet so it re-reads the secret
kubectl rollout restart statefulset/stalwart-mail -n mail
```

Rotate the password by repeating steps 1–4.

### 3.2 Production (Hetzner k3s)

1. Complete §2 (Hetzner prerequisites) first
2. Generate real secrets:
   ```bash
   # Generate Argon2id password hashes from any strong random passphrase
   docker run --rm --entrypoint /bin/sh stalwartlabs/stalwart:v0.15.5 -c '
     # Stalwart does not ship a hash command — use a Python one-liner or
     # any argon2 CLI tool. Example with htpasswd-argon2:
     echo "<paste-generated-hash-here>"
   '
   ```
3. Create the Secret:
   ```bash
   kubectl create namespace mail
   kubectl create secret generic stalwart-secrets -n mail \
     --from-literal=ADMIN_SECRET='$argon2id$v=19$...' \
     --from-literal=MASTER_SECRET='$argon2id$v=19$...' \
     --from-literal=STALWART_HOSTNAME='mail.phoenix-host.net'
   ```
4. Apply the base manifests:
   ```bash
   kubectl apply -k k8s/base/stalwart/
   ```
5. Wait for the StatefulSet:
   ```bash
   kubectl wait --for=condition=Ready pod -l app=stalwart-mail -n mail --timeout=5m
   ```
6. Verify the LoadBalancer got an external IP (Hetzner Cloud provisions it):
   ```bash
   kubectl get svc stalwart-mail -n mail
   ```
7. Set the DNS A/AAAA for `mail.phoenix-host.net` to the LB IP.
8. Run smoke tests from an external probe: `swaks --server mail.phoenix-host.net --port 25`.

---

## 4. Day-1 Operations

### 4.1 Access the WebAdmin UI

```bash
kubectl port-forward -n mail svc/stalwart-mail-mgmt 8080:8080
# Visit http://localhost:8080 → log in as admin / <ADMIN_SECRET>
```

### 4.2 Reload config without a restart

```bash
kubectl exec -n mail stalwart-mail-0 -- \
  stalwart-cli -u http://127.0.0.1:8080 --credentials "admin:$ADMIN_PASSWORD" \
  server reload-config
```

Not all settings are hot-reloadable — listener changes and store backend changes still require a pod restart. See [Stalwart config overview](https://stalw.art/docs/configuration/overview/#local-and-database-settings).

### 4.3 Reload TLS certificates after cert-manager rotation

```bash
kubectl exec -n mail stalwart-mail-0 -- \
  stalwart-cli -u http://127.0.0.1:8080 --credentials "admin:$ADMIN_PASSWORD" \
  server reload-certificates
```

### 4.4 Create / update principals (Phase 1 internal directory)

Principals are managed via the admin REST API on the management port.

```bash
# Add a domain
curl -u admin:$ADMIN_PASSWORD -X POST -H 'Content-Type: application/json' \
  -d '{"name":"client-a.com","type":"domain"}' \
  http://localhost:8080/api/principal

# Add a mailbox user
curl -u admin:$ADMIN_PASSWORD -X POST -H 'Content-Type: application/json' \
  -d '{
    "name":"alice@client-a.com",
    "type":"individual",
    "secrets":["s3cret"],
    "quota":1073741824,
    "emails":["alice@client-a.com"],
    "roles":["user"]
  }' \
  http://localhost:8080/api/principal
```

⚠️ The `roles: ["user"]` is required — without it the account cannot submit mail.

In Phase 2+, this is replaced by Stalwart reading the SQL directory directly from the platform Postgres. No manual principal creation required — the platform backend already creates `mailboxes` rows.

### 4.5 Consistent backup while running

```bash
kubectl exec -n mail stalwart-mail-0 -- \
  stalwart-cli --anonymous server database-maintenance --backup /opt/stalwart/backups/$(date +%Y%m%d).tar
kubectl cp mail/stalwart-mail-0:/opt/stalwart/backups/$(date +%Y%m%d).tar ./mail-backup.tar
```

For scheduled backups, create a `CronJob` that invokes the above and streams the output to S3/NFS/another node (Phase 5 task).

### 4.6 Prometheus scrape

The management service exposes `/metrics/prometheus`. Annotate the ServiceMonitor (if using prom-operator) or configure static scrape:

```yaml
- job_name: stalwart
  scheme: http
  basic_auth:
    username: admin
    password: <ADMIN_SECRET_plaintext>  # use metrics.prometheus.auth in config for a dedicated scrape user
  static_configs:
    - targets: ['stalwart-mail-mgmt.mail.svc.cluster.local:8080']
  metrics_path: /metrics/prometheus
```

Community Grafana dashboard: [dashboard #23498](https://grafana.com/grafana/dashboards/23498-service-stalwart/).

---

## 5. Storage Migration Procedures

All procedures assume a short planned downtime (≤15 min for small volumes). Always take a fresh backup first.

### 5.1 local-path → hcloud-volumes

When you need node portability, volume snapshots, and online expansion.

```bash
# 1) Create a new PVC on hcloud-volumes
kubectl apply -f - <<EOF
apiVersion: v1
kind: PersistentVolumeClaim
metadata:
  name: data-stalwart-mail-new
  namespace: mail
spec:
  accessModes: [ReadWriteOnce]
  storageClassName: hcloud-volumes
  resources:
    requests:
      storage: 20Gi
EOF

# 2) Scale Stalwart to zero
kubectl scale statefulset stalwart-mail -n mail --replicas=0
kubectl wait --for=delete pod/stalwart-mail-0 -n mail --timeout=2m

# 3) Copy data via a helper pod mounting both PVCs
kubectl run migrate-mail -n mail --image=alpine --restart=Never --overrides='
{
  "spec": {
    "volumes": [
      {"name": "old", "persistentVolumeClaim": {"claimName": "data-stalwart-mail-0"}},
      {"name": "new", "persistentVolumeClaim": {"claimName": "data-stalwart-mail-new"}}
    ],
    "containers": [{
      "name": "rsync",
      "image": "alpine",
      "command": ["/bin/sh", "-c", "apk add --no-cache rsync && rsync -aHAX --info=progress2 /old/ /new/ && touch /new/.migrated"],
      "volumeMounts": [
        {"name": "old", "mountPath": "/old"},
        {"name": "new", "mountPath": "/new"}
      ]
    }]
  }
}'
kubectl wait --for=condition=Ready pod/migrate-mail -n mail --timeout=10m
kubectl logs -f migrate-mail -n mail
kubectl delete pod migrate-mail -n mail

# 4) Patch the StatefulSet template to reference the new storage class
#    (edit k8s/base/stalwart/statefulset.yaml, change storageClassName: hcloud-volumes)
# 5) Delete the old PVC + PV (STATE: volumeClaimTemplate recreate)
kubectl delete pvc data-stalwart-mail-0 -n mail

# 6) Re-apply and scale back up
kubectl apply -k k8s/base/stalwart/
kubectl scale statefulset stalwart-mail -n mail --replicas=1
kubectl wait --for=condition=Ready pod -l app=stalwart-mail -n mail --timeout=5m
```

### 5.2 local-path → NFS on another node

Same flow as §5.1 but with `storageClassName: nfs-client` (requires `nfs-subdir-external-provisioner` installed).

Caveats:
- RocksDB write throughput drops 2–5x due to NFS `fsync` overhead
- Acceptable for 50–100 mailboxes; not recommended for high-volume sending

### 5.3 local blob store → S3 (Stalwart-native, no PVC migration)

This is the **recommended** migration when mail storage grows beyond ~20–50 GB. Message bodies go to S3; metadata stays on fast local storage.

1. **Provision an S3 bucket** (Hetzner Object Storage, Garage, or AWS S3)
2. **Update `config.toml`**:
   ```toml
   [store."s3-blob"]
   type = "s3"
   access-key = "%{env:S3_ACCESS_KEY}%"
   secret-key = "%{env:S3_SECRET_KEY}%"
   region = "eu-central-1"
   bucket = "mail-blobs"
   endpoint = "https://fsn1.your-objectstorage.com"

   [storage]
   blob = "s3-blob"    # change from "fs-blob"
   ```
3. **Inject S3 creds into the Secret**:
   ```bash
   kubectl patch secret stalwart-secrets -n mail -p='
   {"stringData":{"S3_ACCESS_KEY":"...","S3_SECRET_KEY":"..."}}
   '
   ```
4. **One-off copy** of existing blobs from `/opt/stalwart/blobs/` to S3 — scripted helper TBD in Phase 3
5. **Reload config**:
   ```bash
   kubectl exec -n mail stalwart-mail-0 -- \
     stalwart-cli -u http://127.0.0.1:8080 --credentials "admin:$ADMIN_PASSWORD" \
     server reload-config
   ```

Downtime: reload only (seconds). RocksDB metadata unchanged.

---

## 6. Troubleshooting

### 6.1 Pod pending

```bash
kubectl describe pod stalwart-mail-0 -n mail
kubectl get events -n mail --sort-by=.lastTimestamp
```

Common causes:
- PVC unbound — check StorageClass exists and has capacity
- Image pull — local k3s may need `crictl pull` warmup

### 6.2 TLS listeners fail to start

Stalwart auto-generates a self-signed cert on first boot if no `[certificate.*]` block is present. This is fine for testing but not for production — cert-manager-mounted certs should replace it.

### 6.3 SMTP submission returns "550 5.7.1 Your account is not authorized"

The principal is missing the `user` role. Patch it:

```bash
curl -u admin:$ADMIN_PASSWORD -X PATCH -H 'Content-Type: application/json' \
  -d '[{"action":"set","field":"roles","value":["user"]}]' \
  http://localhost:8080/api/principal/<user>
```

### 6.4 SMTP submission returns "SASL: no auth mechanism"

Stalwart only offers PLAIN/LOGIN auth **after** STARTTLS has been negotiated (or on the implicit-TLS port 465). Plaintext submission on port 587 without STARTTLS won't work — that's by design.

### 6.5 Connection refused from outside the cluster

- Check the Service type: should be `LoadBalancer` in prod, `NodePort` in dev
- Check endpoints: `kubectl get endpoints stalwart-mail -n mail`
- Check Hetzner Cloud Firewall rules (§2.3)
- Check that the Hetzner LB got provisioned: `kubectl describe svc stalwart-mail -n mail`

### 6.6 Mail arrives but goes to spam

1. Verify PTR: `dig -x <your-ip>` returns `mail.<your-domain>`
2. Verify SPF/DKIM/DMARC for the sending domain (Phase 1 auto-provisions these via the `email-domains` module)
3. Check IP reputation: https://www.mail-tester.com, https://mxtoolbox.com/blacklists.aspx
4. If on a new IP, expect warm-up period (§2.4)

---

## 7. Status Tracking

| Item | Status | Notes |
|---|---|---|
| Hetzner port 25 unblock request | **REQUESTED** (2026-04-07) | User filed the request; awaiting approval |
| Production deployment | Pending | Blocked on port 25 unblock + real secrets + PTR setup |
| cert-manager Certificate for mail hostname | Not provisioned | Add once production target hostname is chosen |
| Prometheus scrape config | Not configured | Phase 5 |
| Grafana dashboard 23498 | Not imported | Phase 5 |
| Scheduled off-node backups | Not configured | Phase 5 |
| DKIM key rotation | Phase 3 | Currently single key per domain, no rotation |
| DNS SRV / autodiscover | Phase 4 | `dns-provisioning.ts` does not yet emit SRV records |
| Website sendmail from workload pods | Phase 4 | Requires per-pod auth + audit log |
| SQL directory integration (real mailboxes from platform DB) | ✅ Shipped (Phase 2a, 2026-04-08) | `stalwart` schema in platform DB; `stalwart_reader` NOLOGIN role; Endpoints bridge for local dev |
| TLS between Stalwart and platform Postgres | **Production hardening required** | Base ConfigMap has `enable = false`; production overlay must set `enable = true` + strict cert verification |
| VRFY / EXPN cross-client enumeration | Phase 3 | `verify` query is currently unscoped; consider disabling VRFY at Stalwart config level |
