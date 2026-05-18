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

# 7. WS handler must check user.role === 'super_admin' (defence in depth
#    against any future hook-bypass on the WS upgrade path).
if ! grep -Eq "user\.role[[:space:]]*!==[[:space:]]*'super_admin'" "$ROUTES"; then
  fail "routes.ts WS handler must verify user.role !== 'super_admin' as a belt-and-braces check."
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

echo "[ci-node-terminal-check] OK — all security invariants intact."
