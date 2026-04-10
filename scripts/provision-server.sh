#!/usr/bin/env bash
set -euo pipefail

# provision-server.sh — Provision a server with k3s, Calico CNI, and security hardening.
# Works for both Terraform-provisioned and pre-existing servers.
#
# Usage:
#   ./scripts/provision-server.sh --host <IP> --ssh-key <path>
#
# Options:
#   --host      Server IP address or hostname (required)
#   --ssh-key   Path to SSH private key (required)
#   --user      SSH user (default: root)
#   --k3s-version  k3s version to install (default: v1.31.4+k3s1)
#   --help      Show this help message

# shellcheck disable=SC2034
readonly IDEMPOTENCY_MARKER="/var/lib/hosting-platform/.provisioned"

# Defaults
SSH_USER="root"
K3S_VERSION="v1.31.4+k3s1"
HOST=""
SSH_KEY=""

usage() {
  sed -n '3,14p' "${BASH_SOURCE[0]}" | sed 's/^# \?//'
  exit 0
}

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

error() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2
  exit 1
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --host)     HOST="$2"; shift 2 ;;
      --ssh-key)  SSH_KEY="$2"; shift 2 ;;
      --user)     SSH_USER="$2"; shift 2 ;;
      --k3s-version) K3S_VERSION="$2"; shift 2 ;;
      --help|-h)  usage ;;
      *)          error "Unknown option: $1" ;;
    esac
  done

  [[ -z "$HOST" ]] && error "Missing required option: --host <IP>"
  [[ -z "$SSH_KEY" ]] && error "Missing required option: --ssh-key <path>"
  [[ ! -f "$SSH_KEY" ]] && error "SSH key not found: $SSH_KEY"
}

# Execute a command on the remote server via SSH
remote() {
  ssh -o StrictHostKeyChecking=accept-new \
      -o ConnectTimeout=10 \
      -i "$SSH_KEY" \
      "${SSH_USER}@${HOST}" "$@"
}

# Copy a file to the remote server
remote_copy() {
  scp -o StrictHostKeyChecking=accept-new \
      -i "$SSH_KEY" \
      "$1" "${SSH_USER}@${HOST}:$2"
}

check_connectivity() {
  log "Checking connectivity to ${HOST}..."
  remote "hostname" >/dev/null 2>&1 || error "Cannot connect to ${HOST} via SSH"
  log "Connected to $(remote hostname)"
}

harden_ssh() {
  log "Hardening SSH configuration..."
  remote bash -s <<'REMOTE_SCRIPT'
    set -euo pipefail

    SSHD_CONFIG="/etc/ssh/sshd_config"
    MARKER="/var/lib/hosting-platform/.ssh-hardened"

    if [[ -f "$MARKER" ]]; then
      echo "SSH already hardened, skipping."
      exit 0
    fi

    # Backup original config
    cp "$SSHD_CONFIG" "${SSHD_CONFIG}.bak.$(date +%s)"

    # Disable password authentication
    sed -i 's/^#\?PasswordAuthentication.*/PasswordAuthentication no/' "$SSHD_CONFIG"
    sed -i 's/^#\?ChallengeResponseAuthentication.*/ChallengeResponseAuthentication no/' "$SSHD_CONFIG"
    sed -i 's/^#\?PubkeyAuthentication.*/PubkeyAuthentication yes/' "$SSHD_CONFIG"
    sed -i 's/^#\?PermitRootLogin.*/PermitRootLogin prohibit-password/' "$SSHD_CONFIG"
    sed -i 's/^#\?X11Forwarding.*/X11Forwarding no/' "$SSHD_CONFIG"

    # Validate config before restarting
    sshd -t || { echo "ERROR: Invalid sshd_config"; exit 1; }
    systemctl reload sshd

    mkdir -p "$(dirname "$MARKER")"
    touch "$MARKER"
    echo "SSH hardened successfully."
REMOTE_SCRIPT
}

install_packages() {
  log "Installing base packages..."
  remote bash -s <<'REMOTE_SCRIPT'
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive

    apt-get update -qq
    apt-get install -y -qq \
      curl \
      wget \
      gnupg2 \
      software-properties-common \
      ca-certificates \
      nftables \
      fail2ban \
      jq \
      unzip \
      open-iscsi \
      nfs-common \
      >/dev/null 2>&1

    echo "Base packages installed."
REMOTE_SCRIPT
}

configure_firewall() {
  log "Configuring nftables firewall..."
  remote bash -s <<'REMOTE_SCRIPT'
    set -euo pipefail

    cat > /etc/nftables.conf <<'NFT'
#!/usr/sbin/nft -f

flush ruleset

table inet filter {
  chain input {
    type filter hook input priority filter; policy drop;

    # Allow loopback
    iif "lo" accept

    # Allow established/related connections
    ct state established,related accept

    # Allow ICMP (ping, path MTU discovery)
    ip protocol icmp accept
    ip6 nexthdr icmpv6 accept

    # Allow HTTP (NGINX Ingress / Let's Encrypt ACME challenge)
    tcp dport 80 accept

    # Allow HTTPS (NGINX Ingress)
    tcp dport 443 accept

    # Allow k8s API (restricted — consider limiting to specific IPs)
    tcp dport 6443 accept

    # Allow SSH (break-glass access; primary access via NetBird mesh)
    tcp dport 22 accept

    # Allow WireGuard (NetBird peer)
    udp dport 51820 accept
    udp dport 29899 accept   # NetBird direct connection

    # Log and drop everything else
    counter drop
  }

  chain forward {
    type filter hook forward priority filter; policy accept;

    # Allow established/related
    ct state established,related accept

    # k3s and Docker manage their own FORWARD rules
  }

  chain output {
    type filter hook output priority filter; policy accept;
  }
}
NFT

    # Enable and start nftables
    systemctl enable nftables
    nft -f /etc/nftables.conf
    echo "Firewall configured."
REMOTE_SCRIPT
}

configure_fail2ban() {
  log "Configuring fail2ban..."
  remote bash -s <<'REMOTE_SCRIPT'
    set -euo pipefail

    MARKER="/var/lib/hosting-platform/.fail2ban-configured"
    if [[ -f "$MARKER" ]]; then
      echo "fail2ban already configured, skipping."
      exit 0
    fi

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

    mkdir -p "$(dirname "$MARKER")"
    touch "$MARKER"
    echo "fail2ban configured."
REMOTE_SCRIPT
}

install_vpn_tools() {
  log "Installing VPN tools (WireGuard + NetBird)..."
  remote bash -s <<'REMOTE_SCRIPT'
    set -euo pipefail

    # WireGuard
    if command -v wg &>/dev/null; then
      echo "WireGuard already installed."
    else
      echo "Installing WireGuard..."
      apt-get install -y -qq wireguard-tools >/dev/null 2>&1
      echo "WireGuard installed (not configured)."
    fi

    # NetBird
    if command -v netbird &>/dev/null; then
      echo "NetBird already installed."
    else
      echo "Installing NetBird client..."
      curl -fsSL https://pkgs.netbird.io/install.sh | sh >/dev/null 2>&1
      systemctl enable netbird 2>/dev/null || true
      echo "NetBird installed (not configured — run 'netbird up --setup-key <KEY>' when ready)."
    fi
REMOTE_SCRIPT
}

install_k3s() {
  log "Installing k3s ${K3S_VERSION}..."
  remote bash -s -- "$K3S_VERSION" <<'REMOTE_SCRIPT'
    set -euo pipefail

    K3S_VERSION="$1"
    MARKER="/var/lib/hosting-platform/.k3s-installed"

    if command -v k3s &>/dev/null; then
      INSTALLED_VERSION="$(k3s --version | awk '{print $3}')"
      echo "k3s already installed: ${INSTALLED_VERSION}"
      if [[ "$INSTALLED_VERSION" == "$K3S_VERSION" ]]; then
        echo "Correct version already installed, skipping."
        mkdir -p "$(dirname "$MARKER")"
        touch "$MARKER"
        exit 0
      fi
      echo "Upgrading from ${INSTALLED_VERSION} to ${K3S_VERSION}..."
    fi

    # Install k3s with Calico-compatible settings:
    # --flannel-backend=none: disable Flannel (Calico provides CNI)
    # --disable-network-policy: disable built-in network policy controller (Calico provides it)
    # --disable=traefik: disable Traefik ingress (we use NGINX Ingress)
    # --disable=servicelb: disable ServiceLB (we use NGINX Ingress with hostPort)
    # Build TLS SAN flags for all host IPs (IPv4 + IPv6)
    TLS_SANS=""
    for ip in $(hostname -I); do
      TLS_SANS="${TLS_SANS} --tls-san=${ip}"
    done

    # shellcheck disable=SC2086
    curl -sfL https://get.k3s.io | \
      INSTALL_K3S_VERSION="$K3S_VERSION" \
      INSTALL_K3S_EXEC="server" \
      sh -s - \
        --flannel-backend=none \
        --disable-network-policy \
        --disable=traefik \
        --disable=servicelb \
        --write-kubeconfig-mode=644 \
        --cluster-cidr=10.42.0.0/16,fd42::/48 \
        --service-cidr=10.43.0.0/16,fd43::/112 \
        --kubelet-arg=max-pods=250 \
        ${TLS_SANS}

    # Wait for k3s to be ready (API server)
    echo "Waiting for k3s API server..."
    for i in $(seq 1 60); do
      if kubectl get nodes &>/dev/null; then
        echo "k3s API server is ready."
        break
      fi
      sleep 2
    done

    mkdir -p "$(dirname "$MARKER")"
    touch "$MARKER"
    echo "k3s ${K3S_VERSION} installed."
REMOTE_SCRIPT
}

install_calico() {
  log "Installing Calico CNI..."
  remote bash -s <<'REMOTE_SCRIPT'
    set -euo pipefail
    export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

    CALICO_VERSION="v3.28.0"
    MARKER="/var/lib/hosting-platform/.calico-installed"

    if kubectl get namespace calico-system &>/dev/null 2>&1; then
      echo "Calico already installed, skipping."
      touch "$MARKER"
      exit 0
    fi

    echo "Installing Calico ${CALICO_VERSION}..."

    # Install the Calico operator
    kubectl create -f "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/tigera-operator.yaml" || true

    # Wait for operator to be ready
    echo "Waiting for Calico operator..."
    kubectl wait --for=condition=available --timeout=120s deployment/tigera-operator -n tigera-operator 2>/dev/null || true

    # Install Calico custom resources
    cat <<'EOF' | kubectl apply -f -
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  calicoNetwork:
    ipPools:
    - blockSize: 26
      cidr: 10.42.0.0/16
      encapsulation: VXLANCrossSubnet
      natOutgoing: Enabled
      nodeSelector: all()
    - blockSize: 122
      cidr: fd42::/48
      encapsulation: None
      natOutgoing: false
      nodeSelector: all()
---
apiVersion: operator.tigera.io/v1
kind: APIServer
metadata:
  name: default
spec: {}
EOF

    # Wait for Calico to be ready
    echo "Waiting for Calico pods..."
    sleep 10
    kubectl wait --for=condition=ready pod -l k8s-app=calico-node -n calico-system --timeout=180s 2>/dev/null || echo "Warning: Calico pods not ready yet. They may need more time."

    mkdir -p "$(dirname "$MARKER")"
    touch "$MARKER"
    echo "Calico CNI installed."
REMOTE_SCRIPT
}

verify_installation() {
  log "Verifying installation..."
  remote bash -s <<'REMOTE_SCRIPT'
    set -euo pipefail
    export KUBECONFIG=/etc/rancher/k3s/k3s.yaml

    echo "=== Node Status ==="
    kubectl get nodes -o wide

    echo ""
    echo "=== System Pods ==="
    kubectl get pods -A

    echo ""
    echo "=== k3s Version ==="
    k3s --version

    echo ""
    echo "=== Firewall Rules ==="
    nft list ruleset | head -30

    echo ""
    echo "Installation verification complete."
REMOTE_SCRIPT
}

main() {
  parse_args "$@"

  log "Starting server provisioning for ${HOST}"
  log "================================================"

  check_connectivity
  harden_ssh
  install_packages
  configure_firewall
  configure_fail2ban
  install_vpn_tools
  install_k3s
  install_calico
  verify_installation

  log "================================================"
  log "Server provisioning complete!"
  log ""
  log "Next steps:"
  log "  1. Copy kubeconfig: ssh -i ${SSH_KEY} ${SSH_USER}@${HOST} 'cat /etc/rancher/k3s/k3s.yaml' > kubeconfig.yaml"
  log "  2. Update the server address in kubeconfig.yaml to ${HOST}"
  log "  3. Run: ./scripts/install-platform.sh --kubeconfig kubeconfig.yaml"
}

main "$@"
