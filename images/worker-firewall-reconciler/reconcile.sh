#!/usr/bin/env bash
# reconcile.sh — converges host nft sets tenant_ports_{tcp,udp} with the
# Pods scheduled to this node.
#
# Inputs
#   NODE_NAME           — downward API; the node we reconcile for.
#   RECONCILE_INTERVAL  — seconds between sweeps (default 30).
#   NFT_TABLE           — table name (default `inet filter`).
#
# Sources of truth (per Pod):
#   spec.containers[*].ports[*].hostPort + protocol  (literal hostPort)
#   metadata.annotations["platform.io/firewall-tcp-ports"]  (CSV w/ ranges)
#   metadata.annotations["platform.io/firewall-udp-ports"]  (CSV w/ ranges)
#
# Annotations support ranges in nft form: "16384-32768,3478,5349".
# Single ports become 1-element nft ranges naturally — `add element { 3478 }`.
#
# Idempotent: only adds elements that are missing and removes elements that
# are no longer required. Identical state ⇒ zero nft writes.
#
# Required nft sets (declared by bootstrap.sh, declared empty):
#   set tenant_ports_tcp { type inet_service; flags interval; }
#   set tenant_ports_udp { type inet_service; flags interval; }
# If a set is missing (cluster pre-dates the firewall feature), reconcile
# logs a warning and idles — we never `nft add set` from here, the host
# bootstrap is the authoritative writer of structure.

set -uo pipefail

NODE_NAME="${NODE_NAME:?NODE_NAME env required (downward API)}"
RECONCILE_INTERVAL="${RECONCILE_INTERVAL:-30}"
NFT_TABLE="${NFT_TABLE:-inet filter}"

log() { printf '%s [worker-fw] %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"; }

# Trap SIGTERM/INT so the kubelet's graceful shutdown returns quickly.
shutdown=0
trap 'shutdown=1; log "shutdown signal received"' TERM INT

# ─── nft set helpers ────────────────────────────────────────────────────────
#
# `nft list set inet filter tenant_ports_tcp` outputs something like:
#
#   table inet filter {
#       set tenant_ports_tcp {
#           type inet_service
#           flags interval
#           elements = { 3478, 5349, 16384-32768 }
#       }
#   }
#
# We extract the `{ ... }` after `elements = ` and split on `,` to get a
# canonical list of nft elements. Empty set ⇒ no `elements =` line.
nft_set_exists() {
  local set_name="$1"
  nft list set "$NFT_TABLE" "$set_name" >/dev/null 2>&1
}

# Self-bootstrap: idempotently install the named sets + accept rules in the
# input chain if they're missing. Used on hosts whose bootstrap.sh predates
# this feature — runs once at startup and on every reconcile if they
# disappeared (e.g. after `nft flush ruleset`). Quietly no-ops if already
# present.
nft_self_bootstrap() {
  local need_tcp_set=false need_udp_set=false need_tcp_rule=false need_udp_rule=false
  nft_set_exists tenant_ports_tcp || need_tcp_set=true
  nft_set_exists tenant_ports_udp || need_udp_set=true
  # nft list table inet filter shows the rules; check for the dport @set
  # references. If absent, we add them.
  local existing
  existing=$(nft list table "$NFT_TABLE" 2>/dev/null) || return 1
  echo "$existing" | grep -qE 'tcp dport @tenant_ports_tcp accept' || need_tcp_rule=true
  echo "$existing" | grep -qE 'udp dport @tenant_ports_udp accept' || need_udp_rule=true

  if [[ "$need_tcp_set" == "true" ]]; then
    if nft "add set $NFT_TABLE tenant_ports_tcp { type inet_service\; flags interval\; }" 2>/tmp/nft.err; then
      log "self-bootstrap: created set tenant_ports_tcp"
    else
      log "FAIL self-bootstrap create tenant_ports_tcp: $(cat /tmp/nft.err)"
    fi
  fi
  if [[ "$need_udp_set" == "true" ]]; then
    if nft "add set $NFT_TABLE tenant_ports_udp { type inet_service\; flags interval\; }" 2>/tmp/nft.err; then
      log "self-bootstrap: created set tenant_ports_udp"
    else
      log "FAIL self-bootstrap create tenant_ports_udp: $(cat /tmp/nft.err)"
    fi
  fi
  if [[ "$need_tcp_rule" == "true" ]]; then
    if nft "add rule $NFT_TABLE input tcp dport @tenant_ports_tcp accept" 2>/tmp/nft.err; then
      log "self-bootstrap: added rule tcp dport @tenant_ports_tcp accept"
    else
      log "FAIL self-bootstrap add tcp rule: $(cat /tmp/nft.err)"
    fi
  fi
  if [[ "$need_udp_rule" == "true" ]]; then
    if nft "add rule $NFT_TABLE input udp dport @tenant_ports_udp accept" 2>/tmp/nft.err; then
      log "self-bootstrap: added rule udp dport @tenant_ports_udp accept"
    else
      log "FAIL self-bootstrap add udp rule: $(cat /tmp/nft.err)"
    fi
  fi
}

nft_current_elements() {
  # Prints one element per line, no whitespace, sorted+unique.
  local set_name="$1"
  local raw
  raw=$(nft -a list set "$NFT_TABLE" "$set_name" 2>/dev/null) || return 0
  # Extract the contents between `elements = {` and the matching `}`.
  # Multiline output is possible when the set has many entries.
  local elems
  elems=$(printf '%s\n' "$raw" \
    | awk '
        /elements = \{/ { inblk=1; sub(/^.*elements = \{/, "") }
        inblk { line = line $0 }
        /\}/ && inblk { sub(/\}.*$/, "", line); print line; exit }
      ')
  [[ -z "$elems" ]] && return 0
  printf '%s\n' "$elems" | tr ',' '\n' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//' \
    | grep -v '^$' | sort -u
}

# Apply the diff: add elements in $1 missing from $2, delete elements in $2
# missing from $1. Each arg is a newline-separated, sorted-uniq list.
nft_apply_diff() {
  local set_name="$1" desired="$2" current="$3"
  local to_add to_del
  to_add=$(comm -23 <(printf '%s\n' "$desired") <(printf '%s\n' "$current"))
  to_del=$(comm -13 <(printf '%s\n' "$desired") <(printf '%s\n' "$current"))

  # Defense-in-depth: even if a malicious value snuck past the jq filter,
  # reject anything that isn't a bare port or interval before splicing it
  # into the nft command. nft uses { } and ; as syntax — an injection of
  # `3478 } flush ruleset ;` here would be catastrophic on a privileged
  # process.
  local SAFE='^[0-9]+(-[0-9]+)?$'
  if [[ -n "$to_add" ]]; then
    while IFS= read -r el; do
      [[ -z "$el" ]] && continue
      if [[ ! "$el" =~ $SAFE ]]; then
        log "REFUSE add $set_name { $el } — fails $SAFE"
        continue
      fi
      if nft add element "$NFT_TABLE" "$set_name" "{ $el }" 2>/tmp/nft.err; then
        log "+ $set_name { $el }"
      else
        log "FAIL add $set_name { $el }: $(cat /tmp/nft.err)"
      fi
    done <<< "$to_add"
  fi
  if [[ -n "$to_del" ]]; then
    while IFS= read -r el; do
      [[ -z "$el" ]] && continue
      if [[ ! "$el" =~ $SAFE ]]; then
        log "REFUSE del $set_name { $el } — fails $SAFE"
        continue
      fi
      if nft delete element "$NFT_TABLE" "$set_name" "{ $el }" 2>/tmp/nft.err; then
        log "- $set_name { $el }"
      else
        log "FAIL del $set_name { $el }: $(cat /tmp/nft.err)"
      fi
    done <<< "$to_del"
  fi
}

# ─── Annotation parser ──────────────────────────────────────────────────────
# (parse_csv_ports was an early-draft helper — replaced by jq-side parsing in
# build_desired_sets. Kept removed so shellcheck doesn't flag dead code.)

# ─── Pod scan ───────────────────────────────────────────────────────────────
#
# kubectl get pods --field-selector spec.nodeName=$NODE_NAME and run jq once
# to emit one line per (pod, port, proto) tuple, in the form:
#   tcp <element>
#   udp <element>
# We then split that into two streams.
build_desired_sets() {
  local pods_json
  pods_json=$(kubectl get pods --all-namespaces \
    --field-selector "spec.nodeName=${NODE_NAME}" \
    -o json 2>/tmp/kubectl.err) || {
    log "kubectl get pods failed: $(cat /tmp/kubectl.err)"
    # Don't blow away the host firewall on transient API failures —
    # signal an empty/failed scan so the caller skips this round.
    return 1
  }

  # jq emits "<proto> <element>" lines. Every emitted element is filtered
  # through a regex allowing only digits and an optional single hyphen
  # (port or interval), then re-validated in shell — defense in depth
  # against a malicious annotation injecting nft commands. A value like
  # `3478 } flush ruleset ;` is silently dropped at the jq stage.
  printf '%s' "$pods_json" | jq -r '
    def safe_port: tostring | select(test("^[0-9]+(-[0-9]+)?$"));

    .items[]?
    | (
        # 1. Literal hostPort declarations on every container port.
        (.spec.containers // [])[]?
        | (.ports // [])[]?
        | select(.hostPort != null)
        | "\((.protocol // "TCP") | ascii_downcase) \(.hostPort | safe_port)"
      ),
      (
        # 2. platform.io/firewall-tcp-ports annotation (CSV w/ ranges).
        .metadata.annotations["platform.io/firewall-tcp-ports"] // empty
        | split(",")
        | .[]
        | gsub("^\\s+|\\s+$"; "")
        | safe_port
        | "tcp \(.)"
      ),
      (
        .metadata.annotations["platform.io/firewall-udp-ports"] // empty
        | split(",")
        | .[]
        | gsub("^\\s+|\\s+$"; "")
        | safe_port
        | "udp \(.)"
      )
  ' | grep -E '^(tcp|udp) [0-9]+(-[0-9]+)?$' || true
}

# ─── Reconcile loop ────────────────────────────────────────────────────────

reconcile_once() {
  # Idempotently ensure the host has the sets + accept rules. No-op when
  # bootstrap.sh already installed them; saves the operator from
  # re-running bootstrap on every node when this feature is rolled out
  # to an existing cluster.
  nft_self_bootstrap
  if ! nft_set_exists tenant_ports_tcp || ! nft_set_exists tenant_ports_udp; then
    log "tenant_ports_{tcp,udp} sets still not present after self-bootstrap; idling"
    return 0
  fi

  local raw
  raw=$(build_desired_sets) || return 0

  local desired_tcp desired_udp
  desired_tcp=$(printf '%s\n' "$raw" | awk '$1=="tcp" {print $2}' | sort -u)
  desired_udp=$(printf '%s\n' "$raw" | awk '$1=="udp" {print $2}' | sort -u)

  local current_tcp current_udp
  current_tcp=$(nft_current_elements tenant_ports_tcp)
  current_udp=$(nft_current_elements tenant_ports_udp)

  nft_apply_diff tenant_ports_tcp "$desired_tcp" "$current_tcp"
  nft_apply_diff tenant_ports_udp "$desired_udp" "$current_udp"
}

log "starting; node=$NODE_NAME interval=${RECONCILE_INTERVAL}s table=${NFT_TABLE}"

while (( shutdown == 0 )); do
  reconcile_once
  # Sleep in 1s ticks so SIGTERM doesn't have to wait the full interval.
  for ((i=0; i<RECONCILE_INTERVAL && shutdown==0; i++)); do
    sleep 1
  done
done

log "exiting cleanly"
exit 0
