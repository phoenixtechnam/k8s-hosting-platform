#!/usr/bin/env bash
#
# migrate-valkey-bootstrap.sh
#
# One-shot migration to wire the platform-wide Valkey coordinator
# cache into a running cluster. Idempotent — re-runs are no-ops.
#
# What this does:
#   1. Creates the valkey-auth Secret in redis-system namespace if it
#      doesn't exist yet (random hex password, openssl rand -hex 32).
#   2. Probes the Stalwart Coordinator schema via `stalwart-cli query
#      Coordinator --json` to discover the exact field shape (Stalwart
#      versions differ in discriminator naming).
#   3. Crafts the appropriate Coordinator create/update plan and
#      applies it via stalwart-cli.
#   4. Mirrors the password into stalwart-admin-creds so future
#      bootstrap-plan rotations stay in sync.
#
# Why a script (not a manifest):
#   Stalwart's bootstrap-plan + Coordinator schema can drift between
#   releases. Empirical schema discovery via stalwart-cli is more
#   robust than baking a JSON shape into bootstrap-plan-cm.yaml that
#   might be wrong for a future Stalwart minor.
#
# Prerequisites:
#   - Valkey StatefulSet is deployed and Ready (`kubectl -n redis-system
#     get sts valkey` shows desired/ready replicas).
#   - Stalwart pod is Ready (1/1).
#   - stalwart-admin-creds Secret exists in mail namespace.
#
# Usage:
#   ./scripts/migrate-valkey-bootstrap.sh
#   ./scripts/migrate-valkey-bootstrap.sh --skip-secret    # keep existing valkey-auth
#   ./scripts/migrate-valkey-bootstrap.sh --skip-stalwart  # only create the Secret

set -euo pipefail

NAMESPACE_REDIS="redis-system"
NAMESPACE_MAIL="mail"
SKIP_SECRET=0
SKIP_STALWART=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-secret)   SKIP_SECRET=1; shift ;;
    --skip-stalwart) SKIP_STALWART=1; shift ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

: "${KUBECTL:=kubectl}"

err() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[migrate-valkey] %s\n' "$*"; }

# ── 1. valkey-auth Secret ───────────────────────────────────────────
ensure_secret() {
  if [[ "$SKIP_SECRET" == "1" ]]; then
    log "Skipping Secret creation (--skip-secret)"
    return
  fi

  $KUBECTL get ns "$NAMESPACE_REDIS" >/dev/null 2>&1 \
    || err "Namespace $NAMESPACE_REDIS does not exist — apply k8s/base/valkey/ first"

  if $KUBECTL -n "$NAMESPACE_REDIS" get secret valkey-auth >/dev/null 2>&1; then
    log "valkey-auth Secret already exists — keeping current password"
    return
  fi

  password=$(openssl rand -hex 32)
  $KUBECTL create secret generic valkey-auth \
    --namespace "$NAMESPACE_REDIS" \
    --from-literal=REDIS_PASSWORD="$password" \
    --dry-run=client -o yaml | $KUBECTL apply -f -
  $KUBECTL -n "$NAMESPACE_REDIS" label secret valkey-auth \
    app=valkey app.kubernetes.io/part-of=hosting-platform --overwrite >/dev/null

  log "Created valkey-auth Secret with random password (length=${#password})"
}

# ── 2. Stalwart Coordinator wiring ──────────────────────────────────
# Reads the existing valkey-auth password and the Stalwart
# recovery password, then uses stalwart-cli inside a one-shot pod
# to discover the Coordinator schema and apply the Redis URL.
wire_stalwart() {
  if [[ "$SKIP_STALWART" == "1" ]]; then
    log "Skipping Stalwart Coordinator wiring (--skip-stalwart)"
    return
  fi

  $KUBECTL -n "$NAMESPACE_MAIL" get deploy stalwart-mail >/dev/null 2>&1 \
    || err "Stalwart deployment not found — run cutover first"

  recovery_pw=$($KUBECTL -n "$NAMESPACE_MAIL" get secret stalwart-admin-creds \
    -o jsonpath='{.data.recoveryPassword}' 2>/dev/null | base64 -d) \
    || err "stalwart-admin-creds.recoveryPassword unreadable"
  [[ -n "$recovery_pw" ]] || err "Stalwart recovery password is empty"

  redis_pw=$($KUBECTL -n "$NAMESPACE_REDIS" get secret valkey-auth \
    -o jsonpath='{.data.REDIS_PASSWORD}' 2>/dev/null | base64 -d) \
    || err "valkey-auth.REDIS_PASSWORD unreadable — was the Secret created?"
  [[ -n "$redis_pw" ]] || err "valkey-auth password is empty"

  # The Service ClusterIP form — Phase-1 simple wiring. Phase 3 will
  # upgrade to redis+sentinel:// once Sentinel-aware client config
  # is added; until then redis-rs handles failover via the
  # round-robin ClusterIP + automatic reconnect.
  redis_url="redis://:${redis_pw}@valkey.redis-system.svc.cluster.local:6379"

  stamp=$(date +%s)
  pod_name="stalwart-coordinator-wire-$stamp"

  log "Spawning wiring pod $pod_name in $NAMESPACE_MAIL..."

  # Heredoc for the pod-side script. Schema discovery: query
  # Coordinator first; if nonempty, the in-process default is
  # already there and we just need to UPDATE the URL. If empty
  # (unlikely on Stalwart 0.16, which always has an in-process
  # default), we CREATE a new one.
  wire_script=$(cat <<'WIRE'
#!/bin/sh
set -eu

CLI_VERSION="v1.0.4"
CLI_URL="https://github.com/stalwartlabs/cli/releases/download/${CLI_VERSION}/stalwart-cli-x86_64-unknown-linux-musl.tar.xz"
CLI_SHA256="01c734752cc44b9e24f753cbacfc2d489dadaaccf72cd229ecb7269e85e0eefa"

echo "Downloading stalwart-cli ${CLI_VERSION}..."
wget -q -O /tmp/stalwart-cli.tar.xz "${CLI_URL}"
actual=$(sha256sum /tmp/stalwart-cli.tar.xz | awk '{print $1}')
if [ "${actual}" != "${CLI_SHA256}" ]; then
  echo "ERROR: stalwart-cli SHA256 mismatch" >&2
  exit 1
fi
# Extract to a fixed path (not a glob mv). The archive's top-level
# directory is stable across versions: stalwart-cli-<triple>/.
mkdir -p /tmp/swcli
tar -xJf /tmp/stalwart-cli.tar.xz -C /tmp/swcli/ \
  --strip-components=1 stalwart-cli-x86_64-unknown-linux-musl/stalwart-cli
chmod +x /tmp/swcli/stalwart-cli

# Read secrets from the volume-mounted Secret rather than env vars.
# /sec is mounted by the kubectl run --overrides spec below.
STALWART_RECOVERY_PASSWORD=$(cat /sec/recoveryPassword)
REDIS_URL=$(cat /sec/redisUrl)

export HOME=/tmp
export STALWART_PASSWORD="${STALWART_RECOVERY_PASSWORD}"
URL="http://stalwart-mgmt.mail.svc.cluster.local:8080"

echo "=== Current Coordinator state ==="
# Coordinator is a singleton — no `query` support. Use `get` to read.
/tmp/swcli/stalwart-cli --url "$URL" --user admin get Coordinator 2>&1 || true

# Coordinator is a singleton (always exists, defaults to in-memory
# Disabled/Default variant). We update its discriminator to `Redis`
# and supply the connection URL. The Redis variant on Stalwart 0.16
# accepts only `url` (+ pool/timeout fields); fields like `keyPrefix`
# are not supported here — the cluster name-spacing is done at the
# Stalwart application layer, not the Coordinator config.
echo
echo "=== Applying Redis Coordinator ==="
cat > /tmp/coord.json <<PLAN
{"@type":"update","object":"Coordinator","value":{"@type":"Redis","url":"${REDIS_URL}"}}
PLAN

/tmp/swcli/stalwart-cli --url "$URL" --user admin apply --file /tmp/coord.json

echo
echo "=== Final Coordinator state ==="
/tmp/swcli/stalwart-cli --url "$URL" --user admin get Coordinator 2>&1
echo
echo "Coordinator wired — roll the Stalwart pod for the new client to attach:"
echo "  kubectl -n mail rollout restart deploy stalwart-mail"
WIRE
)

  # S3 hardening (2026-05-07 security review): mount secrets as a
  # tmpfs Secret volume rather than passing them through `--env`.
  # `--env` writes the cleartext secret into the Pod spec, which:
  #   1. lives in etcd until the pod is deleted (default GC ~2h);
  #   2. shows in `kubectl describe pod` output to anyone with
  #      `pods/get` in the namespace;
  #   3. is captured by the audit log forever;
  #   4. is logged in stderr if the pod fails to start.
  #
  # Volume-mounted Secrets stay in tmpfs, are removed when the pod
  # exits, and the Secret object itself is short-lived (deleted in
  # the trap below).
  secret_name="valkey-coord-wire-${stamp}"
  $KUBECTL create secret generic "$secret_name" \
    --namespace "$NAMESPACE_MAIL" \
    --from-literal=recoveryPassword="$recovery_pw" \
    --from-literal=redisUrl="$redis_url" \
    >/dev/null

  # Trap to ensure the transient Secret + Pod are cleaned up even on
  # script interruption.
  cleanup_wire() {
    $KUBECTL -n "$NAMESPACE_MAIL" delete secret "$secret_name" --ignore-not-found --wait=false >/dev/null 2>&1 || true
    $KUBECTL -n "$NAMESPACE_MAIL" delete pod "$pod_name" --ignore-not-found --wait=false --grace-period=0 --force >/dev/null 2>&1 || true
  }
  trap cleanup_wire EXIT

  # alpine pinned by digest to defend against a registry-substitution
  # MitM. Bump the digest when the upstream image is rebuilt for a
  # CVE we care about. (alpine:3.20.3 amd64 digest as of 2026-05.)
  alpine_image="alpine:3.20.3@sha256:beefdbd8a1da6d2915566fde36db9db0b524eb737fc57cd1367effd16dc0d06d"

  # Strategic-merge override: only the volumes + the named container's
  # volumeMounts. kubectl run constructs the rest of the spec
  # (command, image, stdin) from the CLI flags below.
  overrides=$(cat <<EOF
{
  "spec": {
    "containers": [{
      "name": "${pod_name}",
      "volumeMounts": [{"name": "sec", "mountPath": "/sec", "readOnly": true}]
    }],
    "volumes": [{"name": "sec", "secret": {"secretName": "${secret_name}", "defaultMode": 256}}]
  }
}
EOF
)

  # --override-type=strategic so the named-container merge composes
  # with kubectl run's auto-generated container spec (image, command,
  # stdin) rather than replacing it entirely. Default `merge` (JSON
  # merge patch, RFC 7386) replaces array fields wholesale and drops
  # the image / command we set on the CLI.
  $KUBECTL run "$pod_name" -n "$NAMESPACE_MAIL" --rm -i --restart=Never \
    --image="$alpine_image" \
    --override-type=strategic \
    --overrides="$overrides" \
    --command -- /bin/sh -c "$wire_script" \
    || err "Coordinator wiring pod failed"

  trap - EXIT
  cleanup_wire

  log
  log "Wiring complete. Roll the Stalwart pod:"
  log "  kubectl -n $NAMESPACE_MAIL rollout restart deploy stalwart-mail"
}

ensure_secret
wire_stalwart

log "Done. Verify Stalwart attached to Valkey with:"
log "  kubectl -n $NAMESPACE_MAIL logs deploy/stalwart-mail | grep -iE 'redis|coordinator'"
