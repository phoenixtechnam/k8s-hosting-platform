#!/usr/bin/env bash
set -euo pipefail

# install-platform.sh — Install platform components on an existing k3s cluster.
#
# Usage:
#   ./scripts/install-platform.sh --kubeconfig <path>
#
# Options:
#   --kubeconfig   Path to kubeconfig file (required)
#   --skip-monitoring  Skip Prometheus/Loki installation
#   --skip-flux        Skip Flux v2 installation
#   --help             Show this help message

readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

KUBECONFIG_PATH=""
SKIP_MONITORING=false
SKIP_FLUX=false

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
      --kubeconfig)       KUBECONFIG_PATH="$2"; shift 2 ;;
      --skip-monitoring)  SKIP_MONITORING=true; shift ;;
      --skip-flux)        SKIP_FLUX=true; shift ;;
      --help|-h)          usage ;;
      *)                  error "Unknown option: $1" ;;
    esac
  done

  [[ -z "$KUBECONFIG_PATH" ]] && error "Missing required option: --kubeconfig <path>"
  [[ ! -f "$KUBECONFIG_PATH" ]] && error "Kubeconfig not found: $KUBECONFIG_PATH"
}

check_tools() {
  log "Checking required tools..."
  local missing=()

  command -v kubectl &>/dev/null || missing+=("kubectl")
  command -v helm    &>/dev/null || missing+=("helm")

  if [[ "$SKIP_FLUX" != true ]]; then
    command -v flux &>/dev/null || missing+=("flux")
  fi

  if [[ ${#missing[@]} -gt 0 ]]; then
    error "Missing required tools: ${missing[*]}. Install them and retry."
  fi

  log "All required tools found."
}

kctl() {
  kubectl --kubeconfig="$KUBECONFIG_PATH" "$@"
}

helm_cmd() {
  helm --kubeconfig="$KUBECONFIG_PATH" "$@"
}

verify_cluster() {
  log "Verifying cluster connectivity..."
  kctl cluster-info >/dev/null 2>&1 || error "Cannot connect to cluster. Check kubeconfig."
  kctl get nodes >/dev/null 2>&1 || error "Cannot list nodes. Check permissions."
  log "Cluster is reachable."
}

install_nginx_ingress() {
  log "Installing NGINX Ingress Controller..."

  if kctl get namespace ingress-nginx &>/dev/null 2>&1; then
    log "NGINX Ingress namespace already exists, checking deployment..."
    if kctl get deployment -n ingress-nginx ingress-nginx-controller &>/dev/null 2>&1; then
      log "NGINX Ingress already installed, skipping."
      return 0
    fi
  fi

  helm_cmd repo add ingress-nginx https://kubernetes.github.io/ingress-nginx 2>/dev/null || true
  helm_cmd repo update

  helm_cmd upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
    --namespace ingress-nginx \
    --create-namespace \
    --set controller.kind=DaemonSet \
    --set controller.hostPort.enabled=true \
    --set controller.service.type=ClusterIP \
    --set controller.metrics.enabled=true \
    --set controller.allowSnippetAnnotations=false \
    --wait \
    --timeout 300s

  log "NGINX Ingress Controller installed."
}

install_cert_manager() {
  log "Installing cert-manager..."

  if kctl get namespace cert-manager &>/dev/null 2>&1; then
    if kctl get deployment -n cert-manager cert-manager &>/dev/null 2>&1; then
      log "cert-manager already installed, skipping."
      return 0
    fi
  fi

  helm_cmd repo add jetstack https://charts.jetstack.io 2>/dev/null || true
  helm_cmd repo update

  helm_cmd upgrade --install cert-manager jetstack/cert-manager \
    --namespace cert-manager \
    --create-namespace \
    --set crds.enabled=true \
    --set prometheus.enabled=true \
    --wait \
    --timeout 300s

  # Create Let's Encrypt ClusterIssuer (staging + production)
  kctl apply -f - <<'EOF'
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: admin@phoenix-host.net
    privateKeySecretRef:
      name: letsencrypt-staging
    solvers:
    - http01:
        ingress:
          class: nginx
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-production
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: admin@phoenix-host.net
    privateKeySecretRef:
      name: letsencrypt-production
    solvers:
    - http01:
        ingress:
          class: nginx
EOF

  log "cert-manager installed with Let's Encrypt issuers."
}

install_sealed_secrets() {
  log "Installing Sealed Secrets..."

  if kctl get namespace kube-system &>/dev/null 2>&1; then
    if kctl get deployment -n kube-system sealed-secrets-controller &>/dev/null 2>&1; then
      log "Sealed Secrets already installed, skipping."
      return 0
    fi
  fi

  helm_cmd repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets 2>/dev/null || true
  helm_cmd repo update

  helm_cmd upgrade --install sealed-secrets sealed-secrets/sealed-secrets \
    --namespace kube-system \
    --set fullnameOverride=sealed-secrets-controller \
    --wait \
    --timeout 300s

  log "Sealed Secrets controller installed."
}

install_monitoring() {
  if [[ "$SKIP_MONITORING" == true ]]; then
    log "Skipping monitoring stack (--skip-monitoring)."
    return 0
  fi

  log "Installing Prometheus + Loki monitoring stack..."

  if kctl get namespace monitoring &>/dev/null 2>&1; then
    if kctl get statefulset -n monitoring prometheus-kube-prometheus-prometheus &>/dev/null 2>&1; then
      log "Prometheus already installed, skipping Prometheus."
    else
      install_prometheus
    fi
    if kctl get statefulset -n monitoring loki &>/dev/null 2>&1; then
      log "Loki already installed, skipping Loki."
    else
      install_loki
    fi
  else
    install_prometheus
    install_loki
  fi
}

install_prometheus() {
  log "Installing kube-prometheus-stack..."

  helm_cmd repo add prometheus-community https://prometheus-community.github.io/helm-charts 2>/dev/null || true
  helm_cmd repo update

  helm_cmd upgrade --install kube-prometheus prometheus-community/kube-prometheus-stack \
    --namespace monitoring \
    --create-namespace \
    --set prometheus.prometheusSpec.retention=7d \
    --set prometheus.prometheusSpec.resources.requests.memory=512Mi \
    --set prometheus.prometheusSpec.resources.requests.cpu=250m \
    --set prometheus.prometheusSpec.resources.limits.memory=1Gi \
    --set grafana.enabled=true \
    --set grafana.adminPassword=change-me \
    --set alertmanager.enabled=true \
    --wait \
    --timeout 600s

  log "kube-prometheus-stack installed."
}

install_loki() {
  log "Installing Loki..."

  helm_cmd repo add grafana https://grafana.github.io/helm-charts 2>/dev/null || true
  helm_cmd repo update

  helm_cmd upgrade --install loki grafana/loki-stack \
    --namespace monitoring \
    --create-namespace \
    --set loki.persistence.enabled=true \
    --set loki.persistence.size=5Gi \
    --set promtail.enabled=true \
    --wait \
    --timeout 300s

  log "Loki + Promtail installed."
}

install_flux() {
  if [[ "$SKIP_FLUX" == true ]]; then
    log "Skipping Flux v2 (--skip-flux)."
    return 0
  fi

  log "Installing Flux v2..."

  if kctl get namespace flux-system &>/dev/null 2>&1; then
    if kctl get deployment -n flux-system source-controller &>/dev/null 2>&1; then
      log "Flux already installed, skipping."
      return 0
    fi
  fi

  flux install --kubeconfig="$KUBECONFIG_PATH" --timeout=300s

  log "Flux v2 installed."
}

apply_kustomize_base() {
  log "Applying Kustomize base manifests..."

  local base_dir="${SCRIPT_DIR}/../k8s/base"
  if [[ -d "$base_dir" ]]; then
    kctl apply -k "$base_dir"
    log "Kustomize base manifests applied."
  else
    log "Warning: k8s/base directory not found at $base_dir, skipping."
  fi
}

print_summary() {
  log ""
  log "================================================"
  log "Platform installation complete!"
  log "================================================"
  log ""
  log "Installed components:"
  log "  - NGINX Ingress Controller"
  log "  - cert-manager (Let's Encrypt staging + production)"
  log "  - Sealed Secrets controller"
  [[ "$SKIP_MONITORING" != true ]] && log "  - Prometheus + Grafana + Alertmanager"
  [[ "$SKIP_MONITORING" != true ]] && log "  - Loki + Promtail"
  [[ "$SKIP_FLUX" != true ]]       && log "  - Flux v2"
  log "  - Kustomize base manifests (namespaces, RBAC, network policies, quotas)"
  log ""
  log "Verify with:"
  log "  kubectl --kubeconfig=${KUBECONFIG_PATH} get pods -A"
}

main() {
  parse_args "$@"
  check_tools
  verify_cluster

  install_nginx_ingress
  install_cert_manager
  install_sealed_secrets
  install_monitoring
  install_flux
  apply_kustomize_base

  print_summary
}

main "$@"
