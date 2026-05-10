package main

import (
	"context"
	"sort"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	corelisters "k8s.io/client-go/listers/core/v1"
	"k8s.io/client-go/tools/cache"
)

// fakeTenantSetup wires up the tenant-ports reconciler against in-memory
// stores so tests can assert on fakeApplier.tenantPortCalls.
func fakeTenantSetup(t *testing.T, nodeName string, pods []*corev1.Pod, nses []*corev1.Namespace) (*tenantPortsReconciler, *fakeApplier) {
	t.Helper()
	podStore := cache.NewIndexer(cache.MetaNamespaceKeyFunc, cache.Indexers{cache.NamespaceIndex: cache.MetaNamespaceIndexFunc})
	for _, p := range pods {
		if err := podStore.Add(p); err != nil {
			t.Fatalf("seed pod store: %v", err)
		}
	}
	nsStore := cache.NewIndexer(cache.MetaNamespaceKeyFunc, cache.Indexers{})
	for _, n := range nses {
		if err := nsStore.Add(n); err != nil {
			t.Fatalf("seed namespace store: %v", err)
		}
	}
	fa := &fakeApplier{}
	parent := &reconciler{
		applier: fa,
	}
	tpr := &tenantPortsReconciler{
		nodeName: nodeName,
		pods:     corelisters.NewPodLister(podStore),
		nses:     corelisters.NewNamespaceLister(nsStore),
		parent:   parent,
		trigger:  make(chan struct{}, 1),
	}
	return tpr, fa
}

func mkPod(ns, name, nodeName string, opts ...func(*corev1.Pod)) *corev1.Pod {
	p := &corev1.Pod{
		ObjectMeta: metav1.ObjectMeta{Namespace: ns, Name: name, Annotations: map[string]string{}},
		Spec:       corev1.PodSpec{NodeName: nodeName},
	}
	for _, o := range opts {
		o(p)
	}
	return p
}

func withHostPort(port int32, proto corev1.Protocol) func(*corev1.Pod) {
	return func(p *corev1.Pod) {
		if len(p.Spec.Containers) == 0 {
			p.Spec.Containers = []corev1.Container{{Name: "c"}}
		}
		p.Spec.Containers[0].Ports = append(p.Spec.Containers[0].Ports, corev1.ContainerPort{
			HostPort: port, Protocol: proto,
		})
	}
}

func withAnnotation(k, v string) func(*corev1.Pod) {
	return func(p *corev1.Pod) {
		p.Annotations[k] = v
	}
}

func mkNS(name string, annotations map[string]string) *corev1.Namespace {
	if annotations == nil {
		annotations = map[string]string{}
	}
	return &corev1.Namespace{
		ObjectMeta: metav1.ObjectMeta{Name: name, Annotations: annotations},
	}
}

// ── Namespace classification ──────────────────────────────────────────

func TestIsTenantNamespace_clientPrefix(t *testing.T) {
	tpr, _ := fakeTenantSetup(t, "n1", nil, []*corev1.Namespace{mkNS("client-acme", nil)})
	ok, err := tpr.isTenantNamespace("client-acme")
	if err != nil || !ok {
		t.Errorf("client-prefix should be tenant; ok=%v err=%v", ok, err)
	}
}

func TestIsTenantNamespace_annotation(t *testing.T) {
	tpr, _ := fakeTenantSetup(t, "n1", nil, []*corev1.Namespace{
		mkNS("acme-prod", map[string]string{tenantNamespaceAnnotation: "true"}),
	})
	ok, err := tpr.isTenantNamespace("acme-prod")
	if err != nil || !ok {
		t.Errorf("annotated ns should be tenant; ok=%v err=%v", ok, err)
	}
}

func TestIsTenantNamespace_infraNotTenant(t *testing.T) {
	tpr, _ := fakeTenantSetup(t, "n1", nil, []*corev1.Namespace{mkNS("ingress-nginx", nil)})
	ok, err := tpr.isTenantNamespace("ingress-nginx")
	if err != nil {
		t.Fatalf("err = %v", err)
	}
	if ok {
		t.Error("ingress-nginx should NOT be a tenant ns")
	}
}

// ── Pod scanning ──────────────────────────────────────────────────────

func TestReconcileOnce_hostPortIntoTCPSet(t *testing.T) {
	pods := []*corev1.Pod{
		mkPod("client-acme", "web", "n1", withHostPort(443, corev1.ProtocolTCP)),
	}
	nses := []*corev1.Namespace{mkNS("client-acme", nil)}
	tpr, fa := fakeTenantSetup(t, "n1", pods, nses)
	if err := tpr.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce: %v", err)
	}
	if len(fa.tenantPortCalls) != 1 {
		t.Fatalf("expected 1 tenant apply, got %d", len(fa.tenantPortCalls))
	}
	if got, want := fa.tenantPortCalls[0].TCP, []string{"443"}; !equalSorted(got, want) {
		t.Errorf("tcp = %v, want %v", got, want)
	}
	if len(fa.tenantPortCalls[0].UDP) != 0 {
		t.Errorf("udp = %v, want empty", fa.tenantPortCalls[0].UDP)
	}
}

func TestReconcileOnce_hostPortUDP(t *testing.T) {
	pods := []*corev1.Pod{
		mkPod("client-acme", "stun", "n1", withHostPort(3478, corev1.ProtocolUDP)),
	}
	nses := []*corev1.Namespace{mkNS("client-acme", nil)}
	tpr, fa := fakeTenantSetup(t, "n1", pods, nses)
	if err := tpr.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce: %v", err)
	}
	if got, want := fa.tenantPortCalls[0].UDP, []string{"3478"}; !equalSorted(got, want) {
		t.Errorf("udp = %v, want %v", got, want)
	}
}

func TestReconcileOnce_hostPortDefaultsToTCP(t *testing.T) {
	// Empty Protocol field defaults to TCP per the kubernetes API.
	pods := []*corev1.Pod{
		mkPod("client-acme", "web", "n1", withHostPort(8080, "")),
	}
	nses := []*corev1.Namespace{mkNS("client-acme", nil)}
	tpr, fa := fakeTenantSetup(t, "n1", pods, nses)
	if err := tpr.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce: %v", err)
	}
	if got, want := fa.tenantPortCalls[0].TCP, []string{"8080"}; !equalSorted(got, want) {
		t.Errorf("empty protocol should default to TCP; got %v want %v", got, want)
	}
}

func TestReconcileOnce_annotationCSV(t *testing.T) {
	pods := []*corev1.Pod{
		mkPod("client-acme", "turn", "n1",
			withAnnotation(tenantPortAnnotationTCP, "3478,5349"),
			withAnnotation(tenantPortAnnotationUDP, "3478, 16384-32768")),
	}
	nses := []*corev1.Namespace{mkNS("client-acme", nil)}
	tpr, fa := fakeTenantSetup(t, "n1", pods, nses)
	if err := tpr.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce: %v", err)
	}
	got := fa.tenantPortCalls[0]
	if !equalSorted(got.TCP, []string{"3478", "5349"}) {
		t.Errorf("tcp = %v, want [3478 5349]", got.TCP)
	}
	if !equalSorted(got.UDP, []string{"3478", "16384-32768"}) {
		t.Errorf("udp = %v, want [3478 16384-32768]", got.UDP)
	}
}

func TestReconcileOnce_annotationRejectsMaliciousValue(t *testing.T) {
	pods := []*corev1.Pod{
		mkPod("client-acme", "evil", "n1",
			withAnnotation(tenantPortAnnotationTCP, "3478, 1; flush ruleset, 5349")),
	}
	nses := []*corev1.Namespace{mkNS("client-acme", nil)}
	tpr, fa := fakeTenantSetup(t, "n1", pods, nses)
	if err := tpr.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce: %v", err)
	}
	if got, want := fa.tenantPortCalls[0].TCP, []string{"3478", "5349"}; !equalSorted(got, want) {
		t.Errorf("malicious entry should be skipped; got %v want %v", got, want)
	}
}

func TestReconcileOnce_infraNamespaceNotPunched(t *testing.T) {
	// Infra Pod (e.g. kube-proxy) declaring hostPort MUST NOT be exposed.
	pods := []*corev1.Pod{
		mkPod("kube-system", "kube-proxy", "n1", withHostPort(10256, corev1.ProtocolTCP)),
	}
	nses := []*corev1.Namespace{mkNS("kube-system", nil)}
	tpr, fa := fakeTenantSetup(t, "n1", pods, nses)
	if err := tpr.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce: %v", err)
	}
	if len(fa.tenantPortCalls[0].TCP) != 0 {
		t.Errorf("infra hostPort must not appear; got %v", fa.tenantPortCalls[0].TCP)
	}
}

func TestReconcileOnce_skipsPodsOnOtherNodes(t *testing.T) {
	pods := []*corev1.Pod{
		mkPod("client-acme", "local", "n1", withHostPort(80, corev1.ProtocolTCP)),
		mkPod("client-acme", "remote", "n2", withHostPort(90, corev1.ProtocolTCP)),
	}
	nses := []*corev1.Namespace{mkNS("client-acme", nil)}
	tpr, fa := fakeTenantSetup(t, "n1", pods, nses)
	if err := tpr.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce: %v", err)
	}
	if got, want := fa.tenantPortCalls[0].TCP, []string{"80"}; !equalSorted(got, want) {
		t.Errorf("expected only n1's port; got %v", got)
	}
}

func TestReconcileOnce_dedup(t *testing.T) {
	// Two tenants on the same node both expose 8080/tcp — appears once.
	pods := []*corev1.Pod{
		mkPod("client-a", "x", "n1", withHostPort(8080, corev1.ProtocolTCP)),
		mkPod("client-b", "x", "n1", withHostPort(8080, corev1.ProtocolTCP)),
	}
	nses := []*corev1.Namespace{mkNS("client-a", nil), mkNS("client-b", nil)}
	tpr, fa := fakeTenantSetup(t, "n1", pods, nses)
	if err := tpr.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce: %v", err)
	}
	if got, want := fa.tenantPortCalls[0].TCP, []string{"8080"}; !equalSorted(got, want) {
		t.Errorf("dedup failed; got %v want %v", got, want)
	}
}

func TestReconcileOnce_emptyDesiredYieldsZeroState(t *testing.T) {
	// No tenants on this node — desired is empty TCP/UDP. Apply still happens
	// once (changed: empty-vs-cache miss), then second tick is a no-op.
	tpr, fa := fakeTenantSetup(t, "n1", nil, nil)
	if err := tpr.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce: %v", err)
	}
	if err := tpr.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce: %v", err)
	}
	if len(fa.tenantPortCalls) != 1 {
		t.Errorf("expected 1 apply (second is cached no-op), got %d", len(fa.tenantPortCalls))
	}
	if len(fa.tenantPortCalls[0].TCP) != 0 || len(fa.tenantPortCalls[0].UDP) != 0 {
		t.Errorf("empty desired sets; got tcp=%v udp=%v",
			fa.tenantPortCalls[0].TCP, fa.tenantPortCalls[0].UDP)
	}
}

func TestReconcileOnce_outOfBandKernelResetForcesReApply(t *testing.T) {
	// Regression for the staging bug observed 2026-05-09: an operator
	// runs `nft -f /etc/nftables.conf` to reset corrupt state, the
	// reconciler's old in-process cache thought "{4 IPs}" was already
	// applied and skipped the re-write, leaving the kernel set empty.
	//
	// The new design observes kernel state on every tick. Simulate a
	// kernel-state divergence by overriding observePeerFP to an empty
	// fingerprint AFTER the first apply — and verify the next call
	// re-applies.
	fa := &fakeApplier{}
	parent := &reconciler{applier: fa}

	// First call: empty observed (initial state) → applies.
	_, _ = parent.applyPeersIfChanged(peerNftSets{PeersV4: []string{"10.0.0.1"}})
	if len(fa.calls) != 1 {
		t.Fatalf("expected 1 apply on first call; got %d", len(fa.calls))
	}

	// Second call with same desired state: observe matches → skip.
	_, _ = parent.applyPeersIfChanged(peerNftSets{PeersV4: []string{"10.0.0.1"}})
	if len(fa.calls) != 1 {
		t.Fatalf("expected 1 apply when desired matches observed; got %d", len(fa.calls))
	}

	// Out-of-band reset: observed is now empty (kernel was reset).
	empty := ""
	fa.observePeerFP = &empty
	_, _ = parent.applyPeersIfChanged(peerNftSets{PeersV4: []string{"10.0.0.1"}})
	if len(fa.calls) != 2 {
		t.Errorf("expected re-apply after observed kernel state diverges; got %d total calls", len(fa.calls))
	}
}

func TestReconcileOnce_observeErrorTriggersForceApply(t *testing.T) {
	// When netlink is briefly unhappy, observe* returns an error.
	// Reconciler should fall back to "force apply" — better to
	// over-write than under-write when state is unknown.
	fa := &fakeApplier{observeErr: errReconcile}
	parent := &reconciler{applier: fa}

	_, _ = parent.applyPeersIfChanged(peerNftSets{PeersV4: []string{"10.0.0.1"}})
	if len(fa.calls) != 1 {
		t.Fatalf("expected force-apply on observe error; got %d calls", len(fa.calls))
	}
	// And again, even if desired didn't change, observe-error keeps forcing.
	_, _ = parent.applyPeersIfChanged(peerNftSets{PeersV4: []string{"10.0.0.1"}})
	if len(fa.calls) != 2 {
		t.Errorf("observe-error should keep forcing apply; got %d calls", len(fa.calls))
	}
}

// ── helper sanity ────────────────────────────────────────────────────

func TestSortedKeys(t *testing.T) {
	got := sortedKeys(map[string]struct{}{"3478": {}, "16384-32768": {}, "5349": {}})
	want := []string{"16384-32768", "3478", "5349"}
	if !sort.StringsAreSorted(got) {
		t.Errorf("output not sorted: %v", got)
	}
	if !equalSorted(got, want) {
		t.Errorf("got %v, want %v", got, want)
	}
}
