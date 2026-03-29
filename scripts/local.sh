#!/usr/bin/env bash
set -euo pipefail

# local.sh — Manage the local development stack.
#
# Usage:
#   ./scripts/local.sh up        Build and start all services
#   ./scripts/local.sh down      Stop all services
#   ./scripts/local.sh reset     Stop, wipe volumes, and restart fresh
#   ./scripts/local.sh logs      Tail logs from all services
#   ./scripts/local.sh status    Show service status and endpoints
#   ./scripts/local.sh rebuild   Rebuild and restart (no volume wipe)
#   ./scripts/local.sh help      Show this help
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

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

cmd_up() {
  echo "Building and starting local stack..."
  compose up -d --build
  echo ""
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
  echo "Rebuilding local stack..."
  compose up -d --build --force-recreate
  echo ""
  cmd_status
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
  echo ""
  echo "  Login: admin@platform.local / admin"
  echo "════════════════════════════════════════════════"
}

cmd_help() {
  sed -n '3,14p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
}

case "${1:-help}" in
  up)       cmd_up ;;
  down)     cmd_down ;;
  reset)    cmd_reset ;;
  rebuild)  cmd_rebuild ;;
  logs)     cmd_logs ;;
  status)   cmd_status ;;
  help|-h)  cmd_help ;;
  *)        echo "Unknown command: $1"; cmd_help; exit 1 ;;
esac
