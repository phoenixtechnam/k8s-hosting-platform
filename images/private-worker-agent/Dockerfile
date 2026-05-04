# syntax=docker/dockerfile:1.7
#
# private-worker-agent
# --------------------
# Single-container home-side agent for the platform "private worker" feature.
# Decodes a base64url JSON token from $PRIVATE_WORKER_TOKEN, renders an
# frpc.toml, and execs frpc to dial a per-client tunnel into the cluster
# over outbound HTTPS/WSS. No persistent volumes; restart-safe.
#
# Pinned to frp v0.62.1 with verified SHA-256 sums from the upstream
# checksums file:
#   https://github.com/fatedier/frp/releases/download/v0.62.1/frp_sha256_checksums.txt
# Bump FRP_VERSION + matching SHA-256s together when upgrading.

ARG ALPINE_VERSION=3.20

FROM alpine:${ALPINE_VERSION} AS frpc-fetch

ARG TARGETARCH
ARG FRP_VERSION=0.62.1
ARG FRP_SHA256_AMD64=dcf1c62e5862543b6686a8e4c2f430ef636ac33306167f377e7272875020c4d3
ARG FRP_SHA256_ARM64=94c98c19ce181f8e09e0d0cb79c278c31e9ec936eb713826a1ddf4995e7c2155

RUN apk add --no-cache ca-certificates curl tar coreutils

# Resolve the per-arch tarball + expected sha256, download, verify, extract.
# Fail fast if TARGETARCH is unsupported.
RUN set -eu; \
    case "${TARGETARCH}" in \
      amd64) FRP_ARCH=amd64; FRP_SHA256="${FRP_SHA256_AMD64}";; \
      arm64) FRP_ARCH=arm64; FRP_SHA256="${FRP_SHA256_ARM64}";; \
      *) echo "unsupported TARGETARCH=${TARGETARCH}" >&2; exit 1;; \
    esac; \
    TARBALL="frp_${FRP_VERSION}_linux_${FRP_ARCH}.tar.gz"; \
    URL="https://github.com/fatedier/frp/releases/download/v${FRP_VERSION}/${TARBALL}"; \
    echo "Downloading ${URL}"; \
    curl -fsSL --retry 3 --retry-delay 2 -o "/tmp/${TARBALL}" "${URL}"; \
    echo "${FRP_SHA256}  /tmp/${TARBALL}" | sha256sum -c -; \
    mkdir -p /tmp/frp; \
    tar -xzf "/tmp/${TARBALL}" -C /tmp/frp --strip-components=1; \
    install -m 0755 /tmp/frp/frpc /usr/local/bin/frpc; \
    /usr/local/bin/frpc --version

# ---------------------------------------------------------------------------
# Runtime image
# ---------------------------------------------------------------------------
FROM alpine:${ALPINE_VERSION}

# bash         - entrypoint shell (uses set -euo pipefail, arrays)
# coreutils    - GNU base64 (Alpine's busybox base64 lacks reliable padding handling)
# ca-certificates - validate platform TLS cert
# tini         - PID 1 / signal forwarding so SIGTERM reaches frpc cleanly
# jq           - safe JSON parsing (no shell-eval of token blob)
# curl         - optional, useful for in-container debugging (small)
RUN apk add --no-cache \
      bash \
      coreutils \
      ca-certificates \
      tini \
      jq \
      curl \
 && addgroup -S -g 1000 pwagent \
 && adduser -S -u 1000 -G pwagent -h /home/pwagent -s /bin/bash pwagent

COPY --from=frpc-fetch /usr/local/bin/frpc /usr/local/bin/frpc
COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod 0755 /usr/local/bin/frpc /usr/local/bin/entrypoint.sh

# Writable tmpfs for rendered frpc.toml. /tmp is world-writable in alpine.
USER pwagent
WORKDIR /home/pwagent

# frpc has no `status` subcommand against a config file; the admin port
# is bound to 127.0.0.1:7400 by entrypoint.sh. A TCP probe on that port
# is a sufficient liveness signal: if frpc has crashed, the listener is gone.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD nc -z 127.0.0.1 7400 || exit 1

LABEL org.opencontainers.image.source="https://github.com/phoenixtechnam/k8s-hosting-platform" \
      org.opencontainers.image.title="private-worker-agent" \
      org.opencontainers.image.description="Home agent that dials a private worker tunnel into the platform" \
      org.opencontainers.image.licenses="Apache-2.0"

ENTRYPOINT ["/sbin/tini", "-g", "--", "/usr/local/bin/entrypoint.sh"]
