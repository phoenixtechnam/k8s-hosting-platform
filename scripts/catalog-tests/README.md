# Catalog Local Verification Harness

Drives the platform admin API in the same way a customer would, deploys
each catalog entry into an ephemeral client namespace, asserts the per-type
readiness contract, and tears down. Real flow, real assertions — no mocks,
no endpoint-200 checks.

## Quick start

```bash
# 1. Make sure the local stack is up
./scripts/local.sh up

# 2. Run the small tier (24 entries, ~25-40 min total)
./scripts/integration-catalog-local.sh --tier=small

# Or one entry at a time during debugging
./scripts/integration-catalog-local.sh --entries=nginx-php

# Or every entry in tier order — small → medium → large
./scripts/integration-catalog-local.sh
```

Failure evidence lands at `/tmp/catalog-test-evidence/<entry>/` and the
markdown summary at `/tmp/catalog-test-report.md`.

## Files

| Path | Purpose |
|---|---|
| `scripts/integration-catalog-local.sh` | Entry point — argument parser, login, per-entry test loop, report writer |
| `scripts/catalog-tests/readiness.json` | Per-type defaults + per-entry overrides for readiness probes |
| `scripts/catalog-tests/fixtures/tier-filter.json` | Resource-aware tier classification (small / medium / large) |
| `scripts/catalog-tests/lib/api.sh` | Login + `api()` + `wait_for()` + `kctl()` |
| `scripts/catalog-tests/lib/probe.sh` | The five probe kinds — pod_ready_only, http_ingress, db_protocol, service_protocol, stun_probe |
| `scripts/catalog-tests/lib/cleanup.sh` | Tenant teardown + failure-evidence capture |

## Readiness contract

Each entry has a probe `kind` from `readiness.json`. Defaults are keyed by
`catalog_entry.type`; per-entry overrides land in `overrides.<code>`.

| Kind | What it asserts |
|---|---|
| `pod_ready_only` | All pods matching `app.kubernetes.io/instance=<deplname>` reach `Ready`. Used for runtimes (no app deployed; HTTP would 404) |
| `http_ingress` | Curl through the dev ingress (`https://localhost:2011` with Host header), response code in `[expect_code_min, expect_code_max]`. Used for applications + static |
| `db_protocol` | Engine-specific ping via `kubectl exec` — `mariadb-admin ping`, `pg_isready`, `mongosh ping` |
| `service_protocol` | `redis-cli PING`, memcached `version`, MinIO `/minio/health/ready` |
| `stun_probe` | Inline Python sends a STUN binding request to coturn's host port and checks the response message type is `0x0101` (success) |

## Adding an entry

1. Add the entry's code to the appropriate tier in `fixtures/tier-filter.json`
2. If the type-default readiness rule fits, you're done. Otherwise add an
   `overrides.<code>` block in `readiness.json` with the right `path` /
   `expect_code_min` / `kind`.

## Argument reference

```
--tier=small|medium|large    Run one tier (default: all tiers in order)
--entries=foo,bar,baz        Run an explicit comma-separated list
--keep                       Skip cleanup on failure (for triage)
--help                       Print usage
```

Env overrides (when running against a non-default local stack):

```
ADMIN_HOST           default http://admin.k8s-platform.test:2010
ADMIN_EMAIL          default admin@k8s-platform.test
ADMIN_PASSWORD       default admin
PORT_INGRESS_HTTPS   default 2011
K3S_CONTAINER        default hosting-platform-k3s-server-1
EVIDENCE_DIR         default /tmp/catalog-test-evidence
REPORT_FILE          default /tmp/catalog-test-report.md
```

## What's intentionally NOT covered

- Multi-node HA / drain / failover — staging cluster only
- Production-mode overlays — this harness is `dev`-only
- Backup/restore lifecycle of the deployed apps — `integration-pvc.sh` covers it
- Application-specific deep functional testing — readiness stops at "front
  page reachable, response not from the ingress default backend"
