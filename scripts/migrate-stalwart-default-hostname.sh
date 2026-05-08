#!/usr/bin/env bash
#
# migrate-stalwart-default-hostname.sh
#
# One-shot migration to populate Stalwart's SystemSettings.defaultHostname
# on an already-bootstrapped cluster. Idempotent — re-runs are no-ops if
# the value is already correct.
#
# Why this matters:
#   Without SystemSettings.defaultHostname set, Stalwart's SMTP/IMAP/
#   POP3/JMAP/CalDAV/CardDAV/WebDAV listener banners fall back to the
#   pod's gethostname() — which K8s sets to the pod name (e.g.
#   "stalwart-mail-57f954f7bc-vr2lc"). External receivers do FCrDNS /
#   EHLO-vs-PTR / EHLO-vs-cert checks against that and either reject
#   delivery outright or score it as spam.
#
#   Setting defaultHostname to mail.${DOMAIN} (matching the cert SAN
#   + MX target + DNS PTR) makes every replica announce the canonical
#   FQDN regardless of which pod is serving the connection.
#
# Why a separate script (not just bootstrap-plan):
#   1. SystemSettings is a singleton — its `defaultDomainId` field is
#      a JMAP entity reference, not a slug. The bootstrap-plan
#      template uses ${STALWART_DOMAIN_ID} (slug form) which works
#      for DkimSignature.domainId but not necessarily for the
#      singleton's required defaultDomainId. This script queries the
#      live Domain table by name to discover the actual JMAP ID.
#   2. Already-bootstrapped clusters never re-run the bootstrap-plan,
#      so manifest-only changes don't propagate to existing installs.
#
# Prerequisites:
#   - Stalwart pod is Ready
#   - stalwart-admin-creds Secret exists in mail namespace
#   - The platform's primary mail Domain is already created in
#     Stalwart's database (it's created by the original bootstrap
#     plan's Bootstrap.update with defaultDomain=...)
#
# Usage:
#   ./scripts/migrate-stalwart-default-hostname.sh
#   ./scripts/migrate-stalwart-default-hostname.sh --hostname mail.example.com
#   ./scripts/migrate-stalwart-default-hostname.sh --domain example.com

set -euo pipefail

NAMESPACE="mail"
HOSTNAME=""
PLATFORM_DOMAIN=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --namespace) NAMESPACE="$2"; shift 2 ;;
    --hostname)  HOSTNAME="$2"; shift 2 ;;
    --domain)    PLATFORM_DOMAIN="$2"; shift 2 ;;
    -h|--help)   sed -n '2,40p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

: "${KUBECTL:=kubectl}"

err() { printf 'ERROR: %s\n' "$*" >&2; exit 1; }
log() { printf '[migrate-stalwart-hostname] %s\n' "$*"; }

# ── Discover the canonical mail hostname ────────────────────────────
# Priority: --hostname flag > --domain flag (mail.<domain>) > Stalwart's
# existing Bootstrap.serverHostname (read via the admin API).
discover_hostname() {
  if [[ -n "$HOSTNAME" ]]; then return 0; fi
  if [[ -n "$PLATFORM_DOMAIN" ]]; then
    HOSTNAME="mail.${PLATFORM_DOMAIN}"
    log "Derived hostname from --domain: $HOSTNAME"
    return 0
  fi
  # Fallback: query the live Stalwart instance for its existing
  # Bootstrap.serverHostname (set by the original install).
  local pw svc_ip
  pw=$($KUBECTL -n "$NAMESPACE" get secret stalwart-admin-creds \
    -o jsonpath='{.data.recoveryPassword}' 2>/dev/null | base64 -d) \
    || err "stalwart-admin-creds.recoveryPassword unreadable"
  svc_ip=$($KUBECTL -n "$NAMESPACE" get svc stalwart-mgmt -o jsonpath='{.spec.clusterIP}' 2>/dev/null) \
    || err "stalwart-mgmt service not found"
  [[ -n "$svc_ip" ]] || err "stalwart-mgmt has no ClusterIP"

  # Query the Bootstrap singleton for serverHostname. Some Stalwart
  # versions clear the Bootstrap row post-install — fall back to
  # the certificate's first SAN if so.
  local bootstrap_hn
  bootstrap_hn=$(jmap_call "$svc_ip" "$pw" '[
    ["x:Bootstrap/get",{"ids":["singleton"],"properties":["serverHostname"]},"a"]
  ]' | python3 -c '
import sys, json
try:
  d = json.load(sys.stdin)
  rows = d["methodResponses"][0][1]["list"]
  print(rows[0]["serverHostname"] if rows else "")
except Exception:
  pass
')
  if [[ -n "$bootstrap_hn" ]]; then
    HOSTNAME="$bootstrap_hn"
    log "Discovered hostname from live Bootstrap.serverHostname: $HOSTNAME"
    return 0
  fi

  # Last resort: read from the cert's first SAN.
  local cert_san
  cert_san=$(jmap_call "$svc_ip" "$pw" '[
    ["x:Certificate/query",{},"q"]
  ]' | python3 -c '
import sys, json
try:
  d = json.load(sys.stdin)
  ids = d["methodResponses"][0][1]["ids"]
  print(ids[0] if ids else "")
except Exception:
  pass
')
  [[ -n "$cert_san" ]] || err "could not auto-discover hostname; pass --hostname or --domain"
  HOSTNAME=$(jmap_call "$svc_ip" "$pw" "[
    [\"x:Certificate/get\",{\"ids\":[\"$cert_san\"],\"properties\":[\"subjectAlternativeNames\"]},\"g\"]
  ]" | python3 -c '
import sys, json
try:
  d = json.load(sys.stdin)
  sans = d["methodResponses"][0][1]["list"][0]["subjectAlternativeNames"]
  print(next(iter(sans)))
except Exception:
  pass
')
  [[ -n "$HOSTNAME" ]] || err "could not auto-discover hostname; pass --hostname"
  log "Discovered hostname from cert SAN: $HOSTNAME"
}

# ── JMAP wrapper ────────────────────────────────────────────────────
# $1 = mgmt service IP, $2 = admin password, $3 = methodCalls JSON array
jmap_call() {
  local svc_ip="$1" pw="$2" calls="$3"
  curl -s --max-time 10 -u "admin:$pw" \
    -X POST "http://${svc_ip}:8080/jmap" \
    -H 'Content-Type: application/json' \
    -d "{\"using\":[\"urn:ietf:params:jmap:core\",\"urn:stalwart:jmap\"],\"methodCalls\":${calls}}"
}

# ── Run ─────────────────────────────────────────────────────────────
$KUBECTL -n "$NAMESPACE" get deploy stalwart-mail >/dev/null 2>&1 \
  || err "Stalwart deployment not found in namespace $NAMESPACE"

discover_hostname

PW=$($KUBECTL -n "$NAMESPACE" get secret stalwart-admin-creds \
  -o jsonpath='{.data.recoveryPassword}' | base64 -d)
SVC_IP=$($KUBECTL -n "$NAMESPACE" get svc stalwart-mgmt -o jsonpath='{.spec.clusterIP}')
[[ -n "$PW" && -n "$SVC_IP" ]] || err "could not read recovery password or mgmt service IP"

# Look up the platform's primary Domain by name. Stalwart's
# Bootstrap.defaultDomain field stores the name (e.g. example.com);
# the JMAP entity ID for that Domain is what defaultDomainId requires.
DOMAIN_NAME="${HOSTNAME#mail.}"
log "Looking up Domain row for: $DOMAIN_NAME"

DOMAIN_LIST=$(jmap_call "$SVC_IP" "$PW" '[
  ["x:Domain/query",{},"q"]
]')
DOMAIN_IDS=$(printf '%s' "$DOMAIN_LIST" | python3 -c '
import sys, json
print(" ".join(json.load(sys.stdin)["methodResponses"][0][1]["ids"]))
')
[[ -n "$DOMAIN_IDS" ]] || err "no Domain rows found in Stalwart"

# Get the (id, name) pairs and find the one matching our domain.
ID_LIST_JSON=$(printf '%s' "$DOMAIN_IDS" | python3 -c '
import sys, json
print(json.dumps(sys.stdin.read().split()))
')
DOMAIN_DETAILS=$(jmap_call "$SVC_IP" "$PW" "[
  [\"x:Domain/get\",{\"ids\":${ID_LIST_JSON},\"properties\":[\"id\",\"name\"]},\"g\"]
]")
DOMAIN_ID=$(printf '%s' "$DOMAIN_DETAILS" | python3 -c "
import sys, json
target = '$DOMAIN_NAME'
for d in json.load(sys.stdin)['methodResponses'][0][1]['list']:
    if d['name'] == target:
        print(d['id'])
        sys.exit(0)
")
[[ -n "$DOMAIN_ID" ]] || err "no Domain row matches name '$DOMAIN_NAME' — pass --domain explicitly"
log "Resolved Domain '$DOMAIN_NAME' → JMAP id '$DOMAIN_ID'"

# Idempotency: read current SystemSettings, skip if already correct.
CURRENT=$(jmap_call "$SVC_IP" "$PW" '[
  ["x:SystemSettings/get",{"ids":["singleton"],"properties":["defaultHostname","defaultDomainId"]},"g"]
]' | python3 -c '
import sys, json
d = json.load(sys.stdin)["methodResponses"][0][1]["list"][0]
print(d.get("defaultHostname",""), d.get("defaultDomainId",""))
')
read -r CUR_HN CUR_DOM <<< "$CURRENT"
log "Current SystemSettings: defaultHostname='$CUR_HN' defaultDomainId='$CUR_DOM'"

if [[ "$CUR_HN" == "$HOSTNAME" && "$CUR_DOM" == "$DOMAIN_ID" ]]; then
  log "Already correct — no change."
  exit 0
fi

log "Applying defaultHostname='$HOSTNAME' defaultDomainId='$DOMAIN_ID'..."
RESULT=$(jmap_call "$SVC_IP" "$PW" "[
  [\"x:SystemSettings/set\",{\"update\":{\"singleton\":{\"defaultHostname\":\"$HOSTNAME\",\"defaultDomainId\":\"$DOMAIN_ID\"}}},\"set\"]
]")
if printf '%s' "$RESULT" | grep -q '"updated":'; then
  log "SystemSettings updated."
else
  err "JMAP set failed: $RESULT"
fi

log
log "Roll the Stalwart pods so they re-read SystemSettings on startup:"
log "  kubectl -n $NAMESPACE rollout restart deploy stalwart-mail"
log
log "Verify with:"
log "  echo | openssl s_client -connect <node-ip>:465 -servername $HOSTNAME 2>/dev/null \\"
log "    | grep -E '^220 ' | head -1"
log "  # expect: 220 $HOSTNAME Stalwart ESMTP at your service"
