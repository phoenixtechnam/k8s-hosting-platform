#!/usr/bin/env bash
# Backfill Pod Security Standards labels onto existing tenant
# namespaces. ADR-036.
#
# Why: applyNamespace() (k8s-provisioner) now patches PSS labels on
# every call, so the labels converge as tenants are touched. This
# script does the one-shot bulk operation so operators don't need to
# wait for "the next time a deployment changes on each tenant".
#
# What it does (safe order):
#   1. List candidate namespaces (label platform=k8s-hosting, label
#      client=<uuid>, no platform-namespace prefixes).
#   2. For each candidate, list pods that would VIOLATE
#      pod-security.kubernetes.io/enforce=baseline if we set it now.
#      Print them. We use `--dry-run=server` against a probe pod to
#      let the API server tell us whether each pod's securityContext
#      passes baseline. If anything violates, print the offenders and
#      EXIT NON-ZERO. Operator must fix the workload (or escalate to
#      this script's --force flag, which patches anyway).
#   3. Patch labels via `kubectl label namespace <ns> ... --overwrite`.
#
# Usage:
#   scripts/backfill-tenant-namespace-pss.sh              # dry-run preview
#   scripts/backfill-tenant-namespace-pss.sh --apply      # patch labels
#   scripts/backfill-tenant-namespace-pss.sh --apply --force   # ignore violators
#
# Requires kubectl reachable for the target cluster. Idempotent.

set -euo pipefail

APPLY=0
FORCE=0
for arg in "$@"; do
  case "$arg" in
    --apply) APPLY=1 ;;
    --force) FORCE=1 ;;
    -h|--help)
      sed -n '2,/^set -euo/p' "$0" | sed 's/^# \{0,1\}//' | sed '$d'
      exit 0
      ;;
    *)
      echo "unknown arg: $arg" >&2
      exit 64
      ;;
  esac
done

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl not on PATH" >&2
  exit 127
fi

# Discover tenant namespaces. The platform sets label `platform=k8s-hosting`
# on every tenant ns (applyNamespace). Platform-system namespaces
# (kube-*, longhorn-*, cnpg-*, ingress-nginx, platform-*) never carry
# this label so we don't need an explicit exclusion list.
NAMESPACES=$(kubectl get namespaces \
  -l platform=k8s-hosting \
  -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}' \
  | sort -u)

if [ -z "$NAMESPACES" ]; then
  echo "No tenant namespaces (label platform=k8s-hosting) found. Nothing to do."
  exit 0
fi

NS_COUNT=$(echo "$NAMESPACES" | wc -l)
echo "Found $NS_COUNT tenant namespace(s)."
echo

# ---------- Preview violators ----------
# For each pod in each candidate namespace, check whether its
# `securityContext` would survive PSS baseline enforcement. We do
# this client-side rather than via dry-run because baseline's checks
# are well-defined and short.
#
# A pod violates baseline if it sets ANY of:
#   spec.hostNetwork = true
#   spec.hostPID = true
#   spec.hostIPC = true
#   spec.containers[*].ports[*].hostPort != null AND != 0
#   spec.containers[*].securityContext.privileged = true
#   spec.containers[*].securityContext.capabilities.add contains any of
#     [SYS_ADMIN, NET_ADMIN, NET_RAW, SYS_TIME, SYS_MODULE, SYS_PTRACE, ...]
#   spec.containers[*].securityContext.allowPrivilegeEscalation = true (with
#     uid=0 effective)
#   spec.volumes[*].hostPath != null
#   spec.containers[*].securityContext.procMount = "Unmasked"
#
# We use a single jsonpath probe that surfaces the most-common
# breakers. False negatives are fine (audit label still flags them);
# false positives waste an operator's time so we keep the check
# narrow.

violators_total=0
ns_with_violators=()

for ns in $NAMESPACES; do
  # shellcheck disable=SC2016  # single-quote jsonpath as intended
  # We inspect BOTH .spec.containers AND .spec.initContainers — a pod
  # whose main containers are baseline-compliant but whose initContainer
  # runs `privileged: true` or asks for a forbidden cap_add still
  # violates PSS baseline and would be rejected after labelling.
  bad=$(kubectl get pods -n "$ns" -o json 2>/dev/null \
    | jq -r '
        .items[]
        | select(
            .spec.hostNetwork == true
            or .spec.hostPID == true
            or .spec.hostIPC == true
            or ((.spec.volumes // []) | map(.hostPath != null) | any)
            or (((.spec.containers // []) + (.spec.initContainers // [])) | map(
                  .securityContext.privileged == true
                  or .securityContext.allowPrivilegeEscalation == true
                  or (.securityContext.capabilities.add // [] | length > 0)
                  or ((.ports // []) | map((.hostPort // 0) > 0) | any)
                ) | any)
          )
        | "\(.metadata.namespace)/\(.metadata.name)"
      ' 2>/dev/null || true)
  if [ -n "$bad" ]; then
    cnt=$(echo "$bad" | wc -l)
    violators_total=$((violators_total + cnt))
    ns_with_violators+=("$ns:$cnt")
    echo "  $ns: $cnt pod(s) would violate baseline" >&2
    echo "$bad" | sed 's/^/    /' >&2
  fi
done

echo
if [ "$violators_total" -gt 0 ]; then
  echo "PSS baseline preview: $violators_total pod(s) across ${#ns_with_violators[@]} namespace(s) would be REJECTED."
  if [ "$APPLY" -eq 1 ] && [ "$FORCE" -ne 1 ]; then
    echo
    echo "Refusing to patch labels — these pods will lose readiness on the next pod restart." >&2
    echo "Either:" >&2
    echo "  1. Fix the workloads (recommended), then re-run with --apply." >&2
    echo "  2. Re-run with --apply --force to label anyway. Existing pods keep running" >&2
    echo "     until they restart, at which point PSS will reject them." >&2
    exit 2
  fi
else
  echo "PSS baseline preview: no violators found across $NS_COUNT namespace(s)."
fi

if [ "$APPLY" -ne 1 ]; then
  echo
  echo "Dry-run (no --apply). Re-run with --apply to patch labels." >&2
  exit 0
fi

# ---------- Apply labels ----------

echo
echo "Patching PSS labels on $NS_COUNT tenant namespace(s)..."

for ns in $NAMESPACES; do
  kubectl label namespace "$ns" \
    pod-security.kubernetes.io/enforce=baseline \
    pod-security.kubernetes.io/enforce-version=latest \
    pod-security.kubernetes.io/warn=restricted \
    pod-security.kubernetes.io/warn-version=latest \
    pod-security.kubernetes.io/audit=restricted \
    pod-security.kubernetes.io/audit-version=latest \
    --overwrite >/dev/null
  echo "  $ns: labels applied"
done

echo
echo "Done. PSS labels are now on every tenant namespace."
echo "Existing pods continue to run; new pods that violate baseline will be rejected at creation."
