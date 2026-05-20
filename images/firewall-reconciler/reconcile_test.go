package main

import (
	"context"
	"sort"
	"testing"
	"time"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	dynamicfake "k8s.io/client-go/dynamic/fake"
	"k8s.io/client-go/tools/cache"
)

// fakeReconcilerSetup wires up everything needed for a reconcileOnce
// integration test against in-memory fake clients. Returns the
// reconciler, the captured nft scripts (one per apply), the dynamic
// fake (so tests can inspect CR state post-reconcile), and a fixed
// "now" time the reconciler will use.
func fakeReconcilerSetup(
	t *testing.T,
	now time.Time,
	nodes []*corev1.Node,
	ctrs, cpps []*unstructured.Unstructured,
) (*reconciler, *fakeApplier, *dynamicfake.FakeDynamicClient) {
	t.Helper()

	scheme := runtime.NewScheme()
	scheme.AddKnownTypeWithName(ctrGVR.GroupVersion().WithKind("ClusterTrustedRange"), &unstructured.Unstructured{})
	scheme.AddKnownTypeWithName(ctrGVR.GroupVersion().WithKind("ClusterTrustedRangeList"), &unstructured.UnstructuredList{})
	scheme.AddKnownTypeWithName(cppGVR.GroupVersion().WithKind("ClusterPendingPeer"), &unstructured.Unstructured{})
	scheme.AddKnownTypeWithName(cppGVR.GroupVersion().WithKind("ClusterPendingPeerList"), &unstructured.UnstructuredList{})

	gvrToListKind := map[schema.GroupVersionResource]string{
		ctrGVR: "ClusterTrustedRangeList",
		cppGVR: "ClusterPendingPeerList",
	}

	objs := []runtime.Object{}
	for _, c := range ctrs {
		objs = append(objs, c)
	}
	for _, c := range cpps {
		objs = append(objs, c)
	}
	dynClient := dynamicfake.NewSimpleDynamicClientWithCustomListKinds(scheme, gvrToListKind, objs...)

	// In-memory ListWatcher → cache → GenericLister. We bypass real
	// informers and write directly to a thread-safe cache because
	// dynamicinformer + fake client interaction is fiddly and not the
	// thing under test.
	mkLister := func(items []*unstructured.Unstructured, gvr schema.GroupVersionResource) cache.GenericLister {
		store := cache.NewIndexer(cache.MetaNamespaceKeyFunc, cache.Indexers{})
		for _, it := range items {
			if err := store.Add(it); err != nil {
				t.Fatalf("seed cache: %v", err)
			}
		}
		return cache.NewGenericLister(store, gvr.GroupResource())
	}

	fa := &fakeApplier{}
	r := &reconciler{
		nodes:     staticLister{items: nodes},
		ctrLister: mkLister(ctrs, ctrGVR),
		cppLister: mkLister(cpps, cppGVR),
		ctrClient: dynClient.Resource(ctrGVR),
		cppClient: dynClient.Resource(cppGVR),
		cppGrace:  defaultCppPostClaimGrace,
		now:       func() time.Time { return now },
		applier:   fa,
		trigger:   make(chan struct{}, 1),
	}
	return r, fa, dynClient
}

// fakeApplier records every apply call. Tests assert on the recorded
// peer / tenant-port set state. failNth/failErr applies to peerSet
// calls only; tenantPortCalls is independent so error injection in
// one loop doesn't perturb the other.
//
// The observe* methods simulate kernel state by returning the
// fingerprint of the LAST applied state. This matches the real
// applier's behavior on a healthy kernel + lets tests verify the
// "no apply when state already matches" short-circuit. Tests can
// override observePeerFP/observeTenantFP to simulate kernel-state
// divergence (e.g. an out-of-band reset).
type fakeApplier struct {
	calls           []peerNftSets
	tenantPortCalls []tenantPortSets
	failNth         int   // 0 = never fail; N = fail on the Nth peerSet call (1-indexed)
	failErr         error // returned when failNth fires

	// Optional overrides for the observe path. When nil, observe
	// returns the fingerprint of the last applied state (or empty
	// string if nothing applied yet). Tests use these to simulate
	// out-of-band kernel-state divergence.
	observePeerFP   *string
	observeTenantFP *string
	observeErr      error
}

func (f *fakeApplier) applyPeerSets(s peerNftSets) error {
	f.calls = append(f.calls, s)
	if f.failNth > 0 && len(f.calls) == f.failNth {
		return f.failErr
	}
	return nil
}

func (f *fakeApplier) applyTenantPorts(s tenantPortSets) error {
	f.tenantPortCalls = append(f.tenantPortCalls, s)
	return nil
}

// applyCrowdsecBlocklist — Stage B applier interface entry. fakeApplier
// doesn't track these calls because the reconciler tests don't exercise
// the crowdsec path. crowdsec_reconcile_test.go uses its own fake when
// it needs to assert on apply calls.
func (f *fakeApplier) applyCrowdsecBlocklist(_ crowdsecBlocklist) error {
	return nil
}

func (f *fakeApplier) observePeerFingerprint() (string, error) {
	if f.observeErr != nil {
		return "", f.observeErr
	}
	if f.observePeerFP != nil {
		return *f.observePeerFP, nil
	}
	if len(f.calls) == 0 {
		return "", nil
	}
	return peerFingerprint(f.calls[len(f.calls)-1]), nil
}

func (f *fakeApplier) observeTenantPortsFingerprint() (string, error) {
	if f.observeErr != nil {
		return "", f.observeErr
	}
	if f.observeTenantFP != nil {
		return *f.observeTenantFP, nil
	}
	if len(f.tenantPortCalls) == 0 {
		return "", nil
	}
	return tenantPortsFingerprint(f.tenantPortCalls[len(f.tenantPortCalls)-1]), nil
}

func mkCTR(name, cidr string, gen int64) *unstructured.Unstructured {
	u := &unstructured.Unstructured{}
	u.SetAPIVersion("networking.platform.phoenix-host.net/v1alpha1")
	u.SetKind("ClusterTrustedRange")
	u.SetName(name)
	u.SetGeneration(gen)
	_ = unstructured.SetNestedField(u.Object, cidr, "spec", "cidr")
	return u
}

func mkCPP(name, ip, role string, ttlSec int64, ageSec int64, now time.Time, gen int64) *unstructured.Unstructured {
	u := &unstructured.Unstructured{}
	u.SetAPIVersion("networking.platform.phoenix-host.net/v1alpha1")
	u.SetKind("ClusterPendingPeer")
	u.SetName(name)
	u.SetGeneration(gen)
	u.SetCreationTimestamp(metav1.Time{Time: now.Add(-time.Duration(ageSec) * time.Second)})
	_ = unstructured.SetNestedField(u.Object, ip, "spec", "ip")
	_ = unstructured.SetNestedField(u.Object, role, "spec", "role")
	_ = unstructured.SetNestedField(u.Object, ttlSec, "spec", "ttlSeconds")
	return u
}

func TestReconcileOnce_happyPath(t *testing.T) {
	now := time.Date(2026, 5, 8, 12, 0, 0, 0, time.UTC)
	nodes := []*corev1.Node{
		node("n1", corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: "10.0.0.1"}),
		node("n2", corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: "10.0.0.2"},
			corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: "fd00::1"}),
	}
	ctrs := []*unstructured.Unstructured{
		mkCTR("office-vpn", "198.51.100.0/24", 1),
		mkCTR("private-lan", "10.99.0.0/16", 1),
	}
	cpps := []*unstructured.Unstructured{
		mkCPP("new-worker", "10.0.0.5", "worker", 1800, 60, now, 1),         // active, age=60s, ttl=1800
		mkCPP("expired-server", "10.0.0.99", "server", 1800, 3600, now, 1), // expired, age=3600s > ttl=1800
	}
	r, fa, dyn := fakeReconcilerSetup(t, now, nodes, ctrs, cpps)

	if err := r.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce: %v", err)
	}

	// Expect exactly 1 apply (state changed from initial empty).
	if len(fa.calls) != 1 {
		t.Fatalf("expected 1 nft apply, got %d", len(fa.calls))
	}
	got := fa.calls[0]

	if want := []string{"10.0.0.1", "10.0.0.2", "10.0.0.5"}; !equalSorted(got.PeersV4, want) {
		t.Errorf("peers_v4 = %v, want %v", got.PeersV4, want)
	}
	if want := []string{"fd00::1"}; !equalSorted(got.PeersV6, want) {
		t.Errorf("peers_v6 = %v, want %v", got.PeersV6, want)
	}
	if want := []string{"10.99.0.0/16", "198.51.100.0/24"}; !equalSorted(got.TrustedV4, want) {
		t.Errorf("trusted_v4 = %v, want %v", got.TrustedV4, want)
	}
	// Expired CPP must NOT appear in peers
	for _, p := range got.PeersV4 {
		if p == "10.0.0.99" {
			t.Errorf("expired CPP IP 10.0.0.99 should not be in peers_v4: %v", got.PeersV4)
		}
	}

	// Verify the expired CPP was deleted.
	_, err := dyn.Resource(cppGVR).Get(context.Background(), "expired-server", metav1.GetOptions{})
	if err == nil {
		t.Errorf("expired CPP 'expired-server' should have been deleted")
	}
	// Active CPP must still exist
	if _, err := dyn.Resource(cppGVR).Get(context.Background(), "new-worker", metav1.GetOptions{}); err != nil {
		t.Errorf("active CPP 'new-worker' should still exist: %v", err)
	}

	// Verify CTR status patches landed.
	got1, err := dyn.Resource(ctrGVR).Get(context.Background(), "office-vpn", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get office-vpn: %v", err)
	}
	gotCidr, _, _ := unstructured.NestedString(got1.Object, "status", "normalizedCidr")
	if gotCidr != "198.51.100.0/24" {
		t.Errorf("office-vpn status.normalizedCidr = %q, want %q", gotCidr, "198.51.100.0/24")
	}
	gotFamily, _, _ := unstructured.NestedString(got1.Object, "status", "family")
	if gotFamily != "v4" {
		t.Errorf("office-vpn status.family = %q, want v4", gotFamily)
	}
}

func TestReconcileOnce_claimDetection(t *testing.T) {
	now := time.Date(2026, 5, 8, 12, 0, 0, 0, time.UTC)
	// Node IP matches the CPP's IP — should trigger claimedAt patch.
	nodes := []*corev1.Node{
		node("new-worker", corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: "10.0.0.5"}),
	}
	cpps := []*unstructured.Unstructured{
		mkCPP("new-worker", "10.0.0.5", "worker", 1800, 60, now, 1),
	}
	r, _, dyn := fakeReconcilerSetup(t, now, nodes, nil, cpps)

	if err := r.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce: %v", err)
	}

	got, err := dyn.Resource(cppGVR).Get(context.Background(), "new-worker", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get new-worker CPP: %v", err)
	}
	claimed, found, _ := unstructured.NestedString(got.Object, "status", "claimedAt")
	if !found || claimed == "" {
		t.Errorf("status.claimedAt should be set after Node-IP match; got %q", claimed)
	}
	conds, _, _ := unstructured.NestedSlice(got.Object, "status", "conditions")
	hasClaimed := false
	for _, c := range conds {
		m, ok := c.(map[string]any)
		if !ok {
			continue
		}
		if m["type"] == "Claimed" && m["status"] == "True" {
			hasClaimed = true
		}
	}
	if !hasClaimed {
		t.Errorf("expected Claimed=True condition; got conditions=%v", conds)
	}
}

// TestReconcileOnce_claimDetectionSinglePatch — regression guard for
// the double-patch race the code-reviewer flagged. Verifies that a
// CPP transitioning to claimed in one tick has BOTH normalizedIp +
// claimedAt + Claimed condition in its final status (not just one
// or the other due to MergePatchType replacing the conditions array
// when patchCPPStatus and markCPPClaimed both run).
func TestReconcileOnce_claimDetectionSinglePatch(t *testing.T) {
	now := time.Date(2026, 5, 8, 12, 0, 0, 0, time.UTC)
	nodes := []*corev1.Node{
		node("worker-1", corev1.NodeAddress{Type: corev1.NodeInternalIP, Address: "10.0.0.5"}),
	}
	cpps := []*unstructured.Unstructured{
		mkCPP("worker-1", "10.0.0.5", "worker", 1800, 60, now, 1),
	}
	r, _, dyn := fakeReconcilerSetup(t, now, nodes, nil, cpps)

	if err := r.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce: %v", err)
	}

	got, err := dyn.Resource(cppGVR).Get(context.Background(), "worker-1", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get worker-1: %v", err)
	}
	// All four fields must be present in a single combined patch:
	if v, _, _ := unstructured.NestedString(got.Object, "status", "claimedAt"); v == "" {
		t.Error("status.claimedAt missing — claim path failed")
	}
	if v, _, _ := unstructured.NestedString(got.Object, "status", "normalizedIp"); v != "10.0.0.5/32" {
		t.Errorf("status.normalizedIp = %q, want 10.0.0.5/32 (must be carried by markCPPClaimed)", v)
	}
	if v, _, _ := unstructured.NestedString(got.Object, "status", "family"); v != "v4" {
		t.Errorf("status.family = %q, want v4", v)
	}
	if v, _, _ := unstructured.NestedString(got.Object, "status", "expiresAt"); v == "" {
		t.Error("status.expiresAt missing")
	}
	conds, _, _ := unstructured.NestedSlice(got.Object, "status", "conditions")
	hasClaimed := false
	for _, c := range conds {
		m, ok := c.(map[string]any)
		if !ok {
			continue
		}
		if m["type"] == "Claimed" && m["status"] == "True" {
			hasClaimed = true
		}
	}
	if !hasClaimed {
		t.Errorf("expected Claimed=True condition; got %v", conds)
	}
}

// TestReconcileOnce_zeroCreationTimestampGuarded — regression for
// the "expires immediately" footgun. When kube-API returns a stub
// CPP with creationTimestamp=zero, the reconciler should treat it as
// just-created (use now) instead of computing year-1+ttlSeconds and
// deleting the CR on the first tick.
func TestReconcileOnce_zeroCreationTimestampGuarded(t *testing.T) {
	now := time.Date(2026, 5, 8, 12, 0, 0, 0, time.UTC)
	cpp := &unstructured.Unstructured{}
	cpp.SetAPIVersion("networking.platform.phoenix-host.net/v1alpha1")
	cpp.SetKind("ClusterPendingPeer")
	cpp.SetName("zero-ct")
	cpp.SetGeneration(1)
	// creationTimestamp deliberately not set — defaults to metav1.Time{}.
	_ = unstructured.SetNestedField(cpp.Object, "10.0.0.7", "spec", "ip")
	_ = unstructured.SetNestedField(cpp.Object, "worker", "spec", "role")
	_ = unstructured.SetNestedField(cpp.Object, int64(1800), "spec", "ttlSeconds")

	r, _, dyn := fakeReconcilerSetup(t, now, nil, nil, []*unstructured.Unstructured{cpp})
	if err := r.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce: %v", err)
	}

	// CR must NOT have been deleted.
	if _, err := dyn.Resource(cppGVR).Get(context.Background(), "zero-ct", metav1.GetOptions{}); err != nil {
		t.Errorf("CPP with zero creationTimestamp was deleted (premature TTL): %v", err)
	}
}

func TestReconcileOnce_invalidCidrPatchesFailedCondition(t *testing.T) {
	now := time.Date(2026, 5, 8, 12, 0, 0, 0, time.UTC)
	ctrs := []*unstructured.Unstructured{
		mkCTR("bogus", "not-a-cidr", 1),
	}
	r, fa, dyn := fakeReconcilerSetup(t, now, nil, ctrs, nil)

	if err := r.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("reconcileOnce: %v", err)
	}

	// Apply should still happen (peers + trusted both empty),
	// but bogus CTR must NOT contribute to trusted_ranges.
	if len(fa.calls) != 1 {
		t.Fatalf("expected 1 nft apply, got %d", len(fa.calls))
	}
	if len(fa.calls[0].TrustedV4) != 0 {
		t.Errorf("bogus CTR should not contribute to trusted_v4; got %v", fa.calls[0].TrustedV4)
	}

	// CTR status must reflect the failure.
	got, err := dyn.Resource(ctrGVR).Get(context.Background(), "bogus", metav1.GetOptions{})
	if err != nil {
		t.Fatalf("get bogus CTR: %v", err)
	}
	conds, _, _ := unstructured.NestedSlice(got.Object, "status", "conditions")
	hasFailed := false
	for _, c := range conds {
		m, ok := c.(map[string]any)
		if !ok {
			continue
		}
		if m["type"] == "Ready" && m["status"] == "False" && m["reason"] == "ValidationFailed" {
			hasFailed = true
		}
	}
	if !hasFailed {
		t.Errorf("expected Ready=False ValidationFailed condition; got conditions=%v", conds)
	}
}

func TestReconcileOnce_noOpWhenScriptUnchanged(t *testing.T) {
	now := time.Date(2026, 5, 8, 12, 0, 0, 0, time.UTC)
	r, fa, _ := fakeReconcilerSetup(t, now, nil, nil, nil)

	if err := r.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("first reconcileOnce: %v", err)
	}
	if err := r.reconcileOnce(context.Background()); err != nil {
		t.Fatalf("second reconcileOnce: %v", err)
	}
	if len(fa.calls) != 1 {
		t.Errorf("expected exactly 1 apply (second is cached no-op), got %d", len(fa.calls))
	}
}

// equalSorted compares two slices for value-equality after sorting.
// Helps test assertions when ordering is implementation-detail.
func equalSorted(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	a2 := append([]string(nil), a...)
	b2 := append([]string(nil), b...)
	sort.Strings(a2)
	sort.Strings(b2)
	for i := range a2 {
		if a2[i] != b2[i] {
			return false
		}
	}
	return true
}

func TestReconcileOnce_propagatesNftError(t *testing.T) {
	now := time.Date(2026, 5, 8, 12, 0, 0, 0, time.UTC)
	r, _, _ := fakeReconcilerSetup(t, now, nil, nil, nil)
	r.applier = &fakeApplier{failNth: 1, failErr: errReconcile}

	if err := r.reconcileOnce(context.Background()); err == nil {
		t.Error("expected error from nft runner, got nil")
	}
}

// TestListersAreNotNil — sanity check the mkLister helper above.
func TestListersAreNotNil(t *testing.T) {
	r, _, _ := fakeReconcilerSetup(t, time.Now(), nil, nil, nil)
	if _, err := r.ctrLister.List(labels.Everything()); err != nil {
		t.Errorf("ctrLister.List: %v", err)
	}
	if _, err := r.cppLister.List(labels.Everything()); err != nil {
		t.Errorf("cppLister.List: %v", err)
	}
}
