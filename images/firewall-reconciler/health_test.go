package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

// healthState fresh() — direct unit test of the freshness predicate.

func TestFresh_neverReconciledIsNotFresh(t *testing.T) {
	if fresh(0, time.Now()) {
		t.Errorf("ts=0 (never reconciled) should not be fresh")
	}
}

func TestFresh_recentTimestampIsFresh(t *testing.T) {
	now := time.Date(2026, 5, 9, 18, 0, 0, 0, time.UTC)
	tsNanos := now.Add(-30 * time.Second).UnixNano()
	if !fresh(tsNanos, now) {
		t.Errorf("30s-old timestamp should be fresh (max age = %s)", healthMaxAge)
	}
}

func TestFresh_staleTimestampIsNotFresh(t *testing.T) {
	now := time.Date(2026, 5, 9, 18, 0, 0, 0, time.UTC)
	tsNanos := now.Add(-2 * healthMaxAge).UnixNano()
	if fresh(tsNanos, now) {
		t.Errorf("%s-old timestamp should NOT be fresh (max age = %s)",
			now.Sub(time.Unix(0, tsNanos)), healthMaxAge)
	}
}

func TestFresh_futureTimestampIsNotFresh(t *testing.T) {
	// Defensive: a clock skew making ts > now should not register as
	// "fresh negative seconds ago".
	now := time.Date(2026, 5, 9, 18, 0, 0, 0, time.UTC)
	tsNanos := now.Add(30 * time.Second).UnixNano()
	if fresh(tsNanos, now) {
		t.Errorf("future timestamp (clock skew) should not register as fresh")
	}
}

// HTTP handler — drive the actual mux + handler via httptest.

func TestHealthz_503BeforeAnyReconcile(t *testing.T) {
	hs := &healthState{}
	mux := http.NewServeMux()
	registerHealthHandlers(mux, hs)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	resp, err := http.Get(srv.URL + healthPath)
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 503 {
		t.Errorf("expected 503 before any reconcile; got %d", resp.StatusCode)
	}
}

func TestHealthz_200WhenBothLoopsRecent(t *testing.T) {
	hs := &healthState{}
	now := time.Now()
	hs.markPeerHealthy(now)
	hs.markTenantHealthy(now)
	mux := http.NewServeMux()
	registerHealthHandlers(mux, hs)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	resp, err := http.Get(srv.URL + healthPath)
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		t.Errorf("expected 200; got %d, body=%s", resp.StatusCode, string(body))
	}
}

func TestHealthz_503WhenPeerStaleEvenIfTenantFresh(t *testing.T) {
	hs := &healthState{}
	hs.markTenantHealthy(time.Now())
	// peer never reconciled
	mux := http.NewServeMux()
	registerHealthHandlers(mux, hs)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	resp, err := http.Get(srv.URL + healthPath)
	if err != nil {
		t.Fatalf("GET /healthz: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 503 {
		t.Errorf("expected 503 when peer loop never ran; got %d", resp.StatusCode)
	}
}

func TestReadyz_sameSemantics(t *testing.T) {
	hs := &healthState{}
	mux := http.NewServeMux()
	registerHealthHandlers(mux, hs)
	srv := httptest.NewServer(mux)
	defer srv.Close()

	resp, err := http.Get(srv.URL + readyPath)
	if err != nil {
		t.Fatalf("GET /readyz: %v", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 503 {
		t.Errorf("expected 503 before reconcile; got %d", resp.StatusCode)
	}
}
