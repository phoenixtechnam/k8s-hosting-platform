package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// helper — write a host-rooted /etc/ssh/sshd_config (and optional drop-in
// files) into a tmpdir and return the path to use as hostRoot.
func writeSSHDFixture(t *testing.T, main string, dropIn map[string]string) string {
	t.Helper()
	root := t.TempDir()
	if err := os.MkdirAll(filepath.Join(root, "etc/ssh/sshd_config.d"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(root, "etc/ssh/sshd_config"), []byte(main), 0o644); err != nil {
		t.Fatalf("write main: %v", err)
	}
	for name, body := range dropIn {
		if err := os.WriteFile(filepath.Join(root, "etc/ssh/sshd_config.d", name), []byte(body), 0o644); err != nil {
			t.Fatalf("write drop-in %s: %v", name, err)
		}
	}
	return root
}

func TestParseSSHDConfig_SimpleSecure(t *testing.T) {
	root := writeSSHDFixture(t, `
# Sample sshd_config
Port 2222
PermitRootLogin no
PasswordAuthentication no
KbdInteractiveAuthentication no
AllowUsers alice bob
`, nil)
	v := parseSSHDConfig(root)
	if !v.parsed {
		t.Fatalf("expected parsed; err=%v", v.parseError)
	}
	if v.flags.Port != 2222 {
		t.Errorf("Port=%d want 2222", v.flags.Port)
	}
	if v.flags.PermitRootLogin == nil || *v.flags.PermitRootLogin != "no" {
		t.Errorf("PermitRootLogin=%v want 'no'", v.flags.PermitRootLogin)
	}
	if v.flags.PasswordAuthentication == nil || *v.flags.PasswordAuthentication != "no" {
		t.Errorf("PasswordAuthentication=%v want 'no'", v.flags.PasswordAuthentication)
	}
	if v.flags.KbdInteractiveAuthentication == nil || *v.flags.KbdInteractiveAuthentication != "no" {
		t.Errorf("KbdInteractiveAuthentication=%v want 'no'", v.flags.KbdInteractiveAuthentication)
	}
	if len(v.flags.AllowUsers) != 2 || v.flags.AllowUsers[0] != "alice" || v.flags.AllowUsers[1] != "bob" {
		t.Errorf("AllowUsers=%v want [alice bob]", v.flags.AllowUsers)
	}
	if v.flags.ConfigSha256 == "" || v.flags.ConfigSha256 == emptySHA256 {
		t.Errorf("ConfigSha256 should be non-empty + non-default")
	}
}

func TestParseSSHDConfig_IncludeDropInDir(t *testing.T) {
	// Main file has Include for the drop-in dir; the drop-in flips
	// PermitRootLogin from yes to no. First-occurrence rule = the
	// MAIN file's value wins.
	root := writeSSHDFixture(t, `
Include /etc/ssh/sshd_config.d/*.conf
PermitRootLogin yes
Port 22
`, map[string]string{
		"00-harden.conf": "PermitRootLogin no\nPasswordAuthentication no\n",
	})
	v := parseSSHDConfig(root)
	if !v.parsed {
		t.Fatalf("expected parsed; err=%v", v.parseError)
	}
	// Drop-in is read FIRST (Include resolved before subsequent main
	// directives), so PermitRootLogin=no wins. sshd's first-
	// occurrence rule with drop-ins ordered first is the standard
	// hardening idiom — operators put hardening overrides in
	// 00-harden.conf so they win.
	if v.flags.PermitRootLogin == nil || *v.flags.PermitRootLogin != "no" {
		t.Errorf("Include-then-main: PermitRootLogin=%v want 'no'", v.flags.PermitRootLogin)
	}
	// Source file count: main + 1 drop-in = 2.
	if len(v.sourceFiles) != 2 {
		t.Errorf("sourceFiles=%v want 2 entries", v.sourceFiles)
	}
}

func TestParseSSHDConfig_MissingMain(t *testing.T) {
	root := t.TempDir() // no /etc/ssh/* at all
	v := parseSSHDConfig(root)
	if v.parsed {
		t.Errorf("expected parsed=false for missing sshd_config")
	}
	// Port falls back to the IANA default 22.
	if v.flags.Port != 22 {
		t.Errorf("default Port=%d want 22", v.flags.Port)
	}
	if v.flags.ConfigSha256 != emptySHA256 {
		t.Errorf("missing config sha256 should be the empty-input sha")
	}
}

func TestParseSSHDConfig_MatchBlockIgnored(t *testing.T) {
	root := writeSSHDFixture(t, `
PermitRootLogin yes
PasswordAuthentication yes

Match User backup
    PermitRootLogin no
    PasswordAuthentication no
`, nil)
	v := parseSSHDConfig(root)
	if !v.parsed {
		t.Fatalf("parse: %v", v.parseError)
	}
	// Match block is per-user; for posture reporting we want the
	// global default that an anonymous visitor would encounter.
	if v.flags.PermitRootLogin == nil || *v.flags.PermitRootLogin != "yes" {
		t.Errorf("Match-scoped override should NOT shadow global; got %v", v.flags.PermitRootLogin)
	}
}

func TestParseSSHDConfig_ChallengeResponseAlias(t *testing.T) {
	// Pre-7.6 directive name aliased to the modern KbdInteractive.
	root := writeSSHDFixture(t, `
ChallengeResponseAuthentication yes
`, nil)
	v := parseSSHDConfig(root)
	if !v.parsed {
		t.Fatalf("parse: %v", v.parseError)
	}
	if v.flags.KbdInteractiveAuthentication == nil || *v.flags.KbdInteractiveAuthentication != "yes" {
		t.Errorf("ChallengeResponse alias not mapped: got %v", v.flags.KbdInteractiveAuthentication)
	}
}

func TestParseSSHDConfig_AllowUsersSpaceSeparatedDedup(t *testing.T) {
	root := writeSSHDFixture(t, `
AllowUsers alice bob alice
AllowUsers carol
`, nil)
	v := parseSSHDConfig(root)
	if !v.parsed {
		t.Fatalf("parse: %v", v.parseError)
	}
	users := strings.Join(v.flags.AllowUsers, ",")
	if users != "alice,bob,carol" {
		t.Errorf("AllowUsers union+dedup wrong; got %s", users)
	}
}
