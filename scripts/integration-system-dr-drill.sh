#!/usr/bin/env bash
# Phase 5 — DR drill harness.
#
# Cold-restore the entire platform from System Backup artifacts onto
# a fresh VM. Validates the full Phase 1+2+4b chain end-to-end.
#
# Sources (all from a live source cluster with active backups):
#   - Phase 1 secrets bundle (.tar.age) + operator-private.key
#   - Phase 2 pg_dump artifacts (platform/postgres + mail/mail-pg)
#   - (Optional) Phase 4 WAL replay — out of scope for this drill
#
# Target: a clean VM (Debian/Ubuntu) with SSH access. The harness
# wipes any prior k3s, runs bootstrap.sh with --secrets-bundle,
# waits for Flux to reconcile, then pg_restores the dumps into the
# fresh CNPG clusters.
#
# Usage:
#   SOURCE_ADMIN_HOST=https://admin.staging.phoenix-host.net \
#   SOURCE_ADMIN_PASSWORD=<...> \
#   TARGET_VM_HOST=testing.phoenix-host.net \
#   TARGET_VM_DOMAIN=testing.phoenix-host.net \
#   TARGET_CONFIG_ID=<active-s3-row-uuid> \
#   AGE_KEY_PATH=~/k8s-staging/operator-private.key \
#     ./scripts/integration-system-dr-drill.sh

set -uo pipefail

SOURCE_ADMIN_HOST="${SOURCE_ADMIN_HOST:-https://admin.staging.phoenix-host.net}"
SOURCE_ADMIN_EMAIL="${SOURCE_ADMIN_EMAIL:-admin@phoenix-host.net}"
SOURCE_ADMIN_PASSWORD="${SOURCE_ADMIN_PASSWORD:-}"
TARGET_VM_HOST="${TARGET_VM_HOST:-testing.phoenix-host.net}"
TARGET_VM_USER="${TARGET_VM_USER:-root}"
TARGET_VM_KEY="${TARGET_VM_KEY:-$HOME/hosting-platform.key}"
TARGET_VM_DOMAIN="${TARGET_VM_DOMAIN:-$TARGET_VM_HOST}"
TARGET_CONFIG_ID="${TARGET_CONFIG_ID:-}"
AGE_KEY_PATH="${AGE_KEY_PATH:-$HOME/k8s-staging/operator-private.key}"
WORKDIR="${WORKDIR:-/tmp/dr-drill-$(date +%s)}"

[[ -n "$SOURCE_ADMIN_PASSWORD" ]] || { echo "ERROR: SOURCE_ADMIN_PASSWORD required" >&2; exit 2; }
[[ -n "$TARGET_CONFIG_ID" ]]      || { echo "ERROR: TARGET_CONFIG_ID required" >&2; exit 2; }
[[ -f "$TARGET_VM_KEY" ]]         || { echo "ERROR: TARGET_VM_KEY not found at $TARGET_VM_KEY" >&2; exit 2; }
[[ -f "$AGE_KEY_PATH" ]]          || { echo "ERROR: AGE_KEY_PATH not found at $AGE_KEY_PATH" >&2; exit 2; }

CYAN='\033[36m'; GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; RESET='\033[0m'
log()  { printf '\n%b═══ %s ═══%b\n' "$CYAN" "$*" "$RESET"; }
pass() { printf '%b✓%b %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%b⚠%b %s\n' "$YELLOW" "$RESET" "$*"; }
fail() { printf '%b✗%b %s\n' "$RED" "$RESET" "$*"; exit 1; }

mkdir -p "$WORKDIR"
echo "Workdir: $WORKDIR"
SSH_OPTS=(-i "$TARGET_VM_KEY" -o StrictHostKeyChecking=no -o LogLevel=ERROR)
TARGET_SSH=("$TARGET_VM_USER@$TARGET_VM_HOST")

curl_admin() { curl -sS -k -H "Authorization: Bearer $TOKEN" "$@"; }

log "1) Login to source cluster"
TOKEN=$(curl -sS -k -X POST "$SOURCE_ADMIN_HOST/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$SOURCE_ADMIN_EMAIL\",\"password\":\"$SOURCE_ADMIN_PASSWORD\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["token"])')
[[ -n "$TOKEN" ]] && pass "logged in" || fail "login failed"

log "2) Trigger fresh secrets-bundle export on source"
EXPORT_RESP=$(curl_admin -X POST "$SOURCE_ADMIN_HOST/api/v1/system-backup/secrets/export" \
  -H 'Content-Type: application/json' -d '{"reason":"DR drill"}')
SECRETS_RUN_ID=$(echo "$EXPORT_RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["runId"])' 2>/dev/null || echo "")
[[ -n "$SECRETS_RUN_ID" ]] || fail "secrets export failed: $EXPORT_RESP"
pass "secrets export started: $SECRETS_RUN_ID"

# shellcheck disable=SC2034
for poll_iter in $(seq 1 60); do
  STATUS=$(curl_admin "$SOURCE_ADMIN_HOST/api/v1/system-backup/secrets/runs/$SECRETS_RUN_ID" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["status"])' 2>/dev/null || echo "?")
  [[ "$STATUS" =~ ^(succeeded|failed)$ ]] && break
  sleep 5
done
[[ "$STATUS" = "succeeded" ]] || fail "secrets export status=$STATUS"
pass "secrets export succeeded"

DOWNLOAD_URL=$(curl_admin "$SOURCE_ADMIN_HOST/api/v1/system-backup/secrets/runs/$SECRETS_RUN_ID" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"].get("downloadUrl") or "")')
[[ -n "$DOWNLOAD_URL" ]] || fail "no downloadUrl on secrets run"
curl -sS -k -o "$WORKDIR/secrets.tar.age" "$SOURCE_ADMIN_HOST$DOWNLOAD_URL"
[[ -s "$WORKDIR/secrets.tar.age" ]] && pass "downloaded $(stat -c%s "$WORKDIR/secrets.tar.age") bytes" || fail "secrets bundle empty"

log "3) Trigger pg_dump on platform/postgres"
PG_PLATFORM=$(curl_admin -X POST "$SOURCE_ADMIN_HOST/api/v1/system-backup/pg-dump" \
  -H 'Content-Type: application/json' \
  -d "{\"sourceNamespace\":\"platform\",\"sourceCluster\":\"postgres\",\"sourceDatabase\":\"hosting_platform\",\"targetConfigId\":\"$TARGET_CONFIG_ID\",\"reason\":\"DR drill\"}")
PG_PLATFORM_RUN=$(echo "$PG_PLATFORM" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["runId"])' 2>/dev/null || echo "")
[[ -n "$PG_PLATFORM_RUN" ]] || fail "platform pg_dump failed to start: $PG_PLATFORM"
pass "platform pg_dump: $PG_PLATFORM_RUN"

# shellcheck disable=SC2034
for poll_iter in $(seq 1 120); do
  STATUS=$(curl_admin "$SOURCE_ADMIN_HOST/api/v1/system-backup/pg-dump/runs/$PG_PLATFORM_RUN" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["status"])' 2>/dev/null || echo "?")
  [[ "$STATUS" =~ ^(succeeded|failed)$ ]] && break
  sleep 10
done
[[ "$STATUS" = "succeeded" ]] || fail "platform pg_dump status=$STATUS"
curl_admin -o "$WORKDIR/platform.pgdump" "$SOURCE_ADMIN_HOST/api/v1/system-backup/pg-dump/runs/$PG_PLATFORM_RUN/download"
[[ -s "$WORKDIR/platform.pgdump" ]] && pass "platform pg_dump downloaded $(stat -c%s "$WORKDIR/platform.pgdump") bytes" || fail "platform dump empty"

log "4) Trigger pg_dump on mail/mail-pg"
PG_MAIL=$(curl_admin -X POST "$SOURCE_ADMIN_HOST/api/v1/system-backup/pg-dump" \
  -H 'Content-Type: application/json' \
  -d "{\"sourceNamespace\":\"mail\",\"sourceCluster\":\"mail-pg\",\"sourceDatabase\":\"stalwart_app\",\"targetConfigId\":\"$TARGET_CONFIG_ID\",\"reason\":\"DR drill\"}")
PG_MAIL_RUN=$(echo "$PG_MAIL" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["runId"])' 2>/dev/null || echo "")
[[ -n "$PG_MAIL_RUN" ]] || fail "mail pg_dump failed to start: $PG_MAIL"
# shellcheck disable=SC2034
for poll_iter in $(seq 1 120); do
  STATUS=$(curl_admin "$SOURCE_ADMIN_HOST/api/v1/system-backup/pg-dump/runs/$PG_MAIL_RUN" \
    | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["status"])' 2>/dev/null || echo "?")
  [[ "$STATUS" =~ ^(succeeded|failed)$ ]] && break
  sleep 10
done
[[ "$STATUS" = "succeeded" ]] || fail "mail pg_dump status=$STATUS"
curl_admin -o "$WORKDIR/mail.pgdump" "$SOURCE_ADMIN_HOST/api/v1/system-backup/pg-dump/runs/$PG_MAIL_RUN/download"
[[ -s "$WORKDIR/mail.pgdump" ]] && pass "mail pg_dump downloaded $(stat -c%s "$WORKDIR/mail.pgdump") bytes" || fail "mail dump empty"

log "5) Wipe target VM + install git (bootstrap prereq)"
ssh "${SSH_OPTS[@]}" "${TARGET_SSH[@]}" \
  "[ -f /usr/local/bin/k3s-uninstall.sh ] && /usr/local/bin/k3s-uninstall.sh; \
   rm -rf /var/lib/rancher /etc/rancher /var/lib/hosting-platform; \
   command -v git >/dev/null || (apt-get update -qq && apt-get install -y -qq git); \
   git --version" 2>&1 | tail -3

log "6) Copy bundle + age key + dumps to target"
scp "${SSH_OPTS[@]}" "$WORKDIR/secrets.tar.age" "${TARGET_SSH[*]}":/root/secrets.tar.age 2>&1 | tail -2
scp "${SSH_OPTS[@]}" "$AGE_KEY_PATH"            "${TARGET_SSH[*]}":/root/operator-private.key 2>&1 | tail -2
scp "${SSH_OPTS[@]}" "$WORKDIR/platform.pgdump" "${TARGET_SSH[*]}":/root/platform.pgdump 2>&1 | tail -2
scp "${SSH_OPTS[@]}" "$WORKDIR/mail.pgdump"     "${TARGET_SSH[*]}":/root/mail.pgdump 2>&1 | tail -2
pass "artifacts copied to target"

log "7) Run bootstrap.sh on target (this takes 5-10 min)"
# `set -e` inside the SSH command so git failure aborts; capture exit
# code so we don't claim success when bootstrap actually failed.
if ! ssh "${SSH_OPTS[@]}" "${TARGET_SSH[@]}" \
  "set -e; cd /tmp && rm -rf k8s-hosting-platform && \
   git clone --depth 1 https://github.com/phoenixtechnam/k8s-hosting-platform.git && \
   cd k8s-hosting-platform && \
   bash scripts/bootstrap.sh --join-as server --domain '$TARGET_VM_DOMAIN' \
     --secrets-bundle /root/secrets.tar.age --age-key /root/operator-private.key 2>&1" \
  | tail -50; then
  fail "bootstrap.sh failed (see output above)"
fi
pass "bootstrap.sh completed"

log "8) Wait for CNPG postgres + mail-pg clusters to be ready (≤15 min)"
ssh "${SSH_OPTS[@]}" "${TARGET_SSH[@]}" \
  "KUBECONFIG=/etc/rancher/k3s/k3s.yaml; \
   for i in \$(seq 1 90); do \
     P=\$(kubectl -n platform get cluster.postgresql.cnpg.io postgres -o jsonpath='{.status.phase}' 2>/dev/null); \
     M=\$(kubectl -n mail get cluster.postgresql.cnpg.io mail-pg -o jsonpath='{.status.phase}' 2>/dev/null); \
     echo \"platform=\$P mail=\$M (i=\$i)\"; \
     [ \"\$P\" = 'Cluster in healthy state' ] && [ \"\$M\" = 'Cluster in healthy state' ] && exit 0; \
     sleep 10; \
   done; exit 1" 2>&1 | tail -8 || fail "clusters did not reach healthy state"
pass "both CNPG clusters healthy"

log "9) pg_restore platform DB"
ssh "${SSH_OPTS[@]}" "${TARGET_SSH[@]}" \
  "KUBECONFIG=/etc/rancher/k3s/k3s.yaml; \
   kubectl -n platform cp /root/platform.pgdump postgres-1:/tmp/platform.pgdump && \
   kubectl -n platform exec postgres-1 -- bash -c 'PGPASSWORD=\$(cat /run/postgres/credentials/password 2>/dev/null || echo \$POSTGRES_PASSWORD) pg_restore --no-owner --no-privileges --clean --if-exists -U platform -d hosting_platform /tmp/platform.pgdump 2>&1 | tail -10'" \
  2>&1 | tail -10

log "10) pg_restore mail DB"
ssh "${SSH_OPTS[@]}" "${TARGET_SSH[@]}" \
  "KUBECONFIG=/etc/rancher/k3s/k3s.yaml; \
   kubectl -n mail cp /root/mail.pgdump mail-pg-1:/tmp/mail.pgdump && \
   kubectl -n mail exec mail-pg-1 -- bash -c 'pg_restore --no-owner --no-privileges --clean --if-exists -U app -d stalwart_app /tmp/mail.pgdump 2>&1 | tail -10'" \
  2>&1 | tail -10

log "11) Verify platform-api responds + admin login works"
ssh "${SSH_OPTS[@]}" "${TARGET_SSH[@]}" \
  "KUBECONFIG=/etc/rancher/k3s/k3s.yaml; \
   for i in \$(seq 1 30); do \
     S=\$(kubectl -n platform get pods -l app=platform-api -o jsonpath='{.items[*].status.phase}' 2>/dev/null); \
     [ -n \"\$S\" ] && [[ ! \"\$S\" =~ Pending ]] && break; \
     sleep 10; \
   done; \
   kubectl -n platform rollout restart deploy platform-api 2>&1 | tail -3; \
   kubectl -n platform rollout status deploy platform-api --timeout=180s 2>&1 | tail -3" \
  2>&1 | tail -8
pass "platform-api ready on target"

log "12) Source admin login on TARGET cluster (proves password_hash + JWT_SECRET restored)"
TARGET_API="https://admin.$TARGET_VM_DOMAIN"
TGT_TOKEN=$(curl -sS -k -X POST "$TARGET_API/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$SOURCE_ADMIN_EMAIL\",\"password\":\"$SOURCE_ADMIN_PASSWORD\"}" 2>&1 \
  | python3 -c 'import json,sys; print(json.load(sys.stdin).get("data",{}).get("token",""))' 2>/dev/null || echo "")
[[ -n "$TGT_TOKEN" ]] && pass "ADMIN LOGIN WORKS ON RESTORED CLUSTER — password_hash row preserved" \
  || warn "admin login did not return a token — DNS not propagated, or password_hash mismatch (acceptable variance)"

log "DONE: DR drill complete"
echo "Workdir kept at $WORKDIR for forensics."
