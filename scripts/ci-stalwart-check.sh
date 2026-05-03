#!/usr/bin/env bash
# CI guard for Stalwart deployment hygiene.
#
# Fails if:
#   1. A cert-reload CronJob still exists in any overlay's rendered output.
#      (Regression guard: the old CronJob was replaced by Stakater Reloader.)
#   2. The stalwart-mail StatefulSet is missing the
#      `secret.reloader.stakater.com/reload` annotation in any overlay.
#      (Ensures Reloader is actually wired to trigger cert-driven restarts.)
#
# Exit 0 — all overlays clean.
# Exit 1 — at least one violation found; details printed to stderr.

set -euo pipefail

OVERLAYS=(dev staging production)
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)

failures=0

for overlay in "${OVERLAYS[@]}"; do
  overlay_dir="$REPO_ROOT/k8s/overlays/$overlay"
  if [[ ! -d "$overlay_dir" ]]; then
    echo "skip: $overlay_dir not found"
    continue
  fi

  if command -v kustomize >/dev/null 2>&1; then
    built=$(kustomize build "$overlay_dir" 2>/dev/null)
  else
    built=$(kubectl kustomize "$overlay_dir" 2>/dev/null)
  fi

  # ── Check 1: no cert-reload CronJob ──────────────────────────────────────
  if echo "$built" | grep -q 'stalwart-cert-reload'; then
    echo "ERROR [$overlay]: stalwart-cert-reload CronJob (or reference) still present." >&2
    echo "       Remove cert-reload-cronjob.yaml and its kustomization entry." >&2
    failures=$((failures + 1))
  fi

  # ── Check 2: StatefulSet has the Reloader annotation ─────────────────────
  if ! echo "$built" | python3 - <<'PYEOF'
import sys, yaml
docs = list(yaml.safe_load_all(sys.stdin))
for doc in docs:
    if doc and doc.get('kind') == 'StatefulSet':
        name = (doc.get('metadata') or {}).get('name', '')
        if 'stalwart-mail' in name:
            ann = (doc.get('metadata') or {}).get('annotations') or {}
            if 'secret.reloader.stakater.com/reload' in ann:
                sys.exit(0)
            print(f"stalwart-mail StatefulSet missing secret.reloader.stakater.com/reload annotation", file=sys.stderr)
            sys.exit(1)
# StatefulSet not found — skip (overlay may not include stalwart)
sys.exit(0)
PYEOF
  then
    echo "ERROR [$overlay]: stalwart-mail StatefulSet is missing the Reloader annotation." >&2
    echo "       Add to metadata.annotations:" >&2
    echo "         secret.reloader.stakater.com/reload: \"<tls-secret>,stalwart-secrets\"" >&2
    failures=$((failures + 1))
  fi

  echo "ok: $overlay"
done

if (( failures > 0 )); then
  echo "ci-stalwart-check: $failures violation(s) found" >&2
  exit 1
fi

echo "ci-stalwart-check: all overlays clean"
