package main

import (
	"context"
	"net/netip"
	"testing"
	"time"
)

func mustPrefix(t *testing.T, s string) netip.Prefix {
	t.Helper()
	p, err := netip.ParsePrefix(s)
	if err != nil {
		t.Fatalf("ParsePrefix(%q): %v", s, err)
	}
	return p
}

func TestPrefixContainsOrEquals(t *testing.T) {
	tests := []struct {
		name  string
		outer string
		inner string
		want  bool
	}{
		// Same family — IPv4
		{"equal /32", "1.2.3.4/32", "1.2.3.4/32", true},
		{"contains /32", "1.2.3.0/24", "1.2.3.4/32", true},
		{"contains /28", "1.2.3.0/24", "1.2.3.0/28", true},
		{"outer narrower than inner", "1.2.3.0/28", "1.2.3.0/24", false},
		{"different /24s", "1.2.3.0/24", "1.2.4.0/24", false},
		{"non-overlapping /32s", "1.2.3.4/32", "1.2.3.5/32", false},
		// IPv6
		{"v6 equal /128", "2001:db8::1/128", "2001:db8::1/128", true},
		{"v6 contains", "2001:db8::/32", "2001:db8::1/128", true},
		// Cross-family always false
		{"cross-family v4 outer v6 inner", "1.2.3.0/24", "2001:db8::1/128", false},
		{"cross-family v6 outer v4 inner", "2001:db8::/32", "1.2.3.4/32", false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := prefixContainsOrEquals(mustPrefix(t, tt.outer), mustPrefix(t, tt.inner))
			if got != tt.want {
				t.Errorf("prefixContainsOrEquals(%s, %s) = %v, want %v", tt.outer, tt.inner, got, tt.want)
			}
		})
	}
}

func TestApplyExclusions_DropsContainedAndEqual(t *testing.T) {
	bl := crowdsecBlocklist{
		V4: []netip.Prefix{
			mustPrefix(t, "1.2.3.4/32"),     // contained by exclusion 1.2.3.0/24 → drop
			mustPrefix(t, "5.6.7.8/32"),     // not in exclusion → keep
			mustPrefix(t, "10.0.0.0/16"),    // equal to exclusion → drop
			mustPrefix(t, "192.168.1.1/32"), // not in any exclusion → keep
		},
		TTLv4: []time.Duration{time.Hour, time.Hour, 2 * time.Hour, time.Hour},
		V6: []netip.Prefix{
			mustPrefix(t, "2001:db8::1/128"), // contained → drop
			mustPrefix(t, "fe80::1/128"),     // not in exclusion → keep
		},
		TTLv6: []time.Duration{time.Hour, time.Hour},
	}
	ex := exclusionSet{
		V4: []netip.Prefix{
			mustPrefix(t, "1.2.3.0/24"),
			mustPrefix(t, "10.0.0.0/16"),
		},
		V6: []netip.Prefix{mustPrefix(t, "2001:db8::/32")},
	}

	filtered, dropped := applyExclusions(bl, ex)

	if dropped != 3 {
		t.Errorf("dropped = %d, want 3", dropped)
	}
	if len(filtered.V4) != 2 {
		t.Errorf("filtered.V4 len = %d, want 2 (%v)", len(filtered.V4), filtered.V4)
	}
	if len(filtered.V6) != 1 {
		t.Errorf("filtered.V6 len = %d, want 1 (%v)", len(filtered.V6), filtered.V6)
	}
	// TTL index-alignment preserved.
	if len(filtered.TTLv4) != len(filtered.V4) {
		t.Errorf("TTLv4 mis-aligned: %d vs V4 %d", len(filtered.TTLv4), len(filtered.V4))
	}
	if len(filtered.TTLv6) != len(filtered.V6) {
		t.Errorf("TTLv6 mis-aligned: %d vs V6 %d", len(filtered.TTLv6), len(filtered.V6))
	}
}

func TestApplyExclusions_EmptyInputs(t *testing.T) {
	// Empty exclusions → pass-through, dropped=0.
	bl := crowdsecBlocklist{V4: []netip.Prefix{mustPrefix(t, "1.2.3.4/32")}}
	out, dropped := applyExclusions(bl, exclusionSet{})
	if dropped != 0 || len(out.V4) != 1 {
		t.Errorf("empty exclusion did not pass through: dropped=%d v4=%d", dropped, len(out.V4))
	}
	// Empty blocklist → empty output, dropped=0, no panic.
	out, dropped = applyExclusions(crowdsecBlocklist{}, exclusionSet{V4: []netip.Prefix{mustPrefix(t, "0.0.0.0/0")}})
	if dropped != 0 || len(out.V4) != 0 {
		t.Errorf("empty blocklist not handled cleanly: dropped=%d v4=%d", dropped, len(out.V4))
	}
}

func TestEnforceCap_Truncates(t *testing.T) {
	// Synthesize 500_002 v4 prefixes (just over the cap) by varying the
	// last octet across /24s. Use /32 entries.
	bl := crowdsecBlocklist{}
	for i := 0; i < crowdsecBlocklistMaxElements+2; i++ {
		a := byte((i >> 16) & 0xff)
		b := byte((i >> 8) & 0xff)
		c := byte(i & 0xff)
		ip := netip.AddrFrom4([4]byte{1, a, b, c})
		bl.V4 = append(bl.V4, netip.PrefixFrom(ip, 32))
		bl.TTLv4 = append(bl.TTLv4, time.Hour)
	}
	capped, dropV4, dropV6 := enforceCap(bl)
	if dropV4 != 2 {
		t.Errorf("dropV4 = %d, want 2", dropV4)
	}
	if dropV6 != 0 {
		t.Errorf("dropV6 = %d, want 0", dropV6)
	}
	if len(capped.V4) != crowdsecBlocklistMaxElements {
		t.Errorf("capped.V4 len = %d, want %d", len(capped.V4), crowdsecBlocklistMaxElements)
	}
	if len(capped.TTLv4) != crowdsecBlocklistMaxElements {
		t.Errorf("capped.TTLv4 len = %d, want %d", len(capped.TTLv4), crowdsecBlocklistMaxElements)
	}
}

func TestEnforceCap_BelowCap_NoOp(t *testing.T) {
	bl := crowdsecBlocklist{
		V4:    []netip.Prefix{mustPrefix(t, "1.2.3.4/32")},
		TTLv4: []time.Duration{time.Hour},
	}
	capped, dV4, dV6 := enforceCap(bl)
	if dV4 != 0 || dV6 != 0 {
		t.Errorf("below-cap dropped: v4=%d v6=%d", dV4, dV6)
	}
	if len(capped.V4) != 1 {
		t.Errorf("below-cap mutated: %v", capped.V4)
	}
}

func TestEnforceCap_DeterministicOrdering(t *testing.T) {
	// Same input in different order → same output (after sort).
	a := crowdsecBlocklist{V4: []netip.Prefix{mustPrefix(t, "3.0.0.0/8"), mustPrefix(t, "1.0.0.0/8"), mustPrefix(t, "2.0.0.0/8")}}
	b := crowdsecBlocklist{V4: []netip.Prefix{mustPrefix(t, "1.0.0.0/8"), mustPrefix(t, "2.0.0.0/8"), mustPrefix(t, "3.0.0.0/8")}}
	ca, _, _ := enforceCap(a)
	cb, _, _ := enforceCap(b)
	if len(ca.V4) != len(cb.V4) {
		t.Fatalf("length mismatch")
	}
	for i := range ca.V4 {
		if ca.V4[i] != cb.V4[i] {
			t.Errorf("order mismatch at %d: %s vs %s", i, ca.V4[i], cb.V4[i])
		}
	}
}

func TestSelfProtectIntersection_Counts(t *testing.T) {
	proposed := crowdsecBlocklist{
		V4: []netip.Prefix{
			mustPrefix(t, "1.2.3.4/32"), // intersects exclusion 1.2.3.0/24
			mustPrefix(t, "5.6.7.8/32"), // no overlap
		},
		V6: []netip.Prefix{
			mustPrefix(t, "2001:db8::1/128"), // intersects exclusion 2001:db8::/32
		},
	}
	ex := exclusionSet{
		V4: []netip.Prefix{mustPrefix(t, "1.2.3.0/24")},
		V6: []netip.Prefix{mustPrefix(t, "2001:db8::/32")},
	}
	v4, v6 := selfProtectIntersection(proposed, ex)
	if v4 != 1 || v6 != 1 {
		t.Errorf("intersection v4=%d v6=%d, want 1/1", v4, v6)
	}
}

func TestShouldSelfProtectTrip_Threshold(t *testing.T) {
	// 100 proposed, 6 intersect → 6% > 5% → trip.
	ex := exclusionSet{V4: []netip.Prefix{mustPrefix(t, "10.0.0.0/8")}}
	proposed := crowdsecBlocklist{}
	// 94 non-overlapping (1.0.0.0/8 range — no overlap with 10.0.0.0/8)
	for i := 1; i <= 94; i++ {
		proposed.V4 = append(proposed.V4, mustPrefix(t, "1.0.0."+itoa(i)+"/32"))
	}
	// 6 overlapping
	for i := 1; i <= 6; i++ {
		proposed.V4 = append(proposed.V4, mustPrefix(t, "10.0.0."+itoa(i)+"/32"))
	}
	if !shouldSelfProtectTrip(proposed, ex) {
		t.Errorf("expected trip with 6%% intersection")
	}

	// 100 proposed, 5 intersect → 5% NOT > 5% → no trip.
	proposed2 := crowdsecBlocklist{}
	for i := 1; i <= 95; i++ {
		proposed2.V4 = append(proposed2.V4, mustPrefix(t, "1.0.0."+itoa(i)+"/32"))
	}
	for i := 1; i <= 5; i++ {
		proposed2.V4 = append(proposed2.V4, mustPrefix(t, "10.0.0."+itoa(i)+"/32"))
	}
	if shouldSelfProtectTrip(proposed2, ex) {
		t.Errorf("expected NO trip with exactly 5%% intersection")
	}
}

func TestShouldSelfProtectTrip_EmptyProposed_NoTrip(t *testing.T) {
	if shouldSelfProtectTrip(crowdsecBlocklist{}, exclusionSet{V4: []netip.Prefix{mustPrefix(t, "0.0.0.0/0")}}) {
		t.Error("empty proposed should never trip")
	}
}

func TestNewCrowdsecReconciler_DefaultsDisabled(t *testing.T) {
	t.Setenv(envCrowdsecL4Mode, "")
	r := newCrowdsecReconciler()
	if r.mode != crowdsecL4ModeDisabled {
		t.Errorf("default mode = %q, want disabled", r.mode)
	}
}

func TestNewCrowdsecReconciler_UnknownModeFallsBackToDisabled(t *testing.T) {
	t.Setenv(envCrowdsecL4Mode, "wishful-typo")
	r := newCrowdsecReconciler()
	if r.mode != crowdsecL4ModeDisabled {
		t.Errorf("unknown mode = %q, want disabled", r.mode)
	}
}

func TestNewCrowdsecReconciler_EnforceDowngradedInStageA(t *testing.T) {
	// Stage A defense in depth: even when operator sets "enforce", we
	// downgrade to "dryrun" because the nft-write path isn't built yet.
	t.Setenv(envCrowdsecL4Mode, crowdsecL4ModeEnforce)
	r := newCrowdsecReconciler()
	if r.mode != crowdsecL4ModeDryRun {
		t.Errorf("enforce mode should downgrade to dryrun in Stage A; got %q", r.mode)
	}
}

func TestRun_DisabledBlocksUntilCtxCancel(t *testing.T) {
	// Dormant mode logs once then blocks on ctx.Done() — the
	// runWithRecover wrapper in main.go restarts a goroutine that
	// returns "cleanly", so an immediate return would log "dormant"
	// every ~2s in production (observed on staging at first ship).
	r := &crowdsecReconciler{mode: crowdsecL4ModeDisabled}
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan struct{})
	go func() {
		r.run(ctx)
		close(done)
	}()
	// Wait a bit to ensure the goroutine has entered <-ctx.Done() and
	// is NOT returning early.
	select {
	case <-done:
		t.Fatal("dormant run returned before ctx cancel — would log-spam under runWithRecover")
	case <-time.After(50 * time.Millisecond):
		// Expected — still blocked.
	}
	cancel()
	select {
	case <-done:
		// Expected — ctx cancel unblocks the goroutine.
	case <-time.After(100 * time.Millisecond):
		t.Error("dormant run did not unblock on ctx cancel")
	}
}

func TestTick_NilStubsLogsCleanly(t *testing.T) {
	// Stage A: both fetch + compute are nil. Tick should not panic and
	// should log "computed (no nft write)" with all counts at zero.
	r := &crowdsecReconciler{mode: crowdsecL4ModeDryRun}
	r.tick(context.Background()) // should not panic
	if r.tripCount.Load() != 0 {
		t.Errorf("trip counter bumped on empty input: %d", r.tripCount.Load())
	}
}

func TestTick_TripCounterIncrementsAndQuiesces(t *testing.T) {
	// Trigger a self-protect trip every tick (intersection ratio = 100%).
	r := &crowdsecReconciler{
		mode: crowdsecL4ModeDryRun,
		fetchDecisions: func(_ context.Context) (crowdsecBlocklist, error) {
			return crowdsecBlocklist{
				V4: []netip.Prefix{mustPrefix(t, "10.0.0.1/32"), mustPrefix(t, "10.0.0.2/32")},
			}, nil
		},
		computeExclusions: func(_ context.Context) (exclusionSet, error) {
			return exclusionSet{V4: []netip.Prefix{mustPrefix(t, "10.0.0.0/8")}}, nil
		},
	}
	r.tick(context.Background())
	if r.tripCount.Load() != 1 {
		t.Errorf("after 1 trip, count=%d want 1", r.tripCount.Load())
	}
	r.tick(context.Background())
	r.tick(context.Background())
	if r.tripCount.Load() != selfProtectTripBudget {
		t.Errorf("after %d trips, count=%d", selfProtectTripBudget, r.tripCount.Load())
	}
	if !r.quiescent.Load() {
		t.Errorf("at budget exhaustion quiescent should latch true")
	}
}

func TestTick_HealthyDoesNotResetTripCounter(t *testing.T) {
	// HIGH 2 defense: healthy tick MUST NOT reset the trip counter,
	// else a flickering LAPI (bad/good/bad/good) would never engage
	// the quiescent latch.
	// 1) Trip twice.
	r := &crowdsecReconciler{
		mode: crowdsecL4ModeDryRun,
		fetchDecisions: func(_ context.Context) (crowdsecBlocklist, error) {
			return crowdsecBlocklist{V4: []netip.Prefix{mustPrefix(t, "10.0.0.1/32")}}, nil
		},
		computeExclusions: func(_ context.Context) (exclusionSet, error) {
			return exclusionSet{V4: []netip.Prefix{mustPrefix(t, "10.0.0.0/8")}}, nil
		},
	}
	r.tick(context.Background())
	r.tick(context.Background())
	if r.tripCount.Load() != 2 {
		t.Fatalf("expected trip=2 after 2 bad ticks, got %d", r.tripCount.Load())
	}
	// 2) Healthy tick → trip count STAYS at 2 (NOT reset).
	r.fetchDecisions = func(_ context.Context) (crowdsecBlocklist, error) {
		return crowdsecBlocklist{V4: []netip.Prefix{mustPrefix(t, "5.6.7.8/32")}}, nil
	}
	r.tick(context.Background())
	if r.tripCount.Load() != 2 {
		t.Errorf("healthy tick reset trip counter to %d — flickering LAPI would defeat the budget", r.tripCount.Load())
	}
	// 3) Another bad tick → trip count = 3 → quiescent latches.
	r.fetchDecisions = func(_ context.Context) (crowdsecBlocklist, error) {
		return crowdsecBlocklist{V4: []netip.Prefix{mustPrefix(t, "10.0.0.2/32")}}, nil
	}
	r.tick(context.Background())
	if !r.quiescent.Load() {
		t.Errorf("3rd bad tick should latch quiescent, but it's still false")
	}
}

func TestTick_QuiescentShortCircuits(t *testing.T) {
	// Once quiescent is true, subsequent ticks must NOT call fetch or
	// compute — they short-circuit at the top. Set quiescent manually
	// and verify the stubs never fire.
	calls := 0
	r := &crowdsecReconciler{
		mode: crowdsecL4ModeDryRun,
		fetchDecisions: func(_ context.Context) (crowdsecBlocklist, error) {
			calls++
			return crowdsecBlocklist{}, nil
		},
	}
	r.quiescent.Store(true)
	r.tick(context.Background())
	r.tick(context.Background())
	if calls != 0 {
		t.Errorf("quiescent reconciler should NOT call fetchDecisions, got %d calls", calls)
	}
}

func TestPrefixContainsOrEquals_V4InV6Normalization(t *testing.T) {
	// HIGH 1 defense: a v4-mapped-in-v6 address (`::ffff:1.2.3.4`)
	// must be normalised so it's treated as bare v4. Without this, an
	// LAPI-returned v4-mapped ban would slip past the v4 exclusion
	// filter (because Is4()=false vs Is4()=true) and brick SSH for an
	// operator IP encoded in mapped form.
	mapped := netip.MustParseAddr("::ffff:1.2.3.4")
	bareV4 := netip.MustParseAddr("1.2.3.4")
	if mapped.Is4() {
		t.Fatal("test setup wrong — mapped should report Is4()=false before Unmap()")
	}

	// Inner is the mapped form (as if LAPI returned it).
	// Outer is the bare v4 exclusion (operator's trusted range).
	// Without normalization the family guard returns false and the
	// containment check fails.
	mappedPrefix := netip.PrefixFrom(mapped, 128)
	bareV4Prefix := netip.PrefixFrom(bareV4, 32)
	bareV4Range := mustPrefix(t, "1.2.3.0/24")

	if !prefixContainsOrEquals(bareV4Range, mappedPrefix) {
		t.Error("v4-mapped-in-v6 inner inside v4 outer should match after normalization")
	}
	if !prefixContainsOrEquals(bareV4Prefix, mappedPrefix) {
		t.Error("equal mapped vs bare v4 should match after normalization")
	}
}

// itoa — small int→string helper to avoid pulling strconv into the
// test for one-digit values. Test inputs use 1..255 so the byte cast
// + base-10 format is sufficient.
func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	return string(digits)
}

func TestCrowdsecPrefixesToElements_AttachesTimeout(t *testing.T) {
	prefixes := []netip.Prefix{mustPrefix(t, "10.0.0.0/24")}
	ttls := []time.Duration{2 * time.Hour}
	elems := crowdsecPrefixesToElements(prefixes, ttls, false)
	if len(elems) != 2 {
		t.Fatalf("expected 2 elements (start+end), got %d", len(elems))
	}
	if elems[0].Timeout != 2*time.Hour {
		t.Errorf("start element Timeout = %v, want 2h", elems[0].Timeout)
	}
	if !elems[1].IntervalEnd {
		t.Error("second element should be IntervalEnd")
	}
}

func TestCrowdsecPrefixesToElements_SkipsZeroOrNegativeTTL(t *testing.T) {
	prefixes := []netip.Prefix{
		mustPrefix(t, "10.0.0.0/24"),
		mustPrefix(t, "11.0.0.0/24"),
		mustPrefix(t, "12.0.0.0/24"),
	}
	ttls := []time.Duration{
		time.Hour,
		0,             // zero — skip
		-1 * time.Second, // negative — skip
	}
	elems := crowdsecPrefixesToElements(prefixes, ttls, false)
	if len(elems) != 2 { // only the first prefix survives → 2 elements (start+end)
		t.Errorf("expected 2 elements (one prefix), got %d", len(elems))
	}
}

func TestCrowdsecPrefixesToElements_CapsLongTTL(t *testing.T) {
	prefixes := []netip.Prefix{mustPrefix(t, "10.0.0.0/24")}
	ttls := []time.Duration{30 * 24 * time.Hour} // 30 days — should cap to 7d
	elems := crowdsecPrefixesToElements(prefixes, ttls, false)
	if len(elems) != 2 {
		t.Fatalf("expected 2 elements, got %d", len(elems))
	}
	if elems[0].Timeout != 7*24*time.Hour {
		t.Errorf("expected 30d TTL capped to 7d, got %v", elems[0].Timeout)
	}
}

func TestCrowdsecPrefixesToElements_FamilyFiltered(t *testing.T) {
	// Passing a v4 prefix with isV6=true should be filtered out, and
	// vice versa. Mirrors the existing ipsToElements / cidrsToElements
	// family guard.
	v4 := []netip.Prefix{mustPrefix(t, "10.0.0.0/24")}
	v6 := []netip.Prefix{mustPrefix(t, "2001:db8::/64")}
	ttls := []time.Duration{time.Hour}

	v4InV6 := crowdsecPrefixesToElements(v4, ttls, true)
	if len(v4InV6) != 0 {
		t.Errorf("v4 prefix in v6 call should be filtered, got %d elements", len(v4InV6))
	}
	v6InV4 := crowdsecPrefixesToElements(v6, ttls, false)
	if len(v6InV4) != 0 {
		t.Errorf("v6 prefix in v4 call should be filtered, got %d elements", len(v6InV4))
	}
}

func TestCrowdsecPrefixesToElements_EmptyInput(t *testing.T) {
	elems := crowdsecPrefixesToElements(nil, nil, false)
	if len(elems) != 0 {
		t.Errorf("empty input should yield 0 elements, got %d", len(elems))
	}
}
