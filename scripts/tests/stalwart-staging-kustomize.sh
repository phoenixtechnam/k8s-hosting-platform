#!/usr/bin/env bash
# Kustomize-level assertions for the staging Stalwart overlay.
#
# These tests encode the Phase A design (2026-04-23):
#   1. Stalwart's public-facing Service on staging must be externally
#      reachable WITHOUT a cloud LoadBalancer provider. The staging
#      overlay pins externalIPs: [<node public ip>] on the ClusterIP
#      Service so mail ports (25/465/587/143/993/110/995/4190) bind
#      directly to the node IP. Forward-compatible with multi-node:
#      extend the list when additional nodes join.
#   2. stalwart-backup CronJob must NOT use the removed
#      `stalwart-cli server backup <path>` subcommand (dropped in
#      v0.15+). Must use `server database-maintenance` or equivalent.
#
# Verified via `kubectl kustomize k8s/overlays/staging | yq` — so we
# assert on the real post-build manifest, not just the patch source.
#
# Run locally: bash scripts/tests/stalwart-staging-kustomize.sh
# Passes = exit 0, any failure = exit 1 + human-readable message.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
STAGING_NODE_IP="89.167.3.56"

TOTAL=0
PASSED=0
FAILED=0

pass() { PASSED=$((PASSED+1)); echo "  PASS: $1"; }
fail() { FAILED=$((FAILED+1)); echo "  FAIL: $1" >&2; [ -n "${2:-}" ] && echo "    $2" >&2; }
run_test() { TOTAL=$((TOTAL+1)); echo "TEST: $1"; "$2" || true; }

# Build manifest once, cache.
BUILD="$(mktemp)"
trap 'rm -f "$BUILD"' EXIT

build_staging() {
  local repo="$1"
  # bitnami/kubectl has kustomize bundled.
  docker run --rm -v "$repo:/repo" -w /repo --entrypoint sh bitnami/kubectl:latest -c '
    apk add --no-cache curl >/dev/null 2>&1
    [ -x /usr/local/bin/yq ] || {
      curl -sL https://github.com/mikefarah/yq/releases/latest/download/yq_linux_amd64 \
        -o /usr/local/bin/yq && chmod +x /usr/local/bin/yq
    }
    kubectl kustomize k8s/overlays/staging
  ' 2>&1
}

echo "Building staging overlay (docker + kustomize)..."
if ! build_staging "$REPO_ROOT" > "$BUILD" 2>&1; then
  echo "FATAL: kustomize build k8s/overlays/staging failed." >&2
  head -20 "$BUILD" >&2
  exit 2
fi
BUILD_LINES=$(wc -l < "$BUILD")
echo "  built: $BUILD_LINES lines"

# ─── Assertion helpers ──────────────────────────────────────────────────────
# yq is the most readable way to introspect a multi-doc YAML stream, but we
# also need to run yq against our build. Simplest: pipe into a throwaway
# docker with yq bundled.

yq_eval() {
  # $1 = yq expression; stdin = YAML; stdout = result
  docker run --rm -i --entrypoint yq mikefarah/yq:4 eval-all "$1" -
}

assert_stalwart_mail_service_type() {
  local expected="ClusterIP"
  local actual
  actual=$(yq_eval 'select(.kind=="Service" and .metadata.name=="stalwart-mail") | .spec.type' < "$BUILD")
  # yq emits the literal string without quotes; an unset field is "null".
  case "$actual" in
    "$expected")
      pass "stalwart-mail Service is ClusterIP (externalIPs pattern, not LoadBalancer)"
      ;;
    *)
      fail "stalwart-mail Service type" "expected '$expected', got '$actual'"
      ;;
  esac
}

assert_stalwart_mail_external_ips() {
  local ips
  ips=$(yq_eval 'select(.kind=="Service" and .metadata.name=="stalwart-mail") | .spec.externalIPs[]' < "$BUILD" | sort -u | tr '\n' ',' | sed 's/,$//')
  if [[ "$ips" == *"$STAGING_NODE_IP"* ]]; then
    pass "stalwart-mail Service externalIPs contains $STAGING_NODE_IP (actual: $ips)"
  else
    fail "stalwart-mail Service externalIPs" "expected to contain $STAGING_NODE_IP, got '$ips'"
  fi
}

assert_stalwart_backup_cli_syntax() {
  # Grep the CronJob's args for the removed `server backup <path>` pattern.
  # If present, fails. Also require `database-maintenance` (the v0.15+
  # replacement) to be present — that's the positive assertion.
  local args
  # The stalwart-backup container uses `command: [/bin/sh, -c, <script>]`,
  # so the shell script sits at command[2], not args[].
  args=$(yq_eval 'select(.kind=="CronJob" and .metadata.name=="stalwart-backup") | .spec.jobTemplate.spec.template.spec.containers[0].command[2]' < "$BUILD")
  # Strip shell comment lines before grepping — comments in the script
  # legitimately reference the removed subcommand in the "why" doc; we
  # only care about actual executed commands.
  local code
  code=$(grep -v -E '^[[:space:]]*#' <<< "$args")
  if grep -qE 'stalwart-cli[^|]*server[[:space:]]+backup[[:space:]]' <<< "$code"; then
    fail "stalwart-backup uses removed 'server backup <path>' subcommand" "update to 'server database-maintenance' for v0.15+"
    return
  fi
  if ! grep -qE 'server[[:space:]]+database-maintenance' <<< "$code"; then
    fail "stalwart-backup missing 'server database-maintenance'" "v0.15+ requires a quiesce via database-maintenance"
    return
  fi
  pass "stalwart-backup uses v0.15+ compatible CLI (database-maintenance, no 'server backup')"
}

assert_stalwart_backup_freshness_marker() {
  # The BACKUP_OK_<ts> marker is how dr-restore.sh verifies a snapshot
  # captured a post-quiesce state — keep it across the CronJob rewrite.
  local args
  # The stalwart-backup container uses `command: [/bin/sh, -c, <script>]`,
  # so the shell script sits at command[2], not args[].
  args=$(yq_eval 'select(.kind=="CronJob" and .metadata.name=="stalwart-backup") | .spec.jobTemplate.spec.template.spec.containers[0].command[2]' < "$BUILD")
  if grep -q 'BACKUP_OK_' <<< "$args"; then
    pass "stalwart-backup freshness marker BACKUP_OK_<ts> preserved"
  else
    fail "stalwart-backup freshness marker missing" "keep BACKUP_OK_<ts> so dr-restore.sh can assert a clean snapshot"
  fi
}

assert_mgmt_service_untouched() {
  # ClusterIP mgmt service must stay internal-only (no externalIPs, no LB).
  local t
  t=$(yq_eval 'select(.kind=="Service" and .metadata.name=="stalwart-mail-mgmt") | .spec.type' < "$BUILD")
  if [[ "$t" == "ClusterIP" ]]; then
    pass "stalwart-mail-mgmt Service stays ClusterIP"
  else
    fail "stalwart-mail-mgmt Service type drift" "expected ClusterIP, got '$t'"
  fi
}

assert_dev_overlay_unchanged_type() {
  # Dev Stalwart is deployed via its own kustomization (not the main dev
  # overlay) — matches how ./scripts/local.sh mail-up applies it.
  local devbuild
  devbuild=$(docker run --rm -v "$REPO_ROOT:/repo" -w /repo bitnami/kubectl:latest kustomize k8s/overlays/dev/stalwart 2>&1)
  local t
  t=$(yq_eval 'select(.kind=="Service" and .metadata.name=="stalwart-mail") | .spec.type' <<< "$devbuild")
  if [[ "$t" == "NodePort" ]]; then
    pass "dev overlay Stalwart Service type unchanged (NodePort)"
  else
    fail "dev overlay Stalwart Service type changed" "expected NodePort, got '$t'"
  fi
}

run_test "stalwart-mail Service type is ClusterIP"        assert_stalwart_mail_service_type
run_test "stalwart-mail Service externalIPs contains node IP" assert_stalwart_mail_external_ips
run_test "stalwart-mail-mgmt Service stays ClusterIP"      assert_mgmt_service_untouched
run_test "stalwart-backup CLI syntax v0.15+ compatible"    assert_stalwart_backup_cli_syntax
run_test "stalwart-backup freshness marker preserved"      assert_stalwart_backup_freshness_marker
run_test "dev overlay regression: Service type is NodePort" assert_dev_overlay_unchanged_type

echo ""
echo "Summary: $PASSED/$TOTAL passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
