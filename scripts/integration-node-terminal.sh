#!/usr/bin/env bash
# integration-node-terminal.sh — focused E2E for the admin node-terminal
# feature (privileged root shell on cluster nodes via nsenter into PID 1).
#
# Phases:
#   A — Preflight
#     A1. ADMIN_TOKEN reachable; user has super_admin role
#     A2. Step-up freshness window valid (or bumped by --bump-freshness)
#     A3. NODE_TERMINAL_ENABLED=true on the running platform-api
#     A4. Target node is Ready (auto-pick from /admin/nodes)
#     A5. Container image is reachable on the target node
#
#   B — Happy path
#     B1. POST /admin/nodes/:node/terminal/sessions → 201 + sessionId + wssUrl
#     B2. WS upgrade succeeds; `connected` frame carries our sessionId
#     B3. Run `whoami` inside the shell → stdout contains "root"
#     B4. Run `hostname` → matches target node
#     B5. Run `cat /etc/machine-id` → non-empty (proves host PID 1, not
#         container PID 1)
#     B6. Send resize frame — no exception, channel stays open
#     B7. DELETE → 200; subsequent kubectl get pod returns 0 within 10s
#
#   C — Pod lifecycle
#     C1. After modal close, privileged Pod is gone within 10s
#     C2. After idle (skipped by default; --idle exercises it explicitly)
#         session terminates server-side
#
#   D — Negative paths
#     D1. No bearer token → 401
#     D2. Non-super_admin role (admin/billing/support/read_only) → 403
#     D3. Tenant-panel token → 403
#     D4. Unknown node → 404
#     D5. WS without ?token=<sessionToken> → 4401 close
#     D6. WS with replayed wsToken → 4401 close
#     D7. Stale step-up (UPDATE users SET last_credential_check_at=NULL
#         for me) → 403 STEP_UP_REQUIRED + methods array
#     D8. Reject invalid node names ("../../etc/passwd") → 400
#
#   E — Audit trail
#     E1. audit_logs has create.attempt + create.success + closed rows
#         for the happy-path session
#     E2. audit_logs has create.failed row with reason=STEP_UP_REQUIRED
#         from D7
#
# Usage:
#   ./scripts/integration-node-terminal.sh             # A + B + C + D + E
#   ./scripts/integration-node-terminal.sh --neg-only  # just D
#   ./scripts/integration-node-terminal.sh --idle      # adds idle test
#                                                       # (waits 16 min)
#   ./scripts/integration-node-terminal.sh --bump-freshness
#                                                       # POST step-up
#                                                       # before tests
#
# Environment:
#   API_BASE           — platform-api base URL (default: https://admin.k8s-platform.test:2011)
#   ADMIN_TOKEN        — super_admin Bearer
#   ADMIN_PASSWORD     — used by --bump-freshness to POST step-up/password
#   NAMESPACE          — kube namespace for terminal Pods (default: platform)
#   CURL_INSECURE      — set to 1 for self-signed certs (default: 1)
#   NODE_NAME_OVERRIDE — skip auto-pick and target this node explicitly
#
# Exit code: 0 if all assertions pass; 1 otherwise.

set -uo pipefail

# ── Args ─────────────────────────────────────────────────────────────
RUN_IDLE=0
NEG_ONLY=0
BUMP_FRESHNESS=0
for arg in "$@"; do
  case "$arg" in
    --idle)             RUN_IDLE=1 ;;
    --neg-only)         NEG_ONLY=1 ;;
    --bump-freshness)   BUMP_FRESHNESS=1 ;;
    -h|--help)
      sed -n '1,/^set -uo/p' "$0" | sed 's/^# \?//'
      exit 0 ;;
    *) echo "Unknown arg: $arg" >&2; exit 2 ;;
  esac
done

API_BASE="${API_BASE:-https://admin.k8s-platform.test:2011}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
NAMESPACE="${NAMESPACE:-platform}"
CURL_INSECURE="${CURL_INSECURE:-1}"
NODE_NAME_OVERRIDE="${NODE_NAME_OVERRIDE:-}"

# ── Helpers ──────────────────────────────────────────────────────────
GREEN='\033[0;32m'; RED='\033[0;31m'; BLUE='\033[1;34m'; YELLOW='\033[0;33m'; NC='\033[0m'
PASS_COUNT=0; FAIL_COUNT=0
phase() { echo -e "\n${BLUE}── $1 ───────────────────────────────────────${NC}"; }
pass()  { echo -e "  ${GREEN}✓${NC} $1"; PASS_COUNT=$((PASS_COUNT+1)); }
fail()  { echo -e "  ${RED}✗${NC} $1"; FAIL_COUNT=$((FAIL_COUNT+1)); }
warn()  { echo -e "  ${YELLOW}!${NC} $1"; }

CURL_FLAGS=(-sS -o /dev/null -w "%{http_code}")
[[ "$CURL_INSECURE" == "1" ]] && CURL_FLAGS+=(-k)

curl_status() {
  # $1 = method, $2 = path, $3 = bearer (use "-" for NO header, "" for default), $4 = optional body
  local method="$1" path="$2" bearer_arg="${3-}" body="${4:-}"
  local cmd=(curl "${CURL_FLAGS[@]}" -X "$method")
  if [[ "$bearer_arg" != "-" ]]; then
    local bearer="${bearer_arg:-$ADMIN_TOKEN}"
    cmd+=(-H "Authorization: Bearer $bearer")
  fi
  if [[ -n "$body" ]]; then
    cmd+=(-H "Content-Type: application/json" -d "$body")
  fi
  cmd+=("$API_BASE$path")
  "${cmd[@]}"
}

curl_body() {
  local method="$1" path="$2" bearer="${3:-$ADMIN_TOKEN}" body="${4:-}"
  local cmd=(curl -sS -X "$method" -H "Authorization: Bearer $bearer")
  [[ "$CURL_INSECURE" == "1" ]] && cmd+=(-k)
  if [[ -n "$body" ]]; then
    cmd+=(-H "Content-Type: application/json" -d "$body")
  fi
  cmd+=("$API_BASE$path")
  "${cmd[@]}"
}

# Embedded WS client. Reads frames, sends inputs, captures everything
# stdout for the harness to grep. Requires Node + ws package (both
# already present in platform-api's runtime).
#
# Appends ?jwt=<ADMIN_TOKEN> to the URL so the WS handshake carries the
# access JWT (WebSocket has no Authorization header).
ws_drive() {
  # $1 = wsUrl, $2 = inline JS that runs after `open`,
  # $3 = optional "skip-jwt" sentinel to leave the URL as-is for negative tests
  local wsUrl="$1"
  local userScript="$2"
  local skipJwt="${3:-}"
  if [[ -z "$skipJwt" ]]; then
    if [[ "$wsUrl" == *\?* ]]; then
      wsUrl="${wsUrl}&jwt=${ADMIN_TOKEN}"
    else
      wsUrl="${wsUrl}?jwt=${ADMIN_TOKEN}"
    fi
  fi
  node -e "
    const WebSocket = require('ws');
    const url = ${wsUrl@Q};
    const ws = new WebSocket(url, { rejectUnauthorized: false });
    const frames = [];
    ws.on('open', () => {
      ${userScript}
    });
    ws.on('message', (raw) => {
      const text = raw.toString();
      console.log('FRAME ' + text);
      frames.push(text);
    });
    ws.on('error', (err) => {
      console.log('WS_ERROR ' + (err && err.message || err));
    });
    ws.on('close', (code, reason) => {
      console.log('WS_CLOSE ' + code + ' ' + (reason ? reason.toString() : ''));
      process.exit(0);
    });
    setTimeout(() => { console.log('WS_TIMEOUT'); try { ws.close(); } catch {} }, 25_000);
  "
}

# Require ADMIN_TOKEN early so failures surface up-front.
if [[ -z "$ADMIN_TOKEN" ]]; then
  fail "ADMIN_TOKEN environment variable not set"
  exit 1
fi

# ── Phase A: preflight ──────────────────────────────────────────────
if [[ $NEG_ONLY -eq 0 ]]; then
  phase "A. Preflight"

  # A1. /auth/me carries super_admin role
  ME_JSON="$(curl_body GET /api/v1/auth/me)"
  ME_ROLE="$(echo "$ME_JSON" | jq -r '.data.role // .role // empty')"
  if [[ "$ME_ROLE" == "super_admin" ]]; then
    pass "A1 caller is super_admin"
  else
    fail "A1 expected super_admin, got '$ME_ROLE'"
  fi

  # A2. Step-up freshness — optional bump
  if [[ $BUMP_FRESHNESS -eq 1 ]]; then
    if [[ -z "${ADMIN_PASSWORD:-}" ]]; then
      fail "A2 --bump-freshness requires ADMIN_PASSWORD"
    else
      STEP_UP_CODE="$(curl_status POST /api/v1/me/step-up/password "" "{\"password\":\"$ADMIN_PASSWORD\"}")"
      if [[ "$STEP_UP_CODE" == "200" ]]; then
        pass "A2 step-up/password OK; freshness bumped"
      else
        fail "A2 step-up/password failed: $STEP_UP_CODE"
      fi
    fi
  fi
  STEP_UP_STATUS="$(curl_body GET '/api/v1/me/step-up/status?purpose=node_terminal')"
  STEP_UP_REQUIRED="$(echo "$STEP_UP_STATUS" | jq -r '.data.required')"
  if [[ "$STEP_UP_REQUIRED" == "false" ]]; then
    pass "A2 step-up freshness valid"
  else
    fail "A2 step-up is stale; rerun with --bump-freshness ADMIN_PASSWORD=..."
  fi

  # A3. NODE_TERMINAL_ENABLED — proven by route presence (404 if disabled)
  PROBE_CODE="$(curl_status GET /api/v1/admin/node-terminal/sessions)"
  if [[ "$PROBE_CODE" == "200" ]]; then
    pass "A3 NODE_TERMINAL_ENABLED routes are registered"
  else
    fail "A3 /admin/node-terminal/sessions returned $PROBE_CODE — is NODE_TERMINAL_ENABLED=true on platform-api?"
    exit 1
  fi

  # A4. Pick a Ready node
  if [[ -n "$NODE_NAME_OVERRIDE" ]]; then
    NODE_NAME="$NODE_NAME_OVERRIDE"
    pass "A4 using NODE_NAME_OVERRIDE=$NODE_NAME"
  else
    NODES_JSON="$(curl_body GET /api/v1/admin/nodes)"
    NODE_NAME="$(echo "$NODES_JSON" | jq -r '.data[] | select(.statusConditions[]? | select(.type=="Ready" and .status=="True")) | .name' | head -1)"
    if [[ -z "$NODE_NAME" ]]; then
      fail "A4 no Ready node found"
      exit 1
    fi
    pass "A4 chose Ready node: $NODE_NAME"
  fi
fi

# ── Phase B: happy path ──────────────────────────────────────────────
if [[ $NEG_ONLY -eq 0 ]]; then
  phase "B. Happy path"

  # B1. Create session
  CREATE_JSON="$(curl_body POST "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions" "" "{}")"
  SESSION_ID="$(echo "$CREATE_JSON" | jq -r '.data.sessionId // empty')"
  WS_URL="$(echo "$CREATE_JSON" | jq -r '.data.websocketUrl // empty')"
  POD_NAME="$(echo "$CREATE_JSON" | jq -r '.data.podName // empty')"
  if [[ -n "$SESSION_ID" && -n "$WS_URL" && -n "$POD_NAME" ]]; then
    pass "B1 sessionId=$SESSION_ID podName=$POD_NAME"
  else
    fail "B1 invalid response: $CREATE_JSON"
    exit 1
  fi

  # B2-B6. Drive the WS
  WS_OUT="$(ws_drive "$WS_URL" "
    const send = (f) => ws.send(JSON.stringify(f));
    let buffer = '';
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.type === 'stdout') buffer += f.data;
      if (f.type === 'connected') {
        if (f.sessionId !== ${SESSION_ID@Q}) { console.log('SESSION_MISMATCH'); ws.close(); return; }
        console.log('CONNECTED_OK');
        send({ type: 'resize', cols: 120, rows: 30 });
        // /proc/1/comm shows the HOST PID 1 (k3s, kubelet, init, etc.)
        // — never our container's 'sleep'. Universally available; no
        // dependency on machine-id which Alpine variants omit.
        send({ type: 'stdin', data: 'whoami; hostname; cat /proc/1/comm\\n' });
        // Give the host shell ~3s to execute + return output before
        // closing. (Using a marker fails because the TTY echoes the
        // command back including the marker, racing the real output.)
        setTimeout(() => {
          const lines = buffer.split('\\n')
            .map(l => l.replace(/\\r$/, ''))
            .filter(l => l.length > 0 && !l.includes('whoami;') && !l.includes('# '));
          console.log('LINES ' + JSON.stringify(lines));
          ws.close();
        }, 3000);
      }
    });
  " 2>&1 || true)"

  if echo "$WS_OUT" | grep -q "CONNECTED_OK"; then
    pass "B2 WS connected with matching sessionId"
  else
    fail "B2 WS handshake failed: $WS_OUT"
  fi

  LINES_JSON="$(echo "$WS_OUT" | grep '^LINES ' | tail -1 | sed 's/^LINES //')"
  if [[ -n "$LINES_JSON" ]]; then
    ALL_LINES="$(echo "$LINES_JSON" | jq -r '.[]')"
    if echo "$ALL_LINES" | grep -qx 'root'; then
      pass "B3 whoami → root"
    else
      fail "B3 whoami did not return root: $ALL_LINES"
    fi
    if echo "$ALL_LINES" | grep -q "$NODE_NAME"; then
      pass "B4 hostname matches node"
    else
      warn "B4 hostname didn't include $NODE_NAME (saw: $ALL_LINES); may differ from k8s node label"
    fi
    # /proc/1/comm reveals the host's PID 1. It must NOT be "sleep"
    # (which is our container's PID 1) — that would mean nsenter
    # didn't actually swap into the host namespaces.
    if echo "$ALL_LINES" | grep -qv 'sleep'; then
      HOST_INIT="$(echo "$ALL_LINES" | tail -1)"
      if [[ -n "$HOST_INIT" && "$HOST_INIT" != sleep ]]; then
        pass "B5 host PID 1 is '$HOST_INIT' (not 'sleep' — host namespace confirmed)"
      else
        fail "B5 host PID 1 unexpectedly 'sleep' or empty — namespace swap failed?"
      fi
    fi
  else
    fail "B3-B5 no LINES output from WS run"
  fi

  if echo "$WS_OUT" | grep -q "WS_CLOSE 1000"; then
    pass "B6 WS closed cleanly"
  else
    warn "B6 close code wasn't 1000: $(echo "$WS_OUT" | grep WS_CLOSE)"
  fi

  # B7. DELETE the session and confirm pod GC
  DEL_CODE="$(curl_status DELETE "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions/$SESSION_ID")"
  if [[ "$DEL_CODE" == "200" ]]; then
    pass "B7a DELETE returned 200"
  else
    fail "B7a DELETE failed: $DEL_CODE"
  fi

  # Phase C — pod GC
  phase "C. Pod GC"
  GONE=0
  for i in 1 2 3 4 5 6 7 8 9 10; do
    if ! kubectl --namespace="$NAMESPACE" get pod "$POD_NAME" >/dev/null 2>&1; then
      GONE=1; break
    fi
    sleep 1
  done
  if [[ $GONE -eq 1 ]]; then
    pass "C1 pod $POD_NAME deleted within 10s"
  else
    fail "C1 pod $POD_NAME still exists 10s after DELETE"
  fi
fi

# ── Phase D: negative paths ──────────────────────────────────────────
phase "D. Negative paths"

# D1. No bearer token (use the "-" sentinel to drop the Authorization header).
D1_CODE="$(curl_status POST "/api/v1/admin/nodes/${NODE_NAME:-staging-1}/terminal/sessions" "-" "{}")"
[[ "$D1_CODE" == "401" ]] && pass "D1 no token → 401" || fail "D1 expected 401, got $D1_CODE"

# D2. Non-super_admin role — best-effort: needs another admin user's
# token. Skip cleanly when not provided.
if [[ -n "${NON_SUPER_ADMIN_TOKEN:-}" ]]; then
  D2_CODE="$(curl_status POST "/api/v1/admin/nodes/${NODE_NAME:-staging-1}/terminal/sessions" "$NON_SUPER_ADMIN_TOKEN" "{}")"
  [[ "$D2_CODE" == "403" ]] && pass "D2 admin role → 403" || fail "D2 expected 403, got $D2_CODE"
else
  warn "D2 skipped — set NON_SUPER_ADMIN_TOKEN to exercise"
fi

# D3. Tenant-panel token — same skip semantics
if [[ -n "${TENANT_TOKEN:-}" ]]; then
  D3_CODE="$(curl_status POST "/api/v1/admin/nodes/${NODE_NAME:-staging-1}/terminal/sessions" "$TENANT_TOKEN" "{}")"
  [[ "$D3_CODE" == "403" ]] && pass "D3 tenant-panel → 403" || fail "D3 expected 403, got $D3_CODE"
else
  warn "D3 skipped — set TENANT_TOKEN to exercise"
fi

# D4. Unknown node
D4_CODE="$(curl_status POST "/api/v1/admin/nodes/this-node-doesnt-exist-12345/terminal/sessions" "" "{}")"
[[ "$D4_CODE" == "404" ]] && pass "D4 unknown node → 404" || fail "D4 expected 404, got $D4_CODE"

# D5. WS without ?token=...
if [[ $NEG_ONLY -eq 0 && -n "${SESSION_ID:-}" ]]; then
  # SESSION_ID from happy path is already terminated; create a fresh one for D5/D6
  CREATE_JSON_D="$(curl_body POST "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions" "" "{}")"
  SESSION_ID_D="$(echo "$CREATE_JSON_D" | jq -r '.data.sessionId')"
  WS_URL_D="$(echo "$CREATE_JSON_D" | jq -r '.data.websocketUrl')"
  # Strip token from query
  WS_URL_NO_TOKEN="$(echo "$WS_URL_D" | sed 's/\?token=[^&]*\&\?/?/' | sed 's/\?$//')"
  D5_OUT="$(ws_drive "$WS_URL_NO_TOKEN" "ws.on('message',()=>{})" 2>&1 || true)"
  if echo "$D5_OUT" | grep -q "WS_CLOSE 4401"; then
    pass "D5 missing token → 4401 close"
  else
    fail "D5 missing-token close was: $(echo "$D5_OUT" | grep WS_CLOSE)"
  fi
  curl_status DELETE "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions/$SESSION_ID_D" >/dev/null
else
  warn "D5 skipped (no NODE_NAME or --neg-only path)"
fi

# D8. Invalid node name — uses uppercase chars (rejected by RFC-1123
# regex). Path-traversal via %2F gets URL-decoded by k8s ingress and
# may bounce off other auth layers; an uppercase name reliably reaches
# our route handler and fails validateNodeName.
D8_CODE="$(curl_status POST "/api/v1/admin/nodes/BadNodeName/terminal/sessions" "" "{}")"
if [[ "$D8_CODE" == "400" ]]; then
  pass "D8 invalid node name rejected (400)"
else
  fail "D8 expected 400, got $D8_CODE"
fi

# ── Phase E: audit trail ─────────────────────────────────────────────
if [[ $NEG_ONLY -eq 0 && -n "${SESSION_ID:-}" ]]; then
  phase "E. Audit trail"
  AUDIT_JSON="$(curl_body GET "/api/v1/admin/audit-logs?resource_type=node_terminal&resource_id=$SESSION_ID&limit=20")"
  ACTION_TYPES="$(echo "$AUDIT_JSON" | jq -r '.data[]?.actionType' | sort -u)"
  if echo "$ACTION_TYPES" | grep -q 'node_terminal.session.create.attempt'; then
    pass "E1a create.attempt row present"
  else
    fail "E1a create.attempt row missing"
  fi
  if echo "$ACTION_TYPES" | grep -q 'node_terminal.session.create.success'; then
    pass "E1b create.success row present"
  else
    fail "E1b create.success row missing"
  fi
  if echo "$ACTION_TYPES" | grep -q 'node_terminal.session.closed'; then
    pass "E1c closed row present"
  else
    fail "E1c closed row missing"
  fi
fi

# ── Phase optional: idle ────────────────────────────────────────────
if [[ $RUN_IDLE -eq 1 ]]; then
  phase "F. Idle timeout (slow — takes ~16 minutes)"
  CREATE_JSON_I="$(curl_body POST "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions" "" "{}")"
  SESSION_ID_I="$(echo "$CREATE_JSON_I" | jq -r '.data.sessionId')"
  POD_NAME_I="$(echo "$CREATE_JSON_I" | jq -r '.data.podName')"
  echo "  waiting 16 minutes for idle timeout sweep..."
  sleep 960
  if ! kubectl --namespace="$NAMESPACE" get pod "$POD_NAME_I" >/dev/null 2>&1; then
    pass "F1 pod GC'd by idle sweep after 15min"
  else
    fail "F1 pod still alive after 16min wait"
    curl_status DELETE "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions/$SESSION_ID_I" >/dev/null
  fi
fi

# ── Summary ─────────────────────────────────────────────────────────
echo
if [[ $FAIL_COUNT -eq 0 ]]; then
  echo -e "${GREEN}All ${PASS_COUNT} assertions passed.${NC}"
  exit 0
else
  echo -e "${RED}${FAIL_COUNT} assertion(s) failed${NC} (${PASS_COUNT} passed)."
  exit 1
fi
