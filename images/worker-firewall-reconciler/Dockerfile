# worker-firewall-reconciler — bash + nft + kubectl, runs on every node.
#
# Watches Pods on its own node and converges the host's nft sets
# tenant_ports_tcp / tenant_ports_udp (declared by scripts/bootstrap.sh)
# with the union of:
#   - spec.containers[*].ports[*].hostPort (matching protocol)
#   - metadata.annotations["platform.io/firewall-tcp-ports"] (CSV, ranges OK)
#   - metadata.annotations["platform.io/firewall-udp-ports"] (CSV, ranges OK)
#
# See k8s/base/worker-firewall-reconciler/ for the DaemonSet manifest.

FROM alpine:3.20

# nftables — talk to the host netfilter via netlink (CAP_NET_ADMIN).
# kubectl  — read pods scheduled to this node via downward API NODE_NAME.
# bash     — non-busybox associative arrays + RE matching used by reconcile.sh.
# jq       — robust JSON parsing of `kubectl get pods -o json`.
# coreutils — GNU sort -n / paste / etc., busybox versions are flag-incompatible.
RUN apk add --no-cache nftables kubectl bash jq coreutils

COPY reconcile.sh /usr/local/bin/reconcile.sh
RUN chmod +x /usr/local/bin/reconcile.sh

# Reconcile loop runs as PID 1; SIGTERM in reconcile.sh exits cleanly.
ENTRYPOINT ["/usr/local/bin/reconcile.sh"]
