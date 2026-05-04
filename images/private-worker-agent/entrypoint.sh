#!/usr/bin/env bash
#
# private-worker-agent entrypoint
# -------------------------------
# Decode the base64url JSON blob in $PRIVATE_WORKER_TOKEN, render an
# frpc.toml at /tmp/frpc.toml, and exec frpc as PID 1 (under tini).
#
# Stateless by design: nothing is written outside /tmp. Restart-safe.
#
# Token blob (base64url-encoded JSON):
#   {
#     "v": 1,
#     "slug": "bobs-slug",
#     "server_url": "wss://tunnels.example.com/c/bobs-slug/",
#     "secret": "pwt_<32-bytes-base64url>",
#     "expose": [
#       { "name": "web", "local": "127.0.0.1:8080", "remote_port": 8080 }
#     ]
#   }
#
# frp v0.62.x has no client-side WebSocket-path config — the client always
# dials /~!frp. The cluster-side NGINX rewrites /c/{slug}/ -> /~!frp; the
# slug from the token blob is therefore informational here (logged for
# operator clarity, not used in the rendered toml).

set -euo pipefail

LOG_LEVEL="${PRIVATE_WORKER_LOG_LEVEL:-info}"
CONFIG_PATH="${PRIVATE_WORKER_CONFIG_PATH:-/tmp/frpc.toml}"
ADMIN_PORT="${PRIVATE_WORKER_ADMIN_PORT:-7400}"

die() {
  printf 'private-worker-agent: %s\n' "$*" >&2
  exit 1
}

log() {
  printf 'private-worker-agent: %s\n' "$*"
}

# ---------------------------------------------------------------------------
# 1. Validate inputs
# ---------------------------------------------------------------------------
if [[ -z "${PRIVATE_WORKER_TOKEN:-}" ]]; then
  die 'PRIVATE_WORKER_TOKEN is not set. Pass it via -e PRIVATE_WORKER_TOKEN=... (see README).'
fi

# ---------------------------------------------------------------------------
# 2. base64url -> base64 -> JSON
#
# Tools may emit either base64url (-/_, no padding) or standard base64. We
# normalise to standard base64 with correct padding before decoding.
# ---------------------------------------------------------------------------
b64="${PRIVATE_WORKER_TOKEN}"
# Strip any whitespace/newlines that crept in via copy-paste.
b64="${b64//$'\n'/}"
b64="${b64//$'\r'/}"
b64="${b64//$'\t'/}"
b64="${b64// /}"
# base64url -> base64
b64="${b64//-/+}"
b64="${b64//_//}"
# Re-pad to a multiple of 4.
case $(( ${#b64} % 4 )) in
  0) ;;
  2) b64="${b64}==" ;;
  3) b64="${b64}=" ;;
  1) die 'PRIVATE_WORKER_TOKEN is not valid base64url (length % 4 == 1).' ;;
esac

if ! json="$(printf '%s' "${b64}" | base64 -d 2>/dev/null)"; then
  die 'PRIVATE_WORKER_TOKEN failed to base64-decode. Re-copy the token from the platform UI.'
fi

if ! printf '%s' "${json}" | jq -e . >/dev/null 2>&1; then
  die 'PRIVATE_WORKER_TOKEN decoded to invalid JSON. Re-copy the token from the platform UI.'
fi

# ---------------------------------------------------------------------------
# 3. Validate schema version + extract fields
# ---------------------------------------------------------------------------
v="$(printf '%s' "${json}" | jq -r '.v // empty')"
if [[ "${v}" != "1" ]]; then
  die "Unsupported token version v=${v:-<missing>}. This agent build supports v=1. Upgrade the agent image."
fi

slug="$(printf '%s' "${json}" | jq -r '.slug // empty')"
server_url="$(printf '%s' "${json}" | jq -r '.server_url // empty')"
secret="$(printf '%s' "${json}" | jq -r '.secret // empty')"

[[ -n "${slug}" ]]       || die 'Token blob missing required field "slug".'
[[ -n "${server_url}" ]] || die 'Token blob missing required field "server_url".'
[[ -n "${secret}" ]]     || die 'Token blob missing required field "secret".'

expose_count="$(printf '%s' "${json}" | jq -r '.expose | length')"
if [[ "${expose_count}" == "0" || "${expose_count}" == "null" ]]; then
  die 'Token blob "expose" array is empty. The platform should always mint at least one exposed proxy.'
fi

# ---------------------------------------------------------------------------
# 4. Parse server_url -> host + port + scheme
#
# Accept wss:// (TLS, default port 443) or ws:// (plaintext, default 80).
# We deliberately keep the path in the URL informational only — frp dials
# its hardcoded /~!frp path; the cluster-side NGINX does the rewrite.
# ---------------------------------------------------------------------------
scheme="${server_url%%://*}"
rest="${server_url#*://}"
hostport="${rest%%/*}"
host="${hostport%%:*}"
explicit_port="${hostport#*:}"
if [[ "${explicit_port}" == "${hostport}" ]]; then
  explicit_port=""
fi

case "${scheme}" in
  wss)  default_port=443; transport_protocol="wss"; tls_enable=true ;;
  ws)   default_port=80;  transport_protocol="websocket"; tls_enable=false ;;
  *)    die "Unsupported server_url scheme '${scheme}'. Expected ws:// or wss://." ;;
esac

server_port="${explicit_port:-${default_port}}"

if [[ -z "${host}" ]]; then
  die "Could not parse host from server_url='${server_url}'."
fi

# ---------------------------------------------------------------------------
# 5. Render frpc.toml
# ---------------------------------------------------------------------------
{
  printf 'serverAddr = "%s"\n' "${host}"
  printf 'serverPort = %s\n' "${server_port}"
  printf '\n'
  printf 'transport.protocol = "%s"\n' "${transport_protocol}"
  printf 'transport.tls.enable = %s\n' "${tls_enable}"
  # SNI = host (matches the cluster-issued tunnels.${DOMAIN} cert).
  if [[ "${tls_enable}" == "true" ]]; then
    printf 'transport.tls.serverName = "%s"\n' "${host}"
  fi
  printf 'loginFailExit = false\n'
  printf '\n'
  printf 'log.to = "console"\n'
  printf 'log.level = "%s"\n' "${LOG_LEVEL}"
  printf '\n'
  printf 'auth.method = "token"\n'
  printf 'auth.token = "%s"\n' "${secret}"
  printf '\n'
  printf 'webServer.addr = "127.0.0.1"\n'
  printf 'webServer.port = %s\n' "${ADMIN_PORT}"
  printf '\n'
} > "${CONFIG_PATH}"

# Append one [[proxies]] block per expose entry. Use jq's @sh to avoid
# any shell injection from operator-controlled fields (name, local).
while IFS=$'\t' read -r name local_addr remote_port; do
  local_ip="${local_addr%%:*}"
  local_port="${local_addr##*:}"
  if [[ -z "${local_ip}" || -z "${local_port}" || "${local_ip}" == "${local_addr}" ]]; then
    die "Invalid expose.local '${local_addr}' — expected host:port."
  fi
  {
    printf '[[proxies]]\n'
    printf 'name = "%s"\n' "${name}"
    printf 'type = "tcp"\n'
    printf 'localIP = "%s"\n' "${local_ip}"
    printf 'localPort = %s\n' "${local_port}"
    printf 'remotePort = %s\n' "${remote_port}"
    printf '\n'
  } >> "${CONFIG_PATH}"
done < <(printf '%s' "${json}" | jq -r '.expose[] | [.name, .local, .remote_port] | @tsv')

chmod 0600 "${CONFIG_PATH}" || true

# ---------------------------------------------------------------------------
# 6. Sanitised launch banner (NEVER log the token / secret)
# ---------------------------------------------------------------------------
log "starting agent"
log "  slug         = ${slug}"
log "  server       = ${scheme}://${host}:${server_port}"
log "  tls          = ${tls_enable}"
log "  log_level    = ${LOG_LEVEL}"
log "  config       = ${CONFIG_PATH}"
log "  admin (loop) = 127.0.0.1:${ADMIN_PORT}"
log "  exposing:"
printf '%s' "${json}" | jq -r '.expose[] | "    - \(.name): \(.local) -> remote :\(.remote_port)"'

# ---------------------------------------------------------------------------
# 7. Hand off to frpc as PID 1 (under tini, which is our actual PID 1)
# ---------------------------------------------------------------------------
exec /usr/local/bin/frpc -c "${CONFIG_PATH}"
