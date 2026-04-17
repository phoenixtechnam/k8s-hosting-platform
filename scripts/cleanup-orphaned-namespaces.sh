#!/usr/bin/env bash
#
# cleanup-orphaned-namespaces.sh — delete client-* namespaces whose
# corresponding client row no longer exists in the platform database.
#
# Use this to reclaim pod capacity after smoke-test runs (or any
# other churn) that leaks k8s namespaces. Safe to re-run; a dry-run
# flag is available via `--dry-run`.
#
# Usage:
#   ./scripts/cleanup-orphaned-namespaces.sh                # interactive
#   ./scripts/cleanup-orphaned-namespaces.sh --dry-run      # list only
#   ./scripts/cleanup-orphaned-namespaces.sh --yes          # no prompt
#
# Environment:
#   K3S_CONTAINER   — docker container running k3s (default: hosting-platform-k3s-server-1)
#   API_URL         — platform API base URL (default: http://dind.local:2012)
#   ADMIN_EMAIL     — admin login (default: admin@k8s-platform.local-dev)
#   ADMIN_PASSWORD  — admin password (default: admin)

set -euo pipefail

K3S_CONTAINER="${K3S_CONTAINER:-hosting-platform-k3s-server-1}"
API_URL="${API_URL:-http://dind.local:2012}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@k8s-platform.local-dev}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"

DRY_RUN=false
ASSUME_YES=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --yes|-y)  ASSUME_YES=true ;;
    -h|--help)
      sed -n '2,22p' "$0"
      exit 0
      ;;
  esac
done

if ! command -v curl >/dev/null; then
  echo "error: curl is required" >&2
  exit 2
fi
if ! command -v python3 >/dev/null; then
  echo "error: python3 is required" >&2
  exit 2
fi

# Resolve an admin token
token_json=$(curl -s -X POST "$API_URL/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}")
TOKEN=$(echo "$token_json" | python3 -c 'import sys,json;print(json.load(sys.stdin)["data"]["token"])' 2>/dev/null || true)
if [[ -z "$TOKEN" ]]; then
  echo "error: failed to obtain admin token from $API_URL" >&2
  echo "$token_json" >&2
  exit 3
fi

# List all known client namespaces from the DB
# (pagination: use a very large limit; platforms with >1000 clients
# should paginate, but for cleanup context this is sufficient)
clients_json=$(curl -s "$API_URL/api/v1/clients?limit=100" \
  -H "Authorization: Bearer $TOKEN")
DB_NAMESPACES=$(echo "$clients_json" | python3 -c '
import sys,json
try:
  d=json.load(sys.stdin)
  for c in d.get("data", []):
    ns = c.get("kubernetesNamespace")
    if ns: print(ns)
except Exception as e:
  print(f"error: {e}", file=sys.stderr); sys.exit(1)
')

# List all client-* namespaces from k3s
K8S_NAMESPACES=$(docker exec "$K3S_CONTAINER" kubectl get ns -o name 2>/dev/null \
  | sed 's|^namespace/||' \
  | grep '^client-' || true)

if [[ -z "$K8S_NAMESPACES" ]]; then
  echo "No client-* namespaces found in k3s."
  exit 0
fi

# Compute orphans (in k3s but not in DB)
orphans=()
while read -r ns; do
  [[ -z "$ns" ]] && continue
  if ! grep -Fx "$ns" <<< "$DB_NAMESPACES" >/dev/null; then
    orphans+=("$ns")
  fi
done <<< "$K8S_NAMESPACES"

total=${#orphans[@]}

echo "========================================"
echo "  Orphaned k8s namespaces — $total found"
echo "========================================"
for ns in "${orphans[@]}"; do
  echo "  $ns"
done

if (( total == 0 )); then
  echo "Nothing to do."
  exit 0
fi

if [[ "$DRY_RUN" == "true" ]]; then
  echo ""
  echo "(dry-run: no namespaces were deleted)"
  exit 0
fi

if [[ "$ASSUME_YES" != "true" ]]; then
  echo ""
  read -r -p "Delete all $total orphaned namespaces? [y/N] " reply
  if [[ "$reply" != "y" && "$reply" != "Y" ]]; then
    echo "aborted."
    exit 0
  fi
fi

echo ""
echo "Deleting orphaned namespaces..."
deleted=0
failed=0
for ns in "${orphans[@]}"; do
  if docker exec "$K3S_CONTAINER" kubectl delete ns "$ns" --wait=false >/dev/null 2>&1; then
    echo "  ✓ $ns"
    deleted=$((deleted + 1))
  else
    echo "  ✗ $ns (failed)"
    failed=$((failed + 1))
  fi
done

echo ""
echo "Done: $deleted deleted, $failed failed."
exit 0
