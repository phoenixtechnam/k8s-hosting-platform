#!/usr/bin/env bash
# Verify every platform-managed system workload carries the expected
# role=server nodeAffinity in the rendered staging + production
# overlays. Guardrail for M1 — if someone adds a new system Deployment
# or StatefulSet to the base and forgets to include it in the
# system-node-affinity Kustomize component, that workload would fall
# back to scheduling anywhere (including a worker that the operator
# intended for tenants only). This check catches the drift.
#
# Dev overlay is intentionally skipped — the DinD single-node dev
# stack has no labelled node, so affinity is deliberately absent.
#
# Allowlist is maintained inline below. Add new system workloads here
# AND to k8s/components/system-node-affinity/kustomization.yaml (or
# inline in the overlay if they're overlay-specific like dex).
#
# Exit 1 if any entry on the allowlist renders without the affinity.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)

# Namespace/Kind/Name triples. Each MUST carry the role=server
# nodeAffinity in the rendered staging + production overlays, unless
# marked staging-only (dex only ships in staging for now).
#
# Format: "<namespace>|<kind>|<name>|<staging-only?>"
#   staging-only=1 → only checked against staging
#   staging-only=0 → checked against both overlays
WORKLOADS=(
  "platform|Deployment|admin-panel|0"
  "platform|Deployment|platform-api|0"
  "platform|Deployment|client-panel|0"
  "platform|Deployment|platform-suspended|0"
  "platform|Deployment|oauth2-proxy|0"
  "platform-system|Deployment|sftp-gateway|0"
  # stalwart-mail + dex are overlay-specific — only in staging for now.
  "mail|StatefulSet|stalwart-mail|1"
  "platform|Deployment|dex|1"
)
# postgres is a CNPG Cluster (postgresql.cnpg.io/v1). Its spec.affinity
# has its own schema (no .spec.template.spec.* path) so it is verified
# separately below. redis was removed in M14.
CNPG_CLUSTERS=(
  "platform|postgres|0"
)

OVERLAYS=(staging production)
failures=0

for overlay in "${OVERLAYS[@]}"; do
  overlay_dir="$REPO_ROOT/k8s/overlays/$overlay"
  if [[ ! -d "$overlay_dir" ]]; then
    echo "skip: $overlay_dir not found"
    continue
  fi

  if command -v kustomize >/dev/null 2>&1; then
    built=$(kustomize build "$overlay_dir")
  else
    built=$(kubectl kustomize "$overlay_dir")
  fi

  for spec in "${WORKLOADS[@]}"; do
    ns="${spec%%|*}"
    rest="${spec#*|}"
    kind="${rest%%|*}"
    rest="${rest#*|}"
    name="${rest%%|*}"
    staging_only="${rest#*|}"

    if [[ "$overlay" == "production" && "$staging_only" == "1" ]]; then
      continue
    fi

    # Pull the role label from the rendered workload. yq emits
    # "<value>" (with quotes) for literal scalars or the string
    # "null" when the path is missing.
    value=$(echo "$built" | yq eval-all --no-doc "
      select(
        .kind == \"$kind\"
        and .metadata.name == \"$name\"
        and (.metadata.namespace // \"default\") == \"$ns\"
      )
      | .spec.template.spec.affinity.nodeAffinity
          .requiredDuringSchedulingIgnoredDuringExecution
          .nodeSelectorTerms[0].matchExpressions[]
      | select(.key == \"platform.phoenix-host.net/node-role\")
      | .values[0]
    " - | head -n1)

    if [[ "$value" == "server" ]]; then
      echo "ok  [$overlay] $ns/$kind/$name → node-role=server"
    else
      echo "FAIL [$overlay] $ns/$kind/$name missing role=server nodeAffinity (value: '${value:-<none>}')"
      failures=$((failures + 1))
    fi
  done

  # CNPG Cluster CRs — schema is .spec.affinity.nodeSelector (flat
  # map), not .spec.template.spec.affinity.nodeAffinity.matchExpressions.
  for spec in "${CNPG_CLUSTERS[@]}"; do
    ns="${spec%%|*}"
    rest="${spec#*|}"
    name="${rest%%|*}"
    staging_only="${rest#*|}"

    if [[ "$overlay" == "production" && "$staging_only" == "1" ]]; then
      continue
    fi

    value=$(echo "$built" | yq eval-all --no-doc "
      select(
        .kind == \"Cluster\"
        and .apiVersion == \"postgresql.cnpg.io/v1\"
        and .metadata.name == \"$name\"
        and (.metadata.namespace // \"default\") == \"$ns\"
      )
      | .spec.affinity.nodeSelector[\"platform.phoenix-host.net/node-role\"]
    " - | head -n1)

    if [[ "$value" == "server" ]]; then
      echo "ok  [$overlay] $ns/Cluster(cnpg)/$name → node-role=server"
    else
      echo "FAIL [$overlay] $ns/Cluster(cnpg)/$name missing role=server nodeSelector (value: '${value:-<none>}')"
      failures=$((failures + 1))
    fi
  done
done

if (( failures > 0 )); then
  echo
  echo "✗ $failures system workload(s) missing role=server nodeAffinity."
  echo "  Update k8s/components/system-node-affinity/kustomization.yaml"
  echo "  OR the overlay kustomization (for overlay-only workloads like dex)."
  exit 1
fi

echo "✓ All system workloads in staging+production have role=server nodeAffinity."
