// nft set converger using Go libnftnl bindings (github.com/google/nftables).
//
// Replaces the previous `exec.Command("nft", "-f", "-")` approach so the
// reconciler ships a Go-only binary in its container — no /usr/sbin/nft,
// no apt-installed nftables package, no userspace version-skew with the
// host. The library talks netlink directly to the kernel; the kernel
// netfilter wire format is stable across nft binary versions.
//
// Compatibility rule observed 2026-05-09 (incident #2):
//   container nft 1.1.6 wrote set-element attributes that host nft 1.1.3
//   could not read → host nft segfaulted on every `list set`, ssh-blocked
//   the staging cluster. The "container nft >= host nft" rule from
//   incident #1 was directionally correct ONLY for the read path; the
//   write path requires the opposite ("container nft <= host nft"). The
//   intersection is "container nft == host nft" which is impractical
//   across distros.
//
// Switching to direct netlink eliminates the userspace nft from the
// equation. The kernel state ends up encoded by the kernel itself; any
// `nft` binary on any host can read it.

package main

import (
	"errors"
	"fmt"
	"net/netip"
	"sync"

	"github.com/google/nftables"
)

const (
	nftTableName = "filter"
	setPeersV4   = "cluster_peers_v4"
	setPeersV6   = "cluster_peers_v6"
	setTrustedV4 = "trusted_ranges_v4"
	setTrustedV6 = "trusted_ranges_v6"
)

// nftSets — what the reconciler writes. Order is deterministic so the
// no-op short-circuit cache works.
type nftSets struct {
	PeersV4   []string // bare IPs (e.g. "10.0.0.5")
	PeersV6   []string // bare IPs
	TrustedV4 []string // canonical CIDRs (e.g. "10.0.0.0/16", "1.2.3.4/32")
	TrustedV6 []string // canonical CIDRs
}

// applier wraps the netlink connection plumbing so reconcileOnce can
// inject a fake in tests. Single applyFn matches the previous runNft
// signature for minimum diff in reconcile.go.
type applier interface {
	apply(s nftSets) error
}

// realApplier holds an open lasting netlink connection. Reused across
// reconcile ticks; Close on shutdown.
type realApplier struct {
	mu sync.Mutex // serialises kernel writes (one transaction at a time)
}

func newRealApplier() *realApplier {
	return &realApplier{}
}

// apply opens a fresh netlink conn per reconcile (cheap; ~1ms) and
// commits one batched transaction containing flush+add for all four
// sets. Atomicity is per-set, not cross-set — the kernel applies each
// "flush set X" + "add element X { ... }" as a unit, but the four sets
// are sequenced. That's fine: each set gates a different rule chain so
// momentary inconsistency between cluster_peers and trusted_ranges
// doesn't break correctness.
func (r *realApplier) apply(s nftSets) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	conn, err := nftables.New()
	if err != nil {
		return fmt.Errorf("netlink open: %w", err)
	}
	defer conn.CloseLasting() //nolint:errcheck // close error not actionable

	table := &nftables.Table{
		Family: nftables.TableFamilyINet,
		Name:   nftTableName,
	}

	// Probe table first — bootstrap.sh creates it. If absent, the host
	// hasn't been bootstrapped or nftables.service didn't load. Bail
	// loudly so the operator hits the failure surface immediately
	// instead of the reconciler quietly failing to do anything.
	tables, err := conn.ListTables()
	if err != nil {
		return fmt.Errorf("list tables: %w", err)
	}
	if !findInetFilterTable(tables) {
		return errors.New("inet filter table not found — bootstrap.sh nftables config not loaded")
	}

	// Phase 1: ensure each of the 4 sets exists. Any new set is
	// AddSet-queued; the conn.Flush() at the end of Phase 1 commits
	// them so the kernel knows about them before Phase 2 references
	// them via FlushSet / SetAddElements.
	createdAny := false
	created := func(c bool) { createdAny = createdAny || c }
	if _, c, err := r.ensureSet(conn, table, setPeersV4, false); err != nil {
		return err
	} else {
		created(c)
	}
	if _, c, err := r.ensureSet(conn, table, setPeersV6, true); err != nil {
		return err
	} else {
		created(c)
	}
	if _, c, err := r.ensureSet(conn, table, setTrustedV4, false); err != nil {
		return err
	} else {
		created(c)
	}
	if _, c, err := r.ensureSet(conn, table, setTrustedV6, true); err != nil {
		return err
	} else {
		created(c)
	}
	if createdAny {
		if err := conn.Flush(); err != nil {
			return fmt.Errorf("commit set creations: %w", err)
		}
	}

	// Re-fetch the canonical *Set handles from the kernel. Even though
	// AddSet returns a *Set pointer, the kernel-assigned ID isn't
	// populated until after a commit. FlushSet / SetAddElements
	// resolve the set by ID internally; using a stale (ID=0) handle
	// makes the library send a netlink dump-by-name probe that fails
	// with "no such file or directory" if the conn's cache hasn't seen
	// the set yet. Re-fetching after Phase 1 commit guarantees a
	// proper handle.
	pV4, err := conn.GetSetByName(table, setPeersV4)
	if err != nil {
		return fmt.Errorf("post-create lookup %s: %w", setPeersV4, err)
	}
	pV6, err := conn.GetSetByName(table, setPeersV6)
	if err != nil {
		return fmt.Errorf("post-create lookup %s: %w", setPeersV6, err)
	}
	tV4, err := conn.GetSetByName(table, setTrustedV4)
	if err != nil {
		return fmt.Errorf("post-create lookup %s: %w", setTrustedV4, err)
	}
	tV6, err := conn.GetSetByName(table, setTrustedV6)
	if err != nil {
		return fmt.Errorf("post-create lookup %s: %w", setTrustedV6, err)
	}

	// Phase 2: flush+add per set in a single batch.
	r.flushAndAddElements(conn, pV4, ipsToElements(s.PeersV4, false))
	r.flushAndAddElements(conn, pV6, ipsToElements(s.PeersV6, true))
	r.flushAndAddElements(conn, tV4, cidrsToElements(s.TrustedV4, false))
	r.flushAndAddElements(conn, tV6, cidrsToElements(s.TrustedV6, true))

	if err := conn.Flush(); err != nil {
		return fmt.Errorf("commit member updates: %w", err)
	}
	return nil
}

// ensureSet returns the *Set handle for `name`, creating + committing
// it if absent. The bool return indicates whether a new set was added
// to the batch (the caller flushes once after Phase 1 if any was
// created; the kernel has to know about the set before Phase 2's
// element writes can reference it).
func (r *realApplier) ensureSet(conn *nftables.Conn, table *nftables.Table, name string, isV6 bool) (*nftables.Set, bool, error) {
	if existing, err := conn.GetSetByName(table, name); err == nil && existing != nil {
		return existing, false, nil
	}
	keyType := nftables.TypeIPAddr
	if isV6 {
		keyType = nftables.TypeIP6Addr
	}
	set := &nftables.Set{
		Table:    table,
		Name:     name,
		KeyType:  keyType,
		Interval: true,
	}
	if err := conn.AddSet(set, nil); err != nil {
		return nil, false, fmt.Errorf("add set %s: %w", name, err)
	}
	return set, true, nil
}

// flushAndAddElements queues a flush + element-add for the given set.
// Errors from SetAddElements are non-fatal at the queue stage —
// conn.Flush() returns the actual kernel error.
func (r *realApplier) flushAndAddElements(conn *nftables.Conn, set *nftables.Set, elems []nftables.SetElement) {
	conn.FlushSet(set)
	if len(elems) > 0 {
		_ = conn.SetAddElements(set, elems)
	}
}

// ipsToElements converts bare IPs (e.g. "10.0.0.5") to nftables
// interval-set elements. For an interval set with type ipv4_addr, a
// "single IP" is encoded as a degenerate range [ip, ip+1) — start key
// + IntervalEnd marker. The kernel's nft_set_pipapo expects this shape;
// userspace `nft list set` renders it back as a bare IP.
func ipsToElements(ips []string, isV6 bool) []nftables.SetElement {
	out := make([]nftables.SetElement, 0, len(ips)*2)
	for _, ip := range ips {
		addr, err := netip.ParseAddr(ip)
		if err != nil {
			continue // pre-validated upstream, but defensive
		}
		addr = addr.Unmap()
		if addr.Is4() != !isV6 {
			continue
		}
		next := addr.Next()
		if !next.IsValid() {
			continue // edge: 255.255.255.255 — unrealistic for our use
		}
		out = append(out,
			nftables.SetElement{Key: addrBytes(addr, isV6)},
			nftables.SetElement{Key: addrBytes(next, isV6), IntervalEnd: true},
		)
	}
	return out
}

// cidrsToElements converts CIDRs (e.g. "10.0.0.0/16") to nftables
// interval-set elements: [network_address, network_address + (1<<host_bits)).
func cidrsToElements(cidrs []string, isV6 bool) []nftables.SetElement {
	out := make([]nftables.SetElement, 0, len(cidrs)*2)
	for _, c := range cidrs {
		p, err := netip.ParsePrefix(c)
		if err != nil {
			continue
		}
		p = p.Masked() // snap to network address
		if p.Addr().Is4() != !isV6 {
			continue
		}
		startBytes := addrBytes(p.Addr(), isV6)
		endBytes, ok := nextNetwork(p.Addr(), p.Bits(), isV6)
		if !ok {
			continue
		}
		out = append(out,
			nftables.SetElement{Key: startBytes},
			nftables.SetElement{Key: endBytes, IntervalEnd: true},
		)
	}
	return out
}

// addrBytes returns the canonical 4- or 16-byte slice for the address.
func addrBytes(a netip.Addr, isV6 bool) []byte {
	if isV6 {
		b := a.As16()
		return b[:]
	}
	b := a.As4()
	return b[:]
}

// nextNetwork returns the start of the next non-overlapping network
// after the given network/prefix. Used as the IntervalEnd key for CIDR
// ranges: for 10.0.0.0/16 → 10.1.0.0; for fd00::/8 → fe00::.
// Returns ok=false on edge cases (overflow at /0, invalid prefix).
func nextNetwork(a netip.Addr, bits int, isV6 bool) ([]byte, bool) {
	totalBits := 32
	if isV6 {
		totalBits = 128
	}
	if bits < 0 || bits > totalBits {
		return nil, false
	}
	hostBits := totalBits - bits
	return addPow2(a, hostBits, isV6), true
}

// addPow2 returns a + (1 << exp), clamping to all-ones on overflow.
// For our use, exp = totalBits - prefix_bits; e.g. /16 v4 → exp=16 →
// add 0x10000.
func addPow2(a netip.Addr, exp int, isV6 bool) []byte {
	var b []byte
	if isV6 {
		x := a.As16()
		b = x[:]
	} else {
		x := a.As4()
		b = x[:]
	}
	// Add 1 at position (len*8 - exp) from the LSB end.
	// Carry-propagate from the right.
	idx := len(b) - 1 - exp/8
	if idx < 0 {
		// /0 — wrap to all-ones (kernel rejects /0 anyway, validator
		// catches; this is defensive).
		for i := range b {
			b[i] = 0xFF
		}
		return b
	}
	carry := uint16(1) << uint(exp%8)
	for i := idx; i >= 0; i-- {
		v := uint16(b[i]) + carry
		b[i] = byte(v & 0xFF)
		carry = v >> 8
		if carry == 0 {
			break
		}
	}
	return b
}

// findInetFilterTable returns true if the kernel has the `inet filter`
// table that bootstrap.sh declares.
func findInetFilterTable(tables []*nftables.Table) bool {
	for _, t := range tables {
		if t.Family == nftables.TableFamilyINet && t.Name == nftTableName {
			return true
		}
	}
	return false
}

// preflightFilterTable opens a netlink connection at startup and
// verifies the inet filter table exists. Bootstrap.sh creates it; if
// absent, nftables.service didn't load on this host and we should
// idle-with-loud-log instead of crashlooping on every applier call.
func preflightFilterTable() error {
	conn, err := nftables.New()
	if err != nil {
		return fmt.Errorf("netlink open: %w", err)
	}
	defer conn.CloseLasting() //nolint:errcheck
	tables, err := conn.ListTables()
	if err != nil {
		return fmt.Errorf("list tables: %w", err)
	}
	if !findInetFilterTable(tables) {
		return errors.New("inet filter table not found in kernel netfilter — bootstrap.sh must run before this reconciler")
	}
	return nil
}
