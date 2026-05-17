#!/usr/bin/env bash
# integration-catalog-local.sh — verify every catalog entry actually starts.
#
# Drives the platform admin API (the same way a customer would) to deploy
# each catalog entry into its own ephemeral client namespace, asserts the
# per-type readiness contract, captures evidence on failure, tears down,
# emits a markdown report.
#
# USAGE
#   ./scripts/integration-catalog-local.sh                  # all tiers
#   ./scripts/integration-catalog-local.sh --tier=small     # subset
#   ./scripts/integration-catalog-local.sh --entries=wordpress,nginx-php
#   ./scripts/integration-catalog-local.sh --keep           # don't clean up on failure
#
# ENV
#   ADMIN_HOST           default: http://admin.k8s-platform.test:2010
#   ADMIN_EMAIL          default: admin@k8s-platform.test
#   ADMIN_PASSWORD       default: admin
#   PORT_INGRESS_HTTPS   default: 2011 (HTTPS port mapped on DinD)
#   K3S_CONTAINER        default: hosting-platform-k3s-server-1
#   EVIDENCE_DIR         default: /tmp/catalog-test-evidence
#   REPORT_FILE          default: /tmp/catalog-test-report.md

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/catalog-tests/lib"
FIXTURES_DIR="${SCRIPT_DIR}/catalog-tests/fixtures"
READINESS_FILE="${SCRIPT_DIR}/catalog-tests/readiness.json"
TIER_FILE="${FIXTURES_DIR}/tier-filter.json"

ADMIN_HOST="${ADMIN_HOST:-http://admin.k8s-platform.test:2010}"
ADMIN_EMAIL="${ADMIN_EMAIL:-admin@k8s-platform.test}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-admin}"
PORT_INGRESS_HTTPS="${PORT_INGRESS_HTTPS:-2011}"
K3S_CONTAINER="${K3S_CONTAINER:-hosting-platform-k3s-server-1}"
EVIDENCE_DIR="${EVIDENCE_DIR:-/tmp/catalog-test-evidence}"
REPORT_FILE="${REPORT_FILE:-/tmp/catalog-test-report.md}"
RESULTS_TSV="${RESULTS_TSV:-/tmp/catalog-test-results.tsv}"

# Args
TIER_FILTER=""
ENTRY_FILTER=""
KEEP_ON_FAIL=false
RERUN_FAILURES=false
while (( $# > 0 )); do
  case "$1" in
    --tier=*)    TIER_FILTER="${1#--tier=}"; shift ;;
    --entries=*) ENTRY_FILTER="${1#--entries=}"; shift ;;
    --keep)      KEEP_ON_FAIL=true; shift ;;
    --rerun-failures) RERUN_FAILURES=true; shift ;;
    --help|-h)
      sed -n '3,22p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'; exit 0 ;;
    *) echo "ERROR: unknown arg $1" >&2; exit 2 ;;
  esac
done

# --rerun-failures: replace the entry filter with the FAIL rows from
# the previous run's TSV. Useful for iterative bug-fix loops.
if [[ "$RERUN_FAILURES" == true ]]; then
  if [[ ! -s "$RESULTS_TSV" ]]; then
    echo "ERROR: --rerun-failures needs a prior run at ${RESULTS_TSV}" >&2
    exit 2
  fi
  ENTRY_FILTER=$(awk -F'\t' '$3=="FAIL" {print $1}' "$RESULTS_TSV" | paste -sd, -)
  if [[ -z "$ENTRY_FILTER" ]]; then
    echo "All entries in ${RESULTS_TSV} passed — nothing to re-run."
    exit 0
  fi
  echo "Re-running ${ENTRY_FILTER//,/ }"
fi

# shellcheck source=catalog-tests/lib/api.sh
source "${LIB_DIR}/api.sh"
# shellcheck source=catalog-tests/lib/probe.sh
source "${LIB_DIR}/probe.sh"
# shellcheck source=catalog-tests/lib/cleanup.sh
source "${LIB_DIR}/cleanup.sh"

# ─── safety net: track every tenant we create so the EXIT trap can ──
# tear them down even when SIGINT / set -e interrupts the run between
# `create_tenant` and the inline tear_down_tenant call. The trap is a
# best-effort backstop on top of the per-entry cleanup in run_entry
# — most runs never need it, but it prevents the 41-entry sweep from
# leaking 41 tenants if Ctrl+C lands mid-loop.
declare -a CATALOG_CREATED_TENANTS=()
track_created_tenant()   { CATALOG_CREATED_TENANTS+=("$1"); }
untrack_created_tenant() { CATALOG_CREATED_TENANTS=("${CATALOG_CREATED_TENANTS[@]/$1}"); }

catalog_exit_cleanup() {
  local rc=$?
  local leftover=()
  for cid in "${CATALOG_CREATED_TENANTS[@]}"; do
    [[ -n "$cid" ]] && leftover+=("$cid")
  done
  if [[ ${#leftover[@]} -gt 0 ]]; then
    log "EXIT trap: tearing down ${#leftover[@]} leftover tenant(s)"
    for cid in "${leftover[@]}"; do
      tear_down_tenant "$cid" "" 2>&1 | sed 's/^/  /' || true
    done
  fi
  exit "$rc"
}
trap catalog_exit_cleanup EXIT

# ─── prerequisites ────────────────────────────────────────────────

prereq_check() {
  log "Prerequisite check"
  if ! docker ps --format '{{.Names}}' 2>/dev/null | grep -q "^${K3S_CONTAINER}$"; then
    fail "k3s container ${K3S_CONTAINER} not running. Run: ./scripts/local.sh up"
    exit 1
  fi
  ok "k3s container running"
  TOKEN=$(login_token)
  if [[ -z "$TOKEN" ]]; then
    fail "Admin login failed at ${ADMIN_HOST}"
    exit 1
  fi
  ok "Admin login OK"
  local entries_json
  entries_json=$(api GET "/catalog?limit=200")
  local count
  count=$(echo "$entries_json" | python3 -c "import json,sys;print(len(json.load(sys.stdin).get('data',[])))")
  if [[ -z "$count" || "$count" -lt 1 ]]; then
    fail "Catalog appears empty — sync first via Admin → Catalog"
    exit 1
  fi
  ok "Catalog has ${count} entries"
  mkdir -p "$EVIDENCE_DIR"
  : > "$RESULTS_TSV"
  echo -e "code\ttype\tstatus\tduration_s\treadiness\tdetail\tevidence" > "$RESULTS_TSV"
}

# ─── target list resolution ───────────────────────────────────────

# Build the ordered list of entry codes to test, given args.
resolve_targets() {
  if [[ -n "$ENTRY_FILTER" ]]; then
    echo "$ENTRY_FILTER" | tr ',' '\n'
    return
  fi
  local tiers='small medium large'
  [[ -n "$TIER_FILTER" ]] && tiers="$TIER_FILTER"
  for t in $tiers; do
    python3 -c "
import json, sys
d = json.load(open('${TIER_FILE}'))
for e in d['tiers'].get('${t}', {}).get('entries', []):
    print(e)
"
  done
}

# Resolve readiness rule for an entry — type default + per-entry override.
resolve_readiness() {
  local code="$1" type="$2"
  python3 -c "
import json
d = json.load(open('${READINESS_FILE}'))
rule = dict(d['type_defaults'].get('${type}', {}))
rule.update(d.get('overrides', {}).get('${code}', {}))
print(json.dumps(rule))
"
}

# ─── per-entry test loop ──────────────────────────────────────────

run_entry() {
  local code="$1"
  local stamp; stamp=$(date +%s)
  local rand; rand=$(printf '%04x' $((RANDOM)))
  local cname="t${code:0:8}${rand}"   # K8s name regex: [a-z0-9-]; cap to ensure <63 char
  local depl_name="${code:0:8}${rand}"
  cname=$(echo "$cname" | tr '_' '-' | tr -cd 'a-z0-9-')
  depl_name=$(echo "$depl_name" | tr '_' '-' | tr -cd 'a-z0-9-')

  local started_at; started_at=$(date +%s)
  log "${BOLD}=== ${code} ===${RESET}"

  # Re-login per-entry so the JWT never expires mid-test. Default access
  # token TTL is 30 minutes; long tier runs (24+ entries × ~80s + slow
  # cleanup) easily blow through that. Without this, late-tier entries
  # silently 401 on every API call and the catalog lookup reports
  # "not in catalog" — happened on the first run (12-24/24 all FAIL_lookup
  # at the 30min mark). Cheap (~300ms) given test cost.
  TOKEN=$(login_token)
  if [[ -z "$TOKEN" ]]; then
    fail "re-login failed for ${code}"
    echo -e "${code}\t-\tFAIL\t0\trelogin\tToken refresh failed\t-" >> "$RESULTS_TSV"
    return 1
  fi

  # Resolve catalog entry id + type
  local entry_json
  entry_json=$(api GET "/catalog?limit=200" | python3 -c "
import json, sys
d = json.load(sys.stdin)
for e in d.get('data', []):
    if e.get('code') == '${code}':
        print(json.dumps({'id':e['id'],'type':e['type'],'name':e['name'],'components':e.get('components') or []}))
        break
")
  if [[ -z "$entry_json" ]]; then
    fail "catalog entry '${code}' not found"
    echo -e "${code}\t-\tFAIL\t0\tlookup\tNot in catalog\t-" >> "$RESULTS_TSV"
    return 1
  fi
  local entry_id type rname
  entry_id=$(echo "$entry_json" | python3 -c "import json,sys;print(json.load(sys.stdin)['id'])")
  type=$(echo "$entry_json" | python3 -c "import json,sys;print(json.load(sys.stdin)['type'])")
  rname=$(echo "$entry_json" | python3 -c "import json,sys;print(json.load(sys.stdin)['name'])")
  info "code=${code} type=${type} name='${rname}' id=${entry_id}"

  # Early-skip path: readiness rule with kind=skip means the entry can't be
  # verified in DinD (e.g., coturn needs hostPort 3478 not exposed locally).
  # Record SKIP and exit before paying for plan/client/deploy.
  local _skip_kind
  _skip_kind=$(resolve_readiness "$code" "$type" | python3 -c "import json,sys;print(json.load(sys.stdin).get('kind',''))")
  if [[ "$_skip_kind" == "skip" ]]; then
    info "${code} SKIPPED — readiness.kind=skip (verify on real staging)"
    echo -e "${code}\t${type}\tSKIP\t0\tskip\tDinD limitation — see readiness.json comment\t-" >> "$RESULTS_TSV"
    return 0
  fi

  # Resolve plan + region (cached at first call so we don't pay every entry).
  # Pick the LARGEST plan so multi-component apps (paperless-ngx, plausible,
  # nextcloud — 3+ components) don't trip the starter-plan ResourceQuota.
  # The starter plan's CPU=500m total fits 2 small components max; bigger
  # apps need Business or Premium.
  if [[ -z "${PLAN_ID:-}" ]]; then
    PLAN_ID=$(api GET "/plans?limit=20" \
      | python3 -c "
import json, sys
d = json.load(sys.stdin)
plans = d.get('data', [])
# Sort by cpuLimit descending; take the largest
plans.sort(key=lambda p: float(p.get('cpuLimit', 0) or 0), reverse=True)
print(plans[0].get('id', '') if plans else '')
")
    REGION_ID=$(api GET "/regions?limit=1" \
      | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('data',[{}])[0].get('id',''))")
    if [[ -z "$PLAN_ID" || -z "$REGION_ID" ]]; then
      fail "could not resolve plan_id (${PLAN_ID:-?}) or region_id (${REGION_ID:-?})"
      echo -e "${code}\t${type}\tFAIL\t0\tprereq\tNo plan/region\t-" >> "$RESULTS_TSV"
      return 1
    fi
    info "PLAN_ID=${PLAN_ID} (largest) REGION_ID=${REGION_ID}"
  fi

  # Create client
  local client_resp tenant_id ns
  client_resp=$(api POST "/tenants" \
    "{\"name\":\"catalog-${code}-${rand}\",\"primary_email\":\"${cname}@k8s-platform.test\",\"plan_id\":\"${PLAN_ID}\",\"region_id\":\"${REGION_ID}\",\"storage_tier\":\"local\"}")
  tenant_id=$(echo "$client_resp" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('data',{}).get('id') or '')" 2>/dev/null)
  if [[ -z "$tenant_id" ]]; then
    fail "client create failed: $(echo "$client_resp" | head -c 300)"
    echo -e "${code}\t${type}\tFAIL\t0\tclient_create\tCreate failed\t-" >> "$RESULTS_TSV"
    return 1
  fi
  info "tenant_id=${tenant_id}"
  track_created_tenant "$tenant_id"

  # Wait for client provision
  if ! wait_for 180 "client provisioned" '"provisioningStatus":"provisioned"' \
       "api GET '/tenants/${tenant_id}'"; then
    fail "client never provisioned"
    local ev; ev=$(capture_evidence "$code" "client-${tenant_id}" "$EVIDENCE_DIR" 2>/dev/null || echo "-")
    [[ "$KEEP_ON_FAIL" == false ]] && tear_down_tenant "$tenant_id" ""
    echo -e "${code}\t${type}\tFAIL\t$(($(date +%s) - started_at))\tprovision\tProvision timeout\t${ev}" >> "$RESULTS_TSV"
    return 1
  fi
  ns=$(api GET "/tenants/${tenant_id}" | python3 -c "import json,sys;print(json.load(sys.stdin).get('data',{}).get('kubernetesNamespace',''))" 2>/dev/null)
  info "namespace=${ns}"

  # POST deployment. We pin generous CPU + memory (well above the
  # API default of 250m/256Mi) because mysql, mongodb, immich, plausible,
  # paperless-ngx etc. need 500Mi-1Gi to start. The largest plan we
  # picked above caps these at the plan limit — but the API default of
  # 256Mi crashes mysql before it finishes InnoDB init.
  local depl_resp depl_id
  depl_resp=$(api POST "/tenants/${tenant_id}/deployments" \
    "{\"catalog_entry_id\":\"${entry_id}\",\"name\":\"${depl_name}\",\"replica_count\":1,\"cpu_request\":\"1\",\"memory_request\":\"1Gi\"}")
  depl_id=$(echo "$depl_resp" | python3 -c "import json,sys;d=json.load(sys.stdin);print(d.get('data',{}).get('id') or '')" 2>/dev/null)
  if [[ -z "$depl_id" ]]; then
    fail "deployment create failed: $(echo "$depl_resp" | head -c 300)"
    local ev; ev=$(capture_evidence "$code" "$ns" "$EVIDENCE_DIR")
    [[ "$KEEP_ON_FAIL" == false ]] && tear_down_tenant "$tenant_id" "$ns"
    echo -e "${code}\t${type}\tFAIL\t$(($(date +%s) - started_at))\tdepl_create\tCreate failed\t${ev}" >> "$RESULTS_TSV"
    return 1
  fi
  info "deployment id=${depl_id}"

  # Resolve readiness rule
  local rule kind path min_code max_code timeout ports_tcp ports_udp
  rule=$(resolve_readiness "$code" "$type")
  kind=$(echo "$rule" | python3 -c "import json,sys;print(json.load(sys.stdin).get('kind',''))")
  timeout=$(echo "$rule" | python3 -c "import json,sys;print(json.load(sys.stdin).get('timeout_seconds',300))")

  # Wait for the platform's own status to reach 'running' (or 'failed').
  # 'running' is necessary but not sufficient — pods Ready ≠ app responding.
  if ! wait_for "$timeout" "deployment status=running" '"status":"running"' \
       "api GET '/tenants/${tenant_id}/deployments/${depl_id}'"; then
    # Surface lastError to the report
    local last_err
    last_err=$(api GET "/tenants/${tenant_id}/deployments/${depl_id}" \
      | python3 -c "import json,sys;d=json.load(sys.stdin)['data'];print(d.get('lastError','')[:500])")
    fail "deployment never reached running. lastError=${last_err}"
    local ev; ev=$(capture_evidence "$code" "$ns" "$EVIDENCE_DIR")
    [[ "$KEEP_ON_FAIL" == false ]] && tear_down_tenant "$tenant_id" "$ns"
    echo -e "${code}\t${type}\tFAIL\t$(($(date +%s) - started_at))\tdepl_running\t${last_err:-Timeout}\t${ev}" >> "$RESULTS_TSV"
    return 1
  fi

  # Run readiness probe
  local probe_ok=0
  case "$kind" in
    pod_ready_only)
      probe_pod_ready_only "$ns" "platform.io/managed=true" "$timeout" || probe_ok=$?
      ;;
    http_ingress)
      path=$(echo "$rule" | python3 -c "import json,sys;print(json.load(sys.stdin).get('path','/'))")
      min_code=$(echo "$rule" | python3 -c "import json,sys;print(json.load(sys.stdin).get('expect_code_min',200))")
      max_code=$(echo "$rule" | python3 -c "import json,sys;print(json.load(sys.stdin).get('expect_code_max',399))")
      local ing_comp
      ing_comp=$(echo "$rule" | python3 -c "import json,sys;print(json.load(sys.stdin).get('ingress_component',''))")
      probe_http_ingress "$ns" "$path" "$min_code" "$max_code" "$timeout" "$code" "$ing_comp" || probe_ok=$?
      ;;
    db_protocol)
      # Engine derived from the deployment's primary DB component.
      local engine="$code"
      case "$code" in
        mariadb) engine=mariadb ;;
        mysql)   engine=mysql ;;
        postgresql) engine=postgresql ;;
        mongodb-7)  engine=mongodb ;;
      esac
      probe_db_protocol "$ns" "$depl_name" "$engine" "$timeout" || probe_ok=$?
      ;;
    service_protocol)
      probe_service_protocol "$ns" "$code" "$timeout" || probe_ok=$?
      ;;
    stun_probe)
      local tcp udp
      tcp=$(echo "$rule" | python3 -c "import json,sys;d=json.load(sys.stdin);print(','.join(map(str,d.get('ports_tcp',[]))))")
      udp=$(echo "$rule" | python3 -c "import json,sys;d=json.load(sys.stdin);print(','.join(map(str,d.get('ports_udp',[]))))")
      probe_stun_probe "$ns" "$timeout" "$tcp" "$udp" || probe_ok=$?
      ;;
    *)
      fail "Unknown probe kind '${kind}' for ${code}"; probe_ok=99 ;;
  esac

  local duration=$(( $(date +%s) - started_at ))

  if [[ $probe_ok -eq 0 ]]; then
    ok "${code} PASSED in ${duration}s"
    tear_down_tenant "$tenant_id" "$ns"
    echo -e "${code}\t${type}\tPASS\t${duration}\t${kind}\t-\t-" >> "$RESULTS_TSV"
    return 0
  else
    fail "${code} FAILED probe (kind=${kind})"
    local ev; ev=$(capture_evidence "$code" "$ns" "$EVIDENCE_DIR")
    [[ "$KEEP_ON_FAIL" == false ]] && tear_down_tenant "$tenant_id" "$ns"
    echo -e "${code}\t${type}\tFAIL\t${duration}\t${kind}\tProbe failed\t${ev}" >> "$RESULTS_TSV"
    return 1
  fi
}

# ─── final report ─────────────────────────────────────────────────

write_report() {
  {
    echo "# Catalog Local Verification Report"
    echo
    echo "Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "Stack: ${ADMIN_HOST}"
    echo
    echo "## Results"
    echo
    echo "| Entry | Type | Status | Duration | Kind | Detail |"
    echo "|---|---|---|---|---|---|"
    tail -n +2 "$RESULTS_TSV" | awk -F'\t' '{
      printf("| %s | %s | %s | %ss | %s | %s |\n", $1, $2, $3, $4, $5, $6)
    }'
    echo
    local total pass fail skip
    total=$(tail -n +2 "$RESULTS_TSV" | wc -l)
    pass=$(awk -F'\t' '$3=="PASS"' "$RESULTS_TSV" | wc -l)
    fail=$(awk -F'\t' '$3=="FAIL"' "$RESULTS_TSV" | wc -l)
    skip=$(awk -F'\t' '$3=="SKIP"' "$RESULTS_TSV" | wc -l)
    echo "## Summary"; echo
    echo "- Total: ${total}"
    echo "- Passed: ${pass}"
    echo "- Failed: ${fail}"
    echo "- Skipped: ${skip}"
    echo
    if [[ "$fail" -gt 0 ]]; then
      echo "## Failures"; echo
      awk -F'\t' '$3=="FAIL" {printf("- **%s** (%s) — %s — evidence: %s\n", $1, $5, $6, $7)}' "$RESULTS_TSV"
    fi
  } > "$REPORT_FILE"
  log "Report written: ${REPORT_FILE}"
}

# ─── main ─────────────────────────────────────────────────────────

main() {
  prereq_check
  local targets
  mapfile -t targets < <(resolve_targets)
  log "Plan: ${#targets[@]} entries to test"
  local pass=0 fail=0 idx=0
  for code in "${targets[@]}"; do
    [[ -z "$code" ]] && continue
    idx=$((idx+1))
    log "${BOLD}[${idx}/${#targets[@]}] ${code}${RESET}"
    if run_entry "$code"; then
      pass=$((pass+1))
    else
      fail=$((fail+1))
    fi
  done
  echo
  log "${BOLD}=== summary: ${pass} passed, ${fail} failed (of ${#targets[@]}) ===${RESET}"
  write_report
  [[ $fail -eq 0 ]]
}

main "$@"
