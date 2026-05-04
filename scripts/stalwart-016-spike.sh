#!/usr/bin/env bash
# Stalwart 0.16 spike harness — runs a Stalwart 0.16.3 instance in local
# DinD's Docker (NOT k3s) for raw experimentation with the new
# config.json + JMAP API model.
#
# Why direct Docker (not k8s manifests for the spike): faster iteration.
# We're learning the shape, not deploying production. Once we know what
# works we'll port the validated config to k8s manifests in
# k8s/base/stalwart-v016/.
#
# IMPORTANT 0.16 bootstrap facts (differs from 0.15):
#   - config.json stores ONLY the data-store backend (RocksDB or PG).
#     All server settings (listeners, domains, DKIM, etc) live in the DB.
#   - Start WITHOUT config.json → bootstrap mode (:8080 management only).
#   - STALWART_RECOVERY_ADMIN=user:pass provides admin credentials for both
#     bootstrap mode AND subsequent normal-mode starts (acts as override).
#   - Apply a Bootstrap plan to initialise the DB (creates admin account,
#     sets hostname, domain). The server writes config.json to the etc volume.
#   - stalwart-cli is a SEPARATE binary (github.com/stalwartlabs/cli).
#     It is NOT bundled in the Docker image. We download it and inject it.
#   - stalwart-cli needs HOME to be a writable dir (schema cache). Use HOME=/tmp.
#   - Volumes must be named Docker volumes (DinD's /tmp ≠ workspace /tmp).
#
# Source-IP / egress-IP model (Milestone 1 finding):
#   - ClusterRole controls WHICH tasks/listeners run on a node (routing).
#   - "outboundMta" is a ClusterTaskType — disabling it on a node stops that
#     node from processing the outbound queue. It is NOT an IP-pinning mechanism.
#   - Source IP for outbound SMTP is configured via MtaConnectionStrategy.sourceIps
#     (list of {sourceIp, ehloHostname} objects). This is static config, not
#     per-node dynamic selection.
#   - To pin egress to a specific IP per node you need Calico EgressGateway or
#     hostNetwork-relay on the pod that holds Stalwart's outbound MTA task.
#     OR: use MtaOutboundStrategy.connection expression that evaluates
#     system('node_role') or system('node_hostname') to select a named
#     MtaConnectionStrategy per node (available since 0.16.1).
#
# Usage:
#   DOCKER_HOST=tcp://dind:2375 bash scripts/stalwart-016-spike.sh up
#   DOCKER_HOST=tcp://dind:2375 bash scripts/stalwart-016-spike.sh up-pg
#   DOCKER_HOST=tcp://dind:2375 bash scripts/stalwart-016-spike.sh logs
#   DOCKER_HOST=tcp://dind:2375 bash scripts/stalwart-016-spike.sh shell
#   DOCKER_HOST=tcp://dind:2375 bash scripts/stalwart-016-spike.sh apply <plan.json>
#   DOCKER_HOST=tcp://dind:2375 bash scripts/stalwart-016-spike.sh snapshot <type> [outfile]
#   DOCKER_HOST=tcp://dind:2375 bash scripts/stalwart-016-spike.sh cli <args...>
#   DOCKER_HOST=tcp://dind:2375 bash scripts/stalwart-016-spike.sh down

set -euo pipefail

DOCKER_HOST="${DOCKER_HOST:-tcp://dind:2375}"
export DOCKER_HOST

CONTAINER="stalwart-spike"
PG_CONTAINER="stalwart-spike-pg"
IMAGE="docker.io/stalwartlabs/stalwart:v0.16.3"
# shellcheck disable=SC2034 # CLI_IMAGE retained for future spike steps
# that exec the cli inside a separate container; current spike uses the
# pre-built stalwart-cli binary downloaded from GitHub releases (CLI_URL).
CLI_IMAGE="docker.io/stalwartlabs/stalwart:v0.16.3"
CLI_VERSION="v1.0.4"
CLI_URL="https://github.com/stalwartlabs/cli/releases/download/${CLI_VERSION}/stalwart-cli-x86_64-unknown-linux-musl.tar.xz"
# SHA256 of the tar.xz tarball, pinned 2026-05-03 from GitHub release.
# Update when bumping CLI_VERSION. The verify step in ensure_cli aborts
# if the download doesn't match — protects against a poisoned cache or
# a tampered upstream release.
CLI_SHA256="01c734752cc44b9e24f753cbacfc2d489dadaaccf72cd229ecb7269e85e0eefa"
CLI_CACHE="/tmp/stalwart-cli-cache"

ADMIN_USER="admin"
ADMIN_PASS="spike-admin-pw-1"

# PostgreSQL settings for up-pg mode
PG_PASSWORD="stalwart_spike_pg_pw"
PG_DB="stalwart_app"
PG_USER="stalwart_app"
PG_NETWORK="stalwart-spike-net"

cmd="${1:-up}"

# ── helpers ──────────────────────────────────────────────────────────────────

ensure_cli() {
  if [[ -f "$CLI_CACHE/stalwart-cli" ]]; then return; fi
  echo "Downloading stalwart-cli ${CLI_VERSION}..."
  mkdir -p "$CLI_CACHE"
  local tmp_tar="$CLI_CACHE/stalwart-cli.tar.xz"
  curl -fsSL "$CLI_URL" -o "$tmp_tar"
  # SHA256 verification — refuses to install a tampered binary even
  # against a poisoned cache. The binary runs inside the spike container
  # with admin credentials so trust is not optional.
  local actual; actual=$(sha256sum "$tmp_tar" | awk '{print $1}')
  if [[ "$actual" != "$CLI_SHA256" ]]; then
    echo "ERROR: stalwart-cli SHA256 mismatch" >&2
    echo "  expected: $CLI_SHA256" >&2
    echo "  actual:   $actual" >&2
    rm -f "$tmp_tar"
    exit 3
  fi
  tar xJf "$tmp_tar" -C "$CLI_CACHE" --strip-components=1
  chmod +x "$CLI_CACHE/stalwart-cli"
  rm -f "$tmp_tar"
  echo "stalwart-cli ready at $CLI_CACHE/stalwart-cli (sha256 verified)"
}

inject_cli() {
  ensure_cli
  docker cp "$CLI_CACHE/stalwart-cli" "${CONTAINER}:/tmp/stalwart-cli"
}

wait_healthy() {
  local max=30
  for i in $(seq 1 $max); do
    if docker exec "${CONTAINER}" curl -sf "http://127.0.0.1:8080/healthz/live" >/dev/null 2>&1; then
      echo "Stalwart is healthy (${i}s)"
      return 0
    fi
    printf '.'
    sleep 1
  done
  echo ""
  echo "ERROR: Stalwart did not become healthy in ${max}s" >&2
  docker logs "${CONTAINER}" 2>&1 | tail -20 >&2
  return 1
}

bootstrap_init() {
  # Apply the minimal Bootstrap singleton to initialise the DB.
  # The update MUST produce at least one change (otherwise Stalwart does not
  # write config.json). We force a change by setting serverHostname to a
  # known value — the container's default is its short container ID so any
  # explicit value will differ.
  # After the apply, restart without STALWART_RECOVERY_ADMIN so the server
  # reads config.json and starts in full mode.
  inject_cli
  printf '%s\n' \
    '{"@type":"update","object":"Bootstrap","value":{"serverHostname":"spike.localhost","defaultDomain":"spike.test","generateDkimKeys":false,"requestTlsCertificate":false,"dataStore":{"@type":"RocksDb","path":"/var/lib/stalwart/"}}}' \
    | docker exec -i "${CONTAINER}" sh -c "cat > /tmp/bootstrap-init.ndjson"
  docker exec -e HOME=/tmp "${CONTAINER}" \
    /tmp/stalwart-cli \
    --url http://127.0.0.1:8080 \
    --user "${ADMIN_USER}" \
    --password "${ADMIN_PASS}" \
    apply --file /tmp/bootstrap-init.ndjson
  echo "Bootstrap applied. Restarting to full mode..."
  docker restart "${CONTAINER}"
  sleep 5
  wait_healthy
}

bootstrap_init_pg() {
  inject_cli
  # Get PG container IP on the spike network
  local pg_ip
  pg_ip=$(docker inspect "${PG_CONTAINER}" \
    --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' \
    | head -1)
  echo "PostgreSQL IP: ${pg_ip}"

  printf '%s\n' \
    "{\"@type\":\"update\",\"object\":\"Bootstrap\",\"value\":{\"serverHostname\":\"spike.localhost\",\"defaultDomain\":\"spike.test\",\"generateDkimKeys\":false,\"requestTlsCertificate\":false,\"dataStore\":{\"@type\":\"PostgreSql\",\"host\":\"${pg_ip}\",\"port\":5432,\"database\":\"${PG_DB}\",\"authUsername\":\"${PG_USER}\",\"authSecret\":{\"@type\":\"Value\",\"secret\":\"${PG_PASSWORD}\"},\"useTls\":false,\"allowInvalidCerts\":false,\"poolMaxConnections\":10}}}" \
    | docker exec -i "${CONTAINER}" sh -c "cat > /tmp/bootstrap-init-pg.ndjson"
  docker exec -e HOME=/tmp "${CONTAINER}" \
    /tmp/stalwart-cli \
    --url http://127.0.0.1:8080 \
    --user "${ADMIN_USER}" \
    --password "${ADMIN_PASS}" \
    apply --file /tmp/bootstrap-init-pg.ndjson
  echo "Bootstrap (PG) applied. Restarting to full mode..."
  docker restart "${CONTAINER}"
  sleep 5
  wait_healthy
}

print_urls() {
  local backend="${1:-RocksDB}"
  echo ""
  echo "Stalwart 0.16 spike running (${backend} backend)."
  echo "  JMAP API:       http://dind.local:8081/jmap/session"
  echo "  Admin user:     ${ADMIN_USER}"
  echo "  Admin password: ${ADMIN_PASS}"
  echo ""
  echo "Test with:"
  echo "  docker exec -e HOME=/tmp ${CONTAINER} /tmp/stalwart-cli \\"
  echo "    --url http://127.0.0.1:8080 --user ${ADMIN_USER} --password ${ADMIN_PASS} \\"
  echo "    describe"
}

# ── commands ──────────────────────────────────────────────────────────────────

case "$cmd" in

  # ── RocksDB-backed spike ──────────────────────────────────────────────────
  up)
    docker rm -f "${CONTAINER}" 2>/dev/null || true
    docker volume rm stalwart-spike-etc stalwart-spike-data 2>/dev/null || true
    docker volume create stalwart-spike-etc
    docker volume create stalwart-spike-data

    # Fix data dir permissions (stalwart runs as uid 2000 in the image)
    docker run --rm \
      -v stalwart-spike-data:/var/lib/stalwart \
      alpine:latest \
      sh -c 'mkdir -p /var/lib/stalwart && chown -R 2000:2000 /var/lib/stalwart'

    docker run -d \
      --name "${CONTAINER}" \
      --restart unless-stopped \
      -e "STALWART_RECOVERY_ADMIN=${ADMIN_USER}:${ADMIN_PASS}" \
      -p 8081:8080 \
      -p 3025:25 -p 3465:465 -p 3587:587 \
      -p 3143:143 -p 3993:993 \
      -v stalwart-spike-etc:/etc/stalwart \
      -v stalwart-spike-data:/var/lib/stalwart \
      "${IMAGE}"

    echo "Waiting for bootstrap mode..."
    sleep 8

    bootstrap_init
    inject_cli  # reinject after restart
    print_urls "RocksDB"
    ;;

  # ── PostgreSQL-backed spike ───────────────────────────────────────────────
  up-pg)
    # Tear down any existing
    docker rm -f "${CONTAINER}" "${PG_CONTAINER}" 2>/dev/null || true
    docker volume rm stalwart-spike-etc stalwart-spike-pg-data 2>/dev/null || true
    docker network rm "${PG_NETWORK}" 2>/dev/null || true

    # Create isolated network
    docker network create "${PG_NETWORK}"

    # Create volumes
    docker volume create stalwart-spike-etc
    docker volume create stalwart-spike-pg-data

    # Start PostgreSQL
    echo "Starting PostgreSQL..."
    docker run -d \
      --name "${PG_CONTAINER}" \
      --network "${PG_NETWORK}" \
      -e "POSTGRES_DB=${PG_DB}" \
      -e "POSTGRES_USER=${PG_USER}" \
      -e "POSTGRES_PASSWORD=${PG_PASSWORD}" \
      -v stalwart-spike-pg-data:/var/lib/postgresql/data \
      postgres:16-alpine \
      postgres \
        -c "statement_timeout=30000" \
        -c "lock_timeout=10000" \
        -c "max_connections=50"

    # Wait for PG to be ready
    echo "Waiting for PostgreSQL..."
    for i in $(seq 1 30); do
      if docker exec "${PG_CONTAINER}" pg_isready -q; then
        echo "PostgreSQL ready (${i}s)"
        break
      fi
      printf '.'
      sleep 1
    done

    # Apply connection limits to the role
    docker exec "${PG_CONTAINER}" psql -U "${PG_USER}" -d "${PG_DB}" \
      -c "ALTER ROLE ${PG_USER} CONNECTION LIMIT 20;" || true

    # Start Stalwart in bootstrap mode
    docker run -d \
      --name "${CONTAINER}" \
      --network "${PG_NETWORK}" \
      --restart unless-stopped \
      -e "STALWART_RECOVERY_ADMIN=${ADMIN_USER}:${ADMIN_PASS}" \
      -p 8081:8080 \
      -p 3025:25 -p 3465:465 -p 3587:587 \
      -p 3143:143 -p 3993:993 \
      -v stalwart-spike-etc:/etc/stalwart \
      "${IMAGE}"

    echo "Waiting for bootstrap mode..."
    sleep 10

    bootstrap_init_pg
    inject_cli
    print_urls "PostgreSQL"

    echo ""
    echo "Inspect schema in PostgreSQL:"
    echo "  docker exec ${PG_CONTAINER} psql -U ${PG_USER} -d ${PG_DB} -c '\\dt'"
    ;;

  # ── operational commands ──────────────────────────────────────────────────
  logs)
    docker logs -f "${CONTAINER}"
    ;;

  shell)
    docker exec -it "${CONTAINER}" sh
    ;;

  apply)
    plan="${2:?usage: $0 apply <plan.json>}"
    if [[ ! -f "$plan" ]]; then
      echo "ERROR: plan file not found: $plan" >&2
      exit 2
    fi
    inject_cli
    docker cp "$plan" "${CONTAINER}:/tmp/plan.json"
    docker exec -e HOME=/tmp "${CONTAINER}" \
      /tmp/stalwart-cli \
      --url http://127.0.0.1:8080 \
      --user "${ADMIN_USER}" \
      --password "${ADMIN_PASS}" \
      apply --file /tmp/plan.json
    ;;

  snapshot)
    obj_type="${2:?usage: $0 snapshot <ObjectType> [outfile]}"
    outfile="${3:-}"
    inject_cli
    if [[ -n "$outfile" ]]; then
      docker exec -e HOME=/tmp "${CONTAINER}" \
        /tmp/stalwart-cli \
        --url http://127.0.0.1:8080 \
        --user "${ADMIN_USER}" \
        --password "${ADMIN_PASS}" \
        snapshot "${obj_type}" --allow-unresolved Tenant \
        > "$outfile"
      echo "Snapshot written to $outfile"
    else
      docker exec -e HOME=/tmp "${CONTAINER}" \
        /tmp/stalwart-cli \
        --url http://127.0.0.1:8080 \
        --user "${ADMIN_USER}" \
        --password "${ADMIN_PASS}" \
        snapshot "${obj_type}" --allow-unresolved Tenant
    fi
    ;;

  cli)
    shift
    inject_cli
    docker exec -e HOME=/tmp "${CONTAINER}" \
      /tmp/stalwart-cli \
      --url http://127.0.0.1:8080 \
      --user "${ADMIN_USER}" \
      --password "${ADMIN_PASS}" \
      "$@"
    ;;

  down)
    docker rm -f "${CONTAINER}" "${PG_CONTAINER}" 2>/dev/null || true
    docker network rm "${PG_NETWORK}" 2>/dev/null || true
    docker volume rm stalwart-spike-etc stalwart-spike-data stalwart-spike-pg-data 2>/dev/null || true
    rm -rf "${CLI_CACHE}"
    echo "Spike destroyed."
    ;;

  *)
    cat >&2 <<'USAGE'
usage: bash scripts/stalwart-016-spike.sh <command>

Commands:
  up                        Start spike with RocksDB backend
  up-pg                     Start spike with PostgreSQL backend
  logs                      Tail container logs
  shell                     Open shell in spike container
  apply <plan.json>         Apply a stalwart-cli plan
  snapshot <Type> [out]     Snapshot object type(s) to NDJSON
  cli <args...>             Run arbitrary stalwart-cli command
  down                      Destroy all spike containers and volumes
USAGE
    exit 2
    ;;
esac
