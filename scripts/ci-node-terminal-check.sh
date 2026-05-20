#!/usr/bin/env bash
# CI guard — rejects regressions on load-bearing security invariants
# of the admin node-terminal feature. Wire into Infrastructure CI.
#
# What this catches:
#   1. Anyone flipping `runAsNonRoot: true` on the terminal Pod spec
#      (would break nsenter — root in host PID 1 needs CAP_SYS_ADMIN).
#   2. NODE_TERMINAL_ENABLED defaulting to anything other than 'false'
#      in code (the flag must be opt-in; staging/prod set it explicitly).
#   3. Roles other than super_admin appearing on the routes' requireRole
#      gate (no admin/billing/support/read_only/tenant_*).
#   4. The privileged terminal Pod spec accidentally getting `privileged:
#      false` (would also defeat the feature).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
POD_SPEC="$ROOT/backend/src/modules/node-terminal/pod-spec.ts"
ROUTES="$ROOT/backend/src/modules/node-terminal/routes.ts"
APP_TS="$ROOT/backend/src/app.ts"

fail() {
  echo "[ci-node-terminal-check] FAIL: $1" >&2
  exit 1
}

if [[ ! -f "$POD_SPEC" ]]; then
  fail "Cannot find $POD_SPEC"
fi
if [[ ! -f "$ROUTES" ]]; then
  fail "Cannot find $ROUTES"
fi
if [[ ! -f "$APP_TS" ]]; then
  fail "Cannot find $APP_TS"
fi

# Strip // comments and /* ... */ blocks before grepping, so a docstring
# that MENTIONS `runAsNonRoot: true` doesn't trip the guard.
POD_SPEC_CODE=$(sed -e 's://.*$::' -e '/\/\*/,/\*\//d' "$POD_SPEC")

# 1. runAsNonRoot must never appear with true value in pod-spec code.
if echo "$POD_SPEC_CODE" | grep -Eq 'runAsNonRoot[[:space:]]*:[[:space:]]*true'; then
  fail "pod-spec.ts must NOT set runAsNonRoot:true — breaks nsenter into host PID 1."
fi

# 2. privileged must remain true in pod-spec.
if ! echo "$POD_SPEC_CODE" | grep -Eq 'privileged[[:space:]]*:[[:space:]]*true'; then
  fail "pod-spec.ts is missing the load-bearing securityContext.privileged:true."
fi

# 3. hostPID must remain true.
if ! echo "$POD_SPEC_CODE" | grep -Eq 'hostPID[[:space:]]*:[[:space:]]*true'; then
  fail "pod-spec.ts is missing the load-bearing spec.hostPID:true."
fi

# 4. activeDeadlineSeconds must remain set.
if ! grep -Eq 'activeDeadlineSeconds' "$POD_SPEC"; then
  fail "pod-spec.ts must declare activeDeadlineSeconds — the k8s-level kill switch."
fi

# 5. routes.ts must require super_admin EXCLUSIVELY on requireRole.
#    A loose check: require the literal `requireRole('super_admin')` to appear,
#    and reject any `requireRole(...)` invocation that includes other admin roles.
if ! grep -Eq "requireRole\('super_admin'\)" "$ROUTES"; then
  fail "routes.ts must declare requireRole('super_admin') — strictest role gate."
fi
if grep -Eq "requireRole\('super_admin',[[:space:]]*'(admin|billing|support|read_only|tenant_admin|tenant_user)'" "$ROUTES"; then
  fail "routes.ts requireRole must NOT include any role other than super_admin."
fi

# 6. NODE_TERMINAL_ENABLED default in app.ts must remain 'false'.
#    The flag falls back through the chain `config ?? env ?? 'false'`.
#    We grep for the literal "?? 'false'" with the flag name nearby.
if ! grep -B1 -A6 "NODE_TERMINAL_ENABLED" "$APP_TS" | grep -Eq "\?\?[[:space:]]*'false'"; then
  fail "app.ts NODE_TERMINAL_ENABLED default must remain 'false' (opt-in feature flag)."
fi

# 7. WS handler must reject any caller whose role is not super_admin
#    (defence-in-depth against future hook-bypass on the WS upgrade
#    path). The expected pattern is `if (user.role !== 'super_admin')`
#    leading to a reject. We grep for the literal predicate.
if ! grep -Eq "user\.role[[:space:]]*!==[[:space:]]*'super_admin'" "$ROUTES"; then
  fail "routes.ts WS handler must contain 'user.role !== \\'super_admin\\'' rejection predicate as a belt-and-braces check."
fi

# 8. WS handler must verify panel === 'admin' (security finding M2 —
#    same defence-in-depth posture as the role check).
if ! grep -Eq "user\.panel[[:space:]]*!==[[:space:]]*'admin'" "$ROUTES"; then
  fail "routes.ts WS handler must verify user.panel !== 'admin' as a belt-and-braces check."
fi

# 9. authenticateWs must reject pre-auth (passkey 2FA) tokens — they
#    carry a `step` claim and must NEVER pass a privileged auth gate.
if ! grep -Eq "decoded as.*step|payload.*\.step" "$ROUTES"; then
  fail "routes.ts authenticateWs must reject JWTs carrying a 'step' claim."
fi

# 10. Pino redact rules must scrub the WS token query param (security
#     finding C2). Without this, tokens leak into platform-api logs.
#     Matches the regex literal that captures token|replica.
if ! grep -Eq "\(token\|replica\)=" "$APP_TS"; then
  fail "app.ts Pino redact must scrub ?token=/?replica= from URLs to prevent ws-token leakage in logs."
fi

# 11. consumeWsTokenForSession must enforce a TTL (security finding C1).
SERVICE_TS="$ROOT/backend/src/modules/node-terminal/service.ts"
SERVICE_CODE=$(sed -e 's://.*$::' -e '/\/\*/,/\*\//d' "$SERVICE_TS")
if ! echo "$SERVICE_CODE" | grep -Eq 'WS_TOKEN_TTL_MS|wsTokenIssuedAt'; then
  fail "service.ts must enforce a TTL on wsToken consumption (WS_TOKEN_TTL_MS)."
fi

# 12. Pod-name uses full UUID (security finding H3 — avoids 8-char
#     prefix collisions).
POD_SPEC_CODE2=$(sed -e 's://.*$::' "$POD_SPEC")
if echo "$POD_SPEC_CODE2" | grep -Eq 'sessionId\.slice\(0,[[:space:]]*8\)'; then
  fail "pod-spec.ts must not truncate sessionId — use the full UUID (avoids collision)."
fi

# 13. attachExec MUST consult the DB via session-store.findById — the
#     load-bearing fix for HA stickiness (PR1 of the ADR-041 follow-up).
#     A future refactor that reintroduces an in-memory-only fast path
#     would silently break re-attach across platform-api replicas.
if ! echo "$SERVICE_CODE" | grep -Eq 'sessionStore\.findById|findById\('; then
  fail "service.ts attachExec must call session-store findById — DB lookup is required for HA stickiness."
fi

# 14. createSession MUST persist the session row via insertSession.
#     Without this, attachExec on any other replica returns
#     SESSION_NOT_FOUND because the row never made it to the DB.
if ! echo "$SERVICE_CODE" | grep -Eq 'sessionStore\.insertSession|insertSession\('; then
  fail "service.ts createSession must call session-store insertSession — DB persistence is required."
fi

# 15. The raw wsToken MUST be hashed before being written to the DB.
#     The store's insertSession + refreshWsToken implementations call
#     hashWsToken(rawToken) inside the SET clause. Reject any code path
#     that assigns wsTokenHash from a raw string (i.e. without
#     hashWsToken(...) on the right-hand side).
#
#     NOTE: this guard is INTENTIONALLY strict — the RHS of every
#     `wsTokenHash:` assignment in session-store.ts must contain either
#     `hashWsToken(` or `null` literally. A maintainer introducing a
#     helper like `wsTokenHash: alreadyHashedBytes` will trip this guard
#     even if the bytes were produced upstream by hashWsToken. The
#     intended escape hatch is to call `hashWsToken(...)` inline at the
#     assignment site (the cost is one extra hash call; the benefit is
#     trivial static review of "raw token never persisted").
STORE_TS="$ROOT/backend/src/modules/node-terminal/session-store.ts"
if [[ ! -f "$STORE_TS" ]]; then
  fail "Cannot find $STORE_TS"
fi
STORE_CODE=$(sed -e 's://.*$::' -e '/\/\*/,/\*\//d' "$STORE_TS")
# wsTokenHash must only ever be assigned from hashWsToken(...) or null.
# Grep every assignment line and verify the RHS contains hashWsToken or
# is exactly `null`. If we find any assignment that doesn't satisfy
# that, fail loudly.
ASSIGN_LINES=$(echo "$STORE_CODE" | grep -E 'wsTokenHash[[:space:]]*:' || true)
while IFS= read -r line; do
  [[ -z "$line" ]] && continue
  # A type-annotation in InsertInput interface looks like
  # `wsToken: string;` — that's NOT an assignment, skip lines with no `,` or `(`.
  if ! echo "$line" | grep -Eq 'hashWsToken\(|null'; then
    fail "session-store.ts: wsTokenHash must only be assigned from hashWsToken(...) or null. Offending line: $line"
  fi
done <<< "$ASSIGN_LINES"

# Defence-in-depth: insertSession's parameter is `wsToken` (raw), and
# the implementation MUST call hashWsToken on it before persisting.
if ! echo "$STORE_CODE" | grep -Eq 'hashWsToken\(input\.wsToken\)|hashWsToken\(newToken\)|hashWsToken\(rawToken\)'; then
  fail "session-store.ts insertSession/refreshWsToken must hash the raw token (hashWsToken) before persistence."
fi

# 16. Grace-period reload survival — the WS close handler MUST go
#     through scheduleDelayedTermination, not call terminateSession
#     synchronously. A regression here would re-introduce the bug
#     where page reload immediately kills the privileged Pod.
#
#     The expected pattern (in finalize() inside attachExec):
#       if (explicitTerminate || reason === 'shell_exited') {
#         await terminateSession(...)
#       } else {
#         await scheduleDelayedTermination(...)
#       }
#     We grep for scheduleDelayedTermination's presence inside service.ts.
if ! echo "$SERVICE_CODE" | grep -Eq 'scheduleDelayedTermination\('; then
  fail "service.ts must call scheduleDelayedTermination on ambiguous WS close — load-bearing for page-reload survival."
fi
# Also: refreshWsToken in session-store MUST clear terminate_after so
# the reconnect path can't race with an in-flight scheduler reap.
if ! echo "$STORE_CODE" | grep -Eq 'refreshWsToken' || ! echo "$STORE_CODE" | grep -A20 'export async function refreshWsToken' | grep -Eq 'terminateAfter:[[:space:]]*null'; then
  fail "session-store.ts refreshWsToken must clear terminate_after atomically with the token refresh (reconnect-vs-reap race fix)."
fi

# 17. consumeWsToken MUST also clear terminate_after atomically.
# Without this, a scheduler sweep landing between token-consume and a
# follow-up cancelDelayedTermination round-trip would terminate a
# freshly-reconnected session. Same race class as 16, second site.
if ! echo "$STORE_CODE" | grep -A20 'export async function consumeWsToken' | grep -Eq 'terminateAfter:[[:space:]]*null'; then
  fail "session-store.ts consumeWsToken must clear terminate_after atomically with the token consume (closes WS-reattach vs scheduler-reap TOCTOU)."
fi

# 18. Cross-replica grace-timer safety. The in-memory setTimeout in
# scheduleDelayedTermination MUST re-check the DB row's terminate_after
# before calling terminateSession. Without this, a reconnect that
# lands on a different replica leaves the original replica's stale
# in-memory timer running — when it fires (60s later) it kills the
# session the user is actively connected to on the other replica.
# (Production-observed regression on staging 2026-05-20.)
if ! echo "$SERVICE_CODE" | grep -A35 'export async function scheduleDelayedTermination' \
   | grep -Eq 'findById|terminateAfter[[:space:]]*===[[:space:]]*null|terminateAfter[[:space:]]*\.getTime'; then
  fail "service.ts scheduleDelayedTermination's setTimeout MUST re-check terminate_after via findById before calling terminateSession (cross-replica safety)."
fi

# 19. Per-session host-filesystem cleanup. The Pod's preStop lifecycle
# hook MUST `rm -f` both the HISTFILE and tmux config that the inner
# shell creates on the host. Without this, /root and /tmp accumulate
# one tiny file per session forever (operator-reported leak on
# staging 2026-05-20). The hook nsenters into PID 1's mount namespace
# so it can see the host's filesystem (the files don't exist inside
# the Pod's container fs).
if ! echo "$POD_SPEC_CODE" | grep -Eq "preStop:" \
   || ! echo "$POD_SPEC_CODE" | grep -Eq "rm -f.*bash_history-" \
   || ! echo "$POD_SPEC_CODE" | grep -Eq "rm -f.*\.nt-tmux-"; then
  fail "pod-spec.ts must declare a preStop lifecycle hook that rm -fs /root/.bash_history-<id> AND /tmp/.nt-tmux-<id>.conf — required to prevent per-session host-fs leaks."
fi

echo "[ci-node-terminal-check] OK — all 19 security + reliability invariants intact."
