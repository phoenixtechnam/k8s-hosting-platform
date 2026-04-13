package main

import (
	"strings"
	"testing"
)

func TestBuildCommand_SFTP(t *testing.T) {
	tests := []struct {
		name     string
		homePath string
		wantDir  string // expected -d argument
	}{
		{"root homePath", "/", "/home"},
		{"subdirectory homePath", "/public_html", "/home/public_html"},
		{"empty homePath defaults to root", "", "/home"},
		{"traversal into .platform sanitized", "/../.platform", "/home"},
		{"double traversal sanitized", "/../../etc", "/home"},
		{"relative traversal sanitized", "../../etc/passwd", "/home/etc/passwd"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildCommand("sftp", nil, tt.homePath)
			// Must be direct argument array, NOT sh -c (prevents shell injection)
			if got[0] == "sh" {
				t.Fatal("SFTP must not use sh -c — use sftp-chroot binary directly")
			}
			if got[0] != "sftp-chroot" {
				t.Fatalf("expected sftp-chroot, got %q", got[0])
			}
			// Check --root, --bind flags
			assertContains(t, got, "--root")
			assertContains(t, got, "--bind")
			assertContains(t, got, "/data:/home")
			// Check -d flag value
			for i, arg := range got {
				if arg == "-d" && i+1 < len(got) {
					if got[i+1] != tt.wantDir {
						t.Errorf("-d = %q, want %q", got[i+1], tt.wantDir)
					}
					return
				}
			}
			t.Error("missing -d flag in command")
		})
	}
}

func assertContains(t *testing.T, args []string, want string) {
	t.Helper()
	for _, a := range args {
		if a == want || strings.Contains(a, want) {
			return
		}
	}
	t.Errorf("args %v should contain %q", args, want)
}

func TestBuildCommand_SCP(t *testing.T) {
	cmd := "scp -t /upload/file.txt"
	got := buildCommand("scp", &cmd, "/")
	// SCP should still use path rewriting (not chroot)
	if got[0] != "scp" {
		t.Errorf("SCP command should start with 'scp', got %q", got[0])
	}
	// Path should be rewritten under /data
	found := false
	for _, arg := range got {
		if arg == "/data/upload/file.txt" {
			found = true
		}
	}
	if !found {
		t.Errorf("SCP path not rewritten under /data, got %v", got)
	}
}

func TestBuildCommand_Rsync(t *testing.T) {
	cmd := "rsync --server -logDtpre.iLsfxCIvu . /some/path"
	got := buildCommand("rsync", &cmd, "/")
	// Path after "." should be rewritten under /data
	found := false
	for _, arg := range got {
		if arg == "/data/some/path" {
			found = true
		}
	}
	if !found {
		t.Errorf("rsync path not rewritten under /data, got %v", got)
	}
}

func TestBuildCommand_Unknown(t *testing.T) {
	got := buildCommand("unknown", nil, "/")
	if got != nil {
		t.Errorf("unknown protocol should return nil, got %v", got)
	}
}

func TestSanitizePath(t *testing.T) {
	tests := []struct {
		name     string
		arg      string
		dataRoot string
		want     string
	}{
		{"normal path", "/file.txt", "/data", "/data/file.txt"},
		{"traversal attempt", "../../etc/passwd", "/data", "/data/etc/passwd"},
		{"double slash", "//etc/passwd", "/data", "/data/etc/passwd"},
		{"null byte", "file\x00.txt", "/data", "/data"},
		{"root escape", "/", "/data", "/data"},
		{"subdir", "/sub/dir/file.txt", "/data/home", "/data/home/sub/dir/file.txt"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := sanitizePath(tt.arg, tt.dataRoot)
			if got != tt.want {
				t.Errorf("sanitizePath(%q, %q) = %q, want %q", tt.arg, tt.dataRoot, got, tt.want)
			}
		})
	}
}
