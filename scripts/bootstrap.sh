#!/usr/bin/env bash
set -euo pipefail

# bootstrap.sh — One-command server setup for the k8s hosting platform.
# Run directly on a fresh Debian 12/13 or Ubuntu 22.04+ server,
# or remotely from your workstation via --remote.

# ─── Remote execution mode ──────────────────────────────────────────────────
REMOTE_HOST=""
SSH_KEY=""
SSH_USER="root"

# Parse --remote, --ssh-key, --ssh-user from args before main arg parsing
REMAINING_ARGS=()
while [[ $# -gt 0 ]]; do
  case "$1" in
    --remote)   REMOTE_HOST="$2"; shift 2 ;;
    --ssh-key)  SSH_KEY="$2"; shift 2 ;;
    --ssh-user) SSH_USER="$2"; shift 2 ;;
    *)          REMAINING_ARGS+=("$1"); shift ;;
  esac
done
set -- "${REMAINING_ARGS[@]}"

if [[ -n "$REMOTE_HOST" ]]; then
  echo "════════════════════════════════════════════════"
  echo "  Remote Bootstrap — $REMOTE_HOST"
  echo "════════════════════════════════════════════════"
  # Build SSH options as an array so spaces or special chars in the
  # --ssh-key path don't split into separate words. Unquoted expansion
  # of a single string would break on `id_rsa with spaces`.
  SSH_OPTS=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=10)
  [[ -n "$SSH_KEY" ]] && SSH_OPTS+=(-i "$SSH_KEY")

  echo "Copying bootstrap script to $REMOTE_HOST..."
  scp "${SSH_OPTS[@]}" "$0" "${SSH_USER}@${REMOTE_HOST}:/tmp/bootstrap.sh"

  echo "Executing bootstrap on $REMOTE_HOST..."
  ssh "${SSH_OPTS[@]}" "${SSH_USER}@${REMOTE_HOST}" "chmod +x /tmp/bootstrap.sh && /tmp/bootstrap.sh $*"
  exit $?
fi

# ─── Configuration ────────────────────────────────────────────────────────────

NODE_ROLE=""
# M1: host-client-workloads. Controls whether this node accepts tenant
# pods in addition to system ones. "" means "derive from role"
# (server→false, worker→true) so existing single-node installs keep
# working unchanged. Set explicitly via --host-client-workloads.
HOST_CLIENT_WORKLOADS=""
PLATFORM_ENV="production"
PLATFORM_DOMAIN=""
K3S_SERVER_IP=""
K3S_TOKEN=""
K3S_VERSION="v1.33.10+k3s1"
CALICO_VERSION="v3.31.5"

# Private-network underlay (M12). When --cluster-network-cidr is set,
# every cross-node K8s flow (etcd peer, apiserver, kubelet, Calico
# Typha + VXLAN) is pinned to the IP picked from that CIDR on the host.
# Public TCP/2379-2380, TCP/5473, TCP/10250, UDP/4789 stay closed —
# the CIDR-restricted nft allow IS the allowlist. See doc examples
# below (NetBird / Tailscale / generic).
CLUSTER_NETWORK_CIDR=""
NETBIRD_MANAGEMENT_URL=""
NETBIRD_SETUP_KEY=""

# ─── Pinned component versions ────────────────────────────────────────────────
# Updated 2026-04-21. When bumping, verify:
#   1. Longhorn compatibility matrix covers the chosen k3s/k8s version
#   2. All Helm chart versions are published at their respective repos
#   3. Run `kubectl kustomize` on all overlays + redeploy staging before prod
# Latest-stable checks done against GitHub releases for each project.
LONGHORN_VERSION="v1.11.1"               # 2026-03-13
INGRESS_NGINX_CHART_VERSION="4.15.1"     # controller v1.15.1, 2026-03-19
CERT_MANAGER_CHART_VERSION="v1.20.2"     # 2026-04-11
SEALED_SECRETS_CHART_VERSION="2.17.4"    # controller v0.36.6
CNPG_CHART_VERSION="0.23.2"              # CloudNative-PG operator v1.24.2
SKIP_CNPG=false                          # --skip-cnpg flag sets this
ACME_EMAIL=""
ENABLE_MONITORING=false
SKIP_FLUX=false
SKIP_HARDENING=false
SKIP_VPN=false
SKIP_LONGHORN=false
OPERATOR_AGE_RECIPIENT=""      # public half (age1...) — optional, generated if empty
FORCE_ROTATE_OPERATOR_KEY=false # regenerate + overwrite ConfigMap even if it exists
MARKER_DIR="/var/lib/hosting-platform"
KUBECONFIG="/etc/rancher/k3s/k3s.yaml"
REPO_URL="https://github.com/phoenixtechnam/k8s-hosting-platform.git"

# ─── Helpers ──────────────────────────────────────────────────────────────────

usage() {
  cat <<'HELPTEXT'
Usage: bootstrap.sh --join-as <server|worker> [OPTIONS]

Server provisioning and platform installation for k8s-hosting-platform.

REQUIRED:
  --join-as <server|worker>
                         What this node joins as. server = control plane
                         (etcd member); worker = kubelet only. The first
                         control-plane invocation is `--join-as server`
                         WITHOUT --server/--token; subsequent control-
                         plane joins pass --server + --token.

OPTIONS:
  --domain <FQDN>        Base domain (required for first server)
  --host-client-workloads <true|false>
                         Whether this node accepts tenant pods. Default:
                         false for servers, true for workers. When false
                         on a server, applies the
                         platform.phoenix-host.net/server-only:NoSchedule
                         taint so only system pods (Flux, platform-api,
                         etc.) land here. Not applicable to workers.
  --env <dev|staging|production> Environment (default: production)
  --k3s-version <ver>    k3s version (default: v1.31.4+k3s1)
  --with-monitoring      Install Prometheus + Loki
  --skip-flux            Skip Flux v2 GitOps
  --skip-hardening       Skip SSH/firewall hardening
  --skip-vpn             Skip WireGuard + NetBird
  --skip-longhorn        Skip Longhorn storage (use local-path)
  --skip-cnpg            Skip CloudNative-PG operator install (M10).
  --acme-email <email>   Email for Let's Encrypt (required for first server)
  --operator-age-recipient <age1...>
                         Public age recipient for operator-held backup
                         encryption. If omitted, a fresh keypair is
                         generated and the PRIVATE KEY is printed to
                         stderr ONCE — save it, it's the only way to
                         decrypt backups. Accepts comma-separated list.
  --force-rotate-operator-key
                         Regenerate the operator keypair even if the
                         ConfigMap already exists (rotation drill).

JOINING (server #2+ or worker):
  --server <ip>          Existing control-plane IP. When --cluster-network-
                         cidr is set on the existing cluster, this MUST
                         be the control-plane's IP within that CIDR
                         (e.g. its NetBird wt0 IP), NOT its public IP.
  --token <token>        k3s join token from /var/lib/rancher/k3s/server/
                         node-token on an existing control-plane.

PRIVATE-NETWORK UNDERLAY (recommended for HA):
  --cluster-network-cidr <cidr>
                         Pin every cross-node k8s flow (etcd peer,
                         apiserver, kubelet, Calico Typha + VXLAN) to
                         the host IP in this CIDR. Public 2379-2380/
                         5473/10250/4789 stay closed; only TCP/22, 80,
                         443, 6443 face the internet. Choose this once
                         at first-server bootstrap — switching later
                         requires a full cluster rebuild.

NETBIRD CONVENIENCE (optional, brings up wt0 before k3s):
  --netbird-management-url <url>
                         e.g. https://vpn.phoenix-host.net
  --netbird-setup-key <uuid>
                         Setup key from the NetBird admin console.
                         When both are set, bootstrap runs `netbird up`
                         and waits for wt0 in 100.64.0.0/10 before
                         installing k3s. If --cluster-network-cidr is
                         not given, defaults to 100.64.0.0/10.

REMOTE MODE:
  --remote <host>        Run on remote server via SSH
  --ssh-key <path>       SSH private key for remote mode
  --ssh-user <user>      SSH user (default: root)

EXAMPLES:

  # ─ NetBird-private 3-server HA cluster ─────────────────────────────
  # First server (creates the cluster):
  ./bootstrap.sh --join-as server \
    --domain phoenix-host.net --acme-email ops@phoenix-host.net \
    --netbird-management-url https://vpn.phoenix-host.net \
    --netbird-setup-key <UUID>

  # Second & third servers (join over NetBird wt0 IP, NOT public IP):
  ./bootstrap.sh --join-as server \
    --server 100.64.1.5 --token K10abc...:server:def... \
    --domain phoenix-host.net --acme-email ops@phoenix-host.net \
    --netbird-management-url https://vpn.phoenix-host.net \
    --netbird-setup-key <UUID>

  # Worker (over NetBird):
  ./bootstrap.sh --join-as worker \
    --server 100.64.1.5 --token K10abc...:server:def... \
    --netbird-management-url https://vpn.phoenix-host.net \
    --netbird-setup-key <UUID>

  # ─ Tailscale-private cluster (operator brings tailscale up first) ──
  # Tailscale's tailnet IP becomes the cluster underlay. tailscale also
  # uses 100.64.0.0/10 by default; the operator runs `tailscale up
  # --auth-key tskey-...` before bootstrap.
  ./bootstrap.sh --join-as server \
    --domain phoenix-host.net --acme-email ops@phoenix-host.net \
    --cluster-network-cidr 100.64.0.0/10

  # ─ Generic private network (Hetzner Cloud private net, VLAN, ZeroTier) ─
  ./bootstrap.sh --join-as server \
    --domain phoenix-host.net --acme-email ops@phoenix-host.net \
    --cluster-network-cidr 10.0.0.0/16

  # ─ Public underlay (single server, no HA) ──────────────────────────
  # No --cluster-network-cidr. Cross-node k8s flows would be blocked
  # by the firewall — only single-server installs should use this.
  ./bootstrap.sh --join-as server \
    --domain phoenix-host.net --acme-email ops@phoenix-host.net

  # ─ Remote bootstrap from workstation ───────────────────────────────
  ./bootstrap.sh --remote 1.2.3.4 --ssh-key ~/hosting-platform.key \
    --join-as server \
    --domain phoenix-host.net --acme-email ops@phoenix-host.net \
    --cluster-network-cidr 100.64.0.0/10
HELPTEXT
  exit 0
}

log()   { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
warn()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARN: $*" >&2; }
error() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2; exit 1; }

marker_exists() { [[ -f "${MARKER_DIR}/.${1}" ]]; }
marker_set()    { mkdir -p "$MARKER_DIR"; touch "${MARKER_DIR}/.${1}"; }

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --join-as)         NODE_ROLE="$2"; shift 2 ;;
      --host-client-workloads) HOST_CLIENT_WORKLOADS="$2"; shift 2 ;;
      --env)             PLATFORM_ENV="$2"; shift 2 ;;
      --domain)          PLATFORM_DOMAIN="$2"; shift 2 ;;
      --server)          K3S_SERVER_IP="$2"; shift 2 ;;
      --token)           K3S_TOKEN="$2"; shift 2 ;;
      --k3s-version)     K3S_VERSION="$2"; shift 2 ;;
      --cluster-network-cidr) CLUSTER_NETWORK_CIDR="$2"; shift 2 ;;
      --netbird-management-url) NETBIRD_MANAGEMENT_URL="$2"; shift 2 ;;
      --netbird-setup-key) NETBIRD_SETUP_KEY="$2"; shift 2 ;;
      --with-monitoring) ENABLE_MONITORING=true; shift ;;
      --skip-monitoring) shift ;; # Deprecated — monitoring is now opt-in via --with-monitoring
      --skip-flux)       SKIP_FLUX=true; shift ;;
      --skip-hardening)  SKIP_HARDENING=true; shift ;;
      --skip-vpn)        SKIP_VPN=true; shift ;;
      --skip-longhorn)   SKIP_LONGHORN=true; shift ;;
      --skip-cnpg)       SKIP_CNPG=true; shift ;;
      --acme-email)      ACME_EMAIL="$2"; shift 2 ;;
      --operator-age-recipient) OPERATOR_AGE_RECIPIENT="$2"; shift 2 ;;
      --force-rotate-operator-key) FORCE_ROTATE_OPERATOR_KEY=true; shift ;;
      --help|-h)         usage ;;
      *)                 error "Unknown option: $1" ;;
    esac
  done

  if [[ "$NODE_ROLE" != "server" && "$NODE_ROLE" != "worker" ]]; then
    error "Missing or invalid --join-as: '${NODE_ROLE}'. Must be 'server' or 'worker'. Run with --help for examples."
  fi

  # Resolve HOST_CLIENT_WORKLOADS default: servers default to refusing
  # client pods (NoSchedule taint); workers accept them. Keep in sync
  # with the cluster_nodes column default (migration 0046).
  if [[ -z "$HOST_CLIENT_WORKLOADS" ]]; then
    if [[ "$NODE_ROLE" == "server" ]]; then
      HOST_CLIENT_WORKLOADS="false"
    else
      HOST_CLIENT_WORKLOADS="true"
    fi
  fi
  if [[ "$HOST_CLIENT_WORKLOADS" != "true" && "$HOST_CLIENT_WORKLOADS" != "false" ]]; then
    error "Invalid --host-client-workloads: ${HOST_CLIENT_WORKLOADS}. Must be 'true' or 'false'."
  fi

  if [[ "$PLATFORM_ENV" != "dev" && "$PLATFORM_ENV" != "staging" && "$PLATFORM_ENV" != "production" ]]; then
    error "Invalid --env: ${PLATFORM_ENV}. Must be 'dev', 'staging', or 'production'."
  fi

  # First-server bootstrap (--join-as server, no --server/--token) requires
  # --domain. Subsequent control-plane joins inherit the domain from the
  # existing cluster's etcd state.
  local is_first_server=false
  if [[ "$NODE_ROLE" == "server" && -z "$K3S_SERVER_IP" && -z "$K3S_TOKEN" ]]; then
    is_first_server=true
  fi
  if [[ "$is_first_server" == true ]] && [[ -z "$PLATFORM_DOMAIN" ]]; then
    error "First-server bootstrap requires --domain. Example: --domain phoenix-host.net"
  fi

  # Worker join — both --server and --token required.
  if [[ "$NODE_ROLE" == "worker" ]]; then
    if [[ -z "$K3S_SERVER_IP" ]]; then
      error "--join-as worker requires --server <CONTROL_PLANE_IP>"
    fi
    if [[ -z "$K3S_TOKEN" ]]; then
      error "--join-as worker requires --token <TOKEN> (from control plane: cat /var/lib/rancher/k3s/server/node-token)"
    fi
  fi

  # HA control-plane join requires both --server and --token. (First-server
  # bootstrap with neither was already handled above.)
  if [[ "$NODE_ROLE" == "server" && -n "$K3S_SERVER_IP" && -z "$K3S_TOKEN" ]]; then
    error "--join-as server with --server requires --token (joining existing cluster)"
  fi
  if [[ "$NODE_ROLE" == "server" && -z "$K3S_SERVER_IP" && -n "$K3S_TOKEN" ]]; then
    error "--join-as server with --token requires --server (joining existing cluster)"
  fi

  # NetBird convenience flags must be paired.
  if [[ -n "$NETBIRD_MANAGEMENT_URL" && -z "$NETBIRD_SETUP_KEY" ]]; then
    error "--netbird-management-url requires --netbird-setup-key"
  fi
  if [[ -z "$NETBIRD_MANAGEMENT_URL" && -n "$NETBIRD_SETUP_KEY" ]]; then
    error "--netbird-setup-key requires --netbird-management-url"
  fi

  # Validate CLUSTER_NETWORK_CIDR shape if set. Tight regex: 4 octets +
  # /0–32 prefix. Also defends the python3 / nft heredocs downstream
  # against shell-interpolated content.
  if [[ -n "$CLUSTER_NETWORK_CIDR" ]] \
     && [[ ! "$CLUSTER_NETWORK_CIDR" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]]; then
    error "Invalid --cluster-network-cidr: '${CLUSTER_NETWORK_CIDR}'. Must be IPv4 CIDR (e.g. 100.64.0.0/10)."
  fi

  # Validate K3S_SERVER_IP shape if set. Same defence-in-depth — the
  # python pre-flight uses this value via env-var (not interpolation),
  # but tighter validation keeps error messages clear.
  if [[ -n "$K3S_SERVER_IP" ]] \
     && [[ ! "$K3S_SERVER_IP" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    error "Invalid --server: '${K3S_SERVER_IP}'. Must be a bare IPv4 address (no scheme, no port)."
  fi

  return 0
}

check_root() {
  [[ "$(id -u)" -eq 0 ]] || error "This script must be run as root."
}

check_os() {
  if [[ ! -f /etc/os-release ]]; then
    error "Cannot detect OS. This script requires Debian 12+ or Ubuntu 22.04+."
  fi
  # shellcheck source=/dev/null
  source /etc/os-release
  log "Detected OS: ${PRETTY_NAME}"
}

# ─── Phase 1: Server Hardening ───────────────────────────────────────────────

harden_ssh() {
  if [[ "$SKIP_HARDENING" == true ]]; then
    log "Skipping SSH hardening (--skip-hardening)."
    return 0
  fi
  if marker_exists "ssh-hardened"; then
    log "SSH already hardened, skipping."
    return 0
  fi

  log "Hardening SSH configuration..."
  local sshd_config="/etc/ssh/sshd_config"

  cp "$sshd_config" "${sshd_config}.bak.$(date +%s)"

  sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' "$sshd_config"
  sed -i 's/^#\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' "$sshd_config"
  sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' "$sshd_config"
  sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' "$sshd_config"
  sed -i 's/^#\?X11Forwarding.*/X11Forwarding no/' "$sshd_config"

  sshd -t || { error "Invalid sshd_config after modification"; }
  systemctl reload sshd

  marker_set "ssh-hardened"
  log "SSH hardened."
}

install_packages() {
  log "Installing base packages..."
  export DEBIAN_FRONTEND=noninteractive

  apt-get update -qq
  # Note: software-properties-common was dropped — it's not present in
  # Debian 13 trixie repos and we don't use add-apt-repository anywhere.
  apt-get install -y -qq \
    curl wget gnupg2 ca-certificates \
    nftables fail2ban jq unzip git open-iscsi nfs-common \
    age \
    >/dev/null 2>&1

  log "Base packages installed."
}

configure_firewall() {
  if [[ "$SKIP_HARDENING" == true ]]; then
    log "Skipping firewall (--skip-hardening)."
    return 0
  fi

  log "Configuring nftables firewall..."

  # M12: when --cluster-network-cidr is set, every cross-node k8s flow
  # (etcd peer 2379-2380, Calico Typha 5473, kubelet 10250, Calico
  # VXLAN 4789) is allowed ONLY from peers inside that CIDR. Public
  # interfaces never see those ports — closed by `policy drop`.
  # Without the flag, we keep the legacy "private RFC1918+CGNAT" allow
  # for UDP/4789 (single-server installs only — HA is not supported on
  # public underlay; document recovery via `nft insert` if you need it).
  local cluster_allow=""
  if [[ -n "$CLUSTER_NETWORK_CIDR" ]]; then
    cluster_allow="    # Cluster-internal k8s flows — restricted to private CIDR ${CLUSTER_NETWORK_CIDR}
    ip saddr ${CLUSTER_NETWORK_CIDR} udp dport 4789 accept   # Calico VXLAN
    ip saddr ${CLUSTER_NETWORK_CIDR} tcp dport 5473 accept   # Calico Typha
    ip saddr ${CLUSTER_NETWORK_CIDR} tcp dport 2379 accept   # etcd client
    ip saddr ${CLUSTER_NETWORK_CIDR} tcp dport 2380 accept   # etcd peer
    ip saddr ${CLUSTER_NETWORK_CIDR} tcp dport 10250 accept  # kubelet"
  else
    cluster_allow="    # Calico VXLAN (UDP/4789) — single-server fallback. HA over public
    # underlay is NOT supported — set --cluster-network-cidr for HA.
    ip saddr { 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, 100.64.0.0/10 } udp dport 4789 accept"
  fi

  cat > /etc/nftables.conf <<NFT
#!/usr/sbin/nft -f

flush ruleset

table inet filter {
  chain input {
    type filter hook input priority filter; policy drop;

    iif "lo" accept
    ct state established,related accept

    ip protocol icmp accept
    ip6 nexthdr icmpv6 accept

    tcp dport 80 accept      # HTTP
    tcp dport 443 accept     # HTTPS
    tcp dport 6443 accept    # k8s API
    tcp dport 22 accept      # SSH
    udp dport 51820 accept   # WireGuard (NetBird)
    udp dport 29899 accept   # NetBird direct connection

${cluster_allow}

    # Calico WireGuard (UDP/51821) — authenticated by public-key crypto,
    # safe to expose like NetBird's 51820.
    udp dport 51821 accept

    # Stalwart mail server ports — required for a node carrying the
    # mail StatefulSet's pod (the staging + production overlays pin
    # stalwart-mail Service with externalIPs to the node). Closed-by-
    # default on non-mail clusters has no functional impact since
    # Stalwart isn't listening; opening them on every k3s node keeps
    # the cluster "mail-ready" if the StatefulSet reschedules across
    # nodes (multi-node HA path).
    tcp dport 25 accept      # SMTP
    tcp dport 465 accept     # SMTP submissions (implicit TLS)
    tcp dport 587 accept     # SMTP submission (STARTTLS)
    tcp dport 143 accept     # IMAP
    tcp dport 993 accept     # IMAPS
    tcp dport 110 accept     # POP3
    tcp dport 995 accept     # POP3S
    tcp dport 4190 accept    # ManageSieve

    counter drop
  }

  chain forward {
    type filter hook forward priority filter; policy accept;
    ct state established,related accept
  }

  chain output {
    type filter hook output priority filter; policy accept;
  }
}
NFT

  systemctl enable nftables
  nft -f /etc/nftables.conf
  log "Firewall configured."
}

configure_fail2ban() {
  if [[ "$SKIP_HARDENING" == true ]]; then
    log "Skipping fail2ban (--skip-hardening)."
    return 0
  fi
  if marker_exists "fail2ban-configured"; then
    log "fail2ban already configured, skipping."
    return 0
  fi

  log "Configuring fail2ban..."
  cat > /etc/fail2ban/jail.local <<'EOF'
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5
backend  = systemd

[sshd]
enabled = true
port    = ssh
filter  = sshd
maxretry = 3
EOF

  systemctl enable fail2ban
  systemctl restart fail2ban
  marker_set "fail2ban-configured"
  log "fail2ban configured."
}

install_vpn_tools() {
  if [[ "$SKIP_VPN" == true ]]; then
    log "Skipping VPN tools (--skip-vpn)."
    return 0
  fi

  # WireGuard
  if command -v wg &>/dev/null; then
    log "WireGuard already installed."
  else
    log "Installing WireGuard..."
    apt-get install -y -qq wireguard-tools >/dev/null 2>&1
    log "WireGuard installed (not configured — run 'wg-quick up <iface>' when ready)."
  fi

  # NetBird — install client if missing.
  if command -v netbird &>/dev/null; then
    log "NetBird already installed."
  else
    log "Installing NetBird client..."
    curl -fsSL https://pkgs.netbird.io/install.sh | sh >/dev/null 2>&1
    systemctl enable netbird 2>/dev/null || true
  fi

  # M12: when --netbird-management-url + --netbird-setup-key are set,
  # bring NetBird up + wait for wt0 to come online BEFORE install_k3s
  # runs. Default-inject CLUSTER_NETWORK_CIDR=100.64.0.0/10 if the
  # operator didn't override it (NetBird CGNAT default).
  if [[ -n "$NETBIRD_MANAGEMENT_URL" && -n "$NETBIRD_SETUP_KEY" ]]; then
    log "Bringing NetBird up (mgmt: ${NETBIRD_MANAGEMENT_URL})..."
    # `netbird up` is idempotent — re-running with --setup-key on an
    # already-connected node is a no-op.
    netbird up \
      --management-url "$NETBIRD_MANAGEMENT_URL" \
      --setup-key "$NETBIRD_SETUP_KEY" \
      >/dev/null 2>&1 \
      || error "netbird up failed — check management URL + setup key."

    log "Waiting for NetBird interface (wt0) to acquire an IP..."
    local _attempt
    for _attempt in $(seq 1 30); do
      if ip -4 -o addr show wt0 2>/dev/null | grep -q 'inet '; then
        local wt0_ip
        wt0_ip=$(ip -4 -o addr show wt0 | awk '{print $4}' | head -1)
        log "NetBird up: wt0 = ${wt0_ip}"
        break
      fi
      sleep 2
    done
    if ! ip -4 -o addr show wt0 2>/dev/null | grep -q 'inet '; then
      error "NetBird interface wt0 did not come up within 60 seconds."
    fi

    # Default-inject CIDR if operator didn't override.
    if [[ -z "$CLUSTER_NETWORK_CIDR" ]]; then
      CLUSTER_NETWORK_CIDR="100.64.0.0/10"
      log "Defaulting --cluster-network-cidr to ${CLUSTER_NETWORK_CIDR} (NetBird CGNAT)."
    fi
  else
    log "NetBird installed but not configured. Run 'netbird up --setup-key <KEY>' when ready, or pass --netbird-management-url + --netbird-setup-key to bootstrap.sh."
  fi
}

# ─── Phase 2: k3s + Calico ───────────────────────────────────────────────────

# M1 C5: pin Helm-managed system components to nodes labelled
# platform.phoenix-host.net/node-role=server and add a toleration for
# the server-only taint. The Kustomize system-node-affinity component
# handles base/overlay manifests; this function covers the Helm
# installs (flux-system, cert-manager, sealed-secrets) and adds the
# server-only toleration to the DaemonSets that need to run on every
# node (ingress-nginx, longhorn-system).
#
# Distinction:
#   - Control-plane only (nodeSelector + toleration):
#       flux-system/*, cert-manager/*, sealed-secrets-controller
#   - Runs on every node, needs toleration only so it schedules onto
#     tainted servers too:
#       ingress-nginx (DaemonSet), longhorn-system/* (Manager DaemonSet,
#       instance-manager DaemonSet, UI Deployment)
#
# Idempotent: strategic-merge patches against stable structure; re-runs
# produce no churn. Safe to call on both fresh installs and upgrades.
# No-op outside server mode.
pin_system_components_to_servers() {
  if [[ "$NODE_ROLE" != "server" ]]; then
    return 0
  fi
  export KUBECONFIG

  log "Pinning Helm-managed system components to server nodes..."

  local server_patch
  server_patch='{"spec":{"template":{"spec":{"affinity":{"nodeAffinity":{"requiredDuringSchedulingIgnoredDuringExecution":{"nodeSelectorTerms":[{"matchExpressions":[{"key":"platform.phoenix-host.net/node-role","operator":"In","values":["server"]}]}]}}},"tolerations":[{"key":"platform.phoenix-host.net/server-only","operator":"Equal","value":"true","effect":"NoSchedule"}]}}}}'
  local toleration_only_patch
  toleration_only_patch='{"spec":{"template":{"spec":{"tolerations":[{"key":"platform.phoenix-host.net/server-only","operator":"Equal","value":"true","effect":"NoSchedule"}]}}}}'

  # Control-plane-only (pin to server + tolerate server-only taint).
  # `|| true` because not every combination is guaranteed to exist on
  # every run (e.g. flux might be skipped via --skip-flux).
  for ns_name in \
      "flux-system:source-controller" \
      "flux-system:kustomize-controller" \
      "flux-system:helm-controller" \
      "flux-system:notification-controller" \
      "flux-system:image-reflector-controller" \
      "flux-system:image-automation-controller" \
      "cert-manager:cert-manager" \
      "cert-manager:cert-manager-webhook" \
      "cert-manager:cert-manager-cainjector" \
      "kube-system:sealed-secrets-controller" \
      "cnpg-system:cnpg-controller-manager"; do
    local ns="${ns_name%%:*}"
    local name="${ns_name#*:}"
    kubectl patch deployment "$name" -n "$ns" \
      --type=strategic \
      --patch="$server_patch" 2>/dev/null || true
  done

  # Runs on every node (DaemonSets) — needs toleration only so it
  # schedules onto tainted servers. Without this, a server that opts
  # into server-only (host-client-workloads=false) would lose
  # ingress-nginx and break public traffic to tenants on other nodes.
  for ns_name in \
      "ingress-nginx:ingress-nginx-controller" \
      "longhorn-system:longhorn-manager" \
      "longhorn-system:longhorn-driver-deployer" \
      "longhorn-system:longhorn-ui" \
      "longhorn-system:csi-attacher" \
      "longhorn-system:csi-provisioner" \
      "longhorn-system:csi-resizer" \
      "longhorn-system:csi-snapshotter"; do
    local ns="${ns_name%%:*}"
    local name="${ns_name#*:}"
    # Try Deployment first, then DaemonSet — some are DaemonSets
    # (ingress-nginx, longhorn-manager), others Deployments (csi-*, UI).
    kubectl patch deployment "$name" -n "$ns" \
      --type=strategic \
      --patch="$toleration_only_patch" 2>/dev/null \
    || kubectl patch daemonset "$name" -n "$ns" \
      --type=strategic \
      --patch="$toleration_only_patch" 2>/dev/null \
    || true
  done

  log "Helm component pinning applied."
}

# M1: apply the platform-managed role + host-client-workloads labels
# (and the server-only taint when applicable) to this node. The backend
# node-sync reconciler treats these labels as authoritative — changing
# them via `kubectl label --overwrite` is the operator-supported path
# to re-role a node after initial provisioning.
#
# Worker caveat: this runs locally with `kubectl` against
# /etc/rancher/k3s/k3s.yaml, which only exists on server nodes. On
# worker nodes we log an instruction for the operator to re-run from
# the control plane; the default unlabeled convention (worker role,
# canHostClientWorkloads=true) matches the migration defaults, so
# most workers don't need this step.
apply_node_labels_and_taints() {
  local node_name
  node_name="$(hostname)"

  if [[ "$NODE_ROLE" == "worker" ]]; then
    log "Worker node labelling must be applied from the control plane."
    log "  After this script completes, run on the server:"
    log "    kubectl label node ${node_name} platform.phoenix-host.net/node-role=worker --overwrite"
    log "    kubectl label node ${node_name} platform.phoenix-host.net/host-client-workloads=${HOST_CLIENT_WORKLOADS} --overwrite"
    log "  (Unlabeled nodes default to worker/true — skipping the above is fine for vanilla workers.)"
    return 0
  fi

  # Server path: kubeconfig is local, kubectl works.
  export KUBECONFIG
  log "Labelling ${node_name}: role=${NODE_ROLE}, host-client-workloads=${HOST_CLIENT_WORKLOADS}"

  # --overwrite makes this idempotent so re-bootstrap / upgrade runs
  # silently no-op if the labels already match.
  kubectl label node "${node_name}" \
    "platform.phoenix-host.net/node-role=${NODE_ROLE}" \
    --overwrite
  kubectl label node "${node_name}" \
    "platform.phoenix-host.net/host-client-workloads=${HOST_CLIENT_WORKLOADS}" \
    --overwrite

  # server + host-client-workloads=false → keep the NoSchedule taint so
  # the scheduler refuses tenant pods. Any other combo → remove it
  # (kubectl taint with a trailing - is the documented delete syntax,
  # 0 status on deletion OR when the taint wasn't present).
  if [[ "$HOST_CLIENT_WORKLOADS" == "false" ]]; then
    log "Applying server-only taint (NoSchedule) — tenant pods will not schedule here."
    kubectl taint node "${node_name}" \
      "platform.phoenix-host.net/server-only=true:NoSchedule" \
      --overwrite
  else
    log "Removing any server-only taint — this server will accept tenant pods."
    kubectl taint node "${node_name}" \
      "platform.phoenix-host.net/server-only:NoSchedule-" \
      2>/dev/null || true
  fi
}

install_k3s() {
  if command -v k3s &>/dev/null; then
    local installed
    installed="$(k3s --version | awk '{print $3}')"
    log "k3s already installed: ${installed}"
    if [[ "$installed" == "$K3S_VERSION" ]]; then
      log "Correct version, skipping k3s install."
      return 0
    fi
    log "Upgrading from ${installed} to ${K3S_VERSION}..."
    # Hard-fail when upgrading a pre-etcd (sqlite) cluster. Running the
    # installer with `--cluster-init` against an existing sqlite datastore
    # would trigger a k3s error mid-way through the install, leaving the
    # cluster in a broken state. The only supported migration path is a
    # fresh rebootstrap (back up data, k3s-uninstall.sh, then re-run this
    # script on an empty node). Detection: the snapshots dir is only
    # populated when the datastore is embedded etcd.
    if [[ "$NODE_ROLE" == "server" ]] \
        && [[ -f /var/lib/rancher/k3s/server/db/state.db ]] \
        && [[ ! -d /var/lib/rancher/k3s/server/db/etcd ]]; then
      error "Upgrade blocked: existing cluster uses the sqlite datastore but this script now installs with --cluster-init (embedded etcd). Back up data, run k3s-uninstall.sh, then re-run this script on the empty node. See docs/02-operations/DISASTER_RECOVERY.md for the supported path."
    fi
  fi

  if [[ "$NODE_ROLE" == "server" ]]; then
    install_k3s_server
  else
    install_k3s_worker
  fi
}

# Resolve the host's IP that falls inside CLUSTER_NETWORK_CIDR. Used to
# pin every cross-node k8s flow onto the private underlay (NetBird wt0,
# Hetzner private net, ZeroTier, etc.). Empty CIDR → empty result and
# the caller falls back to public-IP autodetect. Inputs are passed via
# env-vars rather than string-interpolated into the Python source so the
# helper can't be tricked by exotic CIDR values.
resolve_cluster_network_ip() {
  if [[ -z "$CLUSTER_NETWORK_CIDR" ]]; then
    echo ""
    return 0
  fi
  if ! command -v ip &>/dev/null; then
    error "resolve_cluster_network_ip: 'ip' command missing — install iproute2 first."
  fi
  # `ip -4 -o addr show` returns "iface inet a.b.c.d/n …" lines. Filter
  # to those whose subnet (a.b.c.d/n) matches CLUSTER_NETWORK_CIDR via
  # python's ipaddress for portability across nft/awk/bash CIDR math.
  local ip_output
  ip_output=$(ip -4 -o addr show | awk '{print $4}')
  CLUSTER_NETWORK_CIDR="$CLUSTER_NETWORK_CIDR" python3 - "$ip_output" <<'PYEOF'
import ipaddress, os, sys
target = ipaddress.ip_network(os.environ['CLUSTER_NETWORK_CIDR'], strict=False)
for line in sys.argv[1].splitlines():
    line = line.strip()
    if not line:
        continue
    try:
        addr = ipaddress.ip_interface(line).ip
        if addr in target:
            print(addr)
            sys.exit(0)
    except ValueError:
        pass
PYEOF
}

# Pre-flight: when joining an existing cluster, refuse if the chosen
# advertise-IP isn't in the same CIDR as the existing cluster's peers.
# Catches "server-2 forgot the flag" → mixed public/private etcd.
validate_cluster_network_membership() {
  if [[ -z "$CLUSTER_NETWORK_CIDR" ]]; then
    return 0
  fi
  if [[ -z "$K3S_SERVER_IP" ]]; then
    return 0  # First-server bootstrap; nothing to validate against.
  fi
  CLUSTER_NETWORK_CIDR="$CLUSTER_NETWORK_CIDR" K3S_SERVER_IP="$K3S_SERVER_IP" python3 - <<'PYEOF'
import ipaddress, os, sys
cidr_s = os.environ['CLUSTER_NETWORK_CIDR']
peer_s = os.environ['K3S_SERVER_IP']
cidr = ipaddress.ip_network(cidr_s, strict=False)
peer = ipaddress.ip_address(peer_s)
if peer not in cidr:
    print(f"--server {peer_s} is not inside --cluster-network-cidr {cidr_s}.", file=sys.stderr)
    print("  When the existing cluster is private-network-pinned, --server must be the control-plane's IP within that CIDR (e.g. its NetBird wt0 IP), not its public IP.", file=sys.stderr)
    sys.exit(1)
PYEOF
}

install_k3s_server() {
  log "Installing k3s ${K3S_VERSION} (server)..."
  # Collect all host IPs for TLS SAN (IPv4 + IPv6)
  local tls_sans=""
  for ip in $(hostname -I); do
    tls_sans="${tls_sans} --tls-san=${ip}"
  done

  # M8: joining vs bootstrapping the cluster.
  #   - If --server + --token were passed, this node joins an
  #     existing etcd cluster (uses `server --server <url>` instead
  #     of `--cluster-init`). Use this to grow 1 → 3 → 5 servers.
  #   - Otherwise the first server bootstraps the cluster with
  #     `--cluster-init` (embedded etcd). Same config applies in
  #     both cases; cluster-init just differs by wiring.
  #
  # --cluster-init switches k3s from sqlite datastore to embedded
  # etcd. That:
  #   (1) enables `k3s etcd-snapshot` + populates /var/lib/rancher/k3s/
  #       server/db/snapshots/, which the platform-etcd-snapshot-upload
  #       CronJob hostPath-mounts for DR backups.
  #   (2) makes the cluster HA-ready — additional server nodes can join
  #       later without a reinstall (would require --server + --token).
  #   (3) costs ~50-200 MB RAM for the embedded etcd vs sqlite. Worth it
  #       for production-aligned topology + DR tooling compatibility.
  #
  # One-way: removing --cluster-init on a re-run requires a full cluster
  # rebuild. Existing pre-etcd clusters must rebootstrap to migrate.
  local init_or_join
  if [[ -n "$K3S_SERVER_IP" && -n "$K3S_TOKEN" ]]; then
    log "  joining existing cluster at ${K3S_SERVER_IP}..."
    init_or_join="--server=https://${K3S_SERVER_IP}:6443 --token=${K3S_TOKEN}"
  else
    log "  bootstrapping new cluster (--cluster-init)..."
    init_or_join="--cluster-init"
  fi

  # M12: private-network underlay. When --cluster-network-cidr is set,
  # pin etcd peer / apiserver / kubelet onto the host's IP from that
  # CIDR. The public IP becomes --node-external-ip (announced to peers
  # but not used for bind). Refuses asymmetric joins via the pre-flight
  # check above.
  #
  # k3s requires --node-ip and --cluster-cidr share IP versions: an
  # IPv4-only --node-ip with dual-stack --cluster-cidr is fatal. So
  # when the underlay is IPv4-only (NetBird CGNAT, Tailscale, most
  # provider private nets), we drop IPv6 from cluster/service CIDRs.
  local node_pin=""
  local cluster_cidr_arg="10.42.0.0/16,fd42::/48"
  local service_cidr_arg="10.43.0.0/16,fd43::/112"
  if [[ -n "$CLUSTER_NETWORK_CIDR" ]]; then
    local private_ip public_ip
    private_ip=$(resolve_cluster_network_ip)
    if [[ -z "$private_ip" ]]; then
      error "No host IP found inside --cluster-network-cidr ${CLUSTER_NETWORK_CIDR}. If using NetBird/Tailscale/etc, bring the overlay up first (or pass --netbird-management-url + --netbird-setup-key)."
    fi
    public_ip=$(hostname -I | awk '{print $1}')
    log "  private-network mode: --node-ip=${private_ip} --node-external-ip=${public_ip} --advertise-address=${private_ip}"
    log "  IPv4-only cluster/service CIDR (private underlay is IPv4-only)"
    node_pin="--node-ip=${private_ip} --node-external-ip=${public_ip} --advertise-address=${private_ip} --bind-address=0.0.0.0"
    cluster_cidr_arg="10.42.0.0/16"
    service_cidr_arg="10.43.0.0/16"
    # Add private IP to TLS SANs too, otherwise apiserver cert won't
    # match when peers (and operators) connect via the private IP.
    tls_sans="${tls_sans} --tls-san=${private_ip}"
  fi

  # shellcheck disable=SC2086
  curl -sfL https://get.k3s.io | \
    INSTALL_K3S_VERSION="$K3S_VERSION" \
    INSTALL_K3S_EXEC="server" \
    sh -s - \
      ${init_or_join} \
      ${node_pin} \
      --flannel-backend=none \
      --disable-network-policy \
      --disable=traefik \
      --disable=servicelb \
      --write-kubeconfig-mode=644 \
      --cluster-cidr=${cluster_cidr_arg} \
      --service-cidr=${service_cidr_arg} \
      ${tls_sans}

  log "Waiting for k3s API server..."
  local _attempt
  for _attempt in $(seq 1 60); do
    if kubectl --kubeconfig="$KUBECONFIG" get nodes &>/dev/null; then
      log "k3s API server is ready."
      return 0
    fi
    sleep 2
  done
  error "k3s API server did not become ready within 120 seconds."
}

install_k3s_worker() {
  log "Installing k3s ${K3S_VERSION} (worker — joining ${K3S_SERVER_IP})..."

  # M12: private-network underlay (see install_k3s_server for context).
  # K3S_NODE_IP env var alone is not enough — k3s install.sh writes the
  # env file but the agent's ExecStart line is just `/usr/local/bin/k3s
  # agent` with no flags, and kubelet then auto-detects (picks public
  # eth0 + IPv6). We bake --node-ip / --node-external-ip into the
  # ExecStart via INSTALL_K3S_EXEC, which install.sh translates into
  # the systemd unit's command line. (Tested 2026-04-25 — env-var alone
  # left INTERNAL-IP=public on the Node object.)
  local exec_args="agent"
  if [[ -n "$CLUSTER_NETWORK_CIDR" ]]; then
    local private_ip public_ip
    private_ip=$(resolve_cluster_network_ip)
    if [[ -z "$private_ip" ]]; then
      error "No host IP found inside --cluster-network-cidr ${CLUSTER_NETWORK_CIDR}. If using NetBird/Tailscale/etc, bring the overlay up first (or pass --netbird-management-url + --netbird-setup-key)."
    fi
    public_ip=$(hostname -I | awk '{print $1}')
    log "  private-network mode: --node-ip=${private_ip} --node-external-ip=${public_ip}"
    exec_args="agent --node-ip=${private_ip} --node-external-ip=${public_ip}"
  fi

  curl -sfL https://get.k3s.io | \
    INSTALL_K3S_VERSION="$K3S_VERSION" \
    INSTALL_K3S_EXEC="$exec_args" \
    K3S_URL="https://${K3S_SERVER_IP}:6443" \
    K3S_TOKEN="$K3S_TOKEN" \
    sh -

  log "Waiting for k3s agent to register..."
  local _attempt
  for _attempt in $(seq 1 30); do
    if systemctl is-active --quiet k3s-agent; then
      log "k3s agent is running."
      return 0
    fi
    sleep 2
  done
  error "k3s agent did not start within 60 seconds."
}

install_calico() {
  export KUBECONFIG

  if kubectl get namespace calico-system &>/dev/null 2>&1; then
    log "Calico already installed, skipping."
    return 0
  fi

  log "Installing Calico ${CALICO_VERSION}..."

  kubectl create -f "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/tigera-operator.yaml" || true

  log "Waiting for Calico operator..."
  kubectl wait --for=condition=available --timeout=120s \
    deployment/tigera-operator -n tigera-operator 2>/dev/null || true

  # The tigera-operator manifest declares its own CRDs (Installation,
  # APIServer, etc.) but they register asynchronously after the operator
  # Deployment reports Available. Poll until the CRDs exist, then wait
  # for them to be Established.
  log "Waiting for Calico CRDs to register..."
  for crd in installations.operator.tigera.io apiservers.operator.tigera.io; do
    for _ in $(seq 1 60); do
      kubectl get crd "$crd" &>/dev/null && break
      sleep 2
    done
    kubectl wait --for=condition=established --timeout=60s crd/"$crd" || {
      warn "CRD $crd not established after 60s — will try anyway"
    }
  done

  # Calico networking config (2026-04-25):
  #   * encapsulation: VXLAN (always-on, not VXLANCrossSubnet) — production
  #     workers may live in different subnets than the server; "CrossSubnet"
  #     mode falls back to BGP between same-subnet peers, which then needs
  #     a working BIRD daemon. Always-on VXLAN removes BGP from the path
  #     entirely and works identically same-subnet vs cross-subnet.
  #   * bgp: Disabled — no BIRD process, one less failure surface.
  #   * mtu: 1450 — 1500 underlay − 50 VXLAN overhead.
  #   * BOTH ipPools must share encapsulation when bgp:Disabled — the
  #     operator rejects mixed VXLAN/None with "unencapsulated IP pools
  #     require that BGP is enabled".
  #   * nodeAddressAutodetectionV4.cidrs (M12) — pin Calico's VXLAN
  #     tunnel endpoint onto the private network (NetBird/Tailscale/
  #     etc.) when --cluster-network-cidr is set. Without this, Calico
  #     picks the first-found interface (typically the public eth0).
  # Workers join over UDP/4789 (VXLAN); see configure_firewall().
  local autodetect_block=""
  local ipv6_pool=""
  if [[ -n "$CLUSTER_NETWORK_CIDR" ]]; then
    autodetect_block="    nodeAddressAutodetectionV4:
      cidrs:
      - ${CLUSTER_NETWORK_CIDR}"
    # IPv4-only underlay → drop the IPv6 ipPool. Mixed v4/v6 with
    # bgp:Disabled is rejected anyway, and k3s was launched with
    # IPv4-only cluster-cidr in install_k3s_server.
  else
    ipv6_pool="    - blockSize: 122
      cidr: fd42::/48
      encapsulation: VXLAN
      natOutgoing: Disabled
      nodeSelector: all()"
  fi

  cat <<EOF | kubectl apply -f -
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    bgp: Disabled
    mtu: 1450
${autodetect_block}
    ipPools:
    - blockSize: 26
      cidr: 10.42.0.0/16
      encapsulation: VXLAN
      natOutgoing: Enabled
      nodeSelector: all()
${ipv6_pool}
---
apiVersion: operator.tigera.io/v1
kind: APIServer
metadata:
  name: default
spec: {}
EOF

  log "Waiting for Calico pods..."
  sleep 10
  kubectl wait --for=condition=ready pod -l k8s-app=calico-node \
    -n calico-system --timeout=180s 2>/dev/null \
    || warn "Calico pods not ready yet — they may need more time."

  marker_set "calico-installed"
  log "Calico CNI installed."
}

# ─── Phase 3: Platform Components ────────────────────────────────────────────

install_helm() {
  if command -v helm &>/dev/null; then
    log "Helm already installed: $(helm version --short)"
    return 0
  fi

  log "Installing Helm..."
  curl -fsSL https://raw.githubusercontent.com/helm/helm/main/scripts/get-helm-3 | bash
  log "Helm installed."
}

install_flux_cli() {
  if [[ "$SKIP_FLUX" == true ]]; then return 0; fi

  if command -v flux &>/dev/null; then
    log "Flux CLI already installed."
    return 0
  fi

  log "Installing Flux CLI..."
  curl -fsSL https://fluxcd.io/install.sh | bash
  log "Flux CLI installed."
}

helm_cmd() {
  helm --kubeconfig="$KUBECONFIG" "$@"
}

kctl() {
  kubectl --kubeconfig="$KUBECONFIG" "$@"
}

install_nginx_ingress() {
  if kctl get deployment -n ingress-nginx ingress-nginx-controller &>/dev/null 2>&1; then
    log "NGINX Ingress already installed, skipping."
    return 0
  fi

  log "Installing NGINX Ingress Controller..."
  helm_cmd repo add ingress-nginx https://kubernetes.github.io/ingress-nginx 2>/dev/null || true
  helm_cmd repo update

  helm_cmd upgrade --install ingress-nginx ingress-nginx/ingress-nginx \
    --namespace ingress-nginx \
    --create-namespace \
    --version "${INGRESS_NGINX_CHART_VERSION}" \
    --set controller.kind=DaemonSet \
    --set controller.hostPort.enabled=true \
    --set controller.service.type=ClusterIP \
    --set controller.hostNetwork=true \
    --set controller.dnsPolicy=ClusterFirstWithHostNet \
    --set controller.config.ssl-redirect=false \
    --set controller.config.force-ssl-redirect=false \
    --set controller.metrics.enabled=true \
    --set controller.allowSnippetAnnotations=false \
    --set controller.config.use-gzip=true \
    --set controller.config.gzip-level=5 \
    --set controller.config.gzip-min-length=256 \
    --set controller.config.enable-brotli=true \
    --set controller.config.brotli-level=6 \
    --set controller.config.brotli-min-length=256 \
    --wait \
    --timeout 300s

  log "NGINX Ingress Controller installed."
}

install_cert_manager() {
  if kctl get deployment -n cert-manager cert-manager &>/dev/null 2>&1; then
    log "cert-manager already installed, skipping."
    return 0
  fi

  log "Installing cert-manager..."
  helm_cmd repo add jetstack https://charts.jetstack.io 2>/dev/null || true
  helm_cmd repo update

  helm_cmd upgrade --install cert-manager jetstack/cert-manager \
    --namespace cert-manager \
    --create-namespace \
    --version "${CERT_MANAGER_CHART_VERSION}" \
    --set crds.enabled=true \
    --set prometheus.enabled=true \
    --wait \
    --timeout 300s

  local le_email="${ACME_EMAIL:-admin@${PLATFORM_DOMAIN}}"
  kctl apply -f - <<EOF
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-staging-http01
spec:
  acme:
    server: https://acme-staging-v02.api.letsencrypt.org/directory
    email: ${le_email}
    privateKeySecretRef:
      name: letsencrypt-staging-account-key
    solvers:
    - http01:
        ingress:
          ingressClassName: nginx
---
apiVersion: cert-manager.io/v1
kind: ClusterIssuer
metadata:
  name: letsencrypt-prod-http01
spec:
  acme:
    server: https://acme-v02.api.letsencrypt.org/directory
    email: ${le_email}
    privateKeySecretRef:
      name: letsencrypt-prod-account-key
    solvers:
    - http01:
        ingress:
          ingressClassName: nginx
EOF

  log "cert-manager installed with Let's Encrypt issuers (email=${le_email})."
}

install_sealed_secrets() {
  if kctl get deployment -n kube-system sealed-secrets-controller &>/dev/null 2>&1; then
    log "Sealed Secrets already installed, skipping."
    return 0
  fi

  log "Installing Sealed Secrets..."
  helm_cmd repo add sealed-secrets https://bitnami-labs.github.io/sealed-secrets 2>/dev/null || true
  helm_cmd repo update

  helm_cmd upgrade --install sealed-secrets sealed-secrets/sealed-secrets \
    --namespace kube-system \
    --version "${SEALED_SECRETS_CHART_VERSION}" \
    --set fullnameOverride=sealed-secrets-controller \
    --wait \
    --timeout 300s

  log "Sealed Secrets controller installed."
}

install_longhorn() {
  if [[ "$SKIP_LONGHORN" == true ]]; then
    log "Skipping Longhorn (--skip-longhorn). Using local-path for storage."
    return 0
  fi

  if kctl get deployment -n longhorn-system longhorn-driver-deployer &>/dev/null 2>&1; then
    log "Longhorn already installed, skipping."
    return 0
  fi

  log "Installing Longhorn distributed storage..."

  # Prerequisites should already be installed (open-iscsi, nfs-common)
  systemctl enable --now iscsid 2>/dev/null || true

  helm_cmd repo add longhorn https://charts.longhorn.io 2>/dev/null || true
  helm_cmd repo update

  helm_cmd upgrade --install longhorn longhorn/longhorn \
    --namespace longhorn-system \
    --create-namespace \
    --version "${LONGHORN_VERSION}" \
    --set defaultSettings.defaultReplicaCount=1 \
    --set defaultSettings.replicaAutoBalance=best-effort \
    --set defaultSettings.storageMinimalAvailablePercentage=15 \
    --set defaultSettings.defaultDataLocality=best-effort \
    --wait \
    --timeout 600s

  # Set Longhorn as the default StorageClass, demote local-path
  kctl patch storageclass local-path -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}' 2>/dev/null || true
  kctl patch storageclass longhorn -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}' 2>/dev/null || true

  marker_set "longhorn-installed"
  log "Longhorn installed (replicas=1, auto-balance=best-effort). Add nodes to increase replicas."
}

# M10: CloudNative-PG (CNPG) operator — passive install.
#
# The operator watches for `Cluster` CRs and orchestrates
# active-passive Postgres replication. We install the operator
# unconditionally on server nodes (unless --skip-cnpg) so flipping
# the Postgres topology to replicated in the future is a single-CR
# apply — no operator migration needed when the cluster crosses
# the 3-server HA threshold (M8).
#
# No Cluster CR is applied here; the existing platform Postgres
# StatefulSet keeps running unchanged. Activation is a manual
# operator step with pre-reqs (existing-PVC import, failover plan,
# monitoring review) — see
# docs/09-runbooks/CNPG_ACTIVATION_RUNBOOK.md.
#
# Installed in its own namespace (cnpg-system) so a later
# `helm uninstall` reverts cleanly without touching other platform
# state.
install_cnpg() {
  if [[ "$SKIP_CNPG" == true ]]; then
    log "Skipping CloudNative-PG operator (--skip-cnpg)."
    return 0
  fi

  if kctl get deployment -n cnpg-system cnpg-controller-manager &>/dev/null 2>&1; then
    log "CloudNative-PG operator already installed, skipping."
    return 0
  fi

  log "Installing CloudNative-PG operator (passive — no Cluster CR applied)..."
  helm_cmd repo add cnpg https://cloudnative-pg.github.io/charts 2>/dev/null || true
  helm_cmd repo update

  helm_cmd upgrade --install cnpg cnpg/cloudnative-pg \
    --namespace cnpg-system \
    --create-namespace \
    --version "${CNPG_CHART_VERSION}" \
    --set monitoring.podMonitorEnabled=false \
    --wait \
    --timeout 300s

  log "CloudNative-PG operator installed passively."
  log "  To activate Postgres replication, see:"
  log "  docs/09-runbooks/CNPG_ACTIVATION_RUNBOOK.md"
}

install_monitoring() {
  if [[ "$ENABLE_MONITORING" != true ]]; then
    log "Skipping monitoring stack (use --with-monitoring to install)."
    return 0
  fi

  if kctl get statefulset -n monitoring prometheus-kube-prometheus-prometheus &>/dev/null 2>&1; then
    log "Prometheus already installed, skipping."
  else
    log "Installing kube-prometheus-stack..."
    helm_cmd repo add prometheus-community https://prometheus-community.github.io/helm-charts 2>/dev/null || true
    helm_cmd repo update

    helm_cmd upgrade --install kube-prometheus prometheus-community/kube-prometheus-stack \
      --namespace monitoring \
      --create-namespace \
      --set prometheus.prometheusSpec.retention=7d \
      --set prometheus.prometheusSpec.resources.requests.memory=512Mi \
      --set prometheus.prometheusSpec.resources.requests.cpu=250m \
      --set prometheus.prometheusSpec.resources.limits.memory=1Gi \
      --set grafana.enabled=true \
      --set grafana.adminPassword=change-me \
      --set alertmanager.enabled=true \
      --wait \
      --timeout 600s

    log "kube-prometheus-stack installed."
  fi

  if kctl get statefulset -n monitoring loki &>/dev/null 2>&1; then
    log "Loki already installed, skipping."
  else
    log "Installing Loki..."
    helm_cmd repo add grafana https://grafana.github.io/helm-charts 2>/dev/null || true
    helm_cmd repo update

    helm_cmd upgrade --install loki grafana/loki-stack \
      --namespace monitoring \
      --create-namespace \
      --set loki.persistence.enabled=true \
      --set loki.persistence.size=5Gi \
      --set promtail.enabled=true \
      --wait \
      --timeout 300s

    log "Loki + Promtail installed."
  fi
}

install_flux() {
  if [[ "$SKIP_FLUX" == true ]]; then
    log "Skipping Flux v2 (--skip-flux)."
    return 0
  fi

  if kctl get deployment -n flux-system source-controller &>/dev/null 2>&1; then
    log "Flux already installed, skipping."
    return 0
  fi

  log "Installing Flux v2..."
  local flux_extra=""
  if [[ "$PLATFORM_ENV" == "staging" ]]; then
    flux_extra="--components-extra=image-reflector-controller,image-automation-controller"
  fi
  flux install --kubeconfig="$KUBECONFIG" --timeout=300s $flux_extra

  # Determine which branch Flux should watch
  local flux_branch="main"
  if [[ "$PLATFORM_ENV" == "staging" ]]; then
    flux_branch="staging"
  elif [[ "$PLATFORM_ENV" == "production" ]]; then
    flux_branch="stable"
  fi

  # Source name must match the declarative GitRepository YAML names
  local source_name="hosting-platform"
  if [[ "$PLATFORM_ENV" == "staging" ]]; then
    source_name="hosting-platform-staging"
  elif [[ "$PLATFORM_ENV" == "production" ]]; then
    source_name="hosting-platform-stable"
  fi

  log "Configuring Flux source and kustomization for ${PLATFORM_ENV} (branch=${flux_branch}, source=${source_name})..."
  flux create source git "$source_name" \
    --url="$REPO_URL" \
    --branch="$flux_branch" \
    --interval=1m \
    --kubeconfig="$KUBECONFIG"

  flux create kustomization platform \
    --source="$source_name" \
    --path="./k8s/overlays/${PLATFORM_ENV}" \
    --prune=true \
    --interval=1m \
    --kubeconfig="$KUBECONFIG"

  if [[ "$PLATFORM_ENV" == "staging" ]]; then
    warn "Image automation requires GitHub push credentials for the staging branch."
    warn "Create the flux-github-auth secret before enabling automation:"
    warn "  kubectl create secret generic flux-github-auth -n flux-system \\"
    warn "    --from-literal=username=x-access-token \\"
    warn "    --from-literal=password=<GITHUB_PAT>"
  fi

  log "Flux v2 installed and configured for ${PLATFORM_ENV} (branch=${flux_branch})."
}

generate_platform_secrets() {
  log "Generating platform secrets..."

  # Ensure the `platform` namespace exists BEFORE we try to write Secrets
  # into it. `apply_platform_manifests` creates it via k8s/base/namespaces.yaml
  # later in the flow — but the Secret writes below run first, so without
  # this, fresh-VM bootstraps fail with "namespaces 'platform' not found".
  # Idempotent: kubectl create --dry-run=client applies are no-ops on
  # pre-existing namespaces.
  kctl create namespace platform --dry-run=client -o yaml | kctl apply -f -

  # Only create secrets if they don't already exist
  if kctl get secret -n platform platform-db-credentials &>/dev/null 2>&1; then
    log "DB credentials secret already exists, skipping."
  else
    local db_password
    db_password="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"

    kctl create secret generic platform-db-credentials \
      --namespace=platform \
      --from-literal=password="$db_password" \
      --from-literal=url="postgresql://platform:${db_password}@postgres.platform.svc.cluster.local:5432/hosting_platform"
    log "DB credentials secret created."
  fi

  if kctl get secret -n platform platform-jwt-secret &>/dev/null 2>&1; then
    log "JWT secret already exists, skipping."
  else
    local jwt_secret
    jwt_secret="$(openssl rand -base64 48 | tr -d '/+=' | head -c 64)"

    kctl create secret generic platform-jwt-secret \
      --namespace=platform \
      --from-literal=secret="$jwt_secret"
    log "JWT secret created."
  fi

  if kctl get secret -n platform platform-secrets &>/dev/null 2>&1; then
    log "Platform secrets already exist, skipping."
  else
    local oidc_key
    oidc_key="$(openssl rand -hex 32)"
    local internal_secret
    internal_secret="$(openssl rand -base64 48 | tr -d '/+=' | head -c 64)"

    kctl create secret generic platform-secrets \
      --namespace=platform \
      --from-literal=oidc-encryption-key="$oidc_key" \
      --from-literal=internal-secret="$internal_secret"
    log "Platform secrets created."
  fi

  # OAuth2 Proxy config secret — generated per-environment with unique OIDC client secrets
  if kctl get secret -n platform oauth2-proxy-config &>/dev/null 2>&1; then
    log "OAuth2 Proxy config secret already exists, skipping."
  else
    local oidc_client_secret
    oidc_client_secret="$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)"
    local cookie_secret
    cookie_secret="$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)"

    local issuer_url=""
    local redirect_url=""
    if [[ "$PLATFORM_ENV" == "dev" ]]; then
      issuer_url="http://dex.${PLATFORM_DOMAIN}/dex"
      redirect_url="http://${PLATFORM_DOMAIN}/oauth2/callback"
    elif [[ "$PLATFORM_ENV" == "staging" ]]; then
      issuer_url="https://dex.${PLATFORM_DOMAIN}/dex"
      redirect_url="https://${PLATFORM_DOMAIN}/oauth2/callback"
    else
      # Production: operator must configure external OIDC issuer
      issuer_url="${OIDC_ISSUER_URL:-https://auth.${PLATFORM_DOMAIN}}"
      redirect_url="https://${PLATFORM_DOMAIN}/oauth2/callback"
    fi

    kctl create secret generic oauth2-proxy-config \
      --namespace=platform \
      --from-literal=OIDC_ISSUER_URL="$issuer_url" \
      --from-literal=OAUTH2_PROXY_CLIENT_ID="hosting-platform-oauth2-proxy" \
      --from-literal=OAUTH2_PROXY_CLIENT_SECRET="$oidc_client_secret" \
      --from-literal=OAUTH2_PROXY_COOKIE_SECRET="$cookie_secret" \
      --from-literal=OAUTH2_PROXY_REDIRECT_URL="$redirect_url"
    log "OAuth2 Proxy config secret created (env=${PLATFORM_ENV})."
  fi

  # sftp-gateway needs an ed25519 host key mounted as `sftp-host-keys`
  # in the platform-system namespace. Only local.sh generated this
  # historically; add it here so real-server bootstraps don't leave
  # sftp-gateway stuck in ContainerCreating waiting for the secret.
  kctl create namespace platform-system 2>/dev/null || true
  if kctl get secret -n platform-system sftp-host-keys &>/dev/null 2>&1; then
    log "SFTP host keys secret already exists, skipping."
  else
    local sftp_tmp
    sftp_tmp="$(mktemp -d)"
    ssh-keygen -t ed25519 -N "" -f "${sftp_tmp}/ssh_host_ed25519_key" -q
    kctl create secret generic sftp-host-keys \
      --namespace=platform-system \
      --from-file=ssh_host_ed25519_key="${sftp_tmp}/ssh_host_ed25519_key"
    rm -rf "$sftp_tmp"
    log "SFTP host keys secret created."
  fi

  # sftp-gateway also references platform-secrets (for OIDC_ENCRYPTION_KEY
  # used to decrypt mailbox credentials). Mirror the secret to
  # platform-system so the sftp-gateway Deployment can mount it there
  # without cross-namespace secret references (which k8s doesn't support).
  if kctl get secret -n platform-system platform-secrets &>/dev/null 2>&1; then
    log "platform-secrets already mirrored to platform-system, skipping."
  else
    kctl get secret -n platform platform-secrets -o yaml \
      | sed -E "s|namespace: platform$|namespace: platform-system|" \
      | grep -vE "resourceVersion|uid|creationTimestamp|ownerReferences" \
      | kctl apply -f - >/dev/null
    log "platform-secrets mirrored to platform-system namespace."
  fi

  # The backend's db/seed.js refuses to seed the default admin user
  # unless ADMIN_PASSWORD is set in the platform-api pod env. Generate
  # one, inject as a Secret, and persist to /etc/platform/admin-credentials
  # on the node for the operator. Deployment/platform-api picks it up
  # via envFrom on this secret (see k8s/base/platform/api.yaml).
  if kctl get secret -n platform platform-admin-seed &>/dev/null 2>&1; then
    log "Admin seed credentials already exist, skipping."
  else
    local admin_email="${ADMIN_EMAIL:-admin@${PLATFORM_DOMAIN:-k8s-platform.test}}"
    local admin_password
    admin_password="$(openssl rand -base64 24 | tr -d '/+=' | head -c 20)"
    kctl create secret generic platform-admin-seed \
      --namespace=platform \
      --from-literal=ADMIN_EMAIL="$admin_email" \
      --from-literal=ADMIN_PASSWORD="$admin_password"
    mkdir -p /etc/platform
    umask 077
    cat > /etc/platform/admin-credentials <<EOF
# Generated by bootstrap.sh — do not commit. Chmod 600. Remove after
# creating a real admin user via the Admin Panel.
ADMIN_EMAIL=$admin_email
ADMIN_PASSWORD=$admin_password
EOF
    chmod 600 /etc/platform/admin-credentials
    log "Admin seed credentials written to /etc/platform/admin-credentials."
    log "  Login: $admin_email / $admin_password"
  fi
}

create_platform_configmap() {
  log "Creating platform-config ConfigMap (environment=${PLATFORM_ENV})..."

  local issuer_name="${CLUSTER_ISSUER_NAME:-letsencrypt-prod-http01}"
  if [[ "$PLATFORM_ENV" == "staging" && -z "${CLUSTER_ISSUER_NAME:-}" ]]; then
    issuer_name="letsencrypt-staging-http01"
  elif [[ "$PLATFORM_ENV" == "dev" && -z "${CLUSTER_ISSUER_NAME:-}" ]]; then
    issuer_name="local-ca-issuer"
  fi

  # Support-email default: reuse the operator's ACME email if available —
  # that's already a verified contact address, and the operator typically
  # wants support requests to route to them on a fresh install. Override
  # post-install via the System Settings UI.
  local support_email="${SUPPORT_EMAIL:-${ACME_EMAIL:-}}"
  local platform_name_value="${PLATFORM_NAME:-Hosting Platform}"

  kctl create configmap platform-config \
    --namespace=platform \
    --from-literal=environment="$PLATFORM_ENV" \
    --from-literal=version="0.0.0" \
    --from-literal=default-storage-class="${DEFAULT_STORAGE_CLASS:-longhorn}" \
    --from-literal=cluster-issuer-name="$issuer_name" \
    --from-literal=ingress-base-domain="${PLATFORM_DOMAIN:-}" \
    --from-literal=platform-base-domain="${PLATFORM_DOMAIN:-}" \
    --from-literal=ingress-default-ipv4="${PUBLIC_IP:-}" \
    --from-literal=api-url="https://api.${PLATFORM_DOMAIN:-localhost}" \
    --from-literal=admin-url="https://admin.${PLATFORM_DOMAIN:-localhost}" \
    --from-literal=client-url="https://client.${PLATFORM_DOMAIN:-localhost}" \
    --from-literal=cors-origins="https://admin.${PLATFORM_DOMAIN:-localhost},https://client.${PLATFORM_DOMAIN:-localhost}" \
    --from-literal=support-email="$support_email" \
    --from-literal=support-url="${SUPPORT_URL:-}" \
    --from-literal=platform-name="$platform_name_value" \
    --from-literal=platform-tls-secret-name="${PLATFORM_TLS_SECRET_NAME:-platform-tls}" \
    --dry-run=client -o yaml | kctl apply -f -
  log "platform-config ConfigMap applied (issuer=${issuer_name})."
}

generate_operator_recipient() {
  # The operator holds the age private key that decrypts backup bundles.
  # The public half (recipient) goes into the platform-operator-recipient
  # ConfigMap; the secrets-backup CronJob reads it and encrypts-to-many
  # without ever needing the private key on-cluster.
  #
  # Idempotent: if the ConfigMap already exists and --force-rotate-
  # operator-key was NOT passed, leave everything alone. Re-running the
  # bootstrap must not regenerate the key by accident — that would
  # invalidate every pre-existing backup.
  #
  # Public OSS repo: the private key MUST NOT be persisted anywhere on
  # disk. We print it to stderr with loud banners and rely on the
  # operator to capture it. `age-keygen` writes to a tmpfile under
  # /dev/shm so it never hits non-volatile storage even briefly.
  log "Configuring operator age recipient..."

  if [[ "$FORCE_ROTATE_OPERATOR_KEY" != true ]] && kctl get configmap platform-operator-recipient -n platform >/dev/null 2>&1; then
    log "platform-operator-recipient ConfigMap already exists, skipping (use --force-rotate-operator-key to regenerate)."
    return 0
  fi

  local recipient=""
  if [[ -n "$OPERATOR_AGE_RECIPIENT" ]]; then
    # Operator supplied the public half — validate shape and use as-is.
    # Accept comma-separated list for team-held multi-recipient setups.
    local part
    IFS=',' read -ra _parts <<< "$OPERATOR_AGE_RECIPIENT"
    for part in "${_parts[@]}"; do
      part="${part# }"; part="${part% }"
      if [[ ! "$part" =~ ^age1[a-z0-9]{48,}$ ]]; then
        error "Invalid age recipient: '${part}'. Expected an 'age1...' Bech32 string."
      fi
    done
    recipient="$OPERATOR_AGE_RECIPIENT"
    log "Using operator-provided recipient(s) — no keypair generated."
  else
    if ! command -v age-keygen >/dev/null 2>&1; then
      error "age-keygen not found on PATH. Run install_packages first, or install the 'age' package."
    fi
    # Write to tmpfs so the private key never lands on the root
    # filesystem's journal. Best-effort — /dev/shm is world-writable but
    # this process is already root and only we read it immediately below.
    # mktemp creates the file, but age-keygen -o refuses to overwrite an
    # existing file, so we delete it immediately and rely on age-keygen
    # to recreate. The window is tiny and we're root in this process.
    local tmpkey
    tmpkey="$(mktemp --tmpdir=/dev/shm bootstrap-age.XXXXXX 2>/dev/null || mktemp)"
    rm -f "$tmpkey"
    # age-keygen emits the private key AND a comment line with the public
    # recipient. Capture both, then shred the file.
    if ! age-keygen -o "$tmpkey" 2>/dev/null; then
      rm -f "$tmpkey"
      error "age-keygen failed to write key to ${tmpkey}."
    fi
    chmod 600 "$tmpkey"
    recipient="$(grep -E '^# public key:' "$tmpkey" | awk '{print $NF}')"
    local private_key
    private_key="$(grep -v '^#' "$tmpkey")"
    if [[ -z "$recipient" || -z "$private_key" ]]; then
      rm -f "$tmpkey"
      error "age-keygen produced empty key material — refusing to continue."
    fi

    # Shred + remove. `shred` isn't in base Debian installs via coreutils'
    # /usr/bin; the alternative is overwrite-then-unlink which works on
    # any filesystem (including tmpfs where shred is a no-op anyway).
    : > "$tmpkey"
    rm -f "$tmpkey"

    # Loud banner to stderr. Operator MUST save this — it is the only
    # copy that will ever exist, and backup decryption depends on it.
    {
      echo ""
      echo "╔════════════════════════════════════════════════════════════════╗"
      echo "║  OPERATOR AGE PRIVATE KEY — SAVE THIS NOW                      ║"
      echo "║                                                                ║"
      echo "║  This key decrypts every backup bundle this cluster produces.  ║"
      echo "║  Losing it = backups unrecoverable.                            ║"
      echo "║  Leaking it = anyone can decrypt the backups.                  ║"
      echo "║                                                                ║"
      echo "║  Store in: password manager (1Password/Bitwarden) AND an       ║"
      echo "║            offline paper/metal backup. Do not commit to git.   ║"
      echo "║                                                                ║"
      echo "║  Public recipient (safe to share):                             ║"
      echo "║    ${recipient}"
      echo "║                                                                ║"
      echo "║  Private key (SECRET — save and delete from terminal scroll):  ║"
      echo "║    ${private_key}"
      echo "║                                                                ║"
      echo "║  See docs/02-operations/OPERATOR_KEY_SETUP.md for more.        ║"
      echo "╚════════════════════════════════════════════════════════════════╝"
      echo ""
    } >&2
  fi

  # ConfigMap is intentionally simple — a single `recipient` key the
  # secrets-backup CronJob reads into $OPERATOR_RECIPIENT. Replace-ok
  # because a rotation is expected to be deliberate (the existence-gate
  # at the top of this function handles the idempotent no-op path).
  kctl create configmap platform-operator-recipient \
    --namespace=platform \
    --from-literal=recipient="$recipient" \
    --dry-run=client -o yaml | kctl apply -f -
  log "platform-operator-recipient ConfigMap applied."
}

apply_platform_manifests() {
  log "Applying platform manifests..."

  # Clone repo if not already in it
  local repo_dir=""
  if [[ -f "k8s/base/kustomization.yaml" ]]; then
    repo_dir="."
  elif [[ -f "/opt/k8s-hosting-platform/k8s/base/kustomization.yaml" ]]; then
    repo_dir="/opt/k8s-hosting-platform"
  else
    log "Cloning platform repository..."
    git clone --depth 1 "$REPO_URL" /opt/k8s-hosting-platform 2>/dev/null || true
    repo_dir="/opt/k8s-hosting-platform"
  fi

  if [[ ! -d "${repo_dir}/k8s/base" ]]; then
    warn "k8s/base directory not found, skipping manifest application."
    return 0
  fi

  # Compute hostnames from --domain (operator provides the full base domain)
  local api_host="api.${PLATFORM_DOMAIN}"
  local admin_host="admin.${PLATFORM_DOMAIN}"
  local client_host="client.${PLATFORM_DOMAIN}"
  log "Hostnames: ${api_host}, ${admin_host}, ${client_host}"

  # Generate the environment overlay with real hostnames.
  # For staging, preserve the checked-in kustomization.yaml (contains
  # Flux image policy markers) and only write an ingress patch file.
  local overlay_dir="${repo_dir}/k8s/overlays/${PLATFORM_ENV}"
  mkdir -p "$overlay_dir"

  if [[ "$PLATFORM_ENV" == "staging" && -f "${overlay_dir}/kustomization.yaml" ]]; then
    log "Staging: preserving existing kustomization.yaml (image policy markers)."
    log "Writing ingress hostname patch only."
    cat > "${overlay_dir}/ingress-hosts-patch.yaml" <<PATCH
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: platform-ingress
  namespace: platform
spec:
  tls:
    - hosts:
        - ${api_host}
        - ${admin_host}
        - ${client_host}
      secretName: platform-tls
  rules:
    - host: ${api_host}
    - host: ${admin_host}
    - host: ${client_host}
PATCH
    # Add patch reference if not already in kustomization.yaml
    if ! grep -q "ingress-hosts-patch.yaml" "${overlay_dir}/kustomization.yaml"; then
      log "Adding ingress-hosts-patch.yaml to staging kustomization."
      sed -i '/^patches:/a\  - path: ingress-hosts-patch.yaml' "${overlay_dir}/kustomization.yaml"
    fi
    # Replace Dex PLACEHOLDER URLs and inject generated client secrets
    local dex_config="${overlay_dir}/dex/config.yaml"
    if [[ -f "$dex_config" ]]; then
      log "Updating Dex config with domain ${PLATFORM_DOMAIN}..."
      local dex_host="dex.${PLATFORM_DOMAIN}"
      sed -i "s|PLACEHOLDER.example.com|${PLATFORM_DOMAIN}|g" "$dex_config"
      sed -i "s|issuer:.*|issuer: https://${dex_host}/dex|" "$dex_config"
      # Replace hardcoded client secrets with the generated oauth2-proxy secret
      local proxy_secret
      proxy_secret=$(kctl get secret -n platform oauth2-proxy-config -o jsonpath='{.data.OAUTH2_PROXY_CLIENT_SECRET}' 2>/dev/null | base64 -d || echo "")
      if [[ -n "$proxy_secret" ]]; then
        sed -i "s|staging-secret-oauth2-proxy|${proxy_secret}|g" "$dex_config"
        log "Dex oauth2-proxy client secret synced from generated secret."
      fi
    fi

    kctl apply -k "$overlay_dir"
    log "Staging manifests applied."
    return 0
  fi

  # Also handle dev overlay Dex config if present
  if [[ "$PLATFORM_ENV" == "dev" ]]; then
    local dex_config="${overlay_dir}/dex/config.yaml"
    if [[ -f "$dex_config" ]]; then
      log "Updating dev Dex config with domain ${PLATFORM_DOMAIN}..."
      sed -i "s|PLACEHOLDER.example.com|${PLATFORM_DOMAIN}|g" "$dex_config"
      sed -i "s|issuer:.*|issuer: http://dex.${PLATFORM_DOMAIN}/dex|" "$dex_config"
      # Sync oauth2-proxy client secret
      local proxy_secret
      proxy_secret=$(kctl get secret -n platform oauth2-proxy-config -o jsonpath='{.data.OAUTH2_PROXY_CLIENT_SECRET}' 2>/dev/null | base64 -d || echo "")
      if [[ -n "$proxy_secret" ]]; then
        sed -i "s|local-dev-secret-oauth2-proxy|${proxy_secret}|g" "$dex_config"
      fi
    fi
  fi

  cat > "${overlay_dir}/kustomization.yaml" <<EOF
apiVersion: kustomize.config.k8s.io/v1beta1
kind: Kustomization

resources:
  - ../../base

patches:
  # Ingress hostnames for ${PLATFORM_ENV} (generated by bootstrap.sh --domain ${PLATFORM_DOMAIN})
  - target:
      kind: Ingress
      name: platform-ingress
      namespace: platform
    patch: |
      - op: replace
        path: /spec/tls/0/hosts
        value:
          - ${api_host}
          - ${admin_host}
          - ${client_host}
      - op: replace
        path: /spec/rules/0/host
        value: ${api_host}
      - op: replace
        path: /spec/rules/1/host
        value: ${admin_host}
      - op: replace
        path: /spec/rules/2/host
        value: ${client_host}
EOF

  log "Generated overlay at ${overlay_dir}/kustomization.yaml"

  kctl apply -k "${overlay_dir}"
  log "Platform manifests applied with domain ${PLATFORM_DOMAIN}."
}

# ─── Phase 4: Verification ───────────────────────────────────────────────────

verify() {
  export KUBECONFIG
  log ""
  log "════════════════════════════════════════════════"
  log "VERIFICATION"
  log "════════════════════════════════════════════════"

  # Re-assert the default StorageClass after everything else settles.
  # Longhorn occasionally re-marks local-path as default via k3s's
  # restart behaviour, so running this late is more reliable than
  # running it inline with Longhorn install.
  log "Finalising default StorageClass (longhorn)..."
  kubectl patch storageclass local-path \
    -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}' 2>/dev/null || true
  kubectl patch storageclass longhorn \
    -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}' 2>/dev/null || true

  log ""
  log "── Node Status ──"
  kubectl get nodes -o wide

  log ""
  log "── All Pods ──"
  kubectl get pods -A --sort-by=.metadata.namespace

  log ""
  log "── k3s Version ──"
  k3s --version

  log ""
  log "── Helm Releases ──"
  helm_cmd list -A

  log ""
  log "── Ingress Controller ──"
  kctl get svc -n ingress-nginx 2>/dev/null || echo "  (not found)"

  log ""
  log "── Certificates ──"
  kctl get clusterissuer 2>/dev/null || echo "  (not found)"

  log ""
  log "── Firewall ──"
  nft list ruleset 2>/dev/null | head -10 || echo "  (nftables not configured)"

  log ""
  log "════════════════════════════════════════════════"
}

print_summary() {
  local server_ip
  server_ip="$(hostname -I | awk '{print $1}')"

  log ""
  log "════════════════════════════════════════════════"
  log "  BOOTSTRAP COMPLETE"
  log "════════════════════════════════════════════════"
  log ""
  log "  Server IP:    ${server_ip}"
  log "  Domain:       ${PLATFORM_DOMAIN}"
  log "  Environment:  ${PLATFORM_ENV}"
  log "  Kubeconfig:   ${KUBECONFIG}"
  log "  k3s version:  ${K3S_VERSION}"
  log ""
  log "  Endpoints:"
  log "    Admin:   https://admin.${PLATFORM_DOMAIN}"
  log "    Client:  https://client.${PLATFORM_DOMAIN}"
  log "    API:     https://api.${PLATFORM_DOMAIN}"
  log ""
  log "  Installed:"
  log "    - k3s + Calico CNI"
  log "    - NGINX Ingress Controller (ports 80/443)"
  log "    - cert-manager (Let's Encrypt staging + production)"
  log "    - Sealed Secrets"
  [[ "$ENABLE_MONITORING" == true ]] && log "    - Prometheus + Grafana + Loki"
  [[ "$SKIP_FLUX" != true ]]       && log "    - Flux v2"
  [[ "$SKIP_VPN" != true ]]        && log "    - WireGuard + NetBird (installed, not configured)"
  log "    - Platform namespaces + RBAC + network policies"
  log ""
  log "  To use kubectl from another machine:"
  log "    scp root@${server_ip}:${KUBECONFIG} ./kubeconfig.yaml"
  log "    sed -i 's/127.0.0.1/${server_ip}/g' kubeconfig.yaml"
  log "    export KUBECONFIG=./kubeconfig.yaml"
  log "    kubectl get nodes"
  log ""
  log "  Grafana (if monitoring enabled):"
  log "    kubectl port-forward -n monitoring svc/kube-prometheus-grafana 3000:80"
  log "    User: admin / Password: change-me"
  log ""
  log "════════════════════════════════════════════════"
}

# ─── Main ─────────────────────────────────────────────────────────────────────

main() {
  parse_args "$@"
  check_root
  check_os

  log "════════════════════════════════════════════════"
  log "  K8s Hosting Platform — Bootstrap (${NODE_ROLE}, ${PLATFORM_ENV})"
  log "  k3s ${K3S_VERSION} + Calico ${CALICO_VERSION}"
  log "════════════════════════════════════════════════"
  log ""

  # Phase 1: Server hardening (both roles).
  # Order matters: install_vpn_tools may default-inject CLUSTER_NETWORK_CIDR
  # (NetBird convenience), so it must run BEFORE configure_firewall, which
  # embeds the CIDR into nft rules. configure_fail2ban runs LAST so that an
  # error inside install_vpn_tools (failed `netbird up`) leaves the node
  # with the firewall already locked down by `policy drop` rather than
  # half-hardened.
  log "── Phase 1: Server Hardening ──"
  harden_ssh
  install_packages
  install_vpn_tools
  configure_firewall
  configure_fail2ban

  # M12: refuse asymmetric joins (e.g. server-2 forgot --cluster-network-cidr
  # while joining a private-network cluster). Only meaningful when both
  # CLUSTER_NETWORK_CIDR and K3S_SERVER_IP are set.
  validate_cluster_network_membership

  # Phase 2: k3s (server or agent depending on role)
  log ""
  log "── Phase 2: Kubernetes (k3s) ──"
  install_k3s

  # M1: label + taint the node with platform-managed role state. Must
  # run BEFORE apply_platform_manifests so that system-node-affinity
  # Kustomize patches (landing in M1 C5) don't deadlock the scheduler
  # on first apply. For workers this is a log-only step — the label
  # has to be applied from the control plane.
  if [[ "$NODE_ROLE" == "server" ]]; then
    # Calico + platform components only on the control plane.
    # NOTE: apply_node_labels_and_taints (and the server-only NoSchedule
    # taint it carries when host-client-workloads=false) is intentionally
    # deferred to AFTER pin_system_components_to_servers — applying the
    # taint earlier blocks the Helm pre-install hooks (ingress-nginx,
    # cert-manager) from scheduling on a single-server install.
    install_calico

    # Phase 3: Platform components
    log ""
    log "── Phase 3: Platform Components ──"
    install_helm
    install_flux_cli
    install_nginx_ingress
    install_cert_manager
    install_sealed_secrets
    install_longhorn
    # M10: CNPG operator (passive — no Cluster CR applied). Installs
    # alongside Longhorn so the Postgres replication activation flow
    # in docs/09-runbooks/CNPG_ACTIVATION_RUNBOOK.md is a single-CR
    # step rather than a multi-phase upgrade when the time comes.
    install_cnpg
    install_monitoring
    install_flux
    # M1 C5: pin Helm-managed Deployments to server nodes + add
    # server-only toleration. Runs AFTER all Helm installs so every
    # target Deployment exists by the time we patch it. See function
    # definition above for the split between nodeSelector+toleration
    # (control-plane only) and toleration-only (data plane DaemonSets).
    pin_system_components_to_servers
    # Apply the server-only taint AFTER all Helm components have their
    # tolerations patched in by pin_system_components_to_servers — order
    # matters so that ingress-nginx admission webhook, cert-manager
    # webhook, etc. can complete their initial install on a single-node
    # cluster without being evicted by the taint.
    apply_node_labels_and_taints
    generate_platform_secrets
    create_platform_configmap
    generate_operator_recipient
    apply_platform_manifests

    # Phase 4: Verify
    log ""
    log "── Phase 4: Verification ──"
    verify
    print_summary
  else
    apply_node_labels_and_taints
    # Worker — just confirm agent is running
    log ""
    log "════════════════════════════════════════════════"
    log "  WORKER NODE BOOTSTRAP COMPLETE"
    log "════════════════════════════════════════════════"
    log ""
    log "  Joined control plane: ${K3S_SERVER_IP}"
    log "  k3s agent status: $(systemctl is-active k3s-agent)"
    log ""
    log "  Verify from the control plane:"
    log "    kubectl get nodes"
    log ""
    log "════════════════════════════════════════════════"
  fi

  marker_set "bootstrap-complete"
}

# Only call main() when the script is executed directly, not when sourced.
# Sourced invocations (e.g. unit tests that need individual helpers like
# generate_operator_recipient) should NOT trigger the full bootstrap path.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
