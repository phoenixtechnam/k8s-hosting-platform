#!/usr/bin/env bash
# Post-deploy guard: assert Stalwart's JMAP session reports the
# expected public hostname (not the kernel/pod-name fallback).
#
# Stalwart 0.16 embeds `x:SystemSettings.defaultHostname` into the
# `apiUrl`, `downloadUrl`, `uploadUrl`, `eventSourceUrl` and JMAP
# WebSocket URL on every `/jmap/session` response. If the setting is
# unset, Stalwart falls back to `gethostname()` which in Kubernetes
# is the pod name (e.g. `stalwart-mail-5b97d4679f-blk2d`). That breaks
# every JMAP client (Bulwark, Thunderbird, mobile apps) because the
# browser can't resolve a pod name. See ADR-039 finding #10.
#
# This guard runs against a deployed cluster and exits non-zero if
# Stalwart's self-reported URLs don't contain the expected hostname.
# Wire it into post-deploy smoke + Infrastructure CI.
#
# Usage:
#   ./scripts/ci-stalwart-hostname-check.sh [expected_hostname]
#
# Environment:
#   STALWART_HOSTNAME  — expected public hostname (e.g. mail.example.com)
#   STALWART_ADMIN_USER     — defaults to `admin`
#   STALWART_ADMIN_PASSWORD — defaults to reading from stalwart-admin-creds
#   STALWART_JMAP_URL  — defaults to in-cluster Service URL
#   KUBECONFIG         — optional, picked up by kubectl/wget
set -euo pipefail

EXPECTED="${1:-${STALWART_HOSTNAME:-}}"
ADMIN_USER="${STALWART_ADMIN_USER:-admin}"
ADMIN_PASSWORD="${STALWART_ADMIN_PASSWORD:-}"
JMAP_URL="${STALWART_JMAP_URL:-http://stalwart-mgmt.mail.svc.cluster.local:8080}"

if [[ -z "$EXPECTED" ]]; then
  echo "FAIL: expected hostname not provided. Pass as \$1 or set STALWART_HOSTNAME." >&2
  exit 2
fi

# Fall back to reading the admin password from the cluster Secret. The
# operator may pre-provide STALWART_ADMIN_PASSWORD to skip the
# kubectl dependency (useful in CI runners that lack cluster access).
if [[ -z "$ADMIN_PASSWORD" ]]; then
  if command -v kubectl >/dev/null 2>&1; then
    ADMIN_PASSWORD=$(kubectl get secret -n mail stalwart-admin-creds \
      -o jsonpath='{.data.adminPassword}' 2>/dev/null | base64 -d 2>/dev/null || true)
  fi
  if [[ -z "$ADMIN_PASSWORD" ]]; then
    echo "FAIL: STALWART_ADMIN_PASSWORD not set and kubectl couldn't read" \
         "stalwart-admin-creds/adminPassword." >&2
    exit 2
  fi
fi

AUTH=$(printf "%s:%s" "$ADMIN_USER" "$ADMIN_PASSWORD" | base64 -w0 2>/dev/null || \
       printf "%s:%s" "$ADMIN_USER" "$ADMIN_PASSWORD" | base64)

# Fetch the JMAP session. Follow Stalwart's standard
# `/.well-known/jmap` → `/jmap/session` redirect.
session=$(curl -ksSL -m 15 -H "Authorization: Basic $AUTH" \
          "$JMAP_URL/.well-known/jmap" 2>&1) || {
  echo "FAIL: could not reach $JMAP_URL — $session" >&2
  exit 1
}

# Extract a representative URL — apiUrl is the canonical one.
api_url=$(printf '%s' "$session" | \
          grep -oE '"apiUrl":"[^"]+"' | head -1 | sed 's/^"apiUrl":"//;s/"$//')

if [[ -z "$api_url" ]]; then
  echo "FAIL: no apiUrl in session response. Body:" >&2
  printf '%s\n' "$session" | head -c 400 >&2
  echo >&2
  exit 1
}

# Strip scheme + path: `https://<host>/jmap/` → `<host>`.
host_in_url=$(printf '%s' "$api_url" | sed -E 's|^https?://||; s|[:/].*$||')

if [[ "$host_in_url" != "$EXPECTED" ]]; then
  echo "FAIL: Stalwart apiUrl reports host '$host_in_url'; expected '$EXPECTED'." >&2
  echo "      Full apiUrl: $api_url" >&2
  echo "      Fix: run bootstrap.sh's configure_stalwart_full() or call" >&2
  echo "      x:SystemSettings/set { update:{singleton:{defaultHostname:'$EXPECTED', defaultDomainId:'<id>'} } }." >&2
  exit 1
fi

echo "OK: Stalwart apiUrl reports hostname '$EXPECTED' ($api_url)"
