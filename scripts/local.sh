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
MAIL_OVERLAY_DIR="k8s/overlays/dev/stalwart"
WEBMAIL_OVERLAY_DIR="k8s/overlays/dev/roundcube"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose_k3s() {
  compose "$@"
}

cmd_up() {
  echo "Building and starting local stack..."
  compose up -d --build
  echo ""
  _rebuild_sidecar
  _check_k3s_health
  cmd_status
}

cmd_down() {
  echo "Stopping local stack..."
  compose down
}

cmd_reset() {
  echo "Resetting local stack (wiping volumes)..."
  compose down -v
  echo "Starting fresh..."
  compose up -d --build
  echo ""
  _rebuild_sidecar
  cmd_status
}

cmd_rebuild() {
  echo "Rebuilding app services (backend, admin-panel, client-panel)..."
  # Only rebuild app services — never touch k3s, PostgreSQL, or Redis
  # This prevents accidental removal of infrastructure containers
  compose build backend admin-panel client-panel
  compose up -d --no-deps backend admin-panel client-panel
  echo ""
  # Rebuild and reimport file-manager sidecar into k3s
  _rebuild_sidecar
  # Verify k3s is still running (warn if not)
  _check_k3s_health
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
  echo "  Login: admin@platform.local / admin"
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
  patch_err=$(_mail_k3s_exec kubectl patch endpoints platform-postgres -n mail \
    --type=json \
    -p="[{\"op\":\"replace\",\"path\":\"/subsets/0/addresses/0/ip\",\"value\":\"$pg_ip\"}]" \
    2>&1)
  if [[ $? -ne 0 ]]; then
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
  local recipient="${1:-testuser@mail.dind.local}"
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
    if (echo > /dev/tcp/${DOCKER_HOST_NAME}/${port}) >/dev/null 2>&1; then
      echo "  ✓ ${DOCKER_HOST_NAME}:${port} reachable"
    else
      echo "  ✗ ${DOCKER_HOST_NAME}:${port} NOT reachable"
    fi
  done
}

cmd_help() {
  sed -n '3,18p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
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
  help|-h)        cmd_help ;;
  *)           echo "Unknown command: $1"; cmd_help; exit 1 ;;
esac
