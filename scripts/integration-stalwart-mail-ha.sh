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
#   Phase H — health-truth (--health-truth, ~10 sec, requires ADMIN_TOKEN)
#     Catches the "banner says green but reality is broken" class of bug
#     that motivated the Phase 3a/3b probe rewrite. Calls
#     /admin/mail/health?refresh=1 and compares its claims against live
#     kubectl/nc probes. Drift = fail.
#     H1. banner.pod.healthy == kubectl.containerStatuses.ready
#     H2. banner.rocksdb.currentFile/lockFile match live `test -f`
#     H3. banner.tcp[port].reachable matches live nc on 25 + 993
#     H4. Top-level healthy=true implies all components healthy
#         (catches Phase-3a-style "lying tile" bugs).
#
#   Phase G — migrate endpoint smoke (--migrate-smoke, ~5 sec, requires ADMIN_TOKEN)
#     Non-destructive input-validation surface check on /admin/mail/migrate.
#     G1. Unknown target node → MAIL_NODE_NOT_FOUND
#     G2. Same-node target → MAIL_MIGRATION_SAME_NODE
#     G3. /failback either resolves a target or returns
#         MAIL_PLACEMENT_NO_CANDIDATE (proves the intent-discriminator wiring)
#     G4. placement.currentNode == kubectl pod.spec.nodeName
#
#   Phase I — Flux-ownership post-flip (--flux-ownership, ~5 min, requires --mode-flip)
#     After mode-flip, sleep 300s and assert Flux did NOT revert any of
#     the runtime-owned fields. The 5-min wait is the full Kustomization.
#     spec.interval window — a 60s wait would miss regressions where
#     Flux's first reconcile passes but the 2nd/3rd reverts state.
#     I1. haproxy DS presence matches mode (allServerNodes → present)
#     I2. haproxy DS labelled managed-by=platform-api
#     I3. kustomize-controller absent from haproxy DS managedFields
#     I4. Stalwart Deployment uses stable PVC name 'stalwart-rocksdb-data'
#         (Phase 1 streamline invariant — catches per-run-naming regression)
#     I5. ssa:merge annotation NOT active on Stalwart Deployment
#         (the annotation has the opposite effect of its name — verified
#         on 2026-05-15, see migration.ts header comment)
#
#   Phase J — Stalwart cert acquisition (--cert-acquisition, ~10 sec)
#     Live TLS handshake on mail.<host>:465. Verifies Phase 5 streamline:
#     fresh bootstrap.sh produces a real Let's Encrypt cert via the
#     x:Task/set create AcmeRenewal JMAP path. Non-destructive — can
#     run against any cluster to verify cert state.
#     J1. cert subject CN matches the mail hostname
#     J2. cert issued by Let's Encrypt
#     J3. cert currently valid (not expired)
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
RUN_HEALTH_TRUTH=false
RUN_MIGRATE_SMOKE=false
RUN_FLUX_OWNERSHIP=false
RUN_CERT_ACQUISITION=false
for arg in "$@"; do
  case "$arg" in
    --mode-flip)        RUN_MODE_FLIP=true ;;
    --negative)         RUN_NEGATIVE=true ;;
    --archive)          RUN_ARCHIVE=true ;;
    --archive-downtime) RUN_ARCHIVE_DOWNTIME=true ;;
    --health-truth)     RUN_HEALTH_TRUTH=true ;;
    --migrate-smoke)    RUN_MIGRATE_SMOKE=true ;;
    --flux-ownership)   RUN_FLUX_OWNERSHIP=true ;;
    --cert-acquisition) RUN_CERT_ACQUISITION=true ;;
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
  # Re-resolve the Stalwart pod every call. $POD is captured at
  # harness startup; Phase C / Phase E cycle the Deployment, leaving
  # $POD stale by the time Phase D runs (D1a/D2a then receive empty
  # responses, triggering false-positive WARN). Looking up the pod
  # by label-selector each call keeps jmap_call robust to rollovers.
  local current_pod
  current_pod="$(kctl -n "$STALWART_NS" get pod \
    -l app.kubernetes.io/component=stalwart \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || echo "$POD")"
  kctl exec -i -n "$STALWART_NS" "$current_pod" -c stalwart -- sh -c "
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
  # Container name is `api` on staging/production (per platform-api
  # Deployment); pre-streamline this script used `backend` which silent-
  # failed (Error from server (BadRequest): container backend is not
  # valid) and returned an empty string — Phase C then mis-detected
  # start_mode and would re-PATCH the same mode (no-op or destructive
  # depending on direction).
  kctl -n "$PLATFORM_NS" exec -i deploy/platform-api -c api -- sh -c '
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

  # B4. haproxy DaemonSet lifecycle matches port-exposure mode.
  # 2026-05-14 streamline (Phase 7): the haproxy DS lifecycle moved
  # from Flux into platform-api. In thisNodeOnly mode the DS object
  # does NOT exist (deleted by platform-api on mode flip). In
  # allServerNodes mode the DS exists, scheduled on every server-role
  # node. Pre-Phase-7 the DS was always present with a dummy
  # nodeSelector flipped on/off.
  local ds_desired ds_ready mode server_node_count ds_present
  ds_desired="$(kctl -n "$STALWART_NS" get ds stalwart-haproxy -o jsonpath='{.status.desiredNumberScheduled}' 2>/dev/null || echo 'absent')"
  ds_ready="$(kctl -n "$STALWART_NS" get ds stalwart-haproxy -o jsonpath='{.status.numberReady}' 2>/dev/null || echo '0')"
  if [[ "$ds_desired" == "absent" ]]; then ds_present=false; else ds_present=true; fi
  mode="$(get_port_exposure_mode)"
  ORIGINAL_PORT_EXPOSURE_MODE="${mode:-thisNodeOnly}"
  server_node_count="$(kctl get nodes -l "$SERVER_ROLE_LABEL" -o name 2>/dev/null | wc -l)"
  case "${mode:-thisNodeOnly}" in
    thisNodeOnly)
      if ! $ds_present; then
        note_pass "B4. haproxy DS absent (mode=thisNodeOnly, post-Phase-7 lifecycle)"
      else
        note_fail "B4. haproxy DS present with desired=${ds_desired} but mode=thisNodeOnly (Phase 7 expects platform-api to have deleted it)"
      fi
      ;;
    allServerNodes)
      if ! $ds_present; then
        note_fail "B4. haproxy DS absent but mode=allServerNodes (platform-api should have created it)"
      elif [[ "$ds_desired" == "$server_node_count" && "$ds_ready" == "$server_node_count" ]]; then
        note_pass "B4. haproxy DS desired=ready=${ds_desired} matches ${server_node_count} server-role nodes"
      else
        note_fail "B4. haproxy DS desired=${ds_desired} ready=${ds_ready} but server nodes=${server_node_count}"
      fi
      ;;
    *)
      note_warn "B4. Unknown mode='${mode}' — cannot validate haproxy DS lifecycle"
      ;;
  esac

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
  # The archive run scales the Deployment down+up, replacing the
  # Stalwart pod. `$POD` from harness startup is stale at this point,
  # so re-resolve from the current ReplicaSet.
  local current_pod leftover
  current_pod="$(kctl -n "$STALWART_NS" get pod \
    -l app.kubernetes.io/component=stalwart \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)"
  if [[ -z "$current_pod" ]]; then
    note_fail "E6. no Stalwart pod found after archive run — Deployment may not have scaled back up"
  else
    leftover="$(kctl exec -n "$STALWART_NS" "$current_pod" -c stalwart -- \
      sh -c 'ls -1d /var/lib/stalwart/data/.checkpoint-tmp-* 2>/dev/null | wc -l' 2>/dev/null \
      | tr -d ' \n\r' || echo "?")"
    if [[ "$leftover" == "0" ]]; then
      note_pass "E6. checkpoint dir cleaned up (no .checkpoint-tmp-* in live PVC)"
    else
      note_fail "E6. ${leftover} stale .checkpoint-tmp-* dir(s) left in live PVC"
    fi
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

# ── Phase H — health-truth (/admin/mail/health vs live state) ──────────
# Streamline 2026-05-14: catches the "banner says green but reality is
# broken" class of bug that motivated the Phase 3a/3b probe rewrite. The
# banner is supposed to AGREE with what kubectl/openssl/nc tell us
# directly. When it doesn't, either the probe is lying (Phase-3 bug) or
# the cache is stale beyond its TTL — both are fail-class.
phase_h_health_truth() {
  echo "## Phase H — health-truth (banner vs live)"

  if [[ -z "$ADMIN_TOKEN" || -z "$PLATFORM_API_URL" ]]; then
    note_warn "H. SKIP — ADMIN_TOKEN + PLATFORM_API_URL required to call /admin/mail/health"
    echo ""
    return
  fi

  local health
  health="$(curl -sk --fail --max-time 30 \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    "${PLATFORM_API_URL%/}/api/v1/admin/mail/health?refresh=1" 2>/dev/null || echo '')"
  if [[ -z "$health" ]]; then
    note_fail "H. /admin/mail/health request failed"
    echo ""
    return
  fi

  local banner_healthy banner_pod_healthy banner_jmap_healthy banner_rocksdb_healthy banner_tcp_healthy
  banner_healthy="$(echo "$health" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['healthy'])" 2>/dev/null || echo 'unknown')"
  banner_pod_healthy="$(echo "$health" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['components']['pod']['healthy'])" 2>/dev/null || echo 'unknown')"
  banner_jmap_healthy="$(echo "$health" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['components']['jmap']['healthy'])" 2>/dev/null || echo 'unknown')"
  banner_rocksdb_healthy="$(echo "$health" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['components']['rocksdb']['healthy'])" 2>/dev/null || echo 'unknown')"
  banner_tcp_healthy="$(echo "$health" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['components']['tcp']['healthy'])" 2>/dev/null || echo 'unknown')"

  # H1. Pod-health agreement — banner.pod must match kubectl.containerStatuses.ready.
  local kubectl_ready
  kubectl_ready=$(kctl -n "$STALWART_NS" get pod "$POD" \
    -o jsonpath='{.status.containerStatuses[?(@.name=="stalwart")].ready}' 2>/dev/null || echo '')
  if [[ "$banner_pod_healthy" == "True" && "$kubectl_ready" == "true" ]]; then
    note_pass "H1. banner.pod.healthy == kubectl.containerStatuses.ready (both green)"
  elif [[ "$banner_pod_healthy" == "False" && "$kubectl_ready" != "true" ]]; then
    note_pass "H1. banner.pod.healthy == kubectl.containerStatuses.ready (both red, consistent)"
  else
    note_fail "H1. DRIFT — banner.pod.healthy=${banner_pod_healthy}, kubectl.ready=${kubectl_ready}"
  fi

  # H2. RocksDB-truth — banner.rocksdb.currentFile must match a live test in the pod.
  local pod_current pod_lock
  pod_current=$(kctl -n "$STALWART_NS" exec "$POD" -c stalwart -- \
    sh -c 'test -f /var/lib/stalwart/data/CURRENT && echo "yes" || echo "no"' 2>/dev/null || echo 'unknown')
  pod_lock=$(kctl -n "$STALWART_NS" exec "$POD" -c stalwart -- \
    sh -c 'test -f /var/lib/stalwart/data/LOCK && echo "yes" || echo "no"' 2>/dev/null || echo 'unknown')
  local banner_current banner_lock
  banner_current="$(echo "$health" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['components']['rocksdb']['currentFile'])" 2>/dev/null || echo 'None')"
  banner_lock="$(echo "$health" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['components']['rocksdb']['lockFile'])" 2>/dev/null || echo 'None')"
  local expect_current expect_lock
  [[ "$pod_current" == "yes" ]] && expect_current="True" || expect_current="False"
  [[ "$pod_lock"    == "yes" ]] && expect_lock="True"    || expect_lock="False"
  if [[ "$banner_current" == "$expect_current" && "$banner_lock" == "$expect_lock" ]]; then
    note_pass "H2. banner.rocksdb agrees with live RocksDB sentinels (CURRENT=${pod_current}, LOCK=${pod_lock})"
  else
    note_fail "H2. DRIFT — banner.rocksdb {current=${banner_current}, lock=${banner_lock}} vs live {current=${pod_current}, lock=${pod_lock}}"
  fi

  # H3. TCP-truth — banner.tcp.reachable must match nc from outside the pod
  #     on at least the SMTP greeting port. We test 25 + 993 (smtps).
  for port in 25 993; do
    local banner_port_reachable
    banner_port_reachable="$(echo "$health" | python3 -c "
import sys, json
d = json.load(sys.stdin)['data']
ports = d['components']['tcp']['ports']
hit = next((p for p in ports if p['port'] == ${port}), None)
print(hit['reachable'] if hit else 'missing')" 2>/dev/null || echo 'unknown')"

    local live_reachable
    if timeout 3 bash -c "</dev/tcp/${PROBE_HOST}/${port}" 2>/dev/null; then
      live_reachable='True'
    else
      live_reachable='False'
    fi

    if [[ "$banner_port_reachable" == "$live_reachable" ]]; then
      note_pass "H3/${port}. banner.tcp[${port}].reachable == live nc (${live_reachable})"
    else
      note_fail "H3/${port}. DRIFT — banner.reachable=${banner_port_reachable}, live=${live_reachable}"
    fi
  done

  # H4. Top-level healthy must NOT be true if any per-component is false.
  # This is the most important guardrail — Phase 3a's bug was that the
  # cosmetic tile reported green despite real failures.
  if [[ "$banner_healthy" == "True" ]]; then
    if [[ "$banner_pod_healthy" != "True" || "$banner_jmap_healthy" != "True" \
       || "$banner_rocksdb_healthy" != "True" || "$banner_tcp_healthy" != "True" ]]; then
      note_fail "H4. INVARIANT VIOLATION — top-level healthy=true but at least one component is unhealthy"
    else
      note_pass "H4. Top-level healthy=true and all components agree"
    fi
  else
    note_pass "H4. Top-level healthy=false (will not be considered green)"
  fi
  echo ""
}

# ── Phase G — migration endpoint smoke (non-destructive) ───────────────
# Validates the /admin/mail/migrate input-validation surface without
# actually moving the pod. Three negative tests + one read-only state
# check. The destructive "real migration" test is intentionally NOT in
# the default harness — it requires multi-node coordination and a long
# rsync window. Phase G is the smaller "did the endpoint hang up on
# bad inputs correctly?" check.
phase_g_migrate_smoke() {
  echo "## Phase G — migrate endpoint input validation"

  if [[ -z "$ADMIN_TOKEN" || -z "$PLATFORM_API_URL" ]]; then
    note_warn "G. SKIP — ADMIN_TOKEN + PLATFORM_API_URL required"
    echo ""
    return
  fi

  # G1. Rejects a non-existent target node with MAIL_NODE_NOT_FOUND.
  # mailMigrationStartRequestSchema requires `confirm: true` to prevent
  # accidental triggers from CLI typos / curl history.
  local resp_unknown
  resp_unknown="$(curl -sk --max-time 15 -X POST \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    -H 'Content-Type: application/json' \
    -d '{"targetNode":"this-node-definitely-does-not-exist-xyz","confirm":true}' \
    "${PLATFORM_API_URL%/}/api/v1/admin/mail/migrate" 2>/dev/null || echo '')"
  if echo "$resp_unknown" | grep -q 'MAIL_NODE_NOT_FOUND'; then
    note_pass "G1. /admin/mail/migrate rejects unknown target with MAIL_NODE_NOT_FOUND"
  else
    note_fail "G1. expected MAIL_NODE_NOT_FOUND; got: ${resp_unknown:0:200}"
  fi

  # G2. Rejects same-node migration with MAIL_MIGRATION_SAME_NODE.
  #
  # CRITICAL: target node must match the API's internal source-node
  # logic (activeNode → primaryNode fallback in migration.ts), NOT
  # `kubectl pod.spec.nodeName`. If they differ (state drift), the
  # API will accept the migration request and start an ACTUAL
  # rsync — destructive on a live cluster. Query the placement
  # endpoint to get exactly what the API considers the source.
  local placement_g2 source_node
  placement_g2="$(curl -sk --fail --max-time 15 \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    "${PLATFORM_API_URL%/}/api/v1/admin/mail/placement" 2>/dev/null || echo '')"
  source_node="$(echo "$placement_g2" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)['data']
  print(d.get('activeNode') or d.get('primaryNode') or '')
except Exception:
  print('')" 2>/dev/null || echo '')"
  if [[ -z "$source_node" ]]; then
    note_warn "G2. SKIP — placement.activeNode/primaryNode not set; same-node test would be a destructive false-positive"
  else
    local resp_same
    resp_same="$(curl -sk --max-time 15 -X POST \
      -H "Authorization: Bearer $ADMIN_TOKEN" \
      -H 'Content-Type: application/json' \
      -d "{\"targetNode\":\"${source_node}\",\"confirm\":true}" \
      "${PLATFORM_API_URL%/}/api/v1/admin/mail/migrate" 2>/dev/null || echo '')"
    if echo "$resp_same" | grep -q 'MAIL_MIGRATION_SAME_NODE'; then
      note_pass "G2. /admin/mail/migrate rejects same-node target='${source_node}' with MAIL_MIGRATION_SAME_NODE"
    else
      note_fail "G2. expected MAIL_MIGRATION_SAME_NODE for source-node target='${source_node}'; got: ${resp_same:0:200}"
    fi
  fi

  # G3. /failback — DANGEROUS to call unconditionally. The API
  # resolves target=primaryNode; source=activeNode (or primaryNode
  # fallback). If primary != active (e.g., placement self-heal moved
  # activeNode to a non-primary node), /failback STARTS A REAL
  # MIGRATION instead of rejecting. Live staging caught this twice:
  # harness run-2 + run-4 both triggered destructive migrations.
  #
  # Safe G3: only call /failback when we can predict it'll reject:
  #   - primaryNode is null     → MAIL_PLACEMENT_NO_CANDIDATE expected
  #   - primaryNode == activeNode → MAIL_MIGRATION_SAME_NODE expected
  # In any other state (primary != active != null), SKIP with a warn
  # — testing this requires either a dry-run flag on the API or
  # mocking placement, neither of which we have.
  local g3_primary g3_active
  g3_primary="$(echo "$placement_g2" | python3 -c "
import sys, json
try: print(json.load(sys.stdin)['data'].get('primaryNode') or '')
except: print('')" 2>/dev/null || echo '')"
  g3_active="$(echo "$placement_g2" | python3 -c "
import sys, json
try: print(json.load(sys.stdin)['data'].get('activeNode') or '')
except: print('')" 2>/dev/null || echo '')"
  if [[ -z "$g3_primary" ]] || [[ "$g3_primary" == "$g3_active" ]]; then
    local resp_fb
    resp_fb="$(curl -sk --max-time 15 -X POST \
      -H "Authorization: Bearer $ADMIN_TOKEN" \
      -H 'Content-Type: application/json' \
      -d '{"confirm":true}' \
      "${PLATFORM_API_URL%/}/api/v1/admin/mail/failback" 2>/dev/null || echo '')"
    if echo "$resp_fb" | grep -qE 'MAIL_PLACEMENT_NO_CANDIDATE|MAIL_MIGRATION_SAME_NODE'; then
      note_pass "G3. /admin/mail/failback rejects expected (primary='${g3_primary}', active='${g3_active}')"
    elif echo "$resp_fb" | grep -q 'runId'; then
      # SHOULD have rejected but DIDN'T — real bug or stale state.
      note_fail "G3. /admin/mail/failback ACCEPTED a migration that should have been rejected: ${resp_fb:0:200}"
    else
      note_fail "G3. unexpected /failback response: ${resp_fb:0:200}"
    fi
  else
    note_warn "G3. SKIP — primary='${g3_primary}' != active='${g3_active}'; /failback would start a real migration"
  fi

  # G4. Live pod node lookup matches placement.activeNode (the field
  # the contract exposes; see mailPlacementResponseSchema).
  # NOTE: when activeNode is null (which is allowed by the schema —
  # null means "not yet set after a placement update"), we report a
  # WARN rather than a pass/fail. Some clusters legitimately don't
  # populate activeNode (depends on whether an operator has clicked
  # through the placement-set wizard since pod schedule changed).
  local placement_active live_pod_node
  placement_active="$(echo "$placement_g2" | python3 -c "
import sys, json
try:
  d = json.load(sys.stdin)['data']
  v = d.get('activeNode')
  print(v if v is not None else 'NULL')
except Exception:
  print('')" 2>/dev/null || echo '')"
  live_pod_node="$(kctl -n "$STALWART_NS" get pod "$POD" -o jsonpath='{.spec.nodeName}' 2>/dev/null || echo '')"
  if [[ "$placement_active" == "NULL" ]]; then
    note_warn "G4. placement.activeNode is null (live pod on '${live_pod_node}') — placement state-drift; settings need to be refreshed"
  elif [[ "$placement_active" == "$live_pod_node" ]]; then
    note_pass "G4. placement.activeNode == kubectl pod.spec.nodeName (${live_pod_node})"
  elif [[ -z "$placement_active" ]]; then
    note_warn "G4. SKIP — placement response shape did not expose activeNode"
  else
    note_fail "G4. DRIFT — placement.activeNode=${placement_active}, kubectl=${live_pod_node}"
  fi
  echo ""
}

# ── Phase I — Flux-ownership post-flip (depends on --mode-flip) ────────
# After Phase C flips port-exposure, sleep 5 min and assert the haproxy
# DaemonSet lifecycle matches the operator's intent:
#   - mode=allServerNodes → DS exists, labelled managed-by=platform-api,
#     Flux's kustomize-controller is NOT in its managedFields.
#   - mode=thisNodeOnly   → DS does NOT exist (platform-api deleted it
#     on the flip-back; Flux must not re-create it).
#
# 2026-05-14 streamline: haproxy DS lifecycle is now wholly owned by
# platform-api (k8s/base/stalwart-mail/haproxy/daemonset.yaml was
# deleted; spec moved to haproxy-builder.ts).
#
# 2026-05-15 Phase 1 streamline: extended this phase to ALSO verify the
# Stalwart Deployment's `template.spec.volumes[stalwart-data]` keeps the
# stable PVC name (`stalwart-rocksdb-data`). Pre-streamline the migration
# pipeline renamed the volume claim to a per-run name and Flux reverted
# it ~60s later. The new architecture keeps the name stable across
# migrations; if a future regression flips back to per-run naming, this
# check catches the drift on the next Flux reconcile cycle.
#
# 2026-05-15 Phase 6 wait extended from 60s to 5 min: Flux's default
# reconcile interval is 5 min (Kustomization.spec.interval) — the old
# 60s wait did NOT span a full reconcile cycle, so a regression where
# Flux's reconcile reverted state at minute 4 would pass at minute 1.
# 5 min covers a full cycle even on the slowest staging reconcile.
phase_i_flux_ownership() {
  echo "## Phase I — Flux ownership post-flip (sleeps 5 min)"

  if ! $RUN_MODE_FLIP; then
    note_warn "I. SKIP — --flux-ownership requires --mode-flip to have run"
    echo ""
    return
  fi

  echo "  Waiting 300s for Flux reconcile loops (full Kustomization.spec.interval window)..."
  sleep 300

  local current_mode
  current_mode="$(curl -sk --fail --max-time 15 \
    -H "Authorization: Bearer $ADMIN_TOKEN" \
    "${PLATFORM_API_URL%/}/api/v1/admin/mail/port-exposure" 2>/dev/null \
    | python3 -c 'import sys,json; print(json.load(sys.stdin)["data"]["mode"])' 2>/dev/null \
    || echo 'unknown')"

  local ds_present
  if kctl -n "$STALWART_NS" get daemonset stalwart-haproxy >/dev/null 2>&1; then
    ds_present=true
  else
    ds_present=false
  fi

  case "$current_mode" in
    allServerNodes)
      if $ds_present; then
        note_pass "I1. mode=allServerNodes AND haproxy DS exists"
      else
        note_fail "I1. mode=allServerNodes but haproxy DS is MISSING (platform-api failed to create or Flux deleted)"
      fi
      ;;
    thisNodeOnly)
      if $ds_present; then
        note_fail "I1. mode=thisNodeOnly but haproxy DS STILL EXISTS (platform-api failed to delete or Flux re-created)"
      else
        note_pass "I1. mode=thisNodeOnly AND haproxy DS absent"
      fi
      ;;
    *)
      note_warn "I1. unknown mode '${current_mode}' — could not verify DS lifecycle invariant"
      ;;
  esac

  if $ds_present; then
    # I2. DS carries the platform-api managed-by label.
    local managed_by
    managed_by=$(kctl -n "$STALWART_NS" get daemonset stalwart-haproxy \
      -o jsonpath='{.metadata.labels.platform\.phoenix-host\.net/managed-by}' 2>/dev/null || echo '')
    if [[ "$managed_by" == "platform-api" ]]; then
      note_pass "I2. haproxy DS labelled managed-by=platform-api"
    else
      note_fail "I2. haproxy DS missing managed-by=platform-api label (got: '${managed_by}')"
    fi

    # I3. kustomize-controller is NOT in managedFields. The DS spec was
    # removed from k8s/base, so Flux should never claim ownership of
    # this object after the streamline.
    local managers
    managers=$(kctl -n "$STALWART_NS" get daemonset stalwart-haproxy \
      -o jsonpath='{.metadata.managedFields[*].manager}' 2>/dev/null || echo '')
    if echo "$managers" | grep -q 'kustomize-controller'; then
      note_fail "I3. kustomize-controller is in managedFields — Flux is still trying to manage this DS (managers: ${managers})"
    else
      note_pass "I3. kustomize-controller absent from managedFields (managers: ${managers})"
    fi
  fi

  # I4. Stalwart Deployment's PVC name MUST be the stable
  # `stalwart-rocksdb-data`. Phase 1 streamline retired the per-run
  # `stalwart-rocksdb-data-mig-*` naming that fought with Flux. If a
  # regression brings per-run naming back, the PVC name will drift and
  # this check fails.
  local pvc_claim
  pvc_claim=$(kctl -n "$STALWART_NS" get deploy stalwart-mail \
    -o jsonpath='{.spec.template.spec.volumes[?(@.name=="stalwart-data")].persistentVolumeClaim.claimName}' \
    2>/dev/null || echo '')
  if [[ "$pvc_claim" == "stalwart-rocksdb-data" ]]; then
    note_pass "I4. Stalwart Deployment uses stable PVC name 'stalwart-rocksdb-data'"
  else
    note_fail "I4. Stalwart Deployment claimName drift — got '${pvc_claim}', expected 'stalwart-rocksdb-data'"
  fi

  # I5. The ssa:merge annotation must NOT be active on the Deployment.
  # Live testing on 2026-05-15 proved the annotation's actual effect
  # is "force-conflicts=true regardless of Kustomization.spec.force" —
  # which is the opposite of what its name implies. CI guard
  # ci-mail-arch-regressions.sh check 5 enforces this at build time;
  # this check enforces it at runtime in case a hand-applied patch
  # bypassed git.
  local ssa_value
  ssa_value=$(kctl -n "$STALWART_NS" get deploy stalwart-mail \
    -o jsonpath='{.metadata.annotations.kustomize\.toolkit\.fluxcd\.io/ssa}' \
    2>/dev/null || echo '')
  if [[ "$ssa_value" == "merge" ]]; then
    note_fail "I5. Stalwart Deployment has active kustomize.toolkit.fluxcd.io/ssa=merge annotation"
  else
    note_pass "I5. ssa:merge annotation NOT active on Stalwart Deployment"
  fi
  echo ""
}

# ── Phase J — fresh-bootstrap cert acquisition (operator-runnable only) ────
# Verifies the Phase 5 streamline: bootstrap.sh produces a real Let's
# Encrypt cert on mail.<host>:465 within 90s of bootstrap completing.
# This phase is DESTRUCTIVE (requires nuking + re-bootstrapping a
# cluster) and is therefore guarded by --fresh-bootstrap-check and a
# subsequent live-cert probe. The probe portion can run against ANY
# cluster — it just verifies a real cert is being served.
phase_j_cert_acquisition() {
  echo "## Phase J — Stalwart cert acquisition (live TLS probe)"

  if [[ -z "$PLATFORM_API_URL" ]]; then
    note_warn "J. SKIP — PLATFORM_API_URL required"
    echo ""
    return
  fi

  local mail_host
  mail_host=$(echo "$PLATFORM_API_URL" | sed -E 's|^https?://||; s|/.*||; s|^api\.|mail.|; s|^admin\.|mail.|; s|^platform-api\.|mail.|')
  if [[ -z "$mail_host" ]]; then
    note_warn "J. SKIP — could not derive mail hostname from PLATFORM_API_URL=${PLATFORM_API_URL}"
    echo ""
    return
  fi

  echo "  Probing TLS on ${mail_host}:465 (SMTPS)..."
  local cert_info
  cert_info=$(echo | timeout 10 openssl s_client \
    -connect "${mail_host}:465" \
    -servername "${mail_host}" 2>/dev/null \
    | openssl x509 -noout -subject -issuer -dates 2>/dev/null || echo '')

  if [[ -z "$cert_info" ]]; then
    note_fail "J1. TLS handshake on ${mail_host}:465 failed — no cert returned"
    echo ""
    return
  fi

  # J1. Cert subject must match the mail hostname.
  if echo "$cert_info" | grep -qE "subject=.*CN ?= ?${mail_host}"; then
    note_pass "J1. ${mail_host}:465 serves cert CN=${mail_host}"
  else
    note_fail "J1. ${mail_host}:465 cert subject does NOT match — got: $(echo "$cert_info" | grep subject)"
  fi

  # J2. Cert MUST be Let's Encrypt (not self-signed or staging cluster CA).
  if echo "$cert_info" | grep -qE 'issuer=.*(Let.s Encrypt|R[0-9]{1,2}|E[0-9]{1,2})'; then
    note_pass "J2. ${mail_host}:465 cert issued by Let's Encrypt"
  else
    note_fail "J2. ${mail_host}:465 cert NOT issued by Let's Encrypt — got: $(echo "$cert_info" | grep issuer)"
  fi

  # J3. Cert MUST be currently valid (notBefore < now < notAfter).
  local not_after
  not_after=$(echo "$cert_info" | grep -oP 'notAfter=\K.*' || echo '')
  if [[ -n "$not_after" ]]; then
    local expiry_epoch now_epoch
    expiry_epoch=$(date -d "$not_after" +%s 2>/dev/null || echo 0)
    now_epoch=$(date +%s)
    if (( expiry_epoch > now_epoch )); then
      local days_left=$(( (expiry_epoch - now_epoch) / 86400 ))
      note_pass "J3. cert valid — ${days_left} days until expiry"
    else
      note_fail "J3. cert is EXPIRED (notAfter=${not_after})"
    fi
  else
    note_warn "J3. could not parse notAfter from cert"
  fi
  echo ""
}

# ── Run phases ─────────────────────────────────────────────────────────
phase_a_health
phase_b_state
if $RUN_HEALTH_TRUTH;     then phase_h_health_truth;          fi
if $RUN_MIGRATE_SMOKE;    then phase_g_migrate_smoke;         fi
if $RUN_MODE_FLIP;        then phase_c_mode_flip;            fi
if $RUN_FLUX_OWNERSHIP;   then phase_i_flux_ownership;        fi
if $RUN_NEGATIVE;         then phase_d_negative;             fi
if $RUN_ARCHIVE;          then phase_e_archive_no_downtime;  fi
if $RUN_ARCHIVE_DOWNTIME; then phase_f_archive_downtime;     fi
if $RUN_CERT_ACQUISITION; then phase_j_cert_acquisition;    fi

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
