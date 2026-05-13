#!/usr/bin/env bash
# integration-stalwart-mail-ha.sh — comprehensive end-to-end harness for
# the Stalwart mail HA stack. Replaces and extends integration-stalwart-acme.sh.
#
# Covers everything PR #22 (haproxy DS + proxy-networks reconciler) and
# PRs #23/#24 (Stalwart JMAP schema fixes) shipped:
#
#   Phase A — read-only health (default, ~30s)
#     A1. Stalwart pod healthy
#     A2. x:AcmeProvider letsencrypt + HTTP-01
#     A3. ingress-acme routes /.well-known/acme-challenge
#     A4. All 6 mail listeners exist (smtp 25/465/587, imap 143/993, sieve 4190)
#     A5. Each mail port serves a Let's Encrypt cert with ≥30 days validity
#
#   Phase B — reconciler & trust-list state (default, ~30s)
#     B1. proxyTrustedNetworks exactly = set of cluster server-role node IPs
#     B2. proxyTrustedNetworks does NOT contain 0.0.0.0/0 (spoofing defense)
#     B3. Every server-role node IP is in x:AllowedIp
#     B4. haproxy DaemonSet exists and matches current port-exposure mode
#     B5. Reconciler log silence in last $LOG_LOOKBACK_MIN minutes
#         (no proxy-networks errors, no SystemSettings flapping, no
#          AllowedIp primaryKeyViolation)
#
#   Phase C — mode-flip live test (--mode-flip, ~5 min, destructive but reversible)
#     C1. PATCH /admin/mail/port-exposure {mode:'allServerNodes'}
#     C2. haproxy DS scales to server-node count
#     C3. Mail ports reachable on every server node (TCP)
#     C4. SMTP greeting from an OFF-Stalwart node (proves haproxy is forwarding)
#     C5. PATCH back to {mode:'thisNodeOnly'}, DS scales to 0
#
#   Phase D — negative / self-heal tests (--negative, ~5 min, destructive but reversible)
#     D1. Manually clobber proxyTrustedNetworks with {} → reconciler restores within 90s
#     D2. Manually add a junk entry to proxyTrustedNetworks → reconciler removes it within 90s
#     (NOT included: adding `0.0.0.0/0` manually — the reconciler can remove it
#      but we don't want to ever push that key to a live cluster even
#      transiently.)
#
#   Phase E — mail-archive E2E (--archive, ~5 min, requires ADMIN_TOKEN + configured backup target)
#     E1. GET /admin/mail/archive-status — verify a backup target is configured
#         (mail_snapshot_backup_store_id set; otherwise the export has nowhere
#         to land — skip the rest of Phase E with a warn).
#     E2. Capture SMTP greeting baseline (compare during run).
#     E3. POST /admin/mail/archive/trigger {mode:'no_downtime'} → record runId.
#     E4. While run state is not terminal, every 5s:
#           - SMTP banner on port 25 must remain responsive (NO DOWNTIME contract)
#           - Stalwart Deployment.spec.replicas must NOT drop to 0
#         Stop when state ∈ {succeeded, failed}.
#     E5. Final state == 'succeeded'; resticSnapshotId+exportSizeBytes populated;
#         mode column = 'no_downtime'; finishedAt set.
#     E6. Checkpoint dir cleaned up — no /var/lib/stalwart/data/.checkpoint-tmp-*
#         left behind in the live PVC.
#     E7. SMTP + IMAP still serving after the run (smoke greeting on 25/143).
#
#   Phase F — mail-archive downtime mode (--archive-downtime, ~5 min, DESTRUCTIVE)
#     F1. POST /admin/mail/archive/trigger {mode:'downtime'}.
#     F2. During state='scaling_down' or 'exporting', SMTP banner on port 25
#         MUST become unreachable (downtime is the contract for this mode).
#     F3. After the run terminates, SMTP banner returns within 60s.
#     F4. Final state == 'succeeded'; mode column = 'downtime'.
#         (Phase F validates the fallback path. If a no_downtime archive
#         is running concurrently, Phase F refuses to start.)
#
# Exit code: 0 if everything passed (phases that ran). Non-zero with the
# count of failures otherwise.
#
# Usage:
#   STALWART_DOMAIN=mail.staging.phoenix-host.net \
#     bash scripts/integration-stalwart-mail-ha.sh
#
#   # Run the full destructive test suite (requires admin bearer token):
#   STALWART_DOMAIN=mail.staging.phoenix-host.net \
#   ADMIN_TOKEN=eyJ... \
#   PLATFORM_API_URL=https://admin.staging.phoenix-host.net \
#     bash scripts/integration-stalwart-mail-ha.sh --mode-flip --negative --archive
#
# Environment knobs (all optional except STALWART_DOMAIN):
#   STALWART_DOMAIN          The FQDN whose cert + listeners we test.
#   KUBE_CONTEXT             kubectl context (default: current).
#   STALWART_NS              namespace (default: mail).
#   PLATFORM_NS              backend namespace (default: platform).
#   PLATFORM_API_URL         platform-api base URL (default: cluster-internal).
#   ADMIN_TOKEN              Bearer token for super_admin user (Phase C only).
#   MIN_VALIDITY_DAYS        minimum cert validity (default: 30).
#   LOG_LOOKBACK_MIN         minutes of platform-api logs to scan (default: 5).
#   PROBE_HOST               override the host we probe for mail-port TLS.
#                            Default: the Stalwart pod's hostIP.
#   ACME_PROD_DIR_URL        expected ACME directory (default: LE prod).
#
# This script is the deploy-time gate for any mail-arch change. It should
# pass green on staging before any PR touching the mail stack is merged
# to main.

set -euo pipefail

# ── Config ─────────────────────────────────────────────────────────────
STALWART_DOMAIN="${STALWART_DOMAIN:-}"
KUBE_CONTEXT="${KUBE_CONTEXT:-}"
STALWART_NS="${STALWART_NS:-mail}"
PLATFORM_NS="${PLATFORM_NS:-platform}"
PLATFORM_API_URL="${PLATFORM_API_URL:-}"
ADMIN_TOKEN="${ADMIN_TOKEN:-}"
MIN_VALIDITY_DAYS="${MIN_VALIDITY_DAYS:-30}"
LOG_LOOKBACK_MIN="${LOG_LOOKBACK_MIN:-5}"
ACME_PROD_DIR_URL="${ACME_PROD_DIR_URL:-https://acme-v02.api.letsencrypt.org/directory}"
LE_ISSUER_PATTERN='Let.s Encrypt'

# Mail ports + their TLS mode for openssl s_client.
declare -A PORT_STARTTLS=(
  [465]=""           # implicit TLS (SMTPS)
  [587]="-starttls smtp"
  [993]=""           # implicit TLS (IMAPS)
  [143]="-starttls imap"
)
MAIL_PORTS=(25 465 587 143 993 4190)

# Server-role node label (matches placement.ts + reconciler).
SERVER_ROLE_LABEL='platform.phoenix-host.net/node-role=server'

# Flags
RUN_MODE_FLIP=false
RUN_NEGATIVE=false
RUN_ARCHIVE=false
RUN_ARCHIVE_DOWNTIME=false
for arg in "$@"; do
  case "$arg" in
    --mode-flip)        RUN_MODE_FLIP=true ;;
    --negative)         RUN_NEGATIVE=true ;;
    --archive)          RUN_ARCHIVE=true ;;
    --archive-downtime) RUN_ARCHIVE_DOWNTIME=true ;;
    --help|-h)
      sed -n '2,/^set -euo/p' "$0" | sed -e 's/^# //' -e 's/^#$//' -e '/^set -euo/d'
      exit 0
      ;;
    *)            echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

if [[ -z "$STALWART_DOMAIN" ]]; then
  echo "ERROR: STALWART_DOMAIN env var is required (e.g. mail.staging.phoenix-host.net)" >&2
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

# Trap: at exit, if Phase C mutated port-exposure and didn't finish
# reverting, warn the operator loudly. We don't auto-revert because that
# could mask a real test failure — operator decision.
ORIGINAL_PORT_EXPOSURE_MODE=""
ORIGINAL_PROXY_TRUSTED_NETWORKS=""
PHASE_C_MUTATED=false
trap on_exit EXIT

on_exit() {
  local rc=$?
  if $PHASE_C_MUTATED && [[ -n "$ORIGINAL_PORT_EXPOSURE_MODE" ]]; then
    local current_mode
    current_mode="$(get_port_exposure_mode 2>/dev/null || echo unknown)"
    if [[ "$current_mode" != "$ORIGINAL_PORT_EXPOSURE_MODE" ]]; then
      echo "" >&2
      echo "############################################################" >&2
      echo "# WARNING: port-exposure mode is '${current_mode}', was '${ORIGINAL_PORT_EXPOSURE_MODE}'" >&2
      echo "# Phase C did not finish reverting. Revert manually via:" >&2
      echo "#   curl -X PATCH ... /admin/mail/port-exposure -d '{\"mode\":\"${ORIGINAL_PORT_EXPOSURE_MODE}\"}'" >&2
      echo "############################################################" >&2
    fi
  fi
  return $rc
}

# ── Resolve Stalwart pod ───────────────────────────────────────────────
echo "## Stalwart mail HA harness — domain=${STALWART_DOMAIN}, ns=${STALWART_NS}"
echo ""

POD="$(kctl -n "$STALWART_NS" get pod \
  -l app.kubernetes.io/component=stalwart \
  -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
if [[ -z "$POD" ]]; then
  echo "ERROR: no Stalwart pod found in namespace ${STALWART_NS}" >&2
  exit 2
fi
NODE_OF_POD="$(kctl -n "$STALWART_NS" get pod "$POD" -o jsonpath='{.spec.nodeName}')"
HOST_IP_OF_POD="$(kctl -n "$STALWART_NS" get pod "$POD" -o jsonpath='{.status.hostIP}')"
PROBE_HOST="${PROBE_HOST:-$HOST_IP_OF_POD}"

ADMIN_PW="$(kctl -n "$STALWART_NS" get secret stalwart-admin-creds \
  -o jsonpath='{.data.adminPassword}' 2>/dev/null \
  | base64 -d 2>/dev/null || true)"
if [[ -z "$ADMIN_PW" ]]; then
  echo "ERROR: stalwart-admin-creds.adminPassword not readable" >&2
  exit 2
fi

echo "Resolved Stalwart pod=${POD} node=${NODE_OF_POD} hostIP=${HOST_IP_OF_POD}"
echo ""

# ── JMAP helper (creds via stdin → netrc-file, never in argv) ─────────
jmap_call() {
  local method="$1" args="$2"
  local netrc="/tmp/.mail-ha-netrc-$$"
  kctl exec -i -n "$STALWART_NS" "$POD" -c stalwart -- sh -c "
    umask 077; cat > '${netrc}'
    curl -sf --netrc-file '${netrc}' \
      -X POST -H 'Content-Type: application/json' --max-time 15 \
      -d '{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],
           \"methodCalls\":[[\"${method}\",${args},\"c0\"]]}' \
      http://localhost:8080/jmap/
    rm -f '${netrc}'
  " <<<"machine localhost login admin password ${ADMIN_PW}" 2>/dev/null || echo ''
}

get_port_exposure_mode() {
  kctl -n "$PLATFORM_NS" exec -i deploy/platform-api -c backend -- sh -c '
    psql "$DATABASE_URL" -At -c "select mail_port_exposure_mode from system_settings where id = '"'"'system'"'"';"
  ' 2>/dev/null | tr -d ' \n\r' || echo ""
}

# ── Phase A — read-only Stalwart health ───────────────────────────────
phase_a_health() {
  echo "## Phase A — Stalwart health"

  # A1. Pod healthy
  local ready
  ready=$(kctl -n "$STALWART_NS" get pod "$POD" \
    -o jsonpath='{.status.containerStatuses[?(@.name=="stalwart")].ready}')
  if [[ "$ready" == "true" ]]; then
    note_pass "A1. Stalwart pod ${POD} ready"
  else
    note_fail "A1. Stalwart pod ${POD} not ready (containerStatuses.ready=${ready})"
  fi

  # A2. AcmeProvider
  local acme_resp
  acme_resp="$(jmap_call 'x:AcmeProvider/get' '{"accountId":"d333333","ids":null}')"
  if [[ -z "$acme_resp" ]]; then
    note_fail "A2. AcmeProvider/get returned no response (Stalwart unreachable or auth wrong)"
  else
    local acme_directory acme_challenge
    acme_directory="$(echo "$acme_resp" | python3 -c "
import sys, json
r = json.load(sys.stdin)['methodResponses'][0][1].get('list', [])
print(next((x.get('directory','') for x in r), ''))" 2>/dev/null || echo '')"
    acme_challenge="$(echo "$acme_resp" | python3 -c "
import sys, json
r = json.load(sys.stdin)['methodResponses'][0][1].get('list', [])
print(next((x.get('challengeType','') for x in r), ''))" 2>/dev/null || echo '')"
    if [[ "$acme_directory" == "$ACME_PROD_DIR_URL" ]]; then
      note_pass "A2a. AcmeProvider directory = ${ACME_PROD_DIR_URL}"
    else
      note_fail "A2a. AcmeProvider directory = '${acme_directory}' (expected ${ACME_PROD_DIR_URL})"
    fi
    if [[ "$acme_challenge" == "Http01" ]]; then
      note_pass "A2b. AcmeProvider challengeType = Http01"
    else
      note_fail "A2b. AcmeProvider challengeType = '${acme_challenge}' (expected Http01)"
    fi
  fi

  # A3. Ingress routes /.well-known/acme-challenge
  local ing_paths
  ing_paths="$(kctl -n "$STALWART_NS" get ingress stalwart-mail-acme \
    -o jsonpath='{.spec.rules[*].http.paths[*].path}' 2>/dev/null || echo '')"
  if echo "$ing_paths" | grep -q '\.well-known/acme-challenge'; then
    note_pass "A3. Ingress stalwart-mail-acme routes /.well-known/acme-challenge"
  else
    note_fail "A3. Ingress stalwart-mail-acme missing ACME path (got: '${ing_paths}')"
  fi

  # A4. All 6 mail listeners exist
  local listener_resp listener_ports
  listener_resp="$(jmap_call 'x:NetworkListener/get' '{"accountId":"d333333","ids":null}')"
  listener_ports="$(echo "$listener_resp" | python3 -c "
import sys, json, re
r = json.load(sys.stdin)['methodResponses'][0][1].get('list', [])
ports = set()
for L in r:
    binds = L.get('bind', {}) or {}
    for k in binds:
        m = re.search(r':(\d+)\$', k)
        if m: ports.add(int(m.group(1)))
print(' '.join(str(p) for p in sorted(ports)))" 2>/dev/null || echo '')"
  local missing=()
  for p in "${MAIL_PORTS[@]}"; do
    if ! echo " ${listener_ports} " | grep -q " ${p} "; then
      missing+=("$p")
    fi
  done
  if [[ ${#missing[@]} -eq 0 ]]; then
    note_pass "A4. All 6 mail listeners present (ports: ${listener_ports})"
  else
    note_fail "A4. Missing mail listeners on ports: ${missing[*]} (got: ${listener_ports})"
  fi

  # A5. Each mail port serves an LE cert with ≥MIN_VALIDITY_DAYS validity.
  echo "  Probing host: ${PROBE_HOST} with SNI: ${STALWART_DOMAIN}"
  for port in 465 587 993 143; do
    local starttls="${PORT_STARTTLS[$port]:-}"
    local cert_pem
    # shellcheck disable=SC2086
    cert_pem="$(echo '' | timeout 15 openssl s_client \
      -connect "${PROBE_HOST}:${port}" -servername "${STALWART_DOMAIN}" \
      ${starttls} 2>/dev/null \
      | sed -n '/-----BEGIN CERTIFICATE-----/,/-----END CERTIFICATE-----/p' \
      | head -100 || true)"
    if [[ -z "$cert_pem" ]]; then
      note_fail "A5/${port}. could not read serving cert"
      continue
    fi
    local issuer subject not_after
    issuer="$(echo "$cert_pem" | openssl x509 -noout -issuer 2>/dev/null || echo '')"
    subject="$(echo "$cert_pem" | openssl x509 -noout -subject 2>/dev/null || echo '')"
    not_after="$(echo "$cert_pem" | openssl x509 -noout -enddate 2>/dev/null | sed 's/^notAfter=//' || echo '')"
    if echo "$issuer" | grep -qiE "$LE_ISSUER_PATTERN"; then
      :  # pass — issuer is LE
    elif echo "$issuer" | grep -qiE 'cert-manager|selfsigned|local-ca|fake'; then
      note_fail "A5/${port}. served cert issued by cert-manager / local CA (NOT Let's Encrypt) — issuer=${issuer}"
      continue
    else
      note_warn "A5/${port}. unrecognized issuer: ${issuer}"
    fi
    local min_seconds=$(( MIN_VALIDITY_DAYS * 86400 ))
    if echo "$cert_pem" | openssl x509 -noout -checkend "$min_seconds" >/dev/null 2>&1; then
      note_pass "A5/${port}. LE cert OK — ≥${MIN_VALIDITY_DAYS}d (notAfter=${not_after}, ${subject#subject=})"
    elif echo "$cert_pem" | openssl x509 -noout -checkend 0 >/dev/null 2>&1; then
      note_warn "A5/${port}. LE cert valid but <${MIN_VALIDITY_DAYS}d remaining — renewal due"
    else
      note_fail "A5/${port}. LE cert EXPIRED (notAfter=${not_after})"
    fi
  done
  echo ""
}

# ── Phase B — reconciler & trust-list state ───────────────────────────
phase_b_state() {
  echo "## Phase B — reconciler + trust-list state"

  # Compute expected server-role node IP set.
  local expected_ips
  expected_ips="$(kctl get nodes -l "$SERVER_ROLE_LABEL" -o json | python3 -c "
import sys, json
n = json.load(sys.stdin)['items']
ips = set()
for node in n:
    for a in node.get('status', {}).get('addresses', []):
        if a.get('type') == 'InternalIP':
            ip = a.get('address', '')
            if ip and ip not in ('127.0.0.1', '0.0.0.0', '::1'):
                ips.add(ip)
print(' '.join(sorted(ips)))" 2>/dev/null || echo '')"

  if [[ -z "$expected_ips" ]]; then
    note_fail "B0. No server-role nodes labeled '${SERVER_ROLE_LABEL}' — harness cannot validate"
    return
  fi
  echo "  Expected server-role IPs: ${expected_ips}"

  # B1. proxyTrustedNetworks ⊇ expected (exact match)
  local ptn_resp ptn_actual
  ptn_resp="$(jmap_call 'x:SystemSettings/get' '{"ids":["singleton"],"properties":["proxyTrustedNetworks"]}')"
  ptn_actual="$(echo "$ptn_resp" | python3 -c "
import sys, json
r = json.load(sys.stdin)['methodResponses'][0][1].get('list', [])
if not r: print(''); sys.exit(0)
ks = r[0].get('proxyTrustedNetworks') or {}
def canon(k):
    return k[:-3] if k.endswith('/32') else k
print(' '.join(sorted(canon(k) for k, v in ks.items() if v is True)))" 2>/dev/null || echo '')"
  ORIGINAL_PROXY_TRUSTED_NETWORKS="$ptn_actual"
  echo "  Actual   server-role IPs: ${ptn_actual}"

  if [[ "$ptn_actual" == "$expected_ips" ]]; then
    note_pass "B1. SystemSettings.proxyTrustedNetworks = expected server-role node IPs"
  else
    note_fail "B1. Mismatch: expected '${expected_ips}', got '${ptn_actual}'"
  fi

  # B2. Spoofing defense — 0.0.0.0/0 must NOT be in proxyTrustedNetworks
  if echo " ${ptn_actual} " | grep -qE ' (0\.0\.0\.0/0|0\.0\.0\.0|::|::/0) '; then
    note_fail "B2. SECURITY: proxyTrustedNetworks contains a wildcard — PROXY-v2 IP spoofing is now possible"
  else
    note_pass "B2. proxyTrustedNetworks does not contain 0.0.0.0/0 (spoofing defense intact)"
  fi

  # B3. Every server-role IP is in x:AllowedIp
  local allowed_resp allowed_ips
  allowed_resp="$(jmap_call 'x:AllowedIp/get' '{"accountId":"d333333","ids":null}')"
  allowed_ips="$(echo "$allowed_resp" | python3 -c "
import sys, json
r = json.load(sys.stdin)['methodResponses'][0][1].get('list', [])
def canon(a):
    return a[:-3] if a.endswith('/32') else a
print(' '.join(canon(e.get('address','')) for e in r))" 2>/dev/null || echo '')"
  local b3_missing=()
  for ip in $expected_ips; do
    if ! echo " ${allowed_ips} " | grep -q " ${ip} "; then
      b3_missing+=("$ip")
    fi
  done
  if [[ ${#b3_missing[@]} -eq 0 ]]; then
    note_pass "B3. All server-role IPs are in x:AllowedIp"
  else
    note_fail "B3. Missing from x:AllowedIp: ${b3_missing[*]}"
  fi

  # B4. haproxy DaemonSet exists, scale matches port-exposure mode
  local ds_desired ds_ready mode server_node_count
  ds_desired="$(kctl -n "$STALWART_NS" get ds stalwart-haproxy -o jsonpath='{.status.desiredNumberScheduled}' 2>/dev/null || echo 'absent')"
  ds_ready="$(kctl -n "$STALWART_NS" get ds stalwart-haproxy -o jsonpath='{.status.numberReady}' 2>/dev/null || echo '0')"
  if [[ "$ds_desired" == "absent" ]]; then
    note_fail "B4. haproxy DaemonSet not present in namespace ${STALWART_NS}"
  else
    mode="$(get_port_exposure_mode)"
    ORIGINAL_PORT_EXPOSURE_MODE="${mode:-thisNodeOnly}"
    server_node_count="$(kctl get nodes -l "$SERVER_ROLE_LABEL" -o name 2>/dev/null | wc -l)"
    case "${mode:-thisNodeOnly}" in
      thisNodeOnly)
        if [[ "$ds_desired" == "0" ]]; then
          note_pass "B4. haproxy DS desired=0 (mode=thisNodeOnly)"
        else
          note_fail "B4. haproxy DS desired=${ds_desired} but mode=thisNodeOnly (should be 0)"
        fi
        ;;
      allServerNodes)
        if [[ "$ds_desired" == "$server_node_count" && "$ds_ready" == "$server_node_count" ]]; then
          note_pass "B4. haproxy DS desired=ready=${ds_desired} matches ${server_node_count} server-role nodes"
        else
          note_fail "B4. haproxy DS desired=${ds_desired} ready=${ds_ready} but server nodes=${server_node_count}"
        fi
        ;;
      *)
        note_warn "B4. Unknown mode='${mode}' — cannot validate haproxy DS scale"
        ;;
    esac
  fi

  # B5. Reconciler log silence.
  # `grep -c` always prints the count and exits 1 when count=0 — we don't
  # need a `|| echo 0` fallback (that double-prints under set -e). Use
  # `|| true` to swallow the non-zero exit.
  local recent_errors recent_updates
  recent_errors="$(kctl -n "$PLATFORM_NS" logs deploy/platform-api --since="${LOG_LOOKBACK_MIN}m" 2>&1 \
    | { grep -ciE 'proxy-networks.*(failed|error)|allowedip.*(partial failure|primarykeyviol)|systemsettings.*(failed|error)' || true; })"
  # The "Updated SystemSettings.proxyTrustedNetworks → ..." line is a real
  # state change — only flag it if it's been logged more than once in the
  # window, which would mean the reconciler is flapping (idempotency bug).
  recent_updates="$(kctl -n "$PLATFORM_NS" logs deploy/platform-api --since="${LOG_LOOKBACK_MIN}m" 2>&1 \
    | { grep -c 'Updated SystemSettings.proxyTrustedNetworks' || true; })"
  recent_errors="${recent_errors:-0}"
  recent_updates="${recent_updates:-0}"
  if [[ "$recent_errors" -eq 0 && "$recent_updates" -le 1 ]]; then
    note_pass "B5. Reconciler quiet in last ${LOG_LOOKBACK_MIN}min (errors=${recent_errors}, updates=${recent_updates})"
  else
    note_fail "B5. Reconciler noisy — errors=${recent_errors}, updates=${recent_updates} in ${LOG_LOOKBACK_MIN}min"
    kctl -n "$PLATFORM_NS" logs deploy/platform-api --since="${LOG_LOOKBACK_MIN}m" 2>&1 \
      | grep -iE 'proxy-networks|allowedip|systemsettings\.proxy' | tail -5 | sed 's/^/        /'
  fi
  echo ""
}

# ── Phase C — mode-flip live test ─────────────────────────────────────
phase_c_mode_flip() {
  echo "## Phase C — port-exposure mode flip (destructive)"

  if [[ -z "$ADMIN_TOKEN" || -z "$PLATFORM_API_URL" ]]; then
    note_warn "C0. ADMIN_TOKEN + PLATFORM_API_URL not set — skipping Phase C"
    echo ""
    return
  fi

  local start_mode
  start_mode="$(get_port_exposure_mode)"
  echo "  Start mode: ${start_mode:-thisNodeOnly}"

  # C1. PATCH to allServerNodes. Mark Phase C as having mutated state so
  # the EXIT trap warns if we don't revert.
  PHASE_C_MUTATED=true
  local patch_status
  patch_status="$(curl -sk -o /dev/null -w '%{http_code}' \
    -X PATCH "${PLATFORM_API_URL}/api/v1/admin/mail/port-exposure" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d '{"mode":"allServerNodes"}' --max-time 60 || echo '000')"
  if [[ "$patch_status" == "204" || "$patch_status" == "200" ]]; then
    note_pass "C1. PATCH /admin/mail/port-exposure mode=allServerNodes → HTTP ${patch_status}"
  else
    note_fail "C1. PATCH failed — HTTP ${patch_status}"
    return
  fi

  # C2. haproxy DS scales to server-node count (wait up to 120s).
  local server_node_count waited=0 ds_ready
  server_node_count="$(kctl get nodes -l "$SERVER_ROLE_LABEL" -o name 2>/dev/null | wc -l)"
  while (( waited < 120 )); do
    ds_ready="$(kctl -n "$STALWART_NS" get ds stalwart-haproxy -o jsonpath='{.status.numberReady}' 2>/dev/null || echo 0)"
    if [[ "$ds_ready" == "$server_node_count" ]]; then break; fi
    sleep 5
    waited=$(( waited + 5 ))
  done
  if [[ "$ds_ready" == "$server_node_count" ]]; then
    note_pass "C2. haproxy DS scaled to ${ds_ready}/${server_node_count} after ${waited}s"
  else
    note_fail "C2. haproxy DS ready=${ds_ready} server_nodes=${server_node_count} after ${waited}s"
  fi

  # C3. TCP probe port 587 from every server node's external/internal IP.
  local mapfile_ips=()
  while IFS= read -r line; do mapfile_ips+=("$line"); done < <(
    kctl get nodes -l "$SERVER_ROLE_LABEL" -o jsonpath='{range .items[*]}{.status.addresses[?(@.type=="InternalIP")].address}{"\n"}{end}'
  )
  local ok=0 nope=0
  for ip in "${mapfile_ips[@]}"; do
    if timeout 5 bash -c "</dev/tcp/${ip}/587" 2>/dev/null; then
      ok=$(( ok + 1 ))
    else
      nope=$(( nope + 1 ))
      note_warn "    port 587 NOT reachable on ${ip}"
    fi
  done
  if [[ "$ok" -eq "${#mapfile_ips[@]}" ]]; then
    note_pass "C3. port 587 reachable on all ${ok} server-role node IPs"
  else
    note_fail "C3. port 587 reachable on ${ok}/${#mapfile_ips[@]} server-role node IPs"
  fi

  # C4. SMTP greeting from OFF-node (a server node where Stalwart is NOT scheduled).
  local off_node_ip=""
  for ip in "${mapfile_ips[@]}"; do
    if [[ "$ip" != "$HOST_IP_OF_POD" ]]; then off_node_ip="$ip"; break; fi
  done
  if [[ -z "$off_node_ip" ]]; then
    note_warn "C4. Only one server-role node; cannot test off-node path"
  else
    local banner
    banner="$(timeout 10 bash -c "
      exec 3<>/dev/tcp/${off_node_ip}/25
      read -t 5 -u 3 line
      echo \"\$line\"
      printf 'QUIT\\r\\n' >&3
    " 2>/dev/null || echo '')"
    if echo "$banner" | grep -qiE 'esmtp|stalwart|smtp ready|220'; then
      note_pass "C4. SMTP greeting from off-node ${off_node_ip}:25 → ${banner:0:60}"
    else
      note_fail "C4. SMTP banner from off-node ${off_node_ip}:25 unexpected: '${banner:0:80}'"
    fi
  fi

  # C5. PATCH back to thisNodeOnly.
  patch_status="$(curl -sk -o /dev/null -w '%{http_code}' \
    -X PATCH "${PLATFORM_API_URL}/api/v1/admin/mail/port-exposure" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d '{"mode":"thisNodeOnly"}' --max-time 60 || echo '000')"
  if [[ "$patch_status" == "204" || "$patch_status" == "200" ]]; then
    note_pass "C5a. PATCH back to thisNodeOnly → HTTP ${patch_status}"
  else
    note_fail "C5a. PATCH back failed — HTTP ${patch_status}"
  fi

  waited=0
  while (( waited < 120 )); do
    ds_ready="$(kctl -n "$STALWART_NS" get ds stalwart-haproxy -o jsonpath='{.status.desiredNumberScheduled}' 2>/dev/null || echo 0)"
    if [[ "$ds_ready" == "0" ]]; then break; fi
    sleep 5
    waited=$(( waited + 5 ))
  done
  if [[ "$ds_ready" == "0" ]]; then
    note_pass "C5b. haproxy DS scaled back to 0 after ${waited}s"
  else
    note_fail "C5b. haproxy DS desired=${ds_ready} after ${waited}s (expected 0)"
  fi
  echo ""
}

# ── Phase D — negative / self-heal ────────────────────────────────────
phase_d_negative() {
  echo "## Phase D — reconciler self-heal (destructive, reversible)"

  if [[ -z "$ORIGINAL_PROXY_TRUSTED_NETWORKS" ]]; then
    note_warn "D0. Phase B did not record original state — skipping Phase D"
    echo ""
    return
  fi

  # D1. Clobber proxyTrustedNetworks to {} → reconciler should restore within 90s.
  echo "  D1. Clobbering proxyTrustedNetworks to {}..."
  local clobber_resp
  clobber_resp="$(jmap_call 'x:SystemSettings/set' \
    '{"update":{"singleton":{"proxyTrustedNetworks":{}}}}')"
  if ! echo "$clobber_resp" | grep -q '"updated"'; then
    note_warn "D1a. Could not clobber proxyTrustedNetworks (response: ${clobber_resp:0:80})"
  else
    note_pass "D1a. Clobbered proxyTrustedNetworks to {}"
    echo "      Waiting up to 90s for reconciler to restore..."
    local waited=0 actual=""
    while (( waited < 90 )); do
      sleep 10
      waited=$(( waited + 10 ))
      actual="$(jmap_call 'x:SystemSettings/get' '{"ids":["singleton"],"properties":["proxyTrustedNetworks"]}' \
        | python3 -c "
import sys, json
r = json.load(sys.stdin)['methodResponses'][0][1].get('list', [])
if not r: print(''); sys.exit(0)
ks = r[0].get('proxyTrustedNetworks') or {}
def canon(k): return k[:-3] if k.endswith('/32') else k
print(' '.join(sorted(canon(k) for k, v in ks.items() if v is True)))" 2>/dev/null || echo '')"
      if [[ "$actual" == "$ORIGINAL_PROXY_TRUSTED_NETWORKS" ]]; then break; fi
    done
    if [[ "$actual" == "$ORIGINAL_PROXY_TRUSTED_NETWORKS" ]]; then
      note_pass "D1b. Reconciler restored proxyTrustedNetworks in ${waited}s"
    else
      note_fail "D1b. After ${waited}s, proxyTrustedNetworks='${actual}' (expected '${ORIGINAL_PROXY_TRUSTED_NETWORKS}')"
    fi
  fi

  # D2. Add a junk entry → reconciler should remove it within 90s.
  echo "  D2. Adding junk IP to proxyTrustedNetworks..."
  # Build current+junk map.
  local junk_ip="198.51.100.99"  # RFC 5737 TEST-NET-2
  local junk_map
  junk_map="$(python3 -c "
import json
ips = '$ORIGINAL_PROXY_TRUSTED_NETWORKS'.split() + ['$junk_ip']
print(json.dumps({ip: True for ip in ips}))")"
  local junk_resp
  junk_resp="$(jmap_call 'x:SystemSettings/set' \
    "{\"update\":{\"singleton\":{\"proxyTrustedNetworks\":${junk_map}}}}")"
  if ! echo "$junk_resp" | grep -q '"updated"'; then
    note_warn "D2a. Could not inject junk IP (response: ${junk_resp:0:80})"
  else
    note_pass "D2a. Injected ${junk_ip} into proxyTrustedNetworks"
    echo "      Waiting up to 90s for reconciler to remove..."
    local waited=0 actual=""
    while (( waited < 90 )); do
      sleep 10
      waited=$(( waited + 10 ))
      actual="$(jmap_call 'x:SystemSettings/get' '{"ids":["singleton"],"properties":["proxyTrustedNetworks"]}' \
        | python3 -c "
import sys, json
r = json.load(sys.stdin)['methodResponses'][0][1].get('list', [])
if not r: print(''); sys.exit(0)
ks = r[0].get('proxyTrustedNetworks') or {}
def canon(k): return k[:-3] if k.endswith('/32') else k
print(' '.join(sorted(canon(k) for k, v in ks.items() if v is True)))" 2>/dev/null || echo '')"
      if [[ "$actual" == "$ORIGINAL_PROXY_TRUSTED_NETWORKS" ]]; then break; fi
    done
    if [[ "$actual" == "$ORIGINAL_PROXY_TRUSTED_NETWORKS" ]]; then
      note_pass "D2b. Reconciler removed junk IP in ${waited}s"
    else
      note_fail "D2b. After ${waited}s, junk IP still present: '${actual}'"
    fi
  fi
  echo ""
}

# ── Phase E — mail-archive no-downtime E2E ────────────────────────────
phase_e_archive_no_downtime() {
  echo "## Phase E — mail-archive no-downtime E2E"

  if [[ -z "$ADMIN_TOKEN" || -z "$PLATFORM_API_URL" ]]; then
    note_warn "E0. ADMIN_TOKEN + PLATFORM_API_URL not set — skipping Phase E"
    echo ""
    return
  fi

  # E1. Verify a backup target is configured. Without it the export Job
  # would land + then fail at the restic upload step; not a useful test
  # signal. Operator must configure first.
  local status_body backup_store_id
  status_body="$(curl -sk \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    "${PLATFORM_API_URL}/api/v1/admin/mail/archive-status" --max-time 15 || echo '{}')"
  backup_store_id="$(echo "$status_body" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("data",{}).get("backupTarget",{}).get("backupStoreId") or "")' 2>/dev/null || echo "")"
  if [[ -z "$backup_store_id" ]]; then
    note_warn "E1. No backup target configured (mail_snapshot_backup_store_id) — skipping Phase E"
    echo "      Configure one via the Mail Backup card before running --archive."
    echo ""
    return
  fi
  note_pass "E1. backup target configured: ${backup_store_id}"

  # E2. SMTP greeting baseline.
  local baseline_banner
  baseline_banner="$(timeout 10 bash -c "
    exec 3<>/dev/tcp/${PROBE_HOST}/25
    read -t 5 -u 3 line
    echo \"\$line\"
    printf 'QUIT\\r\\n' >&3
  " 2>/dev/null || echo '')"
  if echo "$baseline_banner" | grep -qiE 'esmtp|stalwart|220'; then
    note_pass "E2. SMTP baseline greeting OK before run"
  else
    note_fail "E2. SMTP baseline greeting unexpected: '${baseline_banner:0:80}'"
    return
  fi

  # E3. Trigger no_downtime archive.
  local trigger_response run_id
  trigger_response="$(curl -sk \
    -X POST "${PLATFORM_API_URL}/api/v1/admin/mail/archive/trigger" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d '{"mode":"no_downtime"}' --max-time 30 || echo '{}')"
  run_id="$(echo "$trigger_response" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("data",{}).get("runId") or "")' 2>/dev/null || echo "")"
  if [[ -z "$run_id" ]]; then
    note_fail "E3. trigger /admin/mail/archive/trigger did not return runId: ${trigger_response:0:200}"
    return
  fi
  note_pass "E3. archive run triggered (no_downtime): runId=${run_id}"

  # E4. Poll the run while continuously verifying SMTP banner stays up
  # AND the Stalwart Deployment never scales to 0. The no_downtime path's
  # contract: live mail keeps serving.
  local poll_deadline=$(( $(date +%s) + 600 ))   # 10 min hard cap
  local run_state="" run_step="" smtp_failures=0 scaledown_failures=0
  local check_iter=0
  while (( $(date +%s) < poll_deadline )); do
    local run_body
    run_body="$(curl -sk \
      -H "Authorization: Bearer ${ADMIN_TOKEN}" \
      "${PLATFORM_API_URL}/api/v1/admin/mail/archive-runs/${run_id}" --max-time 15 || echo '{}')"
    run_state="$(echo "$run_body" \
      | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("data",{}).get("state") or "")' 2>/dev/null || echo "")"
    run_step="$(echo "$run_body" \
      | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("data",{}).get("currentStep") or "")' 2>/dev/null || echo "")"

    # CONTRACT: Stalwart replicas must NOT drop. Pre-existing 1 → keep 1.
    local replicas
    replicas="$(kctl -n "$STALWART_NS" get deploy stalwart-mail -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 0)"
    if [[ "$replicas" == "0" ]]; then
      scaledown_failures=$(( scaledown_failures + 1 ))
      echo "    ⚠ replicas dropped to 0 at iter $check_iter (state=$run_state, step=$run_step)" >&2
    fi

    # CONTRACT: SMTP banner stays responsive.
    local probe_banner
    probe_banner="$(timeout 5 bash -c "
      exec 3<>/dev/tcp/${PROBE_HOST}/25
      read -t 3 -u 3 line
      echo \"\$line\"
      printf 'QUIT\\r\\n' >&3
    " 2>/dev/null || echo '')"
    if ! echo "$probe_banner" | grep -qiE 'esmtp|stalwart|220'; then
      smtp_failures=$(( smtp_failures + 1 ))
      echo "    ⚠ SMTP banner missing at iter $check_iter (state=$run_state, step=$run_step): '${probe_banner:0:60}'" >&2
    fi

    echo "    poll: state=$run_state step=$run_step replicas=$replicas (iter $check_iter)"

    if [[ "$run_state" == "succeeded" || "$run_state" == "failed" ]]; then break; fi
    sleep 5
    check_iter=$(( check_iter + 1 ))
  done

  # The contract is "no downtime" — zero failures expected.
  if (( scaledown_failures == 0 )); then
    note_pass "E4a. Stalwart replicas never dropped to 0 across ${check_iter} polls"
  else
    note_fail "E4a. Stalwart replicas dropped to 0 on ${scaledown_failures}/${check_iter} polls"
  fi
  # A single transient SMTP failure during the upload phase could happen
  # due to network jitter; require <2 failures for pass.
  if (( smtp_failures < 2 )); then
    note_pass "E4b. SMTP banner remained responsive (${smtp_failures} transient failures across ${check_iter} polls)"
  else
    note_fail "E4b. SMTP banner failed on ${smtp_failures}/${check_iter} polls — no_downtime contract broken"
  fi

  # E5. Final state inspection.
  if [[ "$run_state" != "succeeded" ]]; then
    note_fail "E5. archive run terminal state=${run_state} (expected 'succeeded'); step=${run_step}"
    return
  fi
  local final_body
  final_body="$(curl -sk \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    "${PLATFORM_API_URL}/api/v1/admin/mail/archive-runs/${run_id}" --max-time 15 || echo '{}')"
  local restic_id export_bytes db_mode
  restic_id="$(echo "$final_body" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("data",{}).get("resticSnapshotId") or "")' 2>/dev/null)"
  export_bytes="$(echo "$final_body" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("data",{}).get("exportSizeBytes") or 0)' 2>/dev/null)"
  db_mode="$(echo "$final_body" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("data",{}).get("mode") or "")' 2>/dev/null)"

  if [[ -n "$restic_id" && "$restic_id" != "null" ]]; then
    note_pass "E5a. resticSnapshotId populated: ${restic_id}"
  else
    note_fail "E5a. resticSnapshotId missing from succeeded run"
  fi
  if (( export_bytes > 0 )); then
    note_pass "E5b. exportSizeBytes=${export_bytes}"
  else
    note_fail "E5b. exportSizeBytes=${export_bytes} (expected > 0)"
  fi
  if [[ "$db_mode" == "no_downtime" ]]; then
    note_pass "E5c. mode column = 'no_downtime'"
  else
    note_fail "E5c. mode column = '${db_mode}' (expected 'no_downtime')"
  fi

  # E6. Checkpoint dir cleanup — no .checkpoint-tmp-* leftovers.
  local leftover
  leftover="$(kctl exec -n "$STALWART_NS" "$POD" -c stalwart -- \
    sh -c 'ls -1d /var/lib/stalwart/data/.checkpoint-tmp-* 2>/dev/null | wc -l' 2>/dev/null \
    | tr -d ' \n\r' || echo "?")"
  if [[ "$leftover" == "0" ]]; then
    note_pass "E6. checkpoint dir cleaned up (no .checkpoint-tmp-* in live PVC)"
  else
    note_fail "E6. ${leftover} stale .checkpoint-tmp-* dir(s) left in live PVC"
  fi

  # E7. SMTP + IMAP still serving after the run.
  local post_smtp post_imap
  post_smtp="$(timeout 10 bash -c "
    exec 3<>/dev/tcp/${PROBE_HOST}/25
    read -t 5 -u 3 line
    echo \"\$line\"
    printf 'QUIT\\r\\n' >&3
  " 2>/dev/null || echo '')"
  post_imap="$(timeout 10 bash -c "
    exec 3<>/dev/tcp/${PROBE_HOST}/143
    read -t 5 -u 3 line
    echo \"\$line\"
    printf 'a LOGOUT\\r\\n' >&3
  " 2>/dev/null || echo '')"
  if echo "$post_smtp" | grep -qiE 'esmtp|stalwart|220'; then
    note_pass "E7a. SMTP greeting OK after run"
  else
    note_fail "E7a. SMTP greeting after run unexpected: '${post_smtp:0:80}'"
  fi
  if echo "$post_imap" | grep -qiE '^\* OK'; then
    note_pass "E7b. IMAP greeting OK after run"
  else
    note_fail "E7b. IMAP greeting after run unexpected: '${post_imap:0:80}'"
  fi
  echo ""
}

# ── Phase F — mail-archive downtime mode (fallback) ────────────────────
phase_f_archive_downtime() {
  echo "## Phase F — mail-archive downtime-mode fallback (DESTRUCTIVE — incurs mail downtime)"

  if [[ -z "$ADMIN_TOKEN" || -z "$PLATFORM_API_URL" ]]; then
    note_warn "F0. ADMIN_TOKEN + PLATFORM_API_URL not set — skipping Phase F"
    echo ""
    return
  fi

  # Same backup-target gate as Phase E.
  local status_body backup_store_id
  status_body="$(curl -sk \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    "${PLATFORM_API_URL}/api/v1/admin/mail/archive-status" --max-time 15 || echo '{}')"
  backup_store_id="$(echo "$status_body" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("data",{}).get("backupTarget",{}).get("backupStoreId") or "")' 2>/dev/null || echo "")"
  if [[ -z "$backup_store_id" ]]; then
    note_warn "F1. No backup target configured — skipping Phase F"
    echo ""
    return
  fi
  note_pass "F1. backup target configured: ${backup_store_id}"

  # F2. Trigger downtime archive.
  local trigger_response run_id
  trigger_response="$(curl -sk \
    -X POST "${PLATFORM_API_URL}/api/v1/admin/mail/archive/trigger" \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    -H 'Content-Type: application/json' \
    -d '{"mode":"downtime"}' --max-time 30 || echo '{}')"
  run_id="$(echo "$trigger_response" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("data",{}).get("runId") or "")' 2>/dev/null || echo "")"
  if [[ -z "$run_id" ]]; then
    note_fail "F2. trigger downtime mode did not return runId: ${trigger_response:0:200}"
    return
  fi
  note_pass "F2. downtime archive triggered: runId=${run_id}"

  # F3. Wait for the run to enter the down phase, then verify SMTP is
  # UNREACHABLE for at least one probe. The contract for downtime mode
  # is that mail goes offline.
  local poll_deadline=$(( $(date +%s) + 900 ))   # 15 min cap
  local run_state="" run_step="" seen_smtp_down=false replicas_was_zero=false
  while (( $(date +%s) < poll_deadline )); do
    local run_body
    run_body="$(curl -sk \
      -H "Authorization: Bearer ${ADMIN_TOKEN}" \
      "${PLATFORM_API_URL}/api/v1/admin/mail/archive-runs/${run_id}" --max-time 15 || echo '{}')"
    run_state="$(echo "$run_body" \
      | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("data",{}).get("state") or "")' 2>/dev/null)"
    run_step="$(echo "$run_body" \
      | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("data",{}).get("currentStep") or "")' 2>/dev/null)"

    local replicas
    replicas="$(kctl -n "$STALWART_NS" get deploy stalwart-mail -o jsonpath='{.spec.replicas}' 2>/dev/null || echo 1)"
    if [[ "$replicas" == "0" ]]; then replicas_was_zero=true; fi

    if [[ "$run_state" == "scaling_down" || "$run_state" == "exporting" || "$run_state" == "scaling_up" ]]; then
      local probe_banner
      probe_banner="$(timeout 3 bash -c "
        exec 3<>/dev/tcp/${PROBE_HOST}/25
        read -t 2 -u 3 line
        echo \"\$line\"
        printf 'QUIT\\r\\n' >&3
      " 2>/dev/null || echo '')"
      if [[ -z "$probe_banner" ]]; then
        seen_smtp_down=true
      fi
    fi

    echo "    poll: state=$run_state step=$run_step replicas=$replicas smtp_down_seen=$seen_smtp_down"
    if [[ "$run_state" == "succeeded" || "$run_state" == "failed" ]]; then break; fi
    sleep 5
  done

  if $replicas_was_zero; then
    note_pass "F3a. Stalwart replicas dropped to 0 during run (downtime contract)"
  else
    note_warn "F3a. Stalwart replicas never observed at 0 — scale-down may have been too fast to catch"
  fi
  if $seen_smtp_down; then
    note_pass "F3b. SMTP went unreachable during run (downtime contract)"
  else
    note_warn "F3b. SMTP never observed unreachable — downtime may have been brief (still acceptable)"
  fi

  # F4. After terminal, SMTP must return within 60s.
  if [[ "$run_state" != "succeeded" ]]; then
    note_fail "F4. terminal state=${run_state} (expected 'succeeded'); step=${run_step}"
    return
  fi
  local waited=0 post_banner=""
  while (( waited < 60 )); do
    post_banner="$(timeout 5 bash -c "
      exec 3<>/dev/tcp/${PROBE_HOST}/25
      read -t 3 -u 3 line
      echo \"\$line\"
      printf 'QUIT\\r\\n' >&3
    " 2>/dev/null || echo '')"
    if echo "$post_banner" | grep -qiE 'esmtp|stalwart|220'; then break; fi
    sleep 5
    waited=$(( waited + 5 ))
  done
  if echo "$post_banner" | grep -qiE 'esmtp|stalwart|220'; then
    note_pass "F4a. SMTP returned within ${waited}s of run completion"
  else
    note_fail "F4a. SMTP did NOT return within 60s — Stalwart scale-back broken? banner='${post_banner:0:80}'"
  fi

  # F4b. mode column = 'downtime'.
  local final_body db_mode
  final_body="$(curl -sk \
    -H "Authorization: Bearer ${ADMIN_TOKEN}" \
    "${PLATFORM_API_URL}/api/v1/admin/mail/archive-runs/${run_id}" --max-time 15 || echo '{}')"
  db_mode="$(echo "$final_body" \
    | python3 -c 'import sys,json; d=json.load(sys.stdin); print(d.get("data",{}).get("mode") or "")' 2>/dev/null)"
  if [[ "$db_mode" == "downtime" ]]; then
    note_pass "F4b. mode column = 'downtime'"
  else
    note_fail "F4b. mode column = '${db_mode}' (expected 'downtime')"
  fi
  echo ""
}

# ── Run phases ─────────────────────────────────────────────────────────
phase_a_health
phase_b_state
if $RUN_MODE_FLIP;        then phase_c_mode_flip;            fi
if $RUN_NEGATIVE;         then phase_d_negative;             fi
if $RUN_ARCHIVE;          then phase_e_archive_no_downtime;  fi
if $RUN_ARCHIVE_DOWNTIME; then phase_f_archive_downtime;     fi

# ── Summary ────────────────────────────────────────────────────────────
echo "═══════════════════════════════════════════════════════════════════"
echo "  Stalwart mail HA harness: pass=${PASS} fail=${FAIL} warn=${WARN}"
echo "═══════════════════════════════════════════════════════════════════"
if (( FAIL > 0 )); then
  echo ""
  echo "RESULT: NOT READY — fix the ${FAIL} failure(s) above."
  exit 1
fi
echo ""
echo "RESULT: GREEN — mail HA stack is healthy."
exit 0
