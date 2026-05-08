// nft script generator + executor. Builds an atomic `nft -f -` script
// that flushes each managed set and re-adds elements. Safe to run
// concurrently with other writers (e.g. worker-firewall-reconciler
// owning tenant_ports_{tcp,udp}) because nft commands are per-set:
// flushing cluster_peers_v4 doesn't touch trusted_ranges_v4 or
// tenant_ports_tcp.

package main

import (
	"bytes"
	"context"
	"fmt"
	"os/exec"
	"strings"
)

const (
	nftFamily = "inet"
	nftTable  = "filter"

	setPeersV4   = "cluster_peers_v4"
	setPeersV6   = "cluster_peers_v6"
	setTrustedV4 = "trusted_ranges_v4"
	setTrustedV6 = "trusted_ranges_v6"
)

// nftSets — what the reconciler writes. Order is deterministic so
// the rendered script is byte-stable for the no-op short-circuit cache.
type nftSets struct {
	PeersV4   []string // bare IPs (e.g. "10.0.0.5")
	PeersV6   []string // bare IPs (e.g. "fd00::1")
	TrustedV4 []string // CIDRs (e.g. "10.0.0.0/16", "1.2.3.4/32")
	TrustedV6 []string // CIDRs (e.g. "fd00::/8")
}

// buildNftScript renders an atomic flush+add script for all four
// managed sets. Empty element lists render as a `flush set` line with
// no `add element` follow-up — equivalent to "set is empty", which is
// a valid nft state and matches a brand-new cluster.
//
// Output format (deterministic, sorted by caller):
//
//	flush set inet filter cluster_peers_v4
//	add element inet filter cluster_peers_v4 { 10.0.0.1, 10.0.0.2 }
//	flush set inet filter cluster_peers_v6
//	flush set inet filter trusted_ranges_v4
//	add element inet filter trusted_ranges_v4 { 10.0.0.0/16 }
//	flush set inet filter trusted_ranges_v6
//	add element inet filter trusted_ranges_v6 { fd00::/8 }
func buildNftScript(s nftSets) []byte {
	var b bytes.Buffer
	emit := func(name string, elems []string) {
		fmt.Fprintf(&b, "flush set %s %s %s\n", nftFamily, nftTable, name)
		if len(elems) > 0 {
			fmt.Fprintf(&b, "add element %s %s %s { %s }\n",
				nftFamily, nftTable, name, strings.Join(elems, ", "))
		}
	}
	emit(setPeersV4, s.PeersV4)
	emit(setPeersV6, s.PeersV6)
	emit(setTrustedV4, s.TrustedV4)
	emit(setTrustedV6, s.TrustedV6)
	return b.Bytes()
}

// realNftRunner pipes the script into `nft -f -`. Used as the default
// reconciler.runNft; tests inject a fake instead of swapping a global.
func realNftRunner(script []byte) error {
	ctx, cancel := context.WithTimeout(context.Background(), nftTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "nft", "-f", "-")
	cmd.Stdin = bytes.NewReader(script)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("nft -f -: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// nftMissingSets probes the host for each of the four sets the
// reconciler manages. Returns the names of any that don't exist, or
// an empty slice if all four are present. Used at startup to detect
// nodes that haven't been re-bootstrapped post-Phase-1 (where the
// trusted_ranges_v{4,6} sets didn't exist) so the reconciler can
// idle-with-loud-log instead of crashlooping on every nft apply.
func nftMissingSets() []string {
	want := []string{setPeersV4, setPeersV6, setTrustedV4, setTrustedV6}
	var missing []string
	for _, s := range want {
		if !nftSetExists(s) {
			missing = append(missing, s)
		}
	}
	return missing
}

// nftSetExists checks whether the named set is declared on the host.
// hostNetwork shares the netfilter namespace, so a regular `nft list`
// inside the container reads the host ruleset.
func nftSetExists(name string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), nftTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "nft", "list", "set", nftFamily, nftTable, name)
	if err := cmd.Run(); err != nil {
		return false
	}
	return true
}
