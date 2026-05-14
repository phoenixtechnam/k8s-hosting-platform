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

# Pod CIDR — passed to k3s as --cluster-cidr and used in the firewall
# allow-list so pods can reach the host's control-plane ports via
# kube-proxy Service-VIP DNAT (which preserves the pod source IP).
# Without this, fresh installs race: pods crashloop with "i/o timeout"
# against 10.43.0.1:443 until Calico's natOutgoing POSTROUTING chain
# is fully active and starts SNAT'ing pod traffic. Existing clusters
# work because Calico SNAT settled before any pod tried; observed on
# fresh testing host 2026-04-30. Keep in sync with install_k3s_server's
# cluster_cidr_arg.
POD_CIDR_V4="10.42.0.0/16"

# Always-on set-mode firewall. cluster_peers_v{4,6} nft sets gate
# cluster-internal control-plane ports (6443/8443/10250/5473/2379-2380),
# converged from kube-API node InternalIPs by the peer-firewall-
# reconciler DaemonSet. trusted_ranges_v{4,6} nft sets gate full TCP/UDP
# from operator-blessed ranges (workstation IPs, hosting-provider
# private LANs, monitoring scrapers, NetBird/Tailscale CIDRs). The
# admin panel writes ClusterTrustedRange CRDs; bootstrap-time entries
# are seeded from the repeatable --allow-source flag below.
ALLOW_SOURCE_LIST_V4=()
ALLOW_SOURCE_LIST_V6=()
# CLUSTER_NETWORK_CIDR retained for k3s --node-ip pinning ONLY (selects
# which interface k3s advertises on). No longer drives firewall trust;
# pass --allow-source for that. Auto-detected from wt0/tailscale0 if
# unset, same as before.
CLUSTER_NETWORK_CIDR=""
CLUSTER_NETWORK_CIDR_V6=""
# Calico-managed WireGuard (UDP/51821): public by default. Public-key
# auth makes the surface effectively zero. Operators on a real private
# VLAN may opt-in to scope it to trusted_ranges via
# --calico-wg-public=false. Not recommended on NetBird/Tailscale meshes:
# Calico's WG endpoint is announced as the underlay (eth0) IP, not the
# mesh IP, so scoping would block legitimate handshakes.
CALICO_WG_PUBLIC="true"
# Calico pod-network MTU. Empty = auto-detect at install time:
# pick the underlay interface (mesh first via wt0/tailscale0/wg0,
# else default-route iface) and subtract 110 bytes for Calico's
# overhead (WireGuard 60 + VXLAN 50). Operators with mixed
# underlays should pin --calico-mtu to the smallest expected
# underlay − 110 to avoid frag-on-the-mesh-side pain.
# Examples:
#   public-only Ethernet:           1500 − 110 = 1390 (we'll round to 1380 for headroom)
#   on a NetBird mesh (wt0=1420):   1420 − 110 = 1310
#   on Tailscale (tailscale0=1280): 1280 − 110 = 1170
# Floor: 1280 (IPv6 minimum). Ceiling: 8990 (jumbo-frame headroom).
CALICO_MTU=""
# DRY_RUN: when true, bootstrap exits cleanly after Phase 1 package
# install. Used by scripts/test-bootstrap-os-matrix.sh to validate the
# OS-family detection + package availability across distros in
# disposable Docker containers (no systemd, no nftables apply, no
# k3s install). NOT for production use.
DRY_RUN=false

# ─── Pinned component versions ────────────────────────────────────────────────
# Updated 2026-04-21. When bumping, verify:
#   1. Longhorn compatibility matrix covers the chosen k3s/k8s version
#   2. All Helm chart versions are published at their respective repos
#   3. Run `kubectl kustomize` on all overlays + redeploy staging before prod
# Latest-stable checks done against GitHub releases for each project.
LONGHORN_VERSION="v1.11.1"               # 2026-03-13
TRAEFIK_CHART_VERSION="40.2.0"           # app v3.7.1 "Langres"; verify: helm search repo traefik/traefik
# Traefik plugin catalog refs. install_traefik wires these into the
# `experimental.plugins.<name>.{moduleName,version}` helm values so the
# controller fetches the Yaegi-interpreted plugin source from
# plugins.traefik.io at startup.
#
# CrowdSec bouncer — platform-wide IP-reputation gate, default-on for
# every panel + tenant IngressRoute (the `crowdsec@traefik` Middleware
# in k8s/base/traefik/middlewares-crowdsec.yaml).
CROWDSEC_PLUGIN_MODULE="github.com/maxlerebourg/crowdsec-bouncer-traefik-plugin"
CROWDSEC_PLUGIN_VERSION="v1.4.4"
# ModSecurity-CRS proxy — tenant-opt-in WAF (the `modsecurity-crs@
# traefik` Middleware). Proxies request bodies to the modsec-crs
# Deployment in k8s/base/modsecurity-crs/ for OWASP CRS verdict.
MODSECURITY_PLUGIN_MODULE="github.com/madebymode/traefik-modsecurity-plugin"
MODSECURITY_PLUGIN_VERSION="v1.6.0"
# Coraza in-process WAF — DEAD CODE. The 2026-05-14 smoke test
# established neither the Yaegi vendored path nor the WASM build is
# usable today (see docker/traefik-plugin-coraza/README.md). Empty
# strings here skip the helm flag emission. When upstream stabilises,
# bump these + flip the WAF Middleware ref in annotation-sync.ts /
# ingress-reconciler.ts.
CORAZA_PLUGIN_MODULE=""
CORAZA_PLUGIN_VERSION=""
CERT_MANAGER_CHART_VERSION="v1.20.2"     # 2026-04-11
SEALED_SECRETS_CHART_VERSION="2.17.4"    # controller v0.36.6
CNPG_CHART_VERSION="0.28.0"              # CloudNative-PG operator v1.29.0 (PG 14-18 support; 1.24/1.27 EOL)
SKIP_CNPG=false                          # --skip-cnpg flag sets this
ACME_EMAIL=""
ENABLE_MONITORING=false
SKIP_FLUX=false
SKIP_HARDENING=false
SKIP_LONGHORN=false
SKIP_SMOKE=false               # --skip-smoke disables the post-install smoke run
REQUIRE_SMOKE_PASS=false       # --require-smoke-pass makes smoke FAIL fatal (CI use)
SMOKE_WAIT_SECONDS=300         # max wait for Flux Kustomizations to reach Ready
OPERATOR_AGE_RECIPIENT=""      # public half (age1...) — optional, generated if empty
FORCE_ROTATE_OPERATOR_KEY=false # regenerate + overwrite ConfigMap even if it exists
# --force-domain-change: opt-in to overwriting the existing
# platform-cluster-config ConfigMap when --domain or --env differ from
# the live cluster. Default false makes re-runs with a typo'd --domain
# hard-fail with a clear message instead of silently breaking every
# Ingress / cert / cookie pinned to the old DOMAIN.
FORCE_DOMAIN_CHANGE=false
SECRETS_BUNDLE_PATH=""         # --secrets-bundle <path|http(s) URL> — pre-Flux import
SECRETS_BUNDLE_KEY=""          # --age-key <path> to operator-private.key for decrypt
MARKER_DIR="/var/lib/hosting-platform"
KUBECONFIG="/etc/rancher/k3s/k3s.yaml"
REPO_URL="https://github.com/phoenixtechnam/k8s-hosting-platform.git"

# ─── Helpers ──────────────────────────────────────────────────────────────────

usage() {
  cat <<'HELPTEXT'
Usage: bootstrap.sh --join-as <server|worker> [OPTIONS]

Server provisioning and platform installation for k8s-hosting-platform.

SUPPORTED OPERATING SYSTEMS:
  Tier 1 (CI-tested):
    - Debian 12 (bookworm), Debian 13 (trixie)
    - Ubuntu 22.04 LTS (jammy), Ubuntu 24.04 LTS (noble)
  Tier 2 (best-effort, smoke-tested in containers):
    - RHEL 9, Rocky Linux 9, AlmaLinux 9, CentOS Stream 9 / 10
  Rejected (script aborts):
    - CentOS Linux 7 / 8 (EOL — use Rocky/Alma 9 or Debian/Ubuntu)
    - Ubuntu < 22.04, Debian < 12
    - Alpine, Talos, Flatcar, NixOS, anything systemd-less

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
  --skip-longhorn        Skip Longhorn storage (use local-path)
  --dry-run              Validate OS + install base packages, then exit
                         before firewall/k3s/Calico/etc. Used by
                         scripts/test-bootstrap-os-matrix.sh in
                         disposable Docker containers. Not for prod.
  --skip-cnpg            Skip CloudNative-PG operator install (M10).
  --skip-smoke           Skip the post-install cluster-network smoke run.
                         Default: smoke runs as advisory (warn-only) at
                         the end of bootstrap on the first server.
  --require-smoke-pass   Make smoke failures FATAL (non-zero exit). Use
                         in CI/automated bootstrap. Without this flag,
                         smoke FAILs are reported but bootstrap exits 0.
  --smoke-wait <sec>     Max seconds to wait for Flux Kustomizations to
                         reach Ready=True before smoke (default: 300).
                         Smoke runs even if the timeout is hit; on a
                         cold first-bootstrap, raise to 600 if you see
                         spurious FAILs from still-reconciling pods.
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
  --force-domain-change  Allow re-running bootstrap.sh with --domain or
                         --env different from the live cluster's
                         platform-cluster-config. Default behaviour is
                         a hard-fail to prevent accidental DOMAIN
                         clobber that would break every Ingress + cert
                         pinned to the previous value. Use only when
                         a domain rename / env flip is intentional;
                         existing certs + cookies will need re-issuance.
  --secrets-bundle <path|URL>
                         Tier-1 secrets bundle to import BEFORE Flux
                         reconciles. Decrypted with --age-key, then
                         every kubernetes Secret YAML inside is applied
                         so platform-api / Stalwart / mail-pg come up
                         with their pre-existing identities (TLS, JWT
                         signing keys, OIDC client secrets, etc.). Used
                         on a fresh cluster to recover from a previous
                         install's secrets without rotating every
                         dependent service. Path or http(s) URL — URLs
                         are curl-downloaded to a tmp file. The bundle
                         is the artifact downloaded from the System
                         Backup admin UI or the on-host
                         /var/lib/hosting-platform/bundles/ directory.
  --age-key <path>       Operator's age private key for --secrets-bundle.
                         Required if --secrets-bundle is set. The key
                         is read once at import time and never copied
                         to the cluster.

JOINING (server #2+ or worker):
  --server <ip>          Existing control-plane IP. When --cluster-network-
                         cidr is set on the existing cluster, this MUST
                         be the control-plane's IP within that CIDR
                         (e.g. its NetBird wt0 IP), NOT its public IP.
  --token <token>        k3s join token from /var/lib/rancher/k3s/server/
                         node-token on an existing control-plane.

FIREWALL TRUST (always-on set mode):
  Cluster firewall is always set-mode: cluster-internal control-plane
  ports (6443/8443/10250/5473/2379-2380) gate via the cluster_peers_v{4,6}
  nft sets, converged from kube-API node InternalIPs by the
  firewall-reconciler DaemonSet. Operator-trusted source ranges
  (workstation IPs, private LANs, monitoring scrapers) gate via the
  trusted_ranges_v{4,6} nft sets. Day-2 management of trusted ranges
  is via the admin panel under Settings → Cluster Networking, which
  writes ClusterTrustedRange CRDs that the reconciler converges. At
  bootstrap time use --allow-source to seed the initial entries.

  --allow-source <ip|cidr>
                         Trust this source for full TCP/UDP. Repeatable
                         and comma-tolerant. Accepts:
                           * single IPv4   1.2.3.4         → /32
                           * single IPv6   2001:db8::1     → /128
                           * IPv4 CIDR     10.0.0.0/16
                           * IPv6 CIDR     fd00::/8
                         Examples:
                           --allow-source 198.51.100.7      (workstation)
                           --allow-source 10.0.0.0/16       (private LAN)
                           --allow-source 100.64.0.0/10     (NetBird/Tailscale)
                           --allow-source 1.2.3.4,5.6.7.8   (comma-separated)
                         Optional — bootstrap-time convenience only.
                         Once platform-api is up, manage via the UI.

  --cluster-network-cidr <cidr>
                         k3s --node-ip pinning. When set, k3s binds and
                         advertises the node's IP from inside this CIDR
                         (e.g. its NetBird wt0 IP) instead of the
                         default-route IP. Auto-detected from wt0 /
                         tailscale0 (100.64.0.0/10) if unset.
                         CONVENIENCE: also added to --allow-source so
                         the host trusts traffic from inside that CIDR.
                         Optional.
  --cluster-network-cidr-v6 <cidr>
                         IPv6 sibling of --cluster-network-cidr. Auto-
                         detected from the mesh interface if unset.
                         Same convenience: also added to --allow-source.
                         Optional.
  --calico-wg-public <true|false>
                         Calico WireGuard (UDP/51821). Default true:
                         public-key auth makes exposure safe AND mesh
                         underlays can't carry Calico's WG endpoint
                         reliably. Set false to scope to trusted_ranges.
  --calico-mtu <bytes>   Pin Calico's pod-network MTU. Default: auto-
                         detect — picks the smallest of the local
                         node's viable underlays (mesh first via
                         wt0/tailscale0/wg0, else default-route iface)
                         and subtracts 110 (Calico WG 60 + VXLAN 50).
                         Override on mixed-underlay clusters where
                         the smallest expected underlay is on a node
                         that hasn't joined yet. Range: [1280, 8990].
                         Examples: 1380 (1500-byte Ethernet underlay),
                         1310 (NetBird wt0 at 1420), 1170 (Tailscale
                         at 1280).

PRE-REQUISITES (sysadmin, BEFORE running this script):
  Bootstrap does NOT install or enrol VPN/mesh CLIENTS (NetBird,
  Tailscale, etc.). It DOES install kernel WireGuard userland
  (wireguard-tools) since Calico's pod-traffic encryption needs it.
  If you want a private-network underlay for k3s --node-ip pinning,
  bring it up FIRST:
    NetBird:    netbird up --management-url <url> --setup-key <KEY>
    Tailscale:  tailscale up --auth-key tskey-...
    Hetzner / cloud VLAN: attach VLAN at provider level

  AUTO-DETECT: configure_firewall checks for wt0 (NetBird) or
  tailscale0 with an IP in 100.64.0.0/10. If found, --cluster-network-
  cidr defaults to 100.64.0.0/10 and v6 is derived from the
  interface's announced route prefix. The detected CIDR is also added
  to --allow-source as a convenience.

REMOTE MODE:
  --remote <host>        Run on remote server via SSH
  --ssh-key <path>       SSH private key for remote mode
  --ssh-user <user>      SSH user (default: root)

EXAMPLES:

  # ─ Single server, public-only ──────────────────────────────────────
  # cluster_peers seeds with self-IP. Operator's workstation IP is
  # added so kubectl works before the admin panel exists.
  ./bootstrap.sh --join-as server \
    --domain phoenix-host.net --acme-email ops@phoenix-host.net \
    --allow-source 198.51.100.7

  # ─ NetBird-private 3-server HA cluster ─────────────────────────────
  # SYSADMIN, on each node BEFORE running bootstrap:
  #   netbird up --management-url https://vpn.example.com --setup-key <UUID>
  # Auto-detect picks wt0 → 100.64.0.0/10 (also added to allow-source).

  # First server (creates the cluster):
  ./bootstrap.sh --join-as server \
    --domain phoenix-host.net --acme-email ops@phoenix-host.net \
    --allow-source 198.51.100.7

  # Second & third servers (join over NetBird wt0 IP, NOT public IP):
  ./bootstrap.sh --join-as server \
    --server 100.64.1.5 --token K10abc...:server:def... \
    --domain phoenix-host.net --acme-email ops@phoenix-host.net

  # Worker:
  ./bootstrap.sh --join-as worker \
    --server 100.64.1.5 --token K10abc...:server:def...

  # ─ Hetzner private LAN + monitoring scraper ────────────────────────
  ./bootstrap.sh --join-as server \
    --domain phoenix-host.net --acme-email ops@phoenix-host.net \
    --cluster-network-cidr 10.0.0.0/16 \
    --allow-source 203.0.113.42 \
    --allow-source 198.51.100.0/24

  # ─ Multiple sources (repeatable + comma) ───────────────────────────
  ./bootstrap.sh --join-as server \
    --domain phoenix-host.net --acme-email ops@phoenix-host.net \
    --allow-source 100.64.0.0/10,fd00::/8 \
    --allow-source 198.51.100.7 \
    --allow-source 2001:db8::42

  # ─ Remote bootstrap from workstation ───────────────────────────────
  ./bootstrap.sh --remote 1.2.3.4 --ssh-key ~/hosting-platform.key \
    --join-as server \
    --domain phoenix-host.net --acme-email ops@phoenix-host.net \
    --allow-source 198.51.100.7
HELPTEXT
  exit 0
}

log()   { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"; }
warn()  { echo "[$(date '+%Y-%m-%d %H:%M:%S')] WARN: $*" >&2; }
error() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: $*" >&2; exit 1; }

marker_exists() { [[ -f "${MARKER_DIR}/.${1}" ]]; }
marker_set()    { mkdir -p "$MARKER_DIR"; touch "${MARKER_DIR}/.${1}"; }

# Parse one --allow-source argument value (comma-tolerant). Each token is
# normalized to a CIDR (/32 for bare IPv4, /128 for bare IPv6) and pushed
# to ALLOW_SOURCE_LIST_V4 or ALLOW_SOURCE_LIST_V6. Hard-fails on
# malformed input BEFORE any nft-grammar concatenation downstream.
parse_allow_source_arg() {
  # python3 is required for the ipaddress validation round-trip below.
  # Bootstrap runs parse_args BEFORE install_base_packages, so on a
  # fresh distro python3 may be absent. Fail with a clear message
  # rather than the misleading "failed CIDR validation" we'd get if
  # the python heredoc silently produced empty output.
  if ! command -v python3 >/dev/null 2>&1; then
    error "python3 not found — required for --allow-source CIDR validation. Install python3 first (Debian/Ubuntu: apt install python3; RHEL: dnf install python3) and re-run."
  fi
  local raw="$1" tok normalized family
  # IFS is restored on subshell exit; safe inside a function.
  local IFS=','
  for tok in $raw; do
    # Strip both spaces and tabs to canonicalise input. Tabs are not
    # rejected by the regex arms below (their character classes don't
    # include \t), but stripping makes the error message cleaner if a
    # downstream check fires.
    tok="${tok//[[:space:]]/}"
    [[ -z "$tok" ]] && continue
    if [[ "$tok" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
      normalized="${tok}/32"; family=v4
    elif [[ "$tok" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]]; then
      normalized="$tok"; family=v4
    elif [[ "$tok" =~ ^[0-9a-fA-F:]+$ && "$tok" == *:* ]]; then
      normalized="${tok}/128"; family=v6
    elif [[ "$tok" =~ ^[0-9a-fA-F:]+/[0-9]{1,3}$ ]]; then
      normalized="$tok"; family=v6
    else
      error "Invalid --allow-source token: '${tok}'. Must be IPv4/v6 address (/32, /128 implied) or CIDR."
    fi
    # Final sanity check via python's ipaddress: catches /33, all-zeros,
    # malformed v6 ranges that the regex above accepts. python3 presence
    # was confirmed at function entry, so an empty result here means
    # the token failed ipaddress.ip_network() — never a missing binary.
    normalized=$(python3 - "$normalized" <<'PYEOF' 2>/dev/null || true
import ipaddress, sys
try:
    n = ipaddress.ip_network(sys.argv[1], strict=False)
    print(str(n))
except Exception:
    sys.exit(1)
PYEOF
    )
    [[ -z "$normalized" ]] && error "Invalid --allow-source token: '${tok}' (failed CIDR validation)."
    if [[ "$family" == v4 ]]; then
      ALLOW_SOURCE_LIST_V4+=("$normalized")
    else
      ALLOW_SOURCE_LIST_V6+=("$normalized")
    fi
  done
}

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
      --cluster-network-cidr-v6) CLUSTER_NETWORK_CIDR_V6="$2"; shift 2 ;;
      --allow-source)    parse_allow_source_arg "$2"; shift 2 ;;
      --calico-wg-public) CALICO_WG_PUBLIC="$2"; shift 2 ;;
      --calico-mtu)      CALICO_MTU="$2"; shift 2 ;;
      --with-monitoring) ENABLE_MONITORING=true; shift ;;
      --skip-monitoring) shift ;; # Deprecated — monitoring is now opt-in via --with-monitoring
      --skip-flux)       SKIP_FLUX=true; shift ;;
      --skip-hardening)  SKIP_HARDENING=true; shift ;;
      --dry-run)         DRY_RUN=true; shift ;;
      --skip-vpn)        shift ;; # Deprecated — bootstrap no longer installs VPN tools; sysadmin responsibility
      --netbird-management-url|--netbird-setup-key)
                         warn "Deprecated flag '$1' ignored — bring up NetBird/Tailscale BEFORE running bootstrap. See docs/04-deployment/CLUSTER_NETWORK.md."
                         shift 2 ;;
      --skip-longhorn)   SKIP_LONGHORN=true; shift ;;
      --skip-cnpg)       SKIP_CNPG=true; shift ;;
      --skip-smoke)      SKIP_SMOKE=true; shift ;;
      --require-smoke-pass) REQUIRE_SMOKE_PASS=true; shift ;;
      --smoke-wait)      SMOKE_WAIT_SECONDS="$2"; shift 2 ;;
      --acme-email)      ACME_EMAIL="$2"; shift 2 ;;
      --operator-age-recipient) OPERATOR_AGE_RECIPIENT="$2"; shift 2 ;;
      --force-rotate-operator-key) FORCE_ROTATE_OPERATOR_KEY=true; shift ;;
      --force-domain-change) FORCE_DOMAIN_CHANGE=true; shift ;;
      --secrets-bundle)  SECRETS_BUNDLE_PATH="$2"; shift 2 ;;
      --age-key)         SECRETS_BUNDLE_KEY="$2"; shift 2 ;;
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

  # Validate CLUSTER_NETWORK_CIDR shape if set. Tight regex: 4 octets +
  # /0–32 prefix. Also defends the python3 / nft heredocs downstream
  # against shell-interpolated content.
  if [[ -n "$CLUSTER_NETWORK_CIDR" ]] \
     && [[ ! "$CLUSTER_NETWORK_CIDR" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}/([0-9]|[12][0-9]|3[0-2])$ ]]; then
    error "Invalid --cluster-network-cidr: '${CLUSTER_NETWORK_CIDR}'. Must be IPv4 CIDR (e.g. 100.64.0.0/10)."
  fi

  # Validate CLUSTER_NETWORK_CIDR_V6 shape if set. Permissive regex —
  # nft will reject malformed values at apply time; we only block shell-
  # injection-shaped input.
  if [[ -n "$CLUSTER_NETWORK_CIDR_V6" ]] \
     && [[ ! "$CLUSTER_NETWORK_CIDR_V6" =~ ^[0-9a-fA-F:]+/[0-9]{1,3}$ ]]; then
    error "Invalid --cluster-network-cidr-v6: '${CLUSTER_NETWORK_CIDR_V6}'. Must be IPv6 CIDR (e.g. fd7a:115c:a1e0::/48)."
  fi

  # Validate CALICO_WG_PUBLIC.
  if [[ "$CALICO_WG_PUBLIC" != "true" && "$CALICO_WG_PUBLIC" != "false" ]]; then
    error "Invalid --calico-wg-public: '${CALICO_WG_PUBLIC}'. Must be 'true' or 'false'."
  fi

  # Validate CALICO_MTU when provided. Empty = auto-detect at install
  # time (see detect_calico_mtu). Non-empty must be an integer in
  # [1280, 8990] — IPv6 minimum link MTU at the low end, jumbo-frame
  # underlay headroom at the high end.
  if [[ -n "$CALICO_MTU" ]]; then
    if ! [[ "$CALICO_MTU" =~ ^[0-9]+$ ]]; then
      error "Invalid --calico-mtu: '${CALICO_MTU}'. Must be a positive integer."
    fi
    if (( CALICO_MTU < 1280 || CALICO_MTU > 8990 )); then
      error "Invalid --calico-mtu: ${CALICO_MTU}. Must be in [1280, 8990] (IPv6 min link MTU through jumbo-frame headroom)."
    fi
  fi

  # CONVENIENCE: when --cluster-network-cidr{,-v6} is set explicitly,
  # also add it to allow-source so the operator doesn't have to repeat
  # the same CIDR twice. Auto-detected values are added later in
  # configure_firewall after detection runs.
  if [[ -n "$CLUSTER_NETWORK_CIDR" ]]; then
    parse_allow_source_arg "$CLUSTER_NETWORK_CIDR"
  fi
  if [[ -n "$CLUSTER_NETWORK_CIDR_V6" ]]; then
    parse_allow_source_arg "$CLUSTER_NETWORK_CIDR_V6"
  fi

  # GUARD: --calico-wg-public=false scopes WireGuard 51821 to
  # @trusted_ranges_v{4,6}. If both lists are empty (no --allow-source,
  # no --cluster-network-cidr, no auto-detected mesh interface), WG
  # becomes unreachable from every source and Calico's pod-traffic
  # encryption silently fails. Warn loud — auto-detect at firewall-
  # render time may still populate the lists, in which case the warning
  # is benign; but a no-mesh single-node cluster with this flag set is
  # almost certainly a misconfiguration.
  if [[ "$CALICO_WG_PUBLIC" == "false" \
        && ${#ALLOW_SOURCE_LIST_V4[@]} -eq 0 \
        && ${#ALLOW_SOURCE_LIST_V6[@]} -eq 0 ]]; then
    warn "--calico-wg-public=false with no --allow-source / --cluster-network-cidr: trusted_ranges may be empty after auto-detect, in which case WireGuard port 51821 becomes unreachable from all sources. If you intend this, ignore. Otherwise add --allow-source <CIDR>."
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

# OS_FAMILY is set by check_os and consumed by install_packages.
# Values: "debian" (apt path) or "rhel" (dnf path).
OS_FAMILY=""
# OS_VARIANT differentiates within a family when install paths diverge.
# Currently used to flag Amazon Linux 2023 in the rhel family — AL2023
# has no EPEL / no CRB and ships fail2ban/age/wireguard-tools in core.
OS_VARIANT=""

check_os() {
  if [[ ! -f /etc/os-release ]]; then
    error "Cannot detect OS — /etc/os-release missing. Supported: Debian 12+, Ubuntu 22.04+, RHEL/Rocky/AlmaLinux/CentOS-Stream 9+."
  fi
  # shellcheck source=/dev/null
  source /etc/os-release

  local major
  major="${VERSION_ID%%.*}"

  case "$ID" in
    debian)
      if [[ -z "${major:-}" ]] || (( major < 12 )); then
        error "Debian ${VERSION_ID:-unknown} is unsupported. Use Debian 12 (bookworm) or 13 (trixie)."
      fi
      OS_FAMILY=debian
      ;;
    ubuntu)
      if [[ -z "${major:-}" ]] || (( major < 22 )); then
        error "Ubuntu ${VERSION_ID:-unknown} is unsupported. Use 22.04 LTS or 24.04 LTS."
      fi
      OS_FAMILY=debian
      ;;
    rocky|almalinux|rhel)
      if [[ -z "${major:-}" ]] || (( major < 9 )); then
        error "${NAME:-$ID} ${VERSION_ID:-unknown} is unsupported. Use the 9.x series."
      fi
      OS_FAMILY=rhel
      ;;
    centos)
      # Reject classic CentOS Linux (7/8 — both EOL). Accept CentOS Stream 9+
      # which advertises "CentOS Stream" in NAME and stays current with RHEL.
      if [[ "${NAME:-}" != *"Stream"* ]]; then
        error "Classic CentOS Linux is end-of-life. Use Rocky/AlmaLinux/CentOS Stream 9+ or Debian/Ubuntu."
      fi
      if [[ -z "${major:-}" ]] || (( major < 9 )); then
        error "CentOS Stream ${VERSION_ID:-unknown} is unsupported. Use Stream 9 or 10."
      fi
      OS_FAMILY=rhel
      ;;
    amzn)
      # Amazon Linux 2023 (AL2023) only — AL2 reaches EOL on 2026-06-30
      # and doesn't ship modern enough kernels for Calico WireGuard
      # without manual backports. AL2023's VERSION_ID is "2023".
      if [[ "${VERSION_ID:-}" != "2023" ]]; then
        error "${NAME:-$ID} ${VERSION_ID:-unknown} is unsupported. Use Amazon Linux 2023 — AL2 is EOL on 2026-06-30."
      fi
      OS_FAMILY=rhel
      OS_VARIANT=amzn2023
      ;;
    *)
      error "Unsupported OS '${ID:-unknown}' (${PRETTY_NAME:-?}). Supported: Debian 12+, Ubuntu 22.04+, RHEL/Rocky/AlmaLinux 9+, CentOS Stream 9+, Amazon Linux 2023."
      ;;
  esac

  log "Detected OS: ${PRETTY_NAME} (family=${OS_FAMILY})"
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

  # Service name varies across distros: 'ssh.service' on Debian/Ubuntu,
  # 'sshd.service' on RHEL/Rocky/Alma/CentOS-Stream. Try both — only
  # one of the two is present per host. Failing on a known-good
  # sshd_config because of a unit-name guess would be an obvious bug.
  if systemctl list-unit-files ssh.service >/dev/null 2>&1; then
    systemctl reload ssh.service
  elif systemctl list-unit-files sshd.service >/dev/null 2>&1; then
    systemctl reload sshd.service
  else
    error "No ssh / sshd systemd unit found — cannot reload OpenSSH."
  fi

  marker_set "ssh-hardened"
  log "SSH hardened."
}

configure_node_logging_caps() {
  # Cap node-side log + dump growth so a crashlooping container or
  # noisy daemon can't fill the host disk and trigger kubelet's
  # eviction-hard threshold (which pulls Longhorn-csi-plugin off the
  # node and brings tenant PVCs down with it).
  #
  # Three sources of unbounded growth, three caps:
  #
  #   1. core dumps. The 2026-05-08 worker incident: Calico Felix
  #      crash-looped for 10 days; kernel default core_pattern=core
  #      wrote ~5000 × 5.7MB core files into the calico-node container's
  #      writable layer until the worker hit DiskPressure. Fix:
  #      core_pattern=|/bin/false drops dumps on the floor (matches
  #      `ulimit -c 0`). Operators who need real cores can override
  #      via /etc/sysctl.d/99-platform-cores.conf.
  #
  #   2. systemd journal. Default unit on Debian is "auto-detected"
  #      which can grow to 4GB+ on a busy node. Cap to 2GB so a
  #      log-spam loop is bounded.
  #
  #   3. logrotate / /var/log/calico. Calico's host-mounted log volume
  #      is rotated by the calico-node DaemonSet itself, but only when
  #      the pod is healthy. If the pod is stuck (image-pull, OOMKill
  #      loop) logs grow unbounded. Add a host-side daily rotate so
  #      they're capped regardless of pod state.
  if [[ "$SKIP_HARDENING" == true ]]; then
    log "Skipping node-logging caps (--skip-hardening)."
    return 0
  fi
  if marker_exists "node-logging-caps"; then
    log "Node logging caps already configured, skipping."
    return 0
  fi

  log "Configuring node-side logging caps (cores, journald, calico logs)..."

  # 1. core dumps: drop by default
  install -d -m 0755 /etc/sysctl.d
  cat > /etc/sysctl.d/99-platform-no-core-dumps.conf <<'EOF'
# Drop core dumps on the floor. Set by bootstrap.sh
# (configure_node_logging_caps). Override by deleting this file
# and setting core_pattern manually if you genuinely need cores
# for a specific debug session — but watch the disk.
kernel.core_pattern = |/bin/false
EOF
  sysctl --system >/dev/null

  install -d -m 0755 /etc/security/limits.d
  cat > /etc/security/limits.d/99-platform-no-cores.conf <<'EOF'
# Belt + suspenders for kernel.core_pattern=|/bin/false above.
* soft core 0
* hard core 0
root soft core 0
root hard core 0
EOF

  # 2. journald cap
  install -d -m 0755 /etc/systemd/journald.conf.d
  cat > /etc/systemd/journald.conf.d/99-platform-cap.conf <<'EOF'
[Journal]
# Cap journald to 2GB. Default is auto-detected (≤ 4GB on Debian)
# which is too much for a 38GB Hetzner CX21. Operators who need
# more journal history should override per-host.
SystemMaxUse=2G
SystemKeepFree=4G
SystemMaxFileSize=128M
RuntimeMaxUse=200M
EOF
  systemctl restart systemd-journald.service || true

  # 3. logrotate for /var/log/calico (host-mounted by calico-node)
  install -d -m 0755 /etc/logrotate.d
  cat > /etc/logrotate.d/calico <<'EOF'
/var/log/calico/*.log /var/log/calico/*/*.log {
  daily
  rotate 5
  size 50M
  compress
  delaycompress
  missingok
  notifempty
  copytruncate
  su root root
}
EOF

  marker_set "node-logging-caps"
  log "Node logging caps configured (cores=disabled, journal=2GB cap, calico=daily rotate)."
}

configure_node_net_tuning() {
  # Raise the kernel UDP receive limits so VXLAN, WireGuard, and any
  # tenant UDP workload don't hit rcvbuf overflow under gigabit bursts.
  #
  # Symptom this prevents (observed 2026-05-10 on staging1): UDP @1 Gbps
  # ingress dropped 15% packets even though the host was idle. Root
  # cause was rmem_max=212992 (kernel default ≈ 256 KB) clamping
  # iperf3 / Calico VXLAN / NetBird socket buffers far below the BDP.
  # Other staging hosts had rmem_max=16M from the cloud image;
  # staging1 didn't — classic config drift. Codifying it here keeps
  # every node consistent regardless of image variant.
  #
  # Values:
  #   rmem_max = 16 MB     — ceiling for setsockopt(SO_RCVBUF). Sized
  #                          for 10 Gbps cross-DC with autotuning.
  #   rmem_default = 4 MB  — default UDP socket buffer (TCP uses its
  #                          own tcp_rmem autotuning, unaffected).
  #   wmem_* mirrors rmem_* for symmetry.
  #   netdev_max_backlog = 10000 — per-CPU RX queue before the kernel
  #                          drops under softirq saturation. Default
  #                          1000 is too tight at gigabit+.
  #
  # Memory cost is bounded: ~50 MB per host worst case on a 4-CPU VM.
  # No effect on TCP (TCP autotuning is governed by net.ipv4.tcp_*).
  if [[ "$SKIP_HARDENING" == true ]]; then
    log "Skipping node net-tuning (--skip-hardening)."
    return 0
  fi
  if marker_exists "node-net-tuning"; then
    log "Node net-tuning already configured, skipping."
    return 0
  fi

  log "Configuring node net-tuning (UDP rcvbuf / netdev backlog)..."

  install -d -m 0755 /etc/sysctl.d
  cat > /etc/sysctl.d/99-cluster-net-tune.conf <<'EOF'
# Cluster network tuning — prevents UDP rcvbuf overflow under bursts.
# Set by bootstrap.sh (configure_node_net_tuning). See that function
# for the why; override by editing this file if a host genuinely
# needs different limits.
net.core.rmem_max = 16777216
net.core.rmem_default = 4194304
net.core.wmem_max = 16777216
net.core.wmem_default = 4194304
net.core.netdev_max_backlog = 10000
EOF
  sysctl --system >/dev/null

  marker_set "node-net-tuning"
  log "Node net-tuning configured (rmem_max=16M, rmem_default=4M, backlog=10000)."
}

install_packages() {
  log "Installing base packages (family=${OS_FAMILY})..."
  case "$OS_FAMILY" in
    debian) install_packages_apt ;;
    rhel)   install_packages_dnf ;;
    *) error "install_packages: unknown OS_FAMILY='${OS_FAMILY}' — check_os should have set this." ;;
  esac
  log "Base packages installed."
}

# Package rationale (shared across families):
#   xfsprogs / e2fsprogs: Longhorn formats/repairs tenant volumes; the
#     longhorn-tenant StorageClass uses xfs (k8s/base/longhorn/
#     storageclasses.yaml) and the storage-lifecycle fsck endpoint runs
#     xfs_repair / e2fsck on the host via a privileged Pod.
#   wireguard-tools: Calico-managed WireGuard pod encryption (UDP/51821)
#     needs the kernel module + userland; sysadmin-side meshes also use
#     wg/wg-quick. Bootstrap does NOT install NetBird/Tailscale clients —
#     sysadmin brings the mesh up first.
#   age: backup encryption / operator-key management.

install_packages_apt() {
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  # software-properties-common deliberately omitted — not in Debian 13
  # trixie repos and we don't use add-apt-repository anywhere.
  # gettext-base provides envsubst — required by apply_platform_manifests
  # to substitute ${DOMAIN} (and any future placeholders) into the
  # rendered staging overlay before kubectl apply.
  # tar is needed by Helm's get-helm-3 installer (extracts the binary
  # archive). Debian/Ubuntu cloud images include it by default; RHEL
  # minimal images do not — caught on Rocky 10.1 fresh install
  # 2026-05-01 ("Could not find tar. It is required to extract the
  # helm binary archive."). Pin it explicitly on both families so
  # the helm install step never depends on a base-image quirk.
  apt-get install -y -qq \
    curl wget gnupg2 ca-certificates \
    nftables fail2ban jq unzip tar git open-iscsi nfs-common \
    xfsprogs e2fsprogs \
    wireguard-tools \
    gettext-base \
    age \
    >/dev/null 2>&1
}

install_packages_dnf() {
  # AL2023 ships fail2ban / age / wireguard-tools in its core repos and
  # has no EPEL / no CRB / no PowerTools — enabling them fails. Branch
  # so the RHEL-9-family path stays unchanged.
  if [[ "$OS_VARIANT" != "amzn2023" ]]; then
    # EPEL provides fail2ban, age, and (on RHEL/CentOS-Stream)
    # wireguard-tools when CRB isn't enabled. Rocky/Alma 9 ship
    # wireguard-tools in the AppStream repo directly, but enabling
    # CRB + EPEL on every RHEL-9 variant is the smallest common
    # code path.
    dnf install -y -q epel-release >/dev/null 2>&1 || \
      error "Failed to install epel-release. RHEL-9-family clusters need EPEL for fail2ban + age."

    # CodeReady Builder (RHEL) / PowerTools / CRB (Rocky/Alma) —
    # name varies by release. Try both; ignore failure (some EPEL
    # packages don't need it).
    dnf config-manager --enable crb >/dev/null 2>&1 \
      || dnf config-manager --enable powertools >/dev/null 2>&1 \
      || true
  fi

  # RHEL-9 minimal images ship 'curl-minimal' (provides the curl binary)
  # which conflicts with the full 'curl' package; --allowerasing lets dnf
  # transparently swap if a transitive dep pulls full curl in. Omitting
  # 'curl' from the explicit list avoids the conflict on a fresh box.
  # gettext for envsubst (Debian splits envsubst into gettext-base; RHEL
  # ships it inside the main gettext package).
  #
  # `age` is omitted here and installed separately by install_age_if_missing
  # because it's not packaged on AL2023 (no EPEL) — install_age_if_missing
  # falls back to the upstream static binary when the package isn't
  # available, which is also a safe no-op when dnf provides age.
  dnf install -y -q --allowerasing \
    wget gnupg2 ca-certificates \
    nftables fail2ban jq unzip tar git iscsi-initiator-utils nfs-utils \
    xfsprogs e2fsprogs \
    wireguard-tools \
    gettext \
    >/dev/null 2>&1
  if [[ "$OS_VARIANT" != "amzn2023" ]]; then
    # On RHEL/Rocky/Alma/CentOS-Stream, EPEL provides age; install it
    # via dnf so we get distro-managed updates. amzn2023 takes the
    # static-binary path below.
    dnf install -y -q age >/dev/null 2>&1 || true
  fi
  install_age_if_missing
}

# Install age from the upstream GitHub release tarball if the system
# package isn't available. Used by AL2023 (no EPEL) and as a defensive
# fallback for any RHEL variant where the EPEL `age` install slipped
# through. age is required by the Tier-1 secrets bundle; the script
# errors out at bundle time without it.
install_age_if_missing() {
  if command -v age >/dev/null 2>&1 && command -v age-keygen >/dev/null 2>&1; then
    return 0
  fi
  local arch="amd64"
  case "$(uname -m)" in
    x86_64) arch="amd64" ;;
    aarch64|arm64) arch="arm64" ;;
    *) error "install_age_if_missing: unsupported arch '$(uname -m)'" ;;
  esac
  local age_ver="v1.2.1"
  local url="https://github.com/FiloSottile/age/releases/download/${age_ver}/age-${age_ver}-linux-${arch}.tar.gz"
  log "  age package not available — installing static binary ${age_ver}/${arch} from upstream..."
  local tmpdir
  tmpdir="$(mktemp -d)"
  if ! curl -fsSL "$url" -o "${tmpdir}/age.tar.gz" 2>/dev/null; then
    rm -rf "$tmpdir"
    error "Failed to download age from ${url}. Check outbound HTTPS connectivity to github.com."
  fi
  tar -xzf "${tmpdir}/age.tar.gz" -C "$tmpdir"
  install -m 0755 "${tmpdir}/age/age"        /usr/local/bin/age
  install -m 0755 "${tmpdir}/age/age-keygen" /usr/local/bin/age-keygen
  rm -rf "$tmpdir"
}

configure_firewall() {
  if [[ "$SKIP_HARDENING" == true ]]; then
    log "Skipping firewall (--skip-hardening)."
    return 0
  fi

  log "Configuring nftables firewall..."

  # Stop + mask any firewall daemon that would compete with our
  # /etc/nftables.conf. These run on default OS images and silently
  # write rules into different nft tables (firewalld → `inet firewalld`,
  # ufw → `inet ufw`), which interferes with how the runtime-firewall
  # reconciler reads/writes our `inet filter` table — and breaks the
  # tenant_ports_{tcp,udp} accept rules. Mask so a `dnf upgrade` doesn't
  # silently re-enable them on the next reboot.
  #
  #   firewalld  — RHEL 9 / Rocky 9 / Alma 9 / CentOS Stream 9/10 (default)
  #   ufw        — Ubuntu user installs (not enabled by default but common)
  #   nftables.service is OUR managed unit; nothing to disable there.
  for unit in firewalld.service ufw.service; do
    if systemctl list-unit-files "$unit" 2>/dev/null | grep -q "^${unit}"; then
      systemctl is-active --quiet "$unit" 2>/dev/null \
        && systemctl stop "$unit" 2>/dev/null \
        && log "  stopped competing firewall unit: $unit"
      systemctl is-enabled --quiet "$unit" 2>/dev/null \
        && systemctl mask "$unit" 2>/dev/null \
        && log "  masked competing firewall unit: $unit"
    fi
  done

  # ─── Auto-detect mesh interface for k3s --node-ip pinning ────────────
  # The detected CIDR populates CLUSTER_NETWORK_CIDR{,_V6} (used later
  # by install_k3s_{server,worker}'s --node-ip arg) AND is mirrored
  # into ALLOW_SOURCE_LIST_V{4,6} so the host firewall trusts mesh
  # peers from day one. Skipped when the operator passed --cluster-
  # network-cidr explicitly (parse_args already merged that into
  # ALLOW_SOURCE_LIST_V*).
  # Route auto-detected CIDRs through parse_allow_source_arg for the
  # same regex + python ipaddress validation the explicit --allow-source
  # path uses. Auto-detected values come from `ip route show` parsing
  # (low risk) but a future kernel/route-table change could surface
  # unexpected formats; the validator is the single source of truth.
  if [[ -z "$CLUSTER_NETWORK_CIDR" ]]; then
    if detected=$(detect_mesh_v4_cidr 2>/dev/null); then
      CLUSTER_NETWORK_CIDR="$detected"
      parse_allow_source_arg "$detected"
      log "Auto-detected mesh interface; --cluster-network-cidr=${CLUSTER_NETWORK_CIDR} (mirrored into allow-source)"
      if [[ -z "$CLUSTER_NETWORK_CIDR_V6" ]]; then
        CLUSTER_NETWORK_CIDR_V6=$(detect_mesh_v6_cidr 2>/dev/null || true)
        if [[ -n "$CLUSTER_NETWORK_CIDR_V6" ]]; then
          parse_allow_source_arg "$CLUSTER_NETWORK_CIDR_V6"
          log "  + auto-detected v6: --cluster-network-cidr-v6=${CLUSTER_NETWORK_CIDR_V6} (mirrored)"
        fi
      fi
    fi
  fi

  log "Firewall: always-on set mode (cluster_peers + trusted_ranges)"
  log "  trust seed: v4=${#ALLOW_SOURCE_LIST_V4[@]} v6=${#ALLOW_SOURCE_LIST_V6[@]} entries"

  # ─── cluster_allow rules ──────────────────────────────────────────────
  # Two scopes, both gated by nft sets the reconciler converges:
  #   cluster_peers_v{4,6}   — control-plane ports for kube-cluster peers
  #     (kube-API node InternalIPs).
  #   trusted_ranges_v{4,6}  — full TCP/UDP for operator-blessed sources
  #     (workstation IPs, private LANs, partner systems). Day-2 managed
  #     via Settings → Cluster Networking; bootstrap seeds from
  #     --allow-source.
  local cluster_allow="    # Cluster peers (control-plane ports only) — converged from kube-API
    # by firewall-reconciler. Helpers /usr/local/bin/peer-firewall-
    # {add,remove} are break-glass for the bootstrap-time window.
    ip  saddr @cluster_peers_v4 tcp dport { 6443, 8443, 10250, 5473, 2379-2380 } accept
    ip6 saddr @cluster_peers_v6 tcp dport { 6443, 8443, 10250, 5473, 2379-2380 } accept

    # Trusted ranges (full TCP/UDP) — converged from ClusterTrustedRange
    # CRDs by firewall-reconciler. Bootstrap-time entries from
    # --allow-source flag are seeded directly into the nft set.
    ip  saddr @trusted_ranges_v4 ip protocol tcp accept
    ip  saddr @trusted_ranges_v4 ip protocol udp accept
    ip6 saddr @trusted_ranges_v6 meta l4proto tcp accept
    ip6 saddr @trusted_ranges_v6 meta l4proto udp accept"

  # ─── Calico WireGuard scoping (default: public) ───────────────────────
  local calico_wg_rule="    # Calico WireGuard (UDP/51821) — public-key auth makes exposure safe.
    # Calico's WG endpoint is the underlay (eth0) IP, so scoping to a
    # mesh CIDR would block legitimate handshakes. Override with
    # --calico-wg-public=false on real-VLAN deployments only.
    udp dport 51821 accept"
  if [[ "$CALICO_WG_PUBLIC" == "false" ]]; then
    calico_wg_rule="    # Calico WireGuard (UDP/51821) — scoped to trusted_ranges (real-VLAN opt-in).
    ip  saddr @trusted_ranges_v4 udp dport 51821 accept
    ip6 saddr @trusted_ranges_v6 udp dport 51821 accept"
  fi

  # ─── nft set declarations ─────────────────────────────────────────────
  # All four firewall sets are always declared. Empty sets are valid;
  # rules referencing an empty set are no-ops, so single-node clusters
  # and freshly-bootstrapped first servers work without special-casing.
  #
  #   cluster_peers_v{4,6}   — converged by firewall-reconciler from
  #     kube-API node InternalIPs.
  #   trusted_ranges_v{4,6}  — converged by firewall-reconciler from
  #     ClusterTrustedRange CRDs; bootstrap also seeds from --allow-source.
  #   tenant_ports_{tcp,udp} — runtime-managed by worker-firewall-
  #     reconciler from Pod hostPort + platform.io/firewall-{tcp,udp}-
  #     ports annotations. See docs/04-deployment/RUNTIME_FIREWALL.md.
  local set_decls="  set tenant_ports_tcp {
    type inet_service
    flags interval
  }
  set tenant_ports_udp {
    type inet_service
    flags interval
  }
  set cluster_peers_v4 {
    type ipv4_addr
    flags interval
  }
  set cluster_peers_v6 {
    type ipv6_addr
    flags interval
  }
  set trusted_ranges_v4 {
    type ipv4_addr
    flags interval
  }
  set trusted_ranges_v6 {
    type ipv6_addr
    flags interval
  }
"

  cat > /etc/nftables.conf <<NFT
#!/usr/sbin/nft -f

flush ruleset

table inet filter {
${set_decls}
  chain input {
    type filter hook input priority filter; policy drop;

    iif "lo" accept
    ct state established,related accept

    ip protocol icmp accept
    ip6 nexthdr icmpv6 accept

    # Public-facing — tenants and operators must always reach these.
    tcp dport 80 accept      # HTTP
    tcp dport 443 accept     # HTTPS
    tcp dport 22 accept      # SSH

    # Public-key-authenticated UDP — exposure is safe.
    udp dport 51820 accept   # NetBird WireGuard
    udp dport 29899 accept   # NetBird direct connection

    # Pod CIDR — kube-proxy DNATs cluster Service VIPs (e.g. 10.43.0.1
    # → kube-apiserver on host:6443) WITHOUT SNAT, so the packet arrives
    # at the host INPUT chain with the pod's source IP. Calico's
    # natOutgoing POSTROUTING chain SNATs it to the host IP eventually,
    # but on a fresh install there's a race window where in-cluster pods
    # (metrics-server, coredns, calico-apiserver, etc.) crashloop with
    # "i/o timeout" against 10.43.0.1:443 before Calico's NAT rules
    # are active. Pod CIDR is internal cluster traffic only; it isn't
    # routable from outside.
    ip saddr ${POD_CIDR_V4} tcp dport { 6443, 8443, 10250, 5473, 2379-2380 } accept

${cluster_allow}

${calico_wg_rule}

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

    # Runtime-managed tenant host ports — populated by
    # firewall-reconciler DaemonSet at runtime as Pods land
    # with hostPort or the platform.io/firewall-{tcp,udp}-ports
    # annotations. Bootstrap leaves the sets empty; the reconciler
    # is the only writer. Same chain on server + worker nodes (server-
    # side host ports are gated by an admin toggle in System Settings).
    tcp dport @tenant_ports_tcp accept
    udp dport @tenant_ports_udp accept

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
  log "Firewall configured (always-on set mode)."

  # Always seed the firewall sets — set mode is the only mode now.
  seed_firewall_sets
  install_peer_firewall_helpers
}

# Seed cluster_peers_v{4,6} + trusted_ranges_v{4,6} nft sets at bootstrap.
#
# cluster_peers seeded with:
#   - this node's primary outbound IPv4 + IPv6 (so the local kubelet
#     etc. trust traffic from self before kube-API knows about us)
#   - the join target's IP from --server, if joining (so we can hit
#     its :6443 to register; the existing peer must have ALREADY added
#     our IP via peer-firewall-add OR via Settings → Cluster Networking
#     → Pre-Enroll Node, which writes a ClusterPendingPeer CRD that the
#     reconciler converges into the existing peers' sets)
#
# trusted_ranges seeded from --allow-source (already validated and
# normalized in parse_args). Once platform-api is up, day-2 management
# is via Settings → Cluster Networking — that page writes
# ClusterTrustedRange CRDs which the reconciler converges. Bootstrap
# entries persist as raw nft set members until the operator either
# adds them via the UI (idempotent, no-op) or removes them.
seed_firewall_sets() {
  log "Seeding firewall nft sets..."
  local local_v4 local_v6 entry
  local_v4=$(detect_local_ipv4 || true)
  local_v6=$(detect_local_ipv6 || true)
  # Each `nft add element` is wrapped in an explicit if/then/else so a
  # non-zero exit (already present, set undeclared) doesn't abort under
  # set -e. Failures are logged but non-fatal — the reconciler DaemonSet
  # repopulates from kube-API once it's running.
  if [[ -n "$local_v4" ]]; then
    if nft add element inet filter cluster_peers_v4 "{ ${local_v4} }" 2>/dev/null; then
      log "  + cluster_peers_v4 ${local_v4} (self)"
    else
      warn "  failed to seed cluster_peers_v4 self ${local_v4}; reconciler will repopulate"
    fi
  fi
  if [[ -n "$local_v6" ]]; then
    if nft add element inet filter cluster_peers_v6 "{ ${local_v6} }" 2>/dev/null; then
      log "  + cluster_peers_v6 ${local_v6} (self)"
    else
      warn "  failed to seed cluster_peers_v6 self ${local_v6}; reconciler will repopulate"
    fi
  fi
  if [[ -n "$K3S_SERVER_IP" ]]; then
    if nft add element inet filter cluster_peers_v4 "{ ${K3S_SERVER_IP} }" 2>/dev/null; then
      log "  + cluster_peers_v4 ${K3S_SERVER_IP} (join target)"
    else
      warn "  failed to seed cluster_peers_v4 join target ${K3S_SERVER_IP}; manual intervention may be required"
    fi
    log ""
    log "  IMPORTANT — joining an existing cluster requires this node's"
    log "  IP to be pre-authorised on every existing peer. Either:"
    log "    (a) Settings → Cluster Networking → Pre-Enroll Node (preferred)"
    log "    (b) On each existing peer, run BEFORE this bootstrap:"
    log "          /usr/local/bin/peer-firewall-add ${local_v4}"
    log "  Otherwise this node cannot reach :6443 and the join will hang."
    log ""
  fi
  # Seed trusted_ranges from the --allow-source flag entries. Each
  # element was already normalized to a CIDR (with prefix) by
  # parse_allow_source_arg, so no further validation is needed here.
  for entry in "${ALLOW_SOURCE_LIST_V4[@]+"${ALLOW_SOURCE_LIST_V4[@]}"}"; do
    if nft add element inet filter trusted_ranges_v4 "{ ${entry} }" 2>/dev/null; then
      log "  + trusted_ranges_v4 ${entry}"
    else
      warn "  failed to seed trusted_ranges_v4 ${entry}; check nft set declaration"
    fi
  done
  for entry in "${ALLOW_SOURCE_LIST_V6[@]+"${ALLOW_SOURCE_LIST_V6[@]}"}"; do
    if nft add element inet filter trusted_ranges_v6 "{ ${entry} }" 2>/dev/null; then
      log "  + trusted_ranges_v6 ${entry}"
    else
      warn "  failed to seed trusted_ranges_v6 ${entry}; check nft set declaration"
    fi
  done
}

# Install the /usr/local/bin/peer-firewall-{add,remove} helpers —
# break-glass for the bootstrap-time window before a new peer appears
# in kube-API. The preferred path is the admin panel (Settings →
# Cluster Networking → Pre-Enroll Node), which writes a
# ClusterPendingPeer CRD that the reconciler converges. These helpers
# remain installed for emergencies (platform-api unreachable, etc.).
install_peer_firewall_helpers() {
  log "Installing /usr/local/bin/peer-firewall-{add,remove}..."

  cat > /usr/local/bin/peer-firewall-add <<'HELPER'
#!/usr/bin/env bash
# peer-firewall-add — Break-glass: add a cluster peer to the local nft
# set. The admin panel (Settings → Cluster Networking → Pre-Enroll Node)
# is the preferred path. Use this helper only when the platform UI is
# unreachable. The firewall-reconciler DaemonSet converges
# membership from kube-API once the new node has registered.
set -euo pipefail
[[ $# -eq 1 ]] || { echo "usage: $0 <ip>" >&2; exit 2; }
ip="$1"
# Strict IP validation BEFORE handing the value to nft. The element
# expression is concatenated into an nft grammar string downstream;
# without this guard a value like "1.2.3.4 }; flush ruleset" would
# inject arbitrary nft commands at root.
v4_re='^([0-9]{1,3}\.){3}[0-9]{1,3}$'
v6_re='^[0-9a-fA-F:]+$'
if [[ "$ip" =~ $v4_re ]]; then
  set_name=cluster_peers_v4
elif [[ "$ip" =~ $v6_re && "$ip" == *:* ]]; then
  set_name=cluster_peers_v6
else
  echo "error: '$ip' is not a valid IPv4 or IPv6 address" >&2
  exit 2
fi
if ! nft list set inet filter "$set_name" >/dev/null 2>&1; then
  echo "error: nft set '$set_name' does not exist." >&2
  echo "       This node was bootstrapped before always-on set mode landed." >&2
  echo "       Re-run scripts/bootstrap.sh on this node to pick up the new firewall layout." >&2
  exit 1
fi
nft add element inet filter "$set_name" "{ ${ip} }"
echo "Added ${ip} to ${set_name}."
HELPER
  chmod +x /usr/local/bin/peer-firewall-add

  cat > /usr/local/bin/peer-firewall-remove <<'HELPER'
#!/usr/bin/env bash
# peer-firewall-remove — Revoke a cluster peer from the local nft set.
# The reconciler normally handles departures by removing nodes that no
# longer appear in kube-API. Use this only to manually purge an IP
# that won't reappear (abandoned join, decommissioned host).
set -euo pipefail
[[ $# -eq 1 ]] || { echo "usage: $0 <ip>" >&2; exit 2; }
ip="$1"
v4_re='^([0-9]{1,3}\.){3}[0-9]{1,3}$'
v6_re='^[0-9a-fA-F:]+$'
if [[ "$ip" =~ $v4_re ]]; then
  set_name=cluster_peers_v4
elif [[ "$ip" =~ $v6_re && "$ip" == *:* ]]; then
  set_name=cluster_peers_v6
else
  echo "error: '$ip' is not a valid IPv4 or IPv6 address" >&2
  exit 2
fi
if ! nft list set inet filter "$set_name" >/dev/null 2>&1; then
  echo "error: nft set '$set_name' does not exist." >&2
  exit 1
fi
if nft delete element inet filter "$set_name" "{ ${ip} }" 2>/dev/null; then
  echo "Removed ${ip} from ${set_name}."
else
  echo "${ip} was not in ${set_name} (no-op)."
fi
HELPER
  chmod +x /usr/local/bin/peer-firewall-remove
}

seed_cluster_trusted_range_crs() {
  # Apply ClusterTrustedRange CRs from the operator's --allow-source
  # entries (and the auto-detected mesh CIDR) so the
  # firewall-reconciler converges them into trusted_ranges_v{4,6}
  # nft sets across all nodes — and so they survive reconciler ticks
  # (the reconciler's atomic flush+add would otherwise wipe the
  # bootstrap-time-only nft seed on first reconcile).
  #
  # Idempotent: a CR with the same name + spec.cidr is a no-op; a
  # different spec.cidr triggers a reconciler resync. This function
  # is a no-op when the CRD doesn't exist (e.g. the platform overlay
  # is still being applied) — caller retries on the next bootstrap
  # re-run if needed.
  if [[ ${#ALLOW_SOURCE_LIST_V4[@]} -eq 0 && ${#ALLOW_SOURCE_LIST_V6[@]} -eq 0 ]]; then
    return 0
  fi
  if ! kctl get crd clustertrustedranges.networking.platform.phoenix-host.net &>/dev/null; then
    log "ClusterTrustedRange CRD not yet applied — skipping CR seed; re-run bootstrap.sh after Flux finishes to pick up."
    return 0
  fi

  log "Seeding ClusterTrustedRange CRs from --allow-source entries..."
  local idx=0
  local entry name
  for entry in "${ALLOW_SOURCE_LIST_V4[@]+"${ALLOW_SOURCE_LIST_V4[@]}"}" \
               "${ALLOW_SOURCE_LIST_V6[@]+"${ALLOW_SOURCE_LIST_V6[@]}"}"; do
    # Deterministic CR name: bootstrap-seed-NN. Allows operators to
    # rename / take ownership via the admin UI later (UI-created CRs
    # use friendly names; the seed CRs stay until explicitly deleted).
    name="bootstrap-seed-$(printf '%02d' $idx)"
    idx=$((idx + 1))
    kctl apply -f - <<CR | grep -v "unchanged" || true
apiVersion: networking.platform.phoenix-host.net/v1alpha1
kind: ClusterTrustedRange
metadata:
  name: ${name}
  labels:
    platform.phoenix-host.net/seed: bootstrap
spec:
  cidr: ${entry}
  description: bootstrap.sh --allow-source seed (rename via admin UI to take ownership)
  addedBy: bootstrap.sh
CR
    log "  + ClusterTrustedRange/${name} cidr=${entry}"
  done
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

verify_underlay() {
  # Bootstrap does NOT install or enrol any VPN/mesh tooling — that's a
  # sysadmin responsibility, performed before this script runs. With
  # always-on set mode, an underlay is no longer required for the
  # firewall to be safe (cluster_peers + trusted_ranges + the reconciler
  # cover that). The remaining role of this function is narrow: when
  # the operator passed --cluster-network-cidr (explicit OR auto-
  # detected from wt0/tailscale0), k3s will be told to bind/advertise
  # an IP inside that CIDR. Verify the host actually has such an IP,
  # to fail loud rather than letting k3s pick a default-route IP and
  # silently advertise the public address.
  if [[ -n "$CLUSTER_NETWORK_CIDR" ]]; then
    local ip
    ip=$(resolve_cluster_network_ip)
    if [[ -z "$ip" ]]; then
      error "No host IP found inside --cluster-network-cidr ${CLUSTER_NETWORK_CIDR}.
       Bring up your VPN (NetBird/Tailscale: 'netbird up' / 'tailscale up')
       or attach the host to its private VLAN BEFORE running bootstrap.
       This script does not install or enrol VPN tooling."
    fi
    log "Underlay OK: host IP ${ip} is inside ${CLUSTER_NETWORK_CIDR}."
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

  # M12: every system Deployment with replicas>1 also gets a topology
  # spread constraint so the replicas land one-per-host (with maxSkew=1
  # ScheduleAnyway as the soft constraint — degrades gracefully when
  # only 1 server exists). Without this, the scheduler keeps placing
  # replicas on whichever server got Ready first; on the 2026-04-25
  # 4-node staging cluster that put all CoreDNS/oauth2-proxy/dex/
  # admin/client/postgres/redis pods on staging, leaving staging at
  # ~52% RAM while staging2/3 sat near idle.
  local server_patch
  server_patch='{"spec":{"template":{"spec":{"affinity":{"nodeAffinity":{"requiredDuringSchedulingIgnoredDuringExecution":{"nodeSelectorTerms":[{"matchExpressions":[{"key":"platform.phoenix-host.net/node-role","operator":"In","values":["server"]}]}]}}},"tolerations":[{"key":"platform.phoenix-host.net/server-only","operator":"Equal","value":"true","effect":"NoSchedule"}]}}}}'
  local toleration_only_patch
  toleration_only_patch='{"spec":{"template":{"spec":{"tolerations":[{"key":"platform.phoenix-host.net/server-only","operator":"Equal","value":"true","effect":"NoSchedule"}]}}}}'

  # Apply a topology spread constraint to a Deployment by pod label.
  # Args: namespace, deployment-name, label-key, label-value
  apply_topology_spread() {
    local ns="$1" name="$2" lkey="$3" lval="$4"
    local patch
    patch='{"spec":{"template":{"spec":{"topologySpreadConstraints":[{"maxSkew":1,"topologyKey":"kubernetes.io/hostname","whenUnsatisfiable":"ScheduleAnyway","labelSelector":{"matchLabels":{"'"$lkey"'":"'"$lval"'"}}}]}}}}'
    kubectl patch deployment "$name" -n "$ns" --type=strategic --patch="$patch" 2>/dev/null || true
  }

  # Control-plane-only (pin to server + tolerate server-only taint).
  # `|| true` because not every combination is guaranteed to exist on
  # every run (e.g. flux might be skipped via --skip-flux).
  for ns_name in \
      "flux-system:source-controller" \
      "flux-system:kustomize-controller" \
      "flux-system:helm-controller" \
      "flux-system:notification-controller" \
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
  # the Traefik DaemonSet and break public traffic to tenants on other nodes.
  for ns_name in \
      "traefik:traefik" \
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
    # (traefik, longhorn-manager), others Deployments (csi-*, UI).
    kubectl patch deployment "$name" -n "$ns" \
      --type=strategic \
      --patch="$toleration_only_patch" 2>/dev/null \
    || kubectl patch daemonset "$name" -n "$ns" \
      --type=strategic \
      --patch="$toleration_only_patch" 2>/dev/null \
    || true
  done

  # 2026-05-08 efficiency audit: bump under-provisioned memory requests
  # to 128Mi on system daemons whose default install values don't reflect
  # actual usage. This is scheduler-accuracy correction — actual memory
  # use is unchanged, but the scheduler will now refuse to over-pack a
  # node based on ground-truth needs, eliminating the 0/0/0 OOM-kill
  # surprise pattern observed pre-audit. Helm-installed daemons (ingress-
  # nginx + Longhorn + CNPG) get their bumps in their respective
  # `--set` flags above; Flux + Tigera ship fixed manifests, so we
  # patch them post-install here.
  bump_request_memory() {
    local ns="$1" name="$2" container="$3" cpu="$4" mem="$5"
    local patch
    patch='{"spec":{"template":{"spec":{"containers":[{"name":"'"$container"'","resources":{"requests":{"cpu":"'"$cpu"'","memory":"'"$mem"'"}}}]}}}}'
    kubectl patch deployment "$name" -n "$ns" --type=strategic --patch="$patch" 2>/dev/null \
      || kubectl patch daemonset "$name" -n "$ns" --type=strategic --patch="$patch" 2>/dev/null \
      || true
  }

  # Flux controllers — manifests ship without resource requests, every
  # pod schedules with 0 requests until k8s OOMs. 128Mi covers steady-
  # state observation 2026-05-08: 90-110 Mi resident across all four.
  bump_request_memory flux-system source-controller manager 50m 128Mi
  bump_request_memory flux-system kustomize-controller manager 50m 128Mi
  bump_request_memory flux-system helm-controller manager 50m 128Mi
  bump_request_memory flux-system notification-controller manager 50m 128Mi
  # 2026-05-09: image-reflector-controller + image-automation-controller
  # removed from the platform — replaced by the in-CI tag-pin step in
  # .github/workflows/build-deploy.yml. Saves ~333 Mi RAM per cluster
  # and removes the long-lived PAT auth surface that broke 2026-05-04.
  # No bump_request_memory entries needed; the deployments don't exist.

  # Tigera operator — sole calico-operator pod, ships with no requests.
  bump_request_memory tigera-operator tigera-operator tigera-operator 50m 128Mi

  # M12: scale CoreDNS to 2 replicas + spread across servers.
  # k3s ships CoreDNS=1 by default; on a 3-server cluster that's a
  # single point of DNS failure. Bump to 2 and topology-spread so
  # killing one server doesn't take cluster DNS down.
  if kubectl get deploy coredns -n kube-system &>/dev/null 2>&1; then
    local desired=2
    local nodes
    nodes=$(kubectl get nodes -l platform.phoenix-host.net/node-role=server --no-headers 2>/dev/null | wc -l)
    if [[ "$nodes" -ge 3 ]]; then desired=3; fi
    log "Scaling CoreDNS to ${desired} replicas + topology spread."
    kubectl scale deployment/coredns -n kube-system --replicas="$desired" 2>/dev/null || true
    apply_topology_spread kube-system coredns k8s-app kube-dns
  fi

  # M12: spread the public-facing platform Deployments across servers.
  # These all live in the platform overlay (Flux-managed); patch them
  # in-place so the constraint sticks even after Flux re-reconciles
  # (kubectl patch updates the Deployment spec, Flux server-side-apply
  # preserves the field on next reconcile because we own that path).
  for ns_name_label in \
      "platform:platform-api:app=platform-api" \
      "platform:admin-panel:app=admin-panel" \
      "platform:client-panel:app=client-panel" \
      "platform:dex:app=dex" \
      "platform:oauth2-proxy:app.kubernetes.io/name=oauth2-proxy"; do
    local ns="${ns_name_label%%:*}"
    local rest="${ns_name_label#*:}"
    local name="${rest%%:*}"
    local label="${rest#*:}"
    local lkey="${label%%=*}"
    local lval="${label#*=}"
    apply_topology_spread "$ns" "$name" "$lkey" "$lval"
  done

  # M12: scale platform-api to N replicas (one per server). HA + halves
  # the load on the original first-server host. Only do this on the
  # FIRST bootstrap (NODE_ROLE==server, no --server flag); subsequent
  # server-joins skip — they'd just thrash the existing replica count.
  if [[ -z "$K3S_SERVER_IP" ]] && kubectl get deploy platform-api -n platform &>/dev/null 2>&1; then
    local api_desired=2
    local server_count
    server_count=$(kubectl get nodes -l platform.phoenix-host.net/node-role=server --no-headers 2>/dev/null | wc -l)
    if [[ "$server_count" -ge 3 ]]; then api_desired=3; fi
    log "Scaling platform-api to ${api_desired} replicas across servers."
    kubectl scale deployment/platform-api -n platform --replicas="$api_desired" 2>/dev/null || true
  fi

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

  # NOTE: the Longhorn node-tag step has moved out of this function.
  # It now runs from main() AFTER apply_platform_manifests so the
  # admission webhook is guaranteed to have endpoints by the time we
  # patch — see tag_longhorn_node_for_system_replicas() and
  # project_testing_bootstrap_2026_05_08.md issue 2.
}

# Idempotent — patches Longhorn Node CR so BOTH .spec.tags AND each
# disk's .spec.disks.<id>.tags include "system". Both are required by
# the platform's longhorn-system-local StorageClass (nodeSelector +
# replica scheduler match against both). Self-contained: waits for the
# admission webhook AND for the Node CR, then verifies the patch stuck
# (Longhorn's config-map controller can clobber spec mid-startup).
apply_longhorn_node_tag() {
  local node_name="$1"
  local i

  # Wait for the longhorn-admission-webhook to have ready endpoints.
  # Without this, the patch is silently rejected ("no endpoints
  # available for service longhorn-admission-webhook") and tags=[]
  # on the Node CR — every system-tier PVC then sticks Pending with
  # "specified node tag system does not exist". Caught on the
  # 2026-05-08 testing.phoenix-host.net bootstrap (51s gap between
  # tag patch attempt and webhook becoming ready).
  log "  waiting for longhorn-admission-webhook endpoints (max 5 min)..."
  i=0
  while ! kctl get endpoints -n longhorn-system longhorn-admission-webhook \
            -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null \
            | grep -q '[0-9]'; do
    i=$((i + 5))
    if [[ "$i" -ge 300 ]]; then
      error "  longhorn-admission-webhook never became ready in 5 min."
    fi
    sleep 5
  done

  # Wait for Longhorn Node CR (created asynchronously by longhorn-manager).
  i=0
  while ! kubectl get node.longhorn.io -n longhorn-system "$node_name" >/dev/null 2>&1; do
    i=$((i + 2))
    if [[ "$i" -ge 60 ]]; then
      error "  longhorn node.${node_name} did not register within 60s."
    fi
    sleep 2
  done

  log "Tagging Longhorn node ${node_name} with 'system' (node + all disks)..."

  # Up to 6 attempts (30 + a few jq seconds each = ~3 min cap). Each
  # attempt re-reads the node, applies the tags via SSA (so additions
  # merge cleanly on re-runs), then verifies via fresh re-read. The
  # config-map controller occasionally clobbers spec.tags shortly
  # after manager startup, so verify-and-retry is mandatory.
  local attempt nodetag disktag
  for attempt in 1 2 3 4 5 6; do
    kubectl get node.longhorn.io -n longhorn-system "$node_name" -o json \
      | jq '.spec.tags = ["system"] | .spec.disks |= map_values(.tags = ["system"])' \
      | kubectl apply --server-side --force-conflicts \
                      --field-manager=bootstrap-longhorn-tag -f - >/dev/null 2>&1 || true

    sleep 3
    nodetag=$(kubectl get node.longhorn.io -n longhorn-system "$node_name" \
                -o jsonpath='{.spec.tags[?(@=="system")]}' 2>/dev/null)
    # Concatenated count: at least one disk tagged "system" — empty
    # disk maps would yield "" which fails the check.
    disktag=$(kubectl get node.longhorn.io -n longhorn-system "$node_name" \
                -o jsonpath='{.spec.disks.*.tags[?(@=="system")]}' 2>/dev/null)
    if [[ "$nodetag" == "system" && "$disktag" == *"system"* ]]; then
      log "  longhorn ${node_name} tagged on attempt ${attempt} (node='${nodetag}', disks contain 'system')."
      return 0
    fi
    log "  attempt ${attempt}/6: tag did not stick (node='${nodetag}', disks='${disktag}'); retrying..."
    sleep 5
  done

  error "  longhorn node tag never stuck after 6 attempts — system-tier PVCs will fail to provision."
}

# Public entry: idempotent, safe to re-run. Workers stay untagged
# (tenant SC has no nodeSelector). For workers this function is
# called from the control plane via integration scripts, not from
# the worker's own bootstrap.
tag_longhorn_node_for_system_replicas() {
  if [[ "$NODE_ROLE" == "worker" ]]; then
    log "Worker node — Longhorn 'system' tag is server-only, skipping."
    return 0
  fi
  apply_longhorn_node_tag "$(hostname)"
}

install_k3s() {
  if command -v k3s &>/dev/null; then
    local installed
    # k3s --version output is two lines:
    #   k3s version v1.33.10+k3s1 (52978a7f)
    #   go version go1.24.13
    # Constraining awk to NR==1 prevents the second line from joining
    # the captured value via the command-substitution newline glue,
    # which previously made the comparison below fall through and
    # re-run the installer with potentially-changed --node-ip /
    # --advertise-address flags on existing clusters (broke staging1
    # etcd membership 2026-05-08 — auto-detect picked NetBird wt0 IP
    # while existing etcd state expected the public IP).
    installed="$(k3s --version | awk 'NR==1 {print $3}')"
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
# Detect the host's primary public IPv4 — robustly, even when an
# operator VPN (NetBird, Tailscale, Headscale, raw WireGuard,
# OpenVPN, IPsec) is up and may carry a default-route to public
# internet. Returns the first IP that satisfies BOTH:
#   1) Routes to a public address (`ip route get` returns it as src)
#   2) Is NOT bound to a known VPN interface
#
# Excluded interface names cover common mesh/VPN tunnels:
#   wt0           — NetBird
#   tailscale*    — Tailscale (rare to drop their interface but covered)
#   wg*           — wg-quick / Headscale / userspace WireGuard
#   tun*          — OpenVPN tun mode + many corporate VPN clients
#   tap*          — OpenVPN tap mode
#   ipsec*, ppp*, gre*  — legacy VPN options
#   cali*, vxlan.calico, wireguard.cali  — Calico's own interfaces
#                  (defensive — Calico won't be up at the time we
#                  call this in install_k3s_*, but pre-existing
#                  state from a previous install might linger)
#
# Falls back to "first global IPv4 not on a VPN-named interface" if
# `ip route get 1.1.1.1` fails (some hosts block ICMP-style probes).
detect_public_ipv4() {
  local probe_ips=("1.1.1.1" "8.8.8.8" "9.9.9.9")  # tried in order
  local vpn_re='^(wt[0-9]*|tailscale[0-9]*|wg[0-9]*|tun[0-9]*|tap[0-9]*|ipsec[0-9]*|ppp[0-9]*|gre[0-9]*|cali[0-9a-f]+|vxlan\.calico|wireguard\.calico|wireguard\.cali)$'

  # Path A: ask the kernel which IP+iface it would use for a public probe.
  local probe ip_route iface src_ip
  for probe in "${probe_ips[@]}"; do
    ip_route=$(ip -4 -o route get "$probe" 2>/dev/null | head -1) || continue
    [[ -z "$ip_route" ]] && continue
    iface=$(echo "$ip_route" | awk '{
      for (i = 1; i < NF; i++) if ($i == "dev") { print $(i+1); exit }
    }')
    src_ip=$(echo "$ip_route" | awk '{
      for (i = 1; i < NF; i++) if ($i == "src") { print $(i+1); exit }
    }')
    [[ -z "$iface" || -z "$src_ip" ]] && continue
    # Reject if the chosen interface is a known VPN tunnel.
    if [[ "$iface" =~ $vpn_re ]]; then
      continue
    fi
    echo "$src_ip"
    return 0
  done

  # Path B: walk `ip -4 -o addr show` and pick the first GLOBAL-scope
  # IP whose interface ISN'T a known VPN. Filter out RFC1918/CGNAT/
  # link-local — those are cluster-internal/VPN underlays, not public.
  local line addr ifname
  while IFS= read -r line; do
    ifname=$(echo "$line" | awk '{print $2}')
    addr=$(echo "$line" | awk '{print $4}' | cut -d/ -f1)
    [[ -z "$ifname" || -z "$addr" ]] && continue
    if [[ "$ifname" =~ $vpn_re ]]; then continue; fi
    # Skip loopback, link-local 169.254/16, RFC1918, CGNAT 100.64/10.
    case "$addr" in
      127.*|169.254.*|10.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*|192.168.*) continue ;;
      100.6[4-9].*|100.[7-9][0-9].*|100.1[01][0-9].*|100.12[0-7].*) continue ;;
    esac
    # Confirm scope global (not host/link).
    if echo "$line" | grep -q "scope global"; then
      echo "$addr"
      return 0
    fi
  done < <(ip -4 -o addr show 2>/dev/null)

  return 1
}

# Auto-detect a NetBird/Tailscale mesh interface and its CIDR. Both
# default to the CGNAT range 100.64.0.0/10. Returns the CIDR on stdout
# and 0 on success; returns 1 (no output) when no recognised mesh
# interface is up. Called by configure_firewall when CLUSTER_NETWORK_CIDR
# is unset, so operators don't have to repeat the flag when their host
# already has wt0 / tailscale0 up.
detect_mesh_v4_cidr() {
  local ifname
  for ifname in wt0 tailscale0; do
    if ip -4 -o addr show "$ifname" 2>/dev/null \
         | grep -qE 'inet 100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.'; then
      echo "100.64.0.0/10"
      return 0
    fi
  done
  return 1
}

# Auto-detect IPv6 CIDR from a mesh interface. Reads the announced
# route prefix off the interface (NetBird advertises a ULA range,
# Tailscale advertises 'fd7a:115c:a1e0::/48'); the per-interface
# address itself is /128 host route on both, which would be useless
# as a peer-allow CIDR. Falls back to the host's /64 only when no
# scoped route is announced — better than nothing on bare deployments.
detect_mesh_v6_cidr() {
  local ifname route_prefix addr
  for ifname in wt0 tailscale0; do
    # Skip interfaces that don't exist.
    ip link show "$ifname" >/dev/null 2>&1 || continue

    # Prefer the route-announced prefix — the actual peer-reachable range.
    route_prefix=$(ip -6 route show dev "$ifname" scope global 2>/dev/null \
                     | awk 'NR==1 && $1 ~ /^[0-9a-fA-F:]+\/[0-9]+$/ {print $1; exit}')
    if [[ -n "$route_prefix" ]]; then
      echo "$route_prefix"
      return 0
    fi

    # Fallback: derive a /64 from the interface's first scope-global
    # address. May be wrong for wider meshes; operator can override.
    addr=$(ip -6 -o addr show "$ifname" scope global 2>/dev/null \
             | awk '/inet6/ {print $4; exit}')
    if [[ -n "$addr" ]]; then
      python3 -c "import ipaddress, sys
try:
    n = ipaddress.ip_interface(sys.argv[1])
    print(ipaddress.ip_network(f'{n.network.network_address}/64', strict=False))
except Exception:
    sys.exit(1)" "$addr" 2>/dev/null && return 0
    fi
  done
  return 1
}

# This node's primary IPv4 used to reach the public internet (default
# route's source). In set mode, this IP is what every other peer in the
# cluster needs to allow. Empty when no v4 default route — bare metal
# without IPv4 is unsupported.
detect_local_ipv4() {
  ip -4 route get 1.1.1.1 2>/dev/null \
    | awk '/src/ {for (i=1;i<=NF;i++) if ($i=="src") { print $(i+1); exit }}'
}

# This node's primary global IPv6, derived the same way as
# detect_local_ipv4. Empty when no v6 default route — that's fine,
# v6 control-plane simply isn't seeded.
detect_local_ipv6() {
  ip -6 route get 2001:4860:4860::8888 2>/dev/null \
    | awk '/src/ {for (i=1;i<=NF;i++) if ($i=="src") { print $(i+1); exit }}'
}

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
  # Pin --node-ip explicitly. k3s's auto-detect picks the first IP
  # it finds — that may be a NetBird/Tailscale/etc wt0 IP if such a
  # mesh is up at install time, which is wrong for the cluster
  # underlay if we want pod traffic to flow over public/private
  # network rather than nested in a third-party VPN.
  # Cluster CIDRs are IPv4-only — we don't expose IPv6 anywhere in
  # the platform, and dual-stack creates the v4-only/v6-only node
  # mismatch that fails worker join (k3s rejects --node-ip IPv4 with
  # dual-stack --cluster-cidr).
  local node_pin=""
  local cluster_cidr_arg="10.42.0.0/16"
  local service_cidr_arg="10.43.0.0/16"
  if [[ -n "$CLUSTER_NETWORK_CIDR" ]]; then
    # Private-underlay mode: pin to the host's IP inside the CIDR.
    local private_ip public_ip
    private_ip=$(resolve_cluster_network_ip)
    if [[ -z "$private_ip" ]]; then
      error "No host IP found inside --cluster-network-cidr ${CLUSTER_NETWORK_CIDR}. If using NetBird/Tailscale/etc, bring the overlay up first (or pass --netbird-management-url + --netbird-setup-key)."
    fi
    public_ip=$(hostname -I | awk '{print $1}')
    log "  private-network mode: --node-ip=${private_ip} --node-external-ip=${public_ip} --advertise-address=${private_ip}"
    node_pin="--node-ip=${private_ip} --node-external-ip=${public_ip} --advertise-address=${private_ip} --bind-address=0.0.0.0"
    tls_sans="${tls_sans} --tls-san=${private_ip}"
  else
    # Public-underlay mode: pin to the host's primary public IPv4.
    # detect_public_ipv4() filters out known VPN tunnel interfaces
    # (wt0, tailscale*, wg*, tun*, etc) so an operator's VPN doesn't
    # accidentally end up as the cluster underlay even if it carries
    # a route to public IPs.
    local public_ip
    public_ip=$(detect_public_ipv4)
    if [[ -z "$public_ip" ]]; then
      error "Could not detect a non-VPN public IPv4 address. Set --cluster-network-cidr <CIDR> to pin the underlay manually."
    fi
    log "  public-underlay mode: --node-ip=${public_ip}"
    node_pin="--node-ip=${public_ip} --advertise-address=${public_ip}"
    tls_sans="${tls_sans} --tls-san=${public_ip}"
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
      --kubelet-arg=image-gc-high-threshold=70 \
      --kubelet-arg=image-gc-low-threshold=60 \
      --kubelet-arg=minimum-image-ttl-duration=60m \
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
  # Pin --node-ip explicitly (see install_k3s_server for rationale).
  local exec_args=""
  if [[ -n "$CLUSTER_NETWORK_CIDR" ]]; then
    local private_ip public_ip
    private_ip=$(resolve_cluster_network_ip)
    if [[ -z "$private_ip" ]]; then
      error "No host IP found inside --cluster-network-cidr ${CLUSTER_NETWORK_CIDR}. If using NetBird/Tailscale/etc, bring the overlay up first (or pass --netbird-management-url + --netbird-setup-key)."
    fi
    public_ip=$(hostname -I | awk '{print $1}')
    log "  private-network mode: --node-ip=${private_ip} --node-external-ip=${public_ip}"
    exec_args="agent --node-ip=${private_ip} --node-external-ip=${public_ip}"
  else
    # Public-underlay mode (workers) — see detect_public_ipv4() comment.
    local public_ip
    public_ip=$(detect_public_ipv4)
    if [[ -z "$public_ip" ]]; then
      error "Could not detect a non-VPN public IPv4 address. Set --cluster-network-cidr <CIDR> to pin the underlay manually."
    fi
    log "  public-underlay mode: --node-ip=${public_ip}"
    exec_args="agent --node-ip=${public_ip}"
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

# detect_calico_mtu — pick the right Calico pod-network MTU.
#
# When the operator passes --calico-mtu N, that wins and we just
# echo N (validated upstream in parse_args / install_calico). When
# unset, we walk a priority list of mesh interfaces (wt0 = NetBird,
# tailscale0, wg0) and use the first one that's UP. Mesh-first
# matters because operators with both a mesh and a public NIC almost
# always intend pod traffic to traverse the mesh, and the mesh's
# MTU is the smaller of the two — pinning to public would fragment.
# If no mesh iface, fall back to the default-route iface (typically
# eth0).
#
# Subtracts 110 bytes for Calico's encapsulation overhead:
#   60 bytes — Calico-managed WireGuard (UDP/51821)
#   50 bytes — VXLAN (the IPPool encapsulation setting)
# Even when WireGuard is enabled and replaces VXLAN as the actual
# wire format for pod-to-pod traffic, Calico still installs a
# wireguard.cali interface whose MTU = pod-MTU − 60. Subtracting
# the full 110 leaves headroom for both encapsulation paths and
# any future kernel-overhead bumps.
#
# Floor: 1280 (IPv6 minimum). Ceiling: 8990 (jumbo-frame headroom).
# Echoes the chosen MTU to stdout; logs the derivation to stderr.
detect_calico_mtu() {
  if [[ -n "$CALICO_MTU" ]]; then
    echo "$CALICO_MTU"
    return 0
  fi

  local underlay_iface=""
  local underlay_mtu=""
  for iface in wt0 wt1 tailscale0 wg0; do
    if ip link show "$iface" up >/dev/null 2>&1; then
      underlay_iface=$iface
      break
    fi
  done

  if [[ -z "$underlay_iface" ]]; then
    underlay_iface=$(ip -4 route show default 2>/dev/null \
      | awk '/default/ {print $5; exit}')
  fi

  if [[ -z "$underlay_iface" ]]; then
    warn "Could not detect underlay interface — defaulting Calico MTU to 1380 (assumes 1500-byte Ethernet)"
    echo "1380"
    return 0
  fi

  underlay_mtu=$(cat "/sys/class/net/${underlay_iface}/mtu" 2>/dev/null || echo "")
  if [[ -z "$underlay_mtu" ]] || ! [[ "$underlay_mtu" =~ ^[0-9]+$ ]]; then
    warn "Could not read MTU on ${underlay_iface} — defaulting Calico MTU to 1380"
    echo "1380"
    return 0
  fi

  local mtu=$((underlay_mtu - 110))
  # Clamp to reasonable bounds. RFC 8200 sets the IPv6 minimum link
  # MTU at 1280; going below that breaks dual-stack pods. Ceiling
  # accommodates jumbo-frame underlays (typical 9000) − 110 = 8890.
  if (( mtu < 1280 )); then
    warn "Detected Calico MTU ${mtu} (underlay ${underlay_iface}=${underlay_mtu}) is below the IPv6 minimum 1280 — clamping. Pod traffic on this cluster may have issues; consider increasing the underlay MTU."
    mtu=1280
  fi
  if (( mtu > 8990 )); then
    mtu=8990
  fi

  log "Calico MTU auto-detect: underlay iface=${underlay_iface} mtu=${underlay_mtu} → calico mtu=${mtu}" >&2
  echo "$mtu"
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

  # Calico networking config (M14, 2026-04-26):
  #   * encapsulation: VXLAN — Calico's pod-network packet format. Stays
  #     even though we now ALSO encrypt with Calico-managed WireGuard;
  #     pod packets ride VXLAN (interoperable with all CNI tooling) inside
  #     the WireGuard tunnel between nodes.
  #   * wireguard.enabled: true — Calico encrypts ALL pod-to-pod traffic
  #     between nodes. Single uniform mechanism whether the underlay is
  #     a public network, a private cloud network, or an operator VPN.
  #     Prevents the double-encap MTU+reconcile bugs we hit running
  #     VXLAN-over-NetBird-WireGuard.
  #   * wireguard.port: 51821 — non-standard port to avoid collisions
  #     with NetBird (51820) on the same hosts.
  #   * bgp: Disabled — no BIRD process, one less failure surface.
  #   * mtu: detect_calico_mtu — picks the smallest of the local node's
  #     viable underlays (mesh-first via wt0/tailscale0/wg0, else
  #     default-route iface) and subtracts 110 for Calico's WG + VXLAN
  #     overhead. Operator can override via --calico-mtu N. Pinning
  #     here (instead of relying on Calico's auto-discovery) avoids
  #     the Felix MTU loop and surfaces the chosen value in `bootstrap`
  #     logs for post-mortem.
  #   * nodeAddressAutodetectionV4: when --cluster-network-cidr is set,
  #     pin to that CIDR explicitly. Otherwise inherit k3s' --node-ip
  #     choice via 'kubernetes: NodeInternalIP'. Calico's VXLAN/WG
  #     tunnel endpoint follows whichever IP k3s already advertised
  #     for the kubelet/apiserver — wt0 mesh IP if NetBird is up, else
  #     the default-route public IP. This matches per-node correctness
  #     in mixed clusters where some nodes joined publicly and others
  #     via the mesh.
  local autodetect_block=""
  # ipv6_pool: kept here as a documented placeholder for the future
  # dual-stack v2 mode (see ROADMAP.md). When enabled, this string
  # would carry the sibling IPv6 ipPool block. Until then the
  # IPv4-only path doesn't emit it.
  # shellcheck disable=SC2034
  local ipv6_pool=""
  if [[ -n "$CLUSTER_NETWORK_CIDR" ]]; then
    autodetect_block="    nodeAddressAutodetectionV4:
      cidrs:
      - ${CLUSTER_NETWORK_CIDR}"
    # IPv4-only underlay → drop the IPv6 ipPool. Mixed v4/v6 with
    # bgp:Disabled is rejected anyway, and k3s was launched with
    # IPv4-only cluster-cidr in install_k3s_server.
  else
    # Inherit k3s' --node-ip choice: Calico picks whatever IP
    # Node.status.addresses[InternalIP] already shows. install_k3s_*
    # auto-detects wt0 / tailscale0 and pins --node-ip to the mesh
    # IP when present, else to the default-route IP. By inheriting
    # via 'kubernetes: NodeInternalIP' we get the right behavior on
    # both public-only and mesh-private nodes without needing
    # separate code paths or per-node Installation overrides.
    #
    # Earlier (until 2026-05-09) we used 'skipInterface' to exclude
    # known VPN tunnel names. That worked for pure-public clusters
    # but actively broke mesh-private nodes — Calico would skip wt0
    # and pick the public NIC for its tunnel endpoint, even after
    # k3s --node-ip pinned the kubelet-side IP to the mesh address.
    # The result was Node.status.InternalIP = mesh, but Calico
    # tunnels (VXLAN/WG outer header) sourced from public NIC →
    # firewall on the receiving server dropped the packet because
    # cluster_peers_v4 contained the mesh IP, not the public one.
    autodetect_block="    nodeAddressAutodetectionV4:
      kubernetes: NodeInternalIP"
    # IPv6 dropped — see install_k3s_server: cluster-cidr is IPv4-only.
  fi

  # controlPlaneReplicas=1 — Tigera's default of 2 is tuned for clusters
  # with 100+ nodes. The project target audience (single hosting operator,
  # 50-100 clients, typically 3-10 cluster nodes) doesn't benefit from
  # 2 calico-apiserver + 2 calico-kube-controllers; on small clusters the
  # redundant pods are pure overhead (~5m CPU + ~95 MiB combined). Larger
  # deployments can override post-bootstrap with:
  #   kubectl patch installation default --type=merge -p \
  #     '{"spec":{"controlPlaneReplicas":2}}'
  # NOTE: typha replicas are NOT settable here — the Tigera operator's
  # built-in typha autoscaler computes replicas from node count and the
  # Installation CR's typhaDeployment.spec.replicas field is silently
  # dropped at admission. For small clusters where 2 typhas is excess,
  # there is no supported override.
  local calico_mtu
  calico_mtu=$(detect_calico_mtu)
  log "Calico Installation will use mtu=${calico_mtu}"

  cat <<EOF | kubectl apply -f -
apiVersion: operator.tigera.io/v1
kind: Installation
metadata:
  name: default
spec:
  controlPlaneReplicas: 1
  calicoNetwork:
    bgp: Disabled
    mtu: ${calico_mtu}
${autodetect_block}
    ipPools:
    - blockSize: 26
      cidr: 10.42.0.0/16
      encapsulation: VXLAN
      natOutgoing: Enabled
      nodeSelector: all()
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

  # 2026-04-25 issue: Felix sometimes does not install the cross-node
  # /26 routes via vxlan.calico after the initial Installation apply,
  # leaving cluster-internal Service traffic broken until the DaemonSet
  # is rolled. Empirically, a single rollout-restart of calico-node DS
  # forces Felix to converge on the autodetect cidrs setting and
  # populate the missing routes.
  # Only run it when --cluster-network-cidr is set (the case where
  # autodetect was reconfigured from the default first-found-iface).
  if [[ -n "$CLUSTER_NETWORK_CIDR" ]]; then
    log "Forcing calico-node convergence on autodetect cidrs..."
    kubectl rollout restart daemonset/calico-node -n calico-system 2>/dev/null || true
    kubectl rollout status daemonset/calico-node -n calico-system --timeout=180s 2>/dev/null \
      || warn "calico-node rollout did not converge in 180s — verify cross-node routes manually with 'ip route show dev vxlan.calico'"
  fi

  # Enable Calico WireGuard now that the FelixConfiguration CRD has
  # been registered by the Tigera operator. WireGuard is always-on,
  # regardless of underlay (public / cloud private net / operator VPN),
  # giving uniform pod-to-pod encryption + a single encap layer (vs
  # the brittle VXLAN-over-NetBird-WireGuard double-encap we had).
  # Port 51821 chosen to avoid NetBird's default 51820 — both can run
  # side-by-side on the same hosts.
  log "Enabling Calico WireGuard (port 51821)..."
  # Wait up to 60s for the FelixConfiguration CRD to be FULLY
  # registered — the CRD object existing isn't enough; kubectl's
  # API discovery has to refresh too. We probe with `api-resources`
  # which forces a fresh discovery.
  local _attempts=0
  while ! kubectl api-resources --api-group=projectcalico.org 2>/dev/null \
        | grep -q "^felixconfigurations"; do
    _attempts=$((_attempts+1))
    if [[ $_attempts -ge 30 ]]; then
      warn "FelixConfiguration CRD not API-registered within 60s — applying anyway."
      break
    fi
    sleep 2
  done
  # xdpEnabled / genericXDPEnabled are turned off because we do not use
  # Felix's XDP-based prefilter (we run iptables dataplane + VXLAN). When
  # an unrelated XDP program is already attached to lo (e.g. NetBird's
  # nb_xdp_prog in xdpgeneric mode), Felix otherwise enters a tight retry
  # loop trying to replace/wipe it — observed burning ~700-900m CPU per
  # node on the staging cluster (2026-04-27).
  #
  # Apply with retry: even after `api-resources` lists the CRD, the
  # apiserver's RESTMapper cache may stay stale for 30-60s, so a single
  # kubectl apply often fails with "no matches for kind FelixConfiguration".
  # Retry up to 5 minutes total before giving up. Caught fresh-install
  # on Ubuntu 24.04 testing host 2026-04-30.
  local _felix_yaml='apiVersion: projectcalico.org/v3
kind: FelixConfiguration
metadata:
  name: default
spec:
  wireguardEnabled: true
  wireguardListeningPort: 51821
  xdpEnabled: false
  genericXDPEnabled: false'
  local _apply_attempts=0
  while true; do
    if printf '%s\n' "$_felix_yaml" | kubectl apply -f - 2>/dev/null; then
      break
    fi
    _apply_attempts=$((_apply_attempts+1))
    if [[ $_apply_attempts -ge 60 ]]; then
      error "FelixConfiguration apply still failing after 5 minutes; bailing."
    fi
    sleep 5
  done

  marker_set "calico-installed"
  log "Calico CNI installed (WireGuard enabled, port 51821)."
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

install_traefik() {
  # Idempotency: check for the DaemonSet, not a Deployment or the chart.
  if kctl get daemonset -n traefik traefik &>/dev/null 2>&1; then
    log "Traefik already installed, skipping."
    return 0
  fi

  log "Installing Traefik v3 Ingress Controller..."
  helm_cmd repo add traefik https://traefik.github.io/charts 2>/dev/null || true
  helm_cmd repo update

  # DaemonSet + hostPort: one pod per eligible node binds directly on
  # host ports 80 and 443. hostPort without hostNetwork means Traefik's
  # entrypoints listen on container ports 8000/8443 and the kernel
  # DNAT rule maps those to host 80/443 — no root required (Traefik
  # runs as UID 65532 by default), and client source IPs are preserved
  # (DNAT changes destination only).
  #
  # HTTP→HTTPS redirect is handled at the EntryPoint level (permanent=true),
  # replacing the per-Ingress ssl-redirect annotation pattern. Per-route
  # overrides are still possible via a RedirectScheme Middleware.
  #
  # Providers: kubernetesCRD only (IngressRoute + Middleware + TLSOption CRDs).
  # kubernetesIngress is explicitly disabled so stale Ingress objects in the
  # cluster don't get silently processed.
  #
  # allowCrossNamespace lets IngressRoutes in tenant namespaces reference
  # shared Middleware CRs in the traefik/platform namespace (rate-limit
  # tiers, WAF config, ForwardAuth, etc.).
  #
  # allowExternalNameServices is required by the private-worker-tunnel
  # feature whose per-client routes point at ExternalName Services.
  #
  # nodeAffinity excludes nodes where the operator has opted them out of
  # ingress traffic (ingress-mode=none) or marked them private-only.
  helm_cmd upgrade --install traefik traefik/traefik \
    --namespace traefik \
    --create-namespace \
    --version "${TRAEFIK_CHART_VERSION}" \
    --set deployment.kind=DaemonSet \
    --set 'ports.web.hostPort=80' \
    --set 'ports.websecure.hostPort=443' \
    --set service.type=ClusterIP \
    --set providers.kubernetesCRD.enabled=true \
    --set providers.kubernetesCRD.allowCrossNamespace=true \
    --set providers.kubernetesCRD.allowExternalNameServices=true \
    --set providers.kubernetesIngress.enabled=false \
    --set "experimental.plugins.crowdsec.moduleName=${CROWDSEC_PLUGIN_MODULE}" \
    --set "experimental.plugins.crowdsec.version=${CROWDSEC_PLUGIN_VERSION}" \
    --set "experimental.plugins.modsecurity.moduleName=${MODSECURITY_PLUGIN_MODULE}" \
    --set "experimental.plugins.modsecurity.version=${MODSECURITY_PLUGIN_VERSION}" \
    ${CORAZA_PLUGIN_MODULE:+--set "experimental.plugins.coraza.moduleName=${CORAZA_PLUGIN_MODULE}"} \
    ${CORAZA_PLUGIN_VERSION:+--set "experimental.plugins.coraza.version=${CORAZA_PLUGIN_VERSION}"} \
    --set 'volumes[0].name=crowdsec-bouncer-key' \
    --set 'volumes[0].mountPath=/var/run/secrets/crowdsec' \
    --set 'volumes[0].type=secret' \
    # entryPoint.forwardedHeaders.trustedIPs — list of CIDRs Traefik
    # TRUSTS to set X-Forwarded-* on incoming connections. With our
    # DaemonSet+hostPort layout Traefik IS the perimeter (no LB in
    # front); external clients connect directly to the node's :80/:443
    # via DNAT and Traefik's connection-remote-addr reflects the real
    # client IP. We therefore set trustedIPs to 127.0.0.1/32 (loopback
    # only) to strip any attacker-supplied XFF before it reaches
    # ForwardAuth Middlewares — operators behind an external L4/L7
    # load balancer must add their LB CIDR in an overlay or the LB
    # would be misidentified as the source IP by CrowdSec.
    --set 'additionalArguments[0]=--entryPoints.web.forwardedHeaders.trustedIPs=127.0.0.1/32' \
    --set 'additionalArguments[1]=--entryPoints.websecure.forwardedHeaders.trustedIPs=127.0.0.1/32' \
    --set resources.requests.cpu=50m \
    --set resources.requests.memory=128Mi \
    --set resources.limits.memory=512Mi \
    --set 'affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].key=platform.phoenix-host.net/ingress-mode' \
    --set 'affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].operator=NotIn' \
    --set 'affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[0].values[0]=none' \
    --set 'affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[1].key=platform.phoenix-host.net/exposure' \
    --set 'affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[1].operator=NotIn' \
    --set 'affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms[0].matchExpressions[1].values[0]=private' \
    --wait \
    --timeout 300s

  log "Traefik v3 Ingress Controller installed."
}

# Generate / load the per-cluster CrowdSec bouncer key and ensure it
# exists as a K8s Secret in BOTH the crowdsec namespace (consumed by
# the CrowdSec Deployment via BOUNCER_KEY_traefik env) AND the traefik
# namespace (mounted into the Traefik pod at /var/run/secrets/crowdsec/
# for the bouncer plugin's crowdsecLapiKeyFile).
#
# Idempotent: if the Secret already exists in either namespace, the
# existing value is preserved. Re-running bootstrap doesn't rotate the
# key. Operators rotating the key should delete both Secrets and
# re-run; the CrowdSec Deployment will re-register the bouncer on
# next pod start.
generate_crowdsec_bouncer_key() {
  local secret_name="crowdsec-bouncer-key"
  local key_value
  # Reuse existing key from either namespace if present.
  if kctl get secret -n crowdsec "${secret_name}" >/dev/null 2>&1; then
    log "CrowdSec bouncer key already exists in crowdsec namespace, reusing."
    key_value=$(kctl get secret -n crowdsec "${secret_name}" -o jsonpath='{.data.bouncer-key}' | base64 -d)
  elif kctl get secret -n traefik "${secret_name}" >/dev/null 2>&1; then
    log "CrowdSec bouncer key found in traefik namespace, copying to crowdsec."
    key_value=$(kctl get secret -n traefik "${secret_name}" -o jsonpath='{.data.bouncer-key}' | base64 -d)
  else
    log "Generating new CrowdSec bouncer key..."
    # 32-byte URL-safe random — same shape CrowdSec's `cscli bouncers
    # add` uses internally. Operators can rotate by deleting both
    # secrets + re-running.
    key_value=$(head -c 32 /dev/urandom | base64 | tr -d '/+=' | head -c 40)
  fi

  # Materialise in both namespaces. Wait until each namespace exists
  # (crowdsec/ kustomization may not have applied yet).
  for ns in crowdsec traefik; do
    if ! kctl get ns "${ns}" >/dev/null 2>&1; then
      kctl create namespace "${ns}" >/dev/null
    fi
    # CRITICAL: key name is `bouncer-key` (not `traefik-bouncer-key`).
    # Traefik's chart mounts the Secret with no `items:` projection, so
    # files inside /var/run/secrets/crowdsec/ are named after the Secret
    # data key. The Middleware spec's crowdsecLapiKeyFile reads
    # `/var/run/secrets/crowdsec/bouncer-key` — they MUST match exactly,
    # otherwise the bouncer fails to load its key at startup and the
    # plugin fails open (silent CrowdSec bypass).
    kctl create secret generic "${secret_name}" \
      --namespace "${ns}" \
      --from-literal=bouncer-key="${key_value}" \
      --dry-run=client -o yaml | kctl apply -f -
  done
  log "CrowdSec bouncer key Secret applied to crowdsec + traefik namespaces."
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
          # Solver Pods are short-lived Jobs spawned by cert-manager.
          # On clusters where servers carry the platform-managed
          # platform.phoenix-host.net/server-only=true:NoSchedule taint
          # (single-server installs, or any cluster where workers don't
          # accept system Pods), the solver lacks the required
          # toleration and stays Pending — every Order hangs forever.
          # Caught on testing.phoenix-host.net 2026-05-01.
          podTemplate:
            spec:
              tolerations:
                - key: platform.phoenix-host.net/server-only
                  operator: Equal
                  value: "true"
                  effect: NoSchedule
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
          # Solver Pods are short-lived Jobs spawned by cert-manager.
          # On clusters where servers carry the platform-managed
          # platform.phoenix-host.net/server-only=true:NoSchedule taint
          # (single-server installs, or any cluster where workers don't
          # accept system Pods), the solver lacks the required
          # toleration and stays Pending — every Order hangs forever.
          # Caught on testing.phoenix-host.net 2026-05-01.
          podTemplate:
            spec:
              tolerations:
                - key: platform.phoenix-host.net/server-only
                  operator: Equal
                  value: "true"
                  effect: NoSchedule
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

  # longhornUI.replicaCount=1 — the dashboard is operator-facing only
  # and not on any client request path. The chart default is 2; on a
  # 4-node staging cluster the second replica is ~30 MiB + scheduling
  # overhead with no fault-tolerance benefit (no SLO on Longhorn UI
  # uptime). Production overlays can override if dashboard HA is
  # actually needed.
  #
  # guaranteedInstanceManagerCPU=8 (default 12) — each instance-manager
  # *reserves* this % of node CPU regardless of actual usage. At 12%,
  # a 4-CPU server reserves 480m per node (240m on a 2-CPU worker)
  # while real-world steady-state usage on small-tenant hosting is
  # 5-45m. Lowering to 8% reclaims ~480m of schedulable CPU across a
  # 3-server cluster while leaving 6-10× headroom over observed peaks.
  # Deployments with heavy IO (tenants doing high-IOPS DB workloads)
  # should override back to 12 via:
  #   kubectl -n longhorn-system patch setting/guaranteed-instance-manager-cpu \
  #     --type=merge -p '{"value":"12"}'
  #
  # concurrentReplicaRebuildPerNodeLimit=2 (default 5) — caps how many
  # replica rebuilds run in parallel per node. 5 is tuned for clusters
  # with 100+ volumes; for 3-4 server clusters with <50 volumes the
  # extra concurrency just produces CPU spikes during recovery without
  # meaningful rebuild-time benefit.
  # csi.kubeletRootDir: Longhorn's auto-discovery spawns a discover-
  # proc-kubelet-cmdline Pod that reads kubelet's /proc/<pid>/cmdline
  # to find --root-dir. On RHEL-family hosts (Rocky 10.1, Alma 9, RHEL
  # 9) SELinux blocks /proc cross-process reads from a Pod, the
  # discover Pod stays Pending, the driver-deployer aborts after 120s
  # with "didn't complete within 120 seconds", and CSI never deploys.
  # Skipping the auto-discovery by passing the path explicitly is safe
  # on every distro because k3s ALWAYS uses /var/lib/kubelet (see
  # install_k3s_server — no --kubelet-arg=root-dir override). Surfaced
  # on Rocky 10.1 fresh install 2026-05-01.
  helm_cmd upgrade --install longhorn longhorn/longhorn \
    --namespace longhorn-system \
    --create-namespace \
    --version "${LONGHORN_VERSION}" \
    --set csi.kubeletRootDir=/var/lib/kubelet \
    --set defaultSettings.defaultReplicaCount=1 \
    --set defaultSettings.replicaAutoBalance=best-effort \
    --set defaultSettings.storageMinimalAvailablePercentage=15 \
    --set defaultSettings.defaultDataLocality=best-effort \
    --set defaultSettings.guaranteedInstanceManagerCPU=8 \
    --set defaultSettings.concurrentReplicaRebuildPerNodeLimit=2 \
    --set longhornUI.replicaCount=1 \
    --set 'longhornManager.resources.requests.cpu=50m' \
    --set 'longhornManager.resources.requests.memory=128Mi' \
    --set 'longhornDriver.resources.requests.cpu=50m' \
    --set 'longhornDriver.resources.requests.memory=128Mi' \
    --set 'longhornUI.resources.requests.cpu=10m' \
    --set 'longhornUI.resources.requests.memory=64Mi' \
    --wait \
    --timeout 600s

  # Set Longhorn as the default StorageClass, demote local-path
  kctl patch storageclass local-path -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"false"}}}' 2>/dev/null || true
  kctl patch storageclass longhorn -p '{"metadata":{"annotations":{"storageclass.kubernetes.io/is-default-class":"true"}}}' 2>/dev/null || true

  # External CSI snapshotter — installs the snapshot.storage.k8s.io
  # CRDs (VolumeSnapshot, VolumeSnapshotContent, VolumeSnapshotClass)
  # and the snapshot-controller Deployment. Required by:
  #   - The platform-managed VolumeSnapshotClass `longhorn`
  #     (k8s/base/longhorn/csi-snapshots.yaml) that bridges Longhorn
  #     snapshots to Kubernetes snapshot CRs.
  #   - CNPG bootstrap.recovery.volumeSnapshots — the Postgres PITR
  #     auto-promote endpoint depends on this to wrap an existing
  #     Longhorn snapshot for CNPG to recover from.
  # Pinned to v6.3.0 (matches Longhorn v1.11.x compatibility matrix).
  log "Installing external-snapshotter CRDs + controller (CNPG PITR + VolumeSnapshotClass dep)…"
  local snap_ver="v6.3.0"
  local snap_base="https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/${snap_ver}"
  for f in \
    "client/config/crd/snapshot.storage.k8s.io_volumesnapshotclasses.yaml" \
    "client/config/crd/snapshot.storage.k8s.io_volumesnapshotcontents.yaml" \
    "client/config/crd/snapshot.storage.k8s.io_volumesnapshots.yaml" \
    "deploy/kubernetes/snapshot-controller/rbac-snapshot-controller.yaml" \
    "deploy/kubernetes/snapshot-controller/setup-snapshot-controller.yaml"; do
    kctl apply -f "${snap_base}/${f}" 2>&1 | grep -v "unchanged" || true
  done

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

  helm_cmd repo add cnpg https://cloudnative-pg.github.io/charts 2>/dev/null || true
  helm_cmd repo update

  # Detect the currently-installed chart version. helm list -o json
  # emits a single-line JSON array (no pretty-print); each element has
  # `name`, `chart` ("cloudnative-pg-<ver>"), and `status`. We capture
  # once (avoid TOCTOU between the existence check and the version
  # extraction) and only treat a `deployed` release as "already at
  # target" — a stuck `failed` / `pending-upgrade` release at the
  # right version still needs to be re-run to recover.
  #
  # WHY upgrade-aware: bumping CNPG_CHART_VERSION alone wasn't
  # picked up by re-running bootstrap; the previous skip-if-deployment
  # -exists short-circuit prevented the upgrade. A bump now triggers
  # a controlled operator roll (which in turn triggers a CNPG-managed
  # rolling switchover on existing Cluster CRs — by design).
  local helm_json
  helm_json=$(helm_cmd list -n cnpg-system -o json 2>/dev/null || echo "[]")
  local current_chart_ver=""
  local current_status=""
  if printf '%s' "$helm_json" | grep -q '"name":"cnpg"'; then
    current_chart_ver=$(printf '%s' "$helm_json" \
      | sed -n 's/.*"name":"cnpg".*"chart":"cloudnative-pg-\([^"]*\)".*/\1/p' \
      | head -n1)
    current_status=$(printf '%s' "$helm_json" \
      | sed -n 's/.*"name":"cnpg".*"status":"\([^"]*\)".*/\1/p' \
      | head -n1)
  fi

  if [[ -n "$current_chart_ver" \
        && "$current_chart_ver" == "$CNPG_CHART_VERSION" \
        && "$current_status" == "deployed" ]]; then
    log "CloudNative-PG operator already at chart ${CNPG_CHART_VERSION} (deployed), skipping."
    return 0
  fi

  if [[ -n "$current_chart_ver" ]]; then
    log "Upgrading CloudNative-PG operator: chart ${current_chart_ver} (${current_status:-unknown}) → ${CNPG_CHART_VERSION}."
    log "  Existing Cluster CRs will undergo a rolling switchover (operator-managed)."
  else
    log "Installing CloudNative-PG operator (passive — no Cluster CR applied)..."
  fi

  # maxConcurrentReconciles=3 (default 10): we never run more than
  # ~5 Cluster CRs (system-db + mail-db + future per-tenant); 3
  # workers is plenty and saves ~50 Mi resident in the operator pod.
  # See cnpg/cloudnative-pg chart values.yaml for full list.
  helm_cmd upgrade --install cnpg cnpg/cloudnative-pg \
    --namespace cnpg-system \
    --create-namespace \
    --version "${CNPG_CHART_VERSION}" \
    --set monitoring.podMonitorEnabled=false \
    --set maxConcurrentReconciles=3 \
    --wait \
    --timeout 600s

  log "CloudNative-PG operator at chart ${CNPG_CHART_VERSION}."
  log "  Activation runbook: docs/09-runbooks/CNPG_ACTIVATION_RUNBOOK.md"
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
  # 2026-05-09: dropped --components-extra=image-reflector-controller,
  # image-automation-controller. Replaced by the in-CI tag-pin step in
  # .github/workflows/build-deploy.yml which uses the workflow's
  # ephemeral GITHUB_TOKEN to commit newTag bumps directly. Saves
  # ~333 Mi RAM per cluster and removes the PAT-rotation failure mode
  # that took out staging image promotion 2026-05-04 → 2026-05-09.
  flux install --kubeconfig="$KUBECONFIG" --timeout=300s

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

  # Apply via YAML so we can include spec.patches: strip
  # spec.instances from the CNPG Cluster manifest before Flux SSA-
  # applies it. Otherwise Flux owns the field and reverts the
  # platform-storage-policy reconciler's imperative HA scale within
  # ~30s. CNPG operator defaults instances=1 when absent — the
  # right floor for fresh clusters. Apply HA flips to 3 imperatively.
  cat <<KUSTYAML | kctl apply -f -
apiVersion: kustomize.toolkit.fluxcd.io/v1
kind: Kustomization
metadata:
  name: platform
  namespace: flux-system
spec:
  interval: 1m
  path: ./k8s/overlays/${PLATFORM_ENV}
  prune: true
  sourceRef:
    kind: GitRepository
    name: ${source_name}
  # All overlays templatize the cluster apex as \${DOMAIN}; Flux
  # substitutes from the platform-cluster-config ConfigMap (created
  # earlier by generate_platform_secrets/runtime-config). Without
  # this, longhorn-ui / admin / stalwart Ingress renders with the
  # literal "longhorn.\${DOMAIN}" host and the whole Kustomization
  # blocks on dry-run. See feedback_no_code_reverts: this is the
  # piece bootstrap.sh was missing on testing.
  postBuild:
    substituteFrom:
      - kind: ConfigMap
        name: platform-cluster-config
        optional: false
  patches:
    - patch: |
        - op: remove
          path: /spec/instances
      target:
        group: postgresql.cnpg.io
        version: v1
        kind: Cluster
        name: postgres
KUSTYAML

  if [[ "$PLATFORM_ENV" == "staging" ]]; then
    warn "Image automation requires GitHub push credentials for the staging branch."
    warn "Create the flux-github-auth secret before enabling automation:"
    warn "  kubectl create secret generic flux-github-auth -n flux-system \\"
    warn "    --from-literal=username=x-access-token \\"
    warn "    --from-literal=password=<GITHUB_PAT>"
  fi

  log "Flux v2 installed and configured for ${PLATFORM_ENV} (branch=${flux_branch})."
}

# Tier-1 secrets-bundle import path. Runs BEFORE generate_platform_secrets
# on first install when the operator passes --secrets-bundle + --age-key.
# The bundle is age-encrypted; we decrypt + tar -x to /dev/shm, then
# kubectl apply each Secret manifest. generate_platform_secrets sees the
# pre-existing Secrets and skips re-generation.
#
# Inputs:
#   $SECRETS_BUNDLE_PATH — local path OR http(s) URL
#   $SECRETS_BUNDLE_KEY  — local path to operator-private.key
#
# No-op when SECRETS_BUNDLE_PATH is empty.
#
# Failure modes (each is fatal — better to halt than to half-import):
#   - bundle download fails (URL case)
#   - age binary missing
#   - age decrypt fails (wrong key, corrupt bundle)
#   - tar extraction fails
#   - any individual `kubectl apply` returns non-zero
import_secrets_bundle() {
  if [[ -z "$SECRETS_BUNDLE_PATH" ]]; then
    return 0
  fi
  if [[ -z "$SECRETS_BUNDLE_KEY" ]]; then
    error "--secrets-bundle requires --age-key (path to operator-private.key)"
  fi
  if ! command -v age >/dev/null 2>&1; then
    error "age binary not found — required for --secrets-bundle. Run install_packages."
  fi
  if [[ ! -r "$SECRETS_BUNDLE_KEY" ]]; then
    error "Cannot read --age-key file: $SECRETS_BUNDLE_KEY"
  fi

  log "Importing Tier-1 secrets bundle from: $SECRETS_BUNDLE_PATH"

  local bundle_local
  if [[ "$SECRETS_BUNDLE_PATH" =~ ^https?:// ]]; then
    bundle_local=$(mktemp --tmpdir=/dev/shm bundle.XXXXXX.tar.age 2>/dev/null \
      || mktemp -t bundle.XXXXXX.tar.age)
    if ! curl -sSf -L --max-time 120 -o "$bundle_local" "$SECRETS_BUNDLE_PATH"; then
      rm -f "$bundle_local"
      error "Failed to download secrets bundle from $SECRETS_BUNDLE_PATH"
    fi
  else
    if [[ ! -r "$SECRETS_BUNDLE_PATH" ]]; then
      error "Cannot read --secrets-bundle file: $SECRETS_BUNDLE_PATH"
    fi
    bundle_local="$SECRETS_BUNDLE_PATH"
  fi

  # Stage decrypted contents to /dev/shm so plaintext Secret YAML never
  # hits the root filesystem. Trap-based wipe on RETURN/EXIT.
  local stage
  stage=$(mktemp -d --tmpdir=/dev/shm bundle-import.XXXXXX 2>/dev/null \
    || mktemp -d)
  chmod 700 "$stage"
  _bundle_import_cleanup() {
    local s="${stage:-}"
    if [[ -n "$s" && -d "$s" ]]; then
      find "$s" -type f -exec sh -c ': > "$1"' _ {} \; 2>/dev/null || true
      rm -rf "$s"
      stage=""
    fi
    # Only wipe the curl-downloaded copy, NEVER an operator-supplied file.
    if [[ "$SECRETS_BUNDLE_PATH" =~ ^https?:// && -n "${bundle_local:-}" && -f "$bundle_local" ]]; then
      : > "$bundle_local"
      rm -f "$bundle_local"
    fi
  }
  trap _bundle_import_cleanup RETURN EXIT

  # Decrypt + extract in a single pipeline. Format is `tar | age` —
  # both the in-cluster export (modules/system-backup/secrets-bundle.ts)
  # and the on-host `bundle_bootstrap_secrets` produce the SAME bytes.
  if ! ( set -o pipefail; age -d -i "$SECRETS_BUNDLE_KEY" "$bundle_local" \
           | tar -C "$stage" -xf - ); then
    error "Bundle decrypt/extract failed. Wrong --age-key? Corrupt bundle?"
  fi

  # Sanity: the bundle must contain a MANIFEST.txt and at least one .yaml.
  if [[ ! -s "${stage}/MANIFEST.txt" ]]; then
    error "Bundle missing MANIFEST.txt — refusing to apply (provenance unknown)."
  fi
  log "Bundle MANIFEST.txt:"
  while IFS= read -r line; do log "  $line"; done < "${stage}/MANIFEST.txt"

  # Ensure the destination namespaces exist before kubectl apply.
  for ns in platform mail; do
    kctl create namespace "$ns" --dry-run=client -o yaml | kctl apply -f -
  done

  local applied=0
  for f in "$stage"/*.yaml; do
    [[ -f "$f" ]] || continue
    # Defence in depth: refuse to apply anything that isn't a Secret.
    # The bundle is age-encrypted so external tampering is mitigated,
    # but a future operator-key compromise must not let an attacker
    # smuggle ClusterRoleBindings or Deployments through this path.
    if ! grep -qE '^kind: Secret[[:space:]]*$' "$f"; then
      error "Refusing to apply non-Secret manifest from bundle: $f"
    fi
    if ! kctl apply -f "$f" >/dev/null; then
      error "Failed to apply secret manifest: $f"
    fi
    applied=$((applied+1))
  done

  log "Imported $applied secret(s) from bundle."

  # If the bundle includes operator-private.key, stash it under
  # /var/lib/hosting-platform/operator-key/ so generate_operator_recipient
  # picks it up for ConfigMap reconciliation. The age private key is
  # then under MARKER_DIR with chmod 0400 — same shape as fresh install.
  if [[ -f "${stage}/operator-private.key" ]]; then
    local key_dir="${MARKER_DIR}/operator-key"
    mkdir -p "$key_dir"
    chmod 700 "$key_dir"
    cp -p "${stage}/operator-private.key" "${key_dir}/operator-private.key"
    chmod 0400 "${key_dir}/operator-private.key"
    log "Restored operator-private.key from bundle to ${key_dir}/"
  fi
  if [[ -f "${stage}/operator-recipient.pub" ]]; then
    local key_dir="${MARKER_DIR}/operator-key"
    mkdir -p "$key_dir"
    cp -p "${stage}/operator-recipient.pub" "${key_dir}/operator-recipient.pub"
    chmod 0444 "${key_dir}/operator-recipient.pub"
  fi

  # Fire trap; explicit so the import path is auditable.
  _bundle_import_cleanup
  trap - RETURN EXIT
  marker_set "secrets-bundle-imported"
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

    # CNPG initdb requires username + password keys; backend reads url.
    # All three are populated here so the same Secret serves both the
    # CNPG Cluster bootstrap and the platform-api DATABASE_URL.
    kctl create secret generic platform-db-credentials \
      --namespace=platform \
      --from-literal=username="platform" \
      --from-literal=password="$db_password" \
      --from-literal=url="postgresql://platform:${db_password}@postgres.platform.svc.cluster.local:5432/hosting_platform"
    log "DB credentials secret created (username + password + url)."
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
      --from-literal=platform-encryption-key="$oidc_key" \
      --from-literal=internal-secret="$internal_secret"
    log "Platform secrets created."
  fi

  # OAuth2 Proxy config secret. Generation is split: the random secrets
  # (client_secret, cookie_secret) are computed ONCE on first creation
  # and preserved across re-runs to avoid invalidating active sessions /
  # the corresponding Dex client. The URL fields, by contrast, are
  # ALWAYS recomputed from the current PLATFORM_DOMAIN — earlier
  # versions of this code skipped the whole secret if it existed,
  # leaving stale env-prefixed hostnames in place when an operator
  # re-bootstrapped after a domain change. Caught on testing.phoenix-
  # host.net 2026-05-01 (oauth2-proxy crashlooped because the secret
  # still pointed at dex.staging.testing.phoenix-host.net).
  local oidc_client_secret="" cookie_secret=""
  if kctl get secret -n platform oauth2-proxy-config &>/dev/null 2>&1; then
    oidc_client_secret=$(kctl get secret -n platform oauth2-proxy-config -o jsonpath='{.data.OAUTH2_PROXY_CLIENT_SECRET}' 2>/dev/null | base64 -d 2>/dev/null || true)
    cookie_secret=$(kctl get secret -n platform oauth2-proxy-config -o jsonpath='{.data.OAUTH2_PROXY_COOKIE_SECRET}' 2>/dev/null | base64 -d 2>/dev/null || true)
  fi
  # Guard against an existing secret with missing / blank fields (older
  # bootstrap layout, partial apply, key rename). Empty values would
  # otherwise pass through as `--from-literal=KEY=` and oauth2-proxy
  # would boot with a blank client_secret — Dex would reject every
  # auth attempt with no obvious upstream error.
  if [[ -z "$oidc_client_secret" ]]; then
    oidc_client_secret="$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)"
    log "OAuth2 Proxy: minted fresh client_secret (no usable value in existing secret)."
  fi
  if [[ -z "$cookie_secret" ]]; then
    cookie_secret="$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)"
    log "OAuth2 Proxy: minted fresh cookie_secret (no usable value in existing secret)."
  fi

  # Hostnames are bare-apex across all environments (no env prefix).
  # See apply_platform_manifests for the matching design choice.
  local issuer_url redirect_url
  if [[ "$PLATFORM_ENV" == "dev" ]]; then
    issuer_url="http://dex.${PLATFORM_DOMAIN}/dex"
    redirect_url="http://admin.${PLATFORM_DOMAIN}/oauth2/callback"
  elif [[ "$PLATFORM_ENV" == "staging" ]]; then
    issuer_url="https://dex.${PLATFORM_DOMAIN}/dex"
    redirect_url="https://admin.${PLATFORM_DOMAIN}/oauth2/callback"
  else
    # Production: operator may configure an external OIDC issuer
    # (e.g. Auth0, Keycloak). Default to the in-cluster Dex if the
    # operator didn't pin one via OIDC_ISSUER_URL env.
    issuer_url="${OIDC_ISSUER_URL:-https://dex.${PLATFORM_DOMAIN}/dex}"
    redirect_url="https://admin.${PLATFORM_DOMAIN}/oauth2/callback"
  fi

  kctl create secret generic oauth2-proxy-config \
    --namespace=platform \
    --from-literal=OIDC_ISSUER_URL="$issuer_url" \
    --from-literal=OAUTH2_PROXY_CLIENT_ID="hosting-platform-oauth2-proxy" \
    --from-literal=OAUTH2_PROXY_CLIENT_SECRET="$oidc_client_secret" \
    --from-literal=OAUTH2_PROXY_COOKIE_SECRET="$cookie_secret" \
    --from-literal=OAUTH2_PROXY_REDIRECT_URL="$redirect_url" \
    --dry-run=client -o yaml | kctl apply -f -
  log "OAuth2 Proxy config secret applied (env=${PLATFORM_ENV}, issuer=${issuer_url})."

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

  # sftp-gateway also references platform-secrets (for PLATFORM_ENCRYPTION_KEY
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

  # Stalwart mail StatefulSet mounts a `stalwart-secrets` Secret with the
  # admin + master credentials. Without it, stalwart-mail-0 hangs in
  # CreateContainerConfigError. Historically this Secret was generated
  # at runtime by the backend's webmail-toggle action, but tenants on a
  # fresh cluster need the mail server pod to be UP before they can
  # toggle anything. Seed deterministic-but-random initial credentials
  # here; the operator can rotate via the admin panel later.
  kctl create namespace mail 2>/dev/null || true
  if kctl get secret -n mail stalwart-secrets &>/dev/null 2>&1; then
    log "stalwart-secrets already exists, skipping."
  else
    local stalwart_admin_pw stalwart_master_pw
    stalwart_admin_pw="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"
    stalwart_master_pw="$(openssl rand -base64 24 | tr -d '/+=' | head -c 32)"
    kctl create secret generic stalwart-secrets \
      --namespace=mail \
      --from-literal=ADMIN_USER=admin \
      --from-literal=ADMIN_PASSWORD="$stalwart_admin_pw" \
      --from-literal=MASTER_USER=master \
      --from-literal=MASTER_PASSWORD="$stalwart_master_pw"
    log "stalwart-secrets created (admin/master credentials)."
    # Persist alongside admin-credentials so the operator can recover
    # them without scraping the Secret.
    install -m 600 -d /etc/platform 2>/dev/null || true
    cat > /etc/platform/stalwart-credentials <<STALWART_EOF
# Generated by bootstrap.sh — do not commit. Chmod 600. Rotate via the
# admin panel before going to production.
STALWART_ADMIN_USER=admin
STALWART_ADMIN_PASSWORD=${stalwart_admin_pw}
# Stalwart 0.16 IMAP master-auth requires the FQDN form
# (verified empirically 2026-05-07: short `master` returns
# AUTHENTICATIONFAILED; `master@master.local` succeeds). The master
# Account is provisioned by provision_stalwart_master_user() in the
# `master.local` synthetic Domain.
STALWART_MASTER_USER=master@master.local
STALWART_MASTER_PASSWORD=${stalwart_master_pw}
STALWART_EOF
    chmod 600 /etc/platform/stalwart-credentials
    log "Stalwart credentials persisted to /etc/platform/stalwart-credentials."
  fi

  # Valkey/Sentinel coordinator cache (k8s/base/valkey/) — the
  # StatefulSet's setup-config init container reads REDIS_PASSWORD from
  # this Secret to render the password into the rendered valkey.conf
  # + sentinel.conf at pod startup. Without it valkey-0 hangs in
  # Init:CreateContainerConfigError.
  #
  # Apply HA tier flips replicas 1↔3 via the storage-policy reconciler
  # (no per-replica Secret needed — all pods reference the same Secret).
  # The password is also embedded in the Stalwart Coordinator URL
  # written by provision_stalwart_master_user() once Stalwart is up.
  kctl create namespace redis-system 2>/dev/null || true
  if kctl get secret -n redis-system valkey-auth &>/dev/null 2>&1; then
    log "valkey-auth already exists, skipping."
  else
    local valkey_password
    valkey_password="$(openssl rand -hex 32)"
    kctl create secret generic valkey-auth \
      --namespace=redis-system \
      --from-literal=REDIS_PASSWORD="$valkey_password"
    kctl -n redis-system label secret valkey-auth \
      app=valkey app.kubernetes.io/part-of=hosting-platform --overwrite >/dev/null
    install -m 700 -d /etc/platform 2>/dev/null || true
    {
      echo "# Generated by bootstrap.sh — do not commit. Chmod 600."
      echo "# Used by: Valkey StatefulSet init container + Stalwart"
      echo "# Coordinator URL. Rotate by running:"
      echo "#   kubectl -n redis-system delete secret valkey-auth"
      echo "#   ./scripts/migrate-valkey-bootstrap.sh"
      echo "VALKEY_PASSWORD=${valkey_password}"
    } > /etc/platform/valkey-credentials
    chmod 600 /etc/platform/valkey-credentials
    log "valkey-auth created. Password persisted to /etc/platform/valkey-credentials."
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

  # Phase 1 (RocksDB migration): mail-pg-app-credentials Secret removed.
  # Stalwart no longer uses CNPG PostgreSQL — the DataStore is RocksDB on
  # a local-path PVC (stalwart-rocksdb-data). No PG credentials needed.

  # Stalwart 0.16 admin credentials (stalwart-admin-creds).
  # Must exist BEFORE the stalwart-mail overlay is applied so that the
  # Deployment can inject STALWART_RECOVERY_ADMIN into the Stalwart process.
  # Format for recoveryAdmin: "admin:<password>" (Stalwart RECOVERY_ADMIN format).
  if kctl get secret -n mail stalwart-admin-creds &>/dev/null 2>&1; then
    log "stalwart-admin-creds already exists, skipping."
  else
    local stalwart_admin_pw
    # See entropy note on mail_pg_password above.
    stalwart_admin_pw="$(openssl rand -hex 32)"
    kctl create secret generic stalwart-admin-creds \
      --namespace=mail \
      --from-literal=adminPassword="$stalwart_admin_pw" \
      --from-literal=recoveryPassword="$stalwart_admin_pw" \
      --from-literal=recoveryAdmin="admin:${stalwart_admin_pw}"
    log "stalwart-admin-creds created."

    # Cross-namespace mirror — platform-api mounts this Secret at
    # /etc/stalwart-creds/ to read ADMIN_SECRET_PLAIN. Without it, the
    # rotation route 500s with "Stalwart admin password is not
    # configured". The rotation flow keeps this in sync via the
    # mirrorSecretName/mirrorNamespace options on rotate-jmap.ts.
    kctl create namespace platform 2>/dev/null || true
    if kctl get secret -n platform platform-stalwart-creds &>/dev/null 2>&1; then
      log "platform-stalwart-creds already exists, skipping mirror."
    else
      kctl create secret generic platform-stalwart-creds \
        --namespace=platform \
        --from-literal=adminPassword="$stalwart_admin_pw" \
        --from-literal=ADMIN_SECRET_PLAIN="$stalwart_admin_pw"
      log "platform-stalwart-creds (mirror) created in platform namespace."
    fi

    mkdir -p /etc/platform
    cat > /etc/platform/stalwart-mail-credentials <<STALWART016_EOF
# Generated by bootstrap.sh — do not commit. Chmod 600.
# Rotate via admin panel after first login.
STALWART_V016_ADMIN_PASSWORD=${stalwart_admin_pw}
STALWART016_EOF
    chmod 600 /etc/platform/stalwart-mail-credentials
    log "Stalwart v016 credentials persisted to /etc/platform/stalwart-mail-credentials."
  fi

  # Cut 3 (2026-05-04): Roundcube webmail secrets (roundcube-secrets).
  # Webmail is always deployed alongside Stalwart on staging+production,
  # so its operator-bootstrap state lives next to Stalwart's.
  #
  # 8 keys consumed by k8s/base/roundcube/deployment.yaml:
  #   JWT_AUTH_SECRET            — must equal platform-api WEBMAIL_JWT_SECRET
  #   STALWART_MASTER_USER       — Stalwart master-auth user (created later
  #                                via JMAP by cutover-stalwart script)
  #   STALWART_MASTER_PASSWORD   — Stalwart master-auth cleartext password
  #   ROUNDCUBEMAIL_DES_KEY      — symmetric key for cred-at-rest in PG
  #   ROUNDCUBEMAIL_DB_HOST/PORT/NAME/USER/PASSWORD — platform CNPG
  #
  # The PG `roundcube` database+role is created in create_roundcube_db()
  # below (separate fn so it can run after CNPG is up but before
  # Roundcube starts).
  if kctl get secret -n mail roundcube-secrets &>/dev/null 2>&1; then
    log "roundcube-secrets already exists, skipping."
  else
    local rc_jwt rc_des rc_master_pw rc_db_pw
    rc_jwt="$(openssl rand -hex 32)"
    rc_des="$(openssl rand -base64 24)"
    rc_master_pw="$(openssl rand -hex 32)"
    rc_db_pw="$(openssl rand -hex 32)"
    kctl create secret generic roundcube-secrets \
      --namespace=mail \
      --from-literal=JWT_AUTH_SECRET="$rc_jwt" \
      --from-literal=STALWART_MASTER_USER="master@master.local" \
      --from-literal=STALWART_MASTER_PASSWORD="$rc_master_pw" \
      --from-literal=ROUNDCUBEMAIL_DES_KEY="$rc_des" \
      --from-literal=ROUNDCUBEMAIL_DB_HOST="system-db-rw.platform.svc.cluster.local" \
      --from-literal=ROUNDCUBEMAIL_DB_PORT="5432" \
      --from-literal=ROUNDCUBEMAIL_DB_NAME="roundcube" \
      --from-literal=ROUNDCUBEMAIL_DB_USER="roundcube" \
      --from-literal=ROUNDCUBEMAIL_DB_PASSWORD="$rc_db_pw"
    log "roundcube-secrets created."

    # Mirror the JWT secret into platform-api's namespace so the
    # /api/v1/admin/mail/sso?to= flow signs tokens with the same
    # secret Roundcube validates. Without this mirror, SSO links
    # 401 immediately because the JWT is signed with the platform
    # API's main JWT_SECRET (different value, different purpose).
    if kctl get secret -n platform platform-webmail-jwt &>/dev/null 2>&1; then
      log "platform-webmail-jwt already exists, skipping mirror."
    else
      kctl create secret generic platform-webmail-jwt \
        --namespace=platform \
        --from-literal=WEBMAIL_JWT_SECRET="$rc_jwt"
      log "platform-webmail-jwt (mirror) created in platform namespace."
    fi

    cat > /etc/platform/roundcube-credentials <<RCEOF
# Generated by bootstrap.sh — do not commit. Chmod 600.
ROUNDCUBE_DB_PASSWORD=${rc_db_pw}
ROUNDCUBE_STALWART_MASTER_PASSWORD=${rc_master_pw}
RCEOF
    chmod 600 /etc/platform/roundcube-credentials
    log "Roundcube credentials persisted to /etc/platform/roundcube-credentials."
    log "NOTE: Roundcube PG database + role must be created via"
    log "      create_roundcube_db() (run after platform CNPG cluster is Ready)."
    log "      Stalwart master user must be provisioned via JMAP (run after"
    log "      Stalwart pod is Ready); see docs/02-operations/STALWART_DEPLOYMENT.md."
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
    `# Passkey/WebAuthn RP config — derived from --domain so a fresh` \
    `# install Just Works without anyone needing to run` \
    `# set-overlay-apex.sh on a separate overlay. RP_ID is the` \
    `# registrable suffix shared by admin + client panels (the apex);` \
    `# ORIGINS is the CSV of fully-qualified panel URLs. Per-overlay` \
    `# overrides remain possible via overlays/<env>/platform-config-patch.yaml.` \
    --from-literal=passkey-rp-id="${PLATFORM_DOMAIN:-localhost}" \
    --from-literal=passkey-rp-name="$platform_name_value" \
    --from-literal=passkey-origins="https://admin.${PLATFORM_DOMAIN:-localhost},https://client.${PLATFORM_DOMAIN:-localhost}" \
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
    # Capture age-keygen output directly from stdout — no tmpfile in
    # /dev/shm. Avoids the rm-then-recreate TOCTOU window where another
    # local process could win the race on a world-writable /dev/shm
    # (mode 1777). age-keygen writes both the private key and a
    # `# public key:` comment line to stdout when invoked without -o.
    local keygen_out=""
    if ! keygen_out="$(age-keygen 2>/dev/null)"; then
      error "age-keygen failed."
    fi
    recipient="$(printf '%s\n' "$keygen_out" | grep -E '^# public key:' | awk '{print $NF}')"
    local private_key=""
    private_key="$(printf '%s\n' "$keygen_out" | grep -v '^#')"
    keygen_out=""  # release intermediate copy
    if [[ -z "$recipient" || -z "$private_key" ]]; then
      private_key=""
      error "age-keygen produced empty key material — refusing to continue."
    fi

    # Persist the generated private key to a 0600 file — operator
    # retrieves it via `make secrets-fetch` (or scp directly) and is
    # responsible for deleting it from the host once stored offline.
    # NEVER printed to stdout/stderr/log to keep secrets out of
    # journald, terminal scrollback, CI logs, etc.
    local key_dir="${MARKER_DIR}/operator-key"
    mkdir -p "$key_dir"
    chmod 700 "$key_dir"
    local key_path="${key_dir}/operator-private.key"
    local recipient_path="${key_dir}/operator-recipient.pub"
    {
      echo "# created: $(date -u +%FT%TZ) (bootstrap-generated on $(hostname))"
      echo "# public key: ${recipient}"
      echo "${private_key}"
    } > "$key_path"
    chmod 600 "$key_path"
    printf '%s\n' "$recipient" > "$recipient_path"
    chmod 644 "$recipient_path"

    # Stash unset to avoid lingering in the bash variable space.
    private_key=""

    # File-only notification — values are NOT echoed.
    log "Operator age key generated."
    log "  private key:  ${key_path}        (mode 0600 — copy offline + delete)"
    log "  recipient:    ${recipient_path}  (mode 0644 — safe to share)"
    log "  See docs/04-deployment/SECRETS_LIFECYCLE.md for retrieval steps."
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

# Tier-1 bootstrap secrets bundle. Tars all platform-namespace
# Secrets that bootstrap created, age-encrypts to the operator
# recipient, and writes to /var/lib/hosting-platform/. This is the
# offline-recovery artifact the operator scp's after install.
#
# Idempotent: re-running creates a NEW timestamped bundle alongside
# any existing ones. Old bundles are left in place — the operator
# can prune after confirming offline storage.
#
# Outputs ONLY file paths to the log. Never echoes secret content.
bundle_bootstrap_secrets() {
  if ! command -v age >/dev/null 2>&1; then
    warn "age binary not found — skipping bootstrap secrets bundle. Run install_packages."
    return 0
  fi

  local recipient
  recipient=$(kctl get configmap -n platform platform-operator-recipient \
    -o jsonpath='{.data.recipient}' 2>/dev/null || true)
  if [[ -z "$recipient" ]]; then
    warn "platform-operator-recipient ConfigMap missing — skipping bootstrap secrets bundle."
    return 0
  fi

  local bundle_dir="${MARKER_DIR}/bundles"
  mkdir -p "$bundle_dir"
  chmod 700 "$bundle_dir"

  local stamp
  stamp=$(date -u +%Y%m%dT%H%M%SZ)
  local out="${bundle_dir}/bootstrap-secrets-${stamp}.tar.age"

  # Stage to /dev/shm so cleartext doesn't hit the root filesystem.
  # Trap-based cleanup ensures we wipe the staging dir even if a
  # later step calls error() (which exit 1's mid-function).
  #
  # The trap fires once on RETURN (function exits normally) and again
  # on EXIT (whole script exits). On EXIT, `$stage` (a function-local)
  # is out of scope, so under `set -u` the bare `$stage` reference
  # would print "stage: unbound variable". `${stage:-}` defaults to
  # empty in that case — the [[ -n ]] guard then short-circuits cleanly.
  # Hoist `stage` out of `local` so the trap (which runs in the parent
  # shell context on EXIT) can still see the value it was set to.
  _bundle_cleanup() {
    local s="${stage:-}"
    if [[ -n "$s" && -d "$s" ]]; then
      find "$s" -type f -exec sh -c ': > "$1"' _ {} \; 2>/dev/null || true
      rm -rf "$s"
      stage=""  # idempotent — second trap fire (EXIT after RETURN) no-ops
    fi
  }
  stage=""
  trap _bundle_cleanup RETURN EXIT
  stage=$(mktemp -d --tmpdir=/dev/shm bootstrap-bundle.XXXXXX 2>/dev/null \
    || mktemp -d)
  chmod 700 "$stage"

  # Bundled secret list. Each entry: <namespace> <name>. Append here
  # when bootstrap adds a new platform-level secret.
  local items=(
    "platform platform-admin-seed"
    "platform platform-db-credentials"
    "platform platform-jwt-secret"
    "platform platform-secrets"
    "platform oauth2-proxy-config"
    "platform sftp-host-keys"
    "platform stalwart-secrets"
    "mail stalwart-admin-creds"
  )

  local manifest="${stage}/MANIFEST.txt"
  {
    echo "bootstrap-secrets bundle"
    echo "cluster:    $(hostname)"
    echo "created:    $(date -u +%FT%TZ)"
    echo "kubectl-rev: $(kctl version --short 2>/dev/null | head -1 || true)"
    echo "recipient:  ${recipient}"
    echo ""
    echo "contents:"
  } > "$manifest"

  local item ns name out_file count=0
  for item in "${items[@]}"; do
    ns="${item% *}"
    name="${item#* }"
    out_file="${stage}/${ns}__${name}.yaml"
    if kctl get secret -n "$ns" "$name" -o yaml >"$out_file" 2>/dev/null; then
      echo "  ${ns}/${name}" >> "$manifest"
      count=$((count+1))
    fi
  done

  # Bundle the operator key files too if present (so a fresh bundle
  # rebuild after the operator already retrieved the on-host key
  # files still has them captured for the next retrieval cycle).
  local key_dir="${MARKER_DIR}/operator-key"
  if [[ -f "${key_dir}/operator-private.key" ]]; then
    cp -p "${key_dir}/operator-private.key" "${stage}/operator-private.key"
    echo "  operator-private.key" >> "$manifest"
    count=$((count+1))
  fi
  if [[ -f "${key_dir}/operator-recipient.pub" ]]; then
    cp -p "${key_dir}/operator-recipient.pub" "${stage}/operator-recipient.pub"
    echo "  operator-recipient.pub" >> "$manifest"
  fi

  if [[ $count -eq 0 ]]; then
    rm -rf "$stage"
    warn "No secrets to bundle — skipping."
    return 0
  fi

  # tar + age in a pipeline (no intermediate plaintext tar on disk).
  # Use bash's pipefail-set elsewhere isn't enabled in this script's
  # parent set -e; explicitly capture pipe status.
  if ! ( set -o pipefail; tar -C "$stage" -cf - . | age -r "$recipient" -o "$out" 2>/dev/null ); then
    error "Failed to create bootstrap secrets bundle at ${out}."
  fi
  chmod 600 "$out"
  # Trap _bundle_cleanup wipes $stage on RETURN/EXIT — no manual rm needed here.

  log "Bootstrap secrets bundle written:"
  log "  ${out}  (${count} item(s), age-encrypted to operator recipient)"
  log "  Retrieve via: make secrets-fetch HOST=root@<this-server>"
  log "  See docs/04-deployment/SECRETS_LIFECYCLE.md"
}

# Block until every admission webhook used by the platform overlay has
# at least one Ready endpoint. Each entry is "<namespace>:<service>".
# When Helm's --wait returns the Deployment is "available" (1/1 desired)
# but the corresponding Endpoints object can lag the readiness probe by
# 30-120s on a freshly-bootstrapped cluster; until that window closes,
# any kubectl apply that triggers the webhook fails with "no endpoints
# available for service <name>" — exactly the Longhorn race that aborts
# the bootstrap on every fresh install.
wait_for_admission_webhooks() {
  local pairs=(
    "longhorn-system:longhorn-admission-webhook"
    "cnpg-system:cnpg-webhook-service"
  )
  local pair ns svc attempts
  for pair in "${pairs[@]}"; do
    ns="${pair%%:*}"
    svc="${pair##*:}"
    if ! kctl get svc -n "$ns" "$svc" &>/dev/null; then
      # Service not declared on this cluster (e.g. --skip-longhorn or
      # a future install path that doesn't ship CNPG) — silently skip.
      continue
    fi
    log "  waiting for ${ns}/${svc} to have ready endpoints..."
    attempts=0
    while true; do
      if kctl get endpoints -n "$ns" "$svc" \
            -o jsonpath='{.subsets[0].addresses[0].ip}' 2>/dev/null \
            | grep -q '[0-9]'; then
        log "  ${ns}/${svc} is ready."
        break
      fi
      attempts=$((attempts + 1))
      if (( attempts >= 60 )); then
        # 60 × 5s = 5 min — long enough for any fresh-install boot
        # delay on Longhorn / CNPG, short enough to fail loudly if
        # something genuinely went wrong with the webhook deployment.
        error "  ${ns}/${svc} still has no endpoints after 5 min — webhook never became ready, bailing."
      fi
      sleep 5
    done
  done
}

# ─── Roundcube webmail PG database+role provisioning ────────────────────────
#
# Cut 3 (2026-05-04): create the `roundcube` database + role on the platform
# CNPG cluster. Idempotent — uses DO blocks that skip if the role/db exist.
# Roundcube reads its DB credentials from the `roundcube-secrets` Secret
# (created by generate_platform_secrets). This function reads the same
# password and runs ALTER ROLE so re-runs converge.
#
# Skipped when:
#   - roundcube-secrets does not exist (mail stack not deployed)
#   - platform postgres Cluster is not Ready within 300s
create_roundcube_db() {
  log ""
  log "── Roundcube DB provisioning ──"

  if ! kctl get secret -n mail roundcube-secrets &>/dev/null 2>&1; then
    log "  roundcube-secrets not found — skipping (mail stack not deployed)."
    return 0
  fi

  log "  Waiting for platform postgres Cluster (up to 300s)..."
  if ! kctl wait --for=condition=Ready cluster/postgres -n platform --timeout=300s 2>/dev/null; then
    warn "  platform postgres Cluster not Ready after 300s — skipping."
    return 0
  fi

  local rc_db_pw
  rc_db_pw=$(kctl get secret -n mail roundcube-secrets \
    -o jsonpath='{.data.ROUNDCUBEMAIL_DB_PASSWORD}' 2>/dev/null | base64 -d || echo "")
  if [[ -z "$rc_db_pw" ]]; then
    warn "  ROUNDCUBEMAIL_DB_PASSWORD missing from roundcube-secrets — skipping."
    return 0
  fi

  local pg_pod
  pg_pod=$(kctl get pod -n platform -l cnpg.io/cluster=postgres,role=primary \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  if [[ -z "$pg_pod" ]]; then
    warn "  No platform postgres primary pod found — skipping."
    return 0
  fi

  # Idempotent provision: CREATE ROLE only if absent, ALTER ROLE for password
  # convergence, CREATE DATABASE only if absent, GRANT regardless. Wrapped in
  # a DO block so a partial-state cluster doesn't error on any single line.
  log "  Provisioning roundcube role + database via primary pod $pg_pod..."
  local sql
  sql=$(cat <<RCSQL
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'roundcube') THEN
    CREATE ROLE roundcube LOGIN PASSWORD '${rc_db_pw}';
  ELSE
    ALTER ROLE roundcube WITH LOGIN PASSWORD '${rc_db_pw}';
  END IF;
END
\$\$;
SELECT 'CREATE DATABASE roundcube OWNER roundcube'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'roundcube')\\gexec
GRANT ALL PRIVILEGES ON DATABASE roundcube TO roundcube;
RCSQL
)
  # NOTE: psql heredoc passed via stdin rather than -c so the \\gexec
  # meta-command works (it runs the SELECT result as a new SQL command).
  if echo "$sql" | kctl exec -i -n platform "$pg_pod" -- psql -U postgres -d postgres >/dev/null 2>&1; then
    log "  roundcube DB provisioned (role + database)."
  else
    warn "  roundcube DB provisioning failed — re-run after fixing platform postgres state."
  fi
}

# ─── Stalwart master-user (impersonation) provisioning ──────────────────────
#
# Cut 3 (2026-05-04): Stalwart 0.16 master-auth is implemented as an Account
# with the built-in `Admin` role (which includes the `impersonate` permission).
# Roundcube's jwt_auth plugin uses the IMAP `<target>%<master>` syntax with
# the master account's password to authenticate as any mailbox.
#
# Sequence (each step idempotent):
#   1. Ensure a `master.local` Domain exists (synthetic, never sends/receives
#      mail — only hosts the master Account).
#   2. Ensure an Account `master@master.local` exists.
#   3. Set credentials = STALWART_MASTER_PASSWORD from roundcube-secrets.
#   4. Assign roles = {@type: Admin} (built-in role, includes impersonate).
#
# Source: Stalwart 0.16 UPGRADING guide + Authorization/Roles docs.
# https://stalw.art/docs/auth/authorization/administrator/
#
# Skipped when:
#   - roundcube-secrets does not exist (mail stack not deployed)
#   - stalwart-mail Deployment is not Ready
provision_stalwart_master_user() {
  log ""
  log "── Stalwart master user (Roundcube SSO impersonator) ──"

  if ! kctl get secret -n mail roundcube-secrets &>/dev/null 2>&1; then
    log "  roundcube-secrets not found — skipping (mail/webmail not deployed)."
    return 0
  fi
  if ! kctl get deployment -n mail stalwart-mail &>/dev/null 2>&1; then
    log "  stalwart-mail Deployment not found — skipping."
    return 0
  fi

  local recovery_pw master_pw
  recovery_pw=$(kctl get secret -n mail stalwart-admin-creds \
    -o jsonpath='{.data.recoveryPassword}' 2>/dev/null | base64 -d || echo "")
  master_pw=$(kctl get secret -n mail roundcube-secrets \
    -o jsonpath='{.data.STALWART_MASTER_PASSWORD}' 2>/dev/null | base64 -d || echo "")
  if [[ -z "$recovery_pw" || -z "$master_pw" ]]; then
    warn "  recovery or master password missing from Secrets — skipping."
    return 0
  fi

  # Provision via direct JMAP calls (no stalwart-cli download required).
  # Idempotent: queries existing domain/account by name and creates only
  # if missing; credentials + role are always updated so rotations converge.
  local job_name="stalwart-master-provision-$(date +%s)"
  local params_secret="stalwart-master-params-$(date +%s)"
  kctl delete pod -n mail "$job_name" --ignore-not-found --wait=true >/dev/null 2>&1 || true

  # Write MASTER_PW to a Secret so it never appears in pod spec env.
  kctl create secret generic "${params_secret}" \
    --namespace=mail \
    --from-literal=MASTER_PW="${master_pw}" \
    --dry-run=client -o yaml | kctl apply -n mail -f - >/dev/null

  cat <<EOF | kctl apply -n mail -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: ${job_name}
  labels:
    app.kubernetes.io/component: stalwart-master-provision
spec:
  restartPolicy: Never
  containers:
  - name: provision
    image: alpine:3.20
    envFrom:
      - secretRef:
          name: stalwart-admin-creds
      - secretRef:
          name: ${params_secret}
    command: ["sh","-c"]
    args:
    - |
      set -e
      apk add -q --no-cache curl jq >/dev/null

      MGMT="http://stalwart-mgmt.mail.svc.cluster.local:8080"
      AUTH="admin:\${recoveryPassword}"
      MASTER_DESC='Hosting Platform master user — DO NOT DELETE. Used by webmail SSO + IMAP/SMTP master-auth proxy. Removing this account breaks Roundcube auto-login and tenant mailbox proxying.'

      SESSION=\$(curl -sf -u "\${AUTH}" --max-time 10 "\${MGMT}/jmap/session") || {
        echo "ERROR: cannot reach \${MGMT}/jmap/session" >&2; exit 1
      }
      ACCT=\$(echo "\${SESSION}" | jq -r \
        '(.primaryAccounts // {}) | to_entries[] | select(.key == "urn:stalwart:jmap") | .value // "d333333"')

      jmap_call() {
        curl -sf -u "\${AUTH}" -X POST "\${MGMT}/jmap/" \
          -H 'Content-Type: application/json' --max-time 30 -d "\$1"
      }

      # Step 1: ensure master.local Domain exists
      DOM_RESP=\$(jmap_call "\$(jq -n --arg a "\$ACCT" \
        '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
          methodCalls:[["x:Domain/get",{accountId:\$a,ids:null},"c0"]]}')")
      DOMAIN_ID=\$(echo "\$DOM_RESP" | jq -r \
        '.methodResponses[0][1].list[] | select(.name == "master.local") | .id' | head -1)
      if [ -z "\$DOMAIN_ID" ]; then
        CREATE_DOM=\$(jmap_call "\$(jq -n --arg a "\$ACCT" \
          '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
            methodCalls:[["x:Domain/set",
              {accountId:\$a,create:{"ml":{"name":"master.local"}}},
              "c0"]]}')")
        DOMAIN_ID=\$(echo "\$CREATE_DOM" | jq -r \
          '.methodResponses[0][1].created["ml"].id // empty' | head -1)
      fi
      [ -n "\$DOMAIN_ID" ] || { echo "ERROR: no master.local domain id" >&2; exit 1; }
      echo "domain id=\${DOMAIN_ID}"

      # Step 2: ensure master@master.local Account exists
      ACCT_RESP=\$(jmap_call "\$(jq -n --arg a "\$ACCT" \
        '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
          methodCalls:[["x:Account/get",{accountId:\$a,ids:null},"c0"]]}')")
      ACCOUNT_ID=\$(echo "\$ACCT_RESP" | jq -r \
        '.methodResponses[0][1].list[] | select(.name == "master") | .id' | head -1)
      if [ -z "\$ACCOUNT_ID" ]; then
        CREATE_ACCT=\$(jmap_call "\$(jq -n --arg a "\$ACCT" --arg d "\$DOMAIN_ID" --arg desc "\$MASTER_DESC" \
          '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
            methodCalls:[["x:Account/set",
              {accountId:\$a,create:{"ma":{"@type":"User","name":"master","domainId":\$d,"description":\$desc}}},
              "c0"]]}')")
        ACCOUNT_ID=\$(echo "\$CREATE_ACCT" | jq -r \
          '.methodResponses[0][1].created["ma"].id // empty' | head -1)
      fi
      [ -n "\$ACCOUNT_ID" ] || { echo "ERROR: no master account id" >&2; exit 1; }
      echo "account id=\${ACCOUNT_ID}"

      # Step 3: credentials + role + description (always update — idempotent)
      jmap_call "\$(jq -n --arg a "\$ACCT" --arg id "\$ACCOUNT_ID" \
          --arg p "\${MASTER_PW}" --arg desc "\$MASTER_DESC" \
        '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
          methodCalls:[["x:Account/set",
            {accountId:\$a,update:{
              (\$id): {
                "credentials":{"0":{"@type":"Password","secret":\$p}},
                "roles":{"@type":"Admin"},
                "description":\$desc
              }
            }},
            "c0"]]}')" | jq -r '.methodResponses[0] | "\(.[0]): \(.[1] | keys[0])"'

      echo "provision-ok account=\${ACCOUNT_ID}"
EOF

  # Wait for the pod to complete.
  for _i in $(seq 1 90); do
    local ph
    ph=$(kctl get pod -n mail "$job_name" -o jsonpath='{.status.phase}' 2>/dev/null || echo "")
    if [[ "$ph" == "Succeeded" || "$ph" == "Failed" ]]; then break; fi
    sleep 2
  done

  if [[ "$(kctl get pod -n mail "$job_name" -o jsonpath='{.status.phase}' 2>/dev/null)" == "Succeeded" ]]; then
    log "  Master user provisioned (Roundcube SSO ready)."
  else
    warn "  Master-user provision Pod did not complete cleanly. Logs:"
    kctl logs -n mail "$job_name" 2>&1 | tail -20 | sed 's/^/    /' || true
  fi
  kctl delete pod    -n mail "$job_name"       --ignore-not-found >/dev/null 2>&1 || true
  kctl delete secret -n mail "${params_secret}" --ignore-not-found >/dev/null 2>&1 || true
}

# ─── Stalwart 0.16 first-install bootstrap ───────────────────────────────────
#
# Called from main() AFTER apply_platform_manifests so the stalwart-mail
# manifests (Deployment, CNPG Cluster, Job) have been applied by Flux/kubectl
# before we wait for them.
#
# Idempotency:
#   - If stalwart-admin-creds Secret already exists AND Stalwart is in full
#     mode (/jmap/session returns 200), the step is skipped.
#   - If the Secret exists but Stalwart is in bootstrap mode (DB empty or
#     Job failed), the rendered plan is re-applied and the Deployment rolled.
#
# The stalwart-mail overlay MUST be applied (either via the env overlay that
# includes it, or via a separate `kubectl apply -k`) before calling this
# function. For env=production this happens in apply_platform_manifests;
# for local dev use `./scripts/local.sh mail16-up` instead.
# configure_stalwart_full — post-bootstrap JMAP configuration.
#
# Called by bootstrap_stalwart_v016() after the bootstrap Job + Deployment
# restart (or on re-runs when Stalwart is already past bootstrap mode).
# Applies all remaining configuration via direct JMAP calls — no
# stalwart-cli required. Fully idempotent: queries existing objects first
# and skips creates for already-present entries.
#
# Handles: SystemSettings (defaultHostname + actual RocksDB domain ID),
#   Jmap upload limits, DkimSignature, AcmeProvider, AllowedIp,
#   NetworkListeners (http-acme/80, submission/587, imap/143),
#   admin credentials (permanent adminPassword replaces recovery password).
#
# RocksDB domain ID note: unlike PostgreSQL (where IDs were slug strings
# like "example-com"), RocksDB assigns short hashes (e.g., "b"). The
# domain ID can only be discovered post-bootstrap via x:Domain/get — it
# cannot be inferred from the domain name at plan-render time.
configure_stalwart_full() {
  local stalwart_hostname="$1"
  local stalwart_domain="$2"

  log "  Configuring Stalwart via JMAP (SystemSettings, Jmap, DKIM, listeners, admin creds)..."

  local admin_pw
  admin_pw=$(kctl get secret -n mail stalwart-admin-creds \
    -o jsonpath='{.data.adminPassword}' 2>/dev/null | base64 -d || echo "")
  if [[ -z "$admin_pw" ]]; then
    warn "  adminPassword missing from stalwart-admin-creds — re-run generate_platform_secrets"
    return 1
  fi

  # Get or generate Ed25519 DKIM private key. Persisted in stalwart-admin-creds
  # so re-runs don't regenerate (which would invalidate the published DNS TXT).
  local dkim_pem
  dkim_pem=$(kctl get secret -n mail stalwart-admin-creds \
    -o jsonpath='{.data.dkimPrivateKeyPem}' 2>/dev/null | base64 -d || echo "")
  if [[ -z "$dkim_pem" ]]; then
    log "  Generating Ed25519 DKIM key (first run)..."
    dkim_pem=$(openssl genpkey -algorithm ed25519 2>/dev/null)
    local dkim_b64
    dkim_b64=$(printf '%s' "$dkim_pem" | base64 | tr -d '\n')
    kctl patch secret stalwart-admin-creds -n mail --type=json \
      -p "[{\"op\":\"add\",\"path\":\"/data/dkimPrivateKeyPem\",\"value\":\"${dkim_b64}\"}]" \
      2>/dev/null || true
  fi

  # Unique suffix for ephemeral pod + Secret names.
  local suffix
  suffix="${BASHPID:-$$}-$(date +%s)"
  local params_secret="stalwart-cfg-${suffix}"
  local pod_name="stalwart-configure-${suffix}"

  # Write configure-params Secret. adminPassword and recoveryPassword come
  # from stalwart-admin-creds via a second envFrom secretRef in the pod.
  kctl create secret generic "${params_secret}" \
    --namespace=mail \
    --from-literal=STALWART_HOSTNAME="${stalwart_hostname}" \
    --from-literal=STALWART_DOMAIN="${stalwart_domain}" \
    --from-literal=STALWART_DKIM_PEM="${dkim_pem}" \
    --dry-run=client -o yaml | kctl apply -f - >/dev/null

  log "  Spawning configure pod ${pod_name}..."
  cat <<POD_YAML | kctl apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata:
  name: ${pod_name}
  namespace: mail
  labels:
    app.kubernetes.io/component: stalwart-configure
spec:
  restartPolicy: Never
  containers:
    - name: configure
      image: alpine:3.20
      envFrom:
        - secretRef:
            name: stalwart-admin-creds
        - secretRef:
            name: ${params_secret}
      command: ["sh", "-c"]
      args:
        - |
          set -eu
          apk add -q --no-cache curl jq

          MGMT="http://stalwart-mgmt.mail.svc.cluster.local:8080"
          AUTH="admin:\${recoveryPassword}"

          SESSION=\$(curl -sf -u "\${AUTH}" --max-time 10 "\${MGMT}/jmap/session") || {
            echo "ERROR: cannot reach \${MGMT}/jmap/session" >&2; exit 1
          }
          ACCT=\$(echo "\${SESSION}" | jq -r \
            '(.primaryAccounts // {}) | to_entries[] | select(.key == "urn:stalwart:jmap") | .value // "d333333"')
          echo "accountId=\${ACCT}"

          jmap_call() {
            curl -sf -u "\${AUTH}" -X POST "\${MGMT}/jmap/" \
              -H 'Content-Type: application/json' --max-time 30 -d "\$1"
          }

          # 1. Resolve RocksDB domain hash ID (cannot be inferred from name).
          # If the domain is absent (Stalwart auto-seeded without x:Bootstrap/set
          # after a DB wipe), create it first — x:Domain/set works in full mode.
          DOM_RESP=\$(jmap_call "\$(jq -n --arg a "\$ACCT" \
            '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
              methodCalls:[["x:Domain/get",{accountId:\$a,ids:null},"c0"]]}')")
          DOMAIN_ID=\$(echo "\$DOM_RESP" | jq -r --arg d "\${STALWART_DOMAIN}" \
            '.methodResponses[0][1].list[] | select(.name == \$d) | .id' 2>/dev/null | head -1)
          if [ -z "\$DOMAIN_ID" ]; then
            echo "Domain \${STALWART_DOMAIN} not found — creating via x:Domain/set..."
            CREATE_KEY=\$(echo "\${STALWART_DOMAIN}" | tr '.' '-')
            jmap_call "\$(jq -n --arg a "\$ACCT" --arg d "\${STALWART_DOMAIN}" --arg k "\${CREATE_KEY}" \
              '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
                methodCalls:[["x:Domain/set",{accountId:\$a,create:{(\$k):{name:\$d}}},"c0"]]}')" | \
              jq -r '.methodResponses[0] | "\(.[0]): \(.[1] | keys[0])"'
            DOM_RESP=\$(jmap_call "\$(jq -n --arg a "\$ACCT" \
              '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
                methodCalls:[["x:Domain/get",{accountId:\$a,ids:null},"c0"]]}')")
            DOMAIN_ID=\$(echo "\$DOM_RESP" | jq -r --arg d "\${STALWART_DOMAIN}" \
              '.methodResponses[0][1].list[] | select(.name == \$d) | .id' 2>/dev/null | head -1)
            [ -n "\$DOMAIN_ID" ] || {
              echo "ERROR: domain create failed — \${DOM_RESP}" >&2; exit 1
            }
          fi
          echo "domain id=\${DOMAIN_ID}"

          # 2. SystemSettings — always update (idempotent)
          jmap_call "\$(jq -n --arg a "\$ACCT" --arg h "\${STALWART_HOSTNAME}" --arg d "\$DOMAIN_ID" \
            '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
              methodCalls:[["x:SystemSettings/set",
                {accountId:\$a,update:{singleton:{defaultHostname:\$h,defaultDomainId:\$d}}},
                "c0"]]}')" | jq -r '.methodResponses[0] | "\(.[0]): \(.[1] | keys[0])"'
          echo "SystemSettings OK"

          # 3. Jmap limits — always update (idempotent)
          jmap_call "\$(jq -n --arg a "\$ACCT" \
            '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
              methodCalls:[["x:Jmap/set",
                {accountId:\$a,update:{singleton:{
                  maxUploadCount:1000000,
                  uploadQuota:10737418240,
                  maxUploadSize:104857600,
                  maxConcurrentUploads:128,
                  maxConcurrentRequests:128,
                  maxMethodCalls:256
                }}},
                "c0"]]}')" | jq -r '.methodResponses[0] | "\(.[0]): \(.[1] | keys[0])"'
          echo "Jmap limits OK"

          # 4. DkimSignature — create if missing
          EXISTING_DKIM=\$(jmap_call "\$(jq -n --arg a "\$ACCT" \
            '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
              methodCalls:[["x:DkimSignature/get",{accountId:\$a,ids:null},"c0"]]}')" | \
            jq -r '.methodResponses[0][1].list[].id // empty' 2>/dev/null | tr '\n' ',')
          if echo ",\${EXISTING_DKIM}," | grep -q ',dkim-default,'; then
            echo "DkimSignature dkim-default already exists — skipping"
          else
            jmap_call "\$(jq -n --arg a "\$ACCT" --arg d "\$DOMAIN_ID" --arg k "\${STALWART_DKIM_PEM}" \
              '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
                methodCalls:[["x:DkimSignature/set",
                  {accountId:\$a,create:{"dkim-default":{
                    "@type":"Dkim1Ed25519Sha256",
                    domainId:\$d,selector:"default",
                    canonicalization:"relaxed/relaxed",
                    headers:{"From":true,"To":true,"Date":true,"Subject":true,"Message-ID":true},
                    privateKey:{"@type":"Text",secret:\$k},
                    report:false,stage:"active",
                    thirdParty:null,thirdPartyHash:null,auid:null,expire:null,
                    memberTenantId:null,nextTransitionAt:null
                  }}},
                  "c0"]]}')" | jq -r '.methodResponses[0] | "\(.[0]): \(.[1] | keys[0])"'
            echo "DkimSignature created"
          fi

          # 5. AcmeProvider — create if missing
          EXISTING_ACME=\$(jmap_call "\$(jq -n --arg a "\$ACCT" \
            '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
              methodCalls:[["x:AcmeProvider/get",{accountId:\$a,ids:null},"c0"]]}')" | \
            jq -r '.methodResponses[0][1].list[].id // empty' 2>/dev/null | tr '\n' ',')
          if echo ",\${EXISTING_ACME}," | grep -q ',letsencrypt,'; then
            echo "AcmeProvider letsencrypt already exists — skipping"
          else
            jmap_call "\$(jq -n --arg a "\$ACCT" --arg d "\${STALWART_DOMAIN}" \
              '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
                methodCalls:[["x:AcmeProvider/set",
                  {accountId:\$a,create:{letsencrypt:{
                    directory:"https://acme-v02.api.letsencrypt.org/directory",
                    challengeType:"Http01",
                    contact:{("hostmaster@" + \$d): true}
                  }}},
                  "c0"]]}')" | jq -r '.methodResponses[0] | "\(.[0]): \(.[1] | keys[0])"'
            echo "AcmeProvider created"
          fi

          # 6. AllowedIp — create missing entries
          EXISTING_IPS=\$(jmap_call "\$(jq -n --arg a "\$ACCT" \
            '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
              methodCalls:[["x:AllowedIp/get",{accountId:\$a,ids:null},"c0"]]}')" | \
            jq -r '.methodResponses[0][1].list[].id // empty' 2>/dev/null | tr '\n' ',')
          CREATE_IPS='{}'
          echo ",\${EXISTING_IPS}," | grep -q ',cluster-pod,' || \
            CREATE_IPS=\$(echo "\$CREATE_IPS" | jq \
              '."cluster-pod" = {"address":"10.42.0.0/16","reason":"k8s pod CIDR (kubelet probes + intra-cluster)"}')
          echo ",\${EXISTING_IPS}," | grep -q ',cluster-svc,' || \
            CREATE_IPS=\$(echo "\$CREATE_IPS" | jq \
              '."cluster-svc" = {"address":"10.43.0.0/16","reason":"k8s service CIDR"}')
          if [ "\$CREATE_IPS" != '{}' ]; then
            jmap_call "\$(jq -n --arg a "\$ACCT" --argjson c "\$CREATE_IPS" \
              '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
                methodCalls:[["x:AllowedIp/set",{accountId:\$a,create:\$c},"c0"]]}')" | \
              jq -r '.methodResponses[0] | "\(.[0]): \(.[1] | keys[0])"'
            echo "AllowedIp created"
          else
            echo "AllowedIp already present — skipping"
          fi

          # 7. NetworkListeners — create missing
          EXISTING_NL=\$(jmap_call "\$(jq -n --arg a "\$ACCT" \
            '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
              methodCalls:[["x:NetworkListener/get",{accountId:\$a,ids:null},"c0"]]}')" | \
            jq -r '.methodResponses[0][1].list[].name // empty' 2>/dev/null | tr '\n' ',')
          echo "Existing listeners: \${EXISTING_NL}"
          CREATE_NL='{}'
          echo ",\${EXISTING_NL}," | grep -q ',http-acme,' || \
            CREATE_NL=\$(echo "\$CREATE_NL" | jq \
              '."http-acme" = {"name":"http-acme","bind":{"[::]:80":true},"protocol":"http","tlsImplicit":false,"useTls":false}')
          echo ",\${EXISTING_NL}," | grep -q ',submission,' || \
            CREATE_NL=\$(echo "\$CREATE_NL" | jq \
              '."submission" = {"name":"submission","bind":{"[::]:587":true},"protocol":"smtp","tlsImplicit":false}')
          echo ",\${EXISTING_NL}," | grep -q ',imap,' || \
            CREATE_NL=\$(echo "\$CREATE_NL" | jq \
              '."imap" = {"name":"imap","bind":{"[::]:143":true},"protocol":"imap","tlsImplicit":false}')
          LISTENERS_CREATED=false
          if [ "\$CREATE_NL" != '{}' ]; then
            jmap_call "\$(jq -n --arg a "\$ACCT" --argjson c "\$CREATE_NL" \
              '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
                methodCalls:[["x:NetworkListener/set",{accountId:\$a,create:\$c},"c0"]]}')" | \
              jq -r '.methodResponses[0] | "\(.[0]): \(.[1] | keys[0])"'
            echo "NetworkListeners created"
            LISTENERS_CREATED=true
          else
            echo "All listeners already present — skipping"
          fi

          # 8. Admin credentials — update the admin JMAP account created by
          # x:Bootstrap/set. After a normal bootstrap, the admin account IS a
          # JMAP principal and appears in x:Account/get. After a DB-wipe + auto-
          # seed (no x:Bootstrap/set), only the built-in superuser exists and
          # x:Account/get returns empty — in that case, skip gracefully (the
          # built-in superuser password is the recoveryPassword from the Secret
          # and cannot be changed via JMAP x:Account/set).
          ACCT_RESP=\$(jmap_call "\$(jq -n --arg a "\$ACCT" \
            '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
              methodCalls:[["x:Account/get",{accountId:\$a,ids:null},"c0"]]}')")
          ADMIN_ID=\$(echo "\$ACCT_RESP" | jq -r \
            '.methodResponses[0][1].list[] | select(.name == "admin") | .id' 2>/dev/null | head -1)
          if [ -z "\$ADMIN_ID" ]; then
            ADMIN_ID=\$(echo "\$ACCT_RESP" | jq -r \
              '.methodResponses[0][1].list[] | select(.roles != null) |
               select(.roles["@type"] == "Superuser" or .roles["@type"] == "Admin") | .id' \
              2>/dev/null | head -1)
          fi
          if [ -z "\$ADMIN_ID" ]; then
            echo "No JMAP admin account found (built-in superuser only) — skipping credential update."
            echo "Admin authenticates via recoveryPassword from stalwart-admin-creds."
          else
            echo "admin account id=\${ADMIN_ID}"
            jmap_call "\$(jq -n --arg a "\$ACCT" --arg id "\$ADMIN_ID" --arg p "\${adminPassword}" \
              '{using:["urn:ietf:params:jmap:core","urn:stalwart:jmap"],
                methodCalls:[["x:Account/set",
                  {accountId:\$a,update:{
                    (\$id): {"credentials":{"0":{"@type":"Password","secret":\$p,"allowedIps":{},"expiresAt":null}}}
                  }},
                  "c0"]]}')" | jq -r '.methodResponses[0] | "\(.[0]): \(.[1] | keys[0])"'
            echo "Admin credentials OK"
          fi

          echo ""
          echo "configure-ok listeners_created=\${LISTENERS_CREATED}"
POD_YAML

  if ! kctl wait --for=jsonpath='{.status.phase}'=Succeeded \
       -n mail "pod/${pod_name}" --timeout=180s 2>/dev/null; then
    warn "  configure pod did not Succeed within 180s."
    kctl logs -n mail "${pod_name}" 2>&1 | tail -40 | sed 's/^/      /' || true
    kctl delete pod    -n mail "${pod_name}"    --grace-period=10 --wait=false 2>/dev/null || true
    kctl delete secret -n mail "${params_secret}" --wait=false 2>/dev/null || true
    return 1
  fi

  local last_line
  last_line=$(kctl logs -n mail "${pod_name}" 2>/dev/null | tail -1)
  kctl logs -n mail "${pod_name}" 2>&1 | sed 's/^/    /' || true
  kctl delete pod    -n mail "${pod_name}"    --grace-period=10 --wait=false 2>/dev/null || true
  kctl delete secret -n mail "${params_secret}" --wait=false 2>/dev/null || true

  # Roll Deployment if new listeners were created (re-bind sockets at process start).
  if echo "$last_line" | grep -q 'listeners_created=true'; then
    log "  Rolling Stalwart Deployment so new listeners bind..."
    kctl rollout restart -n mail deploy/stalwart-mail
    kctl rollout status  -n mail deploy/stalwart-mail --timeout=180s || \
      warn "  Stalwart rollout did not complete in 180s — verify manually."
  fi

  log "  Stalwart full configuration complete."
}

bootstrap_stalwart_v016() {
  log ""
  log "── Stalwart 0.16 bootstrap ──"

  # Guard: only run when the stalwart-mail overlay was actually applied
  # (Deployment exists). If the operator is not deploying mail, skip.
  if ! kctl get deployment -n mail stalwart-mail &>/dev/null 2>&1; then
    log "  stalwart-mail Deployment not found — skipping (mail not deployed)."
    return 0
  fi

  # Phase 1 (RocksDB migration): mail-pg CNPG cluster wait removed.
  # Stalwart now uses embedded RocksDB — no CNPG dependency at startup.

  # ── Step 2: Wait for Stalwart pod to start ────────────────────────────
  log "  Waiting for stalwart-mail rollout (up to 300s)..."
  if ! kctl rollout status -n mail deploy/stalwart-mail --timeout=300s 2>/dev/null; then
    warn "  stalwart-mail rollout did not complete — bootstrap may fail."
  fi

  # ── Step 3: Detect bootstrap state via dual auth probe ───────────────
  # Three-state detection (all via the JMAP mgmt Service ClusterIP):
  #   adminPassword 200  → fully configured (both Job + configure ran)
  #   recoveryPassword 200, adminPassword 401 → Job ran but configure pending
  #   both 401           → fresh empty DB, need full bootstrap
  # Any other code (5xx, 000) → indeterminate, refuse to proceed.
  local stalwart_admin_pw stalwart_recovery_pw
  stalwart_admin_pw=$(kctl get secret -n mail stalwart-admin-creds \
    -o jsonpath='{.data.adminPassword}' 2>/dev/null | base64 -d || echo "")
  stalwart_recovery_pw=$(kctl get secret -n mail stalwart-admin-creds \
    -o jsonpath='{.data.recoveryPassword}' 2>/dev/null | base64 -d || echo "")
  if [[ -z "$stalwart_admin_pw" || -z "$stalwart_recovery_pw" ]]; then
    warn "  stalwart-admin-creds missing adminPassword or recoveryPassword."
    warn "  Re-run generate_platform_secrets first."
    return 0
  fi

  local stalwart_hostname="mail.${PLATFORM_DOMAIN}"
  local stalwart_domain="${PLATFORM_DOMAIN}"

  # Use the JMAP mgmt Service (always reachable from within cluster).
  local mgmt_url="http://stalwart-mgmt.mail.svc.cluster.local:8080"
  local probe_pod
  probe_pod=$(kctl get pod -n platform -l app=admin-panel \
    -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
  if [[ -z "$probe_pod" ]]; then
    warn "  No admin-panel pod found — cannot probe Stalwart auth state."
    return 0
  fi

  local admin_code recovery_code
  admin_code=$(kctl exec -n platform "$probe_pod" -- \
    curl -s -o /dev/null -w '%{http_code}' \
    -u "admin:${stalwart_admin_pw}" --max-time 5 \
    "${mgmt_url}/jmap/session" 2>/dev/null || echo "000")
  recovery_code=$(kctl exec -n platform "$probe_pod" -- \
    curl -s -o /dev/null -w '%{http_code}' \
    -u "admin:${stalwart_recovery_pw}" --max-time 5 \
    "${mgmt_url}/jmap/session" 2>/dev/null || echo "000")

  log "  Auth probe: adminPassword=${admin_code} recoveryPassword=${recovery_code}"

  case "$admin_code" in
    200)
      log "  Stalwart fully configured (adminPassword auth 200) — skipping bootstrap."
      return 0
      ;;
    401)
      case "$recovery_code" in
        200)
          log "  Bootstrap Job ran but full configuration pending — running configure_stalwart_full()."
          configure_stalwart_full "$stalwart_hostname" "$stalwart_domain" || \
            warn "  configure_stalwart_full returned non-zero — check logs above."
          return 0
          ;;
        401)
          log "  Fresh DB — proceeding with bootstrap Job."
          ;;
        *)
          warn "  recoveryPassword probe returned unexpected ${recovery_code} — refusing to bootstrap."
          return 1
          ;;
      esac
      ;;
    *)
      warn "  adminPassword probe returned unexpected ${admin_code} — refusing to bootstrap."
      warn "  Inspect pod state manually before retrying."
      return 1
      ;;
  esac

  # ── Step 4: stalwart-admin-creds already present (generate_platform_secrets) ──

  # ── Step 5: Render bootstrap plan and write to stalwart-bootstrap-plan Secret ──
  # Bootstrap plan is now a simple JSON object with only hostname + domain.
  # All other config (SystemSettings, Jmap, DKIM, listeners, admin creds)
  # is applied post-restart by configure_stalwart_full() via JMAP.
  log "  Rendering bootstrap plan..."
  local plan_rendered
  plan_rendered=$(STALWART_HOSTNAME="$stalwart_hostname" \
    STALWART_DOMAIN="$stalwart_domain" \
    envsubst < <(kctl get configmap -n mail stalwart-bootstrap-plan \
      -o jsonpath='{.data.bootstrap-plan\.json}' 2>/dev/null))

  if [[ -z "$plan_rendered" ]]; then
    warn "  Failed to read stalwart-bootstrap-plan ConfigMap — ensure mail overlay is applied."
    return 0
  fi

  kctl create secret generic stalwart-bootstrap-plan \
    --namespace=mail \
    --from-literal=plan.json="$plan_rendered" \
    --dry-run=client -o yaml | kctl apply -f -
  log "  stalwart-bootstrap-plan Secret written."

  # ── Step 6: Unsuspend bootstrap Job and wait ─────────────────────────
  log "  Unsuspending stalwart-bootstrap Job..."
  kctl patch job stalwart-bootstrap -n mail \
    -p '{"spec":{"suspend":false}}' 2>/dev/null || {
    warn "  Failed to unsuspend bootstrap Job — it may not exist yet (Flux still reconciling)."
    warn "  Re-run bootstrap.sh or manually patch: kubectl patch job stalwart-bootstrap -n mail -p '{\"spec\":{\"suspend\":false}}'"
    return 0
  }

  log "  Waiting for bootstrap Job to complete (up to 300s)..."
  if ! kctl wait --for=condition=complete job/stalwart-bootstrap \
      -n mail --timeout=300s 2>/dev/null; then
    warn "  Bootstrap Job did not complete in 300s."
    warn "  Check logs: kubectl logs -n mail -l app.kubernetes.io/component=mail-bootstrap"
    return 0
  fi
  log "  Bootstrap Job completed."

  # ── Step 7: Restart Deployment to exit bootstrap mode ────────────────
  log "  Rolling Stalwart Deployment to exit bootstrap mode..."
  kctl rollout restart -n mail deploy/stalwart-mail
  kctl rollout status  -n mail deploy/stalwart-mail --timeout=180s || true

  # ── Step 8: Full JMAP configuration ──────────────────────────────────
  log "  Running post-bootstrap JMAP configuration..."
  configure_stalwart_full "$stalwart_hostname" "$stalwart_domain" || \
    warn "  configure_stalwart_full returned non-zero — check logs above."

  # ── Step 9: Verify full mode ──────────────────────────────────────────
  log "  Verifying Stalwart 0.16 full mode..."
  local new_pod_ip verify_code
  new_pod_ip=$(kctl get pod -n mail -l app=stalwart-mail \
    -o jsonpath='{.items[0].status.podIP}' 2>/dev/null || echo "")
  if [[ -z "$new_pod_ip" ]]; then
    warn "  No pod found after rollout — verification skipped."
    return 0
  fi
  verify_code=$(kctl exec -n platform "$probe_pod" -- \
    curl -s -o /dev/null -w '%{http_code}' --max-time 5 \
    "http://${new_pod_ip}:8080/jmap/session" 2>/dev/null || echo "000")

  if [[ "$verify_code" == "200" || "$verify_code" == "401" ]]; then
    log "  Stalwart 0.16 is in full mode (/jmap/session → ${verify_code}). Bootstrap complete."
  else
    warn "  /jmap/session returned ${verify_code} after rollout — Stalwart may need more time."
    warn "  Wait ~30s then retry: kubectl exec -n platform ${verify_probe_pod} -- curl -sI http://${new_pod_ip}:8080/jmap/session"
  fi
}

apply_platform_manifests() {
  log "Applying platform manifests..."

  # Wait for admission webhooks that gate the kubectl apply -k below.
  # On a fresh cluster, Longhorn's mutator.longhorn.io webhook can take
  # 60-120s after Helm `--wait` returns before its endpoints populate;
  # CNPG's webhook has the same shape. Both are referenced by objects
  # in the platform overlay (Longhorn-class PVCs, the Postgres Cluster
  # CR), so applying before they're ready triggers
  # "no endpoints available for service longhorn-admission-webhook"
  # and aborts under set -e. Caught fresh-install on testing.phoenix-
  # host.net 2026-04-30 — same race on staging during initial
  # bootstrap (worked there only because operator re-ran bootstrap
  # after Longhorn settled).
  wait_for_admission_webhooks

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

  # Compute hostnames from --domain (operator provides the full base domain).
  # ALL environments use bare apex — no env prefix. The historical staging
  # `<svc>.staging.<domain>` shape was a phoenix-host.net deployment artefact
  # that confused operators ("admin.testing.phoenix-host.net 404, but
  # admin.staging.testing.phoenix-host.net works") and made print_summary
  # lie about the URL. Operators who want a separate cluster per environment
  # should pass distinct --domain values (e.g. testing.phoenix-host.net vs
  # phoenix-host.net) — bootstrap doesn't sub-namespace by env.
  local api_host="api.${PLATFORM_DOMAIN}"
  local admin_host="admin.${PLATFORM_DOMAIN}"
  local client_host="client.${PLATFORM_DOMAIN}"
  log "Hostnames: ${api_host}, ${admin_host}, ${client_host}"

  # Generate the environment overlay with real hostnames.
  # For staging, preserve the checked-in kustomization.yaml (contains
  # Flux image policy markers) and only write an ingress patch file.
  local overlay_dir="${repo_dir}/k8s/overlays/${PLATFORM_ENV}"
  mkdir -p "$overlay_dir"

  # ── Unified overlay-apply flow (works for ALL environments) ──────────
  # Every overlay (dev, staging, production) is checked into the repo
  # using literal `${DOMAIN}` placeholders wherever the cluster apex
  # would otherwise be hardcoded. Two converging paths apply the
  # rendered output:
  #   • bootstrap (this script): `kustomize | envsubst | kubectl apply`
  #   • Flux: built-in postBuild.substituteFrom on every reconcile,
  #     reading from the same platform-cluster-config ConfigMap.
  # No on-disk sed; no Flux/bootstrap tug-of-war. See
  # docs/04-deployment/CLUSTER_NETWORK.md (operator section).
  if [[ ! -f "${overlay_dir}/kustomization.yaml" ]]; then
    error "Overlay ${PLATFORM_ENV} not found at ${overlay_dir}/kustomization.yaml — \
expected k8s/overlays/${PLATFORM_ENV}/ to exist (dev | staging | production)."
  fi

  # If the CM already exists, refuse to overwrite a mismatched DOMAIN
  # or ENV unless the operator explicitly passes --force-domain-change.
  # Re-running bootstrap.sh with a typo'd --domain previously clobbered
  # the CM silently, breaking every Ingress that uses ${DOMAIN} envsubst
  # (admin.${DOMAIN}, client.${DOMAIN}, dex.${DOMAIN}, …) and 502'ing
  # the admin panel until the CM was patched back manually. Observed
  # on staging1 2026-05-08.
  local existing_domain="" existing_env=""
  if kctl get cm -n flux-system platform-cluster-config >/dev/null 2>&1; then
    existing_domain=$(kctl get cm -n flux-system platform-cluster-config -o jsonpath='{.data.DOMAIN}' 2>/dev/null || echo "")
    existing_env=$(kctl get cm -n flux-system platform-cluster-config -o jsonpath='{.data.ENV}' 2>/dev/null || echo "")
    if [[ -n "$existing_domain" && "$existing_domain" != "$PLATFORM_DOMAIN" ]]; then
      if [[ "$FORCE_DOMAIN_CHANGE" != "true" ]]; then
        error "Refusing to change platform-cluster-config DOMAIN: existing=${existing_domain} new=${PLATFORM_DOMAIN}.
Re-running bootstrap.sh with a different --domain would overwrite the live cluster's DOMAIN and break every
Ingress / cert / cookie domain pinned to it. Pass --force-domain-change if the rename is intentional, OR
correct your --domain to match the live cluster."
      fi
      warn "DOMAIN change confirmed via --force-domain-change: ${existing_domain} → ${PLATFORM_DOMAIN}. Existing Ingresses + certs will need re-issuance."
    fi
    if [[ -n "$existing_env" && "$existing_env" != "$PLATFORM_ENV" ]]; then
      if [[ "$FORCE_DOMAIN_CHANGE" != "true" ]]; then
        error "Refusing to change platform-cluster-config ENV: existing=${existing_env} new=${PLATFORM_ENV}.
Cross-env re-bootstrap is almost always a mistake (e.g. running --env production on a staging cluster
swaps cert issuers + retention policies). Pass --force-domain-change if intentional."
      fi
      warn "ENV change confirmed via --force-domain-change: ${existing_env} → ${PLATFORM_ENV}."
    fi
  fi

  # Resolve the CLUSTER_ISSUER_NAME to pin into the ConfigMap. The
  # value comes from --cluster-issuer (if passed) or the per-env default
  # (computed in install_cert_manager_issuers). Adding it here lets Flux
  # postBuild substituteFrom resolve `${CLUSTER_ISSUER_NAME}` literals
  # in base manifests (e.g. cert-manager Certificate CRs alongside
  # Traefik IngressRoutes), so a single base manifest works across
  # dev/staging/production without per-overlay literal patches.
  local cluster_issuer_for_cm="${CLUSTER_ISSUER_NAME:-letsencrypt-prod-http01}"
  if [[ "$PLATFORM_ENV" == "staging" && -z "${CLUSTER_ISSUER_NAME:-}" ]]; then
    cluster_issuer_for_cm="letsencrypt-staging-http01"
  elif [[ "$PLATFORM_ENV" == "dev" && -z "${CLUSTER_ISSUER_NAME:-}" ]]; then
    cluster_issuer_for_cm="local-ca-issuer"
  fi

  log "Materialising ConfigMap platform-cluster-config (DOMAIN=${PLATFORM_DOMAIN}, ENV=${PLATFORM_ENV}, CLUSTER_ISSUER_NAME=${cluster_issuer_for_cm})..."
  kctl create configmap platform-cluster-config \
    -n flux-system \
    --from-literal=DOMAIN="${PLATFORM_DOMAIN}" \
    --from-literal=ENV="${PLATFORM_ENV}" \
    --from-literal=CLUSTER_ISSUER_NAME="${cluster_issuer_for_cm}" \
    --dry-run=client -o yaml | kctl apply -f -

  # Dex config injection — only for overlays that ship Dex (dev/staging).
  # Replace any leftover PLACEHOLDER URLs and the generated oauth2-proxy
  # client secret. The ${DOMAIN}-bearing lines are left as placeholders
  # for envsubst to resolve below.
  local dex_config="${overlay_dir}/dex/config.yaml"
  if [[ -f "$dex_config" ]]; then
    log "Updating Dex config (env=${PLATFORM_ENV})..."
    sed -i "s|PLACEHOLDER.example.com|${PLATFORM_DOMAIN}|g" "$dex_config"
    local proxy_secret
    proxy_secret=$(kctl get secret -n platform oauth2-proxy-config -o jsonpath='{.data.OAUTH2_PROXY_CLIENT_SECRET}' 2>/dev/null | base64 -d || echo "")
    if [[ -n "$proxy_secret" ]]; then
      # Match either staging-secret-oauth2-proxy or local-dev-secret-oauth2-proxy
      sed -i "s|staging-secret-oauth2-proxy\|local-dev-secret-oauth2-proxy|${proxy_secret}|g" "$dex_config"
      log "Dex oauth2-proxy client secret synced from generated secret."
    fi
  fi

  if ! command -v envsubst >/dev/null 2>&1; then
    error "envsubst not found on PATH; install gettext-base / gettext."
  fi
  log "Rendering overlay with envsubst (DOMAIN=${PLATFORM_DOMAIN}) and applying..."
  # SSA with field-manager=kustomize-controller (Flux's default). Without
  # this, bootstrap uses client-side apply and stashes the manifest in
  # `last-applied-configuration`. When Flux later reconciles via SSA, k8s
  # has already added system-managed labels to live Job pods (controller-
  # uid, batch.kubernetes.io/job-name) — Flux sees a phantom diff in
  # `spec.template.metadata.labels` and tries to patch it, but Job
  # `spec.template` is immutable → "field is immutable" → Kustomization
  # stuck Ready=False. Matching field-manager names lets Flux take clean
  # ownership on first reconcile. --force-conflicts is needed because k8s
  # auto-managed labels register as conflicts on first SSA from a new
  # field manager. See project_testing_bootstrap_2026_05_08.md issue 3.
  DOMAIN="${PLATFORM_DOMAIN}" \
    kubectl --kubeconfig="$KUBECONFIG" kustomize "$overlay_dir" \
    | DOMAIN="${PLATFORM_DOMAIN}" envsubst '${DOMAIN}' \
    | kctl apply --server-side --force-conflicts \
                 --field-manager=kustomize-controller -f -
  log "Platform manifests applied with domain ${PLATFORM_DOMAIN} (env=${PLATFORM_ENV})."
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
  kctl get svc -n traefik 2>/dev/null || echo "  (not found)"
  kctl get daemonset -n traefik traefik 2>/dev/null || echo "  (traefik daemonset not found)"

  log ""
  log "── Certificates ──"
  kctl get clusterissuer 2>/dev/null || echo "  (not found)"

  log ""
  log "── Firewall ──"
  nft list ruleset 2>/dev/null | head -10 || echo "  (nftables not configured)"

  log ""
  log "════════════════════════════════════════════════"
}

# Real install verification — moves beyond "kubectl get nodes shows
# Ready". Probes the admin-panel HTTPS endpoint at the operator's
# --domain, hits /api/v1/healthz on platform-api, and logs in via the
# seeded admin credentials. Fails loudly on any step that the user
# would notice when they open the browser. Skip cert verification (-k)
# because LE staging issuer is the bootstrap default — the cert chain
# is untrusted intentionally.
verify_install() {
  log ""
  log "── Verifying install ──"
  # The platform-api is path-routed under admin.${PLATFORM_DOMAIN}/api/v1/*
  # (no separate api.<domain> Ingress host). Earlier code used a phantom
  # api_host that returned 404 because nothing actually serves it —
  # bootstrap-only synthetic, not in the rendered overlay.
  local admin_host="admin.${PLATFORM_DOMAIN}"
  local creds_file="/etc/platform/admin-credentials"
  local rc=0

  # Wait up to 5 min for the platform-api Deployment to finish rolling
  # out — Helm/Flux may still be settling at this point.
  log "  Waiting for platform-api rollout..."
  if ! kctl rollout status -n platform deploy/platform-api --timeout=300s 2>&1 | tail -1; then
    warn "  platform-api rollout did not complete; verification will likely fail."
  fi

  # 1. /healthz — checks API process and DB connectivity.
  log "  Probing https://${admin_host}/api/v1/healthz ..."
  local health
  health=$(curl -sk -m 15 -o /dev/null -w '%{http_code}' \
             -H "Host: ${admin_host}" "https://127.0.0.1/api/v1/healthz" 2>/dev/null || echo "000")
  if [[ "$health" != "200" ]]; then
    warn "  /healthz returned ${health} (expected 200)"
    rc=1
  else
    log "  /healthz: 200 OK"
  fi

  # 2. Admin login — POST /api/v1/auth/login with seeded credentials.
  if [[ ! -f "$creds_file" ]]; then
    warn "  ${creds_file} missing; cannot exercise admin login."
    rc=1
  else
    local admin_email admin_password
    admin_email=$(awk -F= '/^ADMIN_EMAIL=/{print $2}' "$creds_file")
    admin_password=$(awk -F= '/^ADMIN_PASSWORD=/{print $2}' "$creds_file")
    if [[ -z "$admin_email" || -z "$admin_password" ]]; then
      warn "  could not read ADMIN_EMAIL/ADMIN_PASSWORD from ${creds_file}"
      rc=1
    else
      log "  Logging in as ${admin_email}..."
      local login_body
      login_body=$(printf '{"email":"%s","password":"%s"}' "$admin_email" "$admin_password")
      local login_resp login_code
      login_resp=$(curl -sk -m 15 -X POST \
                     -H "Host: ${admin_host}" \
                     -H "Content-Type: application/json" \
                     -d "$login_body" \
                     -w '\n%{http_code}' \
                     "https://127.0.0.1/api/v1/auth/login" 2>/dev/null || true)
      login_code="${login_resp##*$'\n'}"
      local login_json="${login_resp%$'\n'*}"
      if [[ "$login_code" != "200" ]]; then
        warn "  /auth/login returned ${login_code} (expected 200)"
        warn "  body: $(echo "$login_json" | head -c 200)"
        rc=1
      elif ! echo "$login_json" | grep -qE '"accessToken"|"token"'; then
        warn "  /auth/login 200 but no accessToken/token in body: $(echo "$login_json" | head -c 200)"
        rc=1
      else
        log "  /auth/login: 200 OK, access token issued"
      fi
    fi
  fi

  # 3. Admin panel HTTP shell — should redirect HTTP→HTTPS or serve the
  # SPA shell on HTTPS. The exact body doesn't matter; we verify that
  # the Ingress is routing the host to the admin-panel Service.
  log "  Probing https://${admin_host}/ ..."
  local panel_code
  panel_code=$(curl -sk -m 15 -o /dev/null -w '%{http_code}' \
                 -H "Host: ${admin_host}" "https://127.0.0.1/" 2>/dev/null || echo "000")
  case "$panel_code" in
    200|301|302) log "  admin panel: ${panel_code}" ;;
    *) warn "  admin panel returned ${panel_code} (expected 200/301/302)"; rc=1 ;;
  esac

  if (( rc == 0 )); then
    log "  ✓ verify_install: all checks passed."
  else
    warn "  ✗ verify_install: one or more checks failed (see warnings above)."
    warn "    Bootstrap finished but the admin panel may not be usable yet."
    warn "    Common causes: cert-manager still issuing TLS, DNS not yet"
    warn "    propagated to operator's resolver, ingress controller still"
    warn "    rolling out. Re-run verify_install in a few minutes."
  fi
  return $rc
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

# ─── Phase 5: Post-install smoke (advisory) ──────────────────────────────────

# Run the cluster-network smoke suite at the very end of bootstrap and emit
# a clear PASS/FAIL summary. Advisory by default — first-bootstrap timing
# varies (oauth2-proxy + dex CrashLoopBackOff during reconcile is normal),
# so we don't fail bootstrap on smoke FAIL unless the operator opts in via
# --require-smoke-pass. The smoke script lives in the same scripts/ dir as
# this bootstrap (same repo); we resolve its path relative to BASH_SOURCE
# so the function works whether bootstrap was run locally or via --remote.
run_post_install_smoke() {
  if [[ "$SKIP_SMOKE" == "true" ]]; then
    log "Skipping post-install smoke (--skip-smoke)."
    return 0
  fi
  # Resolve smoke script location. In --remote mode the parent
  # bootstrap.sh is scp'd to /tmp/bootstrap.sh ALONE — the smoke script
  # is NOT included. But apply_platform_manifests git-clones the whole
  # repo to /opt/k8s-hosting-platform/, so the smoke script is available
  # there by the time this function runs. Prefer the cloned-repo path
  # over BASH_SOURCE-relative (which resolves to /tmp on remote runs).
  local smoke_script=""
  for candidate in \
      "/opt/k8s-hosting-platform/scripts/smoke-test-cluster-network.sh" \
      "${BASH_SOURCE[0]%/*}/smoke-test-cluster-network.sh"; do
    if [[ -f "$candidate" ]]; then
      smoke_script="$candidate"
      chmod +x "$smoke_script" 2>/dev/null || true
      break
    fi
  done
  if [[ -z "$smoke_script" || ! -x "$smoke_script" ]]; then
    warn "smoke script not found in the expected paths — skipping post-install smoke."
    warn "  Looked in: /opt/k8s-hosting-platform/scripts/, ${BASH_SOURCE[0]%/*}/"
    return 0
  fi

  log ""
  log "── Phase 5: Post-install smoke (advisory) ──"
  log "Smoke script: $smoke_script"

  # Wait for cluster-settle by checking actual readiness conditions
  # rather than a fixed sleep. Flux Kustomizations are the slowest
  # reconcile path (cert-manager + ingress-nginx admission webhooks
  # + sealed-secrets + platform), so when they're all Ready=True we
  # know the cluster is in a steady state. SMOKE_WAIT_SECONDS becomes
  # the timeout for that wait, not a blind sleep.
  log "Waiting up to ${SMOKE_WAIT_SECONDS}s for Flux Kustomizations to reconcile..."
  if ! KUBECONFIG="$KUBECONFIG" kubectl wait kustomization --all -n flux-system \
      --for=condition=Ready --timeout="${SMOKE_WAIT_SECONDS}s" >/dev/null 2>&1; then
    warn "Not all Kustomizations reached Ready within ${SMOKE_WAIT_SECONDS}s — running smoke anyway (some FAILs may be transient)"
  else
    log "All Flux Kustomizations Ready — running smoke."
  fi

  local smoke_log="/var/log/hosting-platform-bootstrap-smoke.log"
  log "Running smoke suite — log: $smoke_log"
  # Capture rc without tripping the parent `set -e` (we explicitly
  # decide whether to fatal based on REQUIRE_SMOKE_PASS).
  local rc=0
  KUBECONFIG="$KUBECONFIG" bash "$smoke_script" >"$smoke_log" 2>&1 || rc=$?
  if [[ $rc -eq 0 ]]; then
    log "Smoke result: PASS (full log at $smoke_log)"
    return 0
  fi
  local summary
  summary=$(grep '^\[INFO\] run.summary' "$smoke_log" 2>/dev/null | tail -1 || true)
  if [[ "$REQUIRE_SMOKE_PASS" == "true" ]]; then
    # error() exits 1; this never returns.
    error "Smoke FAILED (rc=$rc) and --require-smoke-pass is set. ${summary:-see $smoke_log}"
  fi
  warn "Smoke FAILED (rc=$rc) — advisory only. ${summary:-see $smoke_log}"
  warn "Bootstrap exits 0 because --require-smoke-pass was not set. Investigate via:"
  warn "  scripts/smoke-test-cluster-network.sh   (full output)"
  warn "  make diagnose                           (forensic snapshot)"
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
  # Bootstrap does NOT install or enrol VPN/mesh tooling — sysadmin
  # responsibility, performed before this script runs. verify_underlay
  # asserts the operator-claimed underlay is actually up; configure_firewall
  # then auto-detects wt0/tailscale0 and renders cidr-mode rules.
  log "── Phase 1: Server Hardening ──"
  if [[ "$DRY_RUN" == true ]]; then
    log "DRY-RUN: skipping harden_ssh (no sshd in container)"
  else
    harden_ssh
  fi
  install_packages
  if [[ "$DRY_RUN" != true ]]; then
    configure_node_logging_caps
    configure_node_net_tuning
  fi
  if [[ "$DRY_RUN" == true ]]; then
    log ""
    log "════════════════════════════════════════════════"
    log "  DRY-RUN COMPLETE — OS + packages OK"
    log "  OS:      ${PRETTY_NAME}"
    log "  family:  ${OS_FAMILY}"
    log "════════════════════════════════════════════════"
    return 0
  fi
  verify_underlay
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
    # CrowdSec bouncer key Secret must exist BEFORE install_traefik so
    # the Traefik DaemonSet's volume mount (--set volumes[0].type=secret
    # crowdsec-bouncer-key) finds the Secret on first start; otherwise
    # the pod stays Pending with FailedMount until the Secret lands.
    generate_crowdsec_bouncer_key
    install_traefik
    install_cert_manager
    install_sealed_secrets
    install_longhorn
    # M10: CNPG operator (passive — no Cluster CR applied). Installs
    # alongside Longhorn so the Postgres replication activation flow
    # in docs/09-runbooks/CNPG_ACTIVATION_RUNBOOK.md is a single-CR
    # step rather than a multi-phase upgrade when the time comes.
    install_cnpg
    install_monitoring
    # CRITICAL ORDERING (Cut 3 staging-cutover lesson, 2026-05-04):
    # generate_platform_secrets MUST run BEFORE install_flux. Flux's
    # Kustomization starts reconciling within seconds of creation; if
    # it applies v016 manifests before stalwart-admin-creds exists, the
    # Stalwart Deployment crashes with "secret not found".
    # Phase 1 (RocksDB): mail-pg-app-credentials is no longer needed.
    # generate_platform_secrets is fully self-contained — it only needs
    # the kube-API + namespaces/Secrets RBAC, which are available right
    # after install_cnpg.
    #
    # System Backup Phase 1.4: --secrets-bundle import runs FIRST so
    # generate_platform_secrets sees the imported Secrets and skips
    # regeneration. No-op when --secrets-bundle is not passed.
    import_secrets_bundle
    generate_platform_secrets
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
    create_platform_configmap
    generate_operator_recipient
    apply_platform_manifests
    # Seed ClusterTrustedRange CRs from --allow-source entries. Runs
    # AFTER apply_platform_manifests so the CRDs are guaranteed
    # present. The reconciler converges these CRs into the host nft
    # trusted_ranges_v{4,6} sets — without this seed, the reconciler's
    # atomic flush+add wipes the bootstrap-time-only nft seed on first
    # tick and operator NetBird/workstation access disappears.
    seed_cluster_trusted_range_crs
    # Tag the Longhorn Node CR (.spec.tags + each disk .tags = "system")
    # so the platform's longhorn-system-local StorageClass can schedule
    # replicas. apply_platform_manifests waits for the longhorn admission
    # webhook before applying overlay, so by here the webhook is ready;
    # the function still re-checks defensively. See issue 2 in
    # project_testing_bootstrap_2026_05_08.md.
    tag_longhorn_node_for_system_replicas
    # Stalwart 0.16 first-install bootstrap. Runs after apply_platform_manifests
    # so the stalwart-mail manifests (Deployment, CNPG Cluster, bootstrap Job)
    # exist in the cluster before we wait for them. Skips gracefully when the
    # stalwart-mail overlay was not applied (mail not deployed). Idempotent:
    # re-run is safe when stalwart-admin-creds already exists + full mode.
    bootstrap_stalwart_v016
    # Cut 3 (2026-05-04): Roundcube webmail PG database+role provisioning.
    # Runs after Stalwart bootstrap so platform CNPG is up + Roundcube
    # secrets exist. Idempotent — DO BLOCK skips if role/db already exist.
    create_roundcube_db
    # Cut 3 (2026-05-04): Stalwart master user (Roundcube SSO impersonator).
    # Runs after bootstrap_stalwart_v016 (so Stalwart is up + the recovery
    # admin can authenticate to the cli). Idempotent — re-runs only update
    # credentials/roles to converge after rotation.
    provision_stalwart_master_user
    # Tier-1 secrets bundle for offline retrieval. Runs after
    # generate_platform_secrets + generate_operator_recipient + bootstrap_stalwart_v016
    # so all bundled material (including stalwart-admin-creds) exists.
    # See docs/04-deployment/SECRETS_LIFECYCLE.md.
    bundle_bootstrap_secrets

    # Phase 4: Verify
    log ""
    log "── Phase 4: Verification ──"
    verify
    # Real install verification — actually probe admin login + healthz.
    # Non-fatal (warn only) so a transient cert-manager / DNS issue
    # doesn't fail bootstrap; operator gets a clear message either way.
    verify_install || true
    print_summary

    # Phase 5: post-install cluster-network smoke. Advisory by default;
    # the operator can wire it into CI with --require-smoke-pass. Only
    # runs on the first server (the only role that has KUBECONFIG +
    # cluster-wide reachability for the matrix probes).
    if [[ -z "$K3S_SERVER_IP" ]]; then
      run_post_install_smoke
    fi
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
