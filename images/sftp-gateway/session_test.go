package main

import (
	"testing"
)

func TestBuildCommand_SFTP(t *testing.T) {
	tests := []struct {
		name     string
		homePath string
		wantCmd  []string
	}{
		{
			name:     "root homePath",
			homePath: "/",
			wantCmd:  []string{"chroot", "/data", "/.platform/sftp-server", "-e", "-d", "/"},
		},
		{
			name:     "subdirectory homePath",
			homePath: "/public_html",
			wantCmd:  []string{"chroot", "/data", "/.platform/sftp-server", "-e", "-d", "/public_html"},
		},
		{
			name:     "empty homePath defaults to root",
			homePath: "",
			wantCmd:  []string{"chroot", "/data", "/.platform/sftp-server", "-e", "-d", "/"},
		},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := buildCommand("sftp", nil, tt.homePath)
			if len(got) != len(tt.wantCmd) {
				t.Fatalf("buildCommand(sftp) = %v, want %v", got, tt.wantCmd)
			}
			for i := range got {
				if got[i] != tt.wantCmd[i] {
					t.Errorf("buildCommand(sftp)[%d] = %q, want %q", i, got[i], tt.wantCmd[i])
				}
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
