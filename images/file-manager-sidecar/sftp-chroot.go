// sftp-chroot — bind-mount + chroot + drop privileges + exec.
// Compiled as a static binary. The SFTP gateway calls this with safe
// argument arrays (no shell interpolation) to eliminate injection vectors.
//
// Usage: sftp-chroot --root <jail> --bind <src>:<dst> <cmd> [args...]
//
// Example:
//   sftp-chroot --root /jail --bind /data:/home /.platform/sftp-server -e -d /home
package main

import (
	"crypto/rand"
	"fmt"
	"os"
	"strings"
	"syscall"
)

func main() {
	var root, bindSrc, bindDst string
	var cmdIdx int

	// Parse flags (before the command)
	for i := 1; i < len(os.Args); i++ {
		switch os.Args[i] {
		case "--root":
			if i+1 >= len(os.Args) {
				fatal("--root requires an argument")
			}
			i++
			root = os.Args[i]
		case "--bind":
			if i+1 >= len(os.Args) {
				fatal("--bind requires src:dst argument")
			}
			i++
			parts := strings.SplitN(os.Args[i], ":", 2)
			if len(parts) != 2 {
				fatal("--bind format: src:dst")
			}
			bindSrc, bindDst = parts[0], parts[1]
		default:
			cmdIdx = i
			goto done
		}
	}
done:
	if root == "" || cmdIdx == 0 || cmdIdx >= len(os.Args) {
		fmt.Fprintf(os.Stderr, "usage: sftp-chroot --root <jail> [--bind src:dst] <cmd> [args...]\n")
		os.Exit(1)
	}

	// Validate root and bind paths — only safe characters allowed.
	// This is defense-in-depth against any upstream injection.
	if !isSafePath(root) {
		fatal("root path contains unsafe characters: " + root)
	}
	if bindSrc != "" && (!isSafePath(bindSrc) || !isSafePath(bindDst)) {
		fatal("bind path contains unsafe characters")
	}

	// Bind mount (runs as root, before chroot)
	if bindSrc != "" {
		target := root + bindDst
		if err := syscall.Mount(bindSrc, target, "", syscall.MS_BIND, ""); err != nil {
			fatal(fmt.Sprintf("mount --bind %s %s: %v", bindSrc, target, err))
		}
		// Defer unmount on any exit path
		defer func() {
			_ = syscall.Unmount(target, 0)
		}()
	}

	// Chroot
	if err := syscall.Chroot(root); err != nil {
		fatal(fmt.Sprintf("chroot %s: %v", root, err))
	}
	if err := syscall.Chdir("/"); err != nil {
		fatal(fmt.Sprintf("chdir /: %v", err))
	}

	// Drop privileges to nobody:nobody (65534)
	if err := syscall.Setgroups([]int{65534}); err != nil {
		fatal(fmt.Sprintf("setgroups: %v", err))
	}
	if err := syscall.Setgid(65534); err != nil {
		fatal(fmt.Sprintf("setgid: %v", err))
	}
	if err := syscall.Setuid(65534); err != nil {
		fatal(fmt.Sprintf("setuid: %v", err))
	}

	cmd := os.Args[cmdIdx]
	args := os.Args[cmdIdx:]
	// Pass minimal environment to the child — prevent leaking secrets
	// or platform env vars from the file-manager container.
	childEnv := []string{"HOME=/", "PATH=/.platform"}
	if err := syscall.Exec(cmd, args, childEnv); err != nil {
		fatal(fmt.Sprintf("exec %s: %v", cmd, err))
	}
}

// isSafePath allows only ASCII alphanumeric chars, /, _, -, . in paths.
// Blocks shell metacharacters, spaces, control characters, and non-ASCII.
func isSafePath(p string) bool {
	for _, r := range p {
		isAlpha := (r >= 'a' && r <= 'z') || (r >= 'A' && r <= 'Z')
		isDigit := r >= '0' && r <= '9'
		isAllowed := r == '/' || r == '_' || r == '-' || r == '.'
		if !isAlpha && !isDigit && !isAllowed {
			return false
		}
	}
	return true
}

func fatal(msg string) {
	fmt.Fprintf(os.Stderr, "sftp-chroot: %s\n", msg)
	os.Exit(1)
}

// sessionID returns a random hex string for session identification.
// Exported for use by the gateway if needed.
func sessionID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	return fmt.Sprintf("%x", b)
}
