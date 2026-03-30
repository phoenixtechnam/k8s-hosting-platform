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

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

compose_k3s() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" --profile k3s "$@"
}

cmd_up() {
  echo "Building and starting local stack..."
  compose up -d --build
  echo ""
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
  cmd_status
}

cmd_rebuild() {
  echo "Rebuilding app services (backend, admin-panel, client-panel)..."
  # Only rebuild app services — never touch k3s, MariaDB, or Redis
  # This prevents accidental removal of infrastructure containers
  compose build backend admin-panel client-panel
  compose up -d --no-deps backend admin-panel client-panel
  echo ""
  # Verify k3s is still running (warn if not)
  _check_k3s_health
  cmd_status
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
  fi
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
  echo "    MariaDB:      ${DOCKER_HOST_NAME}:${PORT_DB}"
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
  help|-h)     cmd_help ;;
  *)           echo "Unknown command: $1"; cmd_help; exit 1 ;;
esac
