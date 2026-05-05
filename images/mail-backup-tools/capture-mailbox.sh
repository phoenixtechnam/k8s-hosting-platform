#!/bin/sh
#
# capture-mailbox.sh — IMAP master-user → Maildir → streamed tarball upload.
#
# Argv:
#   $1  ADDR        — mailbox address, e.g. user@example.com
#   $2  UPLOAD_URL  — full HMAC-tokenised upload URL (one mailbox)
#
# Env (required):
#   IMAP_HOST                 — usually stalwart-mail-v016.mail.svc.cluster.local
#   IMAP_PORT                 — 143 (STARTTLS) or 993 (TLS); we default 143
#   STALWART_MASTER_USER      — usually 'master'
#   STALWART_MASTER_PASSWORD  — cleartext master password
#
# Behaviour:
#   1. Write a per-mailbox mbsync config to /tmp/mbsync.cfg.
#   2. mbsync pulls IMAP → /tmp/maildir/ (Maildir++).
#   3. Stream tar | gzip | curl --upload-file -. No intermediate file.
#   4. Compute SHA-256 in the same pipe via tee >(sha256sum) and emit
#      it on stdout for the orchestrator to record.
#
# Failure modes:
#   - mbsync exit ≠ 0 → fatal (mailbox export incomplete).
#   - curl exit ≠ 0   → fatal (artefact not stored).
#
# Storage minimization (Option F): the tarball never lands on disk.
# Peak ephemeral usage ≈ Maildir size only. For mailboxes >10 GiB the
# orchestrator switches to per-folder mode (handled by a different
# script path; not this one).

set -eu

ADDR="${1:-}"
UPLOAD_URL="${2:-}"

if [ -z "$ADDR" ] || [ -z "$UPLOAD_URL" ]; then
  echo "ERROR: usage: capture-mailbox.sh <addr> <upload_url>" >&2
  exit 2
fi

: "${IMAP_HOST:?IMAP_HOST not set}"
# Default to 993 (IMAPS). Stalwart 0.16 disables LOGIN on the
# cleartext port (143) by default, so master-user proxy auth fails
# there regardless of STARTTLS. Operators can override IMAP_PORT=143
# only when targeting a server that allows cleartext LOGIN.
: "${IMAP_PORT:=993}"
: "${STALWART_MASTER_USER:=master}"
: "${STALWART_MASTER_PASSWORD:?STALWART_MASTER_PASSWORD not set}"

MAILDIR="/tmp/maildir"
mkdir -p "$MAILDIR"

# IMAP master-user proxy: authenticate as `<addr>%<master>` with the
# master password — Stalwart treats this as the master user operating
# on the target mailbox. Same pattern Roundcube uses (k8s/base/
# roundcube/jwt_auth.php).
SSO_USER="${ADDR}%${STALWART_MASTER_USER}"

# Build mbsync config. Pass=Cmd reads the password without writing it
# to disk in plaintext; the env var is only readable inside this pod.
#
# AuthMechs LOGIN — Stalwart accepts both LOGIN and PLAIN; PLAIN
# works over STARTTLS or implicit TLS.
#
# TLS handling. The isync 1.4 directive is `SSLType` (not `TLSType`).
# To opt OUT of cert verification (in-cluster self-signed cert),
# we use the Tunnel approach: pipe the IMAP traffic through an
# `openssl s_client` invocation that doesn't require chain validation.
# mbsync sees a plaintext stream over the tunnel, openssl handles TLS.
# Operators wanting strict verification set MBSYNC_TLS_VERIFY=yes,
# which switches to native SSLType + CertificateFile against the alpine
# ca-bundle.
# Build the IMAPAccount stanza line-by-line to avoid blank lines
# inside the section (mbsync treats a blank line as section-end).
{
  echo "IMAPAccount stalwart"
  if [ "${MBSYNC_TLS_VERIFY:-no}" = "yes" ]; then
    echo "Host $IMAP_HOST"
    echo "Port $IMAP_PORT"
    if [ "$IMAP_PORT" = "993" ]; then
      echo "SSLType IMAPS"
    else
      echo "SSLType STARTTLS"
    fi
    echo "CertificateFile /etc/ssl/certs/ca-certificates.crt"
  else
    # Tunnel replaces Host/Port/SSLType. openssl s_client wraps the
    # TLS layer and skips chain validation (the in-cluster cert is
    # self-signed; auth_request still gates the public ingress).
    echo "Tunnel \"openssl s_client -quiet -verify 0 -connect ${IMAP_HOST}:${IMAP_PORT} -servername ${IMAP_HOST} 2>/dev/null\""
  fi
  echo "User $SSO_USER"
  echo "PassCmd \"printenv STALWART_MASTER_PASSWORD\""
  echo "AuthMechs LOGIN"
  echo "PipelineDepth 50"
} > /tmp/mbsync.cfg

cat >> /tmp/mbsync.cfg <<EOF

IMAPStore stalwart-remote
Account stalwart

MaildirStore stalwart-local
Path $MAILDIR/
Inbox $MAILDIR/INBOX
SubFolders Verbatim

Channel mailbox
Far :stalwart-remote:
Near :stalwart-local:
Patterns *
Create Near
Sync Pull
Expunge None
SyncState *
EOF

echo "Capturing $ADDR via mbsync (IMAP $IMAP_HOST:$IMAP_PORT)..." >&2
mbsync -c /tmp/mbsync.cfg mailbox >&2

# Count messages for the result line. find . -type f -path '*/cur/*'
# is Maildir-correct (cur = synced; new = not yet seen).
MSG_COUNT=$(find "$MAILDIR" -type f \( -path "*/cur/*" -o -path "*/new/*" \) | wc -l | tr -d ' ')
echo "MAILDIR_MESSAGES=$MSG_COUNT" >&2

# Option F streaming pipeline.
#
# We need to compute sha256(gzip(tar)) without ever materialising the
# tarball. Bash-style process substitution `tee >(sha256sum)` is NOT
# available in alpine /bin/sh (busybox ash), so we use a FIFO instead:
# sha256sum reads the FIFO in the background while tee duplicates the
# gzip stream to both the FIFO and stdout (which curl uploads). This
# stays POSIX-clean.
SHA_FILE=/tmp/sha.out
SHA_FIFO=/tmp/sha.fifo
rm -f "$SHA_FILE" "$SHA_FIFO"
mkfifo "$SHA_FIFO"
sha256sum < "$SHA_FIFO" > "$SHA_FILE" &
SHA_PID=$!

cd "$MAILDIR"

# `tar -cf - .` over Maildir is safe — Maildir++ filenames are stable
# (UUID + delivery tag + flags suffix), and we just synced so no live
# writer is mutating cur/. Pipe through gzip -1 (best speed/size
# tradeoff for already-binary mail content) and stream upload.
tar -cf - . \
  | gzip -1 \
  | tee "$SHA_FIFO" \
  | curl --fail-with-body -sS \
         -H "Content-Type: application/gzip" \
         --upload-file - \
         "$UPLOAD_URL"

# Wait for the background sha256sum to finish reading. tee closing
# its end of the FIFO terminates sha256sum's read loop.
wait "$SHA_PID"
SHA256=$(awk '{print $1}' "$SHA_FILE")
rm -f "$SHA_FIFO" "$SHA_FILE"
if [ -z "$SHA256" ]; then
  echo "ERROR: sha256 computation failed" >&2
  exit 1
fi
echo "MAILBOX_DONE addr=$ADDR sha256=$SHA256 messages=$MSG_COUNT" >&2

# Stdout: machine-parseable result line for the orchestrator log tail.
echo "RESULT addr=$ADDR sha256=$SHA256 messages=$MSG_COUNT"

# Delete maildir to free emptyDir before next mailbox in the loop.
rm -rf "$MAILDIR"
