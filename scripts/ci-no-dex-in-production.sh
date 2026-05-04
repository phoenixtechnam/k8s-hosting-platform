#!/usr/bin/env bash
# ci-no-dex-in-production.sh — guard that Dex is never deployed in production.
#
# Dex is a developer/staging-only OIDC issuer with static-password test
# users hard-coded into config.yaml (admin@k8s-platform.test / admin,
# user@k8s-platform.test / user). Shipping it in production would
# expose those credentials AND surface a public OIDC issuer no real
# tenant should be relying on.
#
# Two invariants:
#   1. The rendered production overlay (`kubectl kustomize k8s/overlays/production`)
#      must NOT contain any object whose name == "dex" or whose labels
#      include `app=dex` / `app.kubernetes.io/name=dex`.
#   2. There must NOT be a `k8s/overlays/production/dex/` directory or
#      a `dex/` reference in `k8s/overlays/production/kustomization.yaml`.
#
# Per memory `project_dex_deployment_scope.md` — Dex is dev/staging only,
# never production.
#
# Exits non-zero on any violation.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROD_OVERLAY="$REPO_ROOT/k8s/overlays/production"

if [[ ! -d "$PROD_OVERLAY" ]]; then
  echo "ci-no-dex-in-production: $PROD_OVERLAY missing" >&2
  exit 1
fi

failures=0

# Invariant 2 (cheap): no dex/ subdir + no dex reference in kustomization.
if [[ -d "$PROD_OVERLAY/dex" ]]; then
  echo "✗ k8s/overlays/production/dex/ exists — Dex must not ship in production" >&2
  failures=$((failures + 1))
fi

if [[ -f "$PROD_OVERLAY/kustomization.yaml" ]]; then
  if grep -qE '^[[:space:]]*-[[:space:]]*dex/?[[:space:]]*$' "$PROD_OVERLAY/kustomization.yaml"; then
    echo "✗ k8s/overlays/production/kustomization.yaml references 'dex' as a resource" >&2
    failures=$((failures + 1))
  fi
fi

# Invariant 1 (authoritative): render the overlay and grep the result.
# This catches the case where a base/ component or a transitive include
# pulls Dex in even when the production overlay file itself looks clean.
RENDERED=$(mktemp)
trap 'rm -f "$RENDERED"' EXIT

if ! kubectl kustomize "$PROD_OVERLAY" > "$RENDERED" 2>/dev/null; then
  # Fallback: try kustomize binary directly if kubectl-embedded version misbehaves.
  if command -v kustomize >/dev/null 2>&1; then
    kustomize build "$PROD_OVERLAY" > "$RENDERED"
  else
    echo "ci-no-dex-in-production: failed to render production overlay (need kubectl or kustomize)" >&2
    exit 2
  fi
fi

# Match any object named exactly "dex" or labelled app=dex.
# yq is preferred (precise) but optional; fall back to a tolerant grep.
if command -v yq >/dev/null 2>&1; then
  hits=$(yq eval-all '
    [select(.metadata.name == "dex"
        or (.metadata.labels // {})."app" == "dex"
        or (.metadata.labels // {})."app.kubernetes.io/name" == "dex"
        or (.spec.selector.matchLabels // {})."app" == "dex")
     | .kind + "/" + (.metadata.name // "?") + " (ns=" + (.metadata.namespace // "-") + ")"]
    | .[]
  ' "$RENDERED" 2>/dev/null || true)
  if [[ -n "$hits" ]]; then
    echo "✗ Production overlay renders Dex resources:" >&2
    echo "$hits" | sed 's/^/    /' >&2
    failures=$((failures + 1))
  fi
else
  # Fallback: literal grep. Less precise but always available.
  if grep -qE '^[[:space:]]*name:[[:space:]]*dex[[:space:]]*$' "$RENDERED" \
     || grep -qE '^[[:space:]]*app:[[:space:]]*dex[[:space:]]*$' "$RENDERED"; then
    echo "✗ Production overlay rendered output contains Dex name/label" >&2
    grep -nE '^[[:space:]]*(name|app):[[:space:]]*dex[[:space:]]*$' "$RENDERED" | head -10 | sed 's/^/    /' >&2
    failures=$((failures + 1))
  fi
fi

if [[ "$failures" -gt 0 ]]; then
  echo "" >&2
  echo "Dex is dev/staging only — never production." >&2
  echo "See docs memory: project_dex_deployment_scope.md" >&2
  exit 1
fi

echo "✓ Production overlay does not deploy Dex"
