#!/usr/bin/env bash
# Library: API + ANSI helpers for the local catalog test harness.
# Sourced by scripts/integration-catalog-local.sh — do not run directly.

# Colors (set NO_COLOR=1 to disable).
if [[ -z "${NO_COLOR:-}" && -t 1 ]]; then
  CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'
  GRAY='\033[90m'; BOLD='\033[1m'; RESET='\033[0m'
else
  CYAN=''; GREEN=''; RED=''; YELLOW=''; GRAY=''; BOLD=''; RESET=''
fi

log()    { echo -e "${CYAN}[$(date +%H:%M:%S)]${RESET} $*"; }
ok()     { echo -e "  ${GREEN}✓${RESET} $*"; }
warn()   { echo -e "  ${YELLOW}!${RESET} $*"; }
fail()   { echo -e "  ${RED}✗${RESET} $*"; }
info()   { echo -e "  ${GRAY}·${RESET} $*"; }

# Login as admin and return a Bearer token. Honors ADMIN_HOST + creds env.
login_token() {
  curl -sk -X POST "${ADMIN_HOST}/api/v1/auth/login" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"${ADMIN_EMAIL}\",\"password\":\"${ADMIN_PASSWORD}\"}" \
    | python3 -c "import json,sys;print(json.load(sys.stdin)['data']['token'])" 2>/dev/null
}

# api METHOD PATH [JSON_BODY] — calls the platform admin API and prints the
# response body to stdout. PATH starts with /. TOKEN must be in scope.
api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sk -X "$method" "${ADMIN_HOST}/api/v1${path}" \
      -H "Authorization: Bearer ${TOKEN}" \
      -H "Content-Type: application/json" \
      -d "$body"
  else
    curl -sk -X "$method" "${ADMIN_HOST}/api/v1${path}" \
      -H "Authorization: Bearer ${TOKEN}"
  fi
}

# Run kubectl inside the k3s container — single source of truth for how the
# harness reaches the cluster. K3S_CONTAINER is set by the caller.
kctl() {
  docker exec "${K3S_CONTAINER}" kubectl "$@"
}

# wait_for TIMEOUT_S DESC EXPECT_REGEX CMD — re-runs CMD every 4s until its
# stdout matches EXPECT_REGEX or TIMEOUT_S elapses. Returns 0 on match.
wait_for() {
  local timeout="$1" desc="$2" expect="$3" cmd="$4"
  local i=0
  while (( i < timeout )); do
    if eval "$cmd" 2>/dev/null | grep -qE "$expect"; then
      ok "$desc (after ${i}s)"
      return 0
    fi
    sleep 4
    i=$((i + 4))
  done
  fail "$desc — timeout after ${timeout}s waiting for /${expect}/"
  return 1
}

# Resolve a catalog entry's UUID by code via the catalog API.
catalog_id_for() {
  local code="$1"
  api GET "/catalog?limit=200" \
    | python3 -c "
import json, sys
d = json.load(sys.stdin)
for e in d.get('data', []):
  if e.get('code') == '${code}':
    print(e['id']); break
" 2>/dev/null
}

# Read a JSON path from a file. Lightweight wrapper around python -c so we
# don't take a hard jq dependency.
json_get() {
  local file="$1" path="$2"
  python3 -c "
import json, sys
d = json.load(open('${file}'))
try:
    for k in '${path}'.split('.'):
        if k.isdigit():
            d = d[int(k)]
        else:
            d = d[k]
    print(d if not isinstance(d, (dict, list)) else json.dumps(d))
except (KeyError, IndexError, TypeError):
    pass
"
}
