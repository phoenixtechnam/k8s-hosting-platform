// F1+F6 — CrowdSec L4 blocklist reconciler.
//
// Push CrowdSec decisions (banned IPs) from LAPI into the host firewall
// as nft set elements with per-element TTLs, so the kernel drops banned
// traffic at L4 before it ever reaches Traefik/CrowdSec for L7 processing.
//
// THIS IS STAGE A — exclusion arithmetic + cap + self-protect ONLY.
// The reconciler runs as a dormant goroutine: it reads cluster state to
// COMPUTE what would land in `crowdsec_blocklist_v{4,6}`, applies all
// safety filters, but NEVER writes to nft. Every tick logs a "would
// apply" summary. Operator-facing toggle, LAPI HTTP client, and actual
// nft writes land in Stage B / Stage C.
//
// Why this staging:
//   * F1+F6 is the highest-risk change in this codebase — a buggy
//     reconciler can drop every operator IP and brick SSH access
//     cluster-wide. The exclusion-arithmetic correctness is the core
//     defence; ship it standalone with strong unit tests so the
//     read-only path is rock-solid before any kernel writes turn on.
//   * The dormant goroutine still validates the run-loop, the
//     env-flag gating, and the integration with main.go's WaitGroup.
//
// Exclusion sources (UNION, in priority order):
//   1. Pod CIDR — from Node.spec.podCIDR (per-node) UNION cluster-cidr
//   2. Service CIDR — from `kubectl get -o jsonpath=` on the apiserver
//      `serviceCIDR` field (k8s 1.29+) or env override
//   3. Node InternalIPs — cluster-wide, from the Node informer cache
//   4. ClusterTrustedRange CIDRs — operator-blessed
//   5. ClusterPendingPeer IPs — peers being onboarded
//   6. Self external IP — Node ExternalIP if set
//
// Hard cap: 500_000 elements per family. Larger sets degrade nft
// performance and consume kernel memory. We log + truncate at the cap.
//
// Self-protect trip: if more than `selfProtectIntersectionThreshold` (5%)
// of the proposed blocklist intersects the exclusion set, we refuse to
// apply (in Stage B+) and bump a counter. Three consecutive trips and
// the reconciler logs an OPERATOR-VISIBLE warning + stops applying
// until manually re-enabled.

package main

import (
	"context"
	"log/slog"
	"net/netip"
	"os"
	"sort"
	"sync/atomic"
	"time"
)

const (
	// crowdsecBlocklistMaxElements caps the total entries per family
	// to protect kernel memory + nft lookup performance.
	crowdsecBlocklistMaxElements = 500_000

	// selfProtectIntersectionThreshold — refuse to apply if more than
	// this fraction of the proposed blocklist intersects the exclusion
	// set. 5% is conservative; a legitimate community blocklist rarely
	// overlaps with operator IPs at all, so anything >5% is almost
	// certainly a bug in the LAPI stream or a misconfigured trusted
	// range.
	selfProtectIntersectionThreshold = 0.05

	// selfProtectTripBudget — how many consecutive trips before we
	// stop applying. After 3 trips we log a loud warning and the
	// reconciler enters a quiescent state (still LOGGING what it
	// WOULD apply, just not applying).
	selfProtectTripBudget = 3

	// crowdsecReconcileInterval — tick cadence for the LAPI poll +
	// exclusion compute. CrowdSec scenarios typically fire on the
	// order of seconds; 30s gives near-real-time enforcement without
	// hammering LAPI.
	crowdsecReconcileInterval = 30 * time.Second

	// envCrowdsecL4Mode — controls the runtime behaviour.
	//   "disabled" (default) — goroutine doesn't even start.
	//   "dryrun"             — compute + log every tick, NEVER write nft.
	//                          Use this on staging to verify exclusion
	//                          arithmetic + cap behaviour on real data.
	//   "enforce"            — compute + log + write nft (Stage B).
	envCrowdsecL4Mode = "CROWDSEC_L4_MODE"

	crowdsecL4ModeDisabled = "disabled"
	crowdsecL4ModeDryRun   = "dryrun"
	crowdsecL4ModeEnforce  = "enforce"
)

// crowdsecDecision is the minimal subset of a CrowdSec LAPI decision
// we need to populate the nft sets. Maps to /v1/decisions/stream
// response shape — only `value`, `type`, `duration` are load-bearing.
type crowdsecDecision struct {
	// Value is either a bare IP ("1.2.3.4", "fe80::1") or a CIDR
	// ("1.2.3.0/24"). LAPI returns both forms depending on scenario.
	Value string `json:"value"`
	// Type — "ban" is the only one we honour. "captcha" / "throttle"
	// are L7 verdicts the Traefik bouncer enforces, not L4.
	Type string `json:"type"`
	// Duration is a Go-parseable duration string ("1h", "8760h").
	// LAPI returns this as the REMAINING time, not the original ban
	// duration. nft set elements use this as the per-element timeout.
	Duration string `json:"duration"`
}

// crowdsecBlocklist is the parsed + canonicalised view of LAPI's
// current decisions, split into v4 / v6 families. Each entry is a
// netip.Prefix (single IPs are stored as /32 or /128 prefixes for
// uniform interval-set semantics).
type crowdsecBlocklist struct {
	V4 []netip.Prefix
	V6 []netip.Prefix
	// Per-prefix TTL — index-aligned with V4/V6. Used to set the
	// per-element nft timeout when writing.
	TTLv4 []time.Duration
	TTLv6 []time.Duration
}

// exclusionSet collects every prefix we must NEVER drop traffic for,
// regardless of LAPI saying otherwise. UNION semantics: a prefix in
// the exclusion set wins over a blocklist hit.
type exclusionSet struct {
	V4 []netip.Prefix
	V6 []netip.Prefix
}

// applyExclusions returns a new blocklist with every prefix in `ex`
// removed. CIDR-aware: a banned IP inside an excluded CIDR is removed;
// a banned CIDR that overlaps an excluded CIDR is split or fully
// removed depending on overlap shape.
//
// For Stage A we use a SIMPLE STRICT CONTAINMENT check: if any prefix
// in `ex` contains the blocklist prefix, drop it. We don't attempt to
// SPLIT partially-overlapping prefixes — that's a Stage B feature when
// we can reliably test against real LAPI data. The strict-containment
// approach is conservative (over-drops a few blocklist entries that
// PARTIALLY overlap an excluded range) but safe (never under-drops).
func applyExclusions(bl crowdsecBlocklist, ex exclusionSet) (filtered crowdsecBlocklist, droppedCount int) {
	filterFamily := func(prefixes []netip.Prefix, ttls []time.Duration, exPrefixes []netip.Prefix) ([]netip.Prefix, []time.Duration, int) {
		if len(prefixes) == 0 {
			return prefixes, ttls, 0
		}
		out := make([]netip.Prefix, 0, len(prefixes))
		outTTL := make([]time.Duration, 0, len(prefixes))
		dropped := 0
		for i, p := range prefixes {
			excluded := false
			for _, ep := range exPrefixes {
				if prefixContainsOrEquals(ep, p) {
					excluded = true
					break
				}
			}
			if excluded {
				dropped++
				continue
			}
			out = append(out, p)
			if i < len(ttls) {
				outTTL = append(outTTL, ttls[i])
			}
		}
		return out, outTTL, dropped
	}

	v4, ttl4, d4 := filterFamily(bl.V4, bl.TTLv4, ex.V4)
	v6, ttl6, d6 := filterFamily(bl.V6, bl.TTLv6, ex.V6)
	return crowdsecBlocklist{V4: v4, V6: v6, TTLv4: ttl4, TTLv6: ttl6}, d4 + d6
}

// prefixContainsOrEquals returns true if outer contains inner OR
// equals inner. Cross-family always false.
//
// netip.Prefix.Contains() works on addresses, not prefixes — we need
// "is every address in inner also in outer?". Equivalent: outer.Bits()
// must be <= inner.Bits() AND outer.Masked() must equal inner.Masked()
// truncated to outer.Bits().
//
// CRITICAL: callers must Unmap() v4-in-v6 addresses BEFORE handing
// prefixes to this function. A v4-mapped-in-v6 address (`::ffff:1.2.3.4`)
// has `.Is4() == false` but `.Is4In6() == true`. Without normalization,
// such an address-in-v4-exclusion would slip past the family guard and
// escape the exclusion filter — landing in the nft drop set and bricking
// SSH for an operator IP that LAPI happened to encode in mapped form.
// The .Unmap() call below is the belt to the upstream braces.
func prefixContainsOrEquals(outer, inner netip.Prefix) bool {
	outer = unmapPrefix(outer)
	inner = unmapPrefix(inner)
	if outer.Addr().Is4() != inner.Addr().Is4() {
		return false
	}
	if outer.Bits() > inner.Bits() {
		return false
	}
	// Truncate `inner` to outer's prefix length and compare.
	truncated, err := inner.Addr().Prefix(outer.Bits())
	if err != nil {
		return false
	}
	return truncated.Addr() == outer.Masked().Addr()
}

// unmapPrefix normalises a netip.Prefix so v4-in-v6 mapped
// addresses (`::ffff:1.2.3.4`) become bare v4. The bit width is
// preserved when the original was already-bare v4 or already-bare v6;
// for a mapped address the bit width also has to be re-scoped (the
// mapped form uses 128-bit prefixes; bare v4 uses 32-bit).
//
// Exported nowhere — used internally by prefixContainsOrEquals and
// callers that build exclusionSet / crowdsecBlocklist from external
// data (LAPI fetch, informer cache).
func unmapPrefix(p netip.Prefix) netip.Prefix {
	a := p.Addr().Unmap()
	if a == p.Addr() {
		return p // already canonical
	}
	// Mapped → bare v4. The original bit width was in the 96-128 range
	// (the v6 prefix portion). Re-scope to v4 bits (subtract the 96-bit
	// v4-in-v6 prefix). Clamp at [0, 32].
	bits := p.Bits() - 96
	if bits < 0 {
		bits = 0
	}
	if bits > 32 {
		bits = 32
	}
	return netip.PrefixFrom(a, bits)
}

// enforceCap truncates the blocklist if either family exceeds
// crowdsecBlocklistMaxElements. Stable sort (by prefix string) so
// truncation is deterministic across runs — operators picking which
// 500k to keep is at least consistent over time. Returns the number
// of dropped elements per family.
func enforceCap(bl crowdsecBlocklist) (capped crowdsecBlocklist, droppedV4, droppedV6 int) {
	sortPrefixes := func(ps []netip.Prefix, ttls []time.Duration) ([]netip.Prefix, []time.Duration) {
		type pair struct {
			p   netip.Prefix
			ttl time.Duration
		}
		pairs := make([]pair, len(ps))
		for i := range ps {
			t := time.Duration(0)
			if i < len(ttls) {
				t = ttls[i]
			}
			pairs[i] = pair{p: ps[i], ttl: t}
		}
		sort.Slice(pairs, func(i, j int) bool {
			return pairs[i].p.String() < pairs[j].p.String()
		})
		outP := make([]netip.Prefix, len(pairs))
		outT := make([]time.Duration, len(pairs))
		for i, pr := range pairs {
			outP[i] = pr.p
			outT[i] = pr.ttl
		}
		return outP, outT
	}

	v4, ttl4 := sortPrefixes(bl.V4, bl.TTLv4)
	v6, ttl6 := sortPrefixes(bl.V6, bl.TTLv6)
	if len(v4) > crowdsecBlocklistMaxElements {
		droppedV4 = len(v4) - crowdsecBlocklistMaxElements
		v4 = v4[:crowdsecBlocklistMaxElements]
		ttl4 = ttl4[:crowdsecBlocklistMaxElements]
	}
	if len(v6) > crowdsecBlocklistMaxElements {
		droppedV6 = len(v6) - crowdsecBlocklistMaxElements
		v6 = v6[:crowdsecBlocklistMaxElements]
		ttl6 = ttl6[:crowdsecBlocklistMaxElements]
	}
	return crowdsecBlocklist{V4: v4, V6: v6, TTLv4: ttl4, TTLv6: ttl6}, droppedV4, droppedV6
}

// selfProtectIntersection counts prefixes in `proposed` that ANY prefix
// in `ex` contains. Used to compute the intersection ratio before
// trip detection. CIDR-aware via prefixContainsOrEquals.
func selfProtectIntersection(proposed crowdsecBlocklist, ex exclusionSet) (intersectV4, intersectV6 int) {
	for _, p := range proposed.V4 {
		for _, ep := range ex.V4 {
			if prefixContainsOrEquals(ep, p) {
				intersectV4++
				break
			}
		}
	}
	for _, p := range proposed.V6 {
		for _, ep := range ex.V6 {
			if prefixContainsOrEquals(ep, p) {
				intersectV6++
				break
			}
		}
	}
	return
}

// shouldSelfProtectTrip checks whether the proposed blocklist's
// intersection with the exclusion set exceeds the trip threshold.
// Returns true if we MUST refuse the apply (and bump the trip counter
// in the reconciler). Empty proposed → false (nothing to do).
func shouldSelfProtectTrip(proposed crowdsecBlocklist, ex exclusionSet) bool {
	intV4, intV6 := selfProtectIntersection(proposed, ex)
	totalProposed := len(proposed.V4) + len(proposed.V6)
	if totalProposed == 0 {
		return false
	}
	intersectionRatio := float64(intV4+intV6) / float64(totalProposed)
	return intersectionRatio > selfProtectIntersectionThreshold
}

// crowdsecReconciler runs the dormant Stage A loop. Each tick:
//  1. Fetches decisions from LAPI (Stage B — currently empty stub).
//  2. Computes exclusion set from informer caches.
//  3. Applies exclusions → cap → self-protect.
//  4. LOGS what would land in nft. NEVER writes.
type crowdsecReconciler struct {
	mode string // "disabled" | "dryrun" | "enforce"

	// fetchDecisions returns the current blocklist from LAPI. Stage B
	// implements this with an HTTP client; Stage A keeps it nil and
	// the goroutine logs "fetch stub" each tick.
	fetchDecisions func(ctx context.Context) (crowdsecBlocklist, error)

	// computeExclusions reads the informer caches + env to assemble
	// the union of pod/service/node/trusted/cpp/self IPs that must
	// never be banned. Stage B implements this; Stage A keeps it nil.
	computeExclusions func(ctx context.Context) (exclusionSet, error)

	// tripCount counts SELF-PROTECT trips since the last quiescent
	// transition. NOT reset by healthy ticks — a flickering LAPI stream
	// alternating good/bad data would otherwise reset the counter every
	// healthy tick and the quiescent transition would never happen.
	// The counter only resets on pod restart (by virtue of struct init).
	tripCount atomic.Int32

	// quiescent latches true when tripCount reaches selfProtectTripBudget.
	// Once true, every tick short-circuits at the top — no LAPI fetch,
	// no exclusion compute, no nft writes. Recovery requires a pod
	// restart (which is itself the operator-visible signal that "the
	// reconciler had to be manually unstuck"). atomic.Bool because
	// tick() and run() may race (in practice they're single-threaded
	// per reconciler, but the atomic makes future concurrency safe).
	quiescent atomic.Bool
}

// run is the goroutine entry. Exits cleanly when ctx is canceled.
// Safe to spawn even when mode is "disabled" — the function blocks
// on ctx.Done() so the runWithRecover wrapper's restart loop doesn't
// keep re-invoking it (which would spam "dormant" logs every backoff
// cycle).
func (cr *crowdsecReconciler) run(ctx context.Context) {
	if cr.mode == crowdsecL4ModeDisabled {
		slog.Info("crowdsec-l4-reconciler: dormant (CROWDSEC_L4_MODE=disabled)")
		<-ctx.Done()
		return
	}
	slog.Info("crowdsec-l4-reconciler: starting",
		"mode", cr.mode,
		"interval", crowdsecReconcileInterval.String(),
		"max_elements_per_family", crowdsecBlocklistMaxElements,
	)

	// First tick after a short warm-up so informer caches have time
	// to populate even on a cold start.
	timer := time.NewTimer(5 * time.Second)
	defer timer.Stop()

	for {
		select {
		case <-ctx.Done():
			slog.Info("crowdsec-l4-reconciler: shutdown")
			return
		case <-timer.C:
			cr.tick(ctx)
			timer.Reset(crowdsecReconcileInterval)
		}
	}
}

// tick is one reconcile pass. Separated from run() so tests can drive
// it directly without spinning the timer.
func (cr *crowdsecReconciler) tick(ctx context.Context) {
	// Quiescent latch: once self-protect tripped enough, this stays
	// true for the pod's lifetime. Operator-visible signal that the
	// reconciler stopped trying. Recovery is a pod restart.
	if cr.quiescent.Load() {
		slog.Warn("crowdsec-l4-reconciler: quiescent — skipping tick (restart pod to recover)")
		return
	}
	startedAt := time.Now()

	// Stage A: stub fetch + stub exclusions. Stage B fills these in.
	bl := crowdsecBlocklist{}
	if cr.fetchDecisions != nil {
		fetched, err := cr.fetchDecisions(ctx)
		if err != nil {
			slog.Warn("crowdsec-l4-reconciler: fetch failed", "err", err)
			return
		}
		bl = fetched
	}

	ex := exclusionSet{}
	if cr.computeExclusions != nil {
		computed, err := cr.computeExclusions(ctx)
		if err != nil {
			slog.Warn("crowdsec-l4-reconciler: exclusion compute failed", "err", err)
			return
		}
		ex = computed
	}

	// 1. Self-protect runs on the PRE-EXCLUSION blocklist. The point is
	//    to detect an adversarial LAPI stream that's actively targeting
	//    our trusted IPs — even if applyExclusions catches them all,
	//    that's an alarm worth raising (could be a compromised bouncer
	//    key, poisoned community blocklist, or the Console pushing a
	//    bad scenario). Skip the rest of the tick on trip.
	//
	//    The trip counter does NOT reset on healthy ticks — a flickering
	//    LAPI stream alternating good/bad data would otherwise reset
	//    every healthy tick and the quiescent latch would never engage.
	//    Counter resets only on pod restart.
	if shouldSelfProtectTrip(bl, ex) {
		newTrip := cr.tripCount.Add(1)
		intV4, intV6 := selfProtectIntersection(bl, ex)
		slog.Warn("crowdsec-l4-reconciler: SELF-PROTECT TRIP",
			"trip_count", newTrip,
			"trip_budget", selfProtectTripBudget,
			"proposed_v4_pre_exclusion", len(bl.V4),
			"proposed_v6_pre_exclusion", len(bl.V6),
			"intersect_v4", intV4,
			"intersect_v6", intV6,
		)
		if newTrip >= selfProtectTripBudget {
			cr.quiescent.Store(true)
			slog.Error("crowdsec-l4-reconciler: self-protect budget exhausted — quiescent until restart",
				"budget", selfProtectTripBudget)
		}
		return
	}

	// 2. Apply exclusions.
	filtered, droppedByExclusion := applyExclusions(bl, ex)

	// 3. Enforce cap (after exclusions to keep the most-relevant entries).
	capped, droppedV4Cap, droppedV6Cap := enforceCap(filtered)

	// Stage A: log + return. Stage B switches on cr.mode here:
	//   dryrun  → log only
	//   enforce → call applier.applyCrowdsecBlocklist(capped)
	slog.Info("crowdsec-l4-reconciler: tick computed (no nft write — Stage A)",
		"mode", cr.mode,
		"v4_in", len(bl.V4),
		"v6_in", len(bl.V6),
		"dropped_by_exclusion", droppedByExclusion,
		"dropped_v4_cap", droppedV4Cap,
		"dropped_v6_cap", droppedV6Cap,
		"v4_out", len(capped.V4),
		"v6_out", len(capped.V6),
		"duration_ms", time.Since(startedAt).Milliseconds(),
	)
}

// newCrowdsecReconciler constructs the reconciler from env. Returns
// nil-with-disabled-mode if the env says so — main.go still spawns
// the goroutine, which exits immediately.
func newCrowdsecReconciler() *crowdsecReconciler {
	mode := os.Getenv(envCrowdsecL4Mode)
	if mode == "" {
		mode = crowdsecL4ModeDisabled
	}
	// Validate explicitly — anything other than the 3 known values
	// gets treated as "disabled" with a warning. We do NOT silently
	// honour an unknown mode (could be a typo for "enforce" that
	// would surprise an operator).
	if mode != crowdsecL4ModeDisabled && mode != crowdsecL4ModeDryRun && mode != crowdsecL4ModeEnforce {
		slog.Warn("crowdsec-l4-reconciler: unknown CROWDSEC_L4_MODE — treating as disabled",
			"got", mode,
			"allowed", []string{crowdsecL4ModeDisabled, crowdsecL4ModeDryRun, crowdsecL4ModeEnforce},
		)
		mode = crowdsecL4ModeDisabled
	}
	// Stage A: enforce mode also gets forced to dryrun because the
	// nft write path isn't implemented yet. The Stage A binary refuses
	// to honour "enforce" regardless of operator intent — defense in
	// depth against a premature flip.
	if mode == crowdsecL4ModeEnforce {
		slog.Warn("crowdsec-l4-reconciler: CROWDSEC_L4_MODE=enforce requested but Stage A only supports dryrun — downgrading",
			"effective_mode", crowdsecL4ModeDryRun)
		mode = crowdsecL4ModeDryRun
	}
	return &crowdsecReconciler{mode: mode}
}
