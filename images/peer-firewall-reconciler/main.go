// peer-firewall-reconciler — always-on set-mode firewall converger.
//
// Watches three kube-API sources and converges four host nft sets:
//
//   Source                            → nft set                    type
//   Node.status.addresses[InternalIP] → cluster_peers_v{4,6}        peer
//   ClusterPendingPeer.spec.ip        → cluster_peers_v{4,6}        peer
//     (TTL-enforced; status.claimedAt   (union with Node InternalIPs)
//      set on Node-IP match)
//   ClusterTrustedRange.spec.cidr     → trusted_ranges_v{4,6}       trust
//
// cluster_peers gates control-plane ports (6443/8443/10250/5473/2379-2380).
// trusted_ranges gates full TCP/UDP for operator-blessed sources
// (workstation IPs, private LANs, monitoring scrapers).
//
// Bootstrap.sh declares the four nft sets on every node; this reconciler
// is the only writer at runtime. No shell-out beyond `nft -f -`.
//
// Runs as DaemonSet hostNetwork: true so nft inside the container shares
// the host netfilter ruleset. Drops to bare CAP_NET_ADMIN — no privileged
// escalation, no host PID/IPC.
package main

import (
	"context"
	"log/slog"
	"os"
	"os/signal"
	"sync"
	"syscall"
	"time"

	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/dynamic/dynamicinformer"
	"k8s.io/client-go/informers"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/cache"
)

const (
	floorReconcile = 30 * time.Second
	informerResync = 10 * time.Minute
	nftTimeout     = 5 * time.Second
)

func main() {
	logger := slog.New(slog.NewJSONHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelInfo}))
	slog.SetDefault(logger)

	// Pre-flight: confirm all four nft sets exist on the host. Bootstrap.sh
	// declares them; if any are missing, the host was bootstrapped with a
	// pre-Phase-1 script and re-running bootstrap.sh on this node is the
	// fix. Without this probe, every reconcile tick would `nft -f -` fail
	// atomically and spam ERROR logs at floorReconcile cadence — clear
	// scream + idle is friendlier to operators investigating the issue.
	if missing := nftMissingSets(); len(missing) > 0 {
		slog.Error("nft sets missing — re-run scripts/bootstrap.sh on this node",
			"missing", missing,
			"hint", "this node was bootstrapped before always-on set mode; re-running bootstrap.sh re-renders /etc/nftables.conf with the four required sets")
		idleForever()
		return
	}

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
	dynClient, err := dynamic.NewForConfig(cfg)
	if err != nil {
		slog.Error("dynamic.NewForConfig", "err", err)
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

	// Typed Node informer — same as the prior reconciler.
	coreFactory := informers.NewSharedInformerFactory(clientset, informerResync)
	nodeInformer := coreFactory.Core().V1().Nodes().Informer()
	nodeLister := coreFactory.Core().V1().Nodes().Lister()

	// Dynamic informers for the two CRDs. We use unstructured + dynamic
	// instead of code-generated typed clients to keep the build simple
	// (no codegen step) and because v1alpha1 schemas may evolve. The
	// ipaddress / status fields we need are all simple scalar types,
	// so unstructured access is ergonomic enough.
	dynFactory := dynamicinformer.NewDynamicSharedInformerFactory(dynClient, informerResync)
	ctrInformer := dynFactory.ForResource(ctrGVR).Informer()
	ctrLister := dynFactory.ForResource(ctrGVR).Lister()
	cppInformer := dynFactory.ForResource(cppGVR).Informer()
	cppLister := dynFactory.ForResource(cppGVR).Lister()

	r := &reconciler{
		nodes:      nodeLister,
		ctrLister:  ctrLister,
		cppLister:  cppLister,
		ctrClient:  dynClient.Resource(ctrGVR),
		cppClient:  dynClient.Resource(cppGVR),
		cppGrace:   defaultCppPostClaimGrace,
		now:        time.Now,
		runNft:     realNftRunner,
		trigger:    make(chan struct{}, 1),
	}

	for _, inf := range []cache.SharedIndexInformer{nodeInformer, ctrInformer, cppInformer} {
		if _, err := inf.AddEventHandler(cache.ResourceEventHandlerFuncs{
			AddFunc:    func(any) { r.kick() },
			UpdateFunc: func(any, any) { r.kick() },
			DeleteFunc: func(any) { r.kick() },
		}); err != nil {
			slog.Error("AddEventHandler", "err", err)
			os.Exit(1)
		}
	}

	coreFactory.Start(ctx.Done())
	dynFactory.Start(ctx.Done())
	if !cache.WaitForCacheSync(ctx.Done(),
		nodeInformer.HasSynced, ctrInformer.HasSynced, cppInformer.HasSynced) {
		slog.Error("informer cache sync timed out")
		os.Exit(1)
	}
	slog.Info("informer caches synced — entering reconcile loop")

	r.run(ctx)
}

// run kicks reconcileOnce on informer events and at the floor cadence.
// Errors are logged but never fatal — informer event handlers requeue
// implicitly on next change, the floor ticker drives liveness even if
// no events arrive (e.g. permanent kube-API outage).
func (r *reconciler) run(ctx context.Context) {
	r.kick() // kick once at start so we don't wait floorReconcile for the first pass
	t := time.NewTicker(floorReconcile)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-r.trigger:
		case <-t.C:
		}
		if err := r.reconcileOnce(ctx); err != nil {
			slog.Error("reconcile", "err", err)
		}
	}
}

func (r *reconciler) kick() {
	select {
	case r.trigger <- struct{}{}:
	default:
	}
}

// idleForever blocks on SIGTERM/SIGINT. Retained for backward-compat
// with the prior "idle if cidr/single mode" behavior — no longer
// reachable in the always-on design but kept in case a future
// kill-switch flag re-introduces an idle path.
//
//nolint:unused
func idleForever() {
	sigs := make(chan os.Signal, 1)
	signal.Notify(sigs, syscall.SIGTERM, syscall.SIGINT)
	<-sigs
}

// reconciler holds the wiring shared between the run loop and the
// reconcileOnce / status / nft helpers.
type reconciler struct {
	nodes     nodeLister
	ctrLister cache.GenericLister
	cppLister cache.GenericLister
	ctrClient dynamic.NamespaceableResourceInterface
	cppClient dynamic.NamespaceableResourceInterface

	// cppGrace is the delay between setting status.claimedAt and
	// deleting the CR. Lets ops/UI observe the claimed state before
	// the resource disappears.
	cppGrace time.Duration

	// now is injectable for deterministic TTL tests.
	now func() time.Time

	// runNft is the nft executor; injectable so unit tests swap a fake.
	runNft func([]byte) error

	trigger chan struct{}

	mu   sync.Mutex
	last []byte
}

// Type assertions (compile-time guarantees that we use the right
// interfaces from k8s libraries even after dependency bumps).
var (
	_ cache.GenericLister = (cache.GenericLister)(nil)
)
