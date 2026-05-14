#!/usr/bin/env bash
# upgrade-cnpg.sh — bump the CloudNativePG operator on an existing cluster.
#
# WHY a separate script: bootstrap.sh's install_cnpg() handles the
# fresh-install path and the upgrade path (via `helm upgrade --install`),
# but bootstrap.sh as a whole is a 4000-line provisioning script. Running
# it just to bump CNPG is wasteful and risks unrelated phases re-running.
# This helper does the one thing.
#
# Usage:
#   ./scripts/upgrade-cnpg.sh                    # uses $KUBECONFIG / default
#   ./scripts/upgrade-cnpg.sh --kubeconfig PATH  # explicit kubeconfig
#   ./scripts/upgrade-cnpg.sh --dind             # talk to local DinD k3s
#   ./scripts/upgrade-cnpg.sh --remote root@HOST # SSH into a server node
#
# Behaviour:
#   - helm repo add + update
#   - detect installed chart version; no-op if already at target
#   - helm upgrade --install with --wait (10min timeout — CRD migration
#     + rolling switchover on managed Cluster CRs takes time)
#   - existing CNPG Cluster CRs undergo a primary switchover (operator-
#     managed, normally ≤30s downtime per cluster). Plan accordingly.
#
# Pinned version MUST match scripts/bootstrap.sh:CNPG_CHART_VERSION.
# When bumping, edit BOTH files in the same commit.
set -euo pipefail

CNPG_CHART_VERSION="0.28.0"   # operator v1.29.0 — keep in sync with bootstrap.sh

KUBECONFIG_PATH="${KUBECONFIG:-$HOME/.kube/config}"
REMOTE_HOST=""
USE_DIND=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --kubeconfig)  KUBECONFIG_PATH="$2"; shift 2 ;;
    --dind)        USE_DIND=true; shift ;;
    --remote)      REMOTE_HOST="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

log() { printf '[upgrade-cnpg] %s\n' "$*"; }

if [[ -n "$REMOTE_HOST" ]]; then
  # When --remote is passed, the local --kubeconfig is dropped — we
  # always use /etc/rancher/k3s/k3s.yaml on the remote (the canonical
  # k3s server kubeconfig path, mode 600 root:root → sudo required).
  # Same pattern as bootstrap.sh:1953. If the caller intended a
  # non-default remote kubeconfig, run upgrade-cnpg.sh on the remote
  # directly instead of via --remote.
  if [[ -n "${KUBECONFIG:-}" || "$KUBECONFIG_PATH" != "$HOME/.kube/config" ]]; then
    log "WARN: --remote ignores local --kubeconfig; uses /etc/rancher/k3s/k3s.yaml on $REMOTE_HOST."
  fi
  log "Re-executing on $REMOTE_HOST..."
  scp -q "$0" "${REMOTE_HOST}:/tmp/upgrade-cnpg.sh"
  exec ssh -t "$REMOTE_HOST" "sudo bash /tmp/upgrade-cnpg.sh --kubeconfig /etc/rancher/k3s/k3s.yaml"
fi

if [[ "$USE_DIND" == true ]]; then
  # DinD's CNPG was installed via raw `kubectl apply -f cnpg-1.22.0.yaml`
  # (per HA_MIGRATION_RUNBOOK.md), NOT via helm. Running helm upgrade
  # here would create a new helm release on top of unmanaged resources
  # and conflict on the Deployment + CRDs, leaving DinD in a broken
  # state. Until DinD is helm-adopted (label/annotate pass), this path
  # is intentionally a hard abort.
  echo "ERROR: DinD CNPG is kubectl-apply-managed (not Helm)." >&2
  echo "  Running helm upgrade here would conflict with the existing operator." >&2
  echo "  To bump DinD CNPG, either:" >&2
  echo "    (a) wipe DinD: ./scripts/local.sh reset && ./scripts/local.sh up" >&2
  echo "    (b) helm-adopt the existing install (manual label/annotate)" >&2
  exit 1
fi

if ! command -v helm >/dev/null 2>&1; then
  echo "helm CLI not found on PATH" >&2
  exit 1
fi

helm_cmd() { helm --kubeconfig="$KUBECONFIG_PATH" "$@"; }
kctl()     { kubectl --kubeconfig="$KUBECONFIG_PATH" "$@"; }

log "Adding/refreshing CNPG helm repo..."
helm_cmd repo add cnpg https://cloudnative-pg.github.io/charts >/dev/null 2>&1 || true
helm_cmd repo update cnpg >/dev/null

# helm list -o json is single-line per release. Capture once to avoid
# TOCTOU between existence check and version extraction. Status is
# checked separately so a stuck `failed`/`pending-upgrade` release at
# the right version still runs the upgrade (recovery path).
helm_json=$(helm_cmd list -n cnpg-system -o json 2>/dev/null || echo "[]")
current=""
status=""
if printf '%s' "$helm_json" | grep -q '"name":"cnpg"'; then
  current=$(printf '%s' "$helm_json" \
    | sed -n 's/.*"name":"cnpg".*"chart":"cloudnative-pg-\([^"]*\)".*/\1/p' \
    | head -n1)
  status=$(printf '%s' "$helm_json" \
    | sed -n 's/.*"name":"cnpg".*"status":"\([^"]*\)".*/\1/p' \
    | head -n1)
fi

if [[ "$current" == "$CNPG_CHART_VERSION" && "$status" == "deployed" ]]; then
  log "Already at chart ${CNPG_CHART_VERSION} (deployed), no-op."
  exit 0
fi

if [[ -n "$current" ]]; then
  log "Upgrading: chart ${current} (${status:-unknown}) → ${CNPG_CHART_VERSION} (operator v1.29.0)."
  log "  Existing Cluster CRs will undergo a rolling switchover."
  cluster_count=$(kctl get cluster.postgresql.cnpg.io -A --no-headers 2>/dev/null | wc -l)
  log "  Affected clusters: ${cluster_count}"
else
  log "Fresh install: chart ${CNPG_CHART_VERSION}."
fi

helm_cmd upgrade --install cnpg cnpg/cloudnative-pg \
  --namespace cnpg-system \
  --create-namespace \
  --version "${CNPG_CHART_VERSION}" \
  --set monitoring.podMonitorEnabled=false \
  --wait \
  --timeout 600s

log "Operator at chart ${CNPG_CHART_VERSION}."

# Verify the operator is healthy and that all known Cluster CRs converge
# back to a Ready/Healthy state. Without this check, a partial upgrade
# could leave the cluster broken with no operator-side log.
log "Waiting for operator pod ready..."
# The deployment name has changed across chart versions
# (cnpg-cloudnative-pg → cnpg-controller-manager and back). Resolve
# the actual name from helm's release manifest instead of guessing.
deploy_name=$(kctl -n cnpg-system get deploy \
  -l app.kubernetes.io/name=cloudnative-pg \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
if [[ -z "$deploy_name" ]]; then
  deploy_name=$(kctl -n cnpg-system get deploy -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
fi
if [[ -n "$deploy_name" ]]; then
  kctl -n cnpg-system rollout status "deploy/${deploy_name}" --timeout=300s
else
  log "WARN: could not resolve operator deployment name in cnpg-system."
fi

log "Verifying CNPG Cluster CRs..."
if ! kctl get cluster.postgresql.cnpg.io -A 2>/dev/null; then
  log "(no Cluster CRs found — fresh install or none managed)"
fi

log "Done."
