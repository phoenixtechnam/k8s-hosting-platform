#!/usr/bin/env bash
set -euo pipefail

# local.sh — Manage the local development stack.
#
# All services run inside k3s using the same Kustomize manifests as production.
#
# Integration mode (everything in k3s):
#   ./scripts/local.sh up          Build images, deploy all pods to k3s
#   ./scripts/local.sh rebuild     Rebuild app images + rollout restart (content-hash skip)
#   ./scripts/local.sh down        Stop everything
#   ./scripts/local.sh reset       Wipe volumes, restart fresh
#
# `rebuild` is the iteration loop — 0s if nothing changed, ~20s per changed
# service. For the topology where the browser is on a different machine than
# the source tree, this is the only mode that works without port-forwarding.
#
# (A `dev` subcommand — apps on the workspace host, infra in k3s — exists in
# the source but is unwired from dispatch because its printed URLs point at
# localhost:3000/5173/5174 which aren't reachable from a remote browser. See
# cmd_dev() if you want to revisit — needs ingress-routing to host ports, or
# in-cluster HMR via hostPath + tsx/vite watch.)
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

# Load env files. shellcheck can't follow the paths statically since
# they're composed from $PROJECT_DIR — tell it not to try.
# shellcheck disable=SC1090
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi
# shellcheck disable=SC1090
if [[ -f "$ENV_LOCAL" ]]; then
  set -a; source "$ENV_LOCAL"; set +a
fi

# Defaults — all host ports in 2010-2030 range
#
# PLATFORM_BASE_DOMAIN is the apex for all user-facing URLs (admin, client,
# dex, webmail, mail, stalwart subdomains derive from it). The operator's
# internal DNS must resolve *.<base> to the cluster LB — no /etc/hosts
# entries required. Dev default: k8s-platform.test.
PLATFORM_BASE_DOMAIN="${PLATFORM_BASE_DOMAIN:-k8s-platform.test}"
#
# DIND_INTERNAL_HOST is the hostname this workspace container uses to reach
# the DinD daemon / k3s API (e.g., for `docker exec` into the DinD
# container and for the k3s TLS SAN). It is NEVER part of a user-facing
# URL — all services use subdomains of PLATFORM_BASE_DOMAIN. The legacy
# name DOCKER_HOST_NAME is still honored for backwards compat but renamed
# for clarity.
DIND_INTERNAL_HOST="${DIND_INTERNAL_HOST:-${DOCKER_HOST_NAME:-dind.local}}"
# Keep DOCKER_HOST_NAME as an alias so any sub-scripts / helpers that still
# read it continue to work.
DOCKER_HOST_NAME="${DIND_INTERNAL_HOST}"
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

# ─── Phase timing helpers ───────────────────────────────────────────────────
_PHASE_TIMINGS=()
_PHASE_START_EPOCH=""
_DEPLOY_START_EPOCH=""

_phase() {
  local label="$1"
  local now
  now=$(date +%s)
  if [[ -n "$_PHASE_START_EPOCH" ]]; then
    local prev_label="$_PHASE_CURRENT"
    local elapsed=$((now - _PHASE_START_EPOCH))
    _PHASE_TIMINGS+=("${elapsed}s  ${prev_label}")
  fi
  _PHASE_START_EPOCH="$now"
  _PHASE_CURRENT="$label"
  if [[ -z "$_DEPLOY_START_EPOCH" ]]; then
    _DEPLOY_START_EPOCH="$now"
  fi
}

_phase_summary() {
  # Close the current phase
  _phase "(end)"
  local total=$(( $(date +%s) - _DEPLOY_START_EPOCH ))
  echo ""
  echo "─── Phase timings ────────────────────────────────"
  for line in "${_PHASE_TIMINGS[@]}"; do
    printf "  %s\n" "$line"
  done
  printf "  ──\n  %ds  TOTAL\n" "$total"
  echo "──────────────────────────────────────────────────"
  # Reset for next invocation
  _PHASE_TIMINGS=()
  _PHASE_START_EPOCH=""
  _DEPLOY_START_EPOCH=""
  _PHASE_CURRENT=""
}

compose() {
  docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
}

k3s_exec() {
  docker exec "$K3S_CONTAINER" "$@"
}

# ─── Image management ───────────────────────────────────────────────────────

# Compute a content hash of inputs relevant to a given image. Used to skip
# docker build + ctr import when nothing the image depends on has changed.
_image_input_hash() {
  local name="$1"
  case "$name" in
    backend)
      # shellcheck disable=SC2038
      find "${PROJECT_DIR}/backend/src" "${PROJECT_DIR}/packages/api-contracts/src" \
           "${PROJECT_DIR}/backend/package.json" "${PROJECT_DIR}/backend/tsconfig.json" \
           "${PROJECT_DIR}/backend/Dockerfile" "${PROJECT_DIR}/backend/docker-entrypoint.sh" \
           "${PROJECT_DIR}/packages/api-contracts/package.json" \
           "${PROJECT_DIR}/packages/api-contracts/tsconfig.json" \
           "${PROJECT_DIR}/.dockerignore" \
           -type f 2>/dev/null | LC_ALL=C sort | xargs sha256sum 2>/dev/null | sha256sum | awk '{print $1}'
      ;;
    admin-panel|client-panel)
      local panel="$name"
      find "${PROJECT_DIR}/frontend/${panel}" "${PROJECT_DIR}/packages/api-contracts/src" \
           "${PROJECT_DIR}/packages/api-contracts/package.json" \
           "${PROJECT_DIR}/packages/api-contracts/tsconfig.json" \
           "${PROJECT_DIR}/frontend/docker-entrypoint.sh" \
           "${PROJECT_DIR}/.dockerignore" \
           -type f 2>/dev/null | LC_ALL=C sort | xargs sha256sum 2>/dev/null | sha256sum | awk '{print $1}'
      ;;
    file-manager)
      find "${PROJECT_DIR}/images/file-manager" \
           "${PROJECT_DIR}/.dockerignore" \
           -type f 2>/dev/null | LC_ALL=C sort | xargs sha256sum 2>/dev/null | sha256sum | awk '{print $1}'
      ;;
  esac
}

_image_label_hash() {
  local tag="$1"
  docker image inspect "$tag" --format '{{ index .Config.Labels "hp.input-hash" }}' 2>/dev/null || true
}

_image_in_k3s() {
  local tag="$1"
  docker exec "$K3S_CONTAINER" ctr images ls -q 2>/dev/null \
    | grep -qx "docker.io/${tag}"
}

# Import a docker image into k3s containerd with stderr surfaced and one
# retry. containerd can transiently refuse imports during warmup (seen
# repeatedly after `reset` when the k3s node restarts), so a blind silent
# pipeline loses visibility when the race bites.
_import_into_k3s() {
  local tag="$1"
  local attempt
  for attempt in 1 2; do
    if docker save "$tag" | docker exec -i "$K3S_CONTAINER" ctr images import - 2>&1 | sed 's/^/    /'; then
      return 0
    fi
    if (( attempt < 2 )); then
      echo "    (import failed, retrying in 2s...)"
      sleep 2
    fi
  done
  echo "    ERROR: import of $tag into k3s failed after 2 attempts" >&2
  return 1
}

_build_and_import() {
  local name="$1" context="$2" dockerfile="$3"
  local tag="hosting-platform/${name}:local"

  # Content-hash skip: compare desired input hash against the image's label.
  local want got
  want=$(_image_input_hash "$name")
  got=$(_image_label_hash "$tag")

  if [[ -n "$want" && "$want" == "$got" ]]; then
    # Build is unnecessary. But check k3s containerd actually still has the
    # image — after `down -v` or `dev` mode wiping k3s volumes, the Docker
    # daemon still has the tagged image but containerd does not, which caused
    # ErrImagePull when deployments scaled back up.
    if _image_in_k3s "$tag"; then
      echo "  ✓ ${name}: unchanged (hash ${want:0:12}), skipping build + import"
      echo "HP_IMAGE_UNCHANGED_${name}=1" >> "${PROJECT_DIR}/.local.build-state"
      return 0
    fi
    echo "  ↻ ${name}: unchanged but missing from k3s — re-importing"
    if ! _import_into_k3s "$tag"; then
      return 1
    fi
    # Treat as changed so cmd_rebuild rolls out pods that may be stuck in ErrImagePull
    echo "HP_IMAGE_CHANGED_${name}=1" >> "${PROJECT_DIR}/.local.build-state"
    return 0
  fi

  echo "  Building ${name}..."
  DOCKER_BUILDKIT=1 docker build \
    --label "hp.input-hash=${want}" \
    -t "$tag" -f "${PROJECT_DIR}/${dockerfile}" "${PROJECT_DIR}/${context}" -q >/dev/null
  echo "  Importing ${name} into k3s..."
  if ! _import_into_k3s "$tag"; then
    return 1
  fi
  echo "HP_IMAGE_CHANGED_${name}=1" >> "${PROJECT_DIR}/.local.build-state"
}

_build_all_images() {
  echo "Building and importing images into k3s (content-hash skip)..."
  # Reset build-state file so cmd_rebuild knows exactly which images changed.
  : > "${PROJECT_DIR}/.local.build-state"
  # Serial, not parallel. Concurrent `ctr images import` calls into the
  # same containerd socket race during k3s warmup — we lost three consecutive
  # `./scripts/local.sh reset` + `up` runs to transient import errors. A
  # ~3s speedup on cold start isn't worth the flakiness.
  local names=("backend" "admin-panel" "client-panel")
  local dockerfiles=("backend/Dockerfile" "frontend/admin-panel/Dockerfile" "frontend/client-panel/Dockerfile")
  local i
  for i in "${!names[@]}"; do
    if ! _build_and_import "${names[$i]}" "." "${dockerfiles[$i]}"; then
      echo "ERROR: ${names[$i]} build or import failed — see output above"
      return 1
    fi
  done

  # Sidecar image — content-hashed like the others. Base manifests reference
  # it by GHCR name, so on a real rebuild we also re-tag + re-import under
  # that name. The tag itself is idempotent and free; we only re-save+import
  # when the local image was actually rebuilt.
  if [[ -d "${PROJECT_DIR}/images/file-manager" ]]; then
    _build_and_import "file-manager" "images/file-manager" "images/file-manager/Dockerfile"
    # Backend references this image as the bare `file-manager:latest`
    # (see getFileManagerImage() helper at backend/src/modules/file-manager/image.ts).
    # Also keep the GHCR-prefixed tag for production parity — both point at
    # the same image. Re-import when the build changed OR when the target
    # tag is missing from k3s containerd (e.g. after `down -v` wiped it).
    local sidecar_changed=false
    if grep -q '^HP_IMAGE_CHANGED_file-manager=' "${PROJECT_DIR}/.local.build-state" 2>/dev/null; then
      sidecar_changed=true
    fi
    if [[ "$sidecar_changed" == true ]] || ! _image_in_k3s "file-manager:latest"; then
      docker tag "hosting-platform/file-manager:local" "file-manager:latest"
      docker save "file-manager:latest" \
        | docker exec -i "$K3S_CONTAINER" ctr images import - >/dev/null 2>&1
    fi
    if [[ "$sidecar_changed" == true ]] || ! _image_in_k3s "ghcr.io/phoenixtechnam/hosting-platform/file-manager:latest"; then
      docker tag "hosting-platform/file-manager:local" \
        "ghcr.io/phoenixtechnam/hosting-platform/file-manager:latest"
      docker save "ghcr.io/phoenixtechnam/hosting-platform/file-manager:latest" \
        | docker exec -i "$K3S_CONTAINER" ctr images import - >/dev/null 2>&1
    fi
  fi
  echo "  All images imported"
}

# ─── k3s infrastructure ─────────────────────────────────────────────────────

_ensure_k3s_running() {
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "k3s-server"; then
    echo "Starting k3s cluster..."
    compose up -d k3s-server
    # Wait for k3s API before running init (avoids retry loop inside init container)
    echo "Waiting for k3s API..."
    local retries=0
    while ! docker exec "$K3S_CONTAINER" kubectl get nodes --no-headers &>/dev/null; do
      retries=$((retries + 1))
      if (( retries > 30 )); then
        echo "ERROR: k3s API not available after 60s"
        return 1
      fi
      sleep 2
    done
    # Skip init if cert-manager + cnpg already installed (volumes
    # preserved). Otherwise run the heavyweight init Job. Note the
    # check no longer includes ingress-nginx (Traefik replaced it) —
    # the Traefik install is a separate phase below.
    if k3s_exec kubectl get deploy cert-manager -n cert-manager >/dev/null 2>&1 \
       && k3s_exec kubectl get deploy cnpg-controller-manager -n cnpg-system >/dev/null 2>&1; then
      echo "k3s infra already installed — skipping init"
    else
      echo "Running k3s init (cert-manager, cnpg, namespaces)..."
      compose up k3s-init
    fi
  else
    echo "k3s already running"
  fi
  # Label the single DinD node with the production "system" role label
  # so manifests that pin via nodeSelector
  # `platform.phoenix-host.net/node-role=server` (CNPG cluster, system
  # Deployments) actually schedule. Without this, postgres-1 stays Pending
  # forever and nothing comes up. Idempotent — kubectl label --overwrite.
  k3s_exec kubectl label node --all \
    platform.phoenix-host.net/node-role=server --overwrite >/dev/null 2>&1 || true

  # Traefik v3 + CrowdSec bouncer + ModSec plugin — same helm install
  # as scripts/bootstrap.sh's install_traefik so the local DinD stack
  # mirrors production. Skip if Traefik DaemonSet already exists.
  _install_traefik_local
}

# ─── Traefik install (mirrors scripts/bootstrap.sh install_traefik) ────────

# Constants must match scripts/bootstrap.sh — bump in lockstep.
TRAEFIK_CHART_VERSION_LOCAL="40.2.0"
CROWDSEC_PLUGIN_MODULE_LOCAL="github.com/maxlerebourg/crowdsec-bouncer-traefik-plugin"
CROWDSEC_PLUGIN_VERSION_LOCAL="v1.4.4"
MODSECURITY_PLUGIN_MODULE_LOCAL="github.com/madebymode/traefik-modsecurity-plugin"
MODSECURITY_PLUGIN_VERSION_LOCAL="v1.6.0"

# Generate / load the per-cluster CrowdSec bouncer key and ensure it
# exists as a K8s Secret in BOTH `crowdsec` AND `traefik` namespaces.
# Idempotent — reuses an existing key if one is already in either
# namespace. Mirrors scripts/bootstrap.sh's generate_crowdsec_bouncer_key.
_generate_crowdsec_bouncer_key_local() {
  local secret_name="crowdsec-bouncer-key"
  local key_value
  if k3s_exec kubectl get secret -n crowdsec "$secret_name" >/dev/null 2>&1; then
    key_value=$(k3s_exec kubectl get secret -n crowdsec "$secret_name" -o jsonpath='{.data.bouncer-key}' | base64 -d)
  elif k3s_exec kubectl get secret -n traefik "$secret_name" >/dev/null 2>&1; then
    key_value=$(k3s_exec kubectl get secret -n traefik "$secret_name" -o jsonpath='{.data.bouncer-key}' | base64 -d)
  else
    echo "Generating CrowdSec bouncer key..."
    key_value=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)
  fi
  for ns in crowdsec traefik; do
    k3s_exec kubectl get ns "$ns" >/dev/null 2>&1 \
      || k3s_exec kubectl create namespace "$ns" >/dev/null
    k3s_exec sh -c "kubectl create secret generic '$secret_name' \
      --namespace '$ns' \
      --from-literal=bouncer-key='$key_value' \
      --dry-run=client -o yaml | kubectl apply -f -" >/dev/null
  done
}

# Render the Traefik helm install on the workstation host (where helm
# is available — rancher/k3s container doesn't ship helm) and apply
# the rendered YAML inside the k3s container. Same flag-set as
# scripts/bootstrap.sh install_traefik so the local DinD WAF chain
# matches production.
_install_traefik_local() {
  if k3s_exec kubectl get daemonset -n traefik traefik >/dev/null 2>&1; then
    echo "Traefik already installed — skipping helm install."
    return 0
  fi

  command -v helm >/dev/null 2>&1 \
    || { echo "ERROR: helm not found on PATH — install helm to bring up the local Traefik stack." >&2; return 1; }

  echo "Generating CrowdSec bouncer key Secret (crowdsec + traefik namespaces)..."
  _generate_crowdsec_bouncer_key_local

  echo "Installing Traefik v3 (helm template + kubectl apply)..."
  helm repo add traefik https://traefik.github.io/charts >/dev/null 2>&1 || true
  helm repo update >/dev/null 2>&1

  # Apply Traefik CRDs FIRST. The Helm chart ships them in `crds/`,
  # which `helm template` does NOT render — only `helm install` does.
  # Without this step the subsequent kustomize apply fails with
  # "no matches for kind IngressRoute / Middleware in version
  # traefik.io/v1alpha1". Pull the chart locally, apply its crds/.
  local chart_dir
  chart_dir=$(mktemp -d)
  helm pull traefik/traefik --version "${TRAEFIK_CHART_VERSION_LOCAL}" --untar -d "${chart_dir}" >/dev/null 2>&1
  if [[ -d "${chart_dir}/traefik/crds" ]]; then
    cat "${chart_dir}/traefik/crds"/traefik.io_*.yaml | docker exec -i "$K3S_CONTAINER" kubectl apply --server-side -f - >/dev/null
  fi
  rm -rf "${chart_dir}"

  local rendered
  rendered=$(helm template traefik traefik/traefik \
    --version "${TRAEFIK_CHART_VERSION_LOCAL}" \
    --namespace traefik \
    --set deployment.kind=DaemonSet \
    --set 'ports.web.hostPort=80' \
    --set 'ports.websecure.hostPort=443' \
    --set service.spec.type=ClusterIP \
    --set providers.kubernetesCRD.enabled=true \
    --set providers.kubernetesCRD.allowCrossNamespace=true \
    --set providers.kubernetesCRD.allowExternalNameServices=true \
    --set providers.kubernetesIngress.enabled=false \
    --set "experimental.plugins.crowdsec.moduleName=${CROWDSEC_PLUGIN_MODULE_LOCAL}" \
    --set "experimental.plugins.crowdsec.version=${CROWDSEC_PLUGIN_VERSION_LOCAL}" \
    --set "experimental.plugins.modsecurity.moduleName=${MODSECURITY_PLUGIN_MODULE_LOCAL}" \
    --set "experimental.plugins.modsecurity.version=${MODSECURITY_PLUGIN_VERSION_LOCAL}" \
    --set 'volumes[0].name=crowdsec-bouncer-key' \
    --set 'volumes[0].mountPath=/var/run/secrets/crowdsec' \
    --set 'volumes[0].type=secret' \
    --set 'additionalArguments[0]=--entryPoints.web.forwardedHeaders.trustedIPs=127.0.0.1/32' \
    --set 'additionalArguments[1]=--entryPoints.websecure.forwardedHeaders.trustedIPs=127.0.0.1/32' \
    --set resources.requests.cpu=50m \
    --set resources.requests.memory=128Mi \
    --set resources.limits.memory=512Mi)

  # Pipe via stdin so we don't have to copy the file into the container.
  echo "$rendered" | docker exec -i "$K3S_CONTAINER" kubectl apply -f -

  echo "Waiting for Traefik DaemonSet (timeout 120s)..."
  k3s_exec kubectl wait --for=condition=Ready pod \
    -l app.kubernetes.io/name=traefik -n traefik --timeout=120s >/dev/null

  echo "Traefik installed. Plugins:"
  k3s_exec kubectl logs -n traefik daemonset/traefik 2>&1 \
    | grep -E "Loading plugins|Plugins loaded" | head -2 || true
}

_sync_manifests() {
  # Copy k8s manifests into k3s container for kubectl apply
  docker exec "$K3S_CONTAINER" rm -rf /tmp/k8s-sync >/dev/null 2>&1 || true
  docker cp "${PROJECT_DIR}/k8s" "${K3S_CONTAINER}:/tmp/k8s-sync" >/dev/null
}

_apply_dev_overlay() {
  echo "Applying dev overlay..."
  _sync_manifests
  # Production deploys via Flux Kustomization with postBuild.substituteFrom
  # which expands ${DOMAIN} from the cluster-config ConfigMap. Plain
  # `kubectl apply -k` does NOT do that — the literal "${DOMAIN}" survives
  # into the API server which rejects it as an invalid hostname. We render
  # locally with kustomize then envsubst-only-DOMAIN, then apply.
  #
  # We use `envsubst '${DOMAIN}'` (with the explicit allowlist) instead of
  # bare `envsubst` so other dollar-sign sequences in the manifests
  # (Stalwart's ${...} that Flux escapes, shell snippets in CronJobs, etc.)
  # pass through untouched.
  #
  # The `kubectl apply -f -` runs INSIDE the k3s container so the cluster
  # sees the envsubst-expanded YAML; we copy the rendered file in via
  # docker exec stdin.
  #
  # Pre-create namespaces that the base manifest references but only exist
  # in production (calico-system, longhorn-system, tigera-operator). The
  # LimitRange resources targeting those namespaces are no-ops in DinD but
  # we want apply to be clean (no NotFound errors in the log).
  k3s_exec kubectl create namespace calico-system 2>/dev/null || true
  k3s_exec kubectl create namespace longhorn-system 2>/dev/null || true
  k3s_exec kubectl create namespace tigera-operator 2>/dev/null || true

  local rendered
  rendered=$(k3s_exec kubectl kustomize /tmp/k8s-sync/overlays/dev 2>&1) || {
    echo "  kustomize build failed:"
    echo "$rendered" | sed 's/^/    /'
    return 1
  }
  # Substitute only the exact token ${DOMAIN}. Using sed instead of envsubst
  # (which is not always installed) and matching the literal token only
  # avoids accidentally rewriting other shell-style variables (Stalwart
  # bootstrap CronJob escapes, etc.).
  rendered=$(echo "$rendered" | sed "s|\${DOMAIN}|${PLATFORM_BASE_DOMAIN}|g")
  # Stage the rendered manifest on the workspace side then docker-cp into
  # the k3s container. Piping via `docker exec ... sh -c 'cat > file'`
  # silently fails when -i is missing (no stdin attached) — we hit that
  # exact bug in the 2026-05-07 broken-DinD recovery.
  local staged="${PROJECT_DIR}/.local.k8s-rendered.yaml"
  echo "$rendered" > "$staged"
  docker cp "$staged" "${K3S_CONTAINER}:/tmp/k8s-rendered.yaml"
  k3s_exec kubectl apply -f /tmp/k8s-rendered.yaml 2>&1 | grep -v "^$" | sed 's/^/  /'
}

_wait_for_cnpg_cluster() {
  # CNPG bootstrap creates a Cluster CR which the operator reconciles into:
  # 1) PVC for instance-1, 2) initdb Job pod, 3) Pod for instance-1.
  # Cold start with image pull (postgresql:17.5 is ~250 MiB) takes 90-180s.
  # We wait on the operator's `Ready` condition rather than pod-Ready because
  # CNPG's bootstrap Pods come and go — a single `kubectl wait pod --all`
  # races those transitions and reports false negatives.
  local ns="${1:-platform}"
  local name="${2:-postgres}"
  if ! k3s_exec kubectl -n "$ns" get cluster.postgresql.cnpg.io "$name" >/dev/null 2>&1; then
    return 0
  fi
  echo "Waiting for CNPG Cluster ${ns}/${name} to be Ready (up to 300s)..."
  if ! k3s_exec kubectl -n "$ns" wait --for=condition=Ready \
       cluster.postgresql.cnpg.io/"$name" --timeout=300s 2>/dev/null; then
    echo "CNPG Cluster ${ns}/${name} not Ready. Status:"
    k3s_exec kubectl -n "$ns" get cluster.postgresql.cnpg.io "$name" -o wide | sed 's/^/  /'
    k3s_exec kubectl -n "$ns" get pvc,pods -l cnpg.io/cluster="$name" | sed 's/^/  /'
    return 1
  fi
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
  # Inject local-dev system_settings defaults so a fresh `reset` + `up`
  # comes up with usable branding already populated. seed.ts respects
  # admin-configured values (uses COALESCE in ON CONFLICT DO UPDATE), so
  # running this repeatedly never clobbers a value the admin has changed.
  # kubectl exec has no --env flag (that's for `kubectl run`), so we wrap
  # in sh -c and export each value inline. All user-facing URLs derive
  # from PLATFORM_BASE_DOMAIN + the ingress port.
  local base="${PLATFORM_BASE_DOMAIN}"
  local http_port="${PORT_INGRESS_HTTP}"
  k3s_exec kubectl exec -n platform deploy/platform-api -- sh -c "
    export PLATFORM_BASE_DOMAIN='${base}'
    export ADMIN_PANEL_URL='http://admin.${base}:${http_port}'
    export CLIENT_PANEL_URL='http://client.${base}:${http_port}'
    export SUPPORT_EMAIL='admin@${base}'
    export INGRESS_BASE_DOMAIN='${base}'
    export PLATFORM_NAME='Hosting Platform (local dev)'
    node dist/db/seed.js
  " 2>&1 | tail -10 | sed 's/^/  /' || true
}

_bootstrap_stalwart_reader() {
  # The Drizzle migration creates stalwart_reader as NOLOGIN. Set the dev password
  # so Stalwart can authenticate to the platform DB.
  # Resolve current primary. Cluster name was renamed
  # `postgres` → `system-db` in the 2026-05-07 PG18 migration; try the
  # canonical name first, then legacy CNPG name, then legacy postgres-0.
  local pg_pod
  pg_pod=$(k3s_exec kubectl -n platform get pods \
    -l cnpg.io/cluster=system-db,role=primary \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  if [[ -z "$pg_pod" ]]; then
    pg_pod=$(k3s_exec kubectl -n platform get pods \
      -l cnpg.io/cluster=postgres,role=primary \
      -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  fi
  pg_pod="${pg_pod:-postgres-0}"
  k3s_exec kubectl exec -n platform "$pg_pod" -- \
    psql -U platform -d hosting_platform \
    -c "ALTER ROLE stalwart_reader WITH LOGIN PASSWORD 'stalwart-dev-reader-pw';" \
    >/dev/null 2>&1 || true
}

_generate_stalwart_secret() {
  # Invoke the shared helper that generates bcrypt-hashed admin + master
  # credentials + the platform-ns mirror Secret. Helper is idempotent:
  # if mail/stalwart-secrets already exists it's a no-op.
  # We run the helper on the host (this machine) but target k3s inside DinD
  # via `docker exec`.
  KUBECTL="docker exec -i ${K3S_CONTAINER} kubectl" \
    "${SCRIPT_DIR}/generate-stalwart-secret.sh" \
      --hostname="mail.${PLATFORM_BASE_DOMAIN}" \
      --db-password='stalwart-dev-reader-pw' \
      --db-host='platform-postgres.mail.svc.cluster.local' \
      --db-name='hosting_platform' \
      --db-user='stalwart_reader'
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
  # Run k3s infra bringup and image builds in parallel — they are
  # independent on a cold start (k8s API downloads + pod rollouts vs
  # local docker build). Image build typically finishes within the
  # time k3s-init waits for cert-manager + ingress-nginx.
  _phase "k3s infra + image build (overlapped)"
  local build_log
  build_log=$(mktemp)
  (_build_all_images) >"$build_log" 2>&1 &
  local build_pid=$!
  _ensure_k3s_running
  if ! wait "$build_pid"; then
    echo "ERROR: image build failed — log:"
    sed 's/^/  /' "$build_log"
    rm -f "$build_log"
    return 1
  fi
  sed 's/^/  /' "$build_log"
  rm -f "$build_log"

  # The platform-api Deployment mounts `platform-stalwart-creds` as a volume
  # unconditionally (see backend-patch.yaml). Without that Secret the pod
  # sits in ContainerCreating forever. The helper is idempotent — no-op
  # when the Secret already exists — so cheap to call every up.
  _phase "ensure stalwart creds"
  _generate_stalwart_secret

  _phase "kustomize apply"
  _apply_dev_overlay

  # Rollout-restart any deployments whose image actually changed. Without this,
  # a rebuild with the same `:local` tag leaves the old pod running because the
  # Deployment spec didn't change. cmd_rebuild does this too — the warm-path
  # of cmd_up needs the same behaviour.
  local state_file="${PROJECT_DIR}/.local.build-state"
  local changed_deploys=()
  if grep -q '^HP_IMAGE_CHANGED_backend=' "$state_file" 2>/dev/null; then
    changed_deploys+=(deploy/platform-api)
  fi
  if grep -q '^HP_IMAGE_CHANGED_admin-panel=' "$state_file" 2>/dev/null; then
    changed_deploys+=(deploy/admin-panel)
  fi
  if grep -q '^HP_IMAGE_CHANGED_client-panel=' "$state_file" 2>/dev/null; then
    changed_deploys+=(deploy/client-panel)
  fi
  if (( ${#changed_deploys[@]} > 0 )); then
    _phase "rollout restart (changed images)"
    echo "Rolling out: ${changed_deploys[*]}"
    k3s_exec kubectl rollout restart "${changed_deploys[@]}" -n platform
  fi

  _phase "wait for CNPG cluster"
  _wait_for_cnpg_cluster platform postgres

  _phase "wait for pods"
  _wait_for_pods platform
  if (( ${#changed_deploys[@]} > 0 )); then
    for d in "${changed_deploys[@]}"; do
      k3s_exec kubectl rollout status "$d" -n platform --timeout=120s
    done
  fi
  _phase "migrations + seed"
  _run_migrations_and_seed
  _phase "post-bootstrap"
  _bootstrap_stalwart_reader
  _cleanup_stale_namespaces
  _phase_summary
  echo ""
  cmd_status
}

# cmd_dev — currently unwired from dispatch. Left intact so we can revisit.
#
# The idea: run infrastructure (postgres, redis, dex, oauth2-proxy) in k3s and
# scale the app deployments to 0, then run `npm run dev` on the host for HMR.
# Problem in our topology: the workspace container is not the user's browser
# machine, and the printed URLs (localhost:3000/5173/5174) aren't reachable
# from outside. Revisiting this would mean either (a) publishing host dev
# server ports in the 2010-2030 range with an ingress rewrite in front, or
# (b) in-cluster HMR via hostPath + tsx watch / vite --host.
cmd_dev() {
  echo "═══ Fast-Dev Mode: Infra in k3s, apps on host ═══"
  echo ""
  _phase "k3s infra"
  _ensure_k3s_running
  _phase "kustomize apply"
  _apply_dev_overlay
  _phase "scale down app pods"
  echo "Scaling down app pods (running on host instead)..."
  k3s_exec kubectl scale deploy platform-api admin-panel client-panel -n platform --replicas=0 2>/dev/null
  _phase "wait for infra pods"
  echo "Waiting for infrastructure pods..."
  k3s_exec kubectl wait --for=condition=Ready pod -l app=postgres -n platform --timeout=120s 2>/dev/null || true
  k3s_exec kubectl wait --for=condition=Ready pod -l app=redis -n platform --timeout=60s 2>/dev/null || true
  _phase "post-bootstrap"
  _bootstrap_stalwart_reader
  _phase_summary
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
  echo "      PLATFORM_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \\"
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
  _phase "image build"
  _build_all_images

  # Only restart deployments whose image actually changed (content-hash skip).
  # shellcheck disable=SC1090,SC1091
  local state_file="${PROJECT_DIR}/.local.build-state"
  local changed_deploys=()
  if grep -q '^HP_IMAGE_CHANGED_backend=' "$state_file" 2>/dev/null; then
    changed_deploys+=(deploy/platform-api)
  fi
  if grep -q '^HP_IMAGE_CHANGED_admin-panel=' "$state_file" 2>/dev/null; then
    changed_deploys+=(deploy/admin-panel)
  fi
  if grep -q '^HP_IMAGE_CHANGED_client-panel=' "$state_file" 2>/dev/null; then
    changed_deploys+=(deploy/client-panel)
  fi

  if (( ${#changed_deploys[@]} == 0 )); then
    echo "  No images changed — skipping rollout."
    _phase_summary
    echo ""
    cmd_status
    return 0
  fi

  _phase "rollout restart"
  echo "Rolling out restarts for: ${changed_deploys[*]}"
  k3s_exec kubectl rollout restart "${changed_deploys[@]}" -n platform
  _phase "wait for pods"
  echo "Waiting for pods..."
  for d in "${changed_deploys[@]}"; do
    k3s_exec kubectl rollout status "$d" -n platform --timeout=120s
  done
  _phase_summary
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
  local base="${PLATFORM_BASE_DOMAIN}"
  echo "════════════════════════════════════════════════"
  echo "  Local Stack — apex ${base}"
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
    echo "    PostgreSQL:     postgres.${base}:${PORT_DB}"
    echo "    Redis:          redis.${base}:${PORT_REDIS}"
    echo "    Dex OIDC:       https://dex.${base}:${PORT_INGRESS_HTTPS}/dex"
  else
    echo "  Mode: integration (all pods in k3s)"
    echo ""
    echo "  Endpoints:"
    echo "    Admin Panel:    http://admin.${base}:${PORT_INGRESS_HTTP}  (https on :${PORT_INGRESS_HTTPS})"
    echo "    Client Panel:   http://client.${base}:${PORT_INGRESS_HTTP}  (https on :${PORT_INGRESS_HTTPS})"
    echo "    PostgreSQL:     postgres.${base}:${PORT_DB}"
    echo "    Redis:          redis.${base}:${PORT_REDIS}"
    echo "    Dex OIDC:       https://dex.${base}:${PORT_INGRESS_HTTPS}/dex"
  fi

  echo "    k3s API:        https://${DIND_INTERNAL_HOST}:${PORT_K3S_API}  (internal, cert SAN = ${DIND_INTERNAL_HOST})"
  echo ""

  # Show mail/webmail/sftp if deployed
  if k3s_exec kubectl get ns mail >/dev/null 2>&1; then
    local mail_pods
    mail_pods=$(k3s_exec kubectl get pods -n mail --no-headers 2>/dev/null | wc -l)
    if (( mail_pods > 0 )); then
      echo "  Mail server:"
      echo "    SMTP:           mail.${base}:${PORT_MAIL_SMTP}"
      echo "    Submission:     mail.${base}:${PORT_MAIL_SUBMISSION}"
      echo "    IMAP:           mail.${base}:${PORT_MAIL_IMAP}"
      echo "    IMAPS:          mail.${base}:${PORT_MAIL_IMAPS}"
      echo "    Webmail:        https://webmail.${base}:${PORT_INGRESS_HTTPS}"
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
  echo "  k3s Cluster — ${DIND_INTERNAL_HOST}:${PORT_K3S_API}"
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
  # M13: mail-up now deploys Stalwart 0.16 (stalwart-mail overlay).
  # The 0.15 overlay (overlays/dev/stalwart/) was removed in M13.
  # To remove any remaining 0.15 resources, run:
  #   ./scripts/cutover-stalwart-v015-to-v016.sh
  echo "Deploying Stalwart 0.16 mail server..."
  _ensure_k3s_running
  _sync_manifests
  k3s_exec kubectl apply -k /tmp/k8s-sync/overlays/dev/stalwart-mail
  echo ""
  echo "Waiting for Stalwart 0.16 pod (up to 3 minutes)..."
  k3s_exec kubectl wait --for=condition=Ready pod \
    -l app.kubernetes.io/name=stalwart-mail \
    -n mail --timeout=180s || {
    echo "Pod not ready within 3 minutes. Recent events:"
    k3s_exec kubectl get events -n mail --sort-by=.lastTimestamp | tail -20
    echo ""
    echo "Check CNPG mail-pg cluster is also ready:"
    k3s_exec kubectl get cluster mail-pg -n mail 2>/dev/null || true
    return 1
  }
  echo ""
  cmd_mail_status
  echo ""
  echo "════════════════════════════════════════════════"
  echo "  Stalwart 0.16 web-admin"
  echo "════════════════════════════════════════════════"
  echo "  URL: https://mail16-admin.k8s-platform.test:${PORT_INGRESS_HTTPS}/"
  echo ""
  echo "  Add this line to /etc/hosts (once) so your browser resolves it:"
  echo ""
  echo "    127.0.0.1  mail16-admin.k8s-platform.test"
  echo ""
  echo "  The subdomain is gated by the platform_session cookie."
  echo "════════════════════════════════════════════════"
}

# mail16-up: alias for mail-up (for backward compat with any scripts that
# used the pre-M13 separate command name).
cmd_mail16_up() { cmd_mail_up "$@"; }

cmd_mail_down() {
  _sync_manifests
  k3s_exec kubectl delete -k /tmp/k8s-sync/overlays/dev/stalwart-mail --ignore-not-found=true
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
  local mail_host="mail.${PLATFORM_BASE_DOMAIN}"
  echo "  Endpoints:"
  echo "    SMTP:       ${mail_host}:${PORT_MAIL_SMTP}"
  echo "    Submission: ${mail_host}:${PORT_MAIL_SUBMISSION}"
  echo "    IMAP:       ${mail_host}:${PORT_MAIL_IMAP}"
  echo "    IMAPS:      ${mail_host}:${PORT_MAIL_IMAPS}"
  echo "════════════════════════════════════════════════"
}

cmd_mail_logs() {
  k3s_exec kubectl logs -n mail -l app=stalwart-mail --tail=100 -f
}

cmd_mail_test() {
  local mail_host="mail.${PLATFORM_BASE_DOMAIN}"
  echo "Running mail test against ${mail_host}:${PORT_MAIL_SUBMISSION}..."
  echo ""
  echo "TCP probes:"
  for port_var in PORT_MAIL_SMTP PORT_MAIL_SUBMISSION PORT_MAIL_IMAP PORT_MAIL_IMAPS; do
    local port="${!port_var}"
    if (echo > "/dev/tcp/${mail_host}/${port}") >/dev/null 2>&1; then
      echo "  ✓ ${mail_host}:${port} reachable"
    else
      echo "  ✗ ${mail_host}:${port} NOT reachable"
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
  echo "  Endpoint: https://webmail.${PLATFORM_BASE_DOMAIN}:${PORT_INGRESS_HTTPS}/"
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
  echo "  Endpoint: sftp.${PLATFORM_BASE_DOMAIN}:${PORT_SFTP}"
  echo "════════════════════════════════════════════════"
}

# ─── Help & dispatch ─────────────────────────────────────────────────────────

cmd_help() {
  sed -n '3,36p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
}

case "${1:-help}" in
  up)             cmd_up ;;
  # dev mode is currently unwired — see the block comment at the top of this
  # file. The function is preserved in case we come back to it.
  # dev)          cmd_dev ;;
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
