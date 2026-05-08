// IP and CIDR parsing helpers. The reconciler is the authoritative
// validator (CRD pattern is a coarse first filter), so we use Go's
// net/netip — a strict, allocation-free IP library — to reject anything
// that ipaddress.ip_network() in the bootstrap.sh side wouldn't accept.
//
// All public helpers return a "family" string ("v4" or "v6") and a
// canonical text form. Callers feed the canonical form into the nft
// element list and into the CR status.normalized{Cidr,Ip} fields.

package main

import (
	"net/netip"
	"strings"
)

// parseIPOrCIDR accepts:
//   - bare IPv4   "1.2.3.4"           → "1.2.3.4/32",  "v4", ok
//   - IPv4 CIDR   "10.0.0.0/16"       → "10.0.0.0/16", "v4", ok
//   - bare IPv6   "2001:db8::1"       → "2001:db8::1/128", "v6", ok
//   - IPv6 CIDR   "fd00::/8"          → "fd00::/8",   "v6", ok
//
// Rejects:
//   - prefix out of range (/33 v4, /129 v6)
//   - structurally-invalid addresses (":::", trailing-colon)
//   - the all-routes prefix /0 (defense-in-depth; CRD has CEL guard
//     too, but bootstrap-time --allow-source seed bypasses that path)
//   - empty / whitespace-only input
//
// Returned canonical form is what the reconciler writes to CR status
// AND to nft, so a round-trip through this function is the single
// source of truth for "is this IP/CIDR usable?".
func parseIPOrCIDR(s string) (canonical, family string, ok bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", "", false
	}

	// Try as Prefix first (covers both bare/* and CIDR forms via fallback).
	if p, err := netip.ParsePrefix(s); err == nil {
		return canonicalisePrefix(p)
	}

	// Try as bare Addr; promote to /32 or /128 prefix.
	if a, err := netip.ParseAddr(s); err == nil {
		if a.Is4() {
			return a.String() + "/32", "v4", true
		}
		if a.Is6() {
			return a.String() + "/128", "v6", true
		}
	}

	return "", "", false
}

// parseBareIP — accepts only a bare IP, no prefix. Used by
// ClusterPendingPeer.spec.ip. Returns canonical "<ip>/32" or "<ip>/128"
// (CPP semantically pre-authorises a single host, never a range).
func parseBareIP(s string) (canonical, family string, ok bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return "", "", false
	}
	a, err := netip.ParseAddr(s)
	if err != nil {
		return "", "", false
	}
	if a.Is4() {
		return a.String() + "/32", "v4", true
	}
	if a.Is6() {
		return a.String() + "/128", "v6", true
	}
	return "", "", false
}

// canonicalisePrefix is the shared post-validation step for any
// netip.Prefix coming in. Rejects /0 and forces a canonical text form.
func canonicalisePrefix(p netip.Prefix) (canonical, family string, ok bool) {
	if !p.IsValid() {
		return "", "", false
	}
	if p.Bits() == 0 {
		// /0 means "trust the entire internet" — never the intent.
		return "", "", false
	}
	// netip.Prefix.Masked() snaps the address to the network address,
	// so "10.0.0.5/16" round-trips to "10.0.0.0/16". Idempotent for
	// already-normalized inputs and a /32 or /128 round-trips trivially.
	masked := p.Masked()
	if masked.Addr().Is4() {
		return masked.String(), "v4", true
	}
	if masked.Addr().Is6() {
		return masked.String(), "v6", true
	}
	return "", "", false
}

// stripPrefix turns "10.0.0.5/32" into "10.0.0.5". Used when emitting
// elements into nft sets that don't have flags interval (cluster_peers
// type ipv4_addr / ipv6_addr accept both forms with `flags interval`,
// but the bare form is what `nft list set` renders so we use it for
// readability).
func stripPrefix(s string) string {
	if i := strings.IndexByte(s, '/'); i > 0 {
		return s[:i]
	}
	return s
}
