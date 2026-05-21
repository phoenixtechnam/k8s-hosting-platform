#!/usr/bin/env bash
# ci-security-hub-redirects.sh — guard the legacy → Security Hub
# URL redirects after the 2026-05-21 navigation refactor.
#
# Asserts (static check against src/App.tsx):
#   1. Every retired legacy URL has a redirect Route entry
#   2. The new canonical /security/* routes exist
#   3. The 3 deleted page files are gone
#   4. No stale imports for the deleted pages remain
#
# Run from repo root; no cluster needed.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

APP="frontend/admin-panel/src/App.tsx"
errors=0

if [[ ! -f "$APP" ]]; then
  echo "FAIL: $APP missing"
  exit 1
fi

# 1. Required redirects — each legacy URL must forward to the new home.
declare -a REDIRECTS=(
  'path="security"|/security/posture'
  'path="settings/security-hardening"|/security/posture'
  'path="settings/cluster-network"|/security/network-trust'
  'path="settings/users"|/security/identity'
)
for entry in "${REDIRECTS[@]}"; do
  src="${entry%|*}"
  dst="${entry#*|}"
  if ! grep -q "$src" "$APP"; then
    echo "FAIL: $APP missing legacy route entry '$src'"
    errors=$((errors + 1))
    continue
  fi
  # Find the line of the matching Route and verify it routes to $dst.
  if ! grep -F "$src" "$APP" | grep -qE "to=\"${dst//\//\\/}\"|to=\\{?[\"']${dst//\//\\/}\"|RedirectWithQuery to=\"${dst//\//\\/}\""; then
    echo "FAIL: $APP redirect for '$src' does not target '$dst'"
    grep -F "$src" "$APP" | head -1
    errors=$((errors + 1))
  fi
done

# 2. Canonical Security Hub routes present.
for canonical in \
  'path="security/posture"' \
  'path="security/network-trust"' \
  'path="security/identity"' \
  'path="security/web-defense"'
do
  if ! grep -q "$canonical" "$APP"; then
    echo "FAIL: canonical route '$canonical' missing from $APP"
    errors=$((errors + 1))
  fi
done

# 3. Retired page files must NOT exist.
for old in \
  frontend/admin-panel/src/pages/Security.tsx \
  frontend/admin-panel/src/pages/SecurityHardeningSettings.tsx \
  frontend/admin-panel/src/pages/ClusterNetworkingSettings.tsx
do
  if [[ -e "$old" ]]; then
    echo "FAIL: retired page still present: $old"
    errors=$((errors + 1))
  fi
done

# 4. No stale imports of the retired components anywhere in src/.
if grep -rn "from .*'\\@/pages/Security'\\|from .*'\\@/pages/SecurityHardeningSettings'\\|from .*'\\@/pages/ClusterNetworkingSettings'" frontend/admin-panel/src/ 2>/dev/null | grep -v node_modules; then
  echo "FAIL: stale imports of retired pages found above"
  errors=$((errors + 1))
fi

# 4b. No stale internal `to="/settings/..."` links to retired paths
# (e.g. <Link to="/settings/cluster-network">) — they should point at
# the new /security/* canonical home instead. The redirect catches
# the URL but the internal link does a double-hop and the page-title
# history loses fidelity.
if grep -rn 'to="/settings/security-hardening"\|to="/settings/cluster-network"\|to="/settings/users"' frontend/admin-panel/src/ 2>/dev/null | grep -v node_modules | grep -v App.tsx; then
  echo "FAIL: stale internal links to retired URLs found above (use /security/* canonical paths instead)"
  errors=$((errors + 1))
fi

# 5. New canonical pages exist.
for new in \
  frontend/admin-panel/src/pages/PosturePage.tsx \
  frontend/admin-panel/src/pages/WebDefensePage.tsx \
  frontend/admin-panel/src/pages/NetworkTrustPage.tsx \
  frontend/admin-panel/src/components/security/web-defense-tabs.tsx \
  frontend/admin-panel/src/components/RedirectWithQuery.tsx
do
  if [[ ! -f "$new" ]]; then
    echo "FAIL: expected new file missing: $new"
    errors=$((errors + 1))
  fi
done

if [[ "$errors" -gt 0 ]]; then
  echo
  echo "ci-security-hub-redirects: ${errors} failure(s)"
  exit 1
fi

echo "ci-security-hub-redirects: OK"
