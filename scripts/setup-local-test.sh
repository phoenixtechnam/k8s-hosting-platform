#!/usr/bin/env bash
set -euo pipefail

# setup-local-test.sh — Set up a local k3s-in-Docker (k3d) cluster for testing.
#
# Usage:
#   ./scripts/setup-local-test.sh [--delete]
#
# Options:
#   --delete    Delete the existing test cluster
#   --name      Cluster name (default: hosting-test)
#   --help      Show this help message
#
# Creates a k3d cluster with ports 80/443 mapped to localhost.

CLUSTER_NAME="hosting-test"
DELETE_MODE=false

usage() {
  sed -n '3,12p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
  exit 0
}

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

error() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2
  exit 1
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --delete)  DELETE_MODE=true; shift ;;
      --name)    CLUSTER_NAME="$2"; shift 2 ;;
      --help|-h) usage ;;
      *)         error "Unknown option: $1" ;;
    esac
  done
}

check_tools() {
  log "Checking required tools..."
  local missing=()

  command -v docker &>/dev/null || missing+=("docker")
  command -v k3d    &>/dev/null || missing+=("k3d")
  command -v kubectl &>/dev/null || missing+=("kubectl")

  if [[ ${#missing[@]} -gt 0 ]]; then
    error "Missing required tools: ${missing[*]}. Install them and retry."
  fi

  # Check Docker is running
  docker info &>/dev/null || error "Docker is not running. Start Docker and retry."

  log "All required tools found."
}

delete_cluster() {
  log "Deleting cluster '${CLUSTER_NAME}'..."
  if k3d cluster list | grep -q "$CLUSTER_NAME"; then
    k3d cluster delete "$CLUSTER_NAME"
    log "Cluster deleted."
  else
    log "Cluster '${CLUSTER_NAME}' does not exist."
  fi
}

create_cluster() {
  if k3d cluster list 2>/dev/null | grep -q "$CLUSTER_NAME"; then
    log "Cluster '${CLUSTER_NAME}' already exists."
    log "Use --delete to remove it first, or connect with:"
    log "  kubectl config use-context k3d-${CLUSTER_NAME}"
    return 0
  fi

  log "Creating k3d cluster '${CLUSTER_NAME}'..."

  k3d cluster create "$CLUSTER_NAME" \
    --port "80:80@loadbalancer" \
    --port "443:443@loadbalancer" \
    --k3s-arg "--disable=traefik@server:0" \
    --k3s-arg "--disable=servicelb@server:0" \
    --wait \
    --timeout 120s

  log "Cluster '${CLUSTER_NAME}' created."

  # Wait for nodes to be ready
  log "Waiting for node to be ready..."
  kubectl wait --for=condition=ready node --all --timeout=120s

  log ""
  log "================================================"
  log "Local test cluster is ready!"
  log "================================================"
  log ""
  log "Context: k3d-${CLUSTER_NAME}"
  log "Ports:   80 (HTTP), 443 (HTTPS) mapped to localhost"
  log ""
  log "Verify:"
  log "  kubectl get nodes"
  log "  kubectl get pods -A"
  log ""
  log "To install platform components:"
  log "  ./scripts/install-platform.sh --kubeconfig \$(k3d kubeconfig write ${CLUSTER_NAME})"
  log ""
  log "To delete:"
  log "  ./scripts/setup-local-test.sh --delete"
}

main() {
  parse_args "$@"
  check_tools

  if [[ "$DELETE_MODE" == true ]]; then
    delete_cluster
  else
    create_cluster
  fi
}

main "$@"
