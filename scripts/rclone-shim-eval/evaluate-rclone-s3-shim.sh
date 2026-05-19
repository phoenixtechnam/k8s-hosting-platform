#!/usr/bin/env bash
# scripts/rclone-shim-eval/evaluate-rclone-s3-shim.sh
#
# Driver script: syncs the harness to testing.phoenix-host.net, runs the
# evaluation there, and downloads the resulting markdown report.
#
# Credentials are read from ~/k8s-staging/servers.txt -- the file is the
# source of truth (see memory project_staging_servers_reference).
#
# Usage:
#   ./scripts/rclone-shim-eval/evaluate-rclone-s3-shim.sh           # full run
#   ./scripts/rclone-shim-eval/evaluate-rclone-s3-shim.sh --smoke   # fast smoke
#   ./scripts/rclone-shim-eval/evaluate-rclone-s3-shim.sh --report-only
#       # don't re-run scenarios; just re-aggregate existing JSONL
#
# Output:
#   docs/04-deployment/RCLONE_SHIM_EVALUATION.md   (committed)

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
SERVERS_FILE="${SERVERS_FILE:-$HOME/k8s-staging/servers.txt}"
SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
HOST="${TESTING_HOST:-testing.phoenix-host.net}"
REMOTE_USER="${REMOTE_USER:-root}"
REMOTE_DIR="${REMOTE_DIR:-/root/rclone-shim-eval}"
REPORT_OUT="$REPO_ROOT/docs/04-deployment/RCLONE_SHIM_EVALUATION.md"

SMOKE=0
REPORT_ONLY=0
for a in "$@"; do
  case "$a" in
    --smoke)       SMOKE=1 ;;
    --report-only) REPORT_ONLY=1 ;;
    -h|--help) sed -n '3,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $a" >&2; exit 1 ;;
  esac
done

if [ ! -f "$SERVERS_FILE" ]; then
  echo "ERROR: $SERVERS_FILE not found. This file is the source of truth for staging creds." >&2
  exit 2
fi

# Parse servers.txt -- tolerant of whitespace
# servers.txt has CRLF line endings; normalise to a tempfile first.
# ---------------------------------------------------------------------------
NORMALIZED_SERVERS=$(mktemp)
trap 'rm -f "$NORMALIZED_SERVERS"' EXIT
tr -d '\r' <"$SERVERS_FILE" >"$NORMALIZED_SERVERS"

# S3 staging bucket block (5 lines: URL/Bucket/Access/Key)
HETZNER_S3_ENDPOINT=$(awk 'tolower($0) ~ /s3 staging bucket/{found=1; next} found && /^https?:\/\//{print; exit}' "$NORMALIZED_SERVERS")
HETZNER_S3_BUCKET=$(awk 'tolower($0) ~ /s3 staging bucket/{found=1} found && /^Bucket:/{print $2; exit}' "$NORMALIZED_SERVERS")
HETZNER_S3_ACCESS=$(awk 'tolower($0) ~ /s3 staging bucket/{found=1} found && /^Access Key:/{print $3; exit}' "$NORMALIZED_SERVERS")
HETZNER_S3_SECRET=$(awk 'tolower($0) ~ /s3 staging bucket/{found=1} found && /^Key:/{print $2; exit}' "$NORMALIZED_SERVERS")

# SSH/SFTP block
HBOX_SFTP_LINE=$(awk 'tolower($0) ~ /^ssh\/sftp:/{found=1; next} found && /^ssh /{print; exit}' "$NORMALIZED_SERVERS")
# format: "ssh -p23 u335448-sub10@u335448-sub10.your-storagebox.de"
HBOX_SFTP_PORT=$(echo "$HBOX_SFTP_LINE" | grep -oP -- '-p\K[0-9]+' || echo 22)
HBOX_SFTP_USER=$(echo "$HBOX_SFTP_LINE" | grep -oP '\b\S+@' | head -1 | tr -d '@')
HBOX_SFTP_HOST=$(echo "$HBOX_SFTP_LINE" | grep -oP '@\K\S+')

# CIFS block
HBOX_SMB_UNC=$(awk 'tolower($0) ~ /^cifs/{found=1; next} found && /^\\\\/{print; exit}' "$NORMALIZED_SERVERS")
HBOX_SMB_HOST=$(echo "$HBOX_SMB_UNC" | sed -E 's,^\\\\,,; s,\\.*$,,')
HBOX_SMB_SHARE=$(echo "$HBOX_SMB_UNC" | sed -E 's,^\\\\[^\\]+\\,,')
HBOX_SMB_USER=$(awk 'tolower($0) ~ /^cifs/{found=1} found && /^Username:/{print $2; exit}' "$NORMALIZED_SERVERS")
HBOX_SMB_PASS=$(awk 'tolower($0) ~ /^cifs/{found=1} found && /^Password:/{sub(/^Password:[ \t]*/,""); print; exit}' "$NORMALIZED_SERVERS")

# Sanity-check what we parsed
echo "Parsed credentials from $SERVERS_FILE:"
echo "  Hetzner S3:  endpoint=$HETZNER_S3_ENDPOINT bucket=$HETZNER_S3_BUCKET access=${HETZNER_S3_ACCESS:0:6}..."
echo "  Storage Box SFTP: $HBOX_SFTP_USER@$HBOX_SFTP_HOST:$HBOX_SFTP_PORT"
echo "  Storage Box SMB:  //$HBOX_SMB_HOST/$HBOX_SMB_SHARE user=$HBOX_SMB_USER"
for v in HETZNER_S3_ENDPOINT HETZNER_S3_BUCKET HETZNER_S3_ACCESS HETZNER_S3_SECRET \
         HBOX_SFTP_HOST HBOX_SFTP_PORT HBOX_SFTP_USER \
         HBOX_SMB_HOST HBOX_SMB_SHARE HBOX_SMB_USER HBOX_SMB_PASS; do
  if [ -z "${!v}" ]; then echo "ERROR: failed to parse $v from servers.txt" >&2; exit 3; fi
done

# Verify SSH connectivity
echo
echo "Probing $HOST ..."
if ! ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 \
     "$REMOTE_USER@$HOST" "echo ok; uname -srm" >/dev/null; then
  echo "ERROR: cannot SSH to $REMOTE_USER@$HOST with $SSH_KEY" >&2; exit 4
fi
echo "  ok"

# Copy harness + SFTP key to remote
echo "Syncing harness to $REMOTE_USER@$HOST:$REMOTE_DIR ..."
ssh -i "$SSH_KEY" "$REMOTE_USER@$HOST" "mkdir -p $REMOTE_DIR/remote"
scp -i "$SSH_KEY" -q "$SCRIPT_DIR/remote/runner.sh"    "$REMOTE_USER@$HOST:$REMOTE_DIR/remote/runner.sh"
scp -i "$SSH_KEY" -q "$SCRIPT_DIR/remote/aggregate.sh" "$REMOTE_USER@$HOST:$REMOTE_DIR/remote/aggregate.sh"
ssh -i "$SSH_KEY" "$REMOTE_USER@$HOST" "chmod +x $REMOTE_DIR/remote/*.sh"

# We also need an SSH key on the remote host that authorises against the
# Hetzner Storage Box. We reuse the dev-side key -- ship it once with strict
# perms. (The Storage Box owner has accepted this key already.)
REMOTE_SFTP_KEY="$REMOTE_DIR/hbox-sftp.key"
scp -i "$SSH_KEY" -q "$SSH_KEY" "$REMOTE_USER@$HOST:$REMOTE_SFTP_KEY"
ssh -i "$SSH_KEY" "$REMOTE_USER@$HOST" "chmod 600 $REMOTE_SFTP_KEY"

if [ "$REPORT_ONLY" -eq 0 ]; then
  echo
  echo "Running evaluation on $HOST (this can take 15-40 minutes) ..."

  # Smoke profile -- short sizes + brief sustained window
  smoke_env=""
  if [ "$SMOKE" -eq 1 ]; then
    smoke_env="LARGE_SIZES='1M 10M' CONCURRENCY_FANOUT='4' CONC_BLOB_SIZE='10M' SMALL_COUNT=50 SUSTAIN_DURATION=60 SUSTAIN_BLOB_SIZE='5M'"
    echo "  (smoke mode: $smoke_env)"
  fi

  # The shim password contains shell-special chars; pass via stdin to avoid leaking via ps.
  ssh -i "$SSH_KEY" "$REMOTE_USER@$HOST" \
    "export HETZNER_S3_ENDPOINT='$HETZNER_S3_ENDPOINT'; \
     export HETZNER_S3_BUCKET='$HETZNER_S3_BUCKET'; \
     export HETZNER_S3_ACCESS='$HETZNER_S3_ACCESS'; \
     export HETZNER_S3_SECRET='$HETZNER_S3_SECRET'; \
     export HBOX_SFTP_HOST='$HBOX_SFTP_HOST'; \
     export HBOX_SFTP_PORT='$HBOX_SFTP_PORT'; \
     export HBOX_SFTP_USER='$HBOX_SFTP_USER'; \
     export HBOX_SFTP_KEY='$REMOTE_SFTP_KEY'; \
     export HBOX_SMB_HOST='$HBOX_SMB_HOST'; \
     export HBOX_SMB_SHARE='$HBOX_SMB_SHARE'; \
     export HBOX_SMB_USER='$HBOX_SMB_USER'; \
     read -r HBOX_SMB_PASS; export HBOX_SMB_PASS; \
     export EVAL_DIR='$REMOTE_DIR'; \
     $smoke_env \
     bash $REMOTE_DIR/remote/runner.sh" <<< "$HBOX_SMB_PASS"
fi

# Generate the markdown report on the remote, then pull it
echo
echo "Aggregating results ..."
ssh -i "$SSH_KEY" "$REMOTE_USER@$HOST" \
  "EVAL_DIR='$REMOTE_DIR' bash $REMOTE_DIR/remote/aggregate.sh $REMOTE_DIR/RCLONE_SHIM_EVALUATION.md"

mkdir -p "$(dirname "$REPORT_OUT")"
scp -i "$SSH_KEY" -q "$REMOTE_USER@$HOST:$REMOTE_DIR/RCLONE_SHIM_EVALUATION.md" "$REPORT_OUT"
scp -i "$SSH_KEY" -q "$REMOTE_USER@$HOST:$REMOTE_DIR/results.jsonl" "$REPO_ROOT/docs/04-deployment/RCLONE_SHIM_EVALUATION.results.jsonl"

echo
echo "Done."
echo "  Report:  $REPORT_OUT"
echo "  Raw:     $REPO_ROOT/docs/04-deployment/RCLONE_SHIM_EVALUATION.results.jsonl"
