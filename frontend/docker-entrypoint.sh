#!/bin/sh
set -e

# ── Runtime config for the React app ──
CONFIG_TEMPLATE="/usr/share/nginx/html/config.template.js"
CONFIG_OUTPUT="/usr/share/nginx/html/config.js"

if [ -z "${API_URL+x}" ]; then
  echo "INFO: API_URL not set. Using same-origin (empty string)." >&2
fi

if [ -f "$CONFIG_TEMPLATE" ]; then
  envsubst '$API_URL $CLIENT_PANEL_URL $STALWART_ADMIN_URL' < "$CONFIG_TEMPLATE" > "$CONFIG_OUTPUT"
fi

# ── Nginx proxy backend target ──
# Default to k8s service DNS. Docker Compose overrides via BACKEND_HOST env var.
export BACKEND_HOST="${BACKEND_HOST:-platform-api.platform.svc.cluster.local}"
export BACKEND_PORT="${BACKEND_PORT:-3000}"

# ── DNS resolver for runtime re-resolution of the upstream ──
# When the backend container is recreated (docker-compose rebuild) it gets
# a new IP. nginx caches upstream resolution at worker-start, so without a
# resolver + variable-in-proxy_pass the proxy keeps pointing at the dead IP
# and returns 502 until nginx itself is restarted. Extract the first
# nameserver from /etc/resolv.conf so the same template works in Docker
# (embedded DNS @ 127.0.0.11) and Kubernetes (kube-dns).
NGINX_RESOLVER="$(awk '/^nameserver/ {print $2; exit}' /etc/resolv.conf 2>/dev/null)"
export NGINX_RESOLVER="${NGINX_RESOLVER:-127.0.0.11}"

NGINX_TEMPLATE="/etc/nginx/conf.d/default.conf.template"
NGINX_OUTPUT="/etc/nginx/conf.d/default.conf"

if [ -f "$NGINX_TEMPLATE" ]; then
  envsubst '$BACKEND_HOST $BACKEND_PORT $NGINX_RESOLVER' < "$NGINX_TEMPLATE" > "$NGINX_OUTPUT"
fi

exec "$@"
