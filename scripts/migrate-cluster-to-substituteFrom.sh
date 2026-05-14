#!/usr/bin/env bash
set -euo pipefail

# migrate-cluster-to-substituteFrom.sh — one-shot migration that wires
# an existing cluster's Flux Kustomization to use postBuild.substituteFrom
# from a per-cluster platform-cluster-config ConfigMap.
#
# Background: clusters bootstrapped before the postBuild templating
# pattern shipped have a Flux Kustomization that lacks
# `spec.postBuild.substituteFrom`. When the overlay manifests get
# updated to use ${DOMAIN} placeholders, those placeholders pass
# through Flux unsubstituted and the apply fails with
#   "Ingress longhorn-ui dry-run failed: spec.rules[0].host
#    Invalid value: 'longhorn.${DOMAIN}'"
#
# This script:
#   1. Creates ConfigMap/platform-cluster-config in flux-system with
#      DOMAIN=<arg> (idempotent kubectl apply).
#   2. Patches the existing Kustomization with the postBuild.substituteFrom
#      block referencing that ConfigMap.
#   3. Forces an immediate Flux reconcile.
#
# Usage (run on the cluster's control-plane node, or via SSH):
#   ./migrate-cluster-to-substituteFrom.sh <DOMAIN> [<KUSTOMIZATION_NAME>]
#
# Examples:
#   ./migrate-cluster-to-substituteFrom.sh staging.phoenix-host.net platform
#   ./migrate-cluster-to-substituteFrom.sh acme.example.com hosting-platform-staging

if [ $# -lt 1 ]; then
  echo "Usage: $0 <DOMAIN> [<KUSTOMIZATION_NAME>]" >&2
  echo >&2
  echo "  DOMAIN              cluster apex (e.g. staging.phoenix-host.net)" >&2
  echo "  KUSTOMIZATION_NAME  Flux Kustomization name (default: platform)" >&2
  exit 2
fi

DOMAIN="$1"
KUST_NAME="${2:-platform}"
KUST_NS="flux-system"

echo "── 1/3  applying ConfigMap/platform-cluster-config (DOMAIN=${DOMAIN}) ──"
kubectl -n "$KUST_NS" create configmap platform-cluster-config \
  --from-literal=DOMAIN="$DOMAIN" \
  --dry-run=client -o yaml | kubectl apply -f -

echo
echo "── 2/3  patching Kustomization/${KUST_NAME} to add postBuild.substituteFrom ──"
kubectl -n "$KUST_NS" patch kustomization "$KUST_NAME" --type=merge -p "$(cat <<EOF
{
  "spec": {
    "postBuild": {
      "substituteFrom": [
        { "kind": "ConfigMap", "name": "platform-cluster-config", "optional": false }
      ]
    }
  }
}
EOF
)"

echo
echo "── 3/3  forcing reconcile ──"
kubectl -n "$KUST_NS" annotate kustomization "$KUST_NAME" \
  reconcile.fluxcd.io/requestedAt="$(date -u +%FT%TZ)" --overwrite

echo
echo "✅ migration applied. monitor with:"
echo "    kubectl -n $KUST_NS get kustomization $KUST_NAME -w"
echo "    kubectl -n $KUST_NS describe kustomization $KUST_NAME | tail -20"
