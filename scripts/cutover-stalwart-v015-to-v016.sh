#!/usr/bin/env bash
# cutover-stalwart-v015-to-v016.sh
#
# Wipes the Stalwart 0.15 deployment from the local DinD k3s cluster and
# lets Flux / kubectl apply the 0.16 manifests on next sync.
#
# SAFETY:
#   - Refuses to run if any platform tenant has email_domains rows in the
#     platform Postgres DB.
#   - Idempotent: safe to re-run; skips resources that are already gone.
#
# USAGE:
#   ./scripts/cutover-stalwart-v015-to-v016.sh [--force]
#
# FLAGS:
#   --force   Skip the interactive confirmation prompt (for CI / scripted runs).
#
# ENVIRONMENT:
#   KUBECONFIG — path to the cluster kubeconfig (default: /etc/rancher/k3s/k3s.yaml
#                  or DOCKER_HOST-based DinD context set by local.sh).
#
# The script assumes it is run from the project root or anywhere — it does not
# rely on CWD.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FORCE=false

for arg in "$@"; do
  case "$arg" in
    --force) FORCE=true ;;
    *) echo "Unknown argument: $arg" >&2; exit 1 ;;
  esac
done

# ── kubectl wrapper ──────────────────────────────────────────────────────────
# Honour KUBECONFIG if set; fall back to the DinD k3s default used by local.sh.
_kubectl() {
  if [[ -n "${KUBECONFIG:-}" ]]; then
    kubectl "$@"
  elif command -v docker &>/dev/null && docker ps --filter "name=hosting-platform-k3s" --format '{{.Names}}' 2>/dev/null | grep -q k3s; then
    # local.sh DinD pattern — exec into the server container
    local k3s_server
    k3s_server=$(docker ps --filter "name=hosting-platform-k3s-server" --format '{{.Names}}' | head -1)
    if [[ -z "$k3s_server" ]]; then
      echo "ERROR: no DinD k3s-server container found. Is the local stack running?" >&2
      exit 1
    fi
    docker exec "$k3s_server" kubectl "$@"
  else
    kubectl "$@"
  fi
}

# ── psql wrapper — query the platform Postgres ────────────────────────────
_psql() {
  # Try in-cluster via kubectl exec into the CNPG primary pod first.
  # The cluster's CR name is `postgres` (see k8s/base/database.yaml); the
  # label selector that picks the current primary is
  # `cnpg.io/cluster=postgres,role=primary`. Fix from cutover-on-staging
  # (2026-05-04) — original selector had cluster=platform-pg which never
  # matched any pod and silently fell through to the host psql fallback.
  local pg_pod
  pg_pod=$(_kubectl get pod -n platform -l cnpg.io/cluster=postgres,role=primary \
             --no-headers -o custom-columns=":metadata.name" 2>/dev/null | head -1 || true)

  if [[ -n "$pg_pod" ]]; then
    # DB name + owner come from CNPG bootstrap.initdb in
    # k8s/base/database.yaml — `hosting_platform` / `platform`.
    _kubectl exec -n platform "$pg_pod" -- \
      psql -U platform -d hosting_platform -tAc "$1"
  else
    # Fallback: direct psql on localhost (if running outside cluster)
    psql "${PLATFORM_DB_URL:-postgresql://platform_app@localhost:5432/platform}" -tAc "$1"
  fi
}

# ── Pre-flight: check for real tenant email data ─────────────────────────────
echo "==> Pre-flight: checking for tenant email domains..."
email_count=$(_psql "SELECT COUNT(*) FROM email_domains;" 2>/dev/null || echo "error")

if [[ "$email_count" == "error" ]]; then
  echo "WARNING: Could not query platform Postgres. Proceeding with caution."
  echo "         Manually verify no tenant email_domains exist before continuing."
  if [[ "$FORCE" != "true" ]]; then
    read -r -p "Continue anyway? (yes/no): " answer
    [[ "$answer" == "yes" ]] || { echo "Aborted."; exit 1; }
  fi
elif [[ "$email_count" -gt 0 ]]; then
  echo ""
  echo "ERROR: Aborting cutover — $email_count email_domains rows found."
  echo ""
  echo "  Real tenant email data exists in the platform database."
  echo "  Deleting the Stalwart 0.15 deployment would destroy live mailboxes."
  echo ""
  echo "  Either:"
  echo "    1. Migrate all tenants off email before running this script, OR"
  echo "    2. This is a dev/test environment with test data — truncate manually:"
  echo "         kubectl exec -n platform <pg-pod> -- psql -U platform_app -d platform"
  echo "         => TRUNCATE email_domains CASCADE;"
  echo ""
  exit 1
else
  echo "    OK — 0 email_domains rows found. Safe to proceed."
fi

# ── Interactive confirmation ─────────────────────────────────────────────────
echo ""
echo "==> About to DELETE the Stalwart 0.15 StatefulSet, PVC, and Secrets."
echo "    This is IRREVERSIBLE on this cluster."
echo ""
if [[ "$FORCE" != "true" ]]; then
  read -r -p "Continue? (yes/no): " answer
  [[ "$answer" == "yes" ]] || { echo "Aborted."; exit 1; }
fi

# ── Step 1: Delete the 0.15 StatefulSet ────────────────────────────────────
echo ""
echo "==> Step 1: Deleting stalwart-mail StatefulSet (0.15)..."
_kubectl delete statefulset stalwart-mail -n mail --ignore-not-found=true
echo "    Done."

# ── Step 2: Delete the 0.15 PVC ─────────────────────────────────────────────
echo "==> Step 2: Deleting PVC data-stalwart-mail-0 (0.15)..."
_kubectl delete pvc data-stalwart-mail-0 -n mail --ignore-not-found=true
echo "    Done."

# ── Step 3: Delete the 0.15 Secrets ─────────────────────────────────────────
echo "==> Step 3: Deleting stalwart-secrets (0.15 admin/master creds)..."
_kubectl delete secret stalwart-secrets -n mail --ignore-not-found=true
echo "    Done."

# ── Step 4: Delete the 0.15 ConfigMap ───────────────────────────────────────
echo "==> Step 4: Deleting stalwart-config ConfigMap (0.15)..."
_kubectl delete configmap stalwart-config -n mail --ignore-not-found=true
echo "    Done."

# ── Step 5: Delete 0.15 Services (keeps 0.16 Services untouched) ────────────
echo "==> Step 5: Deleting stalwart-mail Services (0.15)..."
_kubectl delete service stalwart-mail stalwart-mail-mgmt stalwart-mail-headless -n mail --ignore-not-found=true
echo "    Done."

# ── Step 5b: Delete 0.15 webadmin Ingress (overlay-specific) ────────────────
# The 0.15 staging overlay shipped a `stalwart-webadmin-ingress` Ingress on
# stalwart.${DOMAIN}. The 0.16 base ships `stalwart-v016-webadmin` on the
# same host+path. Flux refuses the v016 apply with `host already defined
# in ingress mail/stalwart-webadmin-ingress` until the old one is gone.
# Flux's prune will eventually remove it (it's no longer in the kustomize
# output), but cutover-day the operator should clean it up immediately so
# the v016 ingress can come up.
echo "==> Step 5b: Deleting any 0.15 webadmin Ingress on stalwart.<domain>..."
_kubectl delete ingress -n mail stalwart-webadmin-ingress --ignore-not-found=true
echo "    Done."

# ── Step 6: Ensure stalwart-admin-creds Secret exists for v016 ─────────────
echo "==> Step 6: Checking stalwart-admin-creds Secret (required by 0.16)..."
if _kubectl get secret -n mail stalwart-admin-creds &>/dev/null; then
  echo "    OK — stalwart-admin-creds already exists."
else
  echo "    Secret missing. Generating a fresh admin password and creating it."
  # Code-review M-2 fix (2026-05-04): use `openssl rand -hex` so the
  # password length is deterministic. The previous `rand -base64 24 |
  # tr -d '/+=' | head -c 32` could yield <32 chars when the random
  # bytes happened to contain many strippable base64 chars. Hex is
  # always 2 × byte-count and uses a fixed 16-char alphabet — 256 bits
  # of source entropy, 64 chars of output, no stripping.
  stalwart_admin_pw="$(openssl rand -hex 32)"
  _kubectl create secret generic stalwart-admin-creds \
    --namespace=mail \
    --from-literal=adminPassword="$stalwart_admin_pw" \
    --from-literal=recoveryPassword="$stalwart_admin_pw" \
    --from-literal=recoveryAdmin="admin:${stalwart_admin_pw}"
  # Code-review M-1 fix (2026-05-04): write the cleartext to a chmod-600
  # tempfile instead of stdout. CI runs of this script with --force
  # would otherwise leak the password into job log artifacts. The
  # operator can `cat` the printed path interactively.
  pw_file="$(mktemp -t stalwart-admin-pw.XXXXXX)"
  chmod 600 "$pw_file"
  printf '%s\n' "$stalwart_admin_pw" > "$pw_file"
  echo ""
  echo "    GENERATED Stalwart 0.16 admin password written to:"
  echo "        $pw_file   (chmod 600)"
  echo ""
  echo "    Capture the value before this terminal closes — then delete the file:"
  echo "        cat $pw_file"
  echo "        shred -u $pw_file"
  echo ""
  echo "    DO NOT echo this password into a CI log. If running in CI, capture"
  echo "    via the file path above into a secret store, then delete the file."
fi

# ── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "==> Stalwart 0.15 resources removed."
echo ""
echo "    Next steps:"
echo "    1. Apply 0.16 manifests:"
echo "         kubectl apply -k k8s/overlays/dev/stalwart-v016/"
echo "    OR"
echo "         ./scripts/local.sh mail16-up"
echo ""
echo "    2. Verify Stalwart 0.16 pod is Ready:"
echo "         kubectl get pods -n mail"
echo ""
echo "    3. Run the E2E integration test:"
echo "         ./scripts/integration-stalwart-v016-local.sh"
echo ""
