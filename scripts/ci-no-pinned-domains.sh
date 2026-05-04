#!/usr/bin/env bash
set -euo pipefail

# ci-no-pinned-domains.sh — fail CI when committed YAML/TS/SH files
# contain hard-coded apex domain literals.
#
# Background: scripts/set-overlay-apex.sh used to sed-replace `${DOMAIN}`
# placeholders with literal apex strings into ~15 files per overlay,
# baking the apex into git. Any operator forking the repo for a new
# cluster inherited the previous operator's apex — the regression that
# broke passkey login on the new-domain server (RP_ID staging.phoenix-host.net
# rejected for a non-staging origin).
#
# The fix moved everything to Flux postBuild.substituteFrom: overlays
# carry literal `${DOMAIN}` placeholders; the platform-cluster-config
# ConfigMap (created by bootstrap.sh from --domain) supplies the real
# value at apply time. This script enforces that no apex literal slips
# back in.
#
# Allowed exceptions:
#   - test fixtures / *.test.ts / *.spec.ts
#   - YAML/TS comment lines
#   - examples in script `usage` / docs help text
#   - K8s annotation/label keys like `platform.phoenix-host.net/foo`
#     (these are project identifiers, not the cluster apex — see CLAUDE.md)

set +e
FOUND=0

# The literals to forbid (canonical apex values that have leaked before)
PATTERNS=(
  "staging\\.phoenix-host\\.net"
  "k8s-platform\\.test"
  "example\\.com"
)

# File globs to scan. We focus EXCLUSIVELY on the K8s manifest tree —
# this is where the regression happens (overlay files committed with
# baked-in apex literals via set-overlay-apex.sh). Shell scripts and
# backend/frontend code have their own env-overridable patterns and
# are tracked separately.
INCLUDE_GLOBS='--include=*.yaml --include=*.yml'
EXCLUDE_DIRS='--exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=.git'

for pattern in "${PATTERNS[@]}"; do
  echo "── checking for: ${pattern}"
  matches=$(
    grep -rn "$pattern" . $INCLUDE_GLOBS $EXCLUDE_DIRS 2>/dev/null \
      `# Comments` \
      | grep -vE '^[^:]+:[0-9]+:\s*#' \
      `# K8s annotation/label keys — project identifier, not the cluster apex.` \
      | grep -vE 'platform\.phoenix-host\.net/[a-zA-Z]' \
      `# The placeholder itself is allowed (this is what we WANT in overlays).` \
      | grep -vE '\$\{DOMAIN\}' \
      `# Cert-manager ClusterIssuer email — operator@example.com is the documented` \
      `# default; bootstrap.sh patches it via --acme-email.` \
      | grep -vE 'clusterissuer-.*\.yaml:.*email:.*operator@example\.com' \
      | grep -vE 'cluster-issuers\.reference\.yaml:.*email:.*admin@example\.com' \
      `# Flux Image Automation default committer email — never sent anywhere.` \
      | grep -vE 'image-update-automation\.yaml:.*flux@' \
      `# *.example.yaml are intentional template/sample files — kept literal.` \
      | grep -vE '\.example\.yaml' \
      `# Self-test admin/user emails inside overlay/dex/config.yaml — intentional.` \
      `# These are bcrypt-hashed test users for OIDC login flows; the email is` \
      `# never sent and the password is hashed inline.` \
      | grep -vE '/dex/config\.yaml:.*email:.*@' \
      `# Dev overlay (k8s/overlays/dev) uses literal k8s-platform.test for the` \
      `# local DinD apex. local.sh applies the dev overlay with plain` \
      `# kubectl apply -k (no envsubst), so ${DOMAIN} placeholders cannot be` \
      `# substituted there — the literal is intentional and required.` \
      | grep -vE '^\./k8s/overlays/dev/.*k8s-platform\.test' \
      || true
  )
  if [ -n "$matches" ]; then
    echo "    FOUND hard-coded literal:"
    echo "$matches" | sed 's|^|        |'
    FOUND=1
  fi
done

if [ $FOUND -ne 0 ]; then
  echo
  echo "❌ ci-no-pinned-domains: hard-coded apex domain literal(s) found."
  echo
  echo "All overlay manifests must use \${DOMAIN} placeholders. The real"
  echo "apex is supplied at apply time by Flux postBuild.substituteFrom"
  echo "from the platform-cluster-config ConfigMap (created by"
  echo "bootstrap.sh --domain <apex>). See docs/04-deployment/CLUSTER_NETWORK.md."
  exit 1
fi

echo "✅ ci-no-pinned-domains: no hard-coded apex literals in committed files."
