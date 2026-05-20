// CrowdSec LAPI client for F1+F6 Stage B.
//
// Pulls the live decision set from `crowdsec.crowdsec.svc:8080`
// via `/v1/decisions/stream`. Authenticates with a Bouncer API
// key registered against the CrowdSec LAPI (the existing
// `crowdsec-bouncer-key` Secret in the `crowdsec` namespace, same
// key the Traefik bouncer uses).
//
// LAPI stream API shape:
//
//   GET /v1/decisions/stream?startup=true
//   X-Api-Key: <bouncer-key>
//
//   200 OK
//   {
//     "new":     [{ "id":1, "value":"1.2.3.4",    "type":"ban", "scope":"Ip",    "duration":"1h" }, ...],
//     "deleted": [{ "id":2, "value":"5.6.7.0/24", "type":"ban", "scope":"Range", "duration":"0s" }, ...]
//   }
//
// On `startup=true` the response is the full current set. Later polls
// without that flag return only the delta (new/deleted) since the last
// stream-id LAPI tracks per bouncer.
//
// Our reconciler treats every poll as a FULL snapshot — we don't apply
// deltas, we re-render the whole blocklist into nft via flush+add.
// Simpler + idempotent + matches how the peer/tenant reconcilers work.
// LAPI is fine with this pattern (CrowdSec docs explicitly mention it
// for non-streaming bouncers).
//
// What we filter out:
//   - type != "ban"  (we ignore captcha/throttle — those are L7 verdicts
//                    enforced by Traefik's bouncer)
//   - scope != "Ip" && scope != "Range"  (country-scope etc. not for L4)
//   - malformed value strings (netip.ParsePrefix fails)

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/netip"
	"net/url"
	"strings"
	"time"
)

const (
	// crowdsecLAPIDefaultURL — k8s in-cluster service for CrowdSec LAPI.
	// Operator override via env CROWDSEC_LAPI_URL.
	crowdsecLAPIDefaultURL = "http://crowdsec.crowdsec.svc:8080"

	// lapiRequestTimeout — HTTP client timeout. CrowdSec normally
	// responds in <100ms; a 5s ceiling gives margin for the cluster
	// hiccup case without blocking the reconcile tick for an
	// unrecoverable interval.
	lapiRequestTimeout = 5 * time.Second

	// lapiMaxResponseBytes — guard against an adversarial or
	// runaway LAPI returning a giant response that would OOM the
	// reconciler. 50 MiB allows ~500_000 decisions at ~100 bytes
	// each (matches our 500k cap).
	lapiMaxResponseBytes = 50 * 1024 * 1024
)

// lapiDecision is the JSON shape returned by CrowdSec LAPI for each
// element of the "new" / "deleted" arrays. Fields we don't use
// (id, origin, scenario, until, etc.) are intentionally omitted.
type lapiDecision struct {
	Value    string `json:"value"`
	Type     string `json:"type"`
	Scope    string `json:"scope"`
	Duration string `json:"duration"`
}

// lapiStreamResponse is the full response body for /v1/decisions/stream.
// On `startup=true` "deleted" is typically empty; we still parse it
// defensively for shape robustness.
type lapiStreamResponse struct {
	New     []lapiDecision `json:"new"`
	Deleted []lapiDecision `json:"deleted"`
}

// lapiClient wraps the http.Client + auth header so the reconciler
// can call fetchStream(ctx, startup) without rebuilding the request
// each tick.
type lapiClient struct {
	baseURL string
	apiKey  string
	http    *http.Client
}

// newLAPIClient — constructor. baseURL defaults to the in-cluster
// service when empty (operator overrides via CROWDSEC_LAPI_URL env).
// apiKey is required — empty key returns nil client + non-nil error
// so the reconciler can refuse to start instead of silently failing
// every fetch with 403.
func newLAPIClient(baseURL, apiKey string) (*lapiClient, error) {
	if apiKey == "" {
		return nil, fmt.Errorf("crowdsec LAPI: BOUNCER_KEY env is required")
	}
	if baseURL == "" {
		baseURL = crowdsecLAPIDefaultURL
	}
	// Validate baseURL parse — a typo'd URL surfaces as a clear
	// startup error rather than a per-tick warning.
	if _, err := url.Parse(baseURL); err != nil {
		return nil, fmt.Errorf("crowdsec LAPI: invalid baseURL %q: %w", baseURL, err)
	}
	return &lapiClient{
		baseURL: baseURL,
		apiKey:  apiKey,
		http: &http.Client{
			Timeout: lapiRequestTimeout,
		},
	}, nil
}

// fetchStream returns the current blocklist from LAPI.
// `startup=true` forces a full snapshot; subsequent polls without it
// would return only deltas, but we always request snapshots because
// the reconciler's apply path is a stateless flush+add of the full
// set (matches peer/tenant reconcilers).
//
// Returns:
//   - parsed crowdsecBlocklist (v4 + v6 with per-element TTLs)
//   - any error (HTTP non-2xx, parse failure, body truncation)
func (c *lapiClient) fetchStream(ctx context.Context, startup bool) (crowdsecBlocklist, error) {
	endpoint := c.baseURL + "/v1/decisions/stream"
	if startup {
		endpoint += "?startup=true"
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return crowdsecBlocklist{}, fmt.Errorf("build LAPI request: %w", err)
	}
	req.Header.Set("X-Api-Key", c.apiKey)
	req.Header.Set("Accept", "application/json")

	resp, err := c.http.Do(req)
	if err != nil {
		return crowdsecBlocklist{}, fmt.Errorf("LAPI request: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		// Truncate body to a few hundred bytes for the error message.
		// LAPI 403 / 502 surfaces here.
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return crowdsecBlocklist{}, fmt.Errorf("LAPI non-2xx %d: %s", resp.StatusCode, strings.TrimSpace(string(body)))
	}

	// Cap the response size before json.Decode to defend against an
	// adversarial / runaway LAPI returning a multi-GB stream.
	limited := io.LimitReader(resp.Body, lapiMaxResponseBytes+1)
	body, err := io.ReadAll(limited)
	if err != nil {
		return crowdsecBlocklist{}, fmt.Errorf("LAPI read body: %w", err)
	}
	if int64(len(body)) > lapiMaxResponseBytes {
		return crowdsecBlocklist{}, fmt.Errorf("LAPI response exceeded max size of %d bytes", lapiMaxResponseBytes)
	}

	return parseLAPIStream(body)
}

// parseLAPIStream is the pure JSON-to-blocklist transform. Separated
// from fetchStream so tests can drive it directly with fixture bodies.
func parseLAPIStream(body []byte) (crowdsecBlocklist, error) {
	var resp lapiStreamResponse
	if err := json.Unmarshal(body, &resp); err != nil {
		return crowdsecBlocklist{}, fmt.Errorf("LAPI JSON parse: %w", err)
	}
	bl := crowdsecBlocklist{}
	for _, d := range resp.New {
		// Only "ban" type counts for L4. captcha/throttle are L7
		// verdicts the Traefik bouncer enforces, not the kernel.
		if d.Type != "ban" {
			continue
		}
		// Only "Ip" or "Range" scope. Country/AS/etc. don't map to
		// nft sets.
		if d.Scope != "Ip" && d.Scope != "Range" {
			continue
		}
		prefix, ok := parseLAPIValue(d.Value)
		if !ok {
			continue
		}
		// Per-element TTL from CrowdSec's "duration". Parse failure
		// → skip the entry (a malformed duration is a LAPI bug we
		// don't want to perpetuate into the kernel set with timeout=0
		// = never expire).
		ttl, err := time.ParseDuration(d.Duration)
		if err != nil || ttl <= 0 {
			continue
		}
		if prefix.Addr().Is4() {
			bl.V4 = append(bl.V4, prefix)
			bl.TTLv4 = append(bl.TTLv4, ttl)
		} else {
			bl.V6 = append(bl.V6, prefix)
			bl.TTLv6 = append(bl.TTLv6, ttl)
		}
	}
	// We DON'T process the Deleted array — the reconciler does a
	// full-snapshot flush+add every tick, so a previously-deleted
	// entry simply doesn't appear in the next "new" snapshot and is
	// gone from the rendered set.
	return bl, nil
}

// parseLAPIValue handles both bare IPs ("1.2.3.4", "fe80::1") and
// CIDRs ("1.2.3.0/24"). Bare IPs are promoted to /32 or /128. Returns
// the prefix normalised via unmapPrefix (so a v4-mapped-in-v6 value
// is treated as bare v4 — same defense as prefixContainsOrEquals).
func parseLAPIValue(s string) (netip.Prefix, bool) {
	if strings.Contains(s, "/") {
		p, err := netip.ParsePrefix(s)
		if err != nil {
			return netip.Prefix{}, false
		}
		return unmapPrefix(p), true
	}
	addr, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Prefix{}, false
	}
	// Promote to single-host prefix (/32 for v4, /128 for v6).
	addr = addr.Unmap()
	bits := 32
	if addr.Is6() {
		bits = 128
	}
	return netip.PrefixFrom(addr, bits), true
}
