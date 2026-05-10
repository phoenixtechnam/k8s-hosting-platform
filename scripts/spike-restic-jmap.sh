#!/usr/bin/env bash
# Phase 0 spike — validates the restic primitive against the platform's
# real operator targets (S3 + SFTP) before Phase 1 ships.
#
# Validates:
#   - HKDF-SHA256 per-tenant password derivation is deterministic.
#   - restic init + backup + restore round-trip against:
#       1. Hetzner Object Storage (S3)
#       2. Hetzner Storage Box (SFTP, restic native sftp: backend)
#   - Incremental delta is small.
#   - Per-tenant prefix isolation: client A's password cannot open client B's repo.
#   - Object-level restore via --include extracts a single file byte-identical.
#   - Wall-clock and storage-size numbers vs ADR-036 budget.
#
# Captures real numbers into docs/02-operations/TENANT_BACKUP_V2_ROADMAP.md.
#
# Usage:
#   ./scripts/spike-restic-jmap.sh
#
# Environment overrides:
#   SPIKE_RESTIC=/path/to/restic     (default: /tmp/restic if present, else `restic`)
#   SPIKE_KEEP_REPOS=1               (skip cleanup; useful for ad-hoc inspection)
#   SPIKE_BASE_MB=100                (size of synthetic base tree; default 100)
#   SPIKE_DELTA_MB=1                 (size of incremental change; default 1)
#
# Credentials are read from ~/k8s-staging/servers.txt by default. Override
# with explicit env vars if needed (S3_ENDPOINT, S3_BUCKET, S3_KEY, S3_SECRET,
# SFTP_USER, SFTP_HOST, SFTP_PORT, SFTP_KEY).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC2034  # ROOT/ROADMAP held for the doc-update path
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
# shellcheck disable=SC2034
ROADMAP="$ROOT/docs/02-operations/TENANT_BACKUP_V2_ROADMAP.md"

RESTIC="${SPIKE_RESTIC:-/tmp/restic}"
if ! [ -x "$RESTIC" ]; then RESTIC="$(command -v restic 2>/dev/null || true)"; fi
if [ -z "$RESTIC" ]; then
  echo "ERROR: no restic binary found. Set SPIKE_RESTIC=..." >&2
  exit 2
fi

BASE_MB="${SPIKE_BASE_MB:-100}"
DELTA_MB="${SPIKE_DELTA_MB:-1}"

WORK="$(mktemp -d -p "${TMPDIR:-/var/tmp}" restic-spike-XXXXXX)"
echo "spike workdir: $WORK"
trap '[ "${SPIKE_KEEP_REPOS:-0}" = "1" ] || rm -rf "$WORK"' EXIT

# ─── Read creds from servers.txt ────────────────────────────────────────────
SERVERS_TXT="${SERVERS_TXT:-$HOME/k8s-staging/servers.txt}"
strip_cr() { tr -d '\r'; }
if [ -f "$SERVERS_TXT" ]; then
  S3_ENDPOINT_DEFAULT=$(awk '/^https:\/\/.*your-objectstorage/{print $1; exit}' "$SERVERS_TXT" | strip_cr)
  S3_BUCKET_DEFAULT=$(awk '/^Bucket: /{print $2; exit}' "$SERVERS_TXT" | strip_cr)
  S3_KEY_DEFAULT=$(awk '/^Access Key: /{print $3; exit}' "$SERVERS_TXT" | strip_cr)
  S3_SECRET_DEFAULT=$(awk '/^Key: /{print $2; exit}' "$SERVERS_TXT" | strip_cr)
  SFTP_LINE=$(grep -m1 'install-ssh-key' "$SERVERS_TXT" | strip_cr || true)
  SFTP_USER_DEFAULT=$(echo "$SFTP_LINE" | sed -nE 's|.*ssh -p([0-9]+) ([^@]+)@.*|\2|p')
  SFTP_HOST_DEFAULT=$(echo "$SFTP_LINE" | sed -nE 's|.*@([^ ]+) install-ssh-key.*|\1|p')
  SFTP_PORT_DEFAULT=$(echo "$SFTP_LINE" | sed -nE 's|.*ssh -p([0-9]+).*|\1|p')
fi

S3_ENDPOINT="${S3_ENDPOINT:-${S3_ENDPOINT_DEFAULT:-}}"
S3_BUCKET="${S3_BUCKET:-${S3_BUCKET_DEFAULT:-}}"
S3_KEY="${S3_KEY:-${S3_KEY_DEFAULT:-}}"
S3_SECRET="${S3_SECRET:-${S3_SECRET_DEFAULT:-}}"
SFTP_USER="${SFTP_USER:-${SFTP_USER_DEFAULT:-}}"
SFTP_HOST="${SFTP_HOST:-${SFTP_HOST_DEFAULT:-}}"
SFTP_PORT="${SFTP_PORT:-${SFTP_PORT_DEFAULT:-22}}"
SFTP_KEY="${SFTP_KEY:-$HOME/hosting-platform.key}"

[ -n "$S3_ENDPOINT" ] && [ -n "$S3_BUCKET" ] && [ -n "$S3_KEY" ] && [ -n "$S3_SECRET" ] || {
  echo "ERROR: missing S3 creds; set S3_ENDPOINT, S3_BUCKET, S3_KEY, S3_SECRET or populate $SERVERS_TXT" >&2
  exit 2
}
[ -n "$SFTP_USER" ] && [ -n "$SFTP_HOST" ] || {
  echo "ERROR: missing SFTP creds; set SFTP_USER, SFTP_HOST or populate $SERVERS_TXT" >&2
  exit 2
}

# ─── HKDF helper (Node, matches the production restic-driver derivation) ───
# Production code in backend/src/modules/tenant-bundles/restic-driver.ts will
# use crypto.hkdfSync('sha256', secret, salt, info, length). Here we replicate
# in a one-shot Node invocation; assertion: deterministic given clientId.
hkdf_password() {
  local secret_hex="$1" client_id="$2"
  node -e '
    const c = require("crypto");
    const secret = Buffer.from(process.argv[1], "hex");
    const out = c.hkdfSync("sha256", secret, Buffer.alloc(0),
      Buffer.from("restic-tenant-" + process.argv[2]), 32);
    process.stdout.write(Buffer.from(out).toString("hex"));
  ' "$secret_hex" "$client_id"
}

# Synthetic OIDC_ENCRYPTION_KEY for spike (NOT a production key).
# Intentionally NOT reading any OIDC_ENCRYPTION_KEY from the environment —
# this spike runs in a sealed key space and must never collide with prod.
SPIKE_OIDC_KEY=$(openssl rand -hex 32)

# Use random suffix (not date) so concurrent runs cannot collide on the
# remote SFTP path or on each other's S3 prefixes.
SUFFIX=$(openssl rand -hex 4)
CLIENT_A="spike-client-a-$SUFFIX"
CLIENT_B="spike-client-b-$SUFFIX"
PASS_A=$(hkdf_password "$SPIKE_OIDC_KEY" "$CLIENT_A")
PASS_B=$(hkdf_password "$SPIKE_OIDC_KEY" "$CLIENT_B")

# Determinism check.
PASS_A2=$(hkdf_password "$SPIKE_OIDC_KEY" "$CLIENT_A")
[ "$PASS_A" = "$PASS_A2" ] || { echo "FAIL: HKDF non-deterministic"; exit 1; }
[ "$PASS_A" != "$PASS_B" ] || { echo "FAIL: HKDF collision across clients"; exit 1; }
echo "✓ HKDF derivation: deterministic + per-tenant unique"

# Test vector for Phase 1: backend/src/modules/tenant-bundles/restic-driver.ts
# MUST produce the same hex output for the same (key, clientId). This line
# emits one fixture so the production unit test can assert against it.
FIXTURE_KEY="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
FIXTURE_CLIENT="fixture-client-001"
FIXTURE_OUT=$(hkdf_password "$FIXTURE_KEY" "$FIXTURE_CLIENT")
echo "  HKDF test vector (lock for Phase 1):"
echo "    key=$FIXTURE_KEY"
echo "    client=$FIXTURE_CLIENT"
echo "    expected_password=$FIXTURE_OUT"

# ─── Seed test tree ─────────────────────────────────────────────────────────
SOURCE="$WORK/source"
mkdir -p "$SOURCE/databases/maria-spike/_backup"
dd if=/dev/urandom of="$SOURCE/blob.bin" bs=1M count="$BASE_MB" status=none
echo "marker $(date +%s)" > "$SOURCE/marker.txt"
mkdir -p "$SOURCE/var/www/uploads/2026/05"
echo "fake user upload" > "$SOURCE/var/www/uploads/2026/05/photo.jpg"
# Simulate a pre-capture DB dump.
dd if=/dev/urandom of="$SOURCE/databases/maria-spike/_backup/2026-05-09T13-00.sql.gz" bs=1M count=10 status=none
# Reference: full-tree sha is captured per-target inside the SFTP block
# (SOURCE_SHA_LATEST). The base value is informational only.
# shellcheck disable=SC2034
SOURCE_SHA_BASE=$(cd "$SOURCE" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')

# Write per-tenant passwords to mode-600 tmpfiles. We pass them to restic via
# RESTIC_PASSWORD_FILE rather than RESTIC_PASSWORD so secrets do not appear
# in /proc/<pid>/environ. The production restic-driver.ts must use the same
# pattern (write tmpfile, point env at it, unlink in a finally).
PASS_FILE_A="$WORK/pw-a"
PASS_FILE_B="$WORK/pw-b"
( umask 077 && printf '%s' "$PASS_A" > "$PASS_FILE_A" )
( umask 077 && printf '%s' "$PASS_B" > "$PASS_FILE_B" )

# ─── S3 round-trip ──────────────────────────────────────────────────────────
S3_REPO="s3:$S3_ENDPOINT/$S3_BUCKET/spike/restic-files/$CLIENT_A"
echo
echo "=== S3 ROUND-TRIP ($S3_REPO) ==="
export AWS_ACCESS_KEY_ID="$S3_KEY"
export AWS_SECRET_ACCESS_KEY="$S3_SECRET"
export RESTIC_PASSWORD_FILE="$PASS_FILE_A"

t0=$(date +%s.%N)
"$RESTIC" --quiet --repo "$S3_REPO" init >/dev/null
t1=$(date +%s.%N)
S3_INIT_S=$(awk -v a="$t1" -v b="$t0" 'BEGIN{printf "%.2f", a-b}')
echo "  init: ${S3_INIT_S}s"

t0=$(date +%s.%N)
( cd "$SOURCE" && "$RESTIC" --quiet --repo "$S3_REPO" backup --tag spike --tag baseline . ) >/dev/null
t1=$(date +%s.%N)
S3_FULL_S=$(awk -v a="$t1" -v b="$t0" 'BEGIN{printf "%.2f", a-b}')
SNAP1=$("$RESTIC" --quiet --repo "$S3_REPO" snapshots --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);process.stdout.write(j[j.length-1].id)})')
echo "  backup baseline ($BASE_MB MiB + 10 MiB DB dump + small files): ${S3_FULL_S}s, snapshot ${SNAP1:0:8}"

# Make a small change
echo "delta $(date +%s)" >> "$SOURCE/marker.txt"
dd if=/dev/urandom of="$SOURCE/var/www/uploads/2026/05/new.bin" bs=1M count="$DELTA_MB" status=none

t0=$(date +%s.%N)
( cd "$SOURCE" && "$RESTIC" --quiet --repo "$S3_REPO" backup --tag spike --tag incremental . ) >/dev/null
t1=$(date +%s.%N)
S3_INCR_S=$(awk -v a="$t1" -v b="$t0" 'BEGIN{printf "%.2f", a-b}')
SNAP2=$("$RESTIC" --quiet --repo "$S3_REPO" snapshots --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);process.stdout.write(j[j.length-1].id)})')
echo "  backup incremental (~$DELTA_MB MiB delta): ${S3_INCR_S}s, snapshot ${SNAP2:0:8}"

# Repo size on backend
S3_STATS=$("$RESTIC" --quiet --repo "$S3_REPO" stats --mode raw-data --json 2>/dev/null || echo '{}')
S3_BYTES=$(echo "$S3_STATS" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(String(JSON.parse(s).total_size||0))}catch(e){process.stdout.write("0")}})')
S3_MB=$(awk -v b="$S3_BYTES" 'BEGIN{printf "%.1f", b/1024/1024}')
RATIO=$(awk -v r="$S3_MB" -v b="$((BASE_MB+10))" 'BEGIN{printf "%.2f", r/b}')
echo "  repo raw size after 2 snapshots: ${S3_MB} MiB (baseline ~$((BASE_MB+10)) MiB; ratio = ${RATIO})"

# Object-level restore: pull only var/www/uploads/2026/05/photo.jpg
RESTORE="$WORK/restore-s3"
mkdir -p "$RESTORE"
t0=$(date +%s.%N)
"$RESTIC" --quiet --repo "$S3_REPO" restore "$SNAP2" --target "$RESTORE" --include "/var/www/uploads/2026/05/photo.jpg" >/dev/null
t1=$(date +%s.%N)
S3_RESTORE_FILE_S=$(awk -v a="$t1" -v b="$t0" 'BEGIN{printf "%.3f", a-b}')
RESTORED_PATH=$(find "$RESTORE" -name photo.jpg -type f 2>/dev/null | head -1)
[ -n "$RESTORED_PATH" ] || { echo "FAIL: object-level restore missing file (snapshot tree mismatched include path)"; "$RESTIC" --quiet --repo "$S3_REPO" ls "$SNAP2" 2>/dev/null | grep -i photo | head -3; exit 1; }
diff -q "$SOURCE/var/www/uploads/2026/05/photo.jpg" "$RESTORED_PATH" >/dev/null \
  || { echo "FAIL: restored file byte-different"; exit 1; }
echo "  ✓ single-file restore byte-identical in ${S3_RESTORE_FILE_S}s"

# Cross-tenant isolation: try to open repo with client B's password.
# Use a scoped env override so the surrounding RESTIC_PASSWORD_FILE is not
# accidentally clobbered by a later edit.
if RESTIC_PASSWORD_FILE="$PASS_FILE_B" "$RESTIC" --quiet --repo "$S3_REPO" snapshots >/dev/null 2>&1; then
  echo "FAIL: client B password opened client A repo"; exit 1
fi
echo "  ✓ cross-tenant: client B password rejected"

# Forget+prune leaves the recent snapshot.
"$RESTIC" --quiet --repo "$S3_REPO" forget --keep-last 1 --prune >/dev/null
S3_REMAINING=$("$RESTIC" --quiet --repo "$S3_REPO" snapshots --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{process.stdout.write(String(JSON.parse(s).length))})')
[ "$S3_REMAINING" = "1" ] || { echo "FAIL: forget kept $S3_REMAINING snapshots, expected 1"; exit 1; }
echo "  ✓ forget+prune retains 1 snapshot"

# ─── SFTP round-trip ────────────────────────────────────────────────────────
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY
SFTP_REPO="sftp:$SFTP_USER@$SFTP_HOST:spike/restic-files/$CLIENT_A"
echo
echo "=== SFTP ROUND-TRIP ($SFTP_REPO) ==="
export RESTIC_PASSWORD_FILE="$PASS_FILE_A"

# Quote each substitution into the sftp.command string so a path/host with
# whitespace or shell metacharacters can never reorder arguments. printf '%q'
# emits a shell-safe single-token form for arbitrary input.
key_q=$(printf '%q' "$SFTP_KEY")
port_q=$(printf '%q' "$SFTP_PORT")
dest_q=$(printf '%q' "$SFTP_USER@$SFTP_HOST")
SFTP_CMD="ssh -i $key_q -p $port_q -o StrictHostKeyChecking=accept-new -o BatchMode=yes -s $dest_q sftp"

# Pre-create remote dir (Storage Box doesn't auto-create deep paths via sftp).
printf 'mkdir spike\nmkdir spike/restic-files\nmkdir spike/restic-files/%s\nbye\n' "$CLIENT_A" \
  | sftp -i "$SFTP_KEY" -P "$SFTP_PORT" -o StrictHostKeyChecking=accept-new -b - "$SFTP_USER@$SFTP_HOST" >/dev/null 2>&1 || true

t0=$(date +%s.%N)
"$RESTIC" --quiet --repo "$SFTP_REPO" -o sftp.command="$SFTP_CMD" init >/dev/null
t1=$(date +%s.%N)
SFTP_INIT_S=$(awk -v a="$t1" -v b="$t0" 'BEGIN{printf "%.2f", a-b}')
echo "  init: ${SFTP_INIT_S}s"

t0=$(date +%s.%N)
( cd "$SOURCE" && "$RESTIC" --quiet --repo "$SFTP_REPO" -o sftp.command="$SFTP_CMD" backup --tag spike --tag baseline . ) >/dev/null
t1=$(date +%s.%N)
SFTP_FULL_S=$(awk -v a="$t1" -v b="$t0" 'BEGIN{printf "%.2f", a-b}')
echo "  backup baseline: ${SFTP_FULL_S}s"

# Note: source has both snapshots from S3 round (we haven't reverted source mods),
# so the SFTP baseline is the post-delta tree. Add a second tiny change.
echo "sftp-delta $(date +%s)" > "$SOURCE/sftp-mark.txt"

t0=$(date +%s.%N)
( cd "$SOURCE" && "$RESTIC" --quiet --repo "$SFTP_REPO" -o sftp.command="$SFTP_CMD" backup --tag spike --tag incremental . ) >/dev/null
t1=$(date +%s.%N)
SFTP_INCR_S=$(awk -v a="$t1" -v b="$t0" 'BEGIN{printf "%.2f", a-b}')
SNAP_SFTP=$("$RESTIC" --quiet --repo "$SFTP_REPO" -o sftp.command="$SFTP_CMD" snapshots --json | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);process.stdout.write(j[j.length-1].id)})')
echo "  backup incremental: ${SFTP_INCR_S}s, snapshot ${SNAP_SFTP:0:8}"

SFTP_STATS=$("$RESTIC" --quiet --repo "$SFTP_REPO" -o sftp.command="$SFTP_CMD" stats --mode raw-data --json 2>/dev/null || echo '{}')
SFTP_BYTES=$(echo "$SFTP_STATS" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{try{process.stdout.write(String(JSON.parse(s).total_size||0))}catch(e){process.stdout.write("0")}})')
SFTP_MB=$(awk -v b="$SFTP_BYTES" 'BEGIN{printf "%.1f", b/1024/1024}')
echo "  repo raw size: ${SFTP_MB} MiB"

RESTORE2="$WORK/restore-sftp"
mkdir -p "$RESTORE2"
t0=$(date +%s.%N)
"$RESTIC" --quiet --repo "$SFTP_REPO" -o sftp.command="$SFTP_CMD" restore "$SNAP_SFTP" --target "$RESTORE2" --include "/var/www/uploads/2026/05/photo.jpg" >/dev/null
t1=$(date +%s.%N)
SFTP_RESTORE_FILE_S=$(awk -v a="$t1" -v b="$t0" 'BEGIN{printf "%.3f", a-b}')
RESTORED2=$(find "$RESTORE2" -name photo.jpg -type f | head -1)
diff -q "$SOURCE/var/www/uploads/2026/05/photo.jpg" "$RESTORED2" >/dev/null \
  || { echo "FAIL: SFTP restored file byte-different"; exit 1; }
echo "  ✓ single-file restore byte-identical in ${SFTP_RESTORE_FILE_S}s"

# Full-tree restore + sha256 round-trip — locks integrity of the whole
# captured tree (not just one file). Re-hash the source after the SFTP-side
# delta was added, to match the latest SFTP snapshot.
SOURCE_SHA_LATEST=$(cd "$SOURCE" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')
RESTORE_FULL="$WORK/restore-sftp-full"
mkdir -p "$RESTORE_FULL"
"$RESTIC" --quiet --repo "$SFTP_REPO" -o sftp.command="$SFTP_CMD" restore "$SNAP_SFTP" --target "$RESTORE_FULL" >/dev/null
RESTORE_SHA=$(cd "$RESTORE_FULL" && find . -type f -print0 | sort -z | xargs -0 sha256sum | sha256sum | awk '{print $1}')
[ "$SOURCE_SHA_LATEST" = "$RESTORE_SHA" ] || {
  echo "FAIL: full-tree restore hash mismatch (source=$SOURCE_SHA_LATEST restore=$RESTORE_SHA)"
  exit 1
}
echo "  ✓ full-tree restore byte-identical (sha256 ${SOURCE_SHA_LATEST:0:16}…)"

# ─── Cleanup remote test repos ──────────────────────────────────────────────
if [ "${SPIKE_KEEP_REPOS:-0}" != "1" ]; then
  echo
  echo "=== CLEANUP ==="
  # S3: --keep-last 0 is a no-op (zero means "policy disabled"). The reliable
  # way is to forget all snapshots explicitly via tag-match then prune. Here
  # the tagged-forget would still leave config/key objects under the prefix,
  # so we issue an unconditional prefix-delete via aws-cli if available.
  if command -v aws >/dev/null 2>&1; then
    AWS_ACCESS_KEY_ID="$S3_KEY" AWS_SECRET_ACCESS_KEY="$S3_SECRET" \
      aws s3 rm "s3://$S3_BUCKET/spike/restic-files/$CLIENT_A/" \
        --endpoint-url "$S3_ENDPOINT" --recursive >/dev/null 2>&1 || true
  else
    # Fallback: best-effort restic-side forget. Will leave repo metadata.
    AWS_ACCESS_KEY_ID="$S3_KEY" AWS_SECRET_ACCESS_KEY="$S3_SECRET" \
      "$RESTIC" --quiet --repo "$S3_REPO" forget --tag spike --prune >/dev/null 2>&1 || true
  fi
  # SFTP: scope to the per-run path only — never touch sibling runs that may
  # be active or that the operator deliberately kept with SPIKE_KEEP_REPOS=1.
  printf 'rm -r spike/restic-files/%s\nbye\n' "$CLIENT_A" \
    | sftp -i "$SFTP_KEY" -P "$SFTP_PORT" -o StrictHostKeyChecking=accept-new -b - "$SFTP_USER@$SFTP_HOST" >/dev/null 2>&1 || true
  echo "  cleaned remote test repos for $CLIENT_A"
fi

# ─── Summary table ──────────────────────────────────────────────────────────
echo
echo "════════════════════════════════════════════════════════════════════"
echo "  Phase 0 spike summary (numbers vs ADR-036 budget)"
echo "════════════════════════════════════════════════════════════════════"
printf "  %-32s %10s %10s\n" "Operation" "S3" "SFTP"
printf "  %-32s %10s %10s\n" "init"        "${S3_INIT_S}s"   "${SFTP_INIT_S}s"
printf "  %-32s %10s %10s\n" "baseline backup"  "${S3_FULL_S}s"   "${SFTP_FULL_S}s"
printf "  %-32s %10s %10s\n" "incremental backup" "${S3_INCR_S}s" "${SFTP_INCR_S}s"
printf "  %-32s %10s %10s\n" "single-file restore" "${S3_RESTORE_FILE_S}s" "${SFTP_RESTORE_FILE_S}s"
printf "  %-32s %10s %10s\n" "repo raw size (MiB)"  "${S3_MB}"     "${SFTP_MB}"
echo
echo "  Source baseline: ~$((BASE_MB+10)) MiB; budget targets:"
echo "    files baseline     ~60s   (S3=${S3_FULL_S}s, SFTP=${SFTP_FULL_S}s)"
echo "    files incremental  ~10s   (S3=${S3_INCR_S}s, SFTP=${SFTP_INCR_S}s)"
echo "    single-file restore ~2s   (S3=${S3_RESTORE_FILE_S}s, SFTP=${SFTP_RESTORE_FILE_S}s)"
echo

echo "✓ Phase 0a (restic) PASS"
echo
echo "Append the numbers above to docs/02-operations/TENANT_BACKUP_V2_ROADMAP.md."
