#!/usr/bin/env bash
# Smoke-test the generate_operator_recipient function in isolation.
# Sources bootstrap.sh with the main-guard ON (only runs main() when
# executed directly, not when sourced), then calls the function under
# a shim that replaces age-keygen + kctl with deterministic fakes, so
# we can assert on:
#   - idempotent no-op when ConfigMap already exists
#   - operator-supplied recipient is validated + applied as-is
#   - generated recipient round-trips via age-keygen
#   - --force-rotate-operator-key overrides the existence gate
#   - invalid recipient is rejected
#
# Run: bash scripts/tests/bootstrap-operator-age.sh
# Passes with all tests green, exits non-zero otherwise.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$REPO_ROOT/scripts/bootstrap.sh"

TOTAL=0
PASSED=0
FAILED=0

pass() { PASSED=$((PASSED+1)); echo "  PASS: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAIL: $1" >&2; echo "    $2" >&2; }

run_test() {
  TOTAL=$((TOTAL+1))
  local name="$1"
  local testfn="$2"
  echo "TEST: $name"
  "$testfn" || true
}

# ─── Shim helpers ─────────────────────────────────────────────────────────────

make_shim_dir() {
  local dir
  dir="$(mktemp -d)"
  echo "$dir"
}

# $1 = shim dir
# $2 = "yes"/"no" — whether `kctl get configmap platform-operator-recipient`
#                   should succeed (simulating "already exists")
# $3 = file path to a state-log the shim appends to (who called what)
install_kctl_shim() {
  local dir="$1"
  local exists="$2"
  local log="$3"
  cat > "$dir/kctl" <<SHIM
#!/usr/bin/env bash
echo "kctl \$*" >> "$log"
if [ "\$1" = "get" ] && [ "\$2" = "configmap" ] && [ "\$3" = "platform-operator-recipient" ]; then
  if [ "$exists" = "yes" ]; then
    echo "configmap/platform-operator-recipient   1      1m"
    exit 0
  fi
  echo "Error from server (NotFound): configmaps \"platform-operator-recipient\" not found" >&2
  exit 1
fi
if [ "\$1" = "create" ] && [ "\$2" = "configmap" ]; then
  cat <<'YAML'
apiVersion: v1
kind: ConfigMap
metadata:
  name: platform-operator-recipient
  namespace: platform
data:
  recipient: "stub"
YAML
  exit 0
fi
if [ "\$1" = "apply" ]; then
  cat > /dev/null   # consume stdin
  exit 0
fi
exit 0
SHIM
  chmod +x "$dir/kctl"
}

install_age_keygen_shim() {
  local dir="$1"
  cat > "$dir/age-keygen" <<'SHIM'
#!/usr/bin/env bash
out=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) out="$2"; shift 2 ;;
    *) shift ;;
  esac
done
[ -n "$out" ] || { echo "shim: -o required" >&2; exit 1; }
cat > "$out" <<'BODY'
# created: 2026-04-22T00:00:00Z
# public key: age1stubstubstubstubstubstubstubstubstubstubstubstubstubs
AGE-SECRET-KEY-1STUBSTUBSTUBSTUBSTUBSTUBSTUBSTUBSTUBSTUBSTUBSTUBS
BODY
SHIM
  chmod +x "$dir/age-keygen"
}

# Run the function under test in a fresh bash subshell. The subshell:
# 1. Prepends the shim dir to PATH (so age-keygen is our stub).
# 2. Sources bootstrap.sh — the BASH_SOURCE guard at the bottom prevents
#    main() from firing.
# 3. Overrides error() (returns 1 instead of exit) so test assertions
#    can fire, and kctl() to route through the shim binary.
# 4. Sets the globals the caller asked for and invokes the function.
#
# $1 = shim dir
# $2 = OPERATOR_AGE_RECIPIENT value
# $3 = FORCE_ROTATE_OPERATOR_KEY value
# $4+ = function to call + args
source_and_call() {
  local shim_dir="$1"; shift
  local recipient="$1"; shift
  local force="$1"; shift
  bash <<BASH
export PATH="$shim_dir:\$PATH"
set +e
# shellcheck source=/dev/null
source "$SCRIPT"
error() { echo "[error] \$*" >&2; return 1; }
marker_exists() { return 1; }
marker_set() { return 0; }
kctl() { "$shim_dir/kctl" "\$@"; }
OPERATOR_AGE_RECIPIENT="$recipient"
FORCE_ROTATE_OPERATOR_KEY="$force"
$*
BASH
}

# ─── Tests ────────────────────────────────────────────────────────────────────

test_no_op_when_configmap_exists() {
  local shim_dir log
  shim_dir="$(make_shim_dir)"
  log="$shim_dir/log"
  : > "$log"
  install_kctl_shim "$shim_dir" yes "$log"
  install_age_keygen_shim "$shim_dir"

  local stdout stderr rc
  stdout="$(source_and_call "$shim_dir" '' false generate_operator_recipient 2>"$shim_dir/err")"
  rc=$?
  stderr="$(cat "$shim_dir/err")"

  if [ $rc -eq 0 ] && grep -q 'already exists' <<< "$stdout$stderr" && ! grep -q 'create configmap' "$log"; then
    pass "no-op when ConfigMap exists"
  else
    fail "no-op when ConfigMap exists" "rc=$rc stdout=<$stdout> stderr=<$stderr> log=$(cat "$log")"
  fi
  rm -rf "$shim_dir"
}

test_operator_supplied_recipient_applied() {
  local shim_dir log
  shim_dir="$(make_shim_dir)"
  log="$shim_dir/log"
  : > "$log"
  install_kctl_shim "$shim_dir" no "$log"
  install_age_keygen_shim "$shim_dir"

  local recipient='age1zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz'
  local rc
  source_and_call "$shim_dir" "$recipient" false generate_operator_recipient >"$shim_dir/out" 2>"$shim_dir/err"
  rc=$?

  if [ $rc -eq 0 ] && grep -q -- "--from-literal=recipient=$recipient" "$log"; then
    pass "operator-supplied recipient applied as-is"
  else
    fail "operator-supplied recipient applied as-is" "rc=$rc log=$(cat "$log") err=$(cat "$shim_dir/err")"
  fi
  rm -rf "$shim_dir"
}

test_generated_recipient_applied() {
  local shim_dir log
  shim_dir="$(make_shim_dir)"
  log="$shim_dir/log"
  : > "$log"
  install_kctl_shim "$shim_dir" no "$log"
  install_age_keygen_shim "$shim_dir"

  local rc
  source_and_call "$shim_dir" '' false generate_operator_recipient >"$shim_dir/out" 2>"$shim_dir/err"
  rc=$?

  if [ $rc -eq 0 ] \
      && grep -q 'age1stubstub' "$shim_dir/err" \
      && grep -q 'AGE-SECRET-KEY-1STUBSTUB' "$shim_dir/err" \
      && grep -q -- '--from-literal=recipient=age1stubstub' "$log"; then
    pass "generated recipient printed to stderr and ConfigMap'd"
  else
    fail "generated recipient printed to stderr and ConfigMap'd" "rc=$rc err=$(cat "$shim_dir/err") log=$(cat "$log")"
  fi
  rm -rf "$shim_dir"
}

test_force_rotate_overrides_exists_check() {
  local shim_dir log
  shim_dir="$(make_shim_dir)"
  log="$shim_dir/log"
  : > "$log"
  install_kctl_shim "$shim_dir" yes "$log"
  install_age_keygen_shim "$shim_dir"

  local rc
  source_and_call "$shim_dir" '' true generate_operator_recipient >"$shim_dir/out" 2>"$shim_dir/err"
  rc=$?

  if [ $rc -eq 0 ] && grep -q -- '--from-literal=recipient=age1stubstub' "$log"; then
    pass "--force-rotate-operator-key regenerates"
  else
    fail "--force-rotate-operator-key regenerates" "rc=$rc log=$(cat "$log") err=$(cat "$shim_dir/err")"
  fi
  rm -rf "$shim_dir"
}

test_invalid_recipient_rejected() {
  local shim_dir log
  shim_dir="$(make_shim_dir)"
  log="$shim_dir/log"
  : > "$log"
  install_kctl_shim "$shim_dir" no "$log"
  install_age_keygen_shim "$shim_dir"

  local rc
  source_and_call "$shim_dir" 'notarealage1key' false generate_operator_recipient >"$shim_dir/out" 2>"$shim_dir/err"
  rc=$?

  # Rejection must fail (non-zero) AND must NOT write to the ConfigMap.
  if [ $rc -ne 0 ] && ! grep -q 'create configmap' "$log"; then
    pass "invalid recipient rejected"
  else
    fail "invalid recipient rejected" "rc=$rc log=$(cat "$log") err=$(cat "$shim_dir/err")"
  fi
  rm -rf "$shim_dir"
}

run_test "no-op when ConfigMap exists" test_no_op_when_configmap_exists
run_test "operator-supplied recipient applied as-is" test_operator_supplied_recipient_applied
run_test "generated recipient printed + ConfigMap'd" test_generated_recipient_applied
run_test "--force-rotate-operator-key regenerates" test_force_rotate_overrides_exists_check
run_test "invalid recipient rejected" test_invalid_recipient_rejected

echo ""
echo "Summary: $PASSED/$TOTAL passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
