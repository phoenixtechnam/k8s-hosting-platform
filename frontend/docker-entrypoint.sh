#!/bin/sh
set -e

CONFIG_TEMPLATE="/usr/share/nginx/html/config.template.js"
CONFIG_OUTPUT="/usr/share/nginx/html/config.js"

# Warn if API_URL is not set — the app will fall back to localhost:3000
# which is almost certainly wrong in a containerized deployment.
if [ -z "$API_URL" ]; then
  echo "WARNING: API_URL is not set. Frontend will fall back to http://localhost:3000." >&2
  echo "Set API_URL via environment variable or platform-config ConfigMap." >&2
fi

# If the template exists, substitute env vars into runtime config.
# Only substitute the variables we explicitly declare (avoids clobbering
# nginx's own $uri, $host, etc. if this script is ever sourced elsewhere).
if [ -f "$CONFIG_TEMPLATE" ]; then
  envsubst '$API_URL $CLIENT_PANEL_URL' < "$CONFIG_TEMPLATE" > "$CONFIG_OUTPUT"
fi

exec "$@"
