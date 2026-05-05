#!/usr/bin/env bash
# DinD smoke for the mail-backup-tools image.
#
# Runs locally with docker; no cluster needed. Exercises:
#   1. Image builds clean + size < 50 MiB.
#   2. mbsync, python3, curl, sha256sum all present + version-callable.
#   3. restore-mailbox.py syntax-check + usage check.
#   4. restore-mailbox.py against a real test IMAP server (greenmail):
#       a. seed empty INBOX
#       b. merge-skip-duplicates pass1: appended=N, skipped=0
#       c. merge-skip-duplicates pass2 (idempotency): appended=0, skipped=N
#       d. merge-overwrite pass:    appended=N (server keeps duplicates)
#       e. replace pass:            existing replaced; folder count = N
#
# Capture-mailbox.sh is NOT exercised here because mbsync's master-user
# proxy syntax (`<addr>%<master>`) is Stalwart-specific. Capture is
# validated end-to-end in integration-staging.sh against the real
# Stalwart pod.
#
# Exit codes:
#   0  pass
#   1  any assertion failed
#   2  prereq missing (docker, etc.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
IMAGE_DIR="$REPO_ROOT/images/mail-backup-tools"
TAG="mail-backup-tools-dind:test"

NET="mbtools-dind-net"
GREENMAIL_NAME="mbtools-greenmail"
WORKER_NAME="mbtools-worker"

# Greenmail's user spec: <login>:<password>:<email>. We auth with the
# login id (`alice`), not the email. Greenmail listens on:
#   3025 SMTP    3110 POP3    3143 IMAP    3465 SMTPS    3995 POP3S    3993 IMAPS
IMAP_USER="alice"
IMAP_PASS="alicepass"
IMAP_HOST_IN_NET="greenmail"
IMAP_PORT=3143

cleanup() {
  for c in "$GREENMAIL_NAME" "$WORKER_NAME"; do
    docker rm -f "$c" >/dev/null 2>&1 || true
  done
  docker network rm "$NET" >/dev/null 2>&1 || true
}
trap cleanup EXIT

prereq() {
  command -v docker >/dev/null 2>&1 || { echo "FAIL: docker not on PATH" >&2; exit 2; }
  docker info >/dev/null 2>&1 || { echo "FAIL: docker daemon not reachable" >&2; exit 2; }
}

phase_build() {
  echo "── phase 1: docker build ───────────────────────────────────"
  docker build -t "$TAG" "$IMAGE_DIR"
  local size_bytes size_mib
  size_bytes=$(docker image inspect "$TAG" --format '{{.Size}}')
  size_mib=$((size_bytes / 1024 / 1024))
  echo "image size: ${size_mib} MiB"
  if [ "$size_mib" -gt 50 ]; then
    echo "FAIL: image too large (${size_mib} MiB > 50 MiB budget)" >&2
    return 1
  fi
  echo "OK: image built ($size_mib MiB)"
}

phase_binaries() {
  echo "── phase 2: image binaries present ─────────────────────────"
  docker run --rm "$TAG" sh -c '
    set -e
    mbsync --version | head -1
    python3 --version
    curl --version | head -1
    sha256sum --version 2>&1 | head -1
    tar --version | head -1
  '
  echo "OK: all binaries callable"

  echo "── phase 2b: script syntax ─────────────────────────────────"
  docker run --rm "$TAG" sh -c 'sh -n /usr/local/bin/capture-mailbox.sh' \
    || { echo "FAIL: capture-mailbox.sh syntax error" >&2; return 1; }
  docker run --rm "$TAG" python3 -m py_compile /usr/local/bin/restore-mailbox.py \
    || { echo "FAIL: restore-mailbox.py compile error" >&2; return 1; }
  echo "OK: scripts parse clean"
}

phase_imap_server() {
  echo "── phase 3: start greenmail test IMAP server ───────────────"
  docker network create "$NET" >/dev/null 2>&1 || true
  # greenmail/standalone is an Apache 2 test mail server; ~150MB but
  # we don't push it anywhere. Provides IMAP on :3143 with any-user
  # auth-by-prefix (auto-creates accounts).
  docker run -d --name "$GREENMAIL_NAME" --network "$NET" \
    --network-alias "$IMAP_HOST_IN_NET" \
    -e GREENMAIL_OPTS='-Dgreenmail.setup.test.imap -Dgreenmail.users=alice:alicepass@example.com -Dgreenmail.hostname=0.0.0.0' \
    greenmail/standalone:2.0.1 >/dev/null

  # Wait for IMAP banner via a from-network probe (greenmail container
  # has no shell tooling; we IMAP-noop from another container on the
  # same network).
  local n=0
  until docker run --rm --network "$NET" "$TAG" python3 -c "
import socket, sys
s = socket.socket()
s.settimeout(2)
try:
    s.connect(('${IMAP_HOST_IN_NET}', ${IMAP_PORT}))
    banner = s.recv(64)
    sys.exit(0 if b'OK' in banner else 1)
except Exception:
    sys.exit(1)
" 2>/dev/null; do
    n=$((n + 1))
    [ "$n" -gt 60 ] && { echo "FAIL: greenmail did not come up" >&2; docker logs "$GREENMAIL_NAME" 2>&1 | tail -10 >&2; return 1; }
    sleep 1
  done
  echo "OK: greenmail IMAP up on :3143"
}

# Build a 3-message Maildir fixture on the host to feed restore-mailbox.py.
# Filenames use the canonical Maildir++ shape: <ts>.<unique>:2,<flags>.
make_fixture() {
  local dir="$1"
  rm -rf "$dir"
  mkdir -p "$dir/cur" "$dir/new" "$dir/tmp"
  for i in 1 2 3; do
    local ts; ts=$(date +%s)
    local fname="${dir}/cur/${ts}.M$$P${i}.host,U=${i}:2,S"
    cat > "$fname" <<EOF
From: fixture@dind.test
To: alice@example.com
Subject: fixture-${i}
Message-ID: <fixture-${i}@dind.test>
Date: Mon, 5 May 2026 12:00:0${i} +0000

body ${i}
EOF
  done
}

# Send commands to greenmail IMAP via raw socket from the worker image.
# Plain IMAP4 (no STARTTLS) — greenmail's :3143 is plain.
imap_count_inbox() {
  docker run --rm --network "$NET" "$TAG" python3 -c "
import imaplib
m = imaplib.IMAP4('${IMAP_HOST_IN_NET}', ${IMAP_PORT})
m.login('${IMAP_USER}', '${IMAP_PASS}')
typ, data = m.select('INBOX', readonly=True)
if typ != 'OK': print(0); raise SystemExit
typ, data = m.search(None, 'ALL')
if typ != 'OK' or not data or not data[0]: print(0)
else: print(len(data[0].split()))
m.logout()
"
}

imap_purge_inbox() {
  docker run --rm --network "$NET" "$TAG" python3 -c "
import imaplib
m = imaplib.IMAP4('${IMAP_HOST_IN_NET}', ${IMAP_PORT})
m.login('${IMAP_USER}', '${IMAP_PASS}')
m.select('INBOX')
typ, data = m.search(None, 'ALL')
if typ == 'OK' and data and data[0]:
    for uid in data[0].split():
        m.store(uid, '+FLAGS', '\\\\Deleted')
    m.expunge()
m.logout()
" 2>/dev/null || true
}

run_restore() {
  # The Unraid harness host runs inside DinD — host bind mounts don't
  # propagate to child containers. Use docker cp to seed /maildir
  # inside a long-running worker, then exec the script.
  local mode="$1" fixture="$2"
  local cname="mbtools-restore-$$-$RANDOM"
  docker run -d --name "$cname" --network "$NET" \
    -e ALLOW_PLAINTEXT_IMAP=yes \
    --entrypoint sh "$TAG" -c 'sleep 120' >/dev/null
  docker exec "$cname" mkdir -p /maildir
  docker cp "$fixture/." "$cname:/maildir/"
  local rc=0
  docker exec "$cname" \
    python3 /usr/local/bin/restore-mailbox.py \
      "$IMAP_HOST_IN_NET" "$IMAP_PORT" "$IMAP_USER" "$IMAP_PASS" \
      "$mode" "/maildir" || rc=$?
  docker rm -f "$cname" >/dev/null
  return $rc
}

phase_restore_modes() {
  echo "── phase 4: restore-mailbox.py modes ───────────────────────"
  local fixture="/tmp/mbtools-fixture-$$"
  make_fixture "$fixture"

  # ── 4a: merge-skip pass1 — empty INBOX → 3 appended
  imap_purge_inbox
  local before
  before=$(imap_count_inbox)
  echo "INBOX before: $before"
  local out
  out=$(run_restore merge-skip-duplicates "$fixture")
  echo "$out"
  local after
  after=$(imap_count_inbox)
  if [ "$after" -ne 3 ]; then
    echo "FAIL: merge-skip pass1 expected 3 messages, got $after" >&2
    return 1
  fi
  echo "OK: merge-skip pass1 → 3 messages"

  # ── 4b: merge-skip pass2 — idempotency, INBOX still 3
  out=$(run_restore merge-skip-duplicates "$fixture")
  echo "$out"
  echo "$out" | grep -q 'appended=0 skipped=3' || {
    echo "FAIL: merge-skip pass2 did not report appended=0 skipped=3" >&2
    return 1
  }
  local after2
  after2=$(imap_count_inbox)
  if [ "$after2" -ne 3 ]; then
    echo "FAIL: merge-skip pass2 inflated INBOX to $after2 (expected 3)" >&2
    return 1
  fi
  echo "OK: merge-skip pass2 idempotent (still 3)"

  # ── 4c: merge-overwrite — appends regardless of dedup
  imap_purge_inbox
  run_restore merge-skip-duplicates "$fixture" >/dev/null   # seed 3
  out=$(run_restore merge-overwrite "$fixture")
  echo "$out"
  echo "$out" | grep -q 'appended=3 skipped=0' || {
    echo "FAIL: merge-overwrite did not report appended=3 skipped=0" >&2
    return 1
  }
  local after3
  after3=$(imap_count_inbox)
  if [ "$after3" -ne 6 ]; then
    echo "FAIL: merge-overwrite expected 6 messages, got $after3" >&2
    return 1
  fi
  echo "OK: merge-overwrite → 6 messages (3 originals + 3 dupes)"

  # ── 4d: replace — wipes existing then restores
  out=$(run_restore replace "$fixture")
  echo "$out"
  echo "$out" | grep -q 'appended=3' || {
    echo "FAIL: replace did not report appended=3" >&2
    return 1
  }
  local after4
  after4=$(imap_count_inbox)
  if [ "$after4" -ne 3 ]; then
    echo "FAIL: replace expected 3 messages, got $after4" >&2
    return 1
  fi
  echo "OK: replace → 3 messages (existing wiped)"

  rm -rf "$fixture"
}

main() {
  prereq
  phase_build
  phase_binaries
  phase_imap_server
  phase_restore_modes
  echo
  echo "✔ all phases passed"
}

main "$@"
