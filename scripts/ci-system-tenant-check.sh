#!/usr/bin/env bash
# ci-system-tenant-check.sh — guard against regressions in the SYSTEM
# tenant protection invariants (ADR-040).
#
# Three checks:
#   1. `subscriptions/expiry-checker.ts` MUST contain `eq(tenants.isSystem, false)`
#      in the candidate query. Without this filter, an operator who
#      hand-writes a past `subscription_expires_at` on SYSTEM via
#      direct SQL would see the auto-suspend cron flip SYSTEM to
#      suspended on the next tick.
#   2. `storage-lifecycle/scheduler.ts` MUST contain `eq(tenants.isSystem, false)`
#      filters on BOTH the auto-archive query (`status='suspended'`)
#      and the auto-delete query (`status='archived'`). Same reasoning
#      as (1) — defense in depth against direct SQL writes that would
#      otherwise let the cron pick up SYSTEM.
#   3. `backend/src/db/migrations/0008_system_tenant.sql` MUST contain
#      the partial unique index `tenants_only_one_system_idx`. This is
#      the DB-level "at most one SYSTEM row" enforcement — its accidental
#      removal in a future migration would let a buggy code path create
#      a second SYSTEM row.
#
# Exits non-zero on any missing invariant. Reference: ADR-040.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
EXPIRY="$REPO_ROOT/backend/src/modules/subscriptions/expiry-checker.ts"
SCHED="$REPO_ROOT/backend/src/modules/storage-lifecycle/scheduler.ts"
MIGRATION="$REPO_ROOT/backend/src/db/migrations/0008_system_tenant.sql"

fail() {
  echo "ci-system-tenant-check: FAIL — $1" >&2
  exit 1
}

[[ -f "$EXPIRY" ]] || fail "$EXPIRY not found"
[[ -f "$SCHED" ]] || fail "$SCHED not found"
[[ -f "$MIGRATION" ]] || fail "$MIGRATION not found"

# (1) expiry-checker filter
if ! grep -q "eq(tenants.isSystem, false)" "$EXPIRY"; then
  fail "subscriptions/expiry-checker.ts is missing 'eq(tenants.isSystem, false)' (ADR-040 §3.5)"
fi

# (2) auto-archive + auto-delete filters in the scheduler. We require
# the filter to appear at least TWICE in this file — once per query.
sched_hits=$(grep -c "eq(tenants.isSystem, false)" "$SCHED")
if [[ "$sched_hits" -lt 2 ]]; then
  fail "storage-lifecycle/scheduler.ts has only $sched_hits 'eq(tenants.isSystem, false)' filter(s); expected ≥2 (auto-archive + auto-delete queries)"
fi

# (3) migration index
if ! grep -q "tenants_only_one_system_idx" "$MIGRATION"; then
  fail "migration 0008 is missing the partial unique index 'tenants_only_one_system_idx'"
fi
if ! grep -q "WHERE.*is_system.*=.*TRUE" "$MIGRATION"; then
  fail "migration 0008 partial unique index is missing the 'WHERE is_system = TRUE' qualifier"
fi

echo "ci-system-tenant-check: OK (ADR-040 invariants intact)"
