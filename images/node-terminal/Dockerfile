# Privileged-Pod harness for the admin node-terminal feature.
#
# The Pod runs on the target k3s node with hostPID:true + privileged:true
# (see backend/src/modules/node-terminal/pod-spec.ts). When the operator
# opens a terminal modal, platform-api `kubectl exec`s into this container
# and runs:
#
#   nsenter -t 1 -m -u -i -n -p -- /bin/bash -l
#
# which enters the mount/uts/ipc/net/pid namespaces of PID 1 on the host —
# yielding a root shell in the host's namespaces. The shell uses the
# HOST's bash + coreutils + everything else (via nsenter mount-ns swap).
#
# The container itself only needs `nsenter` (util-linux) and a sleep
# loop to keep it alive while the exec channel is open.
#
# This image is INTERNAL-ONLY. Never expose to tenants. Pulled by
# kubelet on every node that hosts a terminal session; `IfNotPresent`
# pull policy in pod-spec keeps subsequent opens fast.

FROM alpine:3.20

# util-linux provides: nsenter, lsns, unshare, mount, etc.
# bash + coreutils: in-container debugging (rarely used; the shell
#   itself runs in the host namespaces after nsenter).
# tini: cleanly reaps zombies if anything spawns under PID 1 of the
#   pause container. Defence in depth — the pod typically holds
#   only `sleep` as PID 1.
RUN apk add --no-cache \
      util-linux \
      bash \
      coreutils \
      tini \
      tmux \
  && addgroup -S terminal && adduser -S terminal -G terminal

# tmux is bundled here so the host shell can reach it via
# /proc/<self-in-pod>/root/usr/bin/tmux even when the underlying k3s
# node distro doesn't ship tmux (e.g. rancher/k3s containerised in
# dev, or stripped-down node OSes). Production hosts get tmux from
# bootstrap.sh's apt/dnf install; this is the fallback path. The
# nsenter wrapper in pod-spec.ts probes both PATH and /proc/.../root
# locations.

# Document the OCI labels for the GHCR listing. These do not affect
# runtime.
LABEL org.opencontainers.image.title="hosting-platform-node-terminal"
LABEL org.opencontainers.image.description="Privileged-Pod harness for admin web-terminal (nsenter into k3s node host PID 1)"
LABEL org.opencontainers.image.source="https://github.com/phoenixtechnam/hosting-platform"
LABEL org.opencontainers.image.licenses="MIT"
LABEL platform.phoenix-host.net/role="node-terminal"

# Run as root inside the container — needed because nsenter into PID 1
# host namespaces requires CAP_SYS_ADMIN, granted via the privileged
# securityContext in pod-spec.ts. The non-root `terminal` user above
# exists only to document the principle that container code does NOT
# need root by itself; the privileges come from the namespace swap.
USER 0
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["/bin/sh", "-c", "sleep 3600"]
