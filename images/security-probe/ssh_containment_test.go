package main

import (
	"os"
	"path/filepath"
	"testing"
)

// Guards against the security review HIGH finding: a crafted
// sshd_config Include must NOT cause the walker to read files
// outside hostRoot. The mount narrowing in daemonset.yaml is the
// primary defense; this is defense-in-depth.

func TestParseSSHDConfig_IncludeEscapeRejected(t *testing.T) {
	root := t.TempDir()
	// Set up a "private key" outside the simulated hostRoot.
	outside := filepath.Join(t.TempDir(), "private")
	if err := os.WriteFile(outside, []byte("PRIVATE-KEY-MATERIAL"), 0o600); err != nil {
		t.Fatal(err)
	}

	// Build /etc/ssh inside our hostRoot.
	if err := os.MkdirAll(filepath.Join(root, "etc/ssh"), 0o755); err != nil {
		t.Fatal(err)
	}
	// sshd_config with a host-absolute Include pointing at the
	// outside file. After hostRoot rewriting, this would normally
	// resolve to hostRoot+outside — but the absolute-prefix
	// rewrite path joins it under hostRoot, so the resolved path
	// would be e.g. <root>/<outside_path>. The containment guard
	// must reject it.
	body := "Include " + outside + "\nPermitRootLogin yes\n"
	if err := os.WriteFile(filepath.Join(root, "etc/ssh/sshd_config"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	v := parseSSHDConfig(root)
	// We expect the main file to parse successfully (PermitRootLogin
	// yes is in main, not in the Include), and the outside file to
	// be SKIPPED — its content must NOT appear in merged.
	if !v.parsed {
		t.Fatalf("main config should parse: %v", v.parseError)
	}
	if contains(v.mergedText, "PRIVATE-KEY-MATERIAL") {
		t.Fatalf("path containment guard FAILED: outside-hostRoot file contents leaked into merged stream")
	}
	if len(v.sourceFiles) != 1 {
		t.Errorf("sourceFiles=%v want exactly the main sshd_config (Include escape should be rejected)", v.sourceFiles)
	}
}

func TestParseSSHDConfig_IncludeWithDotDotRejected(t *testing.T) {
	root := t.TempDir()
	// Set up something at <tempdir>/private (sibling of hostRoot).
	siblingTmp := t.TempDir()
	private := filepath.Join(siblingTmp, "secret-key")
	if err := os.WriteFile(private, []byte("SECRET-KEY-MATERIAL"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "etc/ssh"), 0o755); err != nil {
		t.Fatal(err)
	}
	// Use a relative Include with .. — sshd resolves these against
	// /etc/ssh by convention. Our walker joins relative paths to
	// etcSshDir, so this becomes <root>/etc/ssh/../../<siblingTmp>/secret-key,
	// which after Clean is <siblingTmp>/secret-key — outside hostRoot.
	relTarget := "../../" + siblingTmp[1:] + "/secret-key"
	body := "Include " + relTarget + "\nPermitRootLogin no\n"
	if err := os.WriteFile(filepath.Join(root, "etc/ssh/sshd_config"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	v := parseSSHDConfig(root)
	if contains(v.mergedText, "SECRET-KEY-MATERIAL") {
		t.Fatal("path containment guard FAILED for relative .. escape")
	}
}

func contains(haystack, needle string) bool {
	return len(haystack) >= len(needle) && (haystack == needle || idx(haystack, needle) >= 0)
}

func idx(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
