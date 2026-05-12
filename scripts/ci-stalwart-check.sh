#!/usr/bin/env bash
# CI guard for Stalwart deployment hygiene.
#
# Fails if:
#   1. A cert-reload CronJob still exists in any overlay's rendered output.
#      (Regression guard: the old CronJob was replaced by Stakater Reloader.)
#   2. The stalwart-mail Deployment is missing the
#      `secret.reloader.stakater.com/reload` annotation in any overlay
#      that includes the stalwart-mail base.
#      (Ensures Reloader is wired to trigger cert + DB-credential restarts.)
#
# Cut 3 (2026-05-04): updated from the v015 StatefulSet to the v016
# Deployment. Also fixed SC2259 — the previous version piped `$built`
# into `python3 - <<HEREDOC`, but the heredoc redirection won over the
# pipe and python read an empty stdin, so the check silently always
# passed. Now we write to a tempfile and pass the path explicitly.
#
# Exit 0 — all overlays clean.
# Exit 1 — at least one violation found; details printed to stderr.

set -euo pipefail

OVERLAYS=(dev staging production)
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)

failures=0
tmpdir=$(mktemp -d -t ci-stalwart-check.XXXXXX)
trap 'rm -rf "$tmpdir"' EXIT

for overlay in "${OVERLAYS[@]}"; do
  overlay_dir="$REPO_ROOT/k8s/overlays/$overlay"
  if [[ ! -d "$overlay_dir" ]]; then
    echo "skip: $overlay_dir not found"
    continue
  fi

  built_file="$tmpdir/$overlay.yaml"
  if command -v kustomize >/dev/null 2>&1; then
    kustomize build "$overlay_dir" > "$built_file" 2>/dev/null
  else
    kubectl kustomize "$overlay_dir" > "$built_file" 2>/dev/null
  fi

  # ── Check 1: no cert-reload CronJob ──────────────────────────────────────
  if grep -q 'stalwart-cert-reload' "$built_file"; then
    echo "ERROR [$overlay]: stalwart-cert-reload CronJob (or reference) still present." >&2
    echo "       Remove cert-reload-cronjob.yaml and its kustomization entry." >&2
    failures=$((failures + 1))
  fi

  # ── Check 2: v016 Deployment carries the Reloader annotation ────────────
  # Pass the rendered YAML to python3 as an argv-1 file path so heredoc
  # stdin and pipe input don't collide (SC2259).
  if ! python3 - "$built_file" <<'PYEOF'
import sys, yaml
with open(sys.argv[1]) as f:
    docs = list(yaml.safe_load_all(f))
for doc in docs:
    if doc and doc.get('kind') == 'Deployment':
        name = (doc.get('metadata') or {}).get('name', '')
        if name == 'stalwart-mail':
            ann = (doc.get('metadata') or {}).get('annotations') or {}
            if 'secret.reloader.stakater.com/reload' in ann:
                sys.exit(0)
            print('stalwart-mail Deployment missing secret.reloader.stakater.com/reload annotation', file=sys.stderr)
            sys.exit(1)
# Deployment not found — skip (overlay may not include stalwart-mail)
sys.exit(0)
PYEOF
  then
    echo "ERROR [$overlay]: stalwart-mail Deployment is missing the Reloader annotation." >&2
    echo "       Add to metadata.annotations:" >&2
    echo "         secret.reloader.stakater.com/reload: \"stalwart-admin-creds,stalwart-snapshot-restic-repo\"" >&2
    failures=$((failures + 1))
  fi

  echo "ok: $overlay"
done

if (( failures > 0 )); then
  echo "ci-stalwart-check: $failures violation(s) found" >&2
  exit 1
fi

echo "ci-stalwart-check: all overlays clean"
