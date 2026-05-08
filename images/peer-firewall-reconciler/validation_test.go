package main

import "testing"

func TestParseIPOrCIDR_acceptsAllForms(t *testing.T) {
	cases := []struct {
		in            string
		wantCanonical string
		wantFamily    string
	}{
		{"1.2.3.4", "1.2.3.4/32", "v4"},
		{"10.0.0.0/16", "10.0.0.0/16", "v4"},
		{"10.0.0.5/16", "10.0.0.0/16", "v4"}, // host bits get masked
		{"2001:db8::1", "2001:db8::1/128", "v6"},
		{"fd00::/8", "fd00::/8", "v6"},
		// Trim leading/trailing whitespace
		{"  10.0.0.0/8  ", "10.0.0.0/8", "v4"},
	}
	for _, c := range cases {
		t.Run(c.in, func(t *testing.T) {
			got, family, ok := parseIPOrCIDR(c.in)
			if !ok {
				t.Fatalf("parseIPOrCIDR(%q): ok=false, want ok=true", c.in)
			}
			if got != c.wantCanonical {
				t.Errorf("canonical=%q, want %q", got, c.wantCanonical)
			}
			if family != c.wantFamily {
				t.Errorf("family=%q, want %q", family, c.wantFamily)
			}
		})
	}
}

func TestParseIPOrCIDR_rejectsBadInput(t *testing.T) {
	cases := []string{
		"",                      // empty
		"   ",                   // whitespace only
		"10.0.0.0/0",            // /0 forbidden
		"::/0",                  // /0 forbidden
		"10.0.0.0/33",           // out of range v4
		"fd00::/129",            // out of range v6
		"1.2.3",                 // truncated v4
		"not-an-ip",             // garbage
		":::",                   // malformed v6
		"1.2.3.4 }; flush",      // injection-shaped
		"10.0.0.0/abc",          // non-numeric prefix
	}
	for _, in := range cases {
		t.Run(in, func(t *testing.T) {
			_, _, ok := parseIPOrCIDR(in)
			if ok {
				t.Errorf("parseIPOrCIDR(%q): ok=true, want ok=false", in)
			}
		})
	}
}

func TestParseBareIP_acceptsSingleAddrs(t *testing.T) {
	cases := []struct {
		in            string
		wantCanonical string
		wantFamily    string
	}{
		{"1.2.3.4", "1.2.3.4/32", "v4"},
		{"2001:db8::1", "2001:db8::1/128", "v6"},
		{"  1.2.3.4  ", "1.2.3.4/32", "v4"},
	}
	for _, c := range cases {
		t.Run(c.in, func(t *testing.T) {
			got, family, ok := parseBareIP(c.in)
			if !ok || got != c.wantCanonical || family != c.wantFamily {
				t.Errorf("parseBareIP(%q) = %q,%q,%v ; want %q,%q,true",
					c.in, got, family, ok, c.wantCanonical, c.wantFamily)
			}
		})
	}
}

func TestParseBareIP_rejectsCIDRandJunk(t *testing.T) {
	cases := []string{
		"10.0.0.0/16",  // CIDR not allowed for bare path
		"fd00::/8",     // CIDR not allowed
		"1.2.3.4/32",   // even /32 not allowed (caller wants bare semantics)
		"",
		"   ",
		"junk",
	}
	for _, in := range cases {
		t.Run(in, func(t *testing.T) {
			_, _, ok := parseBareIP(in)
			if ok {
				t.Errorf("parseBareIP(%q): ok=true, want ok=false", in)
			}
		})
	}
}

func TestStripPrefix(t *testing.T) {
	cases := map[string]string{
		"10.0.0.5/32":         "10.0.0.5",
		"2001:db8::1/128":     "2001:db8::1",
		"10.0.0.0/16":         "10.0.0.0",
		"1.2.3.4":             "1.2.3.4", // no prefix → unchanged
		"":                    "",
	}
	for in, want := range cases {
		if got := stripPrefix(in); got != want {
			t.Errorf("stripPrefix(%q) = %q, want %q", in, got, want)
		}
	}
}
