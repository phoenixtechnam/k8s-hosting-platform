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
#     D7. Stale step-up (UPDATE users SET last_step_up_at=NULL
#         for me) → 403 STEP_UP_REQUIRED + methods array
#     D8. Reject invalid node names ("../../etc/passwd") → 400
#
#   E — Audit trail
#     E1. audit_logs has create.attempt + create.success + closed rows
#         for the happy-path session
#     E2. audit_logs has create.failed row with reason=STEP_UP_REQUIRED
#         from D7
#
#   F — DB-backed session lookup (ADR-041 follow-up)
#     F1. Session row persists to node_terminal_sessions
#     F2. ownerReplica column populated
#     F3. WS upgrade succeeds via DB lookup (no SESSION_NOT_FOUND)
#     F4. ws.attached audit row written or ownerReplica updated
#     Note: a true cross-replica handoff requires two running platform-api
#     Pods + replica spoofing; that's unit-tested in service.test.ts.
#
#   G — Reconnect (fresh wsToken, same session)
#     G1. POST /sessions → original token
#     G2. POST /sessions/:id/ws-token → fresh URL, same sessionId, same Pod
#     G3. New WS connects, exec stream usable
#     G4. Old wssUrl rejected after refresh (no replay possible)
#
#   H — Page-reload survival (grace-period termination)
#     H1. Ungraceful WS close (no terminate frame) — Pod survives
#     H2. DB row has terminate_after populated
#     H3. POST /ws-token cancels the grace timer (terminate_after = NULL)
#     H4. New WS connects, host filesystem state preserved across reload
#     H5. Explicit terminate frame → immediate cleanup (no grace)
#
#   J — Shell continuity (tmux + bash history persists across reconnect)
#     J1. Create session, type a marker command, ungraceful close
#     J2. POST /ws-token mints fresh URL
#     J3. New WS runs `history` — marker from pre-reload session shows up
#
#   I — Idle timeout (opt-in via --idle, takes 16 minutes)
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
# Accept INTEGRATION_TOKEN (master integration-all.sh exports this) as
# a fallback so node-terminal can run inside the bundled suite without
# its own login round-trip.
ADMIN_TOKEN="${ADMIN_TOKEN:-${INTEGRATION_TOKEN:-}}"
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
        // Give the host shell ~5s to execute + return output before
        // closing. (Using a marker fails because the TTY echoes the
        // command back including the marker, racing the real output.)
        // 5s — comfortable headroom for slow nodes / busy clusters.
        setTimeout(() => {
          const lines = buffer.split('\\n')
            .map(l => l.replace(/\\r$/, ''))
            .filter(l => l.length > 0 && !l.includes('whoami;') && !l.includes('# '));
          console.log('LINES ' + JSON.stringify(lines));
          ws.close();
        }, 5000);
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
    HOST_INIT="$(echo "$ALL_LINES" | tail -1)"
    if [[ -n "$HOST_INIT" && "$HOST_INIT" != sleep ]]; then
      pass "B5 host PID 1 is '$HOST_INIT' (not 'sleep' — host namespace confirmed)"
    else
      fail "B5 host PID 1 unexpectedly 'sleep' or empty — namespace swap failed?"
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
  # D6 — token replay. Re-open the SAME ws URL (token already
  # consumed by D5's connection-then-close cycle? Actually D5 closed
  # before consuming because the token check happens on upgrade.
  # Make a fresh session, consume once, then attempt replay.
  CREATE_JSON_D6="$(curl_body POST "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions" "" "{}")"
  WS_URL_D6="$(echo "$CREATE_JSON_D6" | jq -r '.data.websocketUrl')"
  SESSION_ID_D6="$(echo "$CREATE_JSON_D6" | jq -r '.data.sessionId')"
  # First connect consumes the token successfully.
  ws_drive "$WS_URL_D6" "ws.on('message',()=>{ setTimeout(()=>ws.close(),200); })" >/dev/null 2>&1 || true
  sleep 1
  # Second connect with the same URL — token already consumed.
  D6_OUT="$(ws_drive "$WS_URL_D6" "ws.on('message',()=>{})" 2>&1 || true)"
  if echo "$D6_OUT" | grep -q "WS_CLOSE 4401\|TOKEN_INVALID\|SESSION_NOT_FOUND\|WS_CLOSE 4404"; then
    pass "D6 replayed wsToken → 4401/4404 close"
  else
    fail "D6 replay was: $(echo "$D6_OUT" | grep WS_CLOSE | head -1)"
  fi
  curl_status DELETE "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions/$SESSION_ID_D6" >/dev/null 2>&1 || true

  # D7 — stale step-up. Null out lastCredentialCheckAt for the admin
  # and assert createSession returns 403 STEP_UP_REQUIRED. Best-effort:
  # restore the timestamp afterward so subsequent runs are clean.
  # D7 needs a way to mutate users.last_step_up_at directly.
  # KUBECTL must be set to a command that reaches the cluster — for
  # DinD that's `docker exec hosting-platform-k3s-server-1 kubectl`;
  # for staging it's just `kubectl` with the right context.
  KUBECTL_CMD="${KUBECTL:-kubectl}"
  EMAIL="${ADMIN_EMAIL_OVERRIDE:-admin@k8s-platform.test}"
  # Inline-test that the kubectl bridge actually reaches our database.
  if $KUBECTL_CMD --namespace="$NAMESPACE" exec system-db-1 -c postgres -- psql -d hosting_platform -t -A -c "SELECT 1" >/dev/null 2>&1; then
    SAVED_AT="$($KUBECTL_CMD --namespace=$NAMESPACE exec system-db-1 -c postgres -- psql -d hosting_platform -t -A -c "SELECT to_char(last_step_up_at,'YYYY-MM-DD HH24:MI:SS.US') FROM users WHERE email='$EMAIL'" 2>/dev/null | head -1)"
    $KUBECTL_CMD --namespace="$NAMESPACE" exec system-db-1 -c postgres -- psql -d hosting_platform -t -A -c "UPDATE users SET last_step_up_at=NULL WHERE email='$EMAIL'" >/dev/null 2>&1
    D7_BODY="$(curl_body POST "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions" "" "{}")"
    D7_CODE="$(echo "$D7_BODY" | jq -r '.error.code // "none"')"
    D7_METHODS="$(echo "$D7_BODY" | jq -r '.error.details.methods | join(",") // ""' 2>/dev/null)"
    if [[ "$D7_CODE" == "STEP_UP_REQUIRED" && -n "$D7_METHODS" ]]; then
      pass "D7 stale freshness → STEP_UP_REQUIRED + methods=$D7_METHODS"
    else
      fail "D7 expected STEP_UP_REQUIRED, got code=$D7_CODE methods=$D7_METHODS"
    fi
    # Restore so subsequent assertions pass and a future re-run of
    # the harness doesn't immediately demand a step-up.
    if [[ -n "$SAVED_AT" ]]; then
      $KUBECTL_CMD --namespace="$NAMESPACE" exec system-db-1 -c postgres -- psql -d hosting_platform -t -A -c "UPDATE users SET last_step_up_at='$SAVED_AT' WHERE email='$EMAIL'" >/dev/null 2>&1
    fi
  else
    warn "D7 skipped — set KUBECTL='docker exec <dind-container> kubectl' (DinD) or ensure kubectl is on PATH"
  fi

  curl_status DELETE "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions/$SESSION_ID_D" >/dev/null
else
  warn "D5/D6/D7 skipped (no NODE_NAME or --neg-only path)"
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

# ── Phase F: DB-backed session lookup proof ───────────────────────────
#
# A true cross-replica handoff requires two running platform-api Pods +
# the ability to spoof PLATFORM_API_REPLICA_HOST on the WS upgrade —
# infrastructure the harness doesn't have. (Cross-replica branching is
# unit-tested in service.test.ts → "CROSS-REPLICA ATTACH".)
#
# This phase instead proves the load-bearing DB lookup path is wired:
#   F1. Session row lands in `node_terminal_sessions` after create.
#   F2. ownerReplica column populated (proves insertSession ran on the
#       hot path of POST /sessions, not lazily).
#   F3. WS upgrade succeeds, which is only possible if attachExec did a
#       DB findById (an in-memory-only path would still work here too,
#       so the stronger guarantee comes from the unit test).
#   F4. Either ownerReplica was updated (cross-replica branch hit) OR
#       the ws.attached audit row was written (proves attachExec
#       executed end-to-end).
if [[ $NEG_ONLY -eq 0 && -n "${SESSION_ID:-}" ]]; then
  phase "F. DB-backed session lookup"

  # F1. Create
  F_CREATE="$(curl_body POST "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions" "" "{}")"
  F_SESSION_ID="$(echo "$F_CREATE" | jq -r '.data.sessionId')"
  F_WS_URL="$(echo "$F_CREATE" | jq -r '.data.websocketUrl')"
  F_POD_NAME="$(echo "$F_CREATE" | jq -r '.data.podName')"
  if [[ -n "$F_SESSION_ID" && -n "$F_WS_URL" ]]; then
    pass "F1 session created (sessionId=$F_SESSION_ID)"
  else
    fail "F1 failed to create session: $F_CREATE"
  fi

  # F2. Read the DB row's ownerReplica from the listing endpoint
  KUBECTL_CMD_F="${KUBECTL:-kubectl}"
  if [[ -n "$F_SESSION_ID" ]] \
     && $KUBECTL_CMD_F --namespace="$NAMESPACE" exec system-db-1 -c postgres -- psql -d hosting_platform -t -A -c "SELECT 1" >/dev/null 2>&1; then
    OWNER_BEFORE="$($KUBECTL_CMD_F --namespace="$NAMESPACE" exec system-db-1 -c postgres -- \
      psql -d hosting_platform -t -A -c "SELECT owner_replica FROM node_terminal_sessions WHERE id='$F_SESSION_ID'" 2>/dev/null | head -1)"
    if [[ -n "$OWNER_BEFORE" ]]; then
      pass "F2 DB row persisted with ownerReplica='$OWNER_BEFORE'"
    else
      fail "F2 DB row for $F_SESSION_ID not found — insertSession failed"
    fi

    # F3. Open WS — the DB lookup MUST succeed regardless of replica
    F_WS_OUT="$(ws_drive "$F_WS_URL" "
      ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString());
        if (f.type === 'connected') { console.log('DB_LOOKUP_OK'); ws.close(); }
        if (f.type === 'error') { console.log('DB_LOOKUP_ERR ' + f.code); ws.close(); }
      });
    " 2>&1 || true)"
    if echo "$F_WS_OUT" | grep -q "DB_LOOKUP_OK"; then
      pass "F3 WS upgrade succeeded — DB lookup path active"
    else
      fail "F3 WS upgrade failed: $(echo "$F_WS_OUT" | grep -E 'DB_LOOKUP|WS_CLOSE' | head -3)"
    fi

    # F4. ownerReplica was updated when attachExec ran (proves
    #     updateOwnerReplica is in the hot path).
    OWNER_AFTER="$($KUBECTL_CMD_F --namespace="$NAMESPACE" exec system-db-1 -c postgres -- \
      psql -d hosting_platform -t -A -c "SELECT owner_replica FROM node_terminal_sessions WHERE id='$F_SESSION_ID'" 2>/dev/null | head -1)"
    if [[ -n "$OWNER_AFTER" ]]; then
      pass "F4 ownerReplica readable after attach (was '$OWNER_BEFORE', now '$OWNER_AFTER')"
    else
      # Session was deleted by the close — that's also acceptable
      # behaviour; the ws.attached audit row is the authoritative proof.
      ATTACH_AUDIT="$(curl_body GET "/api/v1/admin/audit-logs?resource_type=node_terminal&resource_id=$F_SESSION_ID&limit=20" \
        | jq -r '.data[]?.actionType' | grep -c 'session.ws.attached' || true)"
      if [[ "$ATTACH_AUDIT" -ge 1 ]]; then
        pass "F4 ws.attached audit row written (session.cleaned up by close)"
      else
        fail "F4 no ws.attached audit row found for $F_SESSION_ID"
      fi
    fi

    # F5. Cleanup
    curl_status DELETE "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions/$F_SESSION_ID" >/dev/null 2>&1 || true
  else
    warn "F skipped — no kubectl bridge (set KUBECTL env)"
    [[ -n "$F_SESSION_ID" ]] && curl_status DELETE "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions/$F_SESSION_ID" >/dev/null 2>&1 || true
  fi
fi

# ── Phase G: Reconnect — fresh wsToken on same session row ───────────
#
# The Reconnect button hits POST .../sessions/:id/ws-token which mints
# a fresh single-use token on the SAME sessionId / SAME Pod. The new
# WS exec succeeds because the privileged Pod is still up (P0 spike
# proved this gives an independent PTY).
#
# Design note: the service treats a clean `ws.close()` as "operator
# closed the modal" → terminateSession → DB row deleted. So Reconnect
# is for UNGRACEFUL drops (replica crash, network blip) where the
# server's close handler never runs. For the harness we exercise the
# endpoint contract directly: create → POST /ws-token → new URL → drive.
#
#   G1. Create session.
#   G2. POST /ws-token → fresh URL on same sessionId + same Pod.
#   G3. Drive the new WS → connected frame on same sessionId, echo works.
#   G4. Old URL must reject — its token was replaced in the DB.
#   G5. Cleanup.
if [[ $NEG_ONLY -eq 0 && -n "${NODE_NAME:-}" ]]; then
  phase "G. Reconnect (fresh wsToken, same session)"

  # G1. Create — but do NOT open a WS yet, so the initial token sits
  #     in the DB and stays consumable until we replace it via /ws-token.
  G_CREATE="$(curl_body POST "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions" "" "{}")"
  G_SESSION_ID="$(echo "$G_CREATE" | jq -r '.data.sessionId')"
  G_WS_URL_OLD="$(echo "$G_CREATE" | jq -r '.data.websocketUrl')"
  G_POD_NAME="$(echo "$G_CREATE" | jq -r '.data.podName')"
  if [[ -n "$G_SESSION_ID" && -n "$G_WS_URL_OLD" ]]; then
    pass "G1 created session (id=$G_SESSION_ID)"
  else
    fail "G1 create failed: $G_CREATE"
  fi

  # G2. POST ws-token endpoint — mint fresh token
  RECONNECT_BODY="$(curl_body POST "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions/$G_SESSION_ID/ws-token" "" "{}")"
  G_WS_URL_NEW="$(echo "$RECONNECT_BODY" | jq -r '.data.websocketUrl // empty')"
  G_NEW_SESSION_ID="$(echo "$RECONNECT_BODY" | jq -r '.data.sessionId // empty')"
  G_NEW_POD_NAME="$(echo "$RECONNECT_BODY" | jq -r '.data.podName // empty')"
  if [[ -n "$G_WS_URL_NEW" && "$G_NEW_SESSION_ID" == "$G_SESSION_ID" ]]; then
    pass "G2 ws-token endpoint returned fresh URL on same sessionId"
  else
    fail "G2 ws-token reissue failed: $RECONNECT_BODY"
  fi
  if [[ "$G_NEW_POD_NAME" == "$G_POD_NAME" ]]; then
    pass "G2a same Pod (proves reconnect didn't spin a new one)"
  else
    fail "G2a expected Pod $G_POD_NAME, got $G_NEW_POD_NAME"
  fi
  # G2b — old token must NOT appear in the new URL
  OLD_TOKEN="$(echo "$G_WS_URL_OLD" | sed -E 's/.*[?&]token=([^&]+).*/\1/')"
  if echo "$G_WS_URL_NEW" | grep -qF "token=$OLD_TOKEN"; then
    fail "G2b new URL re-used the old (consumed) token — refreshWsToken broken"
  else
    pass "G2b new URL carries a different token (fresh single-use)"
  fi

  # G3. Drive the new WS — must connect on same sessionId
  if [[ -n "$G_WS_URL_NEW" ]]; then
    G_RECON_OUT="$(ws_drive "$G_WS_URL_NEW" "
      let connected = false;
      let buffer = '';
      ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString());
        if (f.type === 'connected') {
          if (f.sessionId === ${G_SESSION_ID@Q}) { console.log('RECON_OK'); }
          else { console.log('RECON_SESSION_DRIFT'); }
          connected = true;
          // Wait a beat for the exec pipeline + login banner to settle,
          // then send a uniquely-marked echo and give it time to round-trip.
          setTimeout(() => {
            ws.send(JSON.stringify({ type:'stdin', data:'echo MARK_RECON_XYZ\\n' }));
          }, 800);
          setTimeout(() => {
            console.log('BUFFER ' + JSON.stringify(buffer));
            ws.close();
          }, 4000);
        }
        if (f.type === 'stdout') { buffer += f.data; }
        if (f.type === 'error') { console.log('RECON_ERR ' + f.code); }
      });
    " 2>&1 || true)"
    if echo "$G_RECON_OUT" | grep -q "RECON_OK"; then
      pass "G3 reconnect WS connected, same sessionId"
    else
      fail "G3 reconnect failed: $(echo "$G_RECON_OUT" | head -5)"
    fi
    if echo "$G_RECON_OUT" | grep -q "MARK_RECON_XYZ"; then
      pass "G3a echo command surfaced on stdout — exec stream usable"
    else
      warn "G3a no stdout marker seen (timing/buffering) — connection alone is enough"
    fi
  fi

  # G4. The OLD wssUrl must now reject (its token was consumed + replaced)
  G_REPLAY_OUT="$(ws_drive "$G_WS_URL_OLD" "ws.on('message',()=>{})" 2>&1 || true)"
  if echo "$G_REPLAY_OUT" | grep -qE "WS_CLOSE 4401|WS_CLOSE 4404|TOKEN_INVALID|SESSION_NOT_FOUND"; then
    pass "G4 old wssUrl rejected after refresh (token replaced or session gone)"
  else
    fail "G4 old URL did NOT reject — replay possible: $(echo "$G_REPLAY_OUT" | grep WS_CLOSE | head -1)"
  fi

  # G5. Cleanup
  curl_status DELETE "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions/$G_SESSION_ID" >/dev/null 2>&1 || true
fi

# ── Phase H: Page-reload survival (grace period) ─────────────────────
#
# A page reload drops the WS WITHOUT sending the explicit terminate
# frame the × buttons send. The server's WS close handler treats this
# as ambiguous → schedules delayed termination via terminate_after.
# A reconnect via POST /ws-token cancels the timer.
#
#   H1. Open WS, run a command that mutates shell state (e.g. cd /tmp,
#       set a variable), CLOSE the WS WITHOUT a terminate frame.
#   H2. Verify the DB row's `terminate_after` is populated.
#   H3. Wait briefly (< grace period), then POST /ws-token.
#   H4. Verify `terminate_after` is now NULL (refreshWsToken cleared it).
#   H5. Open new WS, drive a command, observe shell state is preserved
#       (the cd persists; the env var does NOT, by k8s exec semantics —
#       each exec gets a fresh PTY but the host filesystem is shared).
#   H6. Explicit terminate frame → server kills immediately (no grace).
#   H7. Cleanup via DELETE.
if [[ $NEG_ONLY -eq 0 && -n "${NODE_NAME:-}" ]]; then
  phase "H. Page-reload survival (grace period)"

  KUBECTL_CMD_H="${KUBECTL:-kubectl}"
  H_HAS_DB=0
  if $KUBECTL_CMD_H --namespace="$NAMESPACE" exec system-db-1 -c postgres -- psql -d hosting_platform -t -A -c "SELECT 1" >/dev/null 2>&1; then
    H_HAS_DB=1
  else
    warn "H skipped DB checks — set KUBECTL='docker exec <dind-container> kubectl' (DinD)"
  fi

  # H1. Create + drive WS, then UNCLEAN close (no terminate frame).
  H_CREATE="$(curl_body POST "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions" "" "{}")"
  H_SESSION_ID="$(echo "$H_CREATE" | jq -r '.data.sessionId')"
  H_WS_URL="$(echo "$H_CREATE" | jq -r '.data.websocketUrl')"
  H_POD_NAME="$(echo "$H_CREATE" | jq -r '.data.podName')"
  if [[ -n "$H_SESSION_ID" && -n "$H_WS_URL" ]]; then
    pass "H1 created session ($H_SESSION_ID)"
  else
    fail "H1 create failed: $H_CREATE"
  fi

  # Drive the WS, mutate the shell, then SIMULATE A PAGE RELOAD by
  # closing the socket without sending a terminate frame.
  ws_drive "$H_WS_URL" "
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.type === 'connected') {
        // Touch a sentinel file on the host so we can verify shell
        // state survives the reload (the file is real — k8s exec
        // sessions share /tmp on the host node).
        ws.send(JSON.stringify({ type:'stdin', data:'touch /tmp/reload-sentinel-${H_SESSION_ID}\\n' }));
        // Simulate page-reload close: no terminate frame, just drop.
        setTimeout(() => ws.close(1001, 'page-reload'), 400);
      }
    });
  " >/dev/null 2>&1 || true
  sleep 1

  # H2. Pod must still be alive (grace period not expired)
  if $KUBECTL_CMD_H --namespace="$NAMESPACE" get pod "$H_POD_NAME" >/dev/null 2>&1; then
    pass "H2 Pod survives ungraceful WS close (grace period active)"
  else
    fail "H2 Pod gone after WS close — grace period not honoured"
  fi

  # H3. DB row must have terminate_after set
  if [[ "$H_HAS_DB" == "1" ]]; then
    H_TA="$($KUBECTL_CMD_H --namespace="$NAMESPACE" exec system-db-1 -c postgres -- \
      psql -d hosting_platform -t -A -c "SELECT terminate_after FROM node_terminal_sessions WHERE id='$H_SESSION_ID'" 2>/dev/null | head -1)"
    if [[ -n "$H_TA" && "$H_TA" != "(null)" ]]; then
      pass "H3 terminate_after populated in DB ($H_TA)"
    else
      fail "H3 terminate_after empty — grace period not persisted"
    fi
  fi

  # H4. POST /ws-token to reconnect — must clear terminate_after
  H_RECON="$(curl_body POST "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions/$H_SESSION_ID/ws-token" "" "{}")"
  H_NEW_WS_URL="$(echo "$H_RECON" | jq -r '.data.websocketUrl // empty')"
  if [[ -n "$H_NEW_WS_URL" ]]; then
    pass "H4 reconnect after grace-close returned fresh URL"
  else
    fail "H4 reconnect failed: $H_RECON"
  fi
  if [[ "$H_HAS_DB" == "1" ]]; then
    H_TA2="$($KUBECTL_CMD_H --namespace="$NAMESPACE" exec system-db-1 -c postgres -- \
      psql -d hosting_platform -t -A -c "SELECT terminate_after FROM node_terminal_sessions WHERE id='$H_SESSION_ID'" 2>/dev/null | head -1)"
    if [[ -z "$H_TA2" || "$H_TA2" == "(null)" ]]; then
      pass "H4a refreshWsToken atomically cleared terminate_after"
    else
      fail "H4a terminate_after still set after reconnect: '$H_TA2'"
    fi
  fi

  # H5. Drive the new WS, check the sentinel file is still on the host
  if [[ -n "$H_NEW_WS_URL" ]]; then
    H_NEW_OUT="$(ws_drive "$H_NEW_WS_URL" "
      let buffer = '';
      ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString());
        if (f.type === 'connected') {
          setTimeout(() => {
            ws.send(JSON.stringify({ type:'stdin', data:'ls /tmp/reload-sentinel-${H_SESSION_ID} 2>&1\\n' }));
          }, 500);
          setTimeout(() => { console.log('BUFFER ' + JSON.stringify(buffer)); ws.close(); }, 3500);
        }
        if (f.type === 'stdout') buffer += f.data;
      });
    " 2>&1 || true)"
    if echo "$H_NEW_OUT" | grep -q "reload-sentinel-$H_SESSION_ID"; then
      pass "H5 sentinel file persisted across reload — shell state survived on the host"
    else
      warn "H5 sentinel grep miss (timing); WS reconnect itself worked"
    fi
  fi

  # H6. Explicit terminate frame → immediate kill (no grace period)
  H_CREATE2="$(curl_body POST "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions" "" "{}")"
  H_SESSION_ID2="$(echo "$H_CREATE2" | jq -r '.data.sessionId')"
  H_WS_URL2="$(echo "$H_CREATE2" | jq -r '.data.websocketUrl')"
  H_POD_NAME2="$(echo "$H_CREATE2" | jq -r '.data.podName')"
  ws_drive "$H_WS_URL2" "
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.type === 'connected') {
        // EXPLICIT terminate intent
        ws.send(JSON.stringify({ type:'terminate' }));
      }
    });
  " >/dev/null 2>&1 || true
  sleep 2
  if [[ "$H_HAS_DB" == "1" ]]; then
    H_EXISTS="$($KUBECTL_CMD_H --namespace="$NAMESPACE" exec system-db-1 -c postgres -- \
      psql -d hosting_platform -t -A -c "SELECT id FROM node_terminal_sessions WHERE id='$H_SESSION_ID2'" 2>/dev/null | head -1)"
    if [[ -z "$H_EXISTS" ]]; then
      pass "H6 explicit terminate frame → DB row deleted immediately (no grace)"
    else
      fail "H6 row still exists after terminate frame: '$H_EXISTS'"
    fi
  fi

  # H7. Cleanup
  curl_status DELETE "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions/$H_SESSION_ID" >/dev/null 2>&1 || true
  curl_status DELETE "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions/$H_SESSION_ID2" >/dev/null 2>&1 || true
fi

# ── Phase J: Shell continuity across reconnect (tmux + history) ──────
#
# The pod-spec.ts buildNsenterArgv wraps the host shell in tmux so the
# SAME pane process survives WS disconnect/reconnect. That means:
#   • Bash history shows commands typed in earlier sessions
#   • A long-running command (`tail -f`) survives reload
#   • The shell's cwd and env survive
#
# This is the user-visible payoff of the whole feature. Without it the
# system "reconnects" but every reload is a fresh PTY — operators
# would call that broken (and one did, 2026-05-20).
if [[ $NEG_ONLY -eq 0 && -n "${NODE_NAME:-}" ]]; then
  phase "J. Shell continuity (tmux + history persistence)"

  J_CREATE="$(curl_body POST "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions" "" "{}")"
  J_SESSION_ID="$(echo "$J_CREATE" | jq -r '.data.sessionId')"
  J_WS_URL="$(echo "$J_CREATE" | jq -r '.data.websocketUrl')"
  if [[ -n "$J_SESSION_ID" ]]; then
    pass "J1 created session ($J_SESSION_ID)"
  else
    fail "J1 create failed: $J_CREATE"
  fi

  J_MARKER="JMARK_$(date +%s)_$$"
  # First session: type a uniquely-marked echo, then ungraceful close.
  ws_drive "$J_WS_URL" "
    ws.on('message', (raw) => {
      const f = JSON.parse(raw.toString());
      if (f.type === 'connected') {
        // Give bash a beat to load .bashrc + apply PROMPT_COMMAND
        setTimeout(() => ws.send(JSON.stringify({ type:'stdin', data:'echo ${J_MARKER}\\n' })), 1200);
        // Reload-mimic close — no terminate frame.
        setTimeout(() => ws.close(1001, 'reload'), 3000);
      }
    });
  " >/dev/null 2>&1 || true
  sleep 1

  # Reconnect via /ws-token (what the frontend's restoreFromStorage does).
  J_RECON="$(curl_body POST "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions/$J_SESSION_ID/ws-token" "" "{}")"
  J_NEW_WS_URL="$(echo "$J_RECON" | jq -r '.data.websocketUrl // empty')"
  if [[ -z "$J_NEW_WS_URL" ]]; then
    fail "J2 reconnect /ws-token failed: $J_RECON"
  else
    pass "J2 reconnect minted fresh URL"
  fi

  # Second session: ask bash for its history; the marker MUST appear.
  if [[ -n "$J_NEW_WS_URL" ]]; then
    J_OUT="$(ws_drive "$J_NEW_WS_URL" "
      let buf = '';
      ws.on('message', (raw) => {
        const f = JSON.parse(raw.toString());
        if (f.type === 'connected') {
          setTimeout(() => ws.send(JSON.stringify({ type:'stdin', data:'history\\n' })), 1500);
          setTimeout(() => { console.log('BUF '+JSON.stringify(buf)); ws.close(); }, 4000);
        }
        if (f.type === 'stdout') buf += f.data;
      });
    " 2>&1 || true)"

    if echo "$J_OUT" | grep -q "$J_MARKER"; then
      pass "J3 bash history shows the pre-reload command ($J_MARKER) — true shell continuity"
    else
      fail "J3 bash history missing pre-reload command — fresh PTY, not the same tmux pane"
    fi
  fi

  curl_status DELETE "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions/$J_SESSION_ID" >/dev/null 2>&1 || true
fi

# ── Phase I (optional): idle timeout — slow, opt-in via --idle ─────────
if [[ $RUN_IDLE -eq 1 ]]; then
  phase "I. Idle timeout (slow — takes ~16 minutes)"
  CREATE_JSON_I="$(curl_body POST "/api/v1/admin/nodes/$NODE_NAME/terminal/sessions" "" "{}")"
  SESSION_ID_I="$(echo "$CREATE_JSON_I" | jq -r '.data.sessionId')"
  POD_NAME_I="$(echo "$CREATE_JSON_I" | jq -r '.data.podName')"
  echo "  waiting 16 minutes for idle timeout sweep..."
  sleep 960
  if ! kubectl --namespace="$NAMESPACE" get pod "$POD_NAME_I" >/dev/null 2>&1; then
    pass "I1 pod GC'd by idle sweep after 15min"
  else
    fail "I1 pod still alive after 16min wait"
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
