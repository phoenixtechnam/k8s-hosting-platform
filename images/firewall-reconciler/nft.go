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
	"log/slog"
	"math/big"
	"net/netip"
	"sort"
	"strconv"
	"sync"

	"github.com/google/nftables"
)

const (
	nftTableName = "filter"
	// Peer reconciler sets — cluster-scope, IP/CIDR keyed.
	setPeersV4   = "cluster_peers_v4"
	setPeersV6   = "cluster_peers_v6"
	setTrustedV4 = "trusted_ranges_v4"
	setTrustedV6 = "trusted_ranges_v6"
	// Tenant-port reconciler sets — node-scope, inet_service (port) keyed.
	setTenantTCP = "tenant_ports_tcp"
	setTenantUDP = "tenant_ports_udp"
	// F1 — CrowdSec L4 blocklist sets — cluster-scope, IP/CIDR keyed.
	// Bootstrap.sh declares with `flags interval,timeout` so per-element
	// TTLs from CrowdSec decisions auto-expire kernel-side as a safety
	// net even if the reconciler stops running.
	setCrowdsecV4 = "crowdsec_blocklist_v4"
	setCrowdsecV6 = "crowdsec_blocklist_v6"
)

// peerNftSets — what the peer reconciler writes. Order is deterministic
// so the per-set fingerprint cache works.
type peerNftSets struct {
	PeersV4   []string // bare IPs (e.g. "10.0.0.5")
	PeersV6   []string // bare IPs
	TrustedV4 []string // canonical CIDRs (e.g. "10.0.0.0/16", "1.2.3.4/32")
	TrustedV6 []string // canonical CIDRs
}

// tenantPortSets — what the tenant-port reconciler writes. Each entry is
// either a bare port ("3478") or a port range ("16384-32768"). Sorted +
// deduped so the per-set fingerprint cache short-circuits identical
// ticks.
type tenantPortSets struct {
	TCP []string
	UDP []string
}

// applier wraps the netlink connection plumbing so reconcile loops can
// inject a fake in tests. Each loop has an apply (write desired state)
// and observe (read current kernel state) method.
//
// The observe* methods are used by reconcile to detect out-of-band
// kernel-state divergence — e.g. an operator running `nft -f
// /etc/nftables.conf` to reset corrupt state, or a kernel reboot
// stripping the sets to bootstrap-time empty. Without observing,
// the reconciler's in-process fingerprint cache could think state
// was already applied while the kernel actually shows something
// different.
//
// Each observe method returns a canonical fingerprint string matching
// the format peerFingerprint / tenantPortsFingerprint produces for
// the desired state, so reconcile can compare them directly. On a
// netlink read error the implementation returns ("", err); the
// reconcile path falls back to "force apply" behavior in that case.
type applier interface {
	applyPeerSets(s peerNftSets) error
	applyTenantPorts(s tenantPortSets) error
	observePeerFingerprint() (string, error)
	observeTenantPortsFingerprint() (string, error)
	// F1+F6 Stage B — CrowdSec L4 blocklist apply method. Stub-only
	// in this commit (logs what would be applied + returns nil).
	// Stage B.5 fills in the real netlink writes — flush+add with
	// per-element timeouts mapped from LAPI durations.
	// Stage A's constructor still downgrades enforce→dryrun so this
	// path is unreachable until Stage C lands the operator toggle +
	// removes the downgrade.
	applyCrowdsecBlocklist(s crowdsecBlocklist) error
}

// realApplier holds an open lasting netlink connection. Reused across
// reconcile ticks; Close on shutdown.
type realApplier struct {
	mu sync.Mutex // serialises kernel writes (one transaction at a time)
}

func newRealApplier() *realApplier {
	return &realApplier{}
}

// applyPeerSets writes the four peer/trusted sets via one batched
// netlink transaction. Two-phase commit:
//   Phase 1: ensure each set exists; commit if any was created so the
//            kernel populates *Set IDs before Phase 2 references them.
//   Phase 2: re-fetch canonical handles, flush + add per set, commit.
//
// Atomicity is per-set, not cross-set — the kernel applies each "flush
// set X" + "add element X" as a unit, but the four sets are sequenced.
// Acceptable: each set gates a different rule chain, momentary
// inconsistency between cluster_peers and trusted_ranges does not
// break correctness.
func (r *realApplier) applyPeerSets(s peerNftSets) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	conn, table, err := r.openAndPreflight()
	if err != nil {
		return err
	}
	defer conn.CloseLasting() //nolint:errcheck // close error not actionable

	createdAny := false
	created := func(c bool) { createdAny = createdAny || c }
	if _, c, err := r.ensureAddrSet(conn, table, setPeersV4, false); err != nil {
		return err
	} else {
		created(c)
	}
	if _, c, err := r.ensureAddrSet(conn, table, setPeersV6, true); err != nil {
		return err
	} else {
		created(c)
	}
	if _, c, err := r.ensureAddrSet(conn, table, setTrustedV4, false); err != nil {
		return err
	} else {
		created(c)
	}
	if _, c, err := r.ensureAddrSet(conn, table, setTrustedV6, true); err != nil {
		return err
	} else {
		created(c)
	}
	if createdAny {
		if err := conn.Flush(); err != nil {
			return fmt.Errorf("commit set creations: %w", err)
		}
	}

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

	r.flushAndAddElements(conn, pV4, ipsToElements(s.PeersV4, false))
	r.flushAndAddElements(conn, pV6, ipsToElements(s.PeersV6, true))
	r.flushAndAddElements(conn, tV4, cidrsToElements(s.TrustedV4, false))
	r.flushAndAddElements(conn, tV6, cidrsToElements(s.TrustedV6, true))

	if err := conn.Flush(); err != nil {
		return fmt.Errorf("commit member updates: %w", err)
	}
	return nil
}

// applyTenantPorts writes tenant_ports_{tcp,udp} via the same two-phase
// commit shape as applyPeerSets but with inet_service (16-bit port)
// interval keys instead of address keys.
func (r *realApplier) applyTenantPorts(s tenantPortSets) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	conn, table, err := r.openAndPreflight()
	if err != nil {
		return err
	}
	defer conn.CloseLasting() //nolint:errcheck

	createdAny := false
	created := func(c bool) { createdAny = createdAny || c }
	if _, c, err := r.ensurePortSet(conn, table, setTenantTCP); err != nil {
		return err
	} else {
		created(c)
	}
	if _, c, err := r.ensurePortSet(conn, table, setTenantUDP); err != nil {
		return err
	} else {
		created(c)
	}
	if createdAny {
		if err := conn.Flush(); err != nil {
			return fmt.Errorf("commit tenant set creations: %w", err)
		}
	}

	tcpSet, err := conn.GetSetByName(table, setTenantTCP)
	if err != nil {
		return fmt.Errorf("post-create lookup %s: %w", setTenantTCP, err)
	}
	udpSet, err := conn.GetSetByName(table, setTenantUDP)
	if err != nil {
		return fmt.Errorf("post-create lookup %s: %w", setTenantUDP, err)
	}

	r.flushAndAddElements(conn, tcpSet, portsToElements(s.TCP))
	r.flushAndAddElements(conn, udpSet, portsToElements(s.UDP))

	if err := conn.Flush(); err != nil {
		return fmt.Errorf("commit tenant member updates: %w", err)
	}
	return nil
}

// applyCrowdsecBlocklist — STUB for Stage B. Logs what would be applied
// + returns nil. Stage B.5 lands the real netlink writes:
//
//   - GetSetByName on crowdsec_blocklist_v4 / v6
//   - For each prefix: SetElement with Timeout = per-element TTL from LAPI
//   - flush+add cycle via the same conn.SetAddElements / SetDeleteElements
//     pattern peer/tenant sets use, but with timeout per element
//
// The crowdsec_blocklist_v4/v6 sets are declared by bootstrap.sh with
// `flags interval,timeout` so the kernel TTL machinery is already
// armed; we just need to write elements with explicit per-row timeouts.
//
// Why stub now: keeping Stage B focused on the data path (LAPI fetch +
// exclusion compute + cap + self-protect) means the dangerous nft-write
// path doesn't co-mingle with the safer arithmetic. Stage B.5 is its
// own focused review.
func (r *realApplier) applyCrowdsecBlocklist(s crowdsecBlocklist) error {
	slog.Info("crowdsec-l4: nft apply STUB (Stage B has no kernel writes)",
		"v4_count", len(s.V4),
		"v6_count", len(s.V6),
	)
	return nil
}

// observePeerFingerprint reads the current kernel state of the four
// peer/trusted sets via netlink and computes the canonical fingerprint
// string. Any decode failure (set missing, malformed elements,
// netlink error) returns ("", err) — reconcile interprets that as
// "must apply" so we don't silently skip writes when state is unknown.
func (r *realApplier) observePeerFingerprint() (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	conn, table, err := r.openAndPreflight()
	if err != nil {
		return "", err
	}
	defer conn.CloseLasting() //nolint:errcheck

	pV4, err := r.readAddrSet(conn, table, setPeersV4, false)
	if err != nil {
		return "", err
	}
	pV6, err := r.readAddrSet(conn, table, setPeersV6, true)
	if err != nil {
		return "", err
	}
	tV4, err := r.readCidrSet(conn, table, setTrustedV4, false)
	if err != nil {
		return "", err
	}
	tV6, err := r.readCidrSet(conn, table, setTrustedV6, true)
	if err != nil {
		return "", err
	}
	return peerFingerprint(peerNftSets{
		PeersV4: pV4, PeersV6: pV6, TrustedV4: tV4, TrustedV6: tV6,
	}), nil
}

// observeTenantPortsFingerprint reads the two tenant_ports_{tcp,udp}
// sets and computes the canonical fingerprint. Same error semantics
// as observePeerFingerprint — empty + error means "force apply".
func (r *realApplier) observeTenantPortsFingerprint() (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	conn, table, err := r.openAndPreflight()
	if err != nil {
		return "", err
	}
	defer conn.CloseLasting() //nolint:errcheck

	tcp, err := r.readPortSet(conn, table, setTenantTCP)
	if err != nil {
		return "", err
	}
	udp, err := r.readPortSet(conn, table, setTenantUDP)
	if err != nil {
		return "", err
	}
	return tenantPortsFingerprint(tenantPortSets{TCP: tcp, UDP: udp}), nil
}

// readAddrSet returns the bare IPs encoded in an interval address set.
// A "bare IP" is encoded as a degenerate range [ip, ip+1) — start key
// + IntervalEnd marker. We pair consecutive elements and recover the
// start address; non-degenerate ranges are skipped (cluster_peers
// only ever holds bare IPs by construction). Empty / missing set
// returns nil — matches "no elements".
func (r *realApplier) readAddrSet(conn *nftables.Conn, table *nftables.Table, name string, isV6 bool) ([]string, error) {
	set, err := conn.GetSetByName(table, name)
	if err != nil {
		// Not-found is treated as empty (the bootstrap may not have
		// run yet on a fresh node; in that case the apply path will
		// create the set + populate it).
		return nil, nil //nolint:nilerr
	}
	elems, err := conn.GetSetElements(set)
	if err != nil {
		return nil, fmt.Errorf("get %s elements: %w", name, err)
	}
	out := []string{}
	var pendingStart netip.Addr
	havePending := false
	for _, e := range elems {
		if !e.IntervalEnd {
			a, ok := bytesToAddr(e.Key, isV6)
			if !ok {
				havePending = false
				continue
			}
			pendingStart = a
			havePending = true
			continue
		}
		if !havePending {
			continue
		}
		endA, ok := bytesToAddr(e.Key, isV6)
		havePending = false
		if !ok {
			continue
		}
		// Bare-IP encoding: [ip, ip+1). If the gap is 1, recover ip.
		next := pendingStart.Next()
		if next == endA {
			out = append(out, pendingStart.String())
		}
		// Else it's a CIDR-shaped range in an address set, which
		// shouldn't happen for cluster_peers — skip silently.
	}
	sort.Strings(out)
	return out, nil
}

// readCidrSet returns the CIDR strings encoded in an interval address
// set used for trusted_ranges. Each CIDR is a [network, network+2^k)
// range. We pair consecutive elements and check that the gap is a
// power of two; if so, recover the prefix bits. Non-power-of-two
// gaps are skipped (defensive — would indicate a non-CIDR write
// landed in the trusted_ranges set).
func (r *realApplier) readCidrSet(conn *nftables.Conn, table *nftables.Table, name string, isV6 bool) ([]string, error) {
	set, err := conn.GetSetByName(table, name)
	if err != nil {
		return nil, nil //nolint:nilerr
	}
	elems, err := conn.GetSetElements(set)
	if err != nil {
		return nil, fmt.Errorf("get %s elements: %w", name, err)
	}
	out := []string{}
	totalBits := 32
	if isV6 {
		totalBits = 128
	}
	var pendingStart netip.Addr
	havePending := false
	for _, e := range elems {
		if !e.IntervalEnd {
			a, ok := bytesToAddr(e.Key, isV6)
			if !ok {
				havePending = false
				continue
			}
			pendingStart = a
			havePending = true
			continue
		}
		if !havePending {
			continue
		}
		havePending = false
		endA, ok := bytesToAddr(e.Key, isV6)
		if !ok {
			continue
		}
		bits, ok := prefixFromInterval(pendingStart, endA, totalBits)
		if !ok {
			continue
		}
		out = append(out, pendingStart.String()+"/"+strconv.Itoa(bits))
	}
	sort.Strings(out)
	return out, nil
}

// readPortSet returns the canonical port-or-range strings encoded in
// a tenant_ports_{tcp,udp} interval set. Decoding mirrors
// portsToElements: for each (start, end-exclusive) pair, if
// end == start+1 emit "<port>", else emit "<lo>-<hi>" with hi=end-1.
// Handles the wraparound case where end-bytes == {0x00, 0x00} (which
// portsToElements emits when the high port is 65535).
func (r *realApplier) readPortSet(conn *nftables.Conn, table *nftables.Table, name string) ([]string, error) {
	set, err := conn.GetSetByName(table, name)
	if err != nil {
		return nil, nil //nolint:nilerr
	}
	elems, err := conn.GetSetElements(set)
	if err != nil {
		return nil, fmt.Errorf("get %s elements: %w", name, err)
	}
	out := []string{}
	var pendingStart uint16
	havePending := false
	for _, e := range elems {
		if !e.IntervalEnd {
			p, ok := bytesToPort(e.Key)
			if !ok {
				havePending = false
				continue
			}
			pendingStart = p
			havePending = true
			continue
		}
		if !havePending {
			continue
		}
		havePending = false
		endRaw, ok := bytesToPort(e.Key)
		if !ok {
			continue
		}
		// Wraparound: portsToElements emits {0x00, 0x00} as the
		// IntervalEnd when hi == 65535. Convert the observed 0 back to
		// the conceptual 65536 by treating the inclusive end as 65535.
		var hi uint16
		if endRaw == 0 {
			hi = 65535
		} else if endRaw <= pendingStart {
			// Non-wraparound but end <= start: malformed range, skip.
			continue
		} else {
			hi = endRaw - 1
		}
		if hi == pendingStart {
			out = append(out, strconv.FormatUint(uint64(pendingStart), 10))
		} else {
			out = append(out,
				strconv.FormatUint(uint64(pendingStart), 10)+
					"-"+strconv.FormatUint(uint64(hi), 10))
		}
	}
	sort.Strings(out)
	return out, nil
}

// bytesToAddr is the inverse of addrBytes.
func bytesToAddr(b []byte, isV6 bool) (netip.Addr, bool) {
	if isV6 {
		if len(b) != 16 {
			return netip.Addr{}, false
		}
		var a16 [16]byte
		copy(a16[:], b)
		return netip.AddrFrom16(a16), true
	}
	if len(b) != 4 {
		return netip.Addr{}, false
	}
	var a4 [4]byte
	copy(a4[:], b)
	return netip.AddrFrom4(a4), true
}

// bytesToPort is the inverse of portBytes.
func bytesToPort(b []byte) (uint16, bool) {
	if len(b) != 2 {
		return 0, false
	}
	return (uint16(b[0]) << 8) | uint16(b[1]), true
}

// prefixFromInterval recovers the CIDR prefix length from a
// [network, network+2^k) range. Returns the prefix bits and true if
// (end - network) is a non-zero power of two; false otherwise. Uses
// math/big because IPv6 spans 128 bits.
func prefixFromInterval(start, end netip.Addr, totalBits int) (int, bool) {
	if start == end {
		return 0, false
	}
	startBig := addrToBig(start)
	endBig := addrToBig(end)
	diff := new(big.Int).Sub(endBig, startBig)
	if diff.Sign() <= 0 {
		return 0, false
	}
	// k = log2(diff) iff diff is a power of two
	bitLen := diff.BitLen() // index of the highest set bit + 1
	// power-of-two test: only the high bit should be set, all others zero
	pow2 := new(big.Int).Lsh(big.NewInt(1), uint(bitLen-1))
	if diff.Cmp(pow2) != 0 {
		return 0, false
	}
	k := bitLen - 1
	bits := totalBits - k
	if bits < 0 || bits > totalBits {
		return 0, false
	}
	return bits, true
}

// addrToBig converts a netip.Addr (4 or 16 bytes) to a math/big.Int
// (unsigned). Used by prefixFromInterval for log2-of-difference math.
func addrToBig(a netip.Addr) *big.Int {
	if a.Is6() && !a.Is4() {
		b := a.As16()
		return new(big.Int).SetBytes(b[:])
	}
	b := a.As4()
	return new(big.Int).SetBytes(b[:])
}

// openAndPreflight opens a fresh netlink conn and verifies the inet
// filter table exists. Shared between applyPeerSets and
// applyTenantPorts so the same precondition error surface applies to
// both.
func (r *realApplier) openAndPreflight() (*nftables.Conn, *nftables.Table, error) {
	conn, err := nftables.New()
	if err != nil {
		return nil, nil, fmt.Errorf("netlink open: %w", err)
	}
	table := &nftables.Table{
		Family: nftables.TableFamilyINet,
		Name:   nftTableName,
	}
	tables, err := conn.ListTables()
	if err != nil {
		_ = conn.CloseLasting()
		return nil, nil, fmt.Errorf("list tables: %w", err)
	}
	if !findInetFilterTable(tables) {
		_ = conn.CloseLasting()
		return nil, nil, errors.New("inet filter table not found — bootstrap.sh nftables config not loaded")
	}
	return conn, table, nil
}

// ensureAddrSet returns the *Set handle for `name`, creating it if
// absent. Used for the four IP/CIDR-keyed peer/trusted sets. The bool
// return indicates whether a new set was added to the batch (caller
// flushes after Phase 1 if any was created so the kernel populates
// *Set IDs before Phase 2's element writes resolve them).
func (r *realApplier) ensureAddrSet(conn *nftables.Conn, table *nftables.Table, name string, isV6 bool) (*nftables.Set, bool, error) {
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

// ensurePortSet is the inet_service variant of ensureAddrSet — for
// tenant_ports_{tcp,udp}. Same semantics: idempotent fetch-or-create,
// returns true if created so the caller knows to commit Phase 1.
func (r *realApplier) ensurePortSet(conn *nftables.Conn, table *nftables.Table, name string) (*nftables.Set, bool, error) {
	if existing, err := conn.GetSetByName(table, name); err == nil && existing != nil {
		return existing, false, nil
	}
	set := &nftables.Set{
		Table:    table,
		Name:     name,
		KeyType:  nftables.TypeInetService,
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

// portsToElements converts ["3478", "16384-32768"] etc. to nftables
// interval-set elements with type inet_service. The kernel encodes
// inet_service as 2 big-endian bytes (uint16). For an interval set, a
// "single port 3478" is a degenerate range [3478, 3479); a "range
// 16384-32768" is [16384, 32769) — IntervalEnd is exclusive, so we add
// 1 to the upper bound.
//
// Edge case: when hi == 65535 (or single port "65535"), the exclusive
// end is 65536 which doesn't fit in uint16. The kernel + userspace
// nft both encode this as a wraparound to 0 — i.e. the IntervalEnd
// key is {0x00, 0x00}, and the kernel's pipapo set comparator treats
// "end == 0 with start > 0" as "end of port space". We mirror that
// convention so a tenant exposing ports up to 65535 produces the same
// kernel state the bash reconciler did via `nft add element`.
//
// Inputs MUST already be validated by tenantPortRegex (digits or
// digits-digits, both <=65535). Out-of-range or unparseable entries
// are silently skipped — the validator upstream is the authoritative
// gate.
func portsToElements(ports []string) []nftables.SetElement {
	out := make([]nftables.SetElement, 0, len(ports)*2)
	for _, p := range ports {
		lo, hi, ok := parsePortOrRange(p)
		if !ok {
			continue
		}
		// Promote to uint32 so hi==65535 → end==65536 doesn't wrap
		// silently in arithmetic; then truncate to uint16 for the
		// kernel encoding (which expects the wraparound to be the
		// "end of port space" sentinel — see func comment).
		end := uint16((uint32(hi) + 1) & 0xFFFF)
		out = append(out,
			nftables.SetElement{Key: portBytes(lo)},
			nftables.SetElement{Key: portBytes(end), IntervalEnd: true},
		)
	}
	return out
}

// parsePortOrRange accepts "3478" or "16384-32768" and returns
// (lo, hi, ok). Single ports return lo==hi. Bounds: 1..65535.
// Reverse ranges (lo > hi) are rejected. Trims surrounding whitespace.
func parsePortOrRange(s string) (lo, hi uint16, ok bool) {
	s = trimSpaces(s)
	if s == "" {
		return 0, 0, false
	}
	dash := -1
	for i := 0; i < len(s); i++ {
		if s[i] == '-' {
			dash = i
			break
		}
	}
	if dash < 0 {
		v, ok := parsePort(s)
		if !ok {
			return 0, 0, false
		}
		return v, v, true
	}
	a, ok1 := parsePort(s[:dash])
	b, ok2 := parsePort(s[dash+1:])
	if !ok1 || !ok2 || a > b {
		return 0, 0, false
	}
	return a, b, true
}

// parsePort accepts a 1..5-digit decimal in 1..65535. Leading zeros
// allowed (jq-side validation rejects them, but we re-check here for
// defense in depth). Returns (port, true) on success.
func parsePort(s string) (uint16, bool) {
	if s == "" || len(s) > 5 {
		return 0, false
	}
	var v uint32
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c < '0' || c > '9' {
			return 0, false
		}
		v = v*10 + uint32(c-'0')
		if v > 65535 {
			return 0, false
		}
	}
	if v == 0 {
		return 0, false
	}
	return uint16(v), true
}

// trimSpaces strips ASCII whitespace; net/strings is overkill for the
// hot path — nftables interval-set element parsing happens once per
// reconcile tick per port.
func trimSpaces(s string) string {
	for len(s) > 0 && isWS(s[0]) {
		s = s[1:]
	}
	for len(s) > 0 && isWS(s[len(s)-1]) {
		s = s[:len(s)-1]
	}
	return s
}

func isWS(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

// portBytes returns the 2-byte big-endian encoding of a uint16 — the
// wire format for nftables.TypeInetService. uint16 because inet_service
// keys are exactly 16 bits; the kernel rejects anything else.
func portBytes(p uint16) []byte {
	return []byte{byte(p >> 8), byte(p)}
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
