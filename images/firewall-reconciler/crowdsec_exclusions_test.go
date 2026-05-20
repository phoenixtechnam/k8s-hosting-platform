package main

import (
	"net/netip"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
)

// fakeNodeLister implements nodeLister with a fixed slice. Same fake
// pattern reconcile_test.go uses for the peer reconciler.
type fakeNodeLister struct {
	nodes []*corev1.Node
}

func (f *fakeNodeLister) List(_ labels.Selector) ([]*corev1.Node, error) {
	return f.nodes, nil
}

func nodeFixture(name string, podCIDR string, podCIDRs []string, internalIPs []string, externalIPs []string) *corev1.Node {
	addrs := []corev1.NodeAddress{}
	for _, ip := range internalIPs {
		addrs = append(addrs, corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: ip})
	}
	for _, ip := range externalIPs {
		addrs = append(addrs, corev1.NodeAddress{Type: corev1.NodeExternalIP, Address: ip})
	}
	return &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Spec: corev1.NodeSpec{
			PodCIDR:  podCIDR,
			PodCIDRs: podCIDRs,
		},
		Status: corev1.NodeStatus{
			Addresses: addrs,
		},
	}
}

func TestBuildExclusionSet_NodeIPsAndPodCIDRs(t *testing.T) {
	nodes := &fakeNodeLister{nodes: []*corev1.Node{
		nodeFixture("node1", "10.42.0.0/24", nil, []string{"10.0.0.1"}, []string{"1.2.3.4"}),
		nodeFixture("node2", "10.42.1.0/24", nil, []string{"10.0.0.2"}, []string{}),
	}}
	ex, err := buildExclusionSet(nodes, nil, nil, "10.43.0.0/16")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	// Expect 2 PodCIDRs + 2 InternalIPs + 1 ExternalIP + 1 service CIDR = 6 v4 entries.
	if len(ex.V4) != 6 {
		t.Errorf("v4 entries = %d, want 6 (%v)", len(ex.V4), ex.V4)
	}
	// Spot-check a few specific prefixes are present.
	wantContains := []string{"10.42.0.0/24", "10.42.1.0/24", "10.43.0.0/16", "10.0.0.1/32", "10.0.0.2/32", "1.2.3.4/32"}
	for _, want := range wantContains {
		found := false
		for _, p := range ex.V4 {
			if p.String() == want {
				found = true
				break
			}
		}
		if !found {
			t.Errorf("missing exclusion: %s (got %v)", want, ex.V4)
		}
	}
}

func TestBuildExclusionSet_DualStack(t *testing.T) {
	nodes := &fakeNodeLister{nodes: []*corev1.Node{
		nodeFixture("dual", "10.42.0.0/24", []string{"10.42.0.0/24", "fd00::/64"},
			[]string{"10.0.0.1", "fe80::1"}, []string{}),
	}}
	ex, err := buildExclusionSet(nodes, nil, nil, "")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	// v4: PodCIDR + InternalIP
	if len(ex.V4) != 2 {
		t.Errorf("v4 = %d, want 2 (%v)", len(ex.V4), ex.V4)
	}
	// v6: PodCIDR + InternalIP
	if len(ex.V6) != 2 {
		t.Errorf("v6 = %d, want 2 (%v)", len(ex.V6), ex.V6)
	}
}

func TestBuildExclusionSet_MalformedServiceCIDR_Skipped(t *testing.T) {
	nodes := &fakeNodeLister{nodes: nil}
	ex, err := buildExclusionSet(nodes, nil, nil, "not-a-cidr")
	if err != nil {
		t.Fatalf("malformed service CIDR should not error: %v", err)
	}
	if len(ex.V4) != 0 || len(ex.V6) != 0 {
		t.Errorf("malformed service CIDR leaked through: %+v", ex)
	}
}

func TestBuildExclusionSet_EmptyEverything(t *testing.T) {
	nodes := &fakeNodeLister{nodes: nil}
	ex, err := buildExclusionSet(nodes, nil, nil, "")
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if len(ex.V4) != 0 || len(ex.V6) != 0 {
		t.Errorf("empty inputs produced exclusions: %+v", ex)
	}
}

func TestParseCIDRSafely(t *testing.T) {
	cases := []struct {
		in     string
		ok     bool
		wantV4 bool
	}{
		{"10.0.0.0/8", true, true},
		{"fe80::/10", true, false},
		{"::ffff:1.2.3.0/120", true, true}, // v4-mapped → bare v4
		{"not-a-cidr", false, false},
		{"", false, false},
	}
	for _, c := range cases {
		t.Run(c.in, func(t *testing.T) {
			p, ok := parseCIDRSafely(c.in)
			if ok != c.ok {
				t.Fatalf("ok = %v, want %v", ok, c.ok)
			}
			if !ok {
				return
			}
			if p.Addr().Is4() != c.wantV4 {
				t.Errorf("Is4 = %v, want %v (got %s)", p.Addr().Is4(), c.wantV4, p)
			}
		})
	}
}

func TestAppendToFamily(t *testing.T) {
	var ex exclusionSet
	appendToFamily(&ex, netip.MustParsePrefix("10.0.0.0/8"))
	appendToFamily(&ex, netip.MustParsePrefix("fe80::/10"))
	appendToFamily(&ex, netip.MustParsePrefix("1.2.3.4/32"))
	if len(ex.V4) != 2 {
		t.Errorf("v4 = %d, want 2", len(ex.V4))
	}
	if len(ex.V6) != 1 {
		t.Errorf("v6 = %d, want 1", len(ex.V6))
	}
}

func TestPodCIDRsFromNode_DedupesSinglePodCIDR(t *testing.T) {
	n := nodeFixture("x", "10.42.0.0/24", []string{"10.42.0.0/24", "fd00::/64"}, nil, nil)
	cidrs := podCIDRsFromNode(n)
	if len(cidrs) != 2 {
		t.Errorf("expected 2 CIDRs (deduped) but got %v", cidrs)
	}
}
