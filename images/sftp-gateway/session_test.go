package main

import (
	"strings"
	"testing"
)

func TestBuildCommand_SFTP(t *testing.T) {
	tests := []struct {
		name         string
		homePath     string
		wantContains string // substring expected in the sh -c command
	}{
		{"root homePath", "/", "-d /home;"},
		{"subdirectory homePath", "/public_html", "-d /home/public_html;"},
		{"empty homePath defaults to root", "", "-d /home;"},
		{"traversal into .platform sanitized", "/../.platform", "-d /home;"},
		{"double traversal sanitized", "/../../etc", "-d /home;"},
		{"relative traversal sanitized", "../../etc/passwd", "-d /home/etc/passwd;"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildCommand("sftp", nil, tt.homePath)
			if len(got) != 3 || got[0] != "sh" || got[1] != "-c" {
				t.Fatalf("buildCommand(sftp) should be [sh -c <cmd>], got %v", got)
			}
			shellCmd := got[2]
			if !strings.Contains(shellCmd, tt.wantContains) {
				t.Errorf("shell command %q should contain %q", shellCmd, tt.wantContains)
			}
			// Must bind-mount PVC into jail
			if !strings.Contains(shellCmd, "mount --bind /data /jail/home") {
				t.Error("missing bind mount")
			}
			// Must use sftp-chroot for privilege drop
			if !strings.Contains(shellCmd, "sftp-chroot /jail") {
				t.Error("missing sftp-chroot call")
			}
			// Must unmount after session
			if !strings.Contains(shellCmd, "umount /jail/home") {
				t.Error("missing unmount cleanup")
			}
		})
	}
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
