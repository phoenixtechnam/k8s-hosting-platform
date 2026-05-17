#!/usr/bin/env bash
# integration-token.sh — shared login cache for integration scripts.
#
# Goal: when the master runner (integration-all.sh) logs in once and
# exports INTEGRATION_TOKEN, individual suite scripts skip their own
# /api/v1/auth/login call and inherit the cached token. Cuts ~300ms +
# one TLS handshake per suite — small per-script, meaningful across
# 9-11 suites and the parallel groups added by the speedup PR.
#
# Crucially, this is OPT-IN per script: when INTEGRATION_TOKEN is
# unset (the standalone-run case, e.g. an operator running
# `./scripts/integration-pvc.sh` directly), `cached_or_login_token`
# falls through to the script's existing login function.
#
# Usage in a suite script:
#
#   source "$(dirname "$0")/lib/integration-token.sh"
#   login_token() {
#     curl -sk -X POST "$ADMIN_HOST/api/v1/auth/login" ...
#   }
#   TOKEN=$(cached_or_login_token)
#
# That's the only change needed. If integration-all.sh ran the script
# with INTEGRATION_TOKEN exported, the cache wins; otherwise the
# script's own login_token() fires. No behaviour change for the
# standalone case.
#
# Token refresh: JWT TTL is 30 minutes by default. integration-all.sh
# runs can exceed that on slow clusters. We do NOT auto-refresh here
# — the cached token simply expires and individual API calls 401. The
# fix is for the caller to detect 401 and call `refresh_integration_token`
# which forces a fresh login. The api() wrapper in scripts that opt in
# can do this automatically (see api_with_retry below).

# Returns the cached token if INTEGRATION_TOKEN is set, otherwise
# invokes the caller-defined `login_token` function. The function
# MUST be defined by the sourcing script before this is called.
cached_or_login_token() {
  if [[ -n "${INTEGRATION_TOKEN:-}" ]]; then
    printf '%s' "$INTEGRATION_TOKEN"
    return 0
  fi
  # Fall back to the script's own login_token. Don't masquerade if
  # it's missing — surface the symbol error clearly.
  if ! declare -F login_token >/dev/null; then
    echo "ERROR: cached_or_login_token: INTEGRATION_TOKEN unset AND login_token() not defined" >&2
    return 1
  fi
  login_token
}

# Force a fresh login (bypass cache). Use when an API call returns 401
# and the cached token is suspected expired. Updates BOTH the local
# TOKEN var and the exported INTEGRATION_TOKEN so subsequent calls in
# the same process pick up the refresh.
refresh_integration_token() {
  if ! declare -F login_token >/dev/null; then
    echo "ERROR: refresh_integration_token: login_token() not defined" >&2
    return 1
  fi
  local fresh
  fresh=$(login_token) || return 1
  [[ -z "$fresh" ]] && return 1
  TOKEN="$fresh"
  export INTEGRATION_TOKEN="$fresh"
  return 0
}
