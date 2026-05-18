package main

import (
	"errors"
	"os"
	"strings"
	"time"
)

// collector composes the per-loop snapshot from the sub-readers.
// Stateless aside from the hostRoot prefix.
type collector struct {
	hostRoot string
}

func newCollector(hostRoot string) *collector { return &collector{hostRoot: hostRoot} }

// collect runs every sub-reader and returns a Snapshot. Errors from
// individual sub-readers are collected into Snapshot.CollectErrors so
// the publisher still ships something useful when (say) sshd_config
// is unreadable.
func (c *collector) collect() (Snapshot, error) {
	nodeName, _ := os.Hostname()
	if env := os.Getenv("NODE_NAME"); env != "" {
		nodeName = env
	}
	snap := Snapshot{
		NodeName:    nodeName,
		GeneratedAt: time.Now().UTC().Format(time.RFC3339),
	}

	sshView := parseSSHDConfig(c.hostRoot)
	if sshView.parseError != nil {
		snap.CollectErrors = append(snap.CollectErrors, "sshd_config: "+sshView.parseError.Error())
	}

	fw := readFirewallConf(c.hostRoot)
	if !fw.loaded {
		snap.CollectErrors = append(snap.CollectErrors, "firewall.conf: not present (assuming SSH public)")
	}
	mesh := detectMesh(c.hostRoot)
	conntrack := collectConntrack(c.hostRoot)
	hardening := collectHardening(c.hostRoot, sshView, fw.ssh22IsPublic)

	snap.Mesh = mesh

	parseErrStr := errorString(sshView.parseError)
	snap.SSH = SSHExposure{
		RestrictionMode:    classifySSHRestriction(fw),
		SSHViaMeshFlag:     fw.sshViaMesh,
		EnforcedInterface:  fw.sshViaMeshInterface,
		SSHDFlags:          sshView.flags,
		ParseSucceeded:     sshView.parsed,
		ParseError:         parseErrStr,
	}
	snap.Hardening = hardening
	snap.Conntrack = conntrack
	snap.PublicPortsV4 = PublicPorts{
		TCP: fw.publicTCP,
		UDP: fw.publicUDP,
	}
	snap.TopDenied = []DeniedSourceWire{} // Phase 2.3

	if len(snap.CollectErrors) > 0 {
		// Don't fail the whole collect — return the partial snapshot
		// + a sentinel error so caller can log.
		return snap, errors.New("partial collect: " + strings.Join(snap.CollectErrors, "; "))
	}
	return snap, nil
}

func errorString(err error) *string {
	if err == nil {
		return nil
	}
	s := err.Error()
	return &s
}
