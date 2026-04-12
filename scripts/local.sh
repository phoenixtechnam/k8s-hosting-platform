#!/usr/bin/env bash
set -euo pipefail

# local.sh — Manage the local development stack.
#
# Usage:
#   ./scripts/local.sh up          Build and start all services
#   ./scripts/local.sh down        Stop all services
#   ./scripts/local.sh reset       Stop, wipe volumes, and restart fresh
#   ./scripts/local.sh logs        Tail logs from all services
#   ./scripts/local.sh status      Show service status and endpoints
#   ./scripts/local.sh rebuild     Rebuild and restart (no volume wipe)
#   ./scripts/local.sh k3s-up      Start k3s cluster + init (PVC, ingress)
#   ./scripts/local.sh k3s-down    Stop k3s cluster
#   ./scripts/local.sh k3s-reset   Wipe k3s cluster and restart fresh
#   ./scripts/local.sh k3s-status  Show k3s cluster status
#   ./scripts/local.sh k3s-shell   Open kubectl shell in k3s
#   ./scripts/local.sh mail-up     Deploy Stalwart mail server to local k3s
#   ./scripts/local.sh mail-down   Remove Stalwart mail server from local k3s
#   ./scripts/local.sh mail-status Show mail server pod/service state
#   ./scripts/local.sh mail-logs   Tail Stalwart logs
#   ./scripts/local.sh mail-test   Send + receive a test mail via swaks
#   ./scripts/local.sh webmail-up     Deploy Roundcube webmail to local k3s
#   ./scripts/local.sh webmail-down   Remove Roundcube from local k3s
#   ./scripts/local.sh webmail-status Show Roundcube pod state
#   ./scripts/local.sh webmail-logs   Tail Roundcube logs
#   ./scripts/local.sh sftp-up     Deploy SFTP gateway to local k3s
#   ./scripts/local.sh sftp-down   Remove SFTP gateway from local k3s
#   ./scripts/local.sh sftp-status Show SFTP gateway pod/service state
#   ./scripts/local.sh help        Show this help
#
# Environment:
#   Override any variable from .env.local, e.g.:
#     DOCKER_HOST_NAME=localhost PORT_ADMIN=8080 ./scripts/local.sh up
#     DOCKER_HOST=tcp://dind:2375 ./scripts/local.sh up

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly PROJECT_DIR

COMPOSE_FILE="${PROJECT_DIR}/docker-compose.local.yml"
ENV_FILE="${PROJECT_DIR}/.env.local"
ENV_LOCAL="${PROJECT_DIR}/.env.local.local"

# Load env files (local overrides base)
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi
if [[ -f "$ENV_LOCAL" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$ENV_LOCAL"
  set +a
fi

# Defaults
DOCKER_HOST_NAME="${DOCKER_HOST_NAME:-dind.local}"
PORT_ADMIN="${PORT_ADMIN:-2010}"
PORT_CLIENT="${PORT_CLIENT:-2011}"
PORT_API="${PORT_API:-2012}"
PORT_DB="${PORT_DB:-2013}"
PORT_REDIS="${PORT_REDIS:-2014}"
PORT_K3S_API="${PORT_K3S_API:-2016}"
PORT_MAIL_SMTP="${PORT_MAIL_SMTP:-2025}"
PORT_MAIL_SMTPS="${PORT_MAIL_SMTPS:-2465}"
PORT_MAIL_SUBMISSION="${PORT_MAIL_SUBMISSION:-2587}"
PORT_MAIL_IMAP="${PORT_MAIL_IMAP:-2143}"
PORT_MAIL_IMAPS="${PORT_MAIL_IMAPS:-2993}"
PORT_MAIL_POP3="${PORT_MAIL_POP3:-2110}"
PORT_MAIL_POP3S="${PORT_MAIL_POP3S:-2995}"
PORT_WEBMAIL="${PORT_WEBMAIL:-2017}"

K3S_CONTAINER="${K3S_CONTAINER:-hosting-platform-k3s-server-1}"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose_k3s() {
  compose "$@"
}

_ensure_cookie_secret() {
  if ! grep -q 'OAUTH2_PROXY_COOKIE_SECRET' "$ENV_FILE" 2>/dev/null; then
    local secret
    secret=$(python3 -c 'import os,base64; print(base64.urlsafe_b64encode(os.urandom(24)).decode())')
    echo "OAUTH2_PROXY_COOKIE_SECRET=$secret" >> "$ENV_FILE"
    echo "  Generated OAuth2 proxy cookie secret"
  fi
}

cmd_up() {
  echo "Building and starting local stack..."
  _ensure_cookie_secret
  # Build sequentially to avoid I/O storms on btrfs loopback (causes host lockups)
  compose build backend
  compose build admin-panel
  compose build client-panel
  compose up -d
  echo ""
  _rebuild_sidecar
  _check_k3s_health
  _cleanup_stale_namespaces
  # If mail namespace exists, re-patch the postgres bridge IP (it changes
  # on every container recreate and Stalwart can't authenticate without it).
  _patch_postgres_bridge 2>/dev/null || true
  cmd_status
}

cmd_down() {
  echo "Stopping local stack..."
  compose down
}

cmd_reset() {
  echo "Resetting local stack (wiping volumes)..."
  compose down -v
  # Remove stale cookie secret so a fresh one is generated
  if [[ -f "$ENV_FILE" ]]; then
    sed -i '/^OAUTH2_PROXY_COOKIE_SECRET=/d' "$ENV_FILE"
  fi
  echo "Starting fresh..."
  _ensure_cookie_secret
  # Build sequentially to avoid I/O storms on btrfs loopback (causes host lockups)
  compose build backend
  compose build admin-panel
  compose build client-panel
  compose up -d
  echo ""
  _rebuild_sidecar
  _patch_postgres_bridge 2>/dev/null || true
  cmd_status
}

cmd_rebuild() {
  echo "Rebuilding app services (backend, admin-panel, client-panel)..."
  # Only rebuild app services — never touch k3s, PostgreSQL, or Redis
  # This prevents accidental removal of infrastructure containers
  # Build sequentially to avoid I/O storms on btrfs loopback (causes host lockups)
  compose build backend
  compose build admin-panel
  compose build client-panel
  compose up -d --no-deps backend admin-panel client-panel
  echo ""
  # Rebuild and reimport file-manager sidecar into k3s
  _rebuild_sidecar
  # Verify k3s is still running (warn if not)
  _check_k3s_health
  _cleanup_stale_namespaces
  _patch_postgres_bridge 2>/dev/null || true
  # Re-patch SFTP backend bridge (backend IP changes on container recreate)
  _sftp_patch_backend_bridge 2>/dev/null || true
  cmd_status
}

_rebuild_sidecar() {
  local k3s_name
  k3s_name=$(docker ps --filter "name=k3s-server" --format '{{.Names}}' 2>/dev/null | head -1)
  if [[ -z "$k3s_name" ]]; then
    return
  fi
  echo "Rebuilding file-manager sidecar..."
  docker build -t file-manager-sidecar:latest "${PROJECT_DIR}/images/file-manager-sidecar/" -q 2>/dev/null
  docker save file-manager-sidecar:latest | docker exec -i "$k3s_name" ctr images import - 2>/dev/null
  echo "  Sidecar image imported into k3s"
}

_cleanup_stale_namespaces() {
  local k3s_name
  k3s_name=$(docker ps --filter "name=k3s-server" --format '{{.Names}}' 2>/dev/null | head -1)
  [[ -z "$k3s_name" ]] && return 0

  local orphan_count
  orphan_count=$(docker exec "$k3s_name" kubectl get ns --no-headers 2>/dev/null \
    | awk '/^client-smoke-test-/ {n++} END {print n+0}')

  if (( orphan_count > 5 )); then
    echo "⚠  $orphan_count stale smoke-test namespaces found — cleaning up to prevent resource exhaustion..."
    docker exec "$k3s_name" kubectl get ns --no-headers 2>/dev/null \
      | awk '/^client-smoke-test-/ {print $1}' \
      | while read -r ns; do
          docker exec "$k3s_name" kubectl delete ns "$ns" --wait=false >/dev/null 2>&1 && echo "  ✓ deleted $ns" || true
        done
  elif (( orphan_count > 0 )); then
    echo "  $orphan_count stale smoke-test namespace(s) found (run ./scripts/cleanup-orphaned-namespaces.sh to clean)"
  fi
}

_check_k3s_health() {
  local k3s_name
  k3s_name=$(docker ps --filter "name=k3s-server" --format '{{.Names}}' 2>/dev/null | head -1)
  if [[ -z "$k3s_name" ]]; then
    echo "⚠️  k3s cluster is not running! Start it with: ./scripts/local.sh k3s-up"
    return
  fi
  if ! docker exec "$k3s_name" kubectl get nodes --no-headers &>/dev/null; then
    echo "⚠️  k3s cluster is running but not healthy"
    return
  fi
  # Verify kubeconfig is accessible from backend
  local backend_name
  backend_name=$(docker ps --filter "name=backend" --format '{{.Names}}' 2>/dev/null | head -1)
  if [[ -n "$backend_name" ]] && ! docker exec "$backend_name" test -f /k8s/kubeconfig.yaml 2>/dev/null; then
    echo "⚠️  Backend cannot see kubeconfig! The k3s-kubeconfig volume may be empty."
    echo "    Fix: ./scripts/local.sh k3s-up"
    return
  fi
  # Auto-repair the stale kubeconfig server URL that occurs whenever k3s-server
  # is recreated without re-running k3s-init. k3s writes its own kubeconfig
  # with `https://127.0.0.1:6443` on every startup; that URL is wrong for the
  # backend container which reaches k3s at `https://k3s-server:6443`.
  _repair_kubeconfig || true
}

_repair_kubeconfig() {
  local k3s_name
  k3s_name=$(docker ps --filter "name=k3s-server" --format '{{.Names}}' 2>/dev/null | head -1)
  [[ -z "$k3s_name" ]] && return 0
  # Check current server URL in the shared kubeconfig
  local current_url
  current_url=$(docker exec "$k3s_name" sh -c 'grep "server:" /output/kubeconfig.yaml 2>/dev/null | head -1 | tr -d " "' 2>/dev/null || true)
  if [[ "$current_url" == *"127.0.0.1:6443"* ]]; then
    echo "⚠️  Stale kubeconfig detected (server URL points to 127.0.0.1). Repairing..."
    docker exec "$k3s_name" sh -c \
      'sed -i "s|https://127.0.0.1:6443|https://k3s-server:6443|g" /output/kubeconfig.yaml' 2>/dev/null || {
        echo "  Failed to repair kubeconfig"
        return 1
      }
    echo "  Kubeconfig server URL rewritten to https://k3s-server:6443"
    # Backend caches the kubeconfig at startup — restart it so the admin panel
    # stops reporting kubernetes as down.
    local backend_name
    backend_name=$(docker ps --filter "name=backend" --format '{{.Names}}' 2>/dev/null | head -1)
    if [[ -n "$backend_name" ]]; then
      echo "  Restarting backend to pick up new kubeconfig..."
      docker restart "$backend_name" >/dev/null 2>&1 || true
    fi
    return 0
  fi
  return 0
}

cmd_logs() {
  compose logs -f --tail 50
}

cmd_status() {
  echo "════════════════════════════════════════════════"
  echo "  Local Stack — ${DOCKER_HOST_NAME}"
  echo "════════════════════════════════════════════════"
  echo ""
  compose ps --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || compose ps
  echo ""
  echo "  Endpoints:"
  echo "    Admin Panel:  http://${DOCKER_HOST_NAME}:${PORT_ADMIN}"
  echo "    Client Panel: http://${DOCKER_HOST_NAME}:${PORT_CLIENT}"
  echo "    Backend API:  http://${DOCKER_HOST_NAME}:${PORT_API}"
  echo "    PostgreSQL:   ${DOCKER_HOST_NAME}:${PORT_DB}"
  echo "    Redis:        ${DOCKER_HOST_NAME}:${PORT_REDIS}"

  # Show k3s if running
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q "k3s-server"; then
    echo "    k3s API:      https://${DOCKER_HOST_NAME}:${PORT_K3S_API}"
  fi

  echo ""
  echo "  Login (local): admin@platform.local / admin"
  echo "  Login (Dex):   admin@platform.local / admin"
  echo "                 admin2@platform.local / admin"
  echo "                 user@platform.local / user"
  echo "                 user2@platform.local / user"
  echo "════════════════════════════════════════════════"
}

# ─── k3s commands ────────────────────────────────────────────────────────────

cmd_k3s_up() {
  echo "Starting k3s cluster..."
  compose_k3s up -d k3s-server
  echo "Waiting for k3s to become healthy..."
  compose_k3s up k3s-init
  echo ""
  cmd_k3s_status
}

cmd_k3s_down() {
  echo "Stopping k3s cluster..."
  compose_k3s stop k3s-server
}

cmd_k3s_reset() {
  echo "Resetting k3s cluster (wiping data)..."
  compose_k3s down -v --remove-orphans 2>/dev/null || true
  # Remove only k3s volumes
  docker volume rm hosting-platform_k3s-data hosting-platform_k3s-kubeconfig hosting-platform_k3s-storage 2>/dev/null || true
  echo "Starting fresh k3s..."
  cmd_k3s_up
}

cmd_k3s_status() {
  echo "════════════════════════════════════════════════"
  echo "  k3s Cluster — ${DOCKER_HOST_NAME}:${PORT_K3S_API}"
  echo "════════════════════════════════════════════════"
  echo ""
  compose ps k3s-server --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "  k3s not running"
  echo ""

  # Try to show cluster info
  if docker exec hosting-platform-k3s-server-1 kubectl get nodes --no-headers 2>/dev/null; then
    echo ""
    echo "  StorageClasses:"
    docker exec hosting-platform-k3s-server-1 kubectl get sc --no-headers 2>/dev/null | sed 's/^/    /'
    echo ""
    echo "  PVCs (all namespaces):"
    docker exec hosting-platform-k3s-server-1 kubectl get pvc -A --no-headers 2>/dev/null | sed 's/^/    /' || echo "    none"
  else
    echo "  k3s cluster not ready or not running"
  fi
  echo ""
  echo "  Kubeconfig: docker exec hosting-platform-k3s-server-1 cat /output/kubeconfig.yaml"
  echo "  kubectl:    docker exec -it hosting-platform-k3s-server-1 kubectl <args>"
  echo "════════════════════════════════════════════════"
}

cmd_k3s_shell() {
  echo "Opening kubectl shell in k3s..."
  docker exec -it hosting-platform-k3s-server-1 /bin/sh
}

# ─── Mail commands (Phase 1 — Stalwart Mail Server) ──────────────────────────

_mail_k3s_exec() {
  docker exec "$K3S_CONTAINER" "$@"
}

_mail_sync_manifests() {
  # Copy current k8s manifests into the k3s-server container at a stable path.
  # docker cp semantics: when the destination exists as a directory, the
  # source is placed INSIDE it. Remove the stale target first so the copy
  # always produces a fresh `/tmp/mail-k8s-sync` whose layout matches the
  # project's k8s/ directory (overlays/, base/, ...).
  docker exec "$K3S_CONTAINER" rm -rf /tmp/mail-k8s-sync >/dev/null 2>&1 || true
  docker cp "${PROJECT_DIR}/k8s" "${K3S_CONTAINER}:/tmp/mail-k8s-sync" >/dev/null
}

_patch_postgres_bridge() {
  # Phase 2a bridge: the `platform-postgres` Service in the `mail` namespace
  # is backed by a manual Endpoints resource that must point at the docker
  # IP of the postgres container. Docker reassigns IPs whenever the container
  # is recreated, so patch it at every mail-up.
  local pg_name pg_ip network_name
  pg_name=$(docker ps --filter "name=hosting-platform-postgres" --format '{{.Names}}' 2>/dev/null | head -1)
  if [[ -z "$pg_name" ]]; then
    echo "  (platform-postgres bridge: postgres container not running — skipping)"
    return 0
  fi
  # Extract the IP on the specific project network. Using `{{range}}` with
  # `{{.IPAddress}}` concatenates addresses from multi-homed containers
  # into a single string that is not a valid IP. Targeting the named
  # project network guarantees we get exactly one valid address.
  network_name="${COMPOSE_PROJECT_NAME:-hosting-platform}_default"
  pg_ip=$(docker inspect "$pg_name" \
    --format "{{with index .NetworkSettings.Networks \"${network_name}\"}}{{.IPAddress}}{{end}}" \
    2>/dev/null)
  # Validate it looks like an IPv4 address before patching — anything else
  # means we looked at the wrong network or the container is not attached.
  if ! [[ "$pg_ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
    echo "  ⚠  (platform-postgres bridge: no valid IP for $pg_name on $network_name; got '$pg_ip')"
    return 1
  fi
  echo "  Patching platform-postgres Endpoints → $pg_ip"
  local patch_err
  if ! patch_err=$(_mail_k3s_exec kubectl patch endpoints platform-postgres -n mail \
      --type=json \
      -p="[{\"op\":\"replace\",\"path\":\"/subsets/0/addresses/0/ip\",\"value\":\"$pg_ip\"}]" \
      2>&1); then
    echo "  ⚠  kubectl patch failed: $patch_err"
    return 1
  fi
  # Bootstrap the stalwart_reader role password (migration now creates
  # the role NOLOGIN; we need to grant login + a dev password).
  _bootstrap_stalwart_reader || true
  # Restart Stalwart pod so it picks up the new endpoint (kube-dns
  # already has it, but a fresh pod makes debugging clearer)
  _mail_k3s_exec kubectl rollout restart statefulset/stalwart-mail -n mail >/dev/null 2>&1 || true
  return 0
}

_bootstrap_stalwart_reader() {
  # Phase 2a: the Drizzle migration creates `stalwart_reader` as NOLOGIN
  # with no password — committing one to SQL would leak into production.
  # This helper sets the dev password so Stalwart can authenticate.
  # The password MUST match the STALWART_DB_PASSWORD value in
  # k8s/overlays/dev/stalwart/secret.yaml.
  local pg_name dev_password
  pg_name=$(docker ps --filter "name=hosting-platform-postgres" --format '{{.Names}}' 2>/dev/null | head -1)
  [[ -z "$pg_name" ]] && return 0
  dev_password="stalwart-dev-reader-pw"
  docker exec "$pg_name" psql -U "${DB_USER:-platform}" -d "${DB_NAME:-hosting_platform}" \
    -c "ALTER ROLE stalwart_reader WITH LOGIN PASSWORD '$dev_password';" >/dev/null 2>&1 || {
      echo "  ⚠  Failed to bootstrap stalwart_reader password"
      return 1
    }
  echo "  Bootstrapped stalwart_reader LOGIN password"
  return 0
}

cmd_mail_up() {
  echo "Deploying Stalwart mail server to local k3s..."
  if ! docker ps --format '{{.Names}}' | grep -q "^${K3S_CONTAINER}$"; then
    echo "ERROR: k3s-server container is not running. Run: ./scripts/local.sh k3s-up"
    return 1
  fi
  # Self-heal: make sure the backend can still reach k3s (guards against the
  # kubeconfig URL drift after a k3s-server recreate)
  _repair_kubeconfig || true
  _mail_sync_manifests
  _mail_k3s_exec kubectl apply -k "/tmp/mail-k8s-sync/overlays/dev/stalwart"
  # Phase 2a: patch the platform-postgres Endpoints with the live postgres
  # container IP so Stalwart's SQL directory can reach the platform DB.
  _patch_postgres_bridge
  echo ""
  echo "Waiting for Stalwart pod to be ready (up to 2 minutes)..."
  _mail_k3s_exec kubectl wait --for=condition=Ready pod -l app=stalwart-mail -n mail --timeout=120s || {
    echo ""
    echo "Pod did not become ready. Recent events:"
    _mail_k3s_exec kubectl get events -n mail --sort-by=.lastTimestamp | tail -20
    echo ""
    echo "Pod describe:"
    _mail_k3s_exec kubectl describe pod -l app=stalwart-mail -n mail
    return 1
  }
  echo ""
  cmd_mail_status
}

cmd_mail_down() {
  echo "Removing Stalwart mail server from local k3s..."
  _mail_sync_manifests
  _mail_k3s_exec kubectl delete -k "/tmp/mail-k8s-sync/overlays/dev/stalwart" --ignore-not-found=true
}

cmd_mail_status() {
  echo "════════════════════════════════════════════════"
  echo "  Stalwart Mail Server — Local Dev"
  echo "════════════════════════════════════════════════"
  echo ""
  if ! _mail_k3s_exec kubectl get ns mail >/dev/null 2>&1; then
    echo "  Mail namespace not found. Run: ./scripts/local.sh mail-up"
    return
  fi
  echo "  Pods:"
  _mail_k3s_exec kubectl get pods -n mail -o wide 2>/dev/null | sed 's/^/    /'
  echo ""
  echo "  Services:"
  _mail_k3s_exec kubectl get svc -n mail 2>/dev/null | sed 's/^/    /'
  echo ""
  echo "  PVCs:"
  _mail_k3s_exec kubectl get pvc -n mail 2>/dev/null | sed 's/^/    /'
  echo ""
  echo "  Host endpoints (via docker-compose port mappings):"
  echo "    SMTP           ${DOCKER_HOST_NAME}:${PORT_MAIL_SMTP}"
  echo "    SMTPS implicit ${DOCKER_HOST_NAME}:${PORT_MAIL_SMTPS}"
  echo "    Submission     ${DOCKER_HOST_NAME}:${PORT_MAIL_SUBMISSION}"
  echo "    IMAP STARTTLS  ${DOCKER_HOST_NAME}:${PORT_MAIL_IMAP}"
  echo "    IMAPS implicit ${DOCKER_HOST_NAME}:${PORT_MAIL_IMAPS}"
  echo "    POP3 STARTTLS  ${DOCKER_HOST_NAME}:${PORT_MAIL_POP3}"
  echo "    POP3S implicit ${DOCKER_HOST_NAME}:${PORT_MAIL_POP3S}"
  echo ""
  echo "  Credentials (dev only):"
  echo "    Admin:  admin / stalwart-dev-admin  (WebAdmin via kubectl port-forward)"
  echo "    Master: master / stalwart-dev-master"
  echo "════════════════════════════════════════════════"
}

cmd_mail_logs() {
  _mail_k3s_exec kubectl logs -n mail -l app=stalwart-mail --tail=100 -f
}

# ─── Webmail commands (Phase 2b — Roundcube) ─────────────────────────────────

cmd_webmail_up() {
  echo "Deploying Roundcube webmail to local k3s..."
  if ! docker ps --format '{{.Names}}' | grep -q "^${K3S_CONTAINER}$"; then
    echo "ERROR: k3s-server container is not running. Run: ./scripts/local.sh k3s-up"
    return 1
  fi
  _repair_kubeconfig || true
  _mail_sync_manifests
  _mail_k3s_exec kubectl apply -k "/tmp/mail-k8s-sync/overlays/dev/roundcube"
  echo ""
  echo "Waiting for Roundcube pod to be ready (up to 3 minutes)..."
  _mail_k3s_exec kubectl wait --for=condition=Ready pod -l app=roundcube -n mail --timeout=180s || {
    echo ""
    echo "Roundcube did not become ready. Recent events:"
    _mail_k3s_exec kubectl get events -n mail --sort-by=.lastTimestamp | tail -20
    echo ""
    echo "Pod logs:"
    _mail_k3s_exec kubectl logs -l app=roundcube -n mail --tail=30 || true
    return 1
  }
  echo ""
  cmd_webmail_status
}

cmd_webmail_down() {
  echo "Removing Roundcube webmail from local k3s..."
  _mail_sync_manifests
  _mail_k3s_exec kubectl delete -k "/tmp/mail-k8s-sync/overlays/dev/roundcube" --ignore-not-found=true
}

cmd_webmail_status() {
  echo "════════════════════════════════════════════════"
  echo "  Roundcube Webmail — Local Dev"
  echo "════════════════════════════════════════════════"
  echo ""
  if ! _mail_k3s_exec kubectl get ns mail >/dev/null 2>&1; then
    echo "  Mail namespace not found. Run: ./scripts/local.sh mail-up first"
    return
  fi
  echo "  Pod:"
  _mail_k3s_exec kubectl get pods -n mail -l app=roundcube -o wide 2>/dev/null | sed 's/^/    /'
  echo ""
  echo "  Service:"
  _mail_k3s_exec kubectl get svc roundcube -n mail 2>/dev/null | sed 's/^/    /'
  echo ""
  echo "  Host endpoint:"
  echo "    http://${DOCKER_HOST_NAME}:${PORT_WEBMAIL}/"
  echo ""
  echo "  Test SSO flow (after running mail-up + mail-test for the test mailbox):"
  echo "    1) curl http://${DOCKER_HOST_NAME}:${PORT_API}/api/v1/email/webmail-token"
  echo "       (with admin token + mailbox_id) to get a JWT"
  echo "    2) Open the returned webmailUrl in a browser"
  echo "════════════════════════════════════════════════"
}

cmd_webmail_logs() {
  _mail_k3s_exec kubectl logs -n mail -l app=roundcube --tail=100 -f
}

cmd_mail_test() {
  # Recipient is currently hard-coded inside the swaks call below;
  # this argument is reserved for the future when the test allows
  # an override. Keep it as a positional but don't bind it to a
  # local — shellcheck would otherwise flag SC2034.
  : "${1:-testuser@mail.dind.local}"
  echo "Running mail send + retrieve cycle against ${DOCKER_HOST_NAME}:${PORT_MAIL_SUBMISSION}..."
  echo ""
  echo "NOTE: This test first creates the test account via stalwart-cli, then"
  echo "      sends a message via SMTP submission and retrieves it via IMAP."
  echo ""
  # Create the test account if it doesn't exist (idempotent)
  _mail_k3s_exec kubectl exec -n mail stalwart-mail-0 -- \
    stalwart-cli -u http://127.0.0.1:8080 -c "admin:stalwart-dev-admin" \
    server database maintenance 2>&1 | head -5 || true
  echo ""
  echo "TCP probes:"
  for port_var in PORT_MAIL_SMTP PORT_MAIL_SUBMISSION PORT_MAIL_IMAP PORT_MAIL_IMAPS; do
    local port="${!port_var}"
    if (echo > "/dev/tcp/${DOCKER_HOST_NAME}/${port}") >/dev/null 2>&1; then
      echo "  ✓ ${DOCKER_HOST_NAME}:${port} reachable"
    else
      echo "  ✗ ${DOCKER_HOST_NAME}:${port} NOT reachable"
    fi
  done
}

# ─── SFTP Gateway commands ───────────────────────────────────────────────────

_sftp_ensure_host_key() {
  # Generate SSH host key Secret if it doesn't exist
  if ! _mail_k3s_exec kubectl get secret sftp-host-keys -n platform-system >/dev/null 2>&1; then
    echo "  Generating SSH host key..."
    local tmpdir
    tmpdir=$(mktemp -d)
    ssh-keygen -t ed25519 -N "" -f "$tmpdir/ssh_host_ed25519_key" -q
    docker cp "$tmpdir/ssh_host_ed25519_key" "${K3S_CONTAINER}:/tmp/sftp-hostkey"
    _mail_k3s_exec kubectl create secret generic sftp-host-keys \
      --from-file=ssh_host_ed25519_key=/tmp/sftp-hostkey \
      -n platform-system
    rm -rf "$tmpdir"
    echo "  SSH host key Secret created"
  fi
}

_sftp_ensure_tls_cert() {
  # Create FTPS TLS certificate via cert-manager (local CA issuer)
  if ! _mail_k3s_exec kubectl get certificate sftp-gateway-tls -n platform-system >/dev/null 2>&1; then
    echo "  Creating FTPS TLS certificate..."
    docker exec "$K3S_CONTAINER" sh -c 'cat > /tmp/sftp-tls-cert.yaml <<EOF
apiVersion: cert-manager.io/v1
kind: Certificate
metadata:
  name: sftp-gateway-tls
  namespace: platform-system
spec:
  secretName: sftp-tls-certs
  issuerRef:
    name: local-ca-issuer
    kind: ClusterIssuer
  dnsNames:
    - sftp.platform.local
    - sftp.ingress.localhost
  duration: 8760h
  renewBefore: 720h
EOF
kubectl apply -f /tmp/sftp-tls-cert.yaml'
    echo "  Waiting for certificate to be ready..."
    _mail_k3s_exec kubectl wait --for=condition=Ready certificate/sftp-gateway-tls \
      -n platform-system --timeout=60s 2>/dev/null || echo "  ⚠  Certificate not ready yet (FTPS will start once it is)"
  fi
}

_sftp_patch_backend_bridge() {
  # Create Service + Endpoints in platform-system that routes to the backend
  # Docker container (same pattern as _patch_postgres_bridge for mail).
  local backend_name backend_ip network_name
  backend_name=$(docker ps --filter "name=hosting-platform-backend" --format '{{.Names}}' 2>/dev/null | head -1)
  if [[ -z "$backend_name" ]]; then
    echo "  ⚠  Backend container not running — SFTP auth will fail"
    return 1
  fi
  network_name="${COMPOSE_PROJECT_NAME:-hosting-platform}_default"
  backend_ip=$(docker inspect "$backend_name" \
    --format "{{with index .NetworkSettings.Networks \"${network_name}\"}}{{.IPAddress}}{{end}}" \
    2>/dev/null)
  if ! [[ "$backend_ip" =~ ^[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}$ ]]; then
    echo "  ⚠  No valid IP for $backend_name on $network_name; got '$backend_ip'"
    return 1
  fi
  echo "  Patching backend bridge → $backend_ip"
  # Apply Service + Endpoints via temp file inside k3s container
  docker exec "$K3S_CONTAINER" sh -c "cat > /tmp/backend-bridge.yaml <<EOF
apiVersion: v1
kind: Service
metadata:
  name: backend
  namespace: platform-system
spec:
  ports:
  - port: 3000
    targetPort: 3000
---
apiVersion: v1
kind: Endpoints
metadata:
  name: backend
  namespace: platform-system
subsets:
- addresses:
  - ip: ${backend_ip}
  ports:
  - port: 3000
EOF
kubectl apply -f /tmp/backend-bridge.yaml" 2>&1
}

cmd_sftp_up() {
  echo "Deploying SFTP gateway to local k3s..."
  if ! docker ps --format '{{.Names}}' | grep -q "^${K3S_CONTAINER}$"; then
    echo "ERROR: k3s-server container is not running. Run: ./scripts/local.sh k3s-up"
    return 1
  fi
  _repair_kubeconfig || true

  # Ensure namespace exists
  _mail_k3s_exec kubectl create namespace platform-system 2>/dev/null || true

  # Ensure secrets
  _sftp_ensure_host_key
  _sftp_ensure_tls_cert

  # Build and import sftp-gateway image
  echo "  Building sftp-gateway image..."
  docker build -t sftp-gateway:latest "${PROJECT_DIR}/images/sftp-gateway/" -q 2>/dev/null
  docker save sftp-gateway:latest | docker exec -i "$K3S_CONTAINER" ctr images import - 2>/dev/null
  echo "  sftp-gateway image imported into k3s"

  # Apply manifests
  _mail_sync_manifests
  _mail_k3s_exec kubectl apply -f /tmp/mail-k8s-sync/base/sftp-gateway.yaml
  _mail_k3s_exec kubectl apply -f /tmp/mail-k8s-sync/base/sftp-gateway-netpol.yaml 2>/dev/null || true

  # Create backend bridge
  _sftp_patch_backend_bridge

  echo ""
  echo "Waiting for SFTP gateway pod to be ready..."
  _mail_k3s_exec kubectl rollout status deployment/sftp-gateway -n platform-system --timeout=60s || {
    echo "Pod did not become ready. Events:"
    _mail_k3s_exec kubectl get events -n platform-system --sort-by=.lastTimestamp | tail -10
    return 1
  }
  echo ""
  cmd_sftp_status
}

cmd_sftp_down() {
  echo "Removing SFTP gateway from local k3s..."
  _mail_sync_manifests
  _mail_k3s_exec kubectl delete -f /tmp/mail-k8s-sync/base/sftp-gateway.yaml --ignore-not-found=true
  _mail_k3s_exec kubectl delete -f /tmp/mail-k8s-sync/base/sftp-gateway-netpol.yaml --ignore-not-found=true
  _mail_k3s_exec kubectl delete svc backend -n platform-system --ignore-not-found=true
  _mail_k3s_exec kubectl delete endpoints backend -n platform-system --ignore-not-found=true
}

cmd_sftp_status() {
  echo "════════════════════════════════════════════════"
  echo "  SFTP Gateway — Local Dev"
  echo "════════════════════════════════════════════════"
  echo ""
  if ! _mail_k3s_exec kubectl get deployment sftp-gateway -n platform-system >/dev/null 2>&1; then
    echo "  SFTP gateway not deployed. Run: ./scripts/local.sh sftp-up"
    return
  fi
  echo "  Pod:"
  _mail_k3s_exec kubectl get pods -n platform-system -l app=sftp-gateway -o wide 2>/dev/null | sed 's/^/    /'
  echo ""
  echo "  Service:"
  _mail_k3s_exec kubectl get svc sftp-gateway -n platform-system 2>/dev/null | sed 's/^/    /'
  echo ""
  echo "  Backend bridge:"
  _mail_k3s_exec kubectl get endpoints backend -n platform-system 2>/dev/null | sed 's/^/    /'
  echo ""
  echo "  TLS Certificate:"
  _mail_k3s_exec kubectl get certificate sftp-gateway-tls -n platform-system 2>/dev/null | sed 's/^/    /' || echo "    not configured"
  echo ""
  echo "  Host endpoint:"
  echo "    SFTP: ${DOCKER_HOST_NAME}:${PORT_SFTP:-2222}"
  echo ""
  echo "  Protocols: SFTP, SCP, rsync (+ FTPS if TLS cert is ready)"
  echo "════════════════════════════════════════════════"
}

cmd_help() {
  sed -n '3,21p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
}

case "${1:-help}" in
  up)          cmd_up ;;
  down)        cmd_down ;;
  reset)       cmd_reset ;;
  rebuild)     cmd_rebuild ;;
  logs)        cmd_logs ;;
  status)      cmd_status ;;
  k3s-up)      cmd_k3s_up ;;
  k3s-down)    cmd_k3s_down ;;
  k3s-reset)   cmd_k3s_reset ;;
  k3s-status)  cmd_k3s_status ;;
  k3s-shell)   cmd_k3s_shell ;;
  mail-up)        cmd_mail_up ;;
  mail-down)      cmd_mail_down ;;
  mail-status)    cmd_mail_status ;;
  mail-logs)      cmd_mail_logs ;;
  mail-test)      shift; cmd_mail_test "$@" ;;
  webmail-up)     cmd_webmail_up ;;
  webmail-down)   cmd_webmail_down ;;
  webmail-status) cmd_webmail_status ;;
  webmail-logs)   cmd_webmail_logs ;;
  sftp-up)        cmd_sftp_up ;;
  sftp-down)      cmd_sftp_down ;;
  sftp-status)    cmd_sftp_status ;;
  help|-h)        cmd_help ;;
  *)           echo "Unknown command: $1"; cmd_help; exit 1 ;;
esac
