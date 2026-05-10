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

// ── tenant-port (inet_service) interval encoding ───────────────────────

func TestPortsToElements_singlePort(t *testing.T) {
	// "3478" → degenerate range [3478, 3479): 2 elements (start + end).
	got := portsToElements([]string{"3478"})
	if len(got) != 2 {
		t.Fatalf("expected 2 elements (start+end) for single port, got %d", len(got))
	}
	if got[0].IntervalEnd {
		t.Error("element[0] should be range-start, not end")
	}
	if !got[1].IntervalEnd {
		t.Error("element[1] should be IntervalEnd marker")
	}
	// 3478 = 0x0D96 → big-endian {0x0D, 0x96}
	if got[0].Key[0] != 0x0D || got[0].Key[1] != 0x96 {
		t.Errorf("start key = %v, want {0x0D, 0x96} (3478 BE)", got[0].Key)
	}
	// end = 3479 = 0x0D97
	if got[1].Key[0] != 0x0D || got[1].Key[1] != 0x97 {
		t.Errorf("end key = %v, want {0x0D, 0x97} (3479 BE)", got[1].Key)
	}
}

func TestPortsToElements_range(t *testing.T) {
	// "16384-32768" → [16384, 32769): start=0x4000 end=0x8001
	got := portsToElements([]string{"16384-32768"})
	if len(got) != 2 {
		t.Fatalf("expected 2 elements, got %d", len(got))
	}
	if got[0].Key[0] != 0x40 || got[0].Key[1] != 0x00 {
		t.Errorf("start = %v, want {0x40, 0x00} (16384 BE)", got[0].Key)
	}
	if got[1].Key[0] != 0x80 || got[1].Key[1] != 0x01 {
		t.Errorf("end = %v, want {0x80, 0x01} (32769 BE)", got[1].Key)
	}
}

func TestPortsToElements_mixed(t *testing.T) {
	// 2 entries → 4 elements.
	got := portsToElements([]string{"3478", "16384-32768"})
	if len(got) != 4 {
		t.Fatalf("expected 4 elements (2 entries × 2 keys), got %d", len(got))
	}
}

func TestPortsToElements_emptyAndInvalidSkipped(t *testing.T) {
	// Each entry that fails parsePortOrRange contributes 0 elements.
	got := portsToElements([]string{"", "0", "65536", "abc", "10-5", "9999999"})
	if len(got) != 0 {
		t.Errorf("invalid entries should be skipped; got %d elements", len(got))
	}
}

func TestPortsToElements_maxPortRangeEncodesAsWraparound(t *testing.T) {
	// Regression for uint16 overflow at hi == 65535. The exclusive end
	// is 65536; we emit {0x00, 0x00} as the IntervalEnd key, which is
	// the kernel-standard "end of port space" wraparound encoding
	// (matches userspace `nft add element { 60000-65535 }` behavior).
	got := portsToElements([]string{"60000-65535"})
	if len(got) != 2 {
		t.Fatalf("expected 2 elements (start+end), got %d", len(got))
	}
	// start = 60000 = 0xEA60
	if got[0].Key[0] != 0xEA || got[0].Key[1] != 0x60 {
		t.Errorf("start = %v, want {0xEA, 0x60} (60000 BE)", got[0].Key)
	}
	// end = 65536 wrapped to {0x00, 0x00} — NOT {0x00, 0x00} from
	// uint16 overflow during arithmetic: we explicitly compute
	// end = uint16((uint32(hi)+1) & 0xFFFF) = 0, then encode 2 bytes.
	if got[1].Key[0] != 0x00 || got[1].Key[1] != 0x00 {
		t.Errorf("end = %v, want {0x00, 0x00} (65536 wraparound)", got[1].Key)
	}
	if !got[1].IntervalEnd {
		t.Error("end element should have IntervalEnd: true")
	}
}

func TestPortsToElements_singlePort65535(t *testing.T) {
	// Same edge: single port 65535 produces [65535, 65536) which
	// encodes start = {0xFF, 0xFF}, end = {0x00, 0x00}.
	got := portsToElements([]string{"65535"})
	if len(got) != 2 {
		t.Fatalf("expected 2 elements, got %d", len(got))
	}
	if got[0].Key[0] != 0xFF || got[0].Key[1] != 0xFF {
		t.Errorf("start = %v, want {0xFF, 0xFF} (65535 BE)", got[0].Key)
	}
	if got[1].Key[0] != 0x00 || got[1].Key[1] != 0x00 {
		t.Errorf("end = %v, want {0x00, 0x00} (65536 wraparound)", got[1].Key)
	}
}

func TestPortsToElements_dedupNotApplied(t *testing.T) {
	// portsToElements does NOT dedupe — that's the reconciler's job
	// before calling it. Same input twice → 4 elements.
	got := portsToElements([]string{"3478", "3478"})
	if len(got) != 4 {
		t.Errorf("portsToElements does not dedupe; expected 4 elements, got %d", len(got))
	}
}

func TestParsePortOrRange(t *testing.T) {
	cases := []struct {
		in        string
		wantLo    uint16
		wantHi    uint16
		wantOk    bool
		assertion string
	}{
		{"3478", 3478, 3478, true, "single port"},
		{" 3478 ", 3478, 3478, true, "trim whitespace"},
		{"16384-32768", 16384, 32768, true, "range"},
		{"1-65535", 1, 65535, true, "min-max range"},
		{"", 0, 0, false, "empty"},
		{"0", 0, 0, false, "port 0 rejected"},
		{"65536", 0, 0, false, "above 65535"},
		{"100-50", 0, 0, false, "reverse range"},
		{"abc", 0, 0, false, "non-numeric"},
		{"100-abc", 0, 0, false, "non-numeric high"},
		{"100-200-300", 0, 0, false, "two dashes (everything after first is 200-300 — non-numeric)"},
	}
	for _, c := range cases {
		t.Run(c.assertion, func(t *testing.T) {
			lo, hi, ok := parsePortOrRange(c.in)
			if ok != c.wantOk {
				t.Errorf("parsePortOrRange(%q) ok = %v, want %v", c.in, ok, c.wantOk)
			}
			if !ok {
				return
			}
			if lo != c.wantLo || hi != c.wantHi {
				t.Errorf("parsePortOrRange(%q) = (%d, %d), want (%d, %d)", c.in, lo, hi, c.wantLo, c.wantHi)
			}
		})
	}
}

func TestPeerFingerprint_stableForSameInput(t *testing.T) {
	a := peerNftSets{
		PeersV4:   []string{"10.0.0.1", "10.0.0.2"},
		TrustedV4: []string{"10.0.0.0/16"},
	}
	b := peerNftSets{
		PeersV4:   []string{"10.0.0.1", "10.0.0.2"},
		TrustedV4: []string{"10.0.0.0/16"},
	}
	if peerFingerprint(a) != peerFingerprint(b) {
		t.Errorf("identical inputs should produce identical fingerprints")
	}
}

func TestPeerFingerprint_differsForDifferentInput(t *testing.T) {
	a := peerNftSets{PeersV4: []string{"10.0.0.1"}}
	b := peerNftSets{PeersV4: []string{"10.0.0.2"}}
	if peerFingerprint(a) == peerFingerprint(b) {
		t.Errorf("different inputs should produce different fingerprints")
	}
}

func TestTenantPortsFingerprint_stableForSameInput(t *testing.T) {
	a := tenantPortSets{TCP: []string{"3478", "16384-32768"}, UDP: []string{"5349"}}
	b := tenantPortSets{TCP: []string{"3478", "16384-32768"}, UDP: []string{"5349"}}
	if tenantPortsFingerprint(a) != tenantPortsFingerprint(b) {
		t.Errorf("identical inputs should produce identical fingerprints")
	}
}

func TestTenantPortsFingerprint_differsForDifferentInput(t *testing.T) {
	a := tenantPortSets{TCP: []string{"3478"}}
	b := tenantPortSets{TCP: []string{"3479"}}
	if tenantPortsFingerprint(a) == tenantPortsFingerprint(b) {
		t.Errorf("different inputs should produce different fingerprints")
	}
}
