# Mail Architecture Options

> **Status update 2026-05-03**: the Stalwart 0.15.x options below are
> **superseded** by the 0.16 pivot. Stalwart 0.16 (released 2026-04-20,
> latest 0.16.3) makes "completely incompatible" breaking changes:
> TOML config replaced by `config.json` + JMAP-stored settings, REST
> management API removed in favour of JMAP, account names must be email
> addresses, built-in clustering with Outbound MTA role, native DKIM +
> DNS automation. The platform is committing to 0.16 directly and
> skipping further investment in 0.15-era integration code. The
> architecture options below are kept for context; the 0.16 plan lives
> in [§ 11 — Stalwart 0.16 Architecture](#11-stalwart-016-architecture)
> at the bottom of this doc.
>
> Spike harness for local DinD experimentation:
> `scripts/stalwart-016-spike.sh up` — lets you poke the JMAP API and
> validate config.json shape before touching staging.

Captures the design space explored during the staging mail E2E hardening
(2026-05-02 / 2026-05-03). **Not a recommendation document** — a record of
the trade-offs operators can choose from, the rationale behind each, and
the costs each one imposes. Pick when committing to a direction.

---

## 0. The Three Things That Vary Independently

Stalwart's storage layer separates five concerns: `data` (KV — flags, UIDs,
folder tree), `lookup` (KV — rate limits, sessions, blocklists),
`directory` (read of principal/auth records), `directory-manage` (writes —
the Bug F surface), `fts` (search index), and `blob` (raw RFC 5322
messages). Each can be bound to a different backend.

Three knobs the operator turns:

1. **Where does the hot KV state live?** (`data`, `lookup`)
   → rocksdb local file vs Postgres.
2. **Where do blobs live?** (`blob`)
   → local PVC vs SFTP-via-MinIO vs native S3.
3. **Which Postgres does the directory talk to?**
   → shared platform-PG vs dedicated mail-PG vs no PG (rocksdb directory).

A mail architecture is a triplet `(KV-store, blob-store, directory-PG)`.
Most knob combinations are valid; some have failure-mode coupling worth
flagging.

---

## 1. Mail Server Choice

### Option MS-1 — Stalwart (current)
Single Rust binary; SMTP/IMAP/JMAP/POP3/sieve/anti-spam/DKIM in one process.
- **Pros**: one config, one log, one process, one container. Modern defaults
  (DKIM/ARC/MTA-STS/TLS-RPT). JMAP native.
- **Cons**: ~3 years old; smaller security-review history than postfix.
  Storage/HA story still maturing in 0.15.
- **Operational profile**: ~200 MB RAM, <0.1 CPU idle.

### Option MS-2 — postfix + dovecot stack
Industry-standard combo. Requires postfix, dovecot, rspamd (or SpamAssassin),
opendkim, opendmarc, postsrsd, fail2ban — 5–7 services.
- **Pros**: 25+ years of production use. Maildir is `rsync`-friendly.
  Per-tenant backup/restore is `tar` of one directory. PG only consulted at
  login (everything else on filesystem).
- **Cons**: 5–7× the operational surface area. HA via Dovecot Director +
  shared NFS maildir + postfix queue replication is well-known to be fiddly.
  No native JMAP. Modern features (DKIM/MTA-STS/TLS-RPT/ARC) require
  separate package configuration.
- **Migration cost from current Stalwart**: 4–8 weeks. All `email_dkim_keys`,
  `mail-imapsync`, `mail-stats`, DNS provisioning, admin-UI iframe, password
  rotation, integration harness — all rewrites.
- **When to pick**: only when "battle-tested code" is a hard governance
  requirement OR when "no DB in mail data path" is non-negotiable AND
  multi-replica HA is also non-negotiable.

### Option MS-3 — Stalwart + postfix front-end (hybrid)
Postfix as MTA, deliver via LMTP to Stalwart for IMAP/JMAP. Adds one service
without giving up Stalwart's modern features. Rare deployment shape; not
recommended for a small platform.

---

## 2. Hot State Storage (`data` + `lookup`)

### Option HS-1 — RocksDB on local PVC (current staging shape)
Stalwart writes flags, UIDs, modseq, lookups, sessions to RocksDB inside
the pod's PVC.
- **Pros**: zero PG load at runtime. RocksDB is purpose-built for this
  workload. Fast (~µs reads). No network roundtrip.
- **Cons**: single-replica only (RWO PVC). Pod restart = ~30s cold-start
  (RocksDB recovery scan). Backup = full PVC snapshot.
- **DB load**: 0 (PG only consulted at login via the principal directory).
- **Resource cost**: Stalwart pod baseline (~200 MB RAM). PVC ~5 GB metadata.
- **HA story**: none — single-replica only.

### Option HS-2 — Postgres for hot KV
Stalwart writes everything to Postgres; pod becomes stateless except for
the blob store (which has its own decision below).
- **Pros**: multi-replica trivially possible. Pod restart in seconds. State
  survives pod loss. Backup = standard PG dump.
- **Cons**: ~5M PG writes/day at 50–100 tenant scale (every IMAP FETCH
  updates lastSeen, every flag change is a write). Adds ~30 partitioned
  tables in a `stalwart_data` schema. Network roundtrip per op (mitigated
  by Stalwart's in-memory cache).
- **DB load**: meaningful — ~5M writes/day. Within reach of a well-tuned
  CNPG cluster but worth isolating (see DB-2 below).
- **Resource cost**: same Stalwart baseline; PG load described above.
- **HA story**: native — N replicas of Stalwart, all reading/writing the
  same PG. With HS-2 + BS-2 (S3 blobs), Stalwart pods are fully ephemeral.

### Option HS-3 — Hybrid (RocksDB hot, PG for directory-manage only)
RocksDB for `data` + `lookup` + `fts`. Postgres for `directory` (read) and
`directory-manage` (write — closes Bug F without bringing PG into the hot
path).
- **Pros**: matches HS-1 performance for IMAP/SMTP hot path. Closes Bug F.
  Per-pod state still bounded to the PVC (~5 GB).
- **Cons**: still single-replica. Stalwart's exact knobs for splitting
  directory-manage from `data` need verification against 0.15 schema.
- **DB load**: ~50–100k queries/day (login + management) — trivial.
- **HA story**: none — same as HS-1.

---

## 3. Blob Storage

### Option BS-1 — Local PVC (`fs` backend)
Blobs as one file per message under `/opt/stalwart/blobs`.
- **Pros**: simplest possible backend. Resizable (Longhorn online resize).
  Standard maildir-like format — readable by any tool. Per-tenant backup is
  feasible by walking the `stalwart_data` index for blob IDs scoped to a
  client.
- **Cons**: RWO — single-replica only unless using RWX-NFS (Longhorn
  share-manager adds ~10–50 ms write latency). Volume grows unbounded with
  mail volume; needs operator-driven resize.
- **Storage cost**: matches mail volume directly. 50 tenants × 100
  mailboxes × 100 messages/day × 200 KB ≈ 10 GB/day inflow.
- **HA story**: incompatible with multi-replica unless RWX-NFS.

### Option BS-2 — Native S3-compatible (Hetzner Object Storage default)
Stalwart's `s3` backend talks to any S3-compatible endpoint.
- **Pros**: multi-replica clean. Lifecycle rules (move to cold tier after
  90 days, delete after retention). 99.99% SLA on Hetzner Object Storage.
  Operator can swap providers freely.
- **Cons**: requires external endpoint — couples mail uptime to provider's
  SLA. Per-blob latency floor ≈ 30–50 ms (HTTPS round-trip).
- **Storage cost**: ~€5/TB/mo (Hetzner OS). Cheaper than PVC at scale once
  blob volume passes the PVC's break-even.
- **HA story**: trivially multi-replica.

### Option BS-3 — MinIO + sshfs to Storage Box (operator preference)
In-cluster MinIO Deployment whose data volume is sshfs-mounted to a
Hetzner Storage Box (~€3/TB/mo). Stalwart talks S3 to MinIO.
- **Pros**: cheap. Local-only feel (no SaaS dependency for mail data —
  just an SSH endpoint). Operator can use any SFTP-reachable storage.
- **Cons**: sshfs default is single-channel; concurrent writes serialise.
  Tunable (`-o multi-channel=8 -o max_read=131072 -o max_write=131072`).
  Production-grade at small scale; degrades under sustained load.
  **`fsync` round-trips per blob = ~50–100 ms** floor.
- **Storage cost**: ~€3/TB/mo + ~50–100 m CPU + ~256 Mi RAM for the MinIO pod.
- **HA story**: MinIO single-replica → blob backend SPOF. Multi-replica MinIO
  on shared sshfs adds significant complexity.
- **When to pick**: small/medium platforms where operator wants no SaaS
  dependency, expected throughput < ~30 MB/s sustained.

### Option BS-4 — JuiceFS + SFTP + PG metadata
JuiceFS chunks blobs into 4 MB blocks, stores blocks via SFTP (any backend
JuiceFS supports), keeps file metadata in Postgres.
- **Pros**: production-grade SFTP-backed storage. Native multi-replica
  capable. Metadata in your existing PG (or a dedicated mail-PG). Reuses
  the platform's PG ops/backup story for filesystem metadata.
- **Cons**: adds JuiceFS CSI driver + per-pod mount sidecar (~150 MB RSS,
  <0.1 CPU). One more layer to understand at incident time. Metadata table
  size ~1 GB at platform scale.
- **Storage cost**: same SFTP backing fee as BS-3 + JuiceFS overhead above.
- **PG impact**: ~30 metadata queries/day per blob op, heavily client-cached
  → ~30k uncached queries/day cluster-wide. Negligible.
- **HA story**: clean — multi-replica Stalwart all mount the same JuiceFS
  filesystem.
- **When to pick**: BS-3 with the "production-grade" requirement upgraded.

### Option BS-5 — rclone-mount with local cache
Pod-side rclone mount with `--vfs-cache-mode=full --vfs-cache-max-size=10G`.
Reads from local cache; cold reads pull from SFTP/S3; writes hit cache then
upload async.
- **Pros**: local-PVC read latency feel. Tunable cache size.
- **Cons**: cache PVC eats some of the savings. Async writes risk data loss
  if pod dies before upload (mitigatable with sync mode but loses the
  performance benefit).
- **When to pick**: rare. Use BS-2 or BS-4 instead.

---

## 4. Directory & Management Postgres

### Option DB-1 — Shared platform-PG (current)
Stalwart's `directory` reads `stalwart.principals` view in the same CNPG
cluster as the platform DB.
- **Pros**: zero extra infrastructure. One CNPG cluster to operate. One
  backup set. Already wired.
- **Cons**: mail traffic shares failure domain with tenant CRUD. A runaway
  IMAP search query (in HS-2 mode) could degrade the platform's auth path.
  Resource contention.
- **DB load added**: ~50–500k queries/day in HS-1; ~5M+ writes/day in HS-2.

### Option DB-2 — Dedicated mail-PG (recommended once load grows)
A second CNPG `Cluster` CR, just for mail-related schemas (`stalwart_*`).
- **Pros**: blast-radius isolation. Mail traffic can't degrade tenant CRUD.
  Mail DB can fail/upgrade independently. Same operator skill set, same
  backup tooling, same monitoring.
- **Cons**: one more PG cluster to operate. ~256 Mi RAM + ~50–200 m CPU
  baseline + ~5 GB disk. A second backup destination to monitor.
- **Setup cost**: ~1 day. New `Cluster` CR + matching `Secret` for
  credentials + Stalwart `[store.pg]` connection string update.
- **What you DON'T isolate**: Postgres-as-software bugs (CVE patches both
  clusters), CNPG operator bugs, cluster-wide infra failures (storage
  class, network).

### Option DB-3 — No PG for hot path (HS-1 default)
PG only consulted for principal directory at login. All hot state in
RocksDB.
- **Pros**: minimal PG surface area; ~500 queries/day cluster-wide.
- **Cons**: single-replica (HS-1's constraint).

---

## 5. Search Index (FTS)

### Option FTS-1 — RocksDB-backed (current default)
Local index, fastest, scales with single-replica.
- **Pros**: instant search up to ~1 M messages per mailbox.
- **Cons**: single-replica only. Lost if PVC corrupts; rebuildable from
  blobs.

### Option FTS-2 — Postgres `tsvector`
Stalwart 0.15 supports `[storage] fts = "postgresql"`.
- **Pros**: multi-replica capable. Backed by your existing PG operability.
- **Cons**: ~10–30% slower than RocksDB for large mailboxes. Heavier write
  load on PG (every message indexed = `tsvector` insert + GIN index update).
- **When to pick**: when multi-replica Stalwart is required and search
  matters.

### Option FTS-3 — Disabled
Stalwart still works; IMAP SEARCH falls back to a sequential scan over
headers and blob bodies.
- **Pros**: zero index storage; zero write overhead. Re-enable later by
  flipping the config + reindexing from blobs.
- **Cons**: SEARCH on a 10k-message mailbox goes from instant to
  multi-second. Power users notice; casual users don't.
- **When to pick**: small platforms where search performance is not a
  contractual feature.

---

## 6. Multi-Node Egress (deliverability)

### Option EG-1 — Direct (any node)
Outbound mail leaves through whichever node a Stalwart pod runs on. SPF
record must list every node IP.
- **Pros**: zero infra.
- **Cons**: fragile — adding a node breaks SPF until DNS republishes. More
  reverse-DNS records to maintain. Spam filters track per-IP reputation;
  with rotating IPs each accumulates only fractional reputation.

### Option EG-2 — Pinned via Calico EgressGateway
Dedicated egress nodes labelled `mail-egress=true`. Calico routes all
SMTP traffic via those nodes' IPs.
- **Pros**: 1–N stable IPs. SPF lists exactly those. Failover if multiple.
  Standard pattern.
- **Cons**: requires Calico EgressGateway support (verify against your
  Calico version). One config layer.
- **When to pick**: HA Stalwart + self-managed deliverability.

### Option EG-3 — Dedicated egress pod with `hostNetwork`
A small `stalwart-relay` Deployment with `nodeSelector` + `hostNetwork:
true` pinned to specific node(s). Other Stalwart replicas relay outbound
through it.
- **Pros**: works without Calico-specific features.
- **Cons**: extra service. The relay pod is a SPOF unless replicated.
- **When to pick**: when EgressGateway isn't available.

### Option EG-4 — External SMTP relay (Mailgun/Postmark/SendGrid)
Stalwart submits outbound to a third-party relay; they handle reputation +
deliverability.
- **Pros**: best deliverability at scale. Provider absorbs IP-reputation
  problem. Backed by sender-policy expertise.
- **Cons**: ~$5–50/mo per service. Cedes one of the platform's value props.
  Tenant data passes through a third party.
- **When to pick**: when reaching enterprise customers / external mailbox
  providers reliably is more important than self-sufficiency.

---

## 7. Recommended Combinations

These are coherent triplets for common operator profiles. Other valid
combinations exist; these are starting points.

### Profile A — Single-replica appliance (current staging)
- MS-1 (Stalwart) + HS-1 (RocksDB) + BS-1 (PVC) + DB-1 (shared PG) + FTS-1
  + EG-1
- **Resource cost**: lowest. ~1 GB Stalwart RAM, ~10 GB PVC growing.
- **Operations cost**: lowest. One pod, one config, one backup target.
- **Limits**: no HA, mail downtime ~30 s on node loss.
- **Closes**: nothing to close — works as shipped (after Bug F is fixed
  with HS-3-style management-store binding).
- **Best for**: 1–50 tenants, deliverability flexibility not required.

### Profile B — Production-isolated single-replica
- MS-1 + HS-3 (RocksDB hot, PG directory only) + BS-1 (PVC) + **DB-2
  (dedicated mail-PG)** + FTS-1 + EG-2
- **Resource cost**: + 256 Mi / 100 m CPU for mail-PG. Same Stalwart pod
  footprint.
- **Operations cost**: one extra CNPG cluster.
- **Limits**: still single-replica.
- **Closes**: blast-radius coupling between mail and platform DB.
- **Best for**: 50–200 tenants where mail and platform CRUD must not share
  failure modes.

### Profile C — HA stateless
- MS-1 + HS-2 (PG-only hot path) + BS-2 (Hetzner Object Storage) + **DB-2
  (dedicated mail-PG)** + FTS-2 (PG) + EG-2
- **Resource cost**: ~5M PG writes/day on the mail-PG. Pod baseline same.
- **Operations cost**: dedicated PG cluster + S3 endpoint creds + Calico
  EgressGateway. Two failure modes (PG, S3) instead of one.
- **Limits**: search is 10–30% slower than FTS-1.
- **Closes**: single-point-of-failure on the Stalwart pod, and on the PVC.
- **Best for**: ≥ 200 tenants where mail uptime is contractually material.

### Profile D — Maximum cost-efficiency, accepting fragility
- MS-1 + HS-3 + BS-3 (MinIO+sshfs to Storage Box) + DB-1 + FTS-1 + EG-2
- **Resource cost**: + ~256 Mi / 100 m CPU for MinIO. Storage Box ~€3/TB/mo.
- **Operations cost**: MinIO + sshfs is an extra failure mode. Sustained-
  load risk documented.
- **Limits**: ~30 MB/s sustained throughput; sshfs single-channel can
  serialise under load. SPOF on storage-box availability.
- **Best for**: lab / personal / very small commercial deployments.

### Profile E — postfix+dovecot
Out-of-band of the above matrix. See MS-2 for the full discussion.
**Realistic switch cost from Profile A: 4–8 weeks of platform-side
rewrites.**

---

## 8. Decision Order

When choosing, walk these questions in this order:

1. **Is multi-replica Stalwart a hard requirement?**
   Yes → eliminates HS-1, HS-3, BS-1 (without RWX-NFS), FTS-1.
   No → all options open.

2. **Is "no SaaS dependency" a hard requirement for blobs?**
   Yes → eliminates BS-2.
   No → BS-2 is the cheapest path to multi-replica.

3. **Is "platform-DB and mail-DB share failure modes" acceptable?**
   No → DB-2 (dedicated mail-PG).
   Yes → DB-1 (shared).

4. **Is fast SEARCH on > 10k-message mailboxes a contractual feature?**
   Yes → FTS-1 (single-replica) or FTS-2 (HA).
   No → FTS-3.

5. **Is per-IP deliverability reputation a concern?**
   Yes → EG-2 with stable egress IPs (or EG-4 if losing self-sufficiency
   is acceptable).
   No → EG-1.

The answers narrow to ~1–2 coherent profiles. Match to A–E above.

---

## 9. What's Built Today

- **MS-1** Stalwart in a single-replica StatefulSet.
- **HS-1** RocksDB on Longhorn PVC (`/opt/stalwart`).
- **BS-1** PVC (`/opt/stalwart/blobs`), 20 Gi.
- **DB-1** Shared platform-PG; read-only `stalwart.principals` view via
  `stalwart_reader` role.
- **FTS-1** RocksDB.
- **EG-1** Direct, but with Service `externalIPs: [89.167.3.56]`
  effectively pinning egress to staging3.

= **Profile A**, with one open issue (Bug F) — directory-management writes
fail because the read-only PG link can't satisfy them. Fix is a single
config: bind directory-manage to RocksDB locally (HS-3 partial).

---

## 10. Migration Paths

Migration between profiles costs roughly:

- **A → B** (add dedicated mail-PG): ~1 day. New CNPG cluster + connection
  string change. No data movement.
- **A → C** (full HA stateless): ~2 weeks. Migrate `data` + `lookup` to
  PG, blobs to S3. Bug-A-class transactional risk on the swap. Migration
  tooling required.
- **A → D** (MinIO+SFTP): ~3 days. Add MinIO Deployment + sshfs CSI;
  migrate blob data via copy + cutover; document load caveats.
- **C ↔ D** (swap blob backend): ~1 week. Migration tooling reads source,
  writes destination, verifies, cuts over with a 7-day fallback window.
- **A → E** (postfix+dovecot): ~4–8 weeks. Full platform-side rewrite of
  every mail-related module + admin UI.

---

## Appendix — Stalwart blob contents

For reference when reasoning about blob-store choice:

A blob is the **raw RFC 5322 message bytes** — exactly what arrived over
SMTP. Headers + body + attachments inline as MIME parts. **Not** in a blob:
flags, folder hierarchy, UIDs, modseq, search index, quota counters,
delivery decisions — all live in the `data`, `lookup`, or `directory`
stores. Blobs are write-once, read-occasionally, and effectively immutable
once written; this is the ideal workload for object storage.

Typical blob sizes: 2–10 KB plain text, 20–100 KB HTML newsletter,
200 KB – 2 MB HTML with embedded images, 1–10 MB with PDF, 10–50 MB with
photo/video. Mean ~50–200 KB; SMTP cap typically 25 MB. At platform scale
(50–100 tenants × 100 mailboxes × 100 messages/day × 200 KB) blob inflow
is ~10–20 GB/day. **99% of "mail data" disk is blobs**, not metadata.

---

## 11. Stalwart 0.16 Architecture

Confirmed 2026-05-03 from upstream sources + working DinD spike.

### What 0.16 changed

| Layer | 0.15.x | 0.16.x |
|---|---|---|
| Config file | `config.toml` (full server config) | `config.json` (datastore-only; everything else as JMAP objects in DB) |
| Management API | REST `/api/...` | JMAP `/jmap/...` |
| CLI | TOML-aware | Rewritten on JMAP |
| Account naming | bare strings (`alice`) | email addresses (`alice@example.com`) |
| DKIM management | manual TOML keys | native auto-rotation + DNS publish |
| DNS automation | manual TOML | native MX/TXT/SRV/CAA/TLSA/CNAME |
| Clustering | external coordination | built-in node-ID management + Outbound MTA role |
| Storage layout | unchanged | unchanged |

### Spike confirmed (DinD, image `stalwartlabs/stalwart:v0.16.3`)
- Bootstrap mode listens on :8080 only (`STALWART_RECOVERY_MODE=1` + `STALWART_RECOVERY_ADMIN=admin:pw`).
- JMAP `/jmap/session` returns standard RFC 8620 capabilities (mail/calendars/contacts/filenode/principals/submission/vacationresponse/sieve/blob).
- `/healthz/live` returns 200 with `{"status":200,"title":"OK"}`.
- Full mail listeners (25/465/587/143/993/4190) come up only after applying a baseline plan with `stalwart-cli apply`.

### Build features in upstream Docker image
`sqlite postgres mysql rocks s3 redis azure nats enterprise` — all backends available; Enterprise feature set baked in.

### Target deployment shape

```
config.json on PVC (or k8s ConfigMap):
  store.<id> = postgresql backend in stalwart_app DB
  storage.{data,blob,fts,lookup} → that store

Everything else (domains, accounts, listeners, DKIM, DNS, ACME, rate
limits, spam rules) lives in the database as JMAP objects.

Initial bootstrap:
  1. CNPG creates database `stalwart_app` with role `stalwart_app`
     (no schema — Stalwart manages its own).
  2. Stalwart pod starts with STALWART_RECOVERY_MODE=1 + admin creds.
  3. platform-api invokes `stalwart-cli apply` with a generated plan
     defining: domain(s), listeners, ACME provider, default DKIM keys,
     SMTP routing, spam thresholds, admin account.
  4. Recovery mode disabled; pod restarts; full listeners come up.
  5. Per-tenant operations (create domain, create mailbox) → platform-
     api calls JMAP API (or another `apply` round).
```

### Platform integration changes

| Capability | Today (0.15) | 0.16 design |
|---|---|---|
| Admin password rotation | platform writes `stalwart-secrets` Secret + REST password set | JMAP `Principal/set` against admin account |
| Cert reload | Reloader on Secret change (already done) | Same — Reloader pattern unchanged |
| Mailbox create | INSERT into platform DB + Stalwart reads via SQL view | platform-api → JMAP `Principal/set type:individual` against `stalwart_app` JMAP endpoint |
| DKIM rotation | platform `email_dkim_keys` table + cron | **Drop** — Stalwart 0.16 auto-rotates; platform reads the published TXT for status display only |
| MX/TXT/SRV provisioning | platform `dns-provisioning.ts` | **Drop** — Stalwart 0.16 manages all DNS records (publishes via the platform's PowerDNS API or directly via supported providers) |
| Cluster outbound egress | none | Stalwart "Outbound MTA role" — designate cluster nodes as outbound-MTA. Likely replaces Calico EgressGateway / hostNetwork-relay plan |
| IMAPSync / mail-imapsync | platform module | **Keep** — not in Stalwart's scope |
| Quota notifier | platform `mail-stats/quota-notifications.ts` | **Keep** — UI-driven; reads usage via JMAP |
| Admin web-admin iframe | platform_session cookie gate over Stalwart `/__stalwart/` | **Rewrite** — new WebUI URL; same auth-gate Component |
| Per-tenant lifecycle | platform owns | **Keep** — translates to JMAP create/delete |

### Calico EgressGateway status

Confirmed unavailable in Calico OSS v3.31.5 on staging — no `EgressGateway` CRDs present, no `egress` API resources. Calico EgressGateway has historically been Calico Enterprise/Cloud only. Plan: test Stalwart 0.16's "Outbound MTA role" first; if it covers our use case, drop the EgressGateway/hostNetwork-relay design entirely. If 0.16 clustering doesn't address outbound source-IP control, fall back to a `stalwart-egress-relay` Deployment with `nodeSelector` + `hostNetwork: true` pinned to operator-selected nodes.

### Decisions confirmed for the 0.16 pivot

- **Q1 (mail-data wipe)**: fresh install on staging; 0 mail-enabled clients exist so wipe is free.
- **Q2 (capability split)**: Stalwart owns DKIM + DNS-record automation; platform owns quota / IMAPSync / admin-UI / lifecycle.
- **Q3 (database)**: dedicated `stalwart_app` database within existing platform CNPG cluster (no second cluster). Role limits applied.
- **Local testing**: spike harness `scripts/stalwart-016-spike.sh` for local DinD.

### Open items requiring further work

- Validate the exact `config.json` schema for the postgresql data backend (spike currently uses RocksDB; need to confirm PG works the same).
- Build a baseline `stalwart-cli apply` plan template (listeners, ACME, default domain, admin account).
- Confirm Outbound MTA role fits multi-node-egress requirement; otherwise plan hostNetwork-relay fallback.
- platform-api JMAP client implementation: Node.js JMAP libraries are sparse (`jmap-client-ts` is the most maintained). Decide whether to use a library or do raw HTTP calls.
- Rewrite admin-panel's mail iframe + password rotation against the new WebUI URL.
- Audit + retire the platform-side DKIM rotation cron + `email_dkim_keys` table once Stalwart 0.16 owns it.
- Audit + retire the platform-side DNS provisioning paths that overlap with Stalwart's auto-DNS.
