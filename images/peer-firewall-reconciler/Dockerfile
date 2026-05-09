# peer-firewall-reconciler — always-on set-mode firewall converger.
# Watches Nodes, ClusterTrustedRange, ClusterPendingPeer CRs and
# converges four nft sets on the host: cluster_peers_v{4,6} (peers
# union with non-expired CPP IPs), trusted_ranges_v{4,6} (CTR CIDRs).
#
# Runs hostNetwork: true so the in-container nft binary shares the host
# netfilter ruleset; needs only CAP_NET_ADMIN, no privileged escalation.

FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY *.go ./
# Build the entire package (multiple .go files now). Test files are
# excluded automatically by `go build`; -trimpath strips the local
# build path; -s -w strips debug symbols.
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/reconciler ./...

# ───────────────── Stage 1: build nft 1.1.6 from source ─────────────────
# Alpine 3.21 ships nft 1.1.1 in apk; 3.22 (when released) is expected to
# track 1.1.x. We pin nft 1.1.6 (latest stable as of 2026-05-09) by
# building from source — guarantees container nft is ≥ host nft on every
# Tier-1/2 supported OS regardless of what apk picks up.
#
# Compatibility rule learned the hard way on staging1 2026-05-08:
# container nft must be ≥ host nft, otherwise libnftnl segfaults parsing
# the kernel's netlink set-dump format. Newer client → older host is
# backward-compatible; reverse is not.
FROM alpine:3.21 AS nft-build

ARG NFTABLES_VERSION=1.1.6
ARG LIBNFTNL_VERSION=1.3.1
ARG LIBMNL_VERSION=1.0.5

RUN apk add --no-cache \
        build-base autoconf automake libtool pkgconf bison flex \
        gmp-dev jansson-dev libxtables linux-headers \
        wget tar gzip xz bash \
    && wget -qO /tmp/libmnl.tar.bz2     https://www.netfilter.org/projects/libmnl/files/libmnl-${LIBMNL_VERSION}.tar.bz2 \
    && wget -qO /tmp/libnftnl.tar.xz    https://www.netfilter.org/projects/libnftnl/files/libnftnl-${LIBNFTNL_VERSION}.tar.xz \
    && wget -qO /tmp/nftables.tar.xz    https://www.netfilter.org/projects/nftables/files/nftables-${NFTABLES_VERSION}.tar.xz \
    && mkdir -p /tmp/src && cd /tmp/src \
    && tar -xjf /tmp/libmnl.tar.bz2 \
    && tar -xJf /tmp/libnftnl.tar.xz \
    && tar -xJf /tmp/nftables.tar.xz \
    && export CONFIG_SHELL=/bin/bash \
    && cd /tmp/src/libmnl-${LIBMNL_VERSION}    && bash ./configure --prefix=/usr && make -j"$(nproc)" && make install \
    && cd /tmp/src/libnftnl-${LIBNFTNL_VERSION} && bash ./configure --prefix=/usr && make -j"$(nproc)" && make install \
    && cd /tmp/src/nftables-${NFTABLES_VERSION} \
        && bash ./configure --prefix=/usr --sbindir=/usr/sbin --disable-man-doc --without-cli \
        && make -j"$(nproc)" \
        && make install \
    && /usr/sbin/nft --version

# ───────────────── Stage 2: minimal runtime image ──────────────────────
FROM alpine:3.21

# Runtime deps only: gmp + jansson + libxtables for nft, plus ca-certs
# for in-cluster k8s API TLS.
RUN apk add --no-cache gmp jansson libxtables ca-certificates

# Copy the nft binary + the libnftables/libnftnl/libmnl shared libs.
# nft links to libnftables.so.1 (provides nft_run_cmd_*), which itself
# depends on libnftnl + libmnl. /usr/sbin/nft is what nft.go execs.
COPY --from=nft-build /usr/sbin/nft                       /usr/sbin/nft
COPY --from=nft-build /usr/lib/libnftables.so.1.1.0       /usr/lib/libnftables.so.1.1.0
COPY --from=nft-build /usr/lib/libnftables.so.1           /usr/lib/libnftables.so.1
COPY --from=nft-build /usr/lib/libnftables.so             /usr/lib/libnftables.so
COPY --from=nft-build /usr/lib/libnftnl.so.11             /usr/lib/libnftnl.so.11
COPY --from=nft-build /usr/lib/libnftnl.so                /usr/lib/libnftnl.so
COPY --from=nft-build /usr/lib/libmnl.so.0                /usr/lib/libmnl.so.0
COPY --from=nft-build /usr/lib/libmnl.so                  /usr/lib/libmnl.so

# Quick smoke at build time — fails the image build if the binary or its
# libs are missing/mismatched.
RUN /usr/sbin/nft --version
COPY --from=build /out/reconciler /usr/local/bin/peer-firewall-reconciler
# Runs as root inside the container so nft inherits CAP_NET_ADMIN
# without ambient-cap configuration. The DaemonSet drops all caps
# except NET_ADMIN, so the actual blast radius is identical to a
# non-root + ambient-cap setup.
ENTRYPOINT ["/usr/local/bin/peer-firewall-reconciler"]
