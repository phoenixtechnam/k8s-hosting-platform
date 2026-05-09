# peer-firewall-reconciler — always-on set-mode firewall converger.
#
# As of 2026-05-09 the reconciler talks netlink directly via
# github.com/google/nftables — NO `nft` binary in the container,
# NO apt/apk-installed nftables package, NO userspace version-skew
# with the host. The kernel's netfilter wire format is stable across
# nft binary versions, so the host's `nft list ...` keeps working
# regardless of what the reconciler writes.
#
# Compatibility incidents (now closed by this design):
#   2026-05-08  alpine 3.20 nft 1.0.9 segfaulted on `nft list set`
#               against host nft 1.1.3-written rules — older client,
#               newer kernel state.
#   2026-05-09  alpine 3.21 + custom-built nft 1.1.6 wrote attrs that
#               host nft 1.1.3 couldn't parse — newer client, older
#               host. Crashed host nft on every list, broke SSH on
#               the staging cluster.
# Both failure modes have a userspace `nft` binary in the data path.
# This image has neither.
#
# Runs hostNetwork: true so the kernel netfilter context is the host's;
# CAP_NET_ADMIN is the only capability needed for set writes.

FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/reconciler ./...

# Distroless static — no shell, no package manager, no `nft`. Just the
# Go binary + ca-certs (for in-cluster apiserver TLS via service VIP).
FROM gcr.io/distroless/static:nonroot
COPY --from=build /out/reconciler /usr/local/bin/peer-firewall-reconciler
# nonroot user (UID 65532) is fine — CAP_NET_ADMIN is granted via
# DaemonSet securityContext.capabilities.add and applies regardless
# of UID. The library uses unprivileged netlink sockets.
USER nonroot:nonroot
ENTRYPOINT ["/usr/local/bin/peer-firewall-reconciler"]
