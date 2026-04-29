// peer-firewall-reconciler watches Kubernetes Node objects and keeps
// host nft sets `cluster_peers_v4` / `cluster_peers_v6` in sync with
// the cluster's InternalIPs. Used in firewall set-mode (Persona C —
// no private network underlay) to scope cluster-internal control-plane
// ports to peer node IPs without requiring an operator-managed CIDR.
//
// Runs as a DaemonSet on hostNetwork: true so nft inside the container
// shares the host's netfilter ruleset. Drops privileges to the bare
// minimum (CAP_NET_ADMIN) — the kernel netfilter API doesn't need
// CAP_SYS_ADMIN or full privileged.
//
// On clusters in cidr or single firewall mode, the nft sets do not
// exist; the reconciler detects this at startup and idles (sleeps
// forever) so the same DaemonSet manifest can ship to every cluster
// without any configuration drift.
package main

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"os"
	"os/exec"
	"os/signal"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"

	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/cache"
)

const (
	nftFamily      = "inet"
	nftTable       = "filter"
	setV4          = "cluster_peers_v4"
	setV6          = "cluster_peers_v6"
	floorReconcile = 30 * time.Second
	nftTimeout     = 5 * time.Second
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	v4Exists := nftSetExists(setV4)
	v6Exists := nftSetExists(setV6)
	if !v4Exists && !v6Exists {
		slog.Info("neither cluster_peers set declared — host firewall is in cidr or single mode; idling")
		idleForever()
		return
	}
	slog.Info("starting reconciler", "v4_set", v4Exists, "v6_set", v6Exists)

	cfg, err := rest.InClusterConfig()
	if err != nil {
		slog.Error("rest.InClusterConfig", "err", err)
		os.Exit(1)
	}
	clientset, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		slog.Error("kubernetes.NewForConfig", "err", err)
		os.Exit(1)
	}

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		sigs := make(chan os.Signal, 1)
		signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
		<-sigs
		slog.Info("shutdown signal received")
		cancel()
	}()

	factory := informers.NewSharedInformerFactory(clientset, 10*time.Minute)
	nodeInformer := factory.Core().V1().Nodes().Informer()
	nodeLister := factory.Core().V1().Nodes().Lister()

	r := &reconciler{
		nodes:   nodeLister,
		v4:      v4Exists,
		v6:      v6Exists,
		trigger: make(chan struct{}, 1),
		runNft:  realNftRunner,
	}
	if _, err := nodeInformer.AddEventHandler(cache.ResourceEventHandlerFuncs{
		AddFunc:    func(any) { r.kick() },
		UpdateFunc: func(any, any) { r.kick() },
		DeleteFunc: func(any) { r.kick() },
	}); err != nil {
		slog.Error("AddEventHandler", "err", err)
		os.Exit(1)
	}

	factory.Start(ctx.Done())
	if !cache.WaitForCacheSync(ctx.Done(), nodeInformer.HasSynced) {
		slog.Error("informer cache sync timed out")
		os.Exit(1)
	}
	slog.Info("informer cache synced")

	r.run(ctx)
}

// nodeLister is the minimal slice of corelisters.NodeLister we depend on.
// Defining it locally keeps the tests free of the full lister machinery.
type nodeLister interface {
	List(selector labels.Selector) ([]*corev1.Node, error)
}

type reconciler struct {
	nodes   nodeLister
	v4, v6  bool
	trigger chan struct{}
	// runNft is the nft executor; injectable so unit tests can swap it
	// for a fake without touching package-level state.
	runNft func([]byte) error

	mu   sync.Mutex
	last []byte
}

func (r *reconciler) kick() {
	select {
	case r.trigger <- struct{}{}:
	default:
	}
}

func (r *reconciler) run(ctx context.Context) {
	// Kick once at start so we don't wait floorReconcile for the first pass.
	r.kick()
	t := time.NewTicker(floorReconcile)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.trigger:
		case <-t.C:
		}
		if err := r.reconcileOnce(); err != nil {
			slog.Error("reconcile", "err", err)
		}
	}
}

func (r *reconciler) reconcileOnce() error {
	nodes, err := r.nodes.List(labels.Everything())
	if err != nil {
		return fmt.Errorf("list nodes: %w", err)
	}
	v4s, v6s := splitInternalIPs(nodes)
	script := buildNftScript(v4s, v6s, r.v4, r.v6)

	// reconcileOnce is only invoked from the single `run` goroutine,
	// so the build phase above is implicitly serialised. The mutex
	// guards `last` against any future caller that might invoke this
	// method concurrently (e.g. a health-check probe).
	r.mu.Lock()
	defer r.mu.Unlock()
	if bytes.Equal(script, r.last) {
		return nil
	}
	if len(script) > 0 {
		if err := r.runNft(script); err != nil {
			return fmt.Errorf("apply nft: %w", err)
		}
	}
	r.last = script
	slog.Info("peer sets reconciled",
		"v4_count", len(v4s), "v6_count", len(v6s),
		"v4", v4s, "v6", v6s)
	return nil
}

// splitInternalIPs separates Node.status.addresses[type=InternalIP] into
// IPv4 and IPv6 sorted slices. Sorted output makes the rendered nft
// script deterministic for the no-op short-circuit in reconcileOnce.
func splitInternalIPs(nodes []*corev1.Node) (v4, v6 []string) {
	for _, n := range nodes {
		for _, addr := range n.Status.Addresses {
			if addr.Type != corev1.NodeInternalIP {
				continue
			}
			ip := net.ParseIP(addr.Address)
			if ip == nil {
				continue
			}
			if ip.To4() != nil {
				v4 = append(v4, ip.String())
			} else {
				v6 = append(v6, ip.String())
			}
		}
	}
	sort.Strings(v4)
	sort.Strings(v6)
	return v4, v6
}

// buildNftScript emits an atomic `nft -f -` script that flushes each
// existing set and re-adds elements. Skips families whose set wasn't
// declared at startup. Empty element list is rendered as a flush
// without an add (a set with zero elements is valid).
func buildNftScript(v4, v6 []string, hasV4, hasV6 bool) []byte {
	var b bytes.Buffer
	if hasV4 {
		fmt.Fprintf(&b, "flush set %s %s %s\n", nftFamily, nftTable, setV4)
		if len(v4) > 0 {
			fmt.Fprintf(&b, "add element %s %s %s { %s }\n",
				nftFamily, nftTable, setV4, strings.Join(v4, ", "))
		}
	}
	if hasV6 {
		fmt.Fprintf(&b, "flush set %s %s %s\n", nftFamily, nftTable, setV6)
		if len(v6) > 0 {
			fmt.Fprintf(&b, "add element %s %s %s { %s }\n",
				nftFamily, nftTable, setV6, strings.Join(v6, ", "))
		}
	}
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

// nftSetExists checks whether the named set is declared on the host.
// hostNetwork shares the netfilter namespace, so a regular `nft list`
// inside the container reads the host ruleset.
func nftSetExists(name string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), nftTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, "nft", "list", "set", nftFamily, nftTable, name)
	if err := cmd.Run(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			return false
		}
		// Non-exit errors (binary missing) → log and assume absent.
		slog.Warn("nft list set failed", "set", name, "err", err)
		return false
	}
	return true
}

func idleForever() {
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	<-sigs
}
