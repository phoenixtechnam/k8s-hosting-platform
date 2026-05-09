package main

import (
	"net/netip"
	"testing"
)

// addPow2 is the byte-arithmetic helper that computes the IntervalEnd
// key for a CIDR — start + (1 << host_bits). Cover edge cases that
// were caught by review of the original walking implementation
// (O(2^host_bits) loop unacceptable for /0 or /16).

func TestAddPow2_ipv4(t *testing.T) {
	cases := []struct {
		start string
		exp   int // host bits = totalBits - prefix
		want  string
	}{
		{"10.0.0.0", 16, "10.1.0.0"},   // /16 → host_bits=16
		{"10.99.0.0", 16, "10.100.0.0"},
		{"198.51.100.0", 8, "198.51.101.0"}, // /24 → host_bits=8
		{"1.2.3.4", 0, "1.2.3.5"},           // /32 → host_bits=0 (single host)
		{"0.0.0.0", 24, "1.0.0.0"},          // /8
	}
	for _, c := range cases {
		t.Run(c.start+"/"+c.want, func(t *testing.T) {
			a, _ := netip.ParseAddr(c.start)
			gotBytes := addPow2(a, c.exp, false)
			gotIP, ok := netip.AddrFromSlice(gotBytes)
			if !ok {
				t.Fatalf("addPow2 returned non-IPv4 bytes: %v", gotBytes)
			}
			gotIP = gotIP.Unmap()
			if gotIP.String() != c.want {
				t.Errorf("addPow2(%s, exp=%d) = %s, want %s", c.start, c.exp, gotIP, c.want)
			}
		})
	}
}

func TestAddPow2_ipv6(t *testing.T) {
	cases := []struct {
		start string
		exp   int
		want  string
	}{
		{"fd00::", 120, "fe00::"}, // /8 → host_bits=120
		{"fd00::", 0, "fd00::1"},  // /128
	}
	for _, c := range cases {
		t.Run(c.start+"/"+c.want, func(t *testing.T) {
			a, _ := netip.ParseAddr(c.start)
			gotBytes := addPow2(a, c.exp, true)
			gotIP, ok := netip.AddrFromSlice(gotBytes)
			if !ok {
				t.Fatalf("addPow2 returned non-IPv6 bytes: %v", gotBytes)
			}
			if gotIP.String() != c.want {
				t.Errorf("addPow2(%s, exp=%d) = %s, want %s", c.start, c.exp, gotIP, c.want)
			}
		})
	}
}

func TestIpsToElements_v4(t *testing.T) {
	got := ipsToElements([]string{"10.0.0.1", "10.0.0.2"}, false)
	// 2 bare IPs → 4 elements: {start, end, start, end}
	if len(got) != 4 {
		t.Fatalf("expected 4 elements, got %d", len(got))
	}
	// 10.0.0.1 → start, 10.0.0.2 → end
	if got[0].IntervalEnd {
		t.Error("element[0] should be range-start, not end")
	}
	if !got[1].IntervalEnd {
		t.Error("element[1] should be IntervalEnd marker")
	}
	if got[1].Key[3] != 2 { // last byte
		t.Errorf("element[1] expected 10.0.0.2, got last byte %d", got[1].Key[3])
	}
}

func TestIpsToElements_skipsWrongFamily(t *testing.T) {
	// v4 IP fed into v6-isV6=true should be filtered out.
	got := ipsToElements([]string{"10.0.0.1"}, true)
	if len(got) != 0 {
		t.Errorf("v4 IP in v6 list should be skipped; got %d elements", len(got))
	}
}

func TestCidrsToElements_v4(t *testing.T) {
	got := cidrsToElements([]string{"10.0.0.0/16"}, false)
	if len(got) != 2 {
		t.Fatalf("expected 2 elements (start+end), got %d", len(got))
	}
	if got[0].IntervalEnd || !got[1].IntervalEnd {
		t.Error("element ordering: [0] start, [1] IntervalEnd")
	}
	// start = 10.0.0.0
	if got[0].Key[0] != 10 || got[0].Key[1] != 0 || got[0].Key[2] != 0 || got[0].Key[3] != 0 {
		t.Errorf("start key = %v, want 10.0.0.0", got[0].Key)
	}
	// end = 10.1.0.0 (start + 2^16)
	if got[1].Key[0] != 10 || got[1].Key[1] != 1 || got[1].Key[2] != 0 || got[1].Key[3] != 0 {
		t.Errorf("end key = %v, want 10.1.0.0", got[1].Key)
	}
}

func TestCidrsToElements_masksHostBits(t *testing.T) {
	// User passes 10.0.0.5/16 (host bits set) — Masked() should snap
	// to 10.0.0.0/16 before computing the range.
	got := cidrsToElements([]string{"10.0.0.5/16"}, false)
	if len(got) != 2 {
		t.Fatalf("expected 2 elements, got %d", len(got))
	}
	// Should match the 10.0.0.0/16 case above
	if got[0].Key[2] != 0 || got[0].Key[3] != 0 {
		t.Errorf("start should snap to /16 network; got %v", got[0].Key)
	}
}

func TestCidrsToElements_skipsWrongFamily(t *testing.T) {
	got := cidrsToElements([]string{"fd00::/8"}, false)
	if len(got) != 0 {
		t.Errorf("v6 CIDR in v4 list should be skipped; got %d", len(got))
	}
}

func TestSetFingerprint_stableForSameInput(t *testing.T) {
	a := nftSets{
		PeersV4:   []string{"10.0.0.1", "10.0.0.2"},
		TrustedV4: []string{"10.0.0.0/16"},
	}
	b := nftSets{
		PeersV4:   []string{"10.0.0.1", "10.0.0.2"},
		TrustedV4: []string{"10.0.0.0/16"},
	}
	if setFingerprint(a) != setFingerprint(b) {
		t.Errorf("identical inputs should produce identical fingerprints")
	}
}

func TestSetFingerprint_differsForDifferentInput(t *testing.T) {
	a := nftSets{PeersV4: []string{"10.0.0.1"}}
	b := nftSets{PeersV4: []string{"10.0.0.2"}}
	if setFingerprint(a) == setFingerprint(b) {
		t.Errorf("different inputs should produce different fingerprints")
	}
}
