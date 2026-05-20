#!/usr/bin/env bash
# ci-nginx-real-ip-check.sh — guard the real_ip directives in the admin
# and tenant panel nginx templates.
#
# Trap this guard exists to prevent: 2026-05-20 incident, where
# set_real_ip_from was added to frontend/admin-panel/nginx.conf (a
# dev-fallback file) but NOT to nginx.conf.template (the one rendered
# by docker-entrypoint.sh at runtime). The image was built, deployed,
# and looked correct — but the rendered /etc/nginx/conf.d/default.conf
# had zero set_real_ip_from lines, so platform-api kept seeing the
# Traefik pod IP as the operator's source IP.
#
# This script asserts:
#   1. nginx.conf.template (admin + tenant) contains all three
#      required directives: set_real_ip_from / real_ip_header /
#      real_ip_recursive.
#   2. The directives stay in sync between nginx.conf and
#      nginx.conf.template — divergence is a footgun because the
#      dev-fallback would behave differently than k8s.
#   3. The nginx.conf.template also has an `include` for the
#      operator-managed CIDR ConfigMap (trusted-proxies.d/*.conf)
#      so the UI-added CDN/LB ranges actually reach nginx.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

errors=0

for panel in admin-panel tenant-panel; do
  template="frontend/${panel}/nginx.conf.template"
  static="frontend/${panel}/nginx.conf"

  if [[ ! -f "$template" ]]; then
    echo "FAIL: $template missing"
    errors=$((errors + 1))
    continue
  fi

  for directive in 'set_real_ip_from' 'real_ip_header' 'real_ip_recursive'; do
    if ! grep -q "^\s*${directive}\b" "$template"; then
      echo "FAIL: $template missing '$directive' directive"
      errors=$((errors + 1))
    fi
  done

  if ! grep -q 'include\s*/etc/nginx/conf.d/trusted-proxies\.d/\*\.conf' "$template"; then
    echo "FAIL: $template missing include for operator-managed trusted-proxies ConfigMap"
    echo "       expected: include /etc/nginx/conf.d/trusted-proxies.d/*.conf;"
    errors=$((errors + 1))
  fi

  if [[ -f "$static" ]]; then
    for directive in 'set_real_ip_from' 'real_ip_header' 'real_ip_recursive'; do
      tmpl_count=$(grep -c "^\s*${directive}\b" "$template" || true)
      static_count=$(grep -c "^\s*${directive}\b" "$static" || true)
      # nginx.conf is the dev-fallback (bare `nginx -g 'daemon off;'`
      # paths without the entrypoint envsubst). It can omit the include
      # since the operator-managed ConfigMap isn't mounted in dev — but
      # the baseline directives MUST match so dev and k8s behave the
      # same way for the in-cluster CIDR trust.
      if [[ "$static_count" -lt 1 && "$tmpl_count" -ge 1 ]]; then
        echo "FAIL: $static missing '$directive' (template has $tmpl_count, static has 0)"
        echo "       dev-fallback drifted from runtime template — sync them."
        errors=$((errors + 1))
      fi
    done
  fi
done

if [[ "$errors" -gt 0 ]]; then
  echo
  echo "ci-nginx-real-ip-check: ${errors} failure(s)"
  echo "See scripts/ci-nginx-real-ip-check.sh header for the incident this guard prevents."
  exit 1
fi

echo "ci-nginx-real-ip-check: OK"
