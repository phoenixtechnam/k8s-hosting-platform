#!/bin/sh
set -e

CONFIG_TEMPLATE="/usr/share/nginx/html/config.template.js"
CONFIG_OUTPUT="/usr/share/nginx/html/config.js"

# If the template exists, substitute env vars into runtime config.
# Only substitute the variables we explicitly declare (avoids clobbering
# nginx's own $uri, $host, etc. if this script is ever sourced elsewhere).
if [ -f "$CONFIG_TEMPLATE" ]; then
  envsubst '$API_URL $CLIENT_PANEL_URL' < "$CONFIG_TEMPLATE" > "$CONFIG_OUTPUT"
fi

exec "$@"
