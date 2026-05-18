#!/usr/bin/env bash
# test-ssh-via-mesh.sh — sanity-check for the --ssh-via-mesh flag.
#
# Validates (without running the destructive bits of bootstrap.sh):
#   1. The bash arg parser accepts `--ssh-via-mesh <iface>`. Verified
#      by running `bootstrap.sh --help` (exits 0 with the flag
#      documented in the help text).
#   2. The static rendering invariants are caught by
#      ci-firewall-check.sh which we re-run from here for
#      symmetry.
#   3. The firewall.conf format is what the security-probe expects.
#      Renders the firewall.conf heredoc body in isolation for both
#      paths (mesh-on, mesh-off) and asserts the four critical
#      fields.
#
# Lock-out drill: a real `--ssh-via-mesh` test against a live host
# is documented in docs/04-deployment/SECURITY_HARDENING.md — that's
# the integration verification an operator runs WITH console
# access.

set -euo pipefail

REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
SCRIPT="$REPO_ROOT/scripts/bootstrap.sh"
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# 1. Help text mentions --ssh-via-mesh.
if ! "$SCRIPT" --help 2>&1 | grep -q '\-\-ssh-via-mesh <iface>'; then
  echo "FAIL [help]: --ssh-via-mesh flag missing from bootstrap.sh --help"
  exit 1
fi

# 2. Re-run ci-firewall-check.sh — it owns static-pattern verification.
if ! bash "$REPO_ROOT/scripts/ci-firewall-check.sh" >/dev/null 2>&1; then
  echo "FAIL [ci-firewall-check]: bootstrap.sh firewall rules are not in the expected shape"
  bash "$REPO_ROOT/scripts/ci-firewall-check.sh"
  exit 1
fi

# 3. Render the firewall.conf heredoc in isolation. This MUST stay
#    in sync with the body in configure_firewall — bump both
#    together when the format changes.

render_firewall_conf() {
  local SSH_VIA_MESH_IFACE="$1"
  local ssh_via_mesh_persist="false"
  [[ -n "$SSH_VIA_MESH_IFACE" ]] && ssh_via_mesh_persist="true"
  cat <<HPFW
# Written by bootstrap.sh — DO NOT EDIT BY HAND.
# Re-run bootstrap with appropriate flags to change posture.
PUBLIC_TCP_PORTS=$( [[ -n "$SSH_VIA_MESH_IFACE" ]] && echo "80 443" || echo "80 443 22" ) 25 465 587 143 993 110 995 4190
PUBLIC_UDP_PORTS=51820 29899
SSH_VIA_MESH=${ssh_via_mesh_persist}
SSH_VIA_MESH_INTERFACE=${SSH_VIA_MESH_IFACE}
HPFW
}

# Case 1: mesh-off (default).
render_firewall_conf "" > "$TMPDIR/firewall.off.conf"
grep -q '^PUBLIC_TCP_PORTS=80 443 22 25' "$TMPDIR/firewall.off.conf" \
  || { echo "FAIL [conf-off]: PUBLIC_TCP_PORTS must include 22 when SSH is public"; cat "$TMPDIR/firewall.off.conf"; exit 1; }
grep -q '^SSH_VIA_MESH=false' "$TMPDIR/firewall.off.conf" \
  || { echo "FAIL [conf-off]: SSH_VIA_MESH must be false"; exit 1; }
grep -q '^SSH_VIA_MESH_INTERFACE=$' "$TMPDIR/firewall.off.conf" \
  || { echo "FAIL [conf-off]: SSH_VIA_MESH_INTERFACE must be empty"; exit 1; }

# Case 2: mesh-on (wt0).
render_firewall_conf "wt0" > "$TMPDIR/firewall.wt0.conf"
grep -q '^PUBLIC_TCP_PORTS=80 443 25' "$TMPDIR/firewall.wt0.conf" \
  || { echo "FAIL [conf-wt0]: PUBLIC_TCP_PORTS must NOT include 22 when SSH is scoped"; cat "$TMPDIR/firewall.wt0.conf"; exit 1; }
grep -q '^SSH_VIA_MESH=true' "$TMPDIR/firewall.wt0.conf" \
  || { echo "FAIL [conf-wt0]: SSH_VIA_MESH must be true"; exit 1; }
grep -q '^SSH_VIA_MESH_INTERFACE=wt0' "$TMPDIR/firewall.wt0.conf" \
  || { echo "FAIL [conf-wt0]: SSH_VIA_MESH_INTERFACE must be wt0"; exit 1; }

# Case 3: mesh-on (tailscale0).
render_firewall_conf "tailscale0" > "$TMPDIR/firewall.ts.conf"
grep -q '^SSH_VIA_MESH_INTERFACE=tailscale0' "$TMPDIR/firewall.ts.conf" \
  || { echo "FAIL [conf-tailscale0]: SSH_VIA_MESH_INTERFACE must be tailscale0"; exit 1; }

# 4. Drift check — assert the in-bootstrap.sh heredoc body matches
# the format above. If someone edits configure_firewall to change
# the key names, this catches the drift before the probe sees the
# new format with the old parser.
EXPECTED_KEYS='PUBLIC_TCP_PORTS PUBLIC_UDP_PORTS SSH_VIA_MESH SSH_VIA_MESH_INTERFACE'
for k in $EXPECTED_KEYS; do
  if ! grep -q "^${k}=" "$SCRIPT"; then
    echo "FAIL [drift]: bootstrap.sh missing the ${k}= line in /etc/hosting-platform/firewall.conf heredoc"
    exit 1
  fi
done

echo "✓ test-ssh-via-mesh: help text + ci-firewall-check + firewall.conf format (3 cases) verified."
