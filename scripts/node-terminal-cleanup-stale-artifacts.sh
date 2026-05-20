#!/usr/bin/env bash
# scripts/node-terminal-cleanup-stale-artifacts.sh
#
# One-off cleanup of node-terminal per-session artifacts that
# accumulated on cluster nodes BEFORE the Pod preStop lifecycle hook
# (added 2026-05-20) started removing them on every teardown.
#
# Removes from EACH node:
#   • /root/.bash_history-<uuid>     (operator-typed commands)
#   • /tmp/.nt-tmux-<uuid>.conf      (tmux config written at session start)
#   • /tmp/reload-sentinel-<uuid>    (harness test artifact)
#
# Each filename ends with a 36-char UUID — the glob is strict enough
# that the script cannot accidentally remove unrelated files (e.g.
# `/root/.bash_history` without a suffix stays put).
#
# Run AFTER the new pod-spec.ts is deployed to every node. The new
# preStop hook will keep these directories tidy going forward.
#
# Usage:
#   ./scripts/node-terminal-cleanup-stale-artifacts.sh [--dry-run]
#
# Environment:
#   SSH_KEY       — path to SSH key (default: ~/hosting-platform.key)
#   HOSTS         — space-separated list of root@host targets
#                   (default: staging hosts from ~/k8s-staging/servers.txt
#                    if present, else fail with instructions)

set -uo pipefail

DRY_RUN=0
[[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1

SSH_KEY="${SSH_KEY:-$HOME/hosting-platform.key}"
if [[ -z "${HOSTS:-}" ]]; then
  if [[ -f "$HOME/k8s-staging/servers.txt" ]]; then
    # Match lines that START with a hostname (no leading whitespace)
    # followed by an IPv4 address (\d+\.\d+\.\d+\.\d+). That filter
    # excludes the DNS round-robin entries ("staging.phoenix-host.net
    # 3 A records: ...") and section headers.
    HOSTS=$(awk '/^[a-zA-Z0-9_.-]+\.phoenix-host\.net[[:space:]]+[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+/{print "root@"$1}' \
      "$HOME/k8s-staging/servers.txt" | tr '\n' ' ')
  else
    echo "ERROR: set HOSTS='root@h1 root@h2 ...' or provide ~/k8s-staging/servers.txt" >&2
    exit 2
  fi
fi
[[ -z "$HOSTS" ]] && { echo "ERROR: HOSTS list resolved empty" >&2; exit 2; }
echo "HOSTS: $HOSTS"

# Strict 36-char UUID-shaped glob — alnum + dash, in the exact 8-4-4-4-12 layout.
# Bash glob can't match that directly, so we let `find` enforce the shape.
FIND_CMD='
  printf "%s\n" "=== HOST: $(hostname) ==="
  # /root/.bash_history-<uuid>
  find /root -maxdepth 1 -type f -name ".bash_history-*" 2>/dev/null \
    | grep -E "/\\.bash_history-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" || true
  # /tmp/.nt-tmux-<uuid>.conf
  find /tmp -maxdepth 1 -type f -name ".nt-tmux-*.conf" 2>/dev/null \
    | grep -E "/\\.nt-tmux-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.conf$" || true
  # /tmp/reload-sentinel-<uuid>
  find /tmp -maxdepth 1 -type f -name "reload-sentinel-*" 2>/dev/null \
    | grep -E "/reload-sentinel-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" || true
'

# Same scan but pipe each find's output to xargs rm -fv. Three
# separate pipelines (one per find) so a single `| xargs` at the end
# wouldn't apply to all three.
DELETE_CMD='
  printf "%s\n" "=== HOST: $(hostname) ==="
  find /root -maxdepth 1 -type f -name ".bash_history-*" 2>/dev/null \
    | grep -E "/\\.bash_history-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" \
    | xargs -r rm -fv
  find /tmp -maxdepth 1 -type f -name ".nt-tmux-*.conf" 2>/dev/null \
    | grep -E "/\\.nt-tmux-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\\.conf$" \
    | xargs -r rm -fv
  find /tmp -maxdepth 1 -type f -name "reload-sentinel-*" 2>/dev/null \
    | grep -E "/reload-sentinel-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$" \
    | xargs -r rm -fv
'

for host in $HOSTS; do
  echo
  echo "─── $host ───"
  if [[ "$DRY_RUN" == "1" ]]; then
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$host" "$FIND_CMD"
  else
    ssh -i "$SSH_KEY" -o StrictHostKeyChecking=no -o ConnectTimeout=10 "$host" "$DELETE_CMD"
  fi
done

echo
if [[ "$DRY_RUN" == "1" ]]; then
  echo "Dry-run complete — re-run without --dry-run to remove the listed files."
else
  echo "Cleanup complete."
fi
