#!/usr/bin/env bash
# ci-tenant-bundles-resource-audit.sh — fail CI when a new K8s
# resource is created in a tenant namespace without a backup-coverage
# decision documented at the call site.
#
# Why: tenant-bundles capture is forward-only. Today the components
# are:
#   - files     captures PVC `${namespace}-storage`
#   - secrets   captures every `kubernetes.io/tls` Secret in ns
#   - mailboxes captures Stalwart mail accounts via IMAP
#   - config    captures DB rows from CONFIG_DUMP_TABLES
#
# Anything else created at runtime in a tenant namespace (a new
# PVC kind, an Opaque Secret holding tenant config, etc.) is silently
# excluded unless someone wires it into a component.
#
# This audit looks at every callsite that creates a Secret or PVC
# in source code and requires either:
#
#   1. A `// backup-coverage: captured-by:<component>` line above
#      OR on the same line — declares the component owning this
#      resource. Linked into Phase B's BundleComponent registry.
#
#   2. A `// backup-coverage: excluded:<reason>` line — declares the
#      resource is intentionally outside any bundle (e.g. cluster-
#      wide infrastructure that isn't tenant data).
#
# Anything else fails CI. Forces an explicit decision per call site.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Skip test files — those don't ship to prod and shouldn't have to
# carry the marker. The audit is about runtime code paths.
mapfile -t CALLSITES < <(
  # Match actual calls (.createNamespaced…(args) or
  # ).createNamespaced…(args)) — NOT type references like
  # Parameters<typeof core.createNamespacedSecret>[0].
  grep -rnE '\.(createNamespacedPersistentVolumeClaim|createNamespacedSecret)\(' \
    backend/src --include='*.ts' \
    --exclude='*.test.ts' --exclude='*.real-db.test.ts' \
    | sort -u
)

echo "── ci-tenant-bundles-resource-audit ──"
echo "  scanning ${#CALLSITES[@]} create-sites in backend/src/**/*.ts"

MISSING=()
for line in "${CALLSITES[@]}"; do
  # line format: path:lineno:content
  file=${line%%:*}
  rest=${line#*:}
  lineno=${rest%%:*}

  # Read the 5 lines before the call (annotation marker may be 1-5
  # lines above) plus the call line itself.
  start=$((lineno - 5))
  [[ $start -lt 1 ]] && start=1
  context=$(sed -n "${start},${lineno}p" "$file")
  if echo "$context" | grep -qE 'backup-coverage:[[:space:]]*(captured-by:[a-zA-Z0-9_-]+|excluded:[^[:space:]]+)'; then
    continue
  fi
  MISSING+=("$file:$lineno")
done

if [[ ${#MISSING[@]} -eq 0 ]]; then
  echo "✅ Every tenant Secret/PVC create-site has a backup-coverage marker."
  exit 0
fi

echo
echo "❌ Found ${#MISSING[@]} create-site(s) missing a backup-coverage marker:"
echo
for site in "${MISSING[@]}"; do
  echo "    - $site"
done
echo
echo "Add ONE of these comments at (or up to 5 lines above) each call:"
echo
echo "  // backup-coverage: captured-by:<component>"
echo "       e.g. captured-by:files / captured-by:secrets / captured-by:mailboxes"
echo
echo "  // backup-coverage: excluded:<reason>"
echo "       e.g. excluded:cluster-infrastructure"
echo "            excluded:transient-restore-token"
echo
echo "If you're adding a new tenant data dimension, also extend the"
echo "BundleComponent registry (see backend/src/modules/tenant-bundles/components/)."
exit 1
