// tenant_reconcile.go — reconciler for tenant_ports_{tcp,udp} sets.
//
// Replaces images/worker-firewall-reconciler/reconcile.sh. Same
// inputs (Pod hostPort + platform.io/firewall-{tcp,udp}-ports
// annotation), same tenant-namespace classification (namespace prefix
// `client-` OR namespace has annotation
// platform.phoenix-host.net/tenant-namespace=true), same set targets.
// Different writer: libnftnl netlink (no `nft` binary in container).
//
// Per-node scope: a Pod informer with a server-side
// fields.OneTermEqualSelector("spec.nodeName", NODE_NAME) ensures the
// reconciler only sees Pods scheduled to its own host.

package main

import (
	"context"
	"fmt"
	"log/slog"
	"regexp"
	"sort"
	"strings"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/labels"
	corelisters "k8s.io/client-go/listers/core/v1"
)

// tenantNamespaceAnnotation flips a namespace into the tenant bucket.
// Belt + suspenders with the `client-` prefix check: either signal is
// sufficient. We'd rather have a false-negative (skip a tenant
// namespace someone forgot to label) than a false-positive (open
// infra ports to the public-facing accept set).
const tenantNamespaceAnnotation = "platform.phoenix-host.net/tenant-namespace"

// tenantPortAnnotationTCP / UDP — operator-supplied CSV with bare
// ports or ranges. Matches the bash worker's annotation contract
// exactly (renaming would break existing catalog manifests in the
// wild; out of scope for this consolidation).
const (
	tenantPortAnnotationTCP = "platform.io/firewall-tcp-ports"
	tenantPortAnnotationUDP = "platform.io/firewall-udp-ports"
)

// tenantPortRegex enforces the security contract from the bash
// reconciler: a port element MUST be a bare integer or `lo-hi` range
// of integers. Anything else (whitespace, nft syntax characters,
// shell metacharacters) is rejected and logged as REFUSE.
var tenantPortRegex = regexp.MustCompile(`^[0-9]+(-[0-9]+)?$`)

// tenantPortsReconciler runs the second loop in the consolidated
// firewall-reconciler binary. Drives applyTenantPortsIfChanged at
// floorReconcile cadence + on every Pod / Namespace event.
type tenantPortsReconciler struct {
	nodeName string
	pods     corelisters.PodLister
	nses     corelisters.NamespaceLister
	parent   *reconciler // for parent.applier (shared netlink writer)

	trigger chan struct{}

	// health publishes the most recent successful tenant-ports
	// reconcile time so the kubelet liveness/readiness HTTP probe
	// can detect stalls. Wired by main(); may be nil in tests.
	health *healthState
}

// newTenantPortsReconciler wires the informers + lister into a
// reconciler ready for run(). Caller still owns the Start/Sync of the
// shared informer factory.
func newTenantPortsReconciler(
	nodeName string,
	pods corelisters.PodLister,
	nses corelisters.NamespaceLister,
	parent *reconciler,
) *tenantPortsReconciler {
	return &tenantPortsReconciler{
		nodeName: nodeName,
		pods:     pods,
		nses:     nses,
		parent:   parent,
		trigger:  make(chan struct{}, 1),
	}
}

// kick is the same coalescing-channel pattern as parent.kick(): if a
// reconcile is already pending, drop the new event; the next ticked
// reconcile will see all observable state.
func (t *tenantPortsReconciler) kick() {
	select {
	case t.trigger <- struct{}{}:
	default:
	}
}

// run drives reconcileOnce on tick + on event. Same shape as the
// peer-reconciler run() loop. Recovery boundary lives at the goroutine
// top in main(); a panic here unwinds to runWithRecover. On a
// successful reconcile we publish a timestamp to the health probe
// so kubelet can detect stalls.
func (t *tenantPortsReconciler) run(ctx context.Context) {
	t.kick()
	tk := time.NewTicker(floorReconcile)
	defer tk.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.trigger:
		case <-tk.C:
		}
		if err := t.reconcileOnce(ctx); err != nil {
			slog.Error("tenant-ports reconcile", "err", err)
			continue
		}
		if t.health != nil {
			t.health.markTenantHealthy(time.Now())
		}
	}
}

// reconcileOnce gathers Pods scheduled to NODE_NAME, filters for
// tenant namespaces, computes desired tenant_ports_{tcp,udp} sets,
// and applies via the parent's libnftnl applier (with per-set
// fingerprint cache so identical state is a no-op).
func (t *tenantPortsReconciler) reconcileOnce(ctx context.Context) error {
	_ = ctx // not used today; kept for symmetry with peer reconcileOnce + future cancellation propagation

	pods, err := t.pods.List(labels.Everything())
	if err != nil {
		return fmt.Errorf("list pods: %w", err)
	}

	tcpSet := map[string]struct{}{}
	udpSet := map[string]struct{}{}

	for _, pod := range pods {
		// Defense in depth: the field-selector should already filter
		// non-local Pods at the apiserver, but the cache might briefly
		// hold stale entries. Skip anything not on this node.
		if pod.Spec.NodeName != t.nodeName {
			continue
		}
		ok, err := t.isTenantNamespace(pod.Namespace)
		if err != nil {
			slog.Warn("namespace lookup failed; skipping pod",
				"pod", pod.Namespace+"/"+pod.Name, "err", err)
			continue
		}
		if !ok {
			continue
		}
		collectHostPorts(pod, tcpSet, udpSet)
		collectAnnotationPorts(pod, tcpSet, udpSet)
	}

	desired := tenantPortSets{
		TCP: sortedKeys(tcpSet),
		UDP: sortedKeys(udpSet),
	}
	changed, err := t.parent.applyTenantPortsIfChanged(desired)
	if err != nil {
		return fmt.Errorf("apply tenant ports: %w", err)
	}
	if changed {
		slog.Info("tenant_ports reconciled",
			"tcp", len(desired.TCP), "udp", len(desired.UDP))
	}
	return nil
}

// isTenantNamespace returns true if the namespace is in the tenant
// bucket — either the name starts with "client-" or the namespace
// carries the tenant-marker annotation. Either signal flips it; we
// prefer false-negative (skip a tenant the operator forgot to label)
// to false-positive (punching infra ports through the public-accept
// rule, which is exactly the IngressNightmare exposure the firewall
// guard exists to prevent).
func (t *tenantPortsReconciler) isTenantNamespace(name string) (bool, error) {
	if strings.HasPrefix(name, "client-") {
		return true, nil
	}
	ns, err := t.nses.Get(name)
	if err != nil {
		return false, err
	}
	return ns.Annotations[tenantNamespaceAnnotation] == "true", nil
}

// collectHostPorts walks pod.spec.containers[*].ports[*] and adds any
// hostPort declarations into the tcp/udp accumulators.
func collectHostPorts(pod *corev1.Pod, tcpSet, udpSet map[string]struct{}) {
	for _, c := range pod.Spec.Containers {
		for _, p := range c.Ports {
			if p.HostPort == 0 {
				continue
			}
			if p.HostPort < 1 || p.HostPort > 65535 {
				continue
			}
			elem := fmt.Sprintf("%d", p.HostPort)
			switch strings.ToUpper(string(p.Protocol)) {
			case "UDP":
				udpSet[elem] = struct{}{}
			case "", "TCP":
				// Empty defaults to TCP per Kubernetes API.
				tcpSet[elem] = struct{}{}
			}
		}
	}
}

// collectAnnotationPorts parses the platform.io/firewall-{tcp,udp}-ports
// annotations and adds entries (each validated against tenantPortRegex)
// to the accumulators. Malformed entries are logged + skipped.
func collectAnnotationPorts(pod *corev1.Pod, tcpSet, udpSet map[string]struct{}) {
	if v, ok := pod.Annotations[tenantPortAnnotationTCP]; ok {
		for _, raw := range strings.Split(v, ",") {
			elem := strings.TrimSpace(raw)
			if elem == "" {
				continue
			}
			if !tenantPortRegex.MatchString(elem) {
				slog.Warn("REFUSE tenant port annotation entry",
					"pod", pod.Namespace+"/"+pod.Name,
					"annotation", tenantPortAnnotationTCP,
					"value", elem,
					"reason", "fails port-or-range regex")
				continue
			}
			tcpSet[elem] = struct{}{}
		}
	}
	if v, ok := pod.Annotations[tenantPortAnnotationUDP]; ok {
		for _, raw := range strings.Split(v, ",") {
			elem := strings.TrimSpace(raw)
			if elem == "" {
				continue
			}
			if !tenantPortRegex.MatchString(elem) {
				slog.Warn("REFUSE tenant port annotation entry",
					"pod", pod.Namespace+"/"+pod.Name,
					"annotation", tenantPortAnnotationUDP,
					"value", elem,
					"reason", "fails port-or-range regex")
				continue
			}
			udpSet[elem] = struct{}{}
		}
	}
}

// sortedKeys returns map keys sorted lexically. Sort order matches
// the canonical fingerprint key order — element strings as written
// (`3478` < `5349` < `16384-32768` lexically; not numerically, but
// stable across ticks so the fingerprint cache hits).
func sortedKeys(m map[string]struct{}) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
