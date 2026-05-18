package main

import (
	"os"
	"path/filepath"
	"testing"
)

func writeFirewallConf(t *testing.T, body string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "etc/hosting-platform"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "etc/hosting-platform/firewall.conf"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	return root
}

func TestReadFirewallConf_SSHPublicByDefault(t *testing.T) {
	root := t.TempDir() // no firewall.conf at all
	fw := readFirewallConf(root)
	if fw.loaded {
		t.Errorf("loaded should be false")
	}
	if !fw.ssh22IsPublic {
		t.Errorf("with no firewall.conf SSH must be reported as public")
	}
	if fw.sshViaMesh {
		t.Errorf("sshViaMesh should be false by default")
	}
}

func TestReadFirewallConf_SSHViaMesh(t *testing.T) {
	root := writeFirewallConf(t, `
PUBLIC_TCP_PORTS=80 443 8443 6443
PUBLIC_UDP_PORTS=51820 51821
SSH_VIA_MESH=true
SSH_VIA_MESH_INTERFACE=wt0
`)
	fw := readFirewallConf(root)
	if !fw.loaded {
		t.Errorf("loaded should be true")
	}
	if !fw.sshViaMesh {
		t.Errorf("sshViaMesh should be true")
	}
	if fw.sshViaMeshInterface == nil || *fw.sshViaMeshInterface != "wt0" {
		t.Errorf("interface=%v want wt0", fw.sshViaMeshInterface)
	}
	if fw.ssh22IsPublic {
		t.Errorf("with SSH_VIA_MESH=true and 22 not in PUBLIC_TCP_PORTS, SSH should NOT be public")
	}
	mode := classifySSHRestriction(fw)
	if mode != "mesh-and-trusted" {
		t.Errorf("classification=%s want mesh-and-trusted", mode)
	}
}

func TestReadFirewallConf_SSHViaMeshButPort22StillPublic(t *testing.T) {
	// Defensive: an operator-edited firewall.conf could declare 22
	// public even with SSH_VIA_MESH=true. The probe should report
	// the truth (public) and let the UI flag the contradiction.
	root := writeFirewallConf(t, `
PUBLIC_TCP_PORTS=22 80 443
SSH_VIA_MESH=true
SSH_VIA_MESH_INTERFACE=wt0
`)
	fw := readFirewallConf(root)
	if !fw.ssh22IsPublic {
		t.Errorf("operator listed 22 publicly — must report public regardless of SSH_VIA_MESH flag")
	}
}

func TestParsePortList_CommaAndSpaceMix(t *testing.T) {
	in := "80,443 8080  3000,3001"
	want := []int{80, 443, 8080, 3000, 3001}
	got := parsePortList(in)
	if len(got) != len(want) {
		t.Fatalf("len=%d want %d (%v)", len(got), len(want), got)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("got[%d]=%d want %d", i, got[i], want[i])
		}
	}
}

func TestParsePortList_RejectsInvalidPorts(t *testing.T) {
	// 0, 65536, negative, non-numeric — all dropped.
	in := "0 22 65535 65536 abc -1"
	got := parsePortList(in)
	want := []int{22, 65535}
	if len(got) != len(want) {
		t.Fatalf("got=%v want %v", got, want)
	}
}
