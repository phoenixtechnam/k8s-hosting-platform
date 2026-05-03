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
# Usage:
#   bash scripts/stalwart-016-spike.sh up           # start fresh
#   bash scripts/stalwart-016-spike.sh logs         # tail logs
#   bash scripts/stalwart-016-spike.sh shell        # exec into pod
#   bash scripts/stalwart-016-spike.sh apply <plan.json>   # stalwart-cli apply
#   bash scripts/stalwart-016-spike.sh down         # destroy
#
# Bootstrap flow (per Stalwart 0.16 upgrade guide):
#   1. Start with STALWART_RECOVERY_MODE=1 + RECOVERY_ADMIN env
#   2. Container comes up listening on :8080 (management only)
#   3. Apply a baseline plan via stalwart-cli that defines listeners +
#      domain + admin account (everything except the datastore which is
#      in config.json)
#   4. Restart without RECOVERY_MODE — Stalwart now reads JMAP-stored
#      config and listens on full port set (25/465/587/143/993/8080/443)

set -euo pipefail

DOCKER_HOST="${DOCKER_HOST:-tcp://dind:2375}"
export DOCKER_HOST

CONTAINER="stalwart-spike"
IMAGE="docker.io/stalwartlabs/stalwart:v0.16.3"
SPIKE_DIR="/tmp/stalwart-spike"
ADMIN_USER="admin"
ADMIN_PASS="spike-admin-pw-1"

cmd="${1:-up}"

case "$cmd" in
  up)
    docker rm -f "$CONTAINER" 2>/dev/null || true

    # Minimal config.json — RocksDB on a host-mounted volume. The data,
    # blob, search, and in-memory stores all share the rocks store.
    # Per the 0.16 upgrade guide this is "small, because it describes
    # only the datastore (data store, blob store, search store,
    # in-memory store)".
    mkdir -p "$SPIKE_DIR/etc" "$SPIKE_DIR/data"
    cat > "$SPIKE_DIR/etc/config.json" <<'JSON'
{
  "store": {
    "rocks": {
      "type": "rocksdb",
      "path": "/var/lib/stalwart/rocks",
      "compression": "lz4"
    }
  },
  "storage": {
    "data": "rocks",
    "blob": "rocks",
    "fts": "rocks",
    "lookup": "rocks"
  }
}
JSON

    docker run -d \
      --name "$CONTAINER" \
      --restart unless-stopped \
      -e STALWART_RECOVERY_MODE=1 \
      -e "STALWART_RECOVERY_ADMIN=${ADMIN_USER}:${ADMIN_PASS}" \
      -p 8080:8080 \
      -p 25:25 -p 465:465 -p 587:587 \
      -p 143:143 -p 993:993 \
      -p 4190:4190 \
      -v "$SPIKE_DIR/etc:/etc/stalwart" \
      -v "$SPIKE_DIR/data:/var/lib/stalwart" \
      "$IMAGE"

    echo "Stalwart 0.16 starting in recovery mode."
    echo "  Management UI:    http://dind.local:8080"
    echo "  Admin user:       $ADMIN_USER"
    echo "  Admin password:   $ADMIN_PASS"
    echo
    echo "Wait ~10s, then probe:"
    echo "  curl -u admin:$ADMIN_PASS http://dind.local:8080/jmap/session | jq"
    ;;

  logs)
    docker logs -f "$CONTAINER"
    ;;

  shell)
    docker exec -it "$CONTAINER" sh
    ;;

  apply)
    plan="${2:?usage: $0 apply <plan.json>}"
    if [[ ! -f "$plan" ]]; then
      echo "ERROR: plan file not found: $plan" >&2
      exit 2
    fi
    docker cp "$plan" "$CONTAINER:/tmp/plan.json"
    docker exec "$CONTAINER" stalwart-cli \
      --url http://127.0.0.1:8080 \
      --credentials "$ADMIN_USER:$ADMIN_PASS" \
      apply /tmp/plan.json
    ;;

  down)
    docker rm -f "$CONTAINER" 2>/dev/null || true
    rm -rf "$SPIKE_DIR"
    echo "spike destroyed"
    ;;

  *)
    echo "usage: $0 {up|logs|shell|apply <plan.json>|down}" >&2
    exit 2
    ;;
esac
