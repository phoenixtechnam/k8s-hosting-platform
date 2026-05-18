package main

import (
	"context"
	"net/http"
	"sync/atomic"
	"time"
)

// healthState publishes the last successful loop time so kubelet can
// declare the pod unhealthy after sustained stalls. Uses atomic
// int64 so the HTTP handler and the loop never block on a mutex.
type healthState struct {
	lastHealthyUnix atomic.Int64
}

func (h *healthState) markHealthy(t time.Time) { h.lastHealthyUnix.Store(t.Unix()) }

// startHealthServer brings up /healthz and /readyz on :8082. healthz
// returns 503 if the last successful loop was more than 5*interval
// ago (default = 5 min); readyz returns 200 once the first loop has
// completed.
func startHealthServer(ctx context.Context, hs *healthState) {
	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", func(w http.ResponseWriter, _ *http.Request) {
		last := hs.lastHealthyUnix.Load()
		if last == 0 {
			http.Error(w, "warming up", http.StatusServiceUnavailable)
			return
		}
		age := time.Now().Unix() - last
		// 5x the default loop interval — protects against transient
		// kube-API blips without flapping kubelet.
		if age > int64(5*defaultInterval.Seconds()) {
			http.Error(w, "stale", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) {
		if hs.lastHealthyUnix.Load() == 0 {
			http.Error(w, "warming up", http.StatusServiceUnavailable)
			return
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("ready"))
	})

	srv := &http.Server{
		Addr:              ":8082",
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
	}
	go func() {
		_ = srv.ListenAndServe()
	}()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = srv.Shutdown(shutdownCtx)
	}()
}
