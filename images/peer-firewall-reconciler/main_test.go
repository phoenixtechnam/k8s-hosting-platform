package main

import (
	"context"
	"strings"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
)

// node — concise test helper for *corev1.Node{}.
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
			corev1.NodeAddress{Type: corev1.NodeExternalIP, Address: "1.1.1.1"},   // skip (not InternalIP)
			corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: "not-an-ip"}, // skip (parse fail)
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

func TestUniqueSorted(t *testing.T) {
	in := []string{"10.0.0.2", "10.0.0.1", "10.0.0.2", "10.0.0.3", "10.0.0.1"}
	got := uniqueSorted(in)
	want := "10.0.0.1,10.0.0.2,10.0.0.3"
	if strings.Join(got, ",") != want {
		t.Errorf("got %v, want %s", got, want)
	}
}

func TestUniqueSorted_emptyInput(t *testing.T) {
	if got := uniqueSorted(nil); len(got) != 0 {
		t.Errorf("expected empty, got %v", got)
	}
	if got := uniqueSorted([]string{}); len(got) != 0 {
		t.Errorf("expected empty, got %v", got)
	}
}

// staticLister implements the local nodeLister interface for tests.
type staticLister struct{ items []*corev1.Node }

func (s staticLister) List(_ labels.Selector) ([]*corev1.Node, error) {
	return s.items, nil
}

// reconcilerCtx — minimal context for tests that exercise the run loop.
//
//nolint:unused
func reconcilerCtx() context.Context {
	return context.Background()
}
