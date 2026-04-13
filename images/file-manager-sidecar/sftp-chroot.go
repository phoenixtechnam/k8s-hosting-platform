// sftp-chroot — chroot + drop privileges + exec.
// Compiled as a static binary and used by the SFTP gateway to confine
// sftp-server to the jail directory while running as uid 65534 (nobody).
//
// Usage: sftp-chroot <root> <cmd> [args...]
package main

import (
	"fmt"
	"os"
	"syscall"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintf(os.Stderr, "usage: sftp-chroot <root> <cmd> [args...]\n")
		os.Exit(1)
	}
	root := os.Args[1]
	cmd := os.Args[2]
	args := os.Args[2:]

	if err := syscall.Chroot(root); err != nil {
		fmt.Fprintf(os.Stderr, "chroot %s: %v\n", root, err)
		os.Exit(1)
	}
	if err := syscall.Chdir("/"); err != nil {
		fmt.Fprintf(os.Stderr, "chdir: %v\n", err)
		os.Exit(1)
	}

	// Drop to nobody:nobody (65534)
	_ = syscall.Setgroups([]int{65534})
	if err := syscall.Setgid(65534); err != nil {
		fmt.Fprintf(os.Stderr, "setgid: %v\n", err)
		os.Exit(1)
	}
	if err := syscall.Setuid(65534); err != nil {
		fmt.Fprintf(os.Stderr, "setuid: %v\n", err)
		os.Exit(1)
	}

	if err := syscall.Exec(cmd, args, os.Environ()); err != nil {
		fmt.Fprintf(os.Stderr, "exec %s: %v\n", cmd, err)
		os.Exit(1)
	}
}
