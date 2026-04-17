#!/usr/bin/env bash
set -euo pipefail

# local.sh — Manage the local development stack.
#
# All services run inside k3s using the same Kustomize manifests as production.
# Two modes available:
#
# Integration mode (everything in k3s):
#   ./scripts/local.sh up          Build images, deploy all pods to k3s
#   ./scripts/local.sh rebuild     Rebuild app images + rollout restart
#   ./scripts/local.sh down        Stop everything
#   ./scripts/local.sh reset       Wipe volumes, restart fresh
#
# Fast-dev mode (infra in k3s, apps on host with hot-reload):
#   ./scripts/local.sh dev         Start infra pods, print host dev instructions
#
# Shared commands:
#   ./scripts/local.sh logs [pod]  Tail logs (all pods or specific one)
#   ./scripts/local.sh status      Show status and endpoints
#   ./scripts/local.sh k3s-shell   Open kubectl shell in k3s
#   ./scripts/local.sh mail-up     Deploy Stalwart mail server (opt-in)
#   ./scripts/local.sh mail-down   Remove Stalwart
#   ./scripts/local.sh mail-status Show mail server state
#   ./scripts/local.sh mail-logs   Tail Stalwart logs
#   ./scripts/local.sh mail-test   Send + receive test mail
#   ./scripts/local.sh webmail-up     Deploy Roundcube (opt-in)
#   ./scripts/local.sh webmail-down   Remove Roundcube
#   ./scripts/local.sh webmail-status Show Roundcube state
#   ./scripts/local.sh webmail-logs   Tail Roundcube logs
#   ./scripts/local.sh sftp-up     Deploy SFTP gateway (opt-in)
#   ./scripts/local.sh sftp-down   Remove SFTP gateway
#   ./scripts/local.sh sftp-status Show SFTP gateway state
#   ./scripts/local.sh help        Show this help
#
# Environment: override via .env.local (see .env.local.example)

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly SCRIPT_DIR
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
readonly PROJECT_DIR

COMPOSE_FILE="${PROJECT_DIR}/docker-compose.local.yml"
ENV_FILE="${PROJECT_DIR}/.env.local"
ENV_LOCAL="${PROJECT_DIR}/.env.local.local"

# Load env files
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi
if [[ -f "$ENV_LOCAL" ]]; then
  set -a; source "$ENV_LOCAL"; set +a
fi

# Defaults — all host ports in 2010-2030 range
DOCKER_HOST_NAME="${DOCKER_HOST_NAME:-dind.local}"
PORT_INGRESS_HTTP="${PORT_INGRESS_HTTP:-2010}"
PORT_INGRESS_HTTPS="${PORT_INGRESS_HTTPS:-2011}"
# Backend API is not published — reach it via /api/* through the admin or
# client panel ingress (http://admin.k8s-platform.test:${PORT_INGRESS_HTTP}).
PORT_DB="${PORT_DB:-2013}"
PORT_REDIS="${PORT_REDIS:-2014}"
PORT_DEX="${PORT_DEX:-2015}"
PORT_K3S_API="${PORT_K3S_API:-2016}"
PORT_WEBMAIL="${PORT_WEBMAIL:-2017}"
PORT_OAUTH2_PROXY="${PORT_OAUTH2_PROXY:-2018}"
PORT_SFTP="${PORT_SFTP:-2019}"
PORT_MAIL_SMTP="${PORT_MAIL_SMTP:-2020}"
PORT_MAIL_SUBMISSION="${PORT_MAIL_SUBMISSION:-2021}"
PORT_MAIL_IMAP="${PORT_MAIL_IMAP:-2022}"
PORT_MAIL_IMAPS="${PORT_MAIL_IMAPS:-2023}"
PORT_MAIL_SMTPS="${PORT_MAIL_SMTPS:-2024}"
PORT_MAIL_POP3="${PORT_MAIL_POP3:-2025}"
PORT_MAIL_POP3S="${PORT_MAIL_POP3S:-2026}"

K3S_CONTAINER="${K3S_CONTAINER:-hosting-platform-k3s-server-1}"

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

k3s_exec() {
  docker exec "$K3S_CONTAINER" "$@"
}

# ─── Image management ───────────────────────────────────────────────────────

_build_and_import() {
  local name="$1" context="$2" dockerfile="$3"
  local tag="hosting-platform/${name}:local"
  echo "  Building ${name}..."
  docker build -t "$tag" -f "${PROJECT_DIR}/${dockerfile}" "${PROJECT_DIR}/${context}" -q >/dev/null
  echo "  Importing ${name} into k3s..."
  docker save "$tag" | docker exec -i "$K3S_CONTAINER" ctr images import - >/dev/null 2>&1
}

_build_all_images() {
  echo "Building and importing images into k3s (parallel)..."
  # Parallel builds — safe on direct filesystems (XFS/BTRFS), previously
  # serialized only for shfs/FUSE mounts which are no longer used.
  local pids=() logs=()
  local names=("backend" "admin-panel" "client-panel")
  local dockerfiles=("backend/Dockerfile" "frontend/admin-panel/Dockerfile" "frontend/client-panel/Dockerfile")
  local i
  for i in "${!names[@]}"; do
    local log
    log=$(mktemp)
    logs+=("$log")
    ( _build_and_import "${names[$i]}" "." "${dockerfiles[$i]}" ) >"$log" 2>&1 &
    pids+=($!)
  done

  local failed=0
  for i in "${!pids[@]}"; do
    if ! wait "${pids[$i]}"; then
      failed=$((failed + 1))
      echo "  ✗ ${names[$i]} build failed — log below:"
      sed 's/^/    /' "${logs[$i]}"
    else
      cat "${logs[$i]}"
    fi
    rm -f "${logs[$i]}"
  done
  if (( failed > 0 )); then
    echo "ERROR: $failed image build(s) failed"
    return 1
  fi

  # Sidecar images (sequential — small, rarely changed)
  if [[ -d "${PROJECT_DIR}/images/file-manager-sidecar" ]]; then
    _build_and_import "file-manager-sidecar" "images/file-manager-sidecar" "images/file-manager-sidecar/Dockerfile"
    # Also tag with GHCR name so base manifests resolve
    docker tag "hosting-platform/file-manager-sidecar:local" \
      "ghcr.io/phoenixtechnam/hosting-platform/file-manager-sidecar:latest"
    docker save "ghcr.io/phoenixtechnam/hosting-platform/file-manager-sidecar:latest" \
      | docker exec -i "$K3S_CONTAINER" ctr images import - >/dev/null 2>&1
  fi
  echo "  All images imported"
}

# ─── k3s infrastructure ─────────────────────────────────────────────────────

_ensure_k3s_running() {
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "k3s-server"; then
    echo "Starting k3s cluster..."
    compose up -d k3s-server
    echo "Running k3s init (ingress, cert-manager, namespaces)..."
    compose up k3s-init
  else
    echo "k3s already running"
  fi

  # Wait for API
  echo "Waiting for k3s API..."
  local retries=0
  while ! k3s_exec kubectl get nodes --no-headers &>/dev/null; do
    retries=$((retries + 1))
    if (( retries > 30 )); then
      echo "ERROR: k3s API not available after 60s"
      return 1
    fi
    sleep 2
  done
}

_sync_manifests() {
  # Copy k8s manifests into k3s container for kubectl apply
  docker exec "$K3S_CONTAINER" rm -rf /tmp/k8s-sync >/dev/null 2>&1 || true
  docker cp "${PROJECT_DIR}/k8s" "${K3S_CONTAINER}:/tmp/k8s-sync" >/dev/null
}

_apply_dev_overlay() {
  echo "Applying dev overlay..."
  _sync_manifests
  k3s_exec kubectl apply -k /tmp/k8s-sync/overlays/dev 2>&1 | grep -v "^$" | sed 's/^/  /'
}

_wait_for_pods() {
  local ns="${1:-platform}"
  echo "Waiting for pods in ${ns}..."
  k3s_exec kubectl wait --for=condition=Ready pod --all -n "$ns" --timeout=180s 2>/dev/null || {
    echo "Some pods not ready. Status:"
    k3s_exec kubectl get pods -n "$ns" | sed 's/^/  /'
    return 1
  }
}

_run_migrations_and_seed() {
  echo "Running database migrations + seed..."
  if ! k3s_exec kubectl exec -n platform deploy/platform-api -- node dist/db/migrate.js 2>&1 | tail -5 | sed 's/^/  /'; then
    echo "  ERROR: migrations failed"
    return 1
  fi
  k3s_exec kubectl exec -n platform deploy/platform-api -- node dist/db/seed.js 2>&1 | tail -8 | sed 's/^/  /' || true
}

_bootstrap_stalwart_reader() {
  # The Drizzle migration creates stalwart_reader as NOLOGIN. Set the dev password
  # so Stalwart can authenticate to the platform DB.
  k3s_exec kubectl exec -n platform postgres-0 -- \
    psql -U platform -d hosting_platform \
    -c "ALTER ROLE stalwart_reader WITH LOGIN PASSWORD 'stalwart-dev-reader-pw';" \
    >/dev/null 2>&1 || true
}

_cleanup_stale_namespaces() {
  local orphan_count
  orphan_count=$(k3s_exec kubectl get ns --no-headers 2>/dev/null \
    | awk '/^client-smoke-test-/ {n++} END {print n+0}')
  if (( orphan_count > 5 )); then
    echo "  Cleaning up $orphan_count stale smoke-test namespaces..."
    k3s_exec kubectl get ns --no-headers 2>/dev/null \
      | awk '/^client-smoke-test-/ {print $1}' \
      | while read -r ns; do
          k3s_exec kubectl delete ns "$ns" --wait=false >/dev/null 2>&1 || true
        done
  fi
}

# ─── Main commands ──────────────────────────────────────────────────────────

cmd_up() {
  echo "═══ Integration Mode: Full k3s ═══"
  echo ""
  _ensure_k3s_running
  _build_all_images
  _apply_dev_overlay
  _wait_for_pods platform
  _run_migrations_and_seed
  _bootstrap_stalwart_reader
  _cleanup_stale_namespaces
  echo ""
  cmd_status
}

cmd_dev() {
  echo "═══ Fast-Dev Mode: Infra in k3s, apps on host ═══"
  echo ""
  _ensure_k3s_running
  _apply_dev_overlay
  # Scale down app deployments — run on host instead
  echo "Scaling down app pods (running on host instead)..."
  k3s_exec kubectl scale deploy platform-api admin-panel client-panel -n platform --replicas=0 2>/dev/null
  # Wait for infra only
  echo "Waiting for infrastructure pods..."
  k3s_exec kubectl wait --for=condition=Ready pod -l app=postgres -n platform --timeout=120s 2>/dev/null || true
  k3s_exec kubectl wait --for=condition=Ready pod -l app=redis -n platform --timeout=60s 2>/dev/null || true
  _bootstrap_stalwart_reader
  echo ""
  echo "════════════════════════════════════════════════"
  echo "  Infrastructure ready!"
  echo ""
  echo "  Services in k3s:"
  echo "    PostgreSQL:   ${DOCKER_HOST_NAME}:${PORT_DB}"
  echo "    Redis:        ${DOCKER_HOST_NAME}:${PORT_REDIS}"
  echo "    Dex OIDC:     ${DOCKER_HOST_NAME}:${PORT_DEX}"
  echo ""
  echo "  Run in separate terminals:"
  echo "    cd backend && DATABASE_URL=postgresql://platform:local-dev-password@${DOCKER_HOST_NAME}:${PORT_DB}/hosting_platform \\"
  echo "      REDIS_URL=redis://${DOCKER_HOST_NAME}:${PORT_REDIS} \\"
  echo "      JWT_SECRET=local-dev-jwt-secret-not-for-production-use \\"
  echo "      OIDC_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \\"
  echo "      PLATFORM_INTERNAL_SECRET=local-dev-platform-internal-secret-please-rotate \\"
  echo "      DISABLE_RATE_LIMIT=true \\"
  echo "      npm run dev"
  echo ""
  echo "    cd frontend/admin-panel && npm run dev"
  echo "    cd frontend/client-panel && npm run dev"
  echo ""
  echo "  Access:"
  echo "    Backend:      http://localhost:3000"
  echo "    Admin Panel:  http://localhost:5173"
  echo "    Client Panel: http://localhost:5174"
  echo "════════════════════════════════════════════════"
}

cmd_down() {
  echo "Stopping local stack..."
  compose down
}

cmd_reset() {
  echo "Resetting local stack (wiping all volumes)..."
  compose down -v
  echo "Starting fresh..."
  cmd_up
}

cmd_rebuild() {
  echo "Rebuilding app images..."
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "k3s-server"; then
    echo "ERROR: k3s is not running. Use ./scripts/local.sh up first."
    return 1
  fi
  _build_all_images
  echo "Rolling out restarts..."
  k3s_exec kubectl rollout restart deploy/platform-api -n platform
  k3s_exec kubectl rollout restart deploy/admin-panel -n platform
  k3s_exec kubectl rollout restart deploy/client-panel -n platform
  echo "Waiting for pods..."
  _wait_for_pods platform
  echo ""
  cmd_status
}

cmd_logs() {
  local target="${1:-}"
  if [[ -n "$target" ]]; then
    k3s_exec kubectl logs -f --tail=100 -l "app=${target}" -n platform 2>/dev/null || \
      k3s_exec kubectl logs -f --tail=100 -l "app=${target}" -n mail 2>/dev/null || \
      echo "No pods found for app=${target}"
  else
    k3s_exec kubectl logs -f --tail=50 -n platform --all-containers=true --max-log-requests=20
  fi
}

cmd_status() {
  echo "════════════════════════════════════════════════"
  echo "  Local Stack — ${DOCKER_HOST_NAME}"
  echo "════════════════════════════════════════════════"
  echo ""
  echo "  Platform pods:"
  k3s_exec kubectl get pods -n platform -o wide 2>/dev/null | sed 's/^/    /' || echo "    (none)"
  echo ""

  # Detect mode
  local api_replicas
  api_replicas=$(k3s_exec kubectl get deploy platform-api -n platform -o jsonpath='{.spec.replicas}' 2>/dev/null || echo "0")
  if [[ "$api_replicas" == "0" ]]; then
    echo "  Mode: fast-dev (apps on host)"
    echo ""
    echo "  Infra endpoints:"
    echo "    PostgreSQL:     ${DOCKER_HOST_NAME}:${PORT_DB}"
    echo "    Redis:          ${DOCKER_HOST_NAME}:${PORT_REDIS}"
    echo "    Dex OIDC:       ${DOCKER_HOST_NAME}:${PORT_DEX}"
  else
    echo "  Mode: integration (all pods in k3s)"
    echo ""
    echo "  Endpoints:"
    echo "    Admin Panel:    http://admin.k8s-platform.test:${PORT_INGRESS_HTTP}  (https on :${PORT_INGRESS_HTTPS})"
    echo "    Client Panel:   http://client.k8s-platform.test:${PORT_INGRESS_HTTP}  (https on :${PORT_INGRESS_HTTPS})"
    echo "    PostgreSQL:     ${DOCKER_HOST_NAME}:${PORT_DB}"
    echo "    Redis:          ${DOCKER_HOST_NAME}:${PORT_REDIS}"
    echo "    Dex OIDC:       ${DOCKER_HOST_NAME}:${PORT_DEX}"
  fi

  echo "    k3s API:        https://${DOCKER_HOST_NAME}:${PORT_K3S_API}"
  echo ""

  # Show mail/webmail/sftp if deployed
  if k3s_exec kubectl get ns mail >/dev/null 2>&1; then
    local mail_pods
    mail_pods=$(k3s_exec kubectl get pods -n mail --no-headers 2>/dev/null | wc -l)
    if (( mail_pods > 0 )); then
      echo "  Mail server:"
      echo "    SMTP:           ${DOCKER_HOST_NAME}:${PORT_MAIL_SMTP}"
      echo "    Submission:     ${DOCKER_HOST_NAME}:${PORT_MAIL_SUBMISSION}"
      echo "    IMAP:           ${DOCKER_HOST_NAME}:${PORT_MAIL_IMAP}"
      echo "    IMAPS:          ${DOCKER_HOST_NAME}:${PORT_MAIL_IMAPS}"
      echo "    Webmail:        http://${DOCKER_HOST_NAME}:${PORT_WEBMAIL}"
      echo ""
    fi
  fi

  echo "  Login: admin@k8s-platform.test / admin"
  echo "════════════════════════════════════════════════"
}

cmd_k3s_shell() {
  docker exec -it "$K3S_CONTAINER" /bin/sh
}

cmd_k3s_status() {
  echo "════════════════════════════════════════════════"
  echo "  k3s Cluster — ${DOCKER_HOST_NAME}:${PORT_K3S_API}"
  echo "════════════════════════════════════════════════"
  echo ""
  compose ps k3s-server --format "table {{.Name}}\t{{.Status}}\t{{.Ports}}" 2>/dev/null || echo "  k3s not running"
  echo ""
  if k3s_exec kubectl get nodes --no-headers 2>/dev/null; then
    echo ""
    echo "  StorageClasses:"
    k3s_exec kubectl get sc --no-headers 2>/dev/null | sed 's/^/    /'
    echo ""
    echo "  All pods:"
    k3s_exec kubectl get pods -A --no-headers 2>/dev/null | sed 's/^/    /'
  else
    echo "  k3s cluster not ready"
  fi
  echo ""
  echo "  Shell: docker exec -it ${K3S_CONTAINER} /bin/sh"
  echo "════════════════════════════════════════════════"
}

# ─── Mail commands (Stalwart) ────────────────────────────────────────────────

cmd_mail_up() {
  echo "Deploying Stalwart mail server..."
  _ensure_k3s_running
  _sync_manifests
  k3s_exec kubectl apply -k /tmp/k8s-sync/overlays/dev/stalwart
  _bootstrap_stalwart_reader
  echo ""
  echo "Waiting for Stalwart pod (up to 2 minutes)..."
  k3s_exec kubectl wait --for=condition=Ready pod -l app=stalwart-mail -n mail --timeout=120s || {
    echo "Pod not ready. Events:"
    k3s_exec kubectl get events -n mail --sort-by=.lastTimestamp | tail -20
    return 1
  }
  echo ""
  cmd_mail_status
}

cmd_mail_down() {
  _sync_manifests
  k3s_exec kubectl delete -k /tmp/k8s-sync/overlays/dev/stalwart --ignore-not-found=true
}

cmd_mail_status() {
  echo "════════════════════════════════════════════════"
  echo "  Stalwart Mail Server"
  echo "════════════════════════════════════════════════"
  echo ""
  if ! k3s_exec kubectl get ns mail >/dev/null 2>&1; then
    echo "  Not deployed. Run: ./scripts/local.sh mail-up"
    return
  fi
  echo "  Pods:"
  k3s_exec kubectl get pods -n mail -o wide 2>/dev/null | sed 's/^/    /'
  echo ""
  echo "  Endpoints:"
  echo "    SMTP:       ${DOCKER_HOST_NAME}:${PORT_MAIL_SMTP}"
  echo "    Submission: ${DOCKER_HOST_NAME}:${PORT_MAIL_SUBMISSION}"
  echo "    IMAP:       ${DOCKER_HOST_NAME}:${PORT_MAIL_IMAP}"
  echo "    IMAPS:      ${DOCKER_HOST_NAME}:${PORT_MAIL_IMAPS}"
  echo "════════════════════════════════════════════════"
}

cmd_mail_logs() {
  k3s_exec kubectl logs -n mail -l app=stalwart-mail --tail=100 -f
}

cmd_mail_test() {
  echo "Running mail test against ${DOCKER_HOST_NAME}:${PORT_MAIL_SUBMISSION}..."
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

# ─── Webmail commands (Roundcube) ────────────────────────────────────────────

cmd_webmail_up() {
  echo "Deploying Roundcube webmail..."
  _ensure_k3s_running
  _sync_manifests
  k3s_exec kubectl apply -k /tmp/k8s-sync/overlays/dev/roundcube
  echo ""
  echo "Waiting for Roundcube pod (up to 3 minutes)..."
  k3s_exec kubectl wait --for=condition=Ready pod -l app=roundcube -n mail --timeout=180s || {
    echo "Roundcube not ready. Logs:"
    k3s_exec kubectl logs -l app=roundcube -n mail --tail=30 || true
    return 1
  }
  echo ""
  cmd_webmail_status
}

cmd_webmail_down() {
  _sync_manifests
  k3s_exec kubectl delete -k /tmp/k8s-sync/overlays/dev/roundcube --ignore-not-found=true
}

cmd_webmail_status() {
  echo "════════════════════════════════════════════════"
  echo "  Roundcube Webmail"
  echo "════════════════════════════════════════════════"
  echo ""
  echo "  Pod:"
  k3s_exec kubectl get pods -n mail -l app=roundcube -o wide 2>/dev/null | sed 's/^/    /'
  echo ""
  echo "  Endpoint: http://${DOCKER_HOST_NAME}:${PORT_WEBMAIL}/"
  echo "════════════════════════════════════════════════"
}

cmd_webmail_logs() {
  k3s_exec kubectl logs -n mail -l app=roundcube --tail=100 -f
}

# ─── SFTP Gateway commands ──────────────────────────────────────────────────

_sftp_ensure_host_key() {
  if ! k3s_exec kubectl get secret sftp-host-keys -n platform-system >/dev/null 2>&1; then
    echo "  Generating SSH host key..."
    local tmpdir
    tmpdir=$(mktemp -d)
    ssh-keygen -t ed25519 -N "" -f "$tmpdir/ssh_host_ed25519_key" -q
    docker cp "$tmpdir/ssh_host_ed25519_key" "${K3S_CONTAINER}:/tmp/sftp-hostkey"
    k3s_exec kubectl create namespace platform-system 2>/dev/null || true
    k3s_exec kubectl create secret generic sftp-host-keys \
      --from-file=ssh_host_ed25519_key=/tmp/sftp-hostkey \
      -n platform-system
    rm -rf "$tmpdir"
    echo "  SSH host key Secret created"
  fi
}

_sftp_ensure_tls_cert() {
  if ! k3s_exec kubectl get certificate sftp-gateway-tls -n platform-system >/dev/null 2>&1; then
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
    - sftp.k8s-platform.test
  duration: 8760h
  renewBefore: 720h
EOF
kubectl apply -f /tmp/sftp-tls-cert.yaml'
    k3s_exec kubectl wait --for=condition=Ready certificate/sftp-gateway-tls \
      -n platform-system --timeout=60s 2>/dev/null || echo "  Certificate not ready yet"
  fi
}

cmd_sftp_up() {
  echo "Deploying SFTP gateway..."
  _ensure_k3s_running

  k3s_exec kubectl create namespace platform-system 2>/dev/null || true
  _sftp_ensure_host_key
  _sftp_ensure_tls_cert

  # Build and import sftp-gateway image
  echo "  Building sftp-gateway image..."
  if [[ -d "${PROJECT_DIR}/images/sftp-gateway" ]]; then
    _build_and_import "sftp-gateway" "images/sftp-gateway" "images/sftp-gateway/Dockerfile"
    docker tag "hosting-platform/sftp-gateway:local" \
      "ghcr.io/phoenixtechnam/hosting-platform/sftp-gateway:latest"
    docker save "ghcr.io/phoenixtechnam/hosting-platform/sftp-gateway:latest" \
      | docker exec -i "$K3S_CONTAINER" ctr images import - >/dev/null 2>&1
  fi

  _sync_manifests
  k3s_exec kubectl apply -f /tmp/k8s-sync/base/sftp-gateway.yaml
  k3s_exec kubectl apply -f /tmp/k8s-sync/base/sftp-gateway-netpol.yaml 2>/dev/null || true

  echo ""
  echo "Waiting for SFTP gateway pod..."
  k3s_exec kubectl rollout status deployment/sftp-gateway -n platform-system --timeout=60s || {
    echo "Pod not ready. Events:"
    k3s_exec kubectl get events -n platform-system --sort-by=.lastTimestamp | tail -10
    return 1
  }
  echo ""
  cmd_sftp_status
}

cmd_sftp_down() {
  _sync_manifests
  k3s_exec kubectl delete -f /tmp/k8s-sync/base/sftp-gateway.yaml --ignore-not-found=true
  k3s_exec kubectl delete -f /tmp/k8s-sync/base/sftp-gateway-netpol.yaml --ignore-not-found=true
}

cmd_sftp_status() {
  echo "════════════════════════════════════════════════"
  echo "  SFTP Gateway"
  echo "════════════════════════════════════════════════"
  echo ""
  echo "  Pod:"
  k3s_exec kubectl get pods -n platform-system -l app=sftp-gateway -o wide 2>/dev/null | sed 's/^/    /'
  echo ""
  echo "  Endpoint: ${DOCKER_HOST_NAME}:${PORT_SFTP}"
  echo "════════════════════════════════════════════════"
}

# ─── Help & dispatch ─────────────────────────────────────────────────────────

cmd_help() {
  sed -n '3,36p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
}

case "${1:-help}" in
  up)             cmd_up ;;
  dev)            cmd_dev ;;
  down)           cmd_down ;;
  reset)          cmd_reset ;;
  rebuild)        cmd_rebuild ;;
  logs)           shift; cmd_logs "${1:-}" ;;
  status)         cmd_status ;;
  k3s-shell)      cmd_k3s_shell ;;
  k3s-status)     cmd_k3s_status ;;
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
  *)              echo "Unknown command: $1"; cmd_help; exit 1 ;;
esac
