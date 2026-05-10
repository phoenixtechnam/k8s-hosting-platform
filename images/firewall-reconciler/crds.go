// CRD GVRs and unstructured-field accessors for ClusterTrustedRange and
// ClusterPendingPeer. Kept in one file so a future schema bump is a
// single-file change.

package main

import (
	"time"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

const (
	crdGroup   = "networking.platform.phoenix-host.net"
	crdVersion = "v1alpha1"
)

var (
	ctrGVR = schema.GroupVersionResource{
		Group:    crdGroup,
		Version:  crdVersion,
		Resource: "clustertrustedranges",
	}
	cppGVR = schema.GroupVersionResource{
		Group:    crdGroup,
		Version:  crdVersion,
		Resource: "clusterpendingpeers",
	}
)

// defaultCppPostClaimGrace — delay between setting status.claimedAt and
// deleting the CR. 5 minutes lets the admin UI render the "Claimed"
// state for at least one poll cycle before the resource disappears.
const defaultCppPostClaimGrace = 5 * time.Minute

// ctrSpec — minimal projection of ClusterTrustedRange.spec.
type ctrSpec struct {
	Cidr        string
	Description string
	AddedBy     string
}

// readCTRSpec extracts the spec fields we care about. Returns empty
// struct + ok=false when the unstructured object lacks the required
// .spec.cidr key (catches accidentally-empty CRs).
func readCTRSpec(u *unstructured.Unstructured) (ctrSpec, bool) {
	if u == nil {
		return ctrSpec{}, false
	}
	cidr, found, _ := unstructured.NestedString(u.Object, "spec", "cidr")
	if !found || cidr == "" {
		return ctrSpec{}, false
	}
	desc, _, _ := unstructured.NestedString(u.Object, "spec", "description")
	addedBy, _, _ := unstructured.NestedString(u.Object, "spec", "addedBy")
	return ctrSpec{Cidr: cidr, Description: desc, AddedBy: addedBy}, true
}

// cppSpec — minimal projection of ClusterPendingPeer.spec.
type cppSpec struct {
	IP         string
	Hostname   string
	Role       string
	TTLSeconds int64
	AddedBy    string
}

// readCPPSpec extracts the spec fields we care about. ttlSeconds
// defaults to 1800 (the CRD schema default) if absent — clients that
// omit the field still get the documented behaviour.
func readCPPSpec(u *unstructured.Unstructured) (cppSpec, bool) {
	if u == nil {
		return cppSpec{}, false
	}
	ip, found, _ := unstructured.NestedString(u.Object, "spec", "ip")
	if !found || ip == "" {
		return cppSpec{}, false
	}
	hostname, _, _ := unstructured.NestedString(u.Object, "spec", "hostname")
	role, _, _ := unstructured.NestedString(u.Object, "spec", "role")
	addedBy, _, _ := unstructured.NestedString(u.Object, "spec", "addedBy")
	ttl, ttlFound, _ := unstructured.NestedInt64(u.Object, "spec", "ttlSeconds")
	if !ttlFound {
		ttl = 1800
	}
	return cppSpec{
		IP:         ip,
		Hostname:   hostname,
		Role:       role,
		TTLSeconds: ttl,
		AddedBy:    addedBy,
	}, true
}

// cppClaimedAt reads status.claimedAt as a time.Time. Returns zero
// time and ok=false if the field is missing or unparseable — used by
// the reconciler to decide whether to set claimedAt for the first time.
func cppClaimedAt(u *unstructured.Unstructured) (time.Time, bool) {
	if u == nil {
		return time.Time{}, false
	}
	s, found, _ := unstructured.NestedString(u.Object, "status", "claimedAt")
	if !found || s == "" {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return time.Time{}, false
	}
	return t, true
}
