# security-probe — read-only host posture probe.
#
# Runs as DaemonSet on every node. Every PROBE_INTERVAL_SECONDS:
#   parse /host/etc/ssh/sshd_config (incl. drop-in dir + Include)
#   detect mesh interface (wt0 / tailscale0 / wg0)
#   sample /host/proc/net/nf_conntrack for INVALID flows
#   read /host/etc/hosting-platform/firewall.conf for SSH posture
#   write ONE ConfigMap per node (security-probe-<node>) in
#     platform-system, with the JSON snapshot at data.snapshot
#
# Container has NO shell, NO package manager, NO `nft` binary, NO
# kubectl. Just the Go binary + apiserver TLS roots. All host paths
# are mounted read-only at /host/* by the DaemonSet manifest.

FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod go.sum* ./
RUN go mod download
COPY *.go ./
RUN CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o /out/security-probe ./...

# Distroless static — no shell, no package manager. Runs as root (uid
# 0) because /etc/ssh/sshd_config and /proc/sys/kernel/* are
# root-readable on most distros and we don't want to require operator
# chmod tweaks to enable the probe. The DaemonSet SecurityContext
# drops ALL capabilities + sets readOnlyRootFilesystem +
# allowPrivilegeEscalation:false so root inside this container is
# strictly less powerful than a non-root user on the host.
FROM gcr.io/distroless/static:latest
COPY --from=build /out/security-probe /usr/local/bin/security-probe
ENTRYPOINT ["/usr/local/bin/security-probe"]
