#!/usr/bin/env bash
# ci-mail-arch-regressions.sh — fail CI on mail-architecture regressions
# that were intentionally retired in the Phase 1+2 streamline (2026-05-15).
#
# Background. The mail subsystem accumulated 45+ PRs of patches around
# the Flux/platform-api SSA war (rsync-based migration cutover) and the
# thisNodeOnly-default port-exposure mode. Both were retired:
#
#   • Phase 1 — migration uses snapshot+restore on a stable PVC name.
#     The rsync Job, the applyRaw cutover (force:true SSA workaround),
#     the parallel-PVC scheme, and the SSH known-hosts ConfigMap are
#     all gone. If they sneak back, this probe goes red.
#
#   • Phase 2 — mailPortExposureMode column default flipped to
#     'allServerNodes'. 'thisNodeOnly' remains supported via the admin
#     API for debugging but must NOT be the default in the schema or
#     in fallback code paths.
#
# Acceptable false-positives: doc strings explaining migration history
# can use `# ci-mail-arch: ignore` on the line.
#
# This probe is paired with ci-no-longhorn-in-mail.sh and runs in the
# same CI stages.

set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Lines that need an "ignore" pragma to pass.
IGNORE_PRAGMA='ci-mail-arch: ignore'

FAILED=0

# ── Check 1: no rsync Job orchestration in mail-admin/migration.ts ────
# The Phase 1 streamline replaced rsync-based migration with snapshot+
# restore. If any of these symbols come back, the architecture is at
# risk of re-introducing the Flux SSA war.
echo "=== Check 1: rsync-Job orchestration must not return to migration.ts ==="
MIG_FILE="backend/src/modules/mail-admin/migration.ts"
if [ -f "$MIG_FILE" ]; then
  BANNED_SYMBOLS=(
    'spawnRsyncJob'
    'stalwart-migration-ssh-key'
    'stalwart-migration-known-hosts'
    'MIGRATION_CUTOVER_PATCH'
    'waitForLocalPathBinding'
    'stalwart-rocksdb-data-mig-'
  )
  for sym in "${BANNED_SYMBOLS[@]}"; do
    if grep -nE "$sym" "$MIG_FILE" | grep -v "$IGNORE_PRAGMA" > /tmp/mail-arch-hits.txt; then
      if [ -s /tmp/mail-arch-hits.txt ]; then
        echo "  ❌ migration.ts re-introduces '$sym':"
        cat /tmp/mail-arch-hits.txt | sed 's/^/    /'
        FAILED=1
      fi
    fi
  done
  if [ "$FAILED" -eq 0 ]; then
    echo "  ✅ no banned rsync symbols in migration.ts"
  fi
else
  echo "  ⚠️  $MIG_FILE not found — skipping"
fi

# ── Check 2: no Kustomize subdir for the deleted rsync support ───────
echo "=== Check 2: k8s/base/stalwart-mail/migration/ must stay deleted ==="
if [ -d k8s/base/stalwart-mail/migration ]; then
  echo "  ❌ k8s/base/stalwart-mail/migration/ exists — Phase 1 streamline removed this dir"
  FAILED=1
else
  echo "  ✅ migration/ subdir absent (as expected)"
fi

# ── Check 3: schema default is allServerNodes, not thisNodeOnly ──────
echo "=== Check 3: mail_port_exposure_mode default must be allServerNodes ==="
SCHEMA_FILE="backend/src/db/schema.ts"
if [ -f "$SCHEMA_FILE" ]; then
  if grep -nE "mailPortExposureMode.*default.*thisNodeOnly" "$SCHEMA_FILE" | grep -v "$IGNORE_PRAGMA" > /tmp/mail-arch-default.txt; then
    if [ -s /tmp/mail-arch-default.txt ]; then
      echo "  ❌ schema.ts still defaults mailPortExposureMode to thisNodeOnly:"
      cat /tmp/mail-arch-default.txt | sed 's/^/    /'
      FAILED=1
    fi
  fi
  if [ "$FAILED" -eq 0 ]; then
    echo "  ✅ schema.ts default for mailPortExposureMode is not thisNodeOnly"
  fi
fi

# ── Check 4: port-exposure fallback for missing DB row uses allServerNodes ──
echo "=== Check 4: port-exposure.ts fallback must use allServerNodes ==="
PE_FILE="backend/src/modules/mail-admin/port-exposure.ts"
if [ -f "$PE_FILE" ]; then
  # Match the `?? 'thisNodeOnly'` fallback that used to be in getMailPortExposure
  if grep -nE "\\?\\?\\s*['\"]thisNodeOnly['\"]" "$PE_FILE" | grep -v "$IGNORE_PRAGMA" > /tmp/mail-arch-fallback.txt; then
    if [ -s /tmp/mail-arch-fallback.txt ]; then
      echo "  ❌ port-exposure.ts has '?? thisNodeOnly' fallback:"
      cat /tmp/mail-arch-fallback.txt | sed 's/^/    /'
      FAILED=1
    fi
  fi
  if [ "$FAILED" -eq 0 ]; then
    echo "  ✅ port-exposure.ts fallback is allServerNodes"
  fi
fi

# ── Check 5: SSA-war annotations not on Stalwart Deployment ─────────
# kustomize.toolkit.fluxcd.io/ssa: merge made the war WORSE by silently
# enabling force-conflicts on Flux's apply. Must stay absent from this
# Deployment.
echo "=== Check 5: ssa:merge annotation not active on Stalwart Deployment ==="
DEP_FILE="k8s/base/stalwart-mail/stalwart/deployment.yaml"
if [ -f "$DEP_FILE" ]; then
  # Allow it in comments (lines starting with #), reject in active YAML.
  if grep -nE "^[^#]*kustomize\.toolkit\.fluxcd\.io/ssa:\s*merge" "$DEP_FILE" > /tmp/mail-arch-ssa.txt; then
    if [ -s /tmp/mail-arch-ssa.txt ]; then
      echo "  ❌ deployment.yaml has active ssa:merge annotation:"
      cat /tmp/mail-arch-ssa.txt | sed 's/^/    /'
      FAILED=1
    fi
  fi
  if [ "$FAILED" -eq 0 ]; then
    echo "  ✅ ssa:merge annotation absent from Stalwart Deployment"
  fi
fi

echo ""
if [ "$FAILED" -ne 0 ]; then
  echo "❌ ci-mail-arch-regressions: one or more checks failed."
  echo "   See above. To bypass a doc-string mention, add '# $IGNORE_PRAGMA' on the line."
  exit 1
fi

echo "✅ ci-mail-arch-regressions: no architectural regressions detected."
