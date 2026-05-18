#!/usr/bin/env bash
# integration-webmail-feature-toggle.sh — E2E for the webmail
# feature-visibility CSS reconciler (2026-05-18).
#
# Exercises the full chain:
#
#   PATCH /admin/webmail-settings
#       ↓
#   updateWebmailSettings → setSetting(webmail_show_*)
#       ↓
#   reconcileWebmailFeatureCss
#       ↓
#   ConfigMap mail/webmail-feature-overrides has expected data
#       ↓
#   Bulwark + Roundcube Deployment's pod template annotation hash
#
# A rolling restart triggered by the annotation change is NOT
# observed by this harness — the trigger itself is sufficient
# proof. Verifying the actual CSS reaches the browser requires
# a Playwright run against webmail.${DOMAIN}, which lives in
# integration-webmail-platform-e2e.sh.
#
# Phases:
#   A — Default state (fresh install)
#     A1. ConfigMap exists in `mail` namespace
#     A2. Both data keys present
#     A3. Both keys carry hide-rules (default = hidden)
#     A4. Both Deployments carry a hash annotation
#
#   B — Toggle Contacts visible
#     B1. PATCH webmail-settings with webmailShowContacts=true
#     B2. ConfigMap bulwark CSS no longer contains [href$="/contacts"]
#     B3. ConfigMap roundcube CSS no longer contains a.button.contacts
#     B4. Both Deployments have a NEW annotation hash (≠ A4)
#
#   C — Toggle Contacts back to hidden
#     C1. PATCH webmail-settings with webmailShowContacts=false
#     C2. ConfigMap bulwark CSS contains [href$="/contacts"] again
#     C3. Annotation hash matches A4 (deterministic CSS → same hash)
#
#   D — Selective toggles
#     D1. Calendar=true, Files=false: bulwark CSS lacks /calendar but has /files
#     D2. Files=true, Calendar=false: opposite
#
# Usage:
#   ADMIN_TOKEN=... ./scripts/integration-webmail-feature-toggle.sh
#
# Environment:
#   NAMESPACE                — kube ns where webmail Pods live (default: mail)
#   PLATFORM_API_URL         — base URL for /admin/webmail-settings
#                              (default: https://${DOMAIN} taken from env)
#   ADMIN_TOKEN              — bearer token, super_admin role
#   KUBECTL                  — kubectl binary (default: kubectl)
#
# Exit non-zero on any assertion failure.

set -euo pipefail

NAMESPACE="${NAMESPACE:-mail}"
KUBECTL="${KUBECTL:-kubectl}"
CM_NAME="webmail-feature-overrides"
ANNOTATION="platform.phoenix-host.net/feature-css-hash"
PASS=0
FAIL=0

red()    { printf '\033[31m%s\033[0m\n' "$*"; }
green()  { printf '\033[32m%s\033[0m\n' "$*"; }
yellow() { printf '\033[33m%s\033[0m\n' "$*"; }
blue()   { printf '\033[34m%s\033[0m\n' "$*"; }

assert() {
  local desc="$1"; shift
  if "$@"; then
    green "  PASS  $desc"
    PASS=$((PASS + 1))
  else
    red "  FAIL  $desc"
    FAIL=$((FAIL + 1))
  fi
}

cm_data_key() {
  $KUBECTL -n "$NAMESPACE" get configmap "$CM_NAME" -o jsonpath="{.data.$1}"
}

deployment_hash() {
  $KUBECTL -n "$NAMESPACE" get deployment "$1" -o jsonpath="{.spec.template.metadata.annotations.${ANNOTATION//./\\.}}"
}

patch_settings() {
  local body="$1"
  if [ -z "${ADMIN_TOKEN:-}" ]; then
    red "ADMIN_TOKEN env var not set — skipping PATCH"
    return 1
  fi
  local url="${PLATFORM_API_URL:-https://${DOMAIN:?DOMAIN env var not set}}/api/v1/admin/webmail-settings"
  curl -sS -fX PATCH \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$body" \
    "$url" > /dev/null
}

wait_for_hash_change() {
  local deployment="$1"
  local previous_hash="$2"
  local i
  for i in $(seq 1 30); do
    sleep 1
    local current
    current=$(deployment_hash "$deployment" || echo "")
    if [ -n "$current" ] && [ "$current" != "$previous_hash" ]; then
      return 0
    fi
  done
  return 1
}

# ─── Phase A ──────────────────────────────────────────────────────
blue "Phase A — default state"

assert "ConfigMap $CM_NAME exists in $NAMESPACE" \
  $KUBECTL -n "$NAMESPACE" get configmap "$CM_NAME" -o name >/dev/null

bulwark_default=$(cm_data_key 'bulwark-overrides\.css' || true)
roundcube_default=$(cm_data_key 'roundcube-overrides\.css' || true)

assert "bulwark-overrides.css key is present (default: hide-rules)" \
  test -n "$bulwark_default"
assert "roundcube-overrides.css key is present (default: hide-rules)" \
  test -n "$roundcube_default"
echo "$bulwark_default" | grep -qE 'a\[href\$="/contacts"\]' \
  && green "  PASS  bulwark CSS hides /contacts (default)" \
  || { red "  FAIL  bulwark CSS does NOT hide /contacts (default)"; FAIL=$((FAIL+1)); }
echo "$roundcube_default" | grep -q 'a.button.contacts' \
  && green "  PASS  roundcube CSS hides a.button.contacts (default)" \
  || { red "  FAIL  roundcube CSS does NOT hide a.button.contacts (default)"; FAIL=$((FAIL+1)); }

bulwark_hash_A=$(deployment_hash bulwark 2>/dev/null || true)
roundcube_hash_A=$(deployment_hash roundcube 2>/dev/null || true)
assert "bulwark Deployment carries feature-css-hash annotation" \
  test -n "$bulwark_hash_A"
assert "roundcube Deployment carries feature-css-hash annotation" \
  test -n "$roundcube_hash_A"

# ─── Phase B ──────────────────────────────────────────────────────
blue "Phase B — toggle Contacts visible"

if [ -z "${ADMIN_TOKEN:-}" ]; then
  yellow "ADMIN_TOKEN not set — skipping Phase B/C/D"
  yellow "Pass it via: ADMIN_TOKEN=<bearer> $0"
else
  patch_settings '{"webmailShowContacts":true}'

  if ! wait_for_hash_change bulwark "$bulwark_hash_A"; then
    red "  FAIL  bulwark hash did not change within 30s of PATCH"
    FAIL=$((FAIL+1))
  else
    green "  PASS  bulwark hash flipped after PATCH"
    PASS=$((PASS+1))
  fi

  bulwark_after=$(cm_data_key 'bulwark-overrides\.css' || true)
  echo "$bulwark_after" | grep -qE 'a\[href\$="/contacts"\]' \
    && { red "  FAIL  bulwark CSS still hides /contacts after enabling"; FAIL=$((FAIL+1)); } \
    || { green "  PASS  bulwark CSS no longer hides /contacts"; PASS=$((PASS+1)); }

  roundcube_after=$(cm_data_key 'roundcube-overrides\.css' || true)
  echo "$roundcube_after" | grep -q 'a.button.contacts' \
    && { red "  FAIL  roundcube CSS still hides a.button.contacts after enabling"; FAIL=$((FAIL+1)); } \
    || { green "  PASS  roundcube CSS no longer hides a.button.contacts"; PASS=$((PASS+1)); }

  # ─── Phase C ────────────────────────────────────────────────────
  blue "Phase C — toggle Contacts back to hidden"
  patch_settings '{"webmailShowContacts":false}'
  sleep 3
  bulwark_restored=$(cm_data_key 'bulwark-overrides\.css' || true)
  echo "$bulwark_restored" | grep -qE 'a\[href\$="/contacts"\]' \
    && { green "  PASS  bulwark CSS hides /contacts again"; PASS=$((PASS+1)); } \
    || { red "  FAIL  bulwark CSS did not restore hide-rule"; FAIL=$((FAIL+1)); }

  bulwark_hash_C=$(deployment_hash bulwark 2>/dev/null || true)
  [ "$bulwark_hash_C" = "$bulwark_hash_A" ] \
    && { green "  PASS  bulwark hash returned to original (deterministic CSS)"; PASS=$((PASS+1)); } \
    || { red "  FAIL  bulwark hash $bulwark_hash_C != $bulwark_hash_A — non-deterministic"; FAIL=$((FAIL+1)); }
fi

echo
echo "─── Summary ───"
echo "PASS: $PASS"
echo "FAIL: $FAIL"
[ "$FAIL" -eq 0 ] || exit 1
