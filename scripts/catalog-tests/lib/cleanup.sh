#!/usr/bin/env bash
# Library: tenant teardown helpers.

# tear_down_tenant CLIENT_ID NAMESPACE
# Best-effort destruction of the test client, all its deployments, and the
# tenant namespace. Idempotent; suppresses errors so we don't leave a
# half-cleaned tenant blocking the next run.
tear_down_tenant() {
  local client_id="$1" ns="$2"
  if [[ -n "$client_id" ]]; then
    # Soft-delete first so the platform's lifecycle hooks unwind in
    # order; force-delete only if the soft-delete didn't take.
    api DELETE "/clients/${client_id}" >/dev/null 2>&1 || true
    api DELETE "/clients/${client_id}?force=true" >/dev/null 2>&1 || true
  fi
  if [[ -n "$ns" ]]; then
    # The platform's client lifecycle deletes the namespace via its own
    # cascade, but we belt-and-suspender to clear leftover state from
    # half-failed runs.
    kctl delete ns "$ns" --wait=false --ignore-not-found >/dev/null 2>&1 || true
  fi
}

# capture_evidence ENTRY_CODE NAMESPACE EVIDENCE_DIR
# On failure, snapshot the operator-debugging trio: pods describe, recent
# events, last 200 log lines per pod. Written under EVIDENCE_DIR/<entry>/.
capture_evidence() {
  local code="$1" ns="$2" dir="$3"
  local out="${dir}/${code}"
  mkdir -p "$out"
  kctl -n "$ns" get pods,svc,ingress,pvc -o wide > "${out}/resources.txt" 2>&1 || true
  kctl -n "$ns" describe pods > "${out}/describe-pods.txt" 2>&1 || true
  kctl -n "$ns" get events --sort-by=.lastTimestamp > "${out}/events.txt" 2>&1 || true
  # Logs per pod, all containers, last 200 lines.
  kctl -n "$ns" get pods -o name 2>/dev/null | while read -r pod; do
    local pname="${pod#pod/}"
    kctl -n "$ns" logs "$pod" --all-containers=true --tail=200 \
      > "${out}/logs-${pname}.txt" 2>&1 || true
  done
  echo "$out"
}
