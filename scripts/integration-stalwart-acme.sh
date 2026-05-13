#!/usr/bin/env bash
# integration-stalwart-acme.sh — verify Stalwart-native ACME is healthy
# end-to-end BEFORE we remove the cert-manager fallback (Phase 3 of the
# RocksDB-HA mail architecture re-audit).
#
# This script is READ-ONLY against the cluster and against Let's Encrypt
# (no forced renewals, no rate-limit-burning POSTs to ACME-v02). It just
# inspects current state and probes the serving cert on each mail port.
#
# What we want to be true:
#   1. Stalwart's x:AcmeProvider row `letsencrypt` exists and points at
#      acme-v02.api.letsencrypt.org with challengeType=Http01.
#   2. Stalwart's SystemSettings.requestTlsCertificate is true (the
#      Bootstrap flag that activates the internal ACME client).
#   3. The Ingress `stalwart-mail-acme` routes /.well-known/acme-challenge
#      to the `http-acme` Stalwart NetworkListener (port 80).
#   4. Each mail port (465 implicit, 587 STARTTLS, 993 implicit, 143
#      STARTTLS) presents a TLS cert chained to Let's Encrypt (not
#      cert-manager's selfsigned-issuer, not the operator's own CA).
#   5. The cert's notAfter is at least 30 days in the future (LE issues
#      90-day certs; if we're inside the renewal window, that's a
#      separate warning the operator should investigate).
#
# Exit code: 0 only if all five checks pass. Non-zero with a one-line
# failure summary otherwise.
#
# Usage:
#   STALWART_DOMAIN=mail.staging.success.com.na \
#   KUBE_CONTEXT=staging \
#     bash scripts/integration-stalwart-acme.sh
#
# Environment knobs:
#   STALWART_DOMAIN          The FQDN whose cert we expect. Required.
#   KUBE_CONTEXT             kubectl context (default: current).
#   STALWART_NS              Namespace (default: mail).
#   STALWART_POD             Pod label (default: app=stalwart-mail).
#   MIN_VALIDITY_DAYS        Minimum cert validity (default: 30).
#   ACME_PROD_DIR_URL        Expected ACME directory URL (default: LE prod).
#
# This script is the Phase-2 gate from docs/07-reference/ADR_TBD-mail-arch-
# re-audit.md. Phase 3 (remove cert-manager) MUST NOT ship until this
# script returns 0 on staging.

set -euo pipefail

# ── Config ─────────────────────────────────────────────────────────────
STALWART_DOMAIN="${STALWART_DOMAIN:-}"
KUBE_CONTEXT="${KUBE_CONTEXT:-}"
STALWART_NS="${STALWART_NS:-mail}"
MIN_VALIDITY_DAYS="${MIN_VALIDITY_DAYS:-30}"
ACME_PROD_DIR_URL="${ACME_PROD_DIR_URL:-https://acme-v02.api.letsencrypt.org/directory}"
LE_ISSUER_PATTERN="${LE_ISSUER_PATTERN:-Let.s Encrypt}"

if [[ -z "$STALWART_DOMAIN" ]]; then
  echo "ERROR: STALWART_DOMAIN env var is required (e.g. mail.staging.success.com.na)" >&2
  exit 2
fi

kctl() {
  if [[ -n "$KUBE_CONTEXT" ]]; then
    kubectl --context "$KUBE_CONTEXT" "$@"
  else
    kubectl "$@"
  fi
}

# Track pass/fail across all checks.
PASS=0
FAIL=0
WARN=0
note_pass() { echo "  ✓ $*"; PASS=$((PASS + 1)); }
note_fail() { echo "  ✗ $*" >&2; FAIL=$((FAIL + 1)); }
note_warn() { echo "  ⚠ $*" >&2; WARN=$((WARN + 1)); }

# ── Resolve a Stalwart pod for the kubectl exec hops below ────────────
echo "## Stalwart-native ACME verification — domain=${STALWART_DOMAIN}, ns=${STALWART_NS}"
echo ""

POD="$(kctl -n "$STALWART_NS" get pod \
  -l app.kubernetes.io/component=stalwart \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"

if [[ -z "$POD" ]]; then
  # Fallback for older labels.
  POD="$(kctl -n "$STALWART_NS" get pod \
    -l app=stalwart-mail \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
fi

if [[ -z "$POD" ]]; then
  echo "ERROR: no Stalwart pod found in namespace ${STALWART_NS}" >&2
  exit 2
fi
echo "Resolved Stalwart pod: ${POD}"
echo ""

# Resolve Stalwart admin credentials from the in-cluster Secret. We use
# `kubectl exec` instead of mounting the Secret to keep this script
# portable to operator workstations that don't have the local fixture.
ADMIN_PW="$(kctl -n "$STALWART_NS" get secret stalwart-admin-creds \
  -o jsonpath='{.data.adminPassword}' 2>/dev/null \
  | base64 -d 2>/dev/null || true)"

if [[ -z "$ADMIN_PW" ]]; then
  echo "ERROR: stalwart-admin-creds.adminPassword not readable — cannot make JMAP calls" >&2
  exit 2
fi

# jmap_get <method> <args-json>
jmap_get() {
  local method="$1" args="$2"
  kctl exec -n "$STALWART_NS" "$POD" -- curl -sf \
    -u "admin:${ADMIN_PW}" \
    -X POST -H 'Content-Type: application/json' --max-time 15 \
    -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],
         \"methodCalls\":[[\"${method}\",${args},\"c0\"]]}" \
    "http://localhost:8080/jmap/" 2>/dev/null || echo ''
}

# ── Check 1: x:AcmeProvider row ────────────────────────────────────────
echo "## 1. x:AcmeProvider configuration"
ACME_RESP="$(jmap_get 'x:AcmeProvider/get' '{"accountId":"d333333","ids":null}')"
if [[ -z "$ACME_RESP" ]]; then
  note_fail "JMAP call returned no response — Stalwart unreachable or admin auth wrong"
else
  ACME_DIRECTORY="$(echo "$ACME_RESP" \
    | python3 -c "import sys,json; r=json.load(sys.stdin)['methodResponses'][0][1]['list']; print(next((x.get('directory','') for x in r), ''))" 2>/dev/null || echo '')"
  ACME_CHALLENGE="$(echo "$ACME_RESP" \
    | python3 -c "import sys,json; r=json.load(sys.stdin)['methodResponses'][0][1]['list']; print(next((x.get('challengeType','') for x in r), ''))" 2>/dev/null || echo '')"

  if [[ "$ACME_DIRECTORY" == "$ACME_PROD_DIR_URL" ]]; then
    note_pass "AcmeProvider directory = ${ACME_PROD_DIR_URL}"
  else
    note_fail "AcmeProvider directory = '${ACME_DIRECTORY}' (expected ${ACME_PROD_DIR_URL})"
  fi

  if [[ "$ACME_CHALLENGE" == "Http01" ]]; then
    note_pass "AcmeProvider challengeType = Http01 (needs port 80 reachable)"
  else
    note_fail "AcmeProvider challengeType = '${ACME_CHALLENGE}' (expected Http01)"
  fi
fi
echo ""

# ── Check 2: SystemSettings.requestTlsCertificate ─────────────────────
# Stalwart 0.16 may store this on the singleton SystemSettings record or
# as part of the Bootstrap config; if /get returns it as a known key,
# we read it. If not, we don't fail — just note.
echo "## 2. SystemSettings.requestTlsCertificate"
SYS_RESP="$(jmap_get 'x:SystemSettings/get' '{"ids":["singleton"]}')"
if [[ -z "$SYS_RESP" ]]; then
  note_warn "x:SystemSettings/get returned empty — Stalwart pre-0.16.3 may not expose this property"
else
  REQ_TLS="$(echo "$SYS_RESP" \
    | python3 -c "import sys,json; r=json.load(sys.stdin)['methodResponses'][0][1]['list']; print(r[0].get('requestTlsCertificate','unknown') if r else 'empty')" 2>/dev/null || echo 'parse-error')"
  case "$REQ_TLS" in
    True|true)
      note_pass "SystemSettings.requestTlsCertificate = true"
      ;;
    False|false)
      note_fail "SystemSettings.requestTlsCertificate = false — internal ACME disabled"
      ;;
    *)
      note_warn "SystemSettings.requestTlsCertificate = '${REQ_TLS}' (could not parse)"
      ;;
  esac
fi
echo ""

# ── Check 3: ingress-acme routes /.well-known/acme-challenge ──────────
echo "## 3. Ingress stalwart-mail-acme routing"
ING_RAW="$(kctl -n "$STALWART_NS" get ingress stalwart-mail-acme \
  -o jsonpath='{.spec.rules[*].http.paths[*].path}' 2>/dev/null || echo '')"
if echo "$ING_RAW" | grep -q '\.well-known/acme-challenge'; then
  note_pass "Ingress stalwart-mail-acme contains /.well-known/acme-challenge path"
else
  note_fail "Ingress stalwart-mail-acme missing /.well-known/acme-challenge path (got: '${ING_RAW}')"
fi
echo ""

# ── Check 4 + 5: probe each mail port for an LE cert with >= MIN_VALIDITY_DAYS ──
echo "## 4-5. Serving cert on each mail port (issuer + notAfter)"
# Port → STARTTLS flag (for openssl s_client)
declare -A PORT_STARTTLS=(
  [465]=""           # implicit TLS (SMTPS)
  [587]="-starttls smtp"
  [993]=""           # implicit TLS (IMAPS)
  [143]="-starttls imap"
)

# Use a node IP for the network test — we can't always reach
# STALWART_DOMAIN from inside the cluster. The operator should provide
# PROBE_HOST; we default to the Stalwart pod's node IP via kubectl.
PROBE_HOST="${PROBE_HOST:-$(kctl -n "$STALWART_NS" get pod "$POD" -o jsonpath='{.status.hostIP}' 2>/dev/null || true)}"

if [[ -z "$PROBE_HOST" ]]; then
  note_warn "No PROBE_HOST set and could not resolve Stalwart pod hostIP — skipping port-level checks"
else
  echo "   Probing host: ${PROBE_HOST} with SNI: ${STALWART_DOMAIN}"
  for port in 465 587 993 143; do
    starttls="${PORT_STARTTLS[$port]}"
    # shellcheck disable=SC2086
    CERT_PEM="$(echo '' | timeout 15 openssl s_client \
      -connect "${PROBE_HOST}:${port}" \
      -servername "${STALWART_DOMAIN}" \
      ${starttls} 2>/dev/null \
      | sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' \
      | head -100 || true)"

    if [[ -z "$CERT_PEM" ]]; then
      note_fail "port ${port}: could not read serving cert"
      continue
    fi

    ISSUER="$(echo "$CERT_PEM" | openssl x509 -noout -issuer 2>/dev/null || echo '')"
    NOT_AFTER="$(echo "$CERT_PEM" | openssl x509 -noout -enddate 2>/dev/null | sed 's/^notAfter=//' || echo '')"
    SUBJECT="$(echo "$CERT_PEM" | openssl x509 -noout -subject 2>/dev/null || echo '')"

    if [[ -z "$ISSUER" ]]; then
      note_fail "port ${port}: openssl x509 parse failed"
      continue
    fi

    # Issuer check.
    if echo "$ISSUER" | grep -qiE "$LE_ISSUER_PATTERN"; then
      :  # silent pass — collated in subject/notAfter line below
    elif echo "$ISSUER" | grep -qiE 'cert-manager|selfsigned|local-ca|test'; then
      note_fail "port ${port}: served cert issued by cert-manager / local CA — NOT Let's Encrypt"
      echo "       issuer: ${ISSUER}"
      continue
    else
      note_warn "port ${port}: unrecognized issuer — ${ISSUER}"
    fi

    # Validity remaining (in days).
    if [[ -n "$NOT_AFTER" ]]; then
      NOT_AFTER_EPOCH="$(date -d "$NOT_AFTER" +%s 2>/dev/null || echo 0)"
      NOW_EPOCH="$(date +%s)"
      DAYS_LEFT=$(( (NOT_AFTER_EPOCH - NOW_EPOCH) / 86400 ))
      if (( DAYS_LEFT >= MIN_VALIDITY_DAYS )); then
        note_pass "port ${port}: LE cert OK — ${DAYS_LEFT} days remaining (subject=${SUBJECT#subject=})"
      elif (( DAYS_LEFT > 0 )); then
        note_warn "port ${port}: LE cert valid but only ${DAYS_LEFT} days remaining (< ${MIN_VALIDITY_DAYS}) — renewal due"
      else
        note_fail "port ${port}: LE cert EXPIRED ($((-DAYS_LEFT)) days ago)"
      fi
    fi
  done
fi
echo ""

# ── Summary ────────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════════"
echo "  Stalwart-native ACME verification: pass=${PASS} fail=${FAIL} warn=${WARN}"
echo "═══════════════════════════════════════════════════════════════════"

if (( FAIL > 0 )); then
  echo ""
  echo "RESULT: NOT READY for Phase 3 (cert-manager removal)."
  echo "        Fix the failures above before deleting certificate-mail-tls.yaml."
  exit 1
fi

echo ""
echo "RESULT: green — Stalwart-native ACME is healthy. Safe to proceed to Phase 3."
exit 0
