#!/usr/bin/env bash
set -euo pipefail

# ci-task-helper-coverage.sh — fail CI when a known long-running surface
# does not call the Task Tracker helper (`tasks.start` / `tracked()` /
# `mirrorOpToTaskTracker` / `createBulkParentTask`).
#
# The Task Tracker helper is the only sanctioned writer for the `tasks`
# table. Every long-running surface (per-client lifecycle transitions,
# bulk lifecycle ops, storage operations, system-backup runs, postgres
# PITR, DNS verification, mail rotation, restore-cart) MUST register
# itself via the helper so the chip lights up. Forgetting to register
# is the HIGH-risk failure mode flagged in the Phase 1 plan.
#
# Strategy
# ────────
# Maintain a SURFACES list mapping a "surface name" → (path glob,
# required marker substring). For each entry, find the file and assert
# that at least one of the markers is present. If none, fail with a
# pointer to the helper module.
#
# Tolerance: surfaces under active development (or intentionally not
# in the chip) can be added to the SKIP list at the bottom. Don't grow
# the SKIP list silently — every entry needs a one-line rationale.

SURFACE_FILE_MARKERS=(
  # client-lifecycle transitions (admin + bulk + per-client)
  "backend/src/modules/client-lifecycle/registry/dispatcher.ts|tasks/service.js"
  # bulk client ops parent fan-out
  "backend/src/modules/clients/bulk.ts|createBulkParentTask"
  # storage ops
  "backend/src/modules/storage-lifecycle/service.ts|mirrorOpToTaskTracker"
  # Phase 2 surfaces (2026-05-03):
  # system-backup runs (admin secrets bundle export)
  "backend/src/modules/system-backup/service.ts|mirrorRunToTaskTracker"
  # tenant bundle creation (per-client backup)
  "backend/src/modules/tenant-bundles/orchestrator.ts|tasks/service.js"
  # postgres PITR start
  "backend/src/modules/postgres-restore/routes.ts|tasks/service.js"
  # postgres PITR finalize
  "backend/src/modules/postgres-restore/service.ts|tasks"
  # restore-cart execute
  "backend/src/modules/backup-restore/routes.ts|tasks/service.js"
  # cache purge
  "backend/src/modules/storage/routes.ts|tracked"
  # DNS verify (per-client domain verify)
  "backend/src/modules/domains/routes.ts|tracked"
  # Mail admin password rotation (Stalwart JMAP)
  "backend/src/modules/mail-admin/routes.ts|tasks/service.js"
  # Phase 4 surface (2026-05-08):
  # Client provisioning + decommission (provisioning_tasks → tasks chip)
  "backend/src/modules/k8s-provisioner/service.ts|mirrorProvisioningToTaskTracker"
)

# Add path-globs of files that the lint will report when newly created
# under a long-running module — operator must add them to SURFACE_FILE_MARKERS
# OR justify with a SKIP entry. Phase 2 covers most surfaces; future phases
# will add: bulk DNS verify, future webmail-master rotation chip, etc.
SKIP=(
  # webmail-master rotation — short-running variant of mail.rotate; reuses
  # admin chip via the JMAP rotation, not separately enrolled.
)

ROOT="${1:-.}"
FAIL=0

for spec in "${SURFACE_FILE_MARKERS[@]}"; do
  file="${spec%%|*}"
  marker="${spec##*|}"
  full="${ROOT}/${file}"
  if [ ! -f "$full" ]; then
    echo "❌ ci-task-helper-coverage: surface file not found: $file"
    FAIL=1
    continue
  fi
  if ! grep -qF "$marker" "$full"; then
    echo "❌ ci-task-helper-coverage: $file is missing the Task Tracker hook ('$marker' not found)."
    echo "   Long-running surfaces must register via backend/src/modules/tasks/service.ts"
    echo "   so the top-bar chip lights up. See docs/04-deployment/TASK_TRACKER.md"
    echo "   (Phase 1B) for the wiring pattern."
    FAIL=1
  fi
done

if [ $FAIL -ne 0 ]; then
  exit 1
fi

echo "✅ ci-task-helper-coverage: all ${#SURFACE_FILE_MARKERS[@]} known long-running surface(s) call the helper."
