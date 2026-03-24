# Multi-Master Database Conflict Resolution Matrix

> **Critical for Phase 2+** — When deploying geographic sharding with multi-master PostgreSQL.
>
> This document defines **exactly** how conflicts are resolved when two regions write different values to the same database record simultaneously.

---

## Overview

In a multi-master setup, two regions can write to the database at the same time. Since network latency is unpredictable, conflicts happen. This document defines resolution rules for every table.

### Conflict Types

| Type | Description | Example |
|------|-------------|---------|
| **Write-write conflict** | Two regions update the same row within the same replication window | Frankfurt updates `clients.plan_id = 'business'` while OVH updates it to `'premium'` |
| **Write-delete conflict** | One region updates a row; another deletes it simultaneously | Frankfurt updates `domains.ssl_cert_path`; OVH deletes the domain |
| **Insert-insert conflict** | Two regions insert a row with the same unique key | Two admins create the same email account in different regions simultaneously |
| **No conflict** | Append-only tables (audit_log, backups) — every insert is unique | Each audit event gets a unique `event_id` (UUID); no row is ever updated |

All conflicts are resolved by the PostgreSQL trigger `resolve_conflict()` that fires `BEFORE UPDATE` on each replicated table. The trigger applies the rule from this matrix and either accepts the incoming update, rejects it (keeping the existing row), or merges values.

---

## Database Schema & Conflict Rules

### Table 1: `clients`

**Purpose:** Customer accounts

**Columns:**

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID` | Primary key (generated at creation; immutable) |
| `name` | `TEXT` | Customer display name |
| `email` | `TEXT UNIQUE` | Contact email address |
| `plan_id` | `UUID` | References `plans.id` |
| `status` | `TEXT` | `active`, `suspended`, `cancelled` |
| `cpu_limit` | `INTEGER` | Millicores (e.g. 1000 = 1 vCPU) |
| `memory_limit_gb` | `NUMERIC(5,2)` | Memory limit in GiB |
| `storage_limit_gb` | `NUMERIC(7,2)` | Storage quota in GiB |
| `billing_price_usd` | `NUMERIC(10,2)` | Custom billed amount (null = use plan default) |
| `region_id` | `TEXT` | Assigned home region slug (immutable after creation) |
| `updated_at` | `TIMESTAMPTZ` | Last modification timestamp (UTC) |
| `updated_by_region` | `TEXT` | Region slug that wrote the last change |
| `version_number` | `BIGINT` | Monotonically increasing; incremented on every write |

**Conflict Resolution Rules:**

| Column | Conflict Rule | Logic | Example |
|---|---|---|---|
| `name` | Last-write-wins | Use `updated_at` timestamp | Admin changes name in Frankfurt; OVH syncs later → use Frankfurt version |
| `email` | Last-write-wins | Use `updated_at` timestamp | Similar to name |
| `plan_id` | Highest-tier wins | Business > Starter, Premium > Business | User upgrades in Frankfurt to Business, in OVH to Premium simultaneously → both see Premium |
| `status` | Disable wins (disabled > active > deleted) | Err on side of caution | Client suspended in Frankfurt, enabled in OVH → stays suspended everywhere |
| `cpu_limit` | Maximum wins | Use higher limit (user-friendly) | Frankfurt sets 2 CPU, OVH sets 4 CPU → client gets 4 everywhere |
| `memory_limit_gb` | Maximum wins | Use higher limit | Same logic as CPU |
| `storage_limit_gb` | Maximum wins | Use higher limit | Same logic |
| `billing_price_usd` | Last-write-wins | Most recent admin action | Admin adjusts price → use newest timestamp |
| `region_id` | Home region (no change) | Region where client was created | Not writable after creation |
| `updated_at` | Most recent timestamp | Tiebreaker for other rules | Updated_at determines "latest" |
| `updated_by_region` | Region with newest `updated_at` | Track where last change came from | Used for audit trail |
| `version_number` | Increment on every write | Helps detect concurrent writes | If both write to same version, conflict detected |

**Conflict Detection:**

A conflict on the `clients` table is detected when pglogical attempts to apply a remote row update and the local row has a `version_number` equal to or higher than the incoming version. The `updated_at` timestamp is used as a tiebreaker when `version_number` values are equal (clock skew < 1s is tolerated).

**Implementation (PostgreSQL trigger):**

```sql
-- migrations/conflict_resolution/clients_trigger.sql

CREATE OR REPLACE FUNCTION resolve_clients_conflict()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  plan_tier_order TEXT[] := ARRAY['starter', 'business', 'premium'];
  old_tier_idx    INT;
  new_tier_idx    INT;
BEGIN
  -- Reject if the incoming update is older than our local record
  IF NEW.updated_at < OLD.updated_at THEN
    RETURN OLD; -- keep local version
  END IF;

  -- plan_id: highest tier wins (regardless of timestamp)
  SELECT array_position(plan_tier_order, p.slug)
    INTO old_tier_idx FROM plans p WHERE p.id = OLD.plan_id;
  SELECT array_position(plan_tier_order, p.slug)
    INTO new_tier_idx FROM plans p WHERE p.id = NEW.plan_id;
  IF old_tier_idx > new_tier_idx THEN
    NEW.plan_id := OLD.plan_id; -- keep higher tier
  END IF;

  -- status: suspended > active (disable wins)
  IF OLD.status = 'suspended' AND NEW.status = 'active' THEN
    NEW.status := 'suspended';
  END IF;
  -- deleted wins over everything
  IF OLD.status = 'cancelled' THEN
    RETURN OLD; -- client already cancelled; ignore update
  END IF;

  -- resource limits: maximum wins
  NEW.cpu_limit       := GREATEST(OLD.cpu_limit,       NEW.cpu_limit);
  NEW.memory_limit_gb := GREATEST(OLD.memory_limit_gb, NEW.memory_limit_gb);
  NEW.storage_limit_gb := GREATEST(OLD.storage_limit_gb, NEW.storage_limit_gb);

  -- version_number: always increment
  NEW.version_number := OLD.version_number + 1;

  -- Log the resolved conflict
  INSERT INTO conflict_log (table_name, record_id, local_version, remote_version, resolved_at, resolution)
  VALUES ('clients', OLD.id::TEXT, OLD.version_number, NEW.version_number, NOW(), 'merged');

  RETURN NEW;
END;
$$;

CREATE TRIGGER clients_conflict_resolution
  BEFORE UPDATE ON clients
  FOR EACH ROW
  WHEN (OLD.version_number IS NOT NULL AND NEW.version_number IS NOT NULL)
  EXECUTE FUNCTION resolve_clients_conflict();
```

---

### Table 2: `domains`

**Purpose:** Registered domains for clients

**Columns:**

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID` | Primary key |
| `client_id` | `UUID` | References `clients.id` |
| `domain` | `TEXT UNIQUE` | Fully-qualified domain name |
| `status` | `TEXT` | `active`, `suspended`, `deleted` |
| `ssl_cert_path` | `TEXT` | Path to TLS certificate in Secrets store |
| `ssl_expiry_at` | `TIMESTAMPTZ` | Certificate expiry timestamp |
| `dns_verified_at` | `TIMESTAMPTZ` | When DNS ownership was first verified |
| `updated_at` | `TIMESTAMPTZ` | Last modification timestamp |
| `updated_by_region` | `TEXT` | Region that made the last change |
| `version_number` | `BIGINT` | Monotonically increasing write counter |

**Conflict Resolution Rules:**

| Column | Conflict Rule | Logic |
|---|---|---|
| `status` | Delete wins (deleted is final) | If one region deleted, all regions delete |
| `ssl_cert_path` | Last-write-wins | Newest cert wins |
| `ssl_expiry_at` | Latest expiry date | If cert renewed in both regions, use latest |
| `dns_verified_at` | Earliest verification | Once verified in any region, mark verified everywhere |

**Special Case: Deletes**

When one region deletes a domain (sets `status = 'deleted'`), pglogical replicates the update to all regions. The trigger ensures:
1. If `OLD.status = 'deleted'` → `RETURN OLD` (ignore any incoming update; deletion is final).
2. If `NEW.status = 'deleted'` → allow the delete to propagate (delete wins).

```sql
CREATE OR REPLACE FUNCTION resolve_domains_conflict()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Delete wins: if local record is already deleted, reject all updates
  IF OLD.status = 'deleted' THEN
    RETURN OLD;
  END IF;
  -- Incoming delete wins over any other status
  IF NEW.status = 'deleted' THEN
    RETURN NEW;
  END IF;

  -- Reject stale updates
  IF NEW.updated_at < OLD.updated_at THEN
    RETURN OLD;
  END IF;

  -- ssl_expiry_at: take the latest (most recently renewed cert)
  IF OLD.ssl_expiry_at > NEW.ssl_expiry_at THEN
    NEW.ssl_expiry_at := OLD.ssl_expiry_at;
    NEW.ssl_cert_path := OLD.ssl_cert_path;
  END IF;

  -- dns_verified_at: take the earliest (once verified, stays verified)
  IF OLD.dns_verified_at IS NOT NULL AND
     (NEW.dns_verified_at IS NULL OR OLD.dns_verified_at < NEW.dns_verified_at) THEN
    NEW.dns_verified_at := OLD.dns_verified_at;
  END IF;

  NEW.version_number := OLD.version_number + 1;

  INSERT INTO conflict_log (table_name, record_id, local_version, remote_version, resolved_at, resolution)
  VALUES ('domains', OLD.id::TEXT, OLD.version_number, NEW.version_number, NOW(), 'merged');

  RETURN NEW;
END;
$$;

CREATE TRIGGER domains_conflict_resolution
  BEFORE UPDATE ON domains
  FOR EACH ROW
  EXECUTE FUNCTION resolve_domains_conflict();
```

---

### Table 3: `email_accounts`

**Purpose:** Email users (user@domain.com)

**Columns:**

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID` | Primary key |
| `client_id` | `UUID` | References `clients.id` |
| `domain_id` | `UUID` | References `domains.id` |
| `username` | `TEXT` | Local part of the email address (e.g. `alice` for `alice@domain.com`) |
| `password_hash` | `TEXT` | argon2id hash of the mailbox password (or null if OIDC-only) |
| `quota_mb` | `INTEGER` | Mailbox storage quota in MiB |
| `forwarding_addresses` | `TEXT[]` | Array of forwarding email addresses |
| `status` | `TEXT` | `active`, `suspended`, `deleted` |
| `created_in_region` | `TEXT` | Region where account was originally created (immutable) |
| `updated_at` | `TIMESTAMPTZ` | Last modification timestamp |
| `version_number` | `BIGINT` | Write counter |

**Conflict Resolution Rules:**

| Column | Conflict Rule | Logic |
|---|---|---|
| `username` | Created in region (no conflict) | Email accounts are created in specific region; no two regions create same account |
| `password_hash` | Last-write-wins | User changes password → newest version everywhere |
| `quota_mb` | Maximum wins | User increases quota in Frankfurt (1000MB), OVH increases (2000MB) → both see 2000MB |
| `forwarding_addresses` | Merge (union) | Both regions add different forwarding addresses → both are forwarded to |

**Implementation:**

```sql
CREATE OR REPLACE FUNCTION resolve_email_accounts_conflict()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  -- Delete wins
  IF OLD.status = 'deleted' THEN RETURN OLD; END IF;
  IF NEW.status = 'deleted' THEN RETURN NEW; END IF;

  -- Reject stale writes
  IF NEW.updated_at < OLD.updated_at THEN RETURN OLD; END IF;

  -- quota_mb: maximum wins (more storage is better for user)
  NEW.quota_mb := GREATEST(OLD.quota_mb, NEW.quota_mb);

  -- forwarding_addresses: merge (union of both arrays, no duplicates)
  NEW.forwarding_addresses := ARRAY(
    SELECT DISTINCT unnest(OLD.forwarding_addresses || NEW.forwarding_addresses)
  );

  NEW.version_number := OLD.version_number + 1;

  INSERT INTO conflict_log VALUES ('email_accounts', OLD.id::TEXT, OLD.version_number, NEW.version_number, NOW(), 'merged');
  RETURN NEW;
END;
$$;

CREATE TRIGGER email_accounts_conflict_resolution
  BEFORE UPDATE ON email_accounts
  FOR EACH ROW
  EXECUTE FUNCTION resolve_email_accounts_conflict();
```

---

### Table 4: `databases`

**Purpose:** MariaDB/PostgreSQL databases for clients

**Columns:**

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID` | Primary key |
| `client_id` | `UUID` | References `clients.id` |
| `db_name` | `TEXT` | Database name (e.g. `client_abc_wp1`) |
| `db_type` | `TEXT` | `mariadb` or `postgresql` |
| `owner_password_hash` | `TEXT` | Hash of the DB owner user password |
| `backup_size_bytes` | `BIGINT` | Size of last backup file (informational) |
| `backup_frequency` | `TEXT` | `hourly`, `daily`, `weekly` |
| `status` | `TEXT` | `active`, `deleted` |
| `created_in_region` | `TEXT` | Immutable — region where DB was created |
| `updated_at` | `TIMESTAMPTZ` | Last modification timestamp |
| `version_number` | `BIGINT` | Write counter |

**Conflict Resolution Rules:**

| Column | Conflict Rule | Logic |
|---|---|---|
| `db_name` | Created in region (no conflict) | Databases created locally; no two regions create same DB |
| `owner_password_hash` | Last-write-wins | User resets password → newest version |
| `backup_size_bytes` | Most recent measurement | Backup size naturally fluctuates |
| `backup_frequency` | Maximum frequency wins | Daily > weekly (more frequent backups are better) |

```sql
CREATE OR REPLACE FUNCTION resolve_databases_conflict()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
  DECLARE freq_order TEXT[] := ARRAY['weekly', 'daily', 'hourly'];
BEGIN
  IF OLD.status = 'deleted' THEN RETURN OLD; END IF;
  IF NEW.status = 'deleted' THEN RETURN NEW; END IF;
  IF NEW.updated_at < OLD.updated_at THEN RETURN OLD; END IF;

  -- backup_size_bytes: most recent measurement (just use last-write-wins via updated_at)
  -- backup_frequency: maximum frequency wins
  IF array_position(freq_order, OLD.backup_frequency) >
     array_position(freq_order, NEW.backup_frequency) THEN
    NEW.backup_frequency := OLD.backup_frequency;
  END IF;

  NEW.version_number := OLD.version_number + 1;
  INSERT INTO conflict_log VALUES ('databases', OLD.id::TEXT, OLD.version_number, NEW.version_number, NOW(), 'merged');
  RETURN NEW;
END;
$$;

CREATE TRIGGER databases_conflict_resolution
  BEFORE UPDATE ON databases
  FOR EACH ROW
  EXECUTE FUNCTION resolve_databases_conflict();
```

---

### Table 5: `websites`

**Purpose:** Web applications (WordPress, Nextcloud, etc.)

**Columns:**

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID` | Primary key |
| `client_id` | `UUID` | References `clients.id` |
| `domain_id` | `UUID` | References `domains.id` |
| `app_type` | `TEXT` | Application type slug (e.g. `wordpress`, `nextcloud`); immutable after creation |
| `status` | `TEXT` | `running`, `stopped`, `error`, `deleted` |
| `resource_cpu_limit` | `INTEGER` | Millicores |
| `resource_memory_mb` | `INTEGER` | Memory limit in MiB |
| `catalog_image_id` | `UUID` | Which catalog image version is deployed |
| `created_in_region` | `TEXT` | Immutable |
| `updated_at` | `TIMESTAMPTZ` | Last modification timestamp |
| `version_number` | `BIGINT` | Write counter |

**Conflict Resolution Rules:**

| Column | Conflict Rule | Logic |
|---|---|---|
| `app_type` | Immutable (no change) | Cannot change app type once created |
| `status` | Stop wins (conservative) | If error detected in one region, stop in all |
| `resource_cpu_limit` | Maximum wins | More resources are better |
| `resource_memory_mb` | Maximum wins | More resources are better |

```sql
CREATE OR REPLACE FUNCTION resolve_websites_conflict()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'deleted' THEN RETURN OLD; END IF;
  IF NEW.status = 'deleted' THEN RETURN NEW; END IF;
  IF NEW.updated_at < OLD.updated_at THEN RETURN OLD; END IF;

  -- app_type is immutable — always keep original value
  NEW.app_type := OLD.app_type;

  -- status: error/stopped wins (conservative)
  IF OLD.status IN ('error', 'stopped') AND NEW.status = 'running' THEN
    NEW.status := OLD.status;
  END IF;

  -- resource limits: maximum wins
  NEW.resource_cpu_limit  := GREATEST(OLD.resource_cpu_limit,  NEW.resource_cpu_limit);
  NEW.resource_memory_mb  := GREATEST(OLD.resource_memory_mb,  NEW.resource_memory_mb);

  NEW.version_number := OLD.version_number + 1;
  INSERT INTO conflict_log VALUES ('websites', OLD.id::TEXT, OLD.version_number, NEW.version_number, NOW(), 'merged');
  RETURN NEW;
END;
$$;

CREATE TRIGGER websites_conflict_resolution
  BEFORE UPDATE ON websites
  FOR EACH ROW
  EXECUTE FUNCTION resolve_websites_conflict();
```

---

### Table 6: `backups`

**Purpose:** Backup metadata (Velero snapshots, file backups)

**Columns:**

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID` | Primary key (UUID v4, globally unique) |
| `client_id` | `UUID` | References `clients.id` |
| `backup_type` | `TEXT` | `files`, `database`, `email`, `full` |
| `status` | `TEXT` | `running`, `complete`, `failed` |
| `size_bytes` | `BIGINT` | Backup archive size |
| `storage_path` | `TEXT` | Path on SFTP/S3 backup server |
| `created_at` | `TIMESTAMPTZ` | When backup started |
| `completed_at` | `TIMESTAMPTZ` | When backup finished |
| `created_in_region` | `TEXT` | Region where backup job ran |

**Conflict Resolution Rules:**

| Column | Conflict Rule | Logic |
|---|---|---|
| (All columns) | Immutable (no conflict) | Backups are write-once; never updated after creation |

**Important:** Backups are stored in region where created + replicated to all other regions daily (eventual consistency is OK).

---

### Table 7: `audit_log`

**Purpose:** Track all operations for compliance

**Columns:**

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID` | Primary key (UUID v7 — time-ordered for natural sort) |
| `event_type` | `TEXT` | Event code (e.g. `CLIENT_CREATED`, `DOMAIN_DELETED`) |
| `actor_id` | `UUID` | Admin or client who performed the action |
| `actor_type` | `TEXT` | `admin`, `client`, `system` |
| `client_id` | `UUID` | Affected client (nullable for platform-level events) |
| `resource_type` | `TEXT` | `client`, `domain`, `email`, `database`, `backup`, etc. |
| `resource_id` | `UUID` | ID of the affected resource |
| `payload` | `JSONB` | Before/after snapshot of changed fields |
| `region` | `TEXT` | Region where the event occurred |
| `created_at` | `TIMESTAMPTZ` | Event timestamp (UTC) |

**Conflict Resolution Rules:**

| Column | Conflict Rule | Logic |
|---|---|---|
| (All columns) | Immutable (append-only) | Audit log is append-only; never updated |

**Important:** Audit log entries are created locally in each region, then replicated. Order may differ between regions, but all entries eventually appear everywhere.

---

### Table 8: `billing_invoices`

**Purpose:** Customer invoices (critical for money!)

**Columns:**

| Column | Type | Description |
|--------|------|-------------|
| `id` | `UUID` | Primary key |
| `client_id` | `UUID` | References `clients.id` |
| `amount_usd` | `NUMERIC(10,2)` | Invoice total |
| `status` | `TEXT` | `draft`, `sent`, `paid`, `overdue`, `cancelled` |
| `due_at` | `TIMESTAMPTZ` | Payment due date |
| `paid_at` | `TIMESTAMPTZ` | When payment was received (null if unpaid) |
| `external_ref` | `TEXT` | Reference ID from external billing system |
| `created_at` | `TIMESTAMPTZ` | Invoice creation timestamp |
| `updated_at` | `TIMESTAMPTZ` | Last modification timestamp |
| `created_in_region` | `TEXT` | Region that created the invoice (master for billing = Frankfurt) |
| `version_number` | `BIGINT` | Write counter |

**Conflict Resolution Rules:**

| Column | Conflict Rule | Logic |
|---|---|---|
| `amount_usd` | Last-write-wins (immutable) | Amount should not change once invoiced |
| `status` | Sequence-based: `draft → sent → paid → overdue` | Only allow forward transitions |

**Status Transition Logic:**

Invoice status can only move forward in the sequence `draft → sent → paid → overdue → cancelled`. A conflict where one region advances status and another tries to regress it is resolved by always taking the further-advanced status.

```sql
CREATE OR REPLACE FUNCTION resolve_billing_invoices_conflict()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE
  -- Lower index = earlier state; higher index = later state
  status_order TEXT[] := ARRAY['draft', 'sent', 'paid', 'overdue', 'cancelled'];
  old_idx INT;
  new_idx INT;
BEGIN
  -- Reject stale writes (billing is single-writer: Frankfurt only; this is a safety net)
  IF NEW.updated_at < OLD.updated_at THEN RETURN OLD; END IF;

  -- status: always advance, never regress
  old_idx := array_position(status_order, OLD.status);
  new_idx := array_position(status_order, NEW.status);
  IF old_idx > new_idx THEN
    NEW.status := OLD.status; -- keep further-advanced status
    NEW.paid_at := OLD.paid_at;
  END IF;

  -- amount_usd: once sent, amount is immutable
  IF OLD.status != 'draft' THEN
    NEW.amount_usd := OLD.amount_usd;
  END IF;

  NEW.version_number := OLD.version_number + 1;
  INSERT INTO conflict_log VALUES ('billing_invoices', OLD.id::TEXT, OLD.version_number, NEW.version_number, NOW(), 'status_forwarded');
  RETURN NEW;
END;
$$;

CREATE TRIGGER billing_invoices_conflict_resolution
  BEFORE UPDATE ON billing_invoices
  FOR EACH ROW
  EXECUTE FUNCTION resolve_billing_invoices_conflict();
```

---

## Conflict Detection & Logging

### Every Write Must Check for Conflicts

The `conflict_log` table records every triggered conflict resolution for audit and monitoring:

```sql
-- migrations/conflict_resolution/conflict_log.sql
CREATE TABLE IF NOT EXISTS conflict_log (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  table_name     TEXT        NOT NULL,
  record_id      TEXT        NOT NULL,
  local_version  BIGINT      NOT NULL,
  remote_version BIGINT      NOT NULL,
  resolved_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolution     TEXT        NOT NULL,  -- 'merged', 'local_kept', 'remote_accepted', 'status_forwarded'
  details        JSONB                  -- optional: which fields were overridden
);

CREATE INDEX conflict_log_table_record_idx ON conflict_log (table_name, record_id);
CREATE INDEX conflict_log_resolved_at_idx  ON conflict_log (resolved_at DESC);
```

The management API exposes `GET /api/v1/admin/monitoring/conflict-log?from=...&to=...&table=...` to allow admins to inspect recent conflicts in the admin panel.

### Monitoring Conflicts

Track conflict frequency to identify problems:

```promql
# Prometheus metric: conflict resolutions per minute (via Postgres exporter)
# Custom query in postgres_exporter queries.yaml:
#   SELECT table_name, count(*) AS conflicts
#   FROM conflict_log
#   WHERE resolved_at > NOW() - INTERVAL '5 minutes'
#   GROUP BY table_name

# Alert: conflict rate spike — may indicate a network partition or replication misconfiguration
- alert: HighConflictRate
  expr: sum(rate(pg_conflict_log_total[5m])) > 10
  for: 2m
  labels:
    severity: warning
  annotations:
    summary: "High multi-master conflict rate ({{ $value }}/min)"
    description: "Check replication lag and network connectivity between regions."
```

---

## Test Cases for Conflict Resolution

**GitHub:** `backend/tests/integration/conflict-resolution.test.ts`

Key test scenarios:

| Test | Scenario | Expected outcome |
|------|----------|-----------------|
| `clients.plan_id upgrade vs downgrade` | Frankfurt: Business → Premium; OVH: Business → Starter simultaneously | Premium wins everywhere |
| `clients.status suspend vs unsuspend` | Frankfurt: suspended; OVH: active | Stays suspended everywhere |
| `domains delete vs update` | Frankfurt: deletes domain; OVH: updates ssl_cert_path | Domain stays deleted |
| `email_accounts forwarding merge` | Frankfurt adds `a@x.com`; OVH adds `b@x.com` | Both in `forwarding_addresses` |
| `websites resource limit max` | Frankfurt: cpu=1000m; OVH: cpu=2000m | cpu=2000m everywhere |
| `billing_invoices status regression` | Frankfurt: `paid`; OVH: `draft` | Stays `paid` |
| `stale write rejected` | OVH sends update with `updated_at` 30s in the past | Local version kept |
| `version_number increment` | Any successful write | version_number increases by 1 |

---

## Preventing Conflicts (Preferred Over Resolving)

The best conflict is one that never happens. Strategies:

### 1. Region-Scoped Operations (No Conflicts)

Operations that are scoped to a single region never produce cross-region conflicts:
- **Client workloads** run in one region only; the region's k3s cluster is the sole authority.
- **Backup jobs** run in one region and write to that region's storage; metadata is append-only.
- **Email accounts** are created in their home region; `created_in_region` is immutable.
- **Databases** are provisioned in one region; `created_in_region` is immutable.

For Phase 2 (warm standby), the primary region (Frankfurt) is the sole writer. The standby (OVH) only writes during failover, eliminating conflicts entirely until Phase 3.

### 2. Use Unique Constraints + Optimistic Locking

Every replicated table uses `version_number` for optimistic locking. The application layer increments `version_number` on every write:

```typescript
// backend/src/db/optimisticUpdate.ts
export async function updateClient(id: string, changes: Partial<Client>, expectedVersion: number) {
  const result = await db.query(
    `UPDATE clients SET name=$1, updated_at=NOW(), version_number=version_number+1
     WHERE id=$2 AND version_number=$3
     RETURNING version_number`,
    [changes.name, id, expectedVersion],
  )
  if (result.rowCount === 0) {
    throw new ConflictError('Concurrent write detected — please retry')
  }
  return result.rows[0]
}
```

The API returns `409 Conflict` to the caller, which retries with a fresh read. This prevents lost-update bugs entirely within a single region and reduces (but does not eliminate) the chance of cross-region conflicts.

### 3. Use Event Sourcing for Critical Data

For billing/invoices (critical for money):

Instead of updating a mutable row, each billing event is an immutable insert into an event log. The current invoice state is derived from the event sequence. This means there are no conflicting updates — only conflicting inserts, which are resolved by the ordering of `event_id` (UUID v7, time-ordered).

```sql
-- billing_events table (event-sourced; never updated)
CREATE TABLE billing_events (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID        NOT NULL REFERENCES billing_invoices(id),
  event_type TEXT        NOT NULL,  -- 'CREATED', 'SENT', 'PAID', 'OVERDUE', 'CANCELLED'
  amount_usd NUMERIC(10,2),
  actor_id   UUID,
  region     TEXT        NOT NULL,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- Invoice current state is: SELECT event_type FROM billing_events WHERE invoice_id=? ORDER BY occurred_at DESC LIMIT 1
```

---

## Monitoring & Alerting

**Setup Prometheus alerts** in `infrastructure/helm/monitoring/prometheus-rules.yaml`:

```yaml
# k8s/base/monitoring/prometheus/rules/conflict-resolution.yaml
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: conflict-resolution
  namespace: monitoring
spec:
  groups:
    - name: conflict-resolution
      interval: 60s
      rules:
        # Alert if more than 10 conflicts/minute across all tables
        - alert: HighConflictRate
          expr: |
            sum(rate(pg_custom_query_conflict_log_total[5m])) > 10
          for: 2m
          labels:
            severity: warning
          annotations:
            summary: "High DB conflict resolution rate"
            description: "More than 10 conflicts/min — check replication lag between regions."

        # Alert if clients.plan_id conflicts are happening (possible billing impact)
        - alert: PlanIdConflicts
          expr: |
            sum(rate(pg_custom_query_conflict_log_clients[5m])) > 1
          for: 5m
          labels:
            severity: critical
          annotations:
            summary: "Plan ID conflicts detected on clients table"
            description: "Two regions assigned different plans to the same client. Investigate immediately."

        # Alert if replication lag exceeds 60 seconds
        - alert: ReplicationLagHigh
          expr: |
            pg_stat_replication_replay_lag_seconds > 60
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "pglogical replication lag > 60s"
            description: "Cross-region replication is lagging. Conflict risk is elevated."
```

The admin panel's **Monitoring → Conflict Log** page queries:

```http
GET /api/v1/admin/monitoring/conflict-log?table=clients&from=2026-03-01&limit=50
```

Response includes: `table_name`, `record_id`, `local_version`, `remote_version`, `resolved_at`, `resolution`, with pagination.

---

## Summary

**Conflict Resolution Hierarchy:**

1. **Immutable** (no updates allowed): backups, audit_log, website.app_type
2. **Delete wins** (deletion is final): domains, clients (if deleted)
3. **Highest priority wins** (business logic): plan_id, status_enum
4. **Maximum wins** (user-friendly): resource limits, quota
5. **Last-write-wins** (most fields): name, email, password
6. **Merge** (combine): forwarding_addresses, tags
7. **Earliest wins** (safety): ssl_verified_at, dns_verified_at

**Golden Rule:** When in doubt, **safer option wins** (e.g., suspended over active, deleted over modified).

This ensures data integrity and prevents money/access-related mistakes.

