// HTTP liveness/readiness endpoint.
//
// Exposes /healthz on a small HTTP server so kubelet probes can
// detect when reconcile loops stall. Both loops have an
// atomic.Int64 storing the unix-nano timestamp of their most recent
// successful reconcileOnce; /healthz returns 200 iff BOTH timestamps
// are within healthMaxAge of now.
//
// hostNetwork:true means the server's listening address is the
// host's network namespace. Kubelet probes the pod's IP, which
// under hostNetwork resolves to the node's IP, so we listen on
// the wildcard 0.0.0.0:8081. The host's existing nft chains
// (input policy drop + iif lo accept) gate external traffic; the
// kubelet probe originates from the same node so it traverses lo
// and is allowed. Direct external probes from a non-peer IP would
// be dropped at the input chain — the endpoint is not exposed.

package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"sync/atomic"
	"time"
)

const (
	healthAddr   = ":8081"
	healthPath   = "/healthz"
	readyPath    = "/readyz"
	healthMaxAge = 90 * time.Second
)

// healthState publishes the most recent successful-reconcile
// timestamp for each loop. Written by the reconcile goroutines via
// markPeerHealthy / markTenantHealthy; read by the HTTP handler.
// atomic.Int64 keeps the writes lock-free and the reads consistent
// without blocking reconciles.
type healthState struct {
	peerLastSuccess   atomic.Int64 // unix nanos; 0 = never
	tenantLastSuccess atomic.Int64
}

func (h *healthState) markPeerHealthy(now time.Time)   { h.peerLastSuccess.Store(now.UnixNano()) }
func (h *healthState) markTenantHealthy(now time.Time) { h.tenantLastSuccess.Store(now.UnixNano()) }

// fresh reports whether `ts` (unix nanos) is within healthMaxAge of
// now. ts == 0 means "never reconciled" → not fresh.
func fresh(tsNanos int64, now time.Time) bool {
	if tsNanos == 0 {
		return false
	}
	age := now.Sub(time.Unix(0, tsNanos))
	return age >= 0 && age <= healthMaxAge
}

// registerHealthHandlers wires /healthz and /readyz into a mux. Both
// return 200 iff BOTH reconcile loops have published a successful
// timestamp within healthMaxAge of now.
//
// Today the two endpoints share the same condition; splitting them
// lets kubelet's manifest configure them independently (readiness
// pulls the pod out of service quickly; liveness restarts after a
// longer threshold). If we ever want different staleness windows we
// only need to introduce a per-handler threshold here.
func registerHealthHandlers(mux *http.ServeMux, h *healthState) {
	mux.HandleFunc(healthPath, func(w http.ResponseWriter, _ *http.Request) {
		now := time.Now()
		peerOK := fresh(h.peerLastSuccess.Load(), now)
		tenantOK := fresh(h.tenantLastSuccess.Load(), now)
		if peerOK && tenantOK {
			w.WriteHeader(http.StatusOK)
			_, _ = fmt.Fprintln(w, "ok")
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = fmt.Fprintf(w, "stale: peer=%v tenant=%v\n", peerOK, tenantOK)
	})
	mux.HandleFunc(readyPath, func(w http.ResponseWriter, _ *http.Request) {
		now := time.Now()
		peerOK := fresh(h.peerLastSuccess.Load(), now)
		tenantOK := fresh(h.tenantLastSuccess.Load(), now)
		if peerOK && tenantOK {
			w.WriteHeader(http.StatusOK)
			_, _ = fmt.Fprintln(w, "ready")
			return
		}
		w.WriteHeader(http.StatusServiceUnavailable)
		_, _ = fmt.Fprintln(w, "warming up")
	})
}

// startHealthServer launches the HTTP probe endpoint and shuts it
// down cleanly when ctx is cancelled. Errors from ListenAndServe
// other than http.ErrServerClosed are logged at WARN — a probe
// failure shouldn't crash the pod.
func startHealthServer(ctx context.Context, h *healthState) {
	mux := http.NewServeMux()
	registerHealthHandlers(mux, h)
	srv := &http.Server{
		Addr:              healthAddr,
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
	go func() {
		err := srv.ListenAndServe()
		if err != nil && !errors.Is(err, http.ErrServerClosed) {
			slog.Warn("health server exited", "err", err)
		}
	}()
}
