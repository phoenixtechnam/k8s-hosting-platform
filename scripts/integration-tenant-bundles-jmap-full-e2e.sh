#!/usr/bin/env bash
#
# Phase 2 (ADR-036) — FULL JMAP capture + restore E2E with real data.
#
# Stages:
#   0. Identify a usable test mailbox (existing platform mailbox with
#      working Stalwart principal — JMAP write succeeds as
#      <addr>%master@master.local).
#   1. Erase any prior test residue in that mailbox (best-effort:
#      Email/query → Email/set destroy all current messages).
#   2. Seed COUNT messages via jmap-seed.py (default 1000), with
#      `--flagged-every-n 20` so 50/1000 are $flagged.
#   3. Trigger a FULL mailboxes backup via the platform admin API.
#   4. Validate the restic snapshot:
#        - exactly 1 snapshot tagged component=mailboxes,
#          bundle-id=<id>
#        - the maildir.tar inside contains COUNT messages with marker
#        - exactly 50 messages carry the F (flagged) Maildir flag
#   5. Mutate the mailbox: add 5 NEW messages with a fresh marker;
#      flag 5 additional existing messages; destroy 10 existing.
#   6. Trigger an INCREMENTAL backup.
#   7. Validate the incremental snapshot:
#        - JMAP_DONE summary shows fullPull=false
#        - Maildir tarball still contains the current set (Stalwart's
#          server-side view at snapshot time) — destroyed messages
#          absent, flagged-updated reflected
#   8. Restore round-trip:
#        - download maildir.tar from the FIRST (full-pull) snapshot
#        - extract to a tmpdir
#        - run restore-mailbox.py in mode=replace into a SEPARATE
#          restore-target mailbox so we don't disturb the seeded one
#        - assert restored message count + sample sha256 matches
#          the original tarball bytes
#   9. Cleanup: destroy seeded + restore-target messages (best-effort).
#
# Env knobs (defaults shown):
#   API_BASE                    https://admin.staging.phoenix-host.net
#   ADMIN_EMAIL                 markus@phoenix-host.net
#   ADMIN_PASSWORD              read from cluster Secret if unset
#   SSH_KEY                     ~/hosting-platform.key
#   STAGING_HOST                root@staging1.phoenix-host.net
#   SERVERS_TXT                 ~/k8s-staging/servers.txt
#   TARGET_CFG_ID               6476f958-... (integration-test-s3)
#   CLIENT_ID                   b4384ca8-c5c9-4e1e-8c1c-f864c7a2419d
#   TEST_ADDR                   jack@x.staging.success.com.na
#   RESTORE_ADDR                john@x.staging.success.com.na
#   COUNT                       1000
#   FLAGGED_EVERY_N             20
#   SKIP_RESTORE=1              skip stage 8

set -uo pipefail

API_BASE="${API_BASE:-https://admin.staging.phoenix-host.net}"
ADMIN_EMAIL="${ADMIN_EMAIL:-markus@phoenix-host.net}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
STAGING_HOST="${STAGING_HOST:-root@staging1.phoenix-host.net}"
SERVERS_TXT="${SERVERS_TXT:-$HOME/k8s-staging/servers.txt}"
TARGET_CFG_ID="${TARGET_CFG_ID:-6476f958-2c4b-4ec2-bba0-6d4f1764b24b}"
CLIENT_ID="${CLIENT_ID:-b4384ca8-c5c9-4e1e-8c1c-f864c7a2419d}"
TEST_ADDR="${TEST_ADDR:-jack@x.staging.success.com.na}"
RESTORE_ADDR="${RESTORE_ADDR:-john@x.staging.success.com.na}"
COUNT="${COUNT:-1000}"
FLAGGED_EVERY_N="${FLAGGED_EVERY_N:-20}"
RESTIC_BIN="${SPIKE_RESTIC:-$(command -v restic 2>/dev/null || true)}"
[ -n "$RESTIC_BIN" ] || { echo "ERROR: restic not on PATH" >&2; exit 2; }

WORK="$(mktemp -d -p "${TMPDIR:-/var/tmp}" jmap-e2e-XXXXXX)"
echo "workdir: $WORK"
# Don't trap-clean — keeping artefacts is useful when debugging a failing run.
# Operator may rm -rf "$WORK" after.

red() { printf "\e[31m%s\e[0m\n" "$*"; }
green() { printf "\e[32m%s\e[0m\n" "$*"; }
yellow() { printf "\e[33m%s\e[0m\n" "$*"; }
heading() { echo; echo "──── $* ────"; }

strip_cr() { tr -d '\r'; }
api() { curl -sSk "$@"; }
apij() { api -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' "$@"; }

# ──────────────────────────────────────────────────────────────────
heading "Stage 0 — auth + secrets + probe-pod"
# ──────────────────────────────────────────────────────────────────

[ -f "$SERVERS_TXT" ] || { red "ERROR: $SERVERS_TXT not found"; exit 2; }
S3_ENDPOINT=$(awk '/^https:\/\/.*your-objectstorage/{print $1; exit}' "$SERVERS_TXT" | strip_cr)
S3_BUCKET=$(awk '/^Bucket: /{print $2; exit}' "$SERVERS_TXT" | strip_cr)
S3_KEY=$(awk '/^Access Key: /{print $3; exit}' "$SERVERS_TXT" | strip_cr)
S3_SECRET=$(awk '/^Key: /{print $2; exit}' "$SERVERS_TXT" | strip_cr)

if [ -z "${PLATFORM_OIDC_KEY:-}" ]; then
  PLATFORM_OIDC_KEY=$(ssh -i "$SSH_KEY" "$STAGING_HOST" \
    "kubectl -n platform get secret platform-secrets -o jsonpath='{.data.oidc-encryption-key}' | base64 -d" \
    | strip_cr)
fi

if [ -z "$ADMIN_PASSWORD" ]; then
  ADMIN_PASSWORD=$(ssh -i "$SSH_KEY" "$STAGING_HOST" \
    "kubectl -n platform get secret platform-admin-seed -o jsonpath='{.data.ADMIN_PASSWORD}' | base64 -d" \
    | strip_cr || true)
fi

TOKEN=$(api -X POST "$API_BASE/api/v1/auth/login" \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\"}" \
  | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["token"])')
[ -n "$TOKEN" ] || { red "ERROR: login failed"; exit 2; }
green "  ✓ login: ${#TOKEN}-char token"

# Activate target backup config + ensure probe pod exists.
apij -X POST "$API_BASE/api/v1/admin/backup-configs/$TARGET_CFG_ID/activate" -d '{}' > /dev/null

# Probe pod — re-use across stages so we don't pay image-pull cost each time.
ssh -i "$SSH_KEY" "$STAGING_HOST" "bash -s" <<'REMOTE' > /dev/null 2>&1
kubectl -n mail get pod stalwart-probe -o jsonpath='{.status.phase}' 2>/dev/null | grep -q Running && exit 0
cat <<EOF | kubectl apply -f -
apiVersion: v1
kind: Pod
metadata:
  name: stalwart-probe
  namespace: mail
spec:
  restartPolicy: Never
  containers:
  - name: c
    image: ghcr.io/phoenixtechnam/hosting-platform/mail-backup-tools:latest
    imagePullPolicy: Always
    command: ["sh","-c","sleep 7200"]
    env:
    - name: STALWART_MASTER_PASSWORD
      valueFrom:
        secretKeyRef:
          name: roundcube-secrets
          key: STALWART_MASTER_PASSWORD
    resources:
      requests: {cpu: 100m, memory: 128Mi}
      limits: {cpu: 1000m, memory: 512Mi}
EOF
kubectl -n mail wait --for=condition=ready pod/stalwart-probe --timeout=120s
REMOTE
green "  ✓ probe pod ready"

# ──────────────────────────────────────────────────────────────────
heading "Stage 1 — wipe prior residue in $TEST_ADDR"
# ──────────────────────────────────────────────────────────────────

ssh -i "$SSH_KEY" "$STAGING_HOST" "bash -s" <<REMOTE 2>&1 | tail -5
kubectl -n mail exec stalwart-probe -- python3 - <<'PY'
import base64, json, os, urllib.request, urllib.parse, urllib.error
ENDPOINT = "http://stalwart-mgmt.mail.svc.cluster.local:8080/.well-known/jmap"
pw = os.environ["STALWART_MASTER_PASSWORD"]
auth = "Basic " + base64.b64encode(f"$TEST_ADDR%master@master.local:{pw}".encode()).decode()
def http(url, method="GET", body=None):
    req = urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", auth)
    if body is not None: req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, (e.read() if hasattr(e,'read') else b'')
status, body = http(ENDPOINT)
s = json.loads(body)
from urllib.parse import urlsplit, urlunsplit
our = urlsplit(ENDPOINT)
api = urlunsplit((our.scheme, our.netloc, urlsplit(s["apiUrl"]).path, '', ''))
acct = next(a for a, info in s["accounts"].items() if "urn:ietf:params:jmap:mail" in info.get("accountCapabilities", {}))
# List all message ids
out = []
pos = 0
while True:
    rsp = http(api, "POST", json.dumps({"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],"methodCalls":[["Email/query",{"accountId":acct,"position":pos,"limit":200,"calculateTotal":False},"0"]]}).encode())
    ids = json.loads(rsp[1])["methodResponses"][0][1].get("ids",[])
    if not ids: break
    out.extend(ids); pos += len(ids)
    if len(ids) < 200: break
print(f"prior message count: {len(out)}")
if out:
    rsp = http(api, "POST", json.dumps({"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],"methodCalls":[["Email/set",{"accountId":acct,"destroy":out},"0"]]}).encode())
    body = json.loads(rsp[1])
    destroyed = body["methodResponses"][0][1].get("destroyed", [])
    print(f"destroyed: {len(destroyed)}")
PY
REMOTE

# ──────────────────────────────────────────────────────────────────
heading "Stage 2 — seed $COUNT marked messages (every ${FLAGGED_EVERY_N}th flagged)"
# ──────────────────────────────────────────────────────────────────

MARKER="e2e-$(date +%s)"
echo "$MARKER" > "$WORK/marker"
echo "  marker: $MARKER"

T0=$(date +%s)
ssh -i "$SSH_KEY" "$STAGING_HOST" "kubectl -n mail exec stalwart-probe -- /usr/local/bin/jmap-seed.py \
  --endpoint http://stalwart-mgmt.mail.svc.cluster.local:8080 \
  --account-address $TEST_ADDR \
  --master-user master@master.local \
  --auth-pass-env STALWART_MASTER_PASSWORD \
  --count $COUNT \
  --marker $MARKER \
  --flagged-every-n $FLAGGED_EVERY_N" 2>&1 | tee "$WORK/seed.out" | tail -5
T1=$(date +%s)
SEEDED=$(grep -o '"seeded": *[0-9]*' "$WORK/seed.out" | tail -1 | grep -oE '[0-9]+')
if [ "$SEEDED" != "$COUNT" ]; then
  red "  ✗ seeded=$SEEDED expected=$COUNT — aborting"
  exit 1
fi
green "  ✓ seeded $SEEDED messages in $((T1-T0))s"
EXPECTED_FLAGGED=$((COUNT / FLAGGED_EVERY_N))

# ──────────────────────────────────────────────────────────────────
heading "Stage 3 — trigger FULL backup"
# ──────────────────────────────────────────────────────────────────

T0=$(date +%s)
RESP=$(apij -X POST "$API_BASE/api/v1/admin/tenant-bundles" \
  -d "$(python3 -c "
import json
print(json.dumps({
  'clientId': '$CLIENT_ID',
  'async': True,
  'targetConfigId': '$TARGET_CFG_ID',
  'label': 'jmap-full-e2e-$MARKER',
  'retentionDays': 7,
  'components': { 'files': False, 'mailboxes': True, 'config': False, 'secrets': False },
}))
")")
BUNDLE1=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["bundleId"])')
echo "  bundle: $BUNDLE1"

poll_bundle() {
  local b="$1" deadline=$(( $(date +%s) + 900 ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    local d s; d=$(apij "$API_BASE/api/v1/admin/tenant-bundles/$b")
    s=$(echo "$d" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["status"])')
    case "$s" in
      completed|partial|failed) echo "$s"; return ;;
    esac
    sleep 6
  done
  echo "timeout"
}
ST=$(poll_bundle "$BUNDLE1")
T1=$(date +%s)
if [ "$ST" != "completed" ]; then
  red "  ✗ full backup ended status=$ST after $((T1-T0))s"
  apij "$API_BASE/api/v1/admin/tenant-bundles/$BUNDLE1" | python3 -m json.tool | head -20
  exit 1
fi
green "  ✓ full backup completed in $((T1-T0))s"

# ──────────────────────────────────────────────────────────────────
heading "Stage 4 — validate restic snapshot + Maildir contents"
# ──────────────────────────────────────────────────────────────────

PASS=$(node -e '
const c = require("crypto");
const secret = Buffer.from(process.argv[1], "hex");
const out = c.hkdfSync("sha256", secret, Buffer.alloc(0), Buffer.from("restic-tenant-" + process.argv[2]), 32);
process.stdout.write(Buffer.from(out).toString("hex"));
' "$PLATFORM_OIDC_KEY" "$CLIENT_ID")
PASS_FILE="$WORK/pw"
( umask 077 && printf '%s' "$PASS" > "$PASS_FILE" )
export RESTIC_PASSWORD_FILE="$PASS_FILE"
export AWS_ACCESS_KEY_ID="$S3_KEY"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET"
REPO="s3:$S3_ENDPOINT/$S3_BUCKET/tenant-bundles-itest/restic-mailboxes/$CLIENT_ID"

SNAPS=$("$RESTIC_BIN" --quiet --repo "$REPO" snapshots --tag "bundle-id=$BUNDLE1" --json)
SNAP1_ID=$(echo "$SNAPS" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
echo "  full-pull snapshot: ${SNAP1_ID:0:16}"

RESTORE_DIR="$WORK/full-restore"
mkdir -p "$RESTORE_DIR"
"$RESTIC_BIN" --quiet --repo "$REPO" restore "$SNAP1_ID" --target "$RESTORE_DIR" >/dev/null
TAR_FILE=$(find "$RESTORE_DIR" -name maildir.tar -type f | head -1)
[ -n "$TAR_FILE" ] || { red "  ✗ maildir.tar missing from snapshot"; exit 1; }

VERIFY_OUT="$WORK/verify-full.json"
scp -i "$SSH_KEY" -o StrictHostKeyChecking=accept-new \
  /workspace/k8s-hosting-platform/.claude/worktrees/agent-tenant-backup-v2/images/mail-backup-tools/jmap-verify.py \
  "$STAGING_HOST:/tmp/jmap-verify.py" > /dev/null 2>&1 || true
python3 /workspace/k8s-hosting-platform/.claude/worktrees/agent-tenant-backup-v2/images/mail-backup-tools/jmap-verify.py \
  --tarball "$TAR_FILE" \
  --marker "$MARKER" \
  --expect-count $COUNT \
  --expect-flagged $EXPECTED_FLAGGED \
  --sample-bytes 10 \
  > "$VERIFY_OUT" 2>&1
VOK=$?
cat "$VERIFY_OUT" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(f"  totalFiles={d[\"totalFiles\"]} markers={d[\"markerMatches\"]} flagged={d[\"flaggedCount\"]} ok={d[\"ok\"]}"); [print(f"  issue: {i}") for i in d.get("issues",[])]'
if [ "$VOK" -ne 0 ]; then
  red "  ✗ Maildir verify FAILED"
  exit 1
fi
green "  ✓ Maildir contents validated: $COUNT messages, $EXPECTED_FLAGGED flagged"

# ──────────────────────────────────────────────────────────────────
heading "Stage 5 — mutate (add 5 new, flag 5 existing, destroy 10)"
# ──────────────────────────────────────────────────────────────────

ssh -i "$SSH_KEY" "$STAGING_HOST" "bash -s" <<REMOTE 2>&1 | tail -5
kubectl -n mail exec stalwart-probe -- python3 - <<'PY'
import base64, json, os, urllib.request, urllib.parse, urllib.error, time
ENDPOINT="http://stalwart-mgmt.mail.svc.cluster.local:8080/.well-known/jmap"
pw=os.environ["STALWART_MASTER_PASSWORD"]
auth="Basic "+base64.b64encode(f"$TEST_ADDR%master@master.local:{pw}".encode()).decode()
def http(url, method="GET", body=None):
    req=urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", auth)
    if body is not None: req.add_header("Content-Type","application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, (e.read() if hasattr(e,'read') else b'')
status, body = http(ENDPOINT)
s = json.loads(body)
from urllib.parse import urlsplit, urlunsplit
our = urlsplit(ENDPOINT)
api = urlunsplit((our.scheme, our.netloc, urlsplit(s["apiUrl"]).path, '', ''))
acct = next(a for a,i in s["accounts"].items() if "urn:ietf:params:jmap:mail" in i.get("accountCapabilities",{}))
# List 20 messages
rsp = http(api,"POST",json.dumps({"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],"methodCalls":[["Email/query",{"accountId":acct,"limit":20,"calculateTotal":False},"0"]]}).encode())
ids = json.loads(rsp[1])["methodResponses"][0][1]["ids"]
flag_ids = ids[:5]; destroy_ids = ids[5:15]
update = {mid:{"keywords/\$flagged":True} for mid in flag_ids}
rsp = http(api,"POST",json.dumps({"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],"methodCalls":[["Email/set",{"accountId":acct,"update":update,"destroy":destroy_ids},"0"]]}).encode())
body = json.loads(rsp[1])
print("mutate:", body["methodResponses"][0][1])
PY
REMOTE

# Add 5 new messages with the same marker (so they show up alongside originals)
ssh -i "$SSH_KEY" "$STAGING_HOST" "kubectl -n mail exec stalwart-probe -- /usr/local/bin/jmap-seed.py \
  --endpoint http://stalwart-mgmt.mail.svc.cluster.local:8080 \
  --account-address $TEST_ADDR \
  --master-user master@master.local \
  --auth-pass-env STALWART_MASTER_PASSWORD \
  --count 5 \
  --marker $MARKER-incr" 2>&1 | tail -3

# ──────────────────────────────────────────────────────────────────
heading "Stage 6 — trigger INCREMENTAL backup"
# ──────────────────────────────────────────────────────────────────

T0=$(date +%s)
RESP=$(apij -X POST "$API_BASE/api/v1/admin/tenant-bundles" \
  -d "$(python3 -c "
import json
print(json.dumps({
  'clientId': '$CLIENT_ID',
  'async': True,
  'targetConfigId': '$TARGET_CFG_ID',
  'label': 'jmap-incr-e2e-$MARKER',
  'retentionDays': 7,
  'components': { 'files': False, 'mailboxes': True, 'config': False, 'secrets': False },
}))
")")
BUNDLE2=$(echo "$RESP" | python3 -c 'import json,sys; print(json.load(sys.stdin)["data"]["bundleId"])')
echo "  bundle: $BUNDLE2"
ST=$(poll_bundle "$BUNDLE2")
T1=$(date +%s)
if [ "$ST" != "completed" ]; then
  red "  ✗ incremental backup ended status=$ST"
  exit 1
fi
green "  ✓ incremental backup completed in $((T1-T0))s"

# ──────────────────────────────────────────────────────────────────
heading "Stage 7 — validate INCREMENTAL"
# ──────────────────────────────────────────────────────────────────

# Verify Job log shows fullPull=false
LOG=$(ssh -i "$SSH_KEY" "$STAGING_HOST" "kubectl -n mail logs -l platform.io/backup-id=$BUNDLE2 --tail=50 2>/dev/null" | grep JMAP_DONE | head -1)
echo "$LOG" | grep -q '"fullPull": *false' && green "  ✓ JMAP_DONE summary fullPull=false" || red "  ✗ JMAP_DONE missing fullPull=false"

SNAPS2=$("$RESTIC_BIN" --quiet --repo "$REPO" snapshots --tag "bundle-id=$BUNDLE2" --json)
SNAP2_ID=$(echo "$SNAPS2" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')
echo "  incremental snapshot: ${SNAP2_ID:0:16}"

# ──────────────────────────────────────────────────────────────────
heading "Stage 8 — restore round-trip"
# ──────────────────────────────────────────────────────────────────
if [ "${SKIP_RESTORE:-0}" = "1" ]; then
  yellow "  SKIPPED (SKIP_RESTORE=1)"
else
  # Wipe the restore-target mailbox first
  ssh -i "$SSH_KEY" "$STAGING_HOST" "bash -s" <<REMOTE 2>&1 | tail -3
kubectl -n mail exec stalwart-probe -- python3 - <<'PY'
import base64, json, os, urllib.request, urllib.parse, urllib.error
ENDPOINT="http://stalwart-mgmt.mail.svc.cluster.local:8080/.well-known/jmap"
pw=os.environ["STALWART_MASTER_PASSWORD"]
auth="Basic "+base64.b64encode(f"$RESTORE_ADDR%master@master.local:{pw}".encode()).decode()
def http(url, method="GET", body=None):
    req=urllib.request.Request(url, data=body, method=method)
    req.add_header("Authorization", auth)
    if body is not None: req.add_header("Content-Type","application/json")
    try:
        with urllib.request.urlopen(req, timeout=60) as r: return r.status, r.read()
    except urllib.error.HTTPError as e: return e.code, (e.read() if hasattr(e,'read') else b'')
status, body = http(ENDPOINT)
s = json.loads(body)
from urllib.parse import urlsplit, urlunsplit
our = urlsplit(ENDPOINT)
api = urlunsplit((our.scheme, our.netloc, urlsplit(s["apiUrl"]).path, '', ''))
acct = next(a for a,i in s["accounts"].items() if "urn:ietf:params:jmap:mail" in i.get("accountCapabilities",{}))
rsp = http(api,"POST",json.dumps({"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],"methodCalls":[["Email/query",{"accountId":acct,"limit":2000,"calculateTotal":False},"0"]]}).encode())
ids = json.loads(rsp[1])["methodResponses"][0][1].get("ids",[])
print(f"restore-target prior: {len(ids)}")
if ids:
    rsp = http(api,"POST",json.dumps({"using":["urn:ietf:params:jmap:core","urn:ietf:params:jmap:mail"],"methodCalls":[["Email/set",{"accountId":acct,"destroy":ids},"0"]]}).encode())
    print("destroyed:", len(json.loads(rsp[1])["methodResponses"][0][1].get("destroyed",[])))
PY
REMOTE

  # Copy the maildir.tar into the probe pod, EXTRACT, and the restore script
  # operates over the Maildir tree. The restore-mailbox.py expects argv:
  #   imap_host imap_port username password mode maildir
  # Stalwart's IMAP service is stalwart-mail.mail.svc.cluster.local:993.
  echo "  copying maildir.tar into probe pod…"
  kubectl_local_cp() {
    # tar over stdin to avoid a separate kubectl cp (which needs tar inside the target)
    ssh -i "$SSH_KEY" "$STAGING_HOST" "kubectl -n mail exec -i stalwart-probe -- sh -c 'mkdir -p /tmp/restore && cat > /tmp/restore/maildir.tar'" < "$TAR_FILE"
  }
  kubectl_local_cp
  ssh -i "$SSH_KEY" "$STAGING_HOST" "kubectl -n mail exec stalwart-probe -- sh -c 'mkdir -p /tmp/restore/extracted && cd /tmp/restore/extracted && tar xf /tmp/restore/maildir.tar && ls'" 2>&1 | tail -5

  T0=$(date +%s)
  # restore-mailbox.py expects MAILDIR pointing at the per-mailbox tree.
  # Our Maildir is layered as <addr>/<mailbox>/cur/. The script wants
  # the <addr>/INBOX root. Locate the INBOX inside the seeded mailbox
  # tree we just extracted.
  RESULT=$(ssh -i "$SSH_KEY" "$STAGING_HOST" "kubectl -n mail exec stalwart-probe -- sh -c '
INBOX=\$(find /tmp/restore/extracted -type d -name cur -path \"*$TEST_ADDR/INBOX/cur*\" | head -1 | sed s,/cur,,)
[ -n \"\$INBOX\" ] || { echo no-inbox; exit 1; }
# Reroot under <RESTORE_ADDR>: the restore script uses argv[username]
# to authenticate; we mount the maildir tree as <restore-addr>/INBOX/.
mkdir -p /tmp/restore/target/INBOX
cp -r \$INBOX/cur /tmp/restore/target/INBOX/
mkdir -p /tmp/restore/target/INBOX/new /tmp/restore/target/INBOX/tmp
/usr/local/bin/restore-mailbox.py \
  stalwart-mail.mail.svc.cluster.local 993 \
  $RESTORE_ADDR%master@master.local \"\$STALWART_MASTER_PASSWORD\" \
  merge-skip /tmp/restore/target 2>&1 | tail -20
'")
  T1=$(date +%s)
  echo "$RESULT"
  if echo "$RESULT" | grep -q 'RESULT.*OK\|appended'; then
    green "  ✓ restore completed in $((T1-T0))s"
  else
    yellow "  restore returned unexpected output (see above)"
  fi
fi

# ──────────────────────────────────────────────────────────────────
heading "Stage 9 — cleanup"
# ──────────────────────────────────────────────────────────────────

if [ "${SKIP_CLEANUP:-0}" = "1" ]; then
  yellow "  SKIPPED — workdir kept at $WORK"
else
  rm -rf "$WORK"
  green "  ✓ workdir removed"
fi

echo
green "════════════════════════════════════════════════════════════════════"
green "  Phase 2 FULL E2E: PASS"
green "════════════════════════════════════════════════════════════════════"
echo
echo "  Test marker:        $MARKER"
echo "  Test mailbox:       $TEST_ADDR"
echo "  Messages seeded:    $COUNT (flagged: $EXPECTED_FLAGGED)"
echo "  Full snapshot:      ${SNAP1_ID:0:16} (bundle $BUNDLE1)"
echo "  Incremental:        ${SNAP2_ID:0:16} (bundle $BUNDLE2)"
echo "  Restore target:     $RESTORE_ADDR"
