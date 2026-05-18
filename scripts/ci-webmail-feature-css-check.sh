#!/usr/bin/env bash
#
# Webmail feature-visibility CSS check.
#
# Invariants (2026-05-18):
#
#   1. Every overlay that includes the Roundcube and/or Bulwark
#      Deployment MUST also include the `mail-feature-css` base module,
#      because both Deployments unconditionally mount the
#      `webmail-feature-overrides` ConfigMap. Without the CM the volume
#      reference fails and the Pod never starts.
#
#   2. The `webmail-feature-overrides` ConfigMap MUST carry both data
#      keys: `bulwark-overrides.css` and `roundcube-overrides.css`. The
#      Pods don't need them populated at boot — platform-api's
#      reconciler is the writer — but the keys must exist so kubelet
#      can mount them as files (kubelet won't create absent CM keys
#      as files, breaking the Pod start).
#
# Exit 1 on any violation.

set -euo pipefail

OVERLAYS=(dev/roundcube dev/bulwark staging production)
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
KUSTOMIZE="kubectl kustomize"

cd "$REPO_ROOT"

red() { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }

fail=0

for overlay in "${OVERLAYS[@]}"; do
  yellow "→ overlay k8s/overlays/$overlay"
  rendered=$($KUSTOMIZE "k8s/overlays/$overlay" 2>/dev/null) || {
    red "    build failed"
    fail=1
    continue
  }

  # ── Invariant 1: do any Deployments mount webmail-feature-overrides?
  deployments_referencing_cm=$(echo "$rendered" \
    | awk '/^kind: Deployment$/{p=1} p && /name: webmail-feature-overrides/{print "yes"; p=0}')

  # If the overlay ships Roundcube or Bulwark Pods, the CM MUST be defined.
  cm_defined=$(echo "$rendered" \
    | awk '/^kind: ConfigMap$/{p=1} p && /name: webmail-feature-overrides/{print "yes"; p=0}')

  if [ -n "$deployments_referencing_cm" ] && [ -z "$cm_defined" ]; then
    red "    a Pod references webmail-feature-overrides but the ConfigMap is NOT defined in this overlay"
    fail=1
    continue
  fi

  if [ -z "$deployments_referencing_cm" ]; then
    green "    no Roundcube/Bulwark Pods in this overlay — skipping"
    continue
  fi

  # ── Invariant 2: ConfigMap has both data keys.
  # kustomize emits `data:` BEFORE `kind: ConfigMap`, so we can't
  # awk-slice by kind. The keys are unique strings within the rendered
  # output, so we just grep globally.
  has_bulwark_key=$(echo "$rendered" | grep -c 'bulwark-overrides.css:' || true)
  has_roundcube_key=$(echo "$rendered" | grep -c 'roundcube-overrides.css:' || true)

  if [ "$has_bulwark_key" -lt 1 ] || [ "$has_roundcube_key" -lt 1 ]; then
    red "    webmail-feature-overrides ConfigMap is missing data keys (bulwark=$has_bulwark_key roundcube=$has_roundcube_key)"
    fail=1
    continue
  fi

  # ── Invariant 3: every webmail Deployment that references the CM
  # must carry the Flux SSA Merge annotation so platform-api's
  # webmail-feature-css reconciler can stamp the pod-template
  # annotation without Flux reverting it on the next sync. Bulwark +
  # Roundcube both ship with this in their base Deployments.
  missing_ssa=$(echo "$rendered" | awk '
    /^kind: Deployment$/ { in_dep=1; name=""; ssa=0; ref=0; next }
    in_dep && /^  name: / { name=$2 }
    in_dep && /kustomize\.toolkit\.fluxcd\.io\/ssa: [Mm]erge/ { ssa=1 }
    in_dep && /name: webmail-feature-overrides/ { ref=1 }
    /^---$/ && in_dep { if (ref && !ssa) print name; in_dep=0 }
    END { if (in_dep && ref && !ssa) print name }
  ')
  if [ -n "$missing_ssa" ]; then
    red "    Deployment(s) reference webmail-feature-overrides but lack kustomize.toolkit.fluxcd.io/ssa: Merge: $missing_ssa"
    red "    Flux would overwrite the feature-css-hash pod-template annotation, preventing rolling restarts on flag flips."
    fail=1
    continue
  fi

  green "    OK"
done

if [ "$fail" -eq 1 ]; then
  red "FAIL — webmail-feature-css invariants violated"
  exit 1
fi

green "OK — webmail-feature-css invariants hold in all overlays"
