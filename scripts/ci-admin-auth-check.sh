#!/usr/bin/env bash
# Verify every IngressRoute labelled as an admin-only UI has an auth gate
# wired up.
#
# In the Traefik model the contract is:
#   - Every IngressRoute carrying label
#     `platform.phoenix-host.net/admin-ui: "true"` must reference the
#     Middleware `admin-auth-cookie@traefik` in at least one of its
#     routes[].middlewares[] entries.
#   - The rendered overlay must contain a Middleware named
#     `admin-auth-cookie` in namespace `traefik` (the base ships a
#     placeholder pointing at platform-api's session endpoint; overlays
#     that include admin-auth-gate-oauth2 replace its spec with a Chain).
#   - The overlay's kustomization.yaml must include exactly ONE of the
#     two admin-auth-gate-* components (cookie or oauth2). Both would
#     fight on the same Middleware; zero would leave an admin-ui labelled
#     route without an actual gate (in the cookie default it would still
#     work, but the operator never explicitly declared the choice).
#
# Exit 1 on any offending IngressRoute or missing/duplicated component.

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
    built=$(kustomize build "$overlay_dir")
  else
    built=$(kubectl kustomize "$overlay_dir")
  fi

  # Count admin-ui-labelled IngressRoutes — the auth-gate-* component is
  # only required if at least one such route exists (dev typically has
  # none because it skips longhorn/stalwart bring-up).
  admin_ui_count=$(echo "$built" | yq eval '
    select(.kind == "IngressRoute"
      and (.metadata.labels // {})["platform.phoenix-host.net/admin-ui"] == "true")
    | .metadata.name
  ' - | grep -c . || true)

  # Step 1: exactly one admin-auth-gate-* component must be wired in
  # when there's at least one admin-ui IngressRoute.
  if [[ -f "$overlay_dir/kustomization.yaml" && "$admin_ui_count" -ge 1 ]]; then
    gate_components=$(grep -E "admin-auth-gate-(cookie|oauth2)" "$overlay_dir/kustomization.yaml" | grep -v '^[[:space:]]*#' | wc -l | tr -d ' ')
    if [[ "$gate_components" != "1" ]]; then
      echo "FAIL [$overlay] kustomization.yaml has $gate_components admin-auth-gate-* components (expected exactly 1)"
      failures=$((failures + 1))
    fi
  fi

  # Step 2: the admin-auth-cookie Middleware must exist in namespace
  # traefik (only when admin-ui routes actually exist in this overlay).
  if [[ "$admin_ui_count" -ge 1 ]]; then
    mw_count=$(echo "$built" | yq eval '
      select(.kind == "Middleware"
        and .metadata.name == "admin-auth-cookie"
        and .metadata.namespace == "traefik")
      | .metadata.name
    ' - | grep -c "admin-auth-cookie" || true)
    if [[ "$mw_count" -lt 1 ]]; then
      echo "FAIL [$overlay] Middleware admin-auth-cookie in namespace traefik is missing"
      failures=$((failures + 1))
    fi
  fi

  # Step 3: every admin-ui-labelled IngressRoute must reference admin-auth-cookie.
  # yq emits "<name>|<refs-csv>" — refs-csv is the comma-joined list of
  # middleware names referenced across all routes[].middlewares[].
  mapfile -t rows < <(
    echo "$built" | yq eval --no-doc '
      select(.kind == "IngressRoute"
        and (.metadata.labels // {})["platform.phoenix-host.net/admin-ui"] == "true")
      | .metadata.name + "|" + ([(.spec.routes // [])[].middlewares // [] | .[].name] | join(","))
    ' -
  )

  for row in "${rows[@]}"; do
    [[ -z "$row" ]] && continue
    name="${row%%|*}"
    refs="${row#*|}"
    if [[ ",$refs," == *",admin-auth-cookie,"* ]]; then
      echo "ok  [$overlay] IngressRoute/$name references admin-auth-cookie"
    else
      echo "FAIL [$overlay] IngressRoute/$name labelled admin-ui=true but does NOT reference admin-auth-cookie (saw: $refs)"
      failures=$((failures + 1))
    fi
  done
done

if (( failures > 0 )); then
  echo
  echo "✗ $failures admin-auth gate problem(s) found."
  echo "  Each overlay must include exactly one of:"
  echo "    components:"
  echo "      - ../../components/admin-auth-gate-cookie"
  echo "      - ../../components/admin-auth-gate-oauth2"
  echo "  And every IngressRoute labelled platform.phoenix-host.net/admin-ui=\"true\""
  echo "  must include admin-auth-cookie@traefik in routes[].middlewares[]."
  exit 1
fi

echo "✓ admin-auth gate check passed."
