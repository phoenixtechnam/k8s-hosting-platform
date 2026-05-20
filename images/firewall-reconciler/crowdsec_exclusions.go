// F1+F6 Stage B — exclusion-set builder.
//
// The exclusion set is the UNION of every prefix the kernel must
// NEVER drop traffic for, regardless of LAPI saying otherwise.
// Sources, all CIDR-aware:
//
//   1. Pod CIDR (per-node) — Node.spec.podCIDR + spec.podCIDRs (dual-stack)
//   2. Service CIDR — env KUBERNETES_SERVICE_CIDR (k3s default "10.43.0.0/16")
//   3. Node InternalIPs (every node, as /32 or /128) — same lister
//      the peer reconciler uses
//   4. Node ExternalIPs (every node, as /32 or /128) — same lister.
//      Critical: an operator banning their own IP would otherwise drop
//      SSH on the node External addr; the External-IP exclusion prevents
//      a foot-gun where a CrowdSec scenario fires on the operator's
//      source IP and locks them out.
//   5. ClusterTrustedRange CIDRs — same lister the peer reconciler uses
//   6. ClusterPendingPeer IPs (active, as /32 or /128) — same lister
//
// Output is UNORDERED — applyExclusions doesn't care about order.

package main

import (
	"fmt"
	"net/netip"
	"strings"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/tools/cache"
)

// envKubernetesServiceCIDR — operator-facing override. k3s default
// is 10.43.0.0/16; kube-proxy also reads this when allocating ClusterIPs.
const envKubernetesServiceCIDR = "KUBERNETES_SERVICE_CIDR"

// buildExclusionSet reads from the same informer listers the peer
// reconciler uses (so no extra apiserver load) plus the service-CIDR
// env. Returns an exclusionSet split into v4/v6.
//
// Errors are returned only for the catastrophic case (lister fully
// broken). Individual malformed entries are skipped silently — the
// peer reconciler already logs malformed CRD specs on its own ticks,
// so we don't double-log here.
func buildExclusionSet(
	nodes nodeLister,
	ctrLister cache.GenericLister,
	cppLister cache.GenericLister,
	serviceCIDREnv string,
) (exclusionSet, error) {
	var ex exclusionSet

	// 2. Service CIDR (env). Optional — if unset we still exclude
	// everything else. If set but malformed: silently skip (the env
	// is logged once at reconciler startup so the operator sees the typo).
	if serviceCIDREnv != "" {
		if p, ok := parseCIDRSafely(serviceCIDREnv); ok {
			appendToFamily(&ex, p)
		}
	}

	// 1+3+4. Walk Nodes for PodCIDRs and Internal/External IPs.
	nodeObjs, err := nodes.List(labels.Everything())
	if err != nil {
		return exclusionSet{}, fmt.Errorf("crowdsec exclusions: list nodes: %w", err)
	}
	for _, n := range nodeObjs {
		for _, cidr := range podCIDRsFromNode(n) {
			if p, ok := parseCIDRSafely(cidr); ok {
				appendToFamily(&ex, p)
			}
		}
		for _, addr := range n.Status.Addresses {
			if addr.Type != corev1.NodeInternalIP && addr.Type != corev1.NodeExternalIP {
				continue
			}
			a, err := netip.ParseAddr(addr.Address)
			if err != nil {
				continue
			}
			a = a.Unmap()
			bits := 32
			if a.Is6() {
				bits = 128
			}
			appendToFamily(&ex, netip.PrefixFrom(a, bits))
		}
	}

	// 5. ClusterTrustedRange CIDRs. The peer reconciler already
	// canonicalises these into trusted_ranges_v{4,6}; we re-derive them
	// here so a banned trusted-range IP can't slip past at L4 either.
	if ctrLister != nil {
		ctrObjs, err := ctrLister.List(labels.Everything())
		if err != nil {
			return exclusionSet{}, fmt.Errorf("crowdsec exclusions: list ctrs: %w", err)
		}
		for _, obj := range ctrObjs {
			ctr, ok := asUnstructured(obj)
			if !ok {
				continue
			}
			spec, ok := readCTRSpec(ctr)
			if !ok {
				continue
			}
			if p, ok := parseCIDRSafely(spec.Cidr); ok {
				appendToFamily(&ex, p)
			}
		}
	}

	// 6. ClusterPendingPeer IPs (active only). TTL handling is the
	// peer reconciler's responsibility — when expired, the CR is
	// deleted from the apiserver and the informer cache catches up
	// on the next tick. Wasted exclusion for at most one tick window
	// (~30s) is harmless; duplicating the TTL loop here would be
	// brittle.
	if cppLister != nil {
		cppObjs, err := cppLister.List(labels.Everything())
		if err != nil {
			return exclusionSet{}, fmt.Errorf("crowdsec exclusions: list cpps: %w", err)
		}
		for _, obj := range cppObjs {
			cpp, ok := asUnstructured(obj)
			if !ok {
				continue
			}
			spec, ok := readCPPSpec(cpp)
			if !ok {
				continue
			}
			canonical, _, ok := parseBareIP(spec.IP)
			if !ok {
				continue
			}
			ip := stripPrefix(canonical)
			a, err := netip.ParseAddr(ip)
			if err != nil {
				continue
			}
			a = a.Unmap()
			bits := 32
			if a.Is6() {
				bits = 128
			}
			appendToFamily(&ex, netip.PrefixFrom(a, bits))
		}
	}

	return ex, nil
}

// podCIDRsFromNode returns the union of Node.spec.podCIDR + .podCIDRs
// (dual-stack) as a string slice. Empty fields are dropped; duplicates
// preserved here and de-duped by netip.ParsePrefix downstream.
func podCIDRsFromNode(n *corev1.Node) []string {
	out := make([]string, 0, 2)
	if c := strings.TrimSpace(n.Spec.PodCIDR); c != "" {
		out = append(out, c)
	}
	for _, c := range n.Spec.PodCIDRs {
		c = strings.TrimSpace(c)
		if c == "" || c == n.Spec.PodCIDR {
			continue
		}
		out = append(out, c)
	}
	return out
}

// parseCIDRSafely normalises a CIDR string into a netip.Prefix,
// rejecting malformed values + v4-mapped-v6 by Unmap-ping. Returns
// (zero, false) on failure so the caller can skip silently.
func parseCIDRSafely(s string) (netip.Prefix, bool) {
	p, err := netip.ParsePrefix(s)
	if err != nil {
		return netip.Prefix{}, false
	}
	if !p.IsValid() {
		return netip.Prefix{}, false
	}
	return unmapPrefix(p), true
}

// appendToFamily routes a prefix into the v4 or v6 slot of an
// exclusionSet based on its (Unmap-aware) family.
func appendToFamily(ex *exclusionSet, p netip.Prefix) {
	if p.Addr().Is4() {
		ex.V4 = append(ex.V4, p)
	} else {
		ex.V6 = append(ex.V6, p)
	}
}
