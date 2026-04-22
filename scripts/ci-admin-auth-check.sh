#!/usr/bin/env bash
# Verify every Ingress labelled as an admin-only UI has an auth gate applied.
#
# For each overlay (dev, staging, production):
#   1. kustomize build
#   2. For every Ingress carrying label
#      `platform.phoenix-host.net/admin-ui: "true"`, require the annotation
#      `platform.phoenix-host.net/auth-gate` to be "cookie" or "oauth2".
#
# That annotation is written by either of the two components in
# k8s/components/admin-auth-gate-{cookie,oauth2}. If it's missing, the
# operator has labelled the ingress as admin-only but forgotten to add
# the `components:` entry that actually applies the auth_request — an
# accidental public-admin-UI regression.
#
# Exit 1 on any offending Ingress.

set -euo pipefail

OVERLAYS=(dev staging production)
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)

# yq picks up YAML stream semantics (documents separated by '---' in
# kustomize output). A single invocation per overlay keeps the tool count
# low — we print one TSV line per labelled Ingress with the gate value
# (or "MISSING"), then grep for the failure.
failures=0

for overlay in "${OVERLAYS[@]}"; do
  overlay_dir="$REPO_ROOT/k8s/overlays/$overlay"
  if [[ ! -d "$overlay_dir" ]]; then
    echo "skip: $overlay_dir not found"
    continue
  fi

  # kustomize might not be on $PATH in every CI image — fall back to
  # kubectl kustomize which is what the Infrastructure CI job already uses.
  if command -v kustomize >/dev/null 2>&1; then
    built=$(kustomize build "$overlay_dir")
  else
    built=$(kubectl kustomize "$overlay_dir")
  fi

  # Walk every Ingress with the admin-ui label. yq emits one line per
  # match in the form "<name>|<gate>". "MISSING" = annotation not set.
  # Using "|" instead of tab — yq string concatenation emits the literal
  # "\t" when requested, so a simple single-char delimiter is safer.
  mapfile -t rows < <(
    echo "$built" | yq eval-all --no-doc '
      select(.kind == "Ingress"
        and (.metadata.labels // {})["platform.phoenix-host.net/admin-ui"] == "true")
      | .metadata.name + "|" + ((.metadata.annotations // {})["platform.phoenix-host.net/auth-gate"] // "MISSING")
    ' -
  )

  for row in "${rows[@]}"; do
    [[ -z "$row" ]] && continue
    name="${row%%|*}"
    gate="${row#*|}"
    case "$gate" in
      cookie|oauth2)
        echo "ok  [$overlay] Ingress/$name → auth-gate=$gate"
        ;;
      *)
        echo "FAIL [$overlay] Ingress/$name labelled admin-ui=true but no auth-gate applied (value: $gate)"
        failures=$((failures + 1))
        ;;
    esac
  done
done

if (( failures > 0 )); then
  echo
  echo "✗ $failures admin-only Ingress(es) missing auth gate."
  echo "  Add one of the following to the overlay's kustomization.yaml:"
  echo "    components:"
  echo "      - ../../components/admin-auth-gate-cookie"
  echo "      - ../../components/admin-auth-gate-oauth2"
  exit 1
fi

echo "✓ All admin-only Ingresses have an auth gate applied."
