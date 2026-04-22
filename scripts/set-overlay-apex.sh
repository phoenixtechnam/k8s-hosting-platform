#!/usr/bin/env bash
set -euo pipefail

# set-overlay-apex.sh — update the apex domain (and optionally the
# cert-manager ClusterIssuer) across every file in a kustomize overlay
# that references it. Replaces what used to be a manual three-file sed
# dance. Safe to re-run.
#
# Usage:
#   ./scripts/set-overlay-apex.sh <overlay-name> <new-apex> [<cluster-issuer>]
#
# Examples:
#   ./scripts/set-overlay-apex.sh staging staging.phoenix-host.net
#   ./scripts/set-overlay-apex.sh staging staging.example.com letsencrypt-prod-http01
#   ./scripts/set-overlay-apex.sh production example.com letsencrypt-prod-http01

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <overlay-name> <new-apex> [<cluster-issuer>]" >&2
  echo "" >&2
  echo "  overlay-name     one of: dev, staging, production" >&2
  echo "  new-apex         apex domain (e.g. staging.example.com)" >&2
  echo "  cluster-issuer   optional; one of letsencrypt-prod-http01," >&2
  echo "                   letsencrypt-staging-http01, local-ca-issuer" >&2
  exit 2
fi

OVERLAY="$1"
NEW_APEX="$2"
NEW_ISSUER="${3:-}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
OVERLAY_DIR="$REPO_ROOT/k8s/overlays/$OVERLAY"

if [[ ! -d "$OVERLAY_DIR" ]]; then
  echo "error: overlay directory not found: $OVERLAY_DIR" >&2
  exit 1
fi

# Apex-domain regex: lowercase hostname with dots. Rejects anything
# obviously wrong (spaces, leading/trailing dots, empty).
if ! [[ "$NEW_APEX" =~ ^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$ && "$NEW_APEX" == *.* ]]; then
  echo "error: invalid apex '$NEW_APEX' (expected lowercase hostname with at least one dot)" >&2
  exit 1
fi

if [[ -n "$NEW_ISSUER" ]]; then
  case "$NEW_ISSUER" in
    letsencrypt-prod-http01|letsencrypt-staging-http01|local-ca-issuer) ;;
    *)
      echo "error: unknown cluster-issuer '$NEW_ISSUER'" >&2
      echo "       allowed: letsencrypt-prod-http01, letsencrypt-staging-http01, local-ca-issuer" >&2
      exit 1
      ;;
  esac
fi

# Find the currently-configured apex by peeking at ingress-base-domain
# in platform-config-patch.yaml. Matches the key's quoted string value.
# The regex tolerates single or double quotes.
CUR_APEX=""
if [[ -f "$OVERLAY_DIR/platform-config-patch.yaml" ]]; then
  CUR_APEX=$(awk -F'"' '/^  ingress-base-domain:/ {print $2; exit}' \
               "$OVERLAY_DIR/platform-config-patch.yaml" || true)
fi

if [[ -z "$CUR_APEX" ]]; then
  echo "error: could not detect current apex in $OVERLAY_DIR/platform-config-patch.yaml" >&2
  echo "       make sure ingress-base-domain is set in that file before running this script" >&2
  exit 1
fi

if [[ "$CUR_APEX" == "$NEW_APEX" ]]; then
  echo "apex is already '$NEW_APEX' — nothing to replace"
else
  echo "→ replacing apex '$CUR_APEX' → '$NEW_APEX' in $OVERLAY_DIR/"
  # Quote hostnames to avoid `.` matching arbitrary chars — we escape
  # dots explicitly for the regex, but sed treats them literally inside
  # a character-class-free simple pattern.
  ESC_CUR=$(printf '%s\n' "$CUR_APEX" | sed 's/\./\\./g')
  # Process every yaml file in the overlay — including subdirs (dex/, etc.)
  while IFS= read -r -d '' f; do
    if grep -q "$CUR_APEX" "$f"; then
      sed -i "s|$ESC_CUR|$NEW_APEX|g" "$f"
      echo "  ✓ $f"
    fi
  done < <(find "$OVERLAY_DIR" -name '*.yaml' -print0)
fi

if [[ -n "$NEW_ISSUER" ]]; then
  CUR_ISSUER=""
  if [[ -f "$OVERLAY_DIR/platform-config-patch.yaml" ]]; then
    CUR_ISSUER=$(awk -F'"' '/^  cluster-issuer-name:/ {print $2; exit}' \
                   "$OVERLAY_DIR/platform-config-patch.yaml" || true)
  fi
  if [[ "$CUR_ISSUER" == "$NEW_ISSUER" ]]; then
    echo "cluster-issuer is already '$NEW_ISSUER' — nothing to replace"
  else
    echo "→ replacing cluster-issuer '$CUR_ISSUER' → '$NEW_ISSUER' in $OVERLAY_DIR/"
    while IFS= read -r -d '' f; do
      if [[ -n "$CUR_ISSUER" ]] && grep -q "$CUR_ISSUER" "$f"; then
        sed -i "s|$CUR_ISSUER|$NEW_ISSUER|g" "$f"
        echo "  ✓ $f"
      fi
    done < <(find "$OVERLAY_DIR" -name '*.yaml' -print0)
  fi
fi

echo ""
echo "Done. Verify the diff:"
echo "  git diff k8s/overlays/$OVERLAY/"
echo ""
echo "Then commit, push, and Flux will reconcile. If cert-manager had"
echo "already issued a cert with the old apex, delete it to force"
echo "re-issuance with the new SAN list:"
echo "  kubectl -n platform delete certificate,certificaterequest,order,challenge --all"
