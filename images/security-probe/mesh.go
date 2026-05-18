package main

import (
	"bufio"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// detectMesh enumerates /sys/class/net/ for well-known mesh interface
// names and returns the first hit. Best-effort peer count from WG
// proc; null for NetBird/Tailscale (would require their binaries,
// which we explicitly DON'T bundle).
//
// Detection priority: netbird (wt0) > tailscale (tailscale0) > wireguard
// (wg0). Operators using vanilla WG should pin the interface name to
// wg0 in their config (standard convention) for the probe to recognise it.
func detectMesh(hostRoot string) MeshStatus {
	candidates := []struct {
		provider string
		iface    string
	}{
		{"netbird", "wt0"},
		{"tailscale", "tailscale0"},
		{"wireguard", "wg0"},
	}
	netDir := filepath.Join(hostRoot, "sys/class/net")
	entries, err := os.ReadDir(netDir)
	if err != nil {
		return MeshStatus{Provider: "none"}
	}
	present := map[string]bool{}
	for _, e := range entries {
		present[e.Name()] = true
	}
	for _, c := range candidates {
		if !present[c.iface] {
			continue
		}
		ip := firstIfaceIP(c.iface)
		status := MeshStatus{Provider: c.provider, InterfaceName: stringPtr(c.iface), InterfaceIP: ip}
		// WireGuard-style peer count from /proc/net/wireguard if the
		// kernel module exposes it. NetBird and Tailscale don't write
		// here, so peerCount stays nil for them.
		if c.provider == "wireguard" || c.provider == "netbird" {
			if peers, age := wgPeerStats(hostRoot, c.iface); peers >= 0 {
				p := peers
				status.PeerCount = &p
				if age >= 0 {
					a := age
					status.LastHandshakeAgeSecs = &a
				}
			}
		}
		return status
	}
	return MeshStatus{Provider: "none"}
}

// firstIfaceIP returns the first non-link-local IP bound to ifaceName,
// or nil if the interface has no address. Uses the Go net package
// because /proc/net/fib_trie parsing is overkill for one address.
func firstIfaceIP(ifaceName string) *string {
	iface, err := net.InterfaceByName(ifaceName)
	if err != nil {
		return nil
	}
	addrs, err := iface.Addrs()
	if err != nil {
		return nil
	}
	for _, a := range addrs {
		ipNet, ok := a.(*net.IPNet)
		if !ok {
			continue
		}
		ip := ipNet.IP
		if ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsLoopback() {
			continue
		}
		s := ip.String()
		return &s
	}
	return nil
}

// wgPeerStats parses /proc/net/wireguard if present (kernel module
// version). Returns (peers, ageSecondsOldestHandshake). Returns
// (-1, -1) when /proc/net/wireguard is unreadable or ifaceName isn't
// present. Best-effort — userspace wg-quick keeps state in
// /var/run/wireguard/ which we deliberately don't mount.
func wgPeerStats(hostRoot, ifaceName string) (int, int64) {
	f, err := os.Open(filepath.Join(hostRoot, "proc/net/wireguard"))
	if err != nil {
		return -1, -1
	}
	defer f.Close()

	scanner := bufio.NewScanner(f)
	peers := 0
	var newestHandshake int64 = 0
	matchedIface := false
	for scanner.Scan() {
		line := scanner.Text()
		fields := strings.Fields(line)
		if len(fields) == 0 {
			continue
		}
		// Lines for ifaceName start with the iface name; sub-lines
		// (peer entries) are tab-indented.
		if !strings.HasPrefix(line, "\t") {
			matchedIface = fields[0] == ifaceName
			continue
		}
		if !matchedIface {
			continue
		}
		peers++
		// Peer line format: tab + public-key + preshared-key +
		// endpoint + ... + last-handshake-time. Field count varies
		// across kernel versions; pick the last numeric-looking field
		// as last-handshake-unix.
		for _, f := range fields {
			if ts, err := strconv.ParseInt(f, 10, 64); err == nil && ts > newestHandshake {
				newestHandshake = ts
			}
		}
	}
	if peers == 0 {
		return 0, -1
	}
	age := time.Now().Unix() - newestHandshake
	if newestHandshake == 0 || age < 0 {
		return peers, -1
	}
	return peers, age
}

func stringPtr(s string) *string { return &s }
