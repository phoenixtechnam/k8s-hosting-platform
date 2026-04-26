#!/usr/bin/env bash
# admin-password-reset.sh — emergency on-server admin password reset.
#
# Use when the platform admin can't log in (lost password, account
# locked, fresh DR-restore). Resets a user's password_hash directly
# in postgres using bcrypt cost 12 (matching backend/src/modules/
# auth/service.ts SALT_ROUNDS). Bypasses the API entirely so it
# works even when the admin panel is down.
#
# Must be run on a cluster server (or anywhere with kubeconfig +
# kubectl access to the cluster). Hashing happens INSIDE the
# platform-api pod via Node.js bcrypt — no shipping cleartext to
# the worker host.
#
# USAGE:
#   ./scripts/admin-password-reset.sh --email <email>             # prompts for password
#   ./scripts/admin-password-reset.sh --email <email> --random    # generates a random password, prints once
#   ./scripts/admin-password-reset.sh --email <email> --password '<pw>'   # explicit (not recommended in shell history)
#
# OPTIONS:
#   --email <addr>      User email (must already exist; this does NOT create users)
#   --random            Generate a strong random password and print it once
#   --password <pw>     Explicit password (avoid in interactive shells; ends up in bash history)
#   --kubeconfig <p>    Override KUBECONFIG (default: /etc/rancher/k3s/k3s.yaml)
#   --namespace <ns>    Platform namespace (default: platform)
#
# EXAMPLES:
#   # Operator on the staging1 server, reset to a random password:
#   sudo ./scripts/admin-password-reset.sh --email admin@phoenix-host.net --random
#
#   # Reset to an interactively-typed password (no shell history leak):
#   sudo ./scripts/admin-password-reset.sh --email admin@phoenix-host.net
#
#   # From operator's workstation with a custom kubeconfig:
#   ./scripts/admin-password-reset.sh --email admin@phoenix-host.net \
#     --kubeconfig /tmp/k8s-staging/kubeconfig --random
#
# SECURITY:
#   - The plaintext password is NEVER written to disk. It's piped via
#     stdin into a kubectl exec session that does the bcrypt hash
#     inside platform-api's container.
#   - The bcrypt hash is updated via psql with parameterized SQL.
#   - Audit log entry is inserted recording actor=null + action=
#     'admin_password_reset_via_cli' for forensic visibility.
set -uo pipefail

EMAIL=""
PASSWORD=""
RANDOM_MODE=0
KUBECONFIG_OVERRIDE=""
PLATFORM_NS="platform"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --email)      EMAIL="$2"; shift 2 ;;
    --password)   PASSWORD="$2"; shift 2 ;;
    --random)     RANDOM_MODE=1; shift ;;
    --kubeconfig) KUBECONFIG_OVERRIDE="$2"; shift 2 ;;
    --namespace)  PLATFORM_NS="$2"; shift 2 ;;
    -h|--help)    grep '^#' "$0" | sed 's/^# \{0,1\}//' | head -45; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

if [[ -n "$KUBECONFIG_OVERRIDE" ]]; then
  export KUBECONFIG="$KUBECONFIG_OVERRIDE"
fi
KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
export KUBECONFIG
if [[ ! -r "$KUBECONFIG" ]]; then
  echo "ERROR: KUBECONFIG file not readable: $KUBECONFIG" >&2
  exit 2
fi

if [[ -z "$EMAIL" ]]; then
  echo "ERROR: --email is required" >&2
  exit 2
fi
if [[ -z "$PASSWORD" && $RANDOM_MODE -eq 0 ]]; then
  # Read interactively without echoing.
  printf 'New password for %s (input hidden): ' "$EMAIL" >&2
  read -rs PASSWORD
  printf '\n' >&2
  printf 'Confirm: ' >&2
  CONFIRM=""
  read -rs CONFIRM
  printf '\n' >&2
  if [[ "$PASSWORD" != "$CONFIRM" ]]; then
    echo "ERROR: passwords don't match" >&2
    exit 1
  fi
  if [[ ${#PASSWORD} -lt 12 ]]; then
    echo "ERROR: password must be at least 12 characters" >&2
    exit 1
  fi
fi

if [[ $RANDOM_MODE -eq 1 ]]; then
  # /dev/urandom + tr — no shelling to a Python that might not exist
  PASSWORD=$(LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c 24)
fi

if ! kubectl get ns "$PLATFORM_NS" >/dev/null 2>&1; then
  echo "ERROR: namespace '$PLATFORM_NS' not found" >&2
  exit 1
fi

# Pick the first Ready platform-api pod for hashing
API_POD=$(kubectl -n "$PLATFORM_NS" get pods -l app=platform-api \
  --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
if [[ -z "$API_POD" ]]; then
  echo "ERROR: no Running platform-api pod in $PLATFORM_NS — cannot hash password" >&2
  exit 1
fi

# Pick the first Ready postgres pod for the UPDATE
PG_POD=$(kubectl -n "$PLATFORM_NS" get pods -l app=postgres \
  --field-selector=status.phase=Running \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
if [[ -z "$PG_POD" ]]; then
  echo "ERROR: no Running postgres pod in $PLATFORM_NS" >&2
  exit 1
fi

# Read DB credentials from the same Secret bootstrap created
PG_USER=$(kubectl -n "$PLATFORM_NS" get statefulset postgres \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="POSTGRES_USER")].value}' 2>/dev/null)
PG_DB=$(kubectl -n "$PLATFORM_NS" get statefulset postgres \
  -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="POSTGRES_DB")].value}' 2>/dev/null)
if [[ -z "$PG_USER" || -z "$PG_DB" ]]; then
  echo "ERROR: failed to read POSTGRES_USER/POSTGRES_DB from postgres StatefulSet" >&2
  exit 1
fi

# Step 1: hash inside the platform-api pod (which has bcrypt installed).
# Pass the cleartext via stdin so it never appears in `ps`, `bash -x`,
# or kubectl event logs. The cost (12) matches SALT_ROUNDS in
# backend/src/modules/auth/service.ts.
HASH=$(printf '%s' "$PASSWORD" \
  | kubectl -n "$PLATFORM_NS" exec -i "$API_POD" -- node -e '
let s = "";
process.stdin.on("data", c => s += c);
process.stdin.on("end", () => {
  try {
    const bcrypt = require("bcrypt");
    process.stdout.write(bcrypt.hashSync(s, 12));
  } catch (e) {
    process.stderr.write("HASH_ERROR: " + e.message);
    process.exit(1);
  }
});
' 2>/dev/null)

if [[ -z "$HASH" || ! "$HASH" =~ ^\$2[aby]?\$ ]]; then
  echo "ERROR: bcrypt hashing failed (got: '${HASH:0:6}...')" >&2
  exit 1
fi

# Step 2: UPDATE password_hash + audit_logs row, in a single tx.
# Build SQL with values escaped for single-quote literals (no
# psql -v needed — variable substitution behavior with -c is
# version-dependent). Email validated by --email; hash is bcrypt
# output ($2b$12$... — SQL-safe inside single quotes).
# audit_logs.actor_id is NOT NULL — use the target user's own id
# (self-reset semantics; matches what an authed self-rotate would do).
escape_sql() { printf '%s' "$1" | sed "s/'/''/g"; }
EMAIL_ESC=$(escape_sql "$EMAIL")
HASH_ESC=$(escape_sql "$HASH")

SQL=$(cat <<EOF
BEGIN;
WITH updated AS (
  UPDATE users
    SET password_hash = '${HASH_ESC}',
        updated_at = NOW()
    WHERE email = '${EMAIL_ESC}'
    RETURNING id
)
INSERT INTO audit_logs(id, actor_id, "actorType", action_type, resource_type, resource_id, http_method, http_path, http_status)
  SELECT gen_random_uuid()::text, id, 'system', 'admin_password_reset_via_cli', 'user',
         id, 'CLI', '/scripts/admin-password-reset.sh', 200
  FROM updated
  RETURNING actor_id;
COMMIT;
EOF
)

ROWS=$(printf '%s' "$SQL" \
  | kubectl -n "$PLATFORM_NS" exec -i "$PG_POD" -- env \
    PGUSER="$PG_USER" PGDATABASE="$PG_DB" \
    psql -v ON_ERROR_STOP=1 -tAq -f - 2>&1)

if [[ -z "$ROWS" ]] || ! echo "$ROWS" | grep -q '^[0-9a-f-]\{36\}$'; then
  echo "ERROR: user with email '$EMAIL' not found, OR audit_logs schema differs" >&2
  echo "psql output: $ROWS" >&2
  exit 1
fi

echo
echo "Password reset for: $EMAIL  (user id: $(echo "$ROWS" | head -1))"
if [[ $RANDOM_MODE -eq 1 ]]; then
  echo
  echo "Generated password (this is the ONLY time it's displayed):"
  echo
  echo "  $PASSWORD"
  echo
  echo "Save it now — it cannot be recovered."
fi
echo "Audit row written to audit_logs (action_type=admin_password_reset_via_cli)."

# Best-effort wipe. Bash doesn't zero memory on assignment, but
# overwriting reduces the lifetime of the secret string in case
# the script is killed mid-run by something that snapshots memory.
PASSWORD=""
HASH=""
SQL=""
EMAIL_ESC=""
HASH_ESC=""
unset PASSWORD HASH SQL EMAIL_ESC HASH_ESC
