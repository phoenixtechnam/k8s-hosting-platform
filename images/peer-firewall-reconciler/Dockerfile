# peer-firewall-reconciler — keeps host nft sets cluster_peers_v{4,6}
# in sync with kube-API node InternalIPs (firewall set-mode only).
#
# Runs hostNetwork: true so the in-container nft binary shares the host
# netfilter ruleset; needs only CAP_NET_ADMIN, no privileged escalation.

FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/reconciler

FROM alpine:3.20
RUN apk add --no-cache nftables ca-certificates
COPY --from=build /out/reconciler /usr/local/bin/peer-firewall-reconciler
# Runs as root inside the container so nft inherits CAP_NET_ADMIN
# without ambient-cap configuration. The DaemonSet drops all caps
# except NET_ADMIN, so the actual blast radius is identical to a
# non-root + ambient-cap setup.
ENTRYPOINT ["/usr/local/bin/peer-firewall-reconciler"]
