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
FROM gcr.io/distroless/static:latest
COPY --from=build /out/reconciler /usr/local/bin/peer-firewall-reconciler
# Runs as root (UID 0) inside the container. DaemonSet drops all caps
# except NET_ADMIN (the only one libnftnl needs for set writes via
# netlink). We tried distroless:nonroot first but the netlink socket
# operations returned EPERM — capabilities granted via container
# runtime aren't automatically in the EFFECTIVE set for non-root,
# and we don't have ambient-cap or setcap wired. Root inside a
# locked-down (drop:ALL, no privileged, readOnlyRootFilesystem,
# RuntimeDefault seccomp) container is acceptable for a binary that
# only uses NET_ADMIN.
ENTRYPOINT ["/usr/local/bin/peer-firewall-reconciler"]
