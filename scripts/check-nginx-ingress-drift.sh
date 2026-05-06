#!/usr/bin/env bash
# check-nginx-ingress-drift.sh — detect (and optionally repair) per-node
# nginx-ingress controllers whose rendered nginx.conf is missing
# `server_name` entries for hosts that ARE present in the cluster's
# Ingress objects.
#
# Why this exists:
#   ingress-nginx is a DaemonSet; every node runs an independent copy
#   of nginx that watches the cluster for Ingress changes and renders
#   nginx.conf locally. Occasionally one node's controller misses an
#   update — the most likely cause is a watcher race during the rapid
#   reconcile sequences Flux fires when a kustomization applies. The
#   pod stays Ready (nginx is healthy and serves the routes it knows
#   about) so kube readinessProbes don't surface the problem. The
#   user-visible symptom is a 404 from one of the staging IPs while
#   the other two return 200 — caught during integration-oidc-dex.sh
#   on staging3 (2026-05-05).
#
# What this checks:
#   For every Ingress object across all namespaces, collect the set of
#   `spec.rules[].host` values. For every nginx-ingress pod, exec in
#   and `grep -c "server_name <host>" /etc/nginx/nginx.conf`. Report
#   each pod whose count != 1 for a given host.
#
# Repair mode:
#   With --repair, send `nginx -s reload` to every drifted pod. The
#   reload re-renders nginx.conf from the latest Ingress objects and
#   the missing `server_name` reappears. No restart, no traffic loss.
#
# Usage:
#   ./scripts/check-nginx-ingress-drift.sh                 # report only
#   ./scripts/check-nginx-ingress-drift.sh --repair        # auto-repair
#   ./scripts/check-nginx-ingress-drift.sh --hosts a,b,c   # only check these
#
# Env overrides:
#   KUBECONFIG  — kubeconfig path (default: /etc/rancher/k3s/k3s.yaml)
#   NAMESPACE   — ingress-nginx namespace (default: ingress-nginx)
#   SELECTOR    — pod label selector (default: app.kubernetes.io/name=ingress-nginx)
#
# Exit codes:
#   0  no drift
#   1  drift detected (and not repaired) OR repair was requested but failed
#   2  invalid CLI args / cluster unreachable

set -uo pipefail

REPAIR=0
HOSTS_ARG=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --repair) REPAIR=1; shift ;;
    --hosts) HOSTS_ARG="${2:-}"; shift 2 ;;
    -h|--help)
      sed -n '1,/^set -uo/p' "$0" | sed -e 's/^# \?//' -e '/^set/d' -e '/^$/d' | head -40
      exit 0
      ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

: "${KUBECONFIG:=/etc/rancher/k3s/k3s.yaml}"
: "${NAMESPACE:=ingress-nginx}"
: "${SELECTOR:=app.kubernetes.io/name=ingress-nginx}"
export KUBECONFIG

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'
log()  { printf '%b[%s]%b %s\n' "$CYAN" "$(date +%H:%M:%S)" "$RESET" "$*" >&2; }
ok()   { printf '  %b✓%b %s\n' "$GREEN" "$RESET" "$*" >&2; }
bad()  { printf '  %b✗%b %s\n' "$RED" "$RESET" "$*" >&2; }
warn() { printf '  %b⚠%b %s\n' "$YELLOW" "$RESET" "$*" >&2; }

# Collect expected hosts from cluster Ingress objects (or from --hosts).
if [[ -n "$HOSTS_ARG" ]]; then
  IFS=',' read -ra HOSTS <<< "$HOSTS_ARG"
else
  mapfile -t HOSTS < <(kubectl get ingress -A -o jsonpath='{range .items[*]}{range .spec.rules[*]}{.host}{"\n"}{end}{end}' 2>/dev/null \
    | grep -v '^$' | sort -u)
fi

if [[ ${#HOSTS[@]} -eq 0 ]]; then
  warn "no Ingress hosts found — nothing to check"
  exit 0
fi

log "checking ${#HOSTS[@]} expected host(s) across nginx-ingress pods"

mapfile -t PODS < <(kubectl get pod -n "$NAMESPACE" -l "$SELECTOR" -o name 2>/dev/null)
if [[ ${#PODS[@]} -eq 0 ]]; then
  bad "no nginx-ingress pods found in namespace=$NAMESPACE selector=$SELECTOR"
  exit 2
fi

drift_total=0
drifted_pods=()

for pod in "${PODS[@]}"; do
  pod_name="${pod#pod/}"
  pod_drift=0
  missing=()
  for host in "${HOSTS[@]}"; do
    # `server_name <host>` (with trailing whitespace + ;) — exact match.
    # We use a literal grep so wildcard hosts with regex chars still work.
    if ! kubectl exec -n "$NAMESPACE" "$pod_name" -c controller -- \
         grep -qF "server_name ${host} " /etc/nginx/nginx.conf 2>/dev/null \
       && ! kubectl exec -n "$NAMESPACE" "$pod_name" -c controller -- \
         grep -qF "server_name ${host};" /etc/nginx/nginx.conf 2>/dev/null
    then
      pod_drift=$((pod_drift + 1))
      missing+=("$host")
    fi
  done
  if [[ $pod_drift -eq 0 ]]; then
    ok "$pod_name — all ${#HOSTS[@]} hosts present"
  else
    bad "$pod_name — missing $pod_drift host(s): ${missing[*]}"
    drifted_pods+=("$pod_name")
    drift_total=$((drift_total + pod_drift))
  fi
done

if [[ $drift_total -eq 0 ]]; then
  log "no drift across ${#PODS[@]} nginx-ingress pods"
  exit 0
fi

if [[ $REPAIR -eq 0 ]]; then
  bad "drift detected — re-run with --repair to issue 'nginx -s reload' on each drifted pod"
  exit 1
fi

log "repairing ${#drifted_pods[@]} drifted pod(s) via nginx -s reload"
repair_failed=0
for pod_name in "${drifted_pods[@]}"; do
  if kubectl exec -n "$NAMESPACE" "$pod_name" -c controller -- nginx -s reload >/dev/null 2>&1; then
    ok "reloaded $pod_name"
  else
    bad "reload failed on $pod_name"
    repair_failed=$((repair_failed + 1))
  fi
done

[[ $repair_failed -eq 0 ]] || exit 1

# Re-verify after reload — give nginx ~3s to re-render config.
sleep 3
log "post-repair re-check"
post_drift=0
for pod_name in "${drifted_pods[@]}"; do
  for host in "${HOSTS[@]}"; do
    if ! kubectl exec -n "$NAMESPACE" "$pod_name" -c controller -- \
         grep -qF "server_name ${host}" /etc/nginx/nginx.conf 2>/dev/null
    then
      bad "$pod_name still missing $host after reload"
      post_drift=$((post_drift + 1))
    fi
  done
done

if [[ $post_drift -eq 0 ]]; then
  log "all drifted pods recovered"
  exit 0
else
  bad "$post_drift host(s) still missing after reload — manual investigation needed"
  exit 1
fi
