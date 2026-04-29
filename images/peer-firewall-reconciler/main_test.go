package main

import (
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
)

func node(name string, addrs ...corev1.NodeAddress) *corev1.Node {
	return &corev1.Node{
		ObjectMeta: metav1.ObjectMeta{Name: name},
		Status:     corev1.NodeStatus{Addresses: addrs},
	}
}

func TestSplitInternalIPs_dualStackOrdered(t *testing.T) {
	nodes := []*corev1.Node{
		node("c", corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: "10.0.0.3"}),
		node("a", corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: "10.0.0.1"},
			corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: "fd00::1"}),
		node("b", corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: "10.0.0.2"}),
	}
	v4, v6 := splitInternalIPs(nodes)
	if got, want := strings.Join(v4, ","), "10.0.0.1,10.0.0.2,10.0.0.3"; got != want {
		t.Errorf("v4 = %q, want %q", got, want)
	}
	if got, want := strings.Join(v6, ","), "fd00::1"; got != want {
		t.Errorf("v6 = %q, want %q", got, want)
	}
}

func TestSplitInternalIPs_skipsNonInternalAndInvalid(t *testing.T) {
	nodes := []*corev1.Node{
		node("a",
			corev1.NodeAddress{Type: corev1.NodeExternalIP, Address: "1.1.1.1"}, // skip
			corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: "not-an-ip"}, // skip
			corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: "10.0.0.5"},
		),
	}
	v4, v6 := splitInternalIPs(nodes)
	if len(v4) != 1 || v4[0] != "10.0.0.5" {
		t.Errorf("v4 = %v, want [10.0.0.5]", v4)
	}
	if len(v6) != 0 {
		t.Errorf("v6 = %v, want []", v6)
	}
}

func TestBuildNftScript_v4OnlyWithElements(t *testing.T) {
	got := string(buildNftScript([]string{"10.0.0.1", "10.0.0.2"}, nil, true, false))
	want := "flush set inet filter cluster_peers_v4\nadd element inet filter cluster_peers_v4 { 10.0.0.1, 10.0.0.2 }\n"
	if got != want {
		t.Errorf("script mismatch\n got: %q\nwant: %q", got, want)
	}
}

func TestBuildNftScript_emptyV4FlushWithoutAdd(t *testing.T) {
	got := string(buildNftScript(nil, nil, true, false))
	want := "flush set inet filter cluster_peers_v4\n"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}

func TestBuildNftScript_dualStackBoth(t *testing.T) {
	got := string(buildNftScript([]string{"10.0.0.1"}, []string{"fd00::1"}, true, true))
	wantParts := []string{
		"flush set inet filter cluster_peers_v4",
		"add element inet filter cluster_peers_v4 { 10.0.0.1 }",
		"flush set inet filter cluster_peers_v6",
		"add element inet filter cluster_peers_v6 { fd00::1 }",
	}
	for _, p := range wantParts {
		if !strings.Contains(got, p) {
			t.Errorf("missing %q in script:\n%s", p, got)
		}
	}
}

func TestBuildNftScript_skipsAbsentFamilies(t *testing.T) {
	got := string(buildNftScript([]string{"10.0.0.1"}, []string{"fd00::1"}, true, false))
	if strings.Contains(got, "v6") {
		t.Errorf("v6 should not appear when hasV6=false; got:\n%s", got)
	}
	got = string(buildNftScript([]string{"10.0.0.1"}, []string{"fd00::1"}, false, true))
	if strings.Contains(got, "v4") {
		t.Errorf("v4 should not appear when hasV4=false; got:\n%s", got)
	}
}

func TestReconciler_noOpWhenScriptUnchanged(t *testing.T) {
	calls := 0
	r := &reconciler{
		v4:     true,
		v6:     false,
		runNft: func([]byte) error { calls++; return nil },
	}
	// First reconcile against an empty cache: lister returns nil, both
	// flush+adds emit a single 'flush set' line — calls runNft once,
	// caches the result.
	r.nodes = staticLister{}
	if err := r.reconcileOnce(); err != nil {
		t.Fatalf("first reconcile: %v", err)
	}
	if calls != 1 {
		t.Fatalf("first reconcile should call runNft exactly once, got %d", calls)
	}
	// Second reconcile against the same cache: identical script, no call.
	if err := r.reconcileOnce(); err != nil {
		t.Fatalf("second reconcile: %v", err)
	}
	if calls != 1 {
		t.Errorf("second reconcile should be a no-op, got %d total calls", calls)
	}
}

func TestReconciler_propagatesNftError(t *testing.T) {
	r := &reconciler{
		v4:     true,
		v6:     false,
		runNft: func([]byte) error { return errFake },
		nodes:  staticLister{},
	}
	if err := r.reconcileOnce(); err == nil {
		t.Fatal("expected error, got nil")
	}
}

// staticLister implements the local nodeLister interface for tests.
type staticLister struct{ items []*corev1.Node }

func (s staticLister) List(_ labels.Selector) ([]*corev1.Node, error) {
	return s.items, nil
}

var errFake = fakeErr("nft fake failure")

type fakeErr string

func (e fakeErr) Error() string { return string(e) }
