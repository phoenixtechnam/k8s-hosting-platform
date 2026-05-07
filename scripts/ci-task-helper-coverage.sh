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
)

# Add path-globs of files that the lint will report when newly created
# under a long-running module — operator must add them to SURFACE_FILE_MARKERS
# OR justify with a SKIP entry. Phase 1B keeps this conservative; Phase 2
# expands to system-backup, postgres-restore, mail-rotation, etc.
SKIP=(
  # system-backup — Phase 2 wiring deferred
  # postgres-restore — Phase 2 wiring deferred
  # restore-cart — Phase 2 wiring deferred
  # mail rotation — Phase 4 wiring deferred (see TASK_TRACKER.md when added)
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
