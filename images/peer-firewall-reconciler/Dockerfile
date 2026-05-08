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

FROM alpine:3.21
# nftables 1.1.3 (alpine 3.21) parses Debian 13 trixie's nft 1.1.3
# ruleset cleanly. Alpine 3.20 ships nft 1.0.9 which segfaults on
# `nft list ...` when the host wrote the ruleset with 1.1.3 — the
# binary literal-string comparison succeeds at "list set" parse but
# the netlink dump format includes new-in-1.1.x set-element shapes
# that 1.0.9 dereferences as garbage. Observed on staging1
# 2026-05-08: nftMissingSets() returned all-missing because every
# probe segfaulted; reconciler idle-looped despite sets being
# declared on the host.
RUN apk add --no-cache nftables ca-certificates
COPY --from=build /out/reconciler /usr/local/bin/peer-firewall-reconciler
# Runs as root inside the container so nft inherits CAP_NET_ADMIN
# without ambient-cap configuration. The DaemonSet drops all caps
# except NET_ADMIN, so the actual blast radius is identical to a
# non-root + ambient-cap setup.
ENTRYPOINT ["/usr/local/bin/peer-firewall-reconciler"]
