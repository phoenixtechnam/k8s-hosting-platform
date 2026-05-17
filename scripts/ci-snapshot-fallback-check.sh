#!/usr/bin/env bash
#
# CI guard for the snapshot-storage overhaul (Phase 5):
#
#   1. The retired `hostpath-snapshot-cronjob.yaml` must NOT be
#      re-introduced into any kustomization.yaml resources list.
#      Streaming Phase-4 Jobs upload directly to the assigned target;
#      a second cron-based copy creates double-uploads + cost.
#
#   2. The dev-only fallback `STORAGE_SNAPSHOT_ALLOW_HOSTPATH_DEV=true`
#      env var must NOT appear in any production/staging overlay.
#      Phase 4's streaming path is the only production-supported route;
#      hostpath fallback exists for local DinD only.
#
# Exits non-zero on violation. Wired into the Infrastructure CI workflow.

set -euo pipefail

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

FAILED=0

# ─── Check 1: hostpath cronjob not in any kustomization resource list ──

echo "▸ Checking that hostpath-snapshot-cronjob is not referenced as an active resource..."

VIOLATIONS=$(grep -rln "^[^#]*hostpath-snapshot-cronjob" "${PROJECT_DIR}/k8s/" 2>/dev/null || true)
if [ -n "$VIOLATIONS" ]; then
  echo "  ✗ hostpath-snapshot-cronjob.yaml is referenced as an active resource in:"
  echo "$VIOLATIONS" | sed 's/^/    /'
  echo "    → Comment out the resource line. Phase 4 streaming Jobs replace the cron."
  FAILED=1
else
  echo "  ✓ no active references found"
fi

# ─── Check 2: hostpath-dev fallback flag not in production overlays ────

echo "▸ Checking that STORAGE_SNAPSHOT_ALLOW_HOSTPATH_DEV is not in prod/staging overlays..."

# Search every overlay that isn't `dev` (which is the only legitimate
# consumer of the dev fallback). The `local` overlay is dev-equivalent.
for overlay_dir in "${PROJECT_DIR}/k8s/overlays"/*/; do
  overlay_name=$(basename "$overlay_dir")
  case "$overlay_name" in
    dev|local) continue ;;
  esac
  HITS=$(grep -rln "STORAGE_SNAPSHOT_ALLOW_HOSTPATH_DEV.*true" "$overlay_dir" 2>/dev/null || true)
  if [ -n "$HITS" ]; then
    echo "  ✗ STORAGE_SNAPSHOT_ALLOW_HOSTPATH_DEV=true in overlay '$overlay_name':"
    echo "$HITS" | sed 's/^/    /'
    echo "    → Remove the env var. Production must route via assigned snapshot classes."
    FAILED=1
  fi
done

if [ "$FAILED" = "0" ]; then
  echo "  ✓ no fallback flags in non-dev overlays"
fi

# ─── Summary ────────────────────────────────────────────────────────────

if [ "$FAILED" = "0" ]; then
  echo
  echo "✓ ci-snapshot-fallback-check passed"
  exit 0
else
  echo
  echo "✗ ci-snapshot-fallback-check FAILED — see above"
  exit 1
fi
