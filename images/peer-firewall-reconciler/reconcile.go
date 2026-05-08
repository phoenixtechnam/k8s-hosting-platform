// reconcileOnce + status patching + TTL enforcement.

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"sort"
	"time"

	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/types"
)

// nodeLister is the minimal slice of corelisters.NodeLister we depend
// on. Defining it locally keeps the tests free of the full lister
// machinery and provides an injection point for a static slice fake.
type nodeLister interface {
	List(selector labels.Selector) ([]*corev1.Node, error)
}

// reconcileOnce gathers all three sources, computes the four nft
// set memberships, applies them atomically (when changed), and patches
// each CR's status. Errors from individual status patches are logged
// but do NOT abort the run — a transient kube-API blip on one CR's
// patch shouldn't block the firewall update for the rest.
func (r *reconciler) reconcileOnce(ctx context.Context) error {
	now := r.now()

	// 1. Gather sources.
	nodes, err := r.nodes.List(labels.Everything())
	if err != nil {
		return fmt.Errorf("list nodes: %w", err)
	}
	ctrObjs, err := r.ctrLister.List(labels.Everything())
	if err != nil {
		return fmt.Errorf("list clustertrustedranges: %w", err)
	}
	cppObjs, err := r.cppLister.List(labels.Everything())
	if err != nil {
		return fmt.Errorf("list clusterpendingpeers: %w", err)
	}

	// 2. Compute set memberships.
	peerV4, peerV6 := splitInternalIPs(nodes)
	nodeIPSet := make(map[string]struct{}, len(peerV4)+len(peerV6))
	for _, ip := range peerV4 {
		nodeIPSet[ip] = struct{}{}
	}
	for _, ip := range peerV6 {
		nodeIPSet[ip] = struct{}{}
	}

	cppByName := make(map[string]*unstructured.Unstructured, len(cppObjs))
	cppV4, cppV6 := []string{}, []string{}
	cppExpiredNames := []string{}
	cppToClaim := []*unstructured.Unstructured{}
	cppPatches := make(map[string]*unstructured.Unstructured, len(cppObjs))

	for _, obj := range cppObjs {
		cpp, ok := asUnstructured(obj)
		if !ok {
			continue
		}
		cppByName[cpp.GetName()] = cpp
		spec, ok := readCPPSpec(cpp)
		if !ok {
			// CRD admission accepted it but spec.ip is missing — write a
			// Failed condition and skip.
			cppPatches[cpp.GetName()] = cpp
			continue
		}
		canonical, family, ok := parseBareIP(spec.IP)
		if !ok {
			// Spec IP fails the authoritative validator. Write Failed.
			cppPatches[cpp.GetName()] = cpp
			continue
		}
		bareIP := stripPrefix(canonical)
		expiresAt := cpp.GetCreationTimestamp().Add(time.Duration(spec.TTLSeconds) * time.Second)

		// TTL: claimed CRs get an extra grace window before delete so
		// the operator can observe the "Claimed" state in the UI.
		claimedAt, claimed := cppClaimedAt(cpp)
		if claimed {
			if now.After(claimedAt.Add(r.cppGrace)) {
				cppExpiredNames = append(cppExpiredNames, cpp.GetName())
				continue
			}
		} else if now.After(expiresAt) {
			cppExpiredNames = append(cppExpiredNames, cpp.GetName())
			continue
		}

		// Active (not expired, possibly already claimed) — union into peer set.
		if family == "v4" {
			cppV4 = append(cppV4, bareIP)
		} else {
			cppV6 = append(cppV6, bareIP)
		}

		// Claim detection: matching Node InternalIP appeared.
		if !claimed {
			if _, present := nodeIPSet[bareIP]; present {
				cppToClaim = append(cppToClaim, cpp)
			}
		}
		cppPatches[cpp.GetName()] = cpp
	}

	trustedV4, trustedV6 := []string{}, []string{}
	ctrPatches := make(map[string]*unstructured.Unstructured, len(ctrObjs))
	for _, obj := range ctrObjs {
		ctr, ok := asUnstructured(obj)
		if !ok {
			continue
		}
		ctrPatches[ctr.GetName()] = ctr
		spec, ok := readCTRSpec(ctr)
		if !ok {
			continue // status patch will write Failed
		}
		canonical, family, ok := parseIPOrCIDR(spec.Cidr)
		if !ok {
			continue // status patch will write Failed
		}
		if family == "v4" {
			trustedV4 = append(trustedV4, canonical)
		} else {
			trustedV6 = append(trustedV6, canonical)
		}
	}

	// 3. Union peer sources, dedupe, sort.
	allPeerV4 := uniqueSorted(append(peerV4, cppV4...))
	allPeerV6 := uniqueSorted(append(peerV6, cppV6...))
	trustedV4 = uniqueSorted(trustedV4)
	trustedV6 = uniqueSorted(trustedV6)

	// 4. Build + apply nft script (cached diff).
	script := buildNftScript(nftSets{
		PeersV4:   allPeerV4,
		PeersV6:   allPeerV6,
		TrustedV4: trustedV4,
		TrustedV6: trustedV6,
	})
	r.mu.Lock()
	scriptChanged := !bytes.Equal(script, r.last)
	if scriptChanged {
		if err := r.runNft(script); err != nil {
			r.mu.Unlock()
			return fmt.Errorf("apply nft: %w", err)
		}
		r.last = script
	}
	r.mu.Unlock()

	if scriptChanged {
		slog.Info("nft sets reconciled",
			"peers_v4", len(allPeerV4), "peers_v6", len(allPeerV6),
			"trusted_v4", len(trustedV4), "trusted_v6", len(trustedV6),
			"cpp_active", len(cppV4)+len(cppV6),
			"cpp_expired_pending_delete", len(cppExpiredNames))
	}

	// 5. Status patches + cleanup. All best-effort — kube-API hiccup
	// on one resource doesn't roll back firewall changes.
	for _, ctr := range ctrPatches {
		r.patchCTRStatus(ctx, ctr, now)
	}
	for _, cpp := range cppPatches {
		r.patchCPPStatus(ctx, cpp, now)
	}
	for _, cpp := range cppToClaim {
		r.markCPPClaimed(ctx, cpp, now)
	}
	for _, name := range cppExpiredNames {
		r.deleteCPP(ctx, name)
	}

	return nil
}

// patchCTRStatus writes the spec validation outcome into the CR's
// status subresource. Idempotent: if status already matches the
// computed values, the merge-patch is a no-op for the kube-API.
func (r *reconciler) patchCTRStatus(ctx context.Context, ctr *unstructured.Unstructured, now time.Time) {
	spec, ok := readCTRSpec(ctr)
	if !ok {
		r.writeStatus(ctx, r.ctrClient, ctr, statusPayload{
			ObservedGeneration: ctr.GetGeneration(),
			Conditions: []condition{{
				Type:    "Ready",
				Status:  "False",
				Reason:  "MissingSpec",
				Message: "spec.cidr is empty or missing",
				Time:    now,
			}},
		})
		return
	}
	canonical, family, ok := parseIPOrCIDR(spec.Cidr)
	if !ok {
		r.writeStatus(ctx, r.ctrClient, ctr, statusPayload{
			ObservedGeneration: ctr.GetGeneration(),
			Conditions: []condition{{
				Type:    "Ready",
				Status:  "False",
				Reason:  "ValidationFailed",
				Message: fmt.Sprintf("spec.cidr %q is not a valid IPv4/v6 address or CIDR (rejected by net/netip)", spec.Cidr),
				Time:    now,
			}},
		})
		return
	}
	r.writeStatus(ctx, r.ctrClient, ctr, statusPayload{
		ObservedGeneration: ctr.GetGeneration(),
		NormalizedCidr:     canonical,
		Family:             family,
		LastSyncedAt:       now,
		Conditions: []condition{{
			Type:    "Ready",
			Status:  "True",
			Reason:  "Synced",
			Message: "trust range present in nft set",
			Time:    now,
		}},
	})
}

// patchCPPStatus writes the spec validation outcome + lifecycle status
// (expiresAt, family, normalizedIp). Does NOT set claimedAt — that's
// a separate path (markCPPClaimed) so we don't overwrite an existing
// claimedAt with each tick.
func (r *reconciler) patchCPPStatus(ctx context.Context, cpp *unstructured.Unstructured, now time.Time) {
	spec, ok := readCPPSpec(cpp)
	if !ok {
		r.writeStatus(ctx, r.cppClient, cpp, statusPayload{
			ObservedGeneration: cpp.GetGeneration(),
			Conditions: []condition{{
				Type:    "Ready",
				Status:  "False",
				Reason:  "MissingSpec",
				Message: "spec.ip is empty or missing",
				Time:    now,
			}},
		})
		return
	}
	canonical, family, ok := parseBareIP(spec.IP)
	if !ok {
		r.writeStatus(ctx, r.cppClient, cpp, statusPayload{
			ObservedGeneration: cpp.GetGeneration(),
			Conditions: []condition{{
				Type:    "Ready",
				Status:  "False",
				Reason:  "ValidationFailed",
				Message: fmt.Sprintf("spec.ip %q is not a valid bare IPv4/v6 address (rejected by net/netip)", spec.IP),
				Time:    now,
			}},
		})
		return
	}
	expiresAt := cpp.GetCreationTimestamp().Add(time.Duration(spec.TTLSeconds) * time.Second)
	r.writeStatus(ctx, r.cppClient, cpp, statusPayload{
		ObservedGeneration: cpp.GetGeneration(),
		NormalizedIp:       canonical,
		Family:             family,
		ExpiresAt:          &expiresAt,
		Conditions: []condition{{
			Type:    "Ready",
			Status:  "True",
			Reason:  "Pending",
			Message: "awaiting node InternalIP match",
			Time:    now,
		}},
	})
}

// markCPPClaimed sets status.claimedAt + a Claimed=True condition.
// Called from reconcileOnce ONLY for CPPs whose IP just appeared in
// kube-API Node InternalIPs — the new node has joined.
func (r *reconciler) markCPPClaimed(ctx context.Context, cpp *unstructured.Unstructured, now time.Time) {
	r.writeStatus(ctx, r.cppClient, cpp, statusPayload{
		ObservedGeneration: cpp.GetGeneration(),
		ClaimedAt:          &now,
		Conditions: []condition{{
			Type:    "Claimed",
			Status:  "True",
			Reason:  "NodeRegistered",
			Message: "matching Node InternalIP observed in kube-API",
			Time:    now,
		}},
	})
}

// deleteCPP removes a TTL-expired or post-claim CPP. Tolerates
// NotFound (already deleted) silently; logs everything else.
func (r *reconciler) deleteCPP(ctx context.Context, name string) {
	err := r.cppClient.Delete(ctx, name, metav1.DeleteOptions{})
	if err != nil && !apierrors.IsNotFound(err) {
		slog.Warn("delete clusterpendingpeer", "name", name, "err", err)
		return
	}
	slog.Info("clusterpendingpeer deleted (TTL expired or post-claim)", "name", name)
}

// statusPayload — fields the reconciler may write into a CR's
// status subresource. Pointer types distinguish "field unset" from
// "zero value" in JSON; nil pointers are omitted from the merge patch.
type statusPayload struct {
	ObservedGeneration int64
	NormalizedCidr     string     // CTR only
	NormalizedIp       string     // CPP only
	Family             string     // "v4" | "v6"
	LastSyncedAt       time.Time  // CTR; zero means omit
	ExpiresAt          *time.Time // CPP
	ClaimedAt          *time.Time // CPP
	Conditions         []condition
}

type condition struct {
	Type    string
	Status  string // "True" | "False" | "Unknown"
	Reason  string
	Message string
	Time    time.Time
}

// writeStatus issues a JSON-merge-patch to the CR's /status subresource.
// Conflicts (resource was deleted, generation moved on) are warned but
// not retried — the next reconcile tick will re-emit if needed.
func (r *reconciler) writeStatus(
	ctx context.Context,
	client interface {
		Patch(ctx context.Context, name string, pt types.PatchType, data []byte, opts metav1.PatchOptions, subresources ...string) (*unstructured.Unstructured, error)
	},
	cr *unstructured.Unstructured,
	p statusPayload,
) {
	statusObj := map[string]any{
		"observedGeneration": p.ObservedGeneration,
	}
	if p.NormalizedCidr != "" {
		statusObj["normalizedCidr"] = p.NormalizedCidr
	}
	if p.NormalizedIp != "" {
		statusObj["normalizedIp"] = p.NormalizedIp
	}
	if p.Family != "" {
		statusObj["family"] = p.Family
	}
	if !p.LastSyncedAt.IsZero() {
		statusObj["lastSyncedAt"] = p.LastSyncedAt.UTC().Format(time.RFC3339)
	}
	if p.ExpiresAt != nil {
		statusObj["expiresAt"] = p.ExpiresAt.UTC().Format(time.RFC3339)
	}
	if p.ClaimedAt != nil {
		statusObj["claimedAt"] = p.ClaimedAt.UTC().Format(time.RFC3339)
	}
	if len(p.Conditions) > 0 {
		statusObj["conditions"] = renderConditions(p.Conditions)
	}
	patch := map[string]any{"status": statusObj}
	body, err := json.Marshal(patch)
	if err != nil {
		slog.Warn("marshal status patch", "name", cr.GetName(), "err", err)
		return
	}
	_, err = client.Patch(ctx, cr.GetName(), types.MergePatchType, body, metav1.PatchOptions{}, "status")
	if err != nil {
		if apierrors.IsNotFound(err) {
			return // CR was deleted between list and patch — fine
		}
		slog.Warn("patch status", "name", cr.GetName(), "err", err)
	}
}

func renderConditions(conds []condition) []map[string]any {
	out := make([]map[string]any, 0, len(conds))
	for _, c := range conds {
		out = append(out, map[string]any{
			"type":               c.Type,
			"status":             c.Status,
			"reason":             c.Reason,
			"message":            c.Message,
			"lastTransitionTime": c.Time.UTC().Format(time.RFC3339),
		})
	}
	return out
}

// splitInternalIPs separates Node.status.addresses[type=InternalIP] into
// IPv4 and IPv6 sorted slices. Sorted output makes the rendered nft
// script deterministic for the no-op short-circuit in reconcileOnce.
func splitInternalIPs(nodes []*corev1.Node) (v4, v6 []string) {
	for _, n := range nodes {
		for _, addr := range n.Status.Addresses {
			if addr.Type != corev1.NodeInternalIP {
				continue
			}
			ip := net.ParseIP(addr.Address)
			if ip == nil {
				continue
			}
			if ip.To4() != nil {
				v4 = append(v4, ip.String())
			} else {
				v6 = append(v6, ip.String())
			}
		}
	}
	sort.Strings(v4)
	sort.Strings(v6)
	return v4, v6
}

// uniqueSorted dedupes a slice and returns it sorted. Used to merge
// Node InternalIPs with non-expired CPP IPs into a single deterministic
// peer-set element list.
func uniqueSorted(in []string) []string {
	if len(in) == 0 {
		return in
	}
	seen := make(map[string]struct{}, len(in))
	out := make([]string, 0, len(in))
	for _, s := range in {
		if _, dup := seen[s]; dup {
			continue
		}
		seen[s] = struct{}{}
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

// asUnstructured coerces a runtime.Object from a generic lister into
// the *Unstructured form we work with. Returns false on a type the
// dynamic informer should never produce — defensive against future
// k8s library changes.
func asUnstructured(obj runtime.Object) (*unstructured.Unstructured, bool) {
	u, ok := obj.(*unstructured.Unstructured)
	if !ok {
		return nil, false
	}
	if u == nil || u.Object == nil {
		return nil, false
	}
	return u, true
}

var (
	// errReconcile is reserved for tests that need a sentinel error.
	//nolint:unused
	errReconcile = errors.New("reconcile failed")
)

// statusPatchType — exported for tests that want to assert the patch
// kind. The reconciler always uses MergePatch because the conditions
// field has x-kubernetes-list-map-keys=[type] in the CRDs, so a merge
// patch on the array correctly re-keys by type.
//
//nolint:unused
const statusPatchType = types.MergePatchType
