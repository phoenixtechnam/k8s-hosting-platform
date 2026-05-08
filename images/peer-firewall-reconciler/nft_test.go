package main

import (
	"strings"
	"testing"
)

func TestBuildNftScript_allFourSetsPopulated(t *testing.T) {
	got := string(buildNftScript(nftSets{
		PeersV4:   []string{"10.0.0.1", "10.0.0.2"},
		PeersV6:   []string{"fd00::1"},
		TrustedV4: []string{"10.0.0.0/16", "1.2.3.4/32"},
		TrustedV6: []string{"fd00::/8"},
	}))
	wantParts := []string{
		"flush set inet filter cluster_peers_v4",
		"add element inet filter cluster_peers_v4 { 10.0.0.1, 10.0.0.2 }",
		"flush set inet filter cluster_peers_v6",
		"add element inet filter cluster_peers_v6 { fd00::1 }",
		"flush set inet filter trusted_ranges_v4",
		"add element inet filter trusted_ranges_v4 { 10.0.0.0/16, 1.2.3.4/32 }",
		"flush set inet filter trusted_ranges_v6",
		"add element inet filter trusted_ranges_v6 { fd00::/8 }",
	}
	for _, p := range wantParts {
		if !strings.Contains(got, p) {
			t.Errorf("missing %q in script:\n%s", p, got)
		}
	}
}

func TestBuildNftScript_emptySetsRenderFlushOnly(t *testing.T) {
	got := string(buildNftScript(nftSets{}))
	wantLines := []string{
		"flush set inet filter cluster_peers_v4",
		"flush set inet filter cluster_peers_v6",
		"flush set inet filter trusted_ranges_v4",
		"flush set inet filter trusted_ranges_v6",
	}
	for _, l := range wantLines {
		if !strings.Contains(got, l) {
			t.Errorf("missing %q in script:\n%s", l, got)
		}
	}
	if strings.Contains(got, "add element") {
		t.Errorf("empty sets should not render add element lines:\n%s", got)
	}
}

func TestBuildNftScript_partialPopulation(t *testing.T) {
	// Only peers v4 + trusted v6 — verify mixed empty/non-empty is OK.
	got := string(buildNftScript(nftSets{
		PeersV4:   []string{"10.0.0.1"},
		TrustedV6: []string{"fd00::/8"},
	}))
	if !strings.Contains(got, "add element inet filter cluster_peers_v4 { 10.0.0.1 }") {
		t.Errorf("missing peers_v4 add element:\n%s", got)
	}
	if strings.Contains(got, "add element inet filter cluster_peers_v6") {
		t.Errorf("peers_v6 should not have add element with empty list:\n%s", got)
	}
	if !strings.Contains(got, "add element inet filter trusted_ranges_v6 { fd00::/8 }") {
		t.Errorf("missing trusted_ranges_v6 add element:\n%s", got)
	}
	if strings.Contains(got, "add element inet filter trusted_ranges_v4") {
		t.Errorf("trusted_ranges_v4 should not have add element with empty list:\n%s", got)
	}
}

func TestBuildNftScript_deterministic(t *testing.T) {
	// Same input twice → identical bytes (powers the no-op short-circuit cache).
	a := buildNftScript(nftSets{PeersV4: []string{"10.0.0.1"}, TrustedV4: []string{"10.0.0.0/8"}})
	b := buildNftScript(nftSets{PeersV4: []string{"10.0.0.1"}, TrustedV4: []string{"10.0.0.0/8"}})
	if string(a) != string(b) {
		t.Errorf("non-deterministic output:\n a=%q\n b=%q", a, b)
	}
}
