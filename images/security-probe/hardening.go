package main

import (
	"bufio"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// collectHardening assembles the CIS-style snapshot from host reads.
// All host paths are resolved under hostRoot to keep tests
// hermetic.
//
// CIS findings here are the Phase 1 hand-picked subset (≤10 rules).
// See docs/04-deployment/SECURITY_HARDENING_ROADMAP.md for the full
// list and why each was chosen.
func collectHardening(hostRoot string, ssh sshConfigView, ssh22Public bool) Hardening {
	h := Hardening{
		KernelVersion: readKernelVersion(hostRoot),
		OSPretty:      readOSPretty(hostRoot),
	}
	h.TimeSinceRebootSecs = bootAgeSeconds(hostRoot)
	h.Fail2banPresent = anyBinaryPresent(hostRoot, "fail2ban-server", "fail2ban-client")
	h.SshguardPresent = anyBinaryPresent(hostRoot, "sshguard")
	h.UnattendedUpgradesActive = unattendedUpgradesPresent(hostRoot)
	h.AutomaticRebootWindow = nil
	h.PendingKernelUpdate = false
	h.KernelEOL = false

	h.CISFindings = buildCISFindings(ssh, h, ssh22Public)
	return h
}

func readKernelVersion(hostRoot string) string {
	b, err := os.ReadFile(filepath.Join(hostRoot, "proc/sys/kernel/osrelease"))
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}

func readOSPretty(hostRoot string) string {
	f, err := os.Open(filepath.Join(hostRoot, "etc/os-release"))
	if err != nil {
		return ""
	}
	defer f.Close()
	scanner := bufio.NewScanner(f)
	for scanner.Scan() {
		line := scanner.Text()
		if strings.HasPrefix(line, "PRETTY_NAME=") {
			v := strings.TrimPrefix(line, "PRETTY_NAME=")
			v = strings.TrimSpace(v)
			v = strings.Trim(v, "\"'")
			return v
		}
	}
	return ""
}

// bootAgeSeconds reads /proc/stat for `btime <epoch>` which is the
// system boot time. Returns 0 on read or parse failure.
func bootAgeSeconds(hostRoot string) int64 {
	b, err := os.ReadFile(filepath.Join(hostRoot, "proc/stat"))
	if err != nil {
		return 0
	}
	for _, line := range strings.Split(string(b), "\n") {
		if strings.HasPrefix(line, "btime ") {
			parts := strings.Fields(line)
			if len(parts) != 2 {
				return 0
			}
			ts, err := strconv.ParseInt(parts[1], 10, 64)
			if err != nil {
				return 0
			}
			age := time.Now().Unix() - ts
			if age < 0 {
				return 0
			}
			return age
		}
	}
	return 0
}

// anyBinaryPresent checks /usr/sbin and /usr/bin under hostRoot for
// any of the given binary names. Returns true on the first hit.
// Doesn't `stat` — `Lstat` is enough to detect symlinks to the
// binary as well as the binary itself.
func anyBinaryPresent(hostRoot string, names ...string) bool {
	for _, dir := range []string{"usr/sbin", "usr/bin"} {
		for _, n := range names {
			p := filepath.Join(hostRoot, dir, n)
			if _, err := os.Lstat(p); err == nil {
				return true
			}
		}
	}
	return false
}

// unattendedUpgradesPresent looks for the apt unattended-upgrades
// binary OR the dnf-automatic binary. Doesn't VERIFY the service is
// enabled — that'd require a `systemctl is-enabled` call which we
// can't issue from a read-only container without exec capability.
// Presence of the binary is a useful first signal; the CIS finding
// downgrades severity to medium for that reason.
func unattendedUpgradesPresent(hostRoot string) bool {
	return anyBinaryPresent(hostRoot,
		"unattended-upgrade", "unattended-upgrades",
		"dnf-automatic",
	)
}

// buildCISFindings encodes the Phase 1 ≤10 rules. Each rule's
// (passing, observed, expected) is derived from the inputs only —
// no further IO — so this function is trivial to unit-test.
func buildCISFindings(ssh sshConfigView, h Hardening, ssh22Public bool) []CISFinding {
	deref := func(s *string) string {
		if s == nil {
			return ""
		}
		return *s
	}
	findings := []CISFinding{
		{
			ID:       "SSH-001",
			Severity: "high",
			Title:    "PermitRootLogin should be no",
			Observed: orParseError(ssh, deref(ssh.flags.PermitRootLogin)),
			Expected: "no",
			Passing:  ssh.parsed && strings.EqualFold(deref(ssh.flags.PermitRootLogin), "no"),
		},
		{
			ID:       "SSH-002",
			Severity: "high",
			Title:    "PasswordAuthentication should be no",
			Observed: orParseError(ssh, deref(ssh.flags.PasswordAuthentication)),
			Expected: "no",
			Passing:  ssh.parsed && strings.EqualFold(deref(ssh.flags.PasswordAuthentication), "no"),
		},
		{
			ID:       "SSH-003",
			Severity: "medium",
			Title:    "AllowUsers whitelist set",
			Observed: orParseError(ssh, strings.Join(ssh.flags.AllowUsers, " ")),
			Expected: "non-empty list",
			Passing:  ssh.parsed && len(ssh.flags.AllowUsers) > 0,
		},
		{
			ID:       "SSH-004",
			Severity: "info",
			Title:    "Port is non-default (security by obscurity, informational)",
			Observed: strconv.Itoa(ssh.flags.Port),
			Expected: "≠ 22",
			Passing:  ssh.flags.Port != 22,
		},
		{
			ID:       "SSH-005",
			Severity: "medium",
			Title:    "KbdInteractiveAuthentication should be no",
			Observed: orParseError(ssh, deref(ssh.flags.KbdInteractiveAuthentication)),
			Expected: "no",
			Passing:  ssh.parsed && strings.EqualFold(deref(ssh.flags.KbdInteractiveAuthentication), "no"),
		},
		{
			ID:       "KERNEL-001",
			Severity: "medium",
			Title:    "Boot age within 90 days",
			Observed: formatBootAge(h.TimeSinceRebootSecs),
			Expected: "< 90d",
			Passing:  h.TimeSinceRebootSecs > 0 && h.TimeSinceRebootSecs < 90*24*3600,
		},
		{
			ID:       "KERNEL-002",
			Severity: "medium",
			Title:    "No pending kernel update",
			Observed: boolStr(h.PendingKernelUpdate),
			Expected: "false",
			Passing:  !h.PendingKernelUpdate,
		},
		{
			ID:       "HARDEN-001",
			Severity: "medium",
			Title:    "fail2ban or sshguard present",
			Observed: boolStr(h.Fail2banPresent || h.SshguardPresent),
			Expected: "true",
			Passing:  h.Fail2banPresent || h.SshguardPresent,
		},
		{
			ID:       "HARDEN-002",
			Severity: "medium",
			Title:    "unattended-upgrades / dnf-automatic installed",
			Observed: boolStr(h.UnattendedUpgradesActive),
			Expected: "true",
			Passing:  h.UnattendedUpgradesActive,
		},
		{
			ID:       "NET-001",
			Severity: "critical",
			Title:    "SSH not exposed to 0.0.0.0/0",
			Observed: ifTrueElse(ssh22Public, "public (any IP can connect on :22)", "scoped"),
			Expected: "scoped (mesh or trusted_ranges only)",
			Passing:  !ssh22Public,
		},
	}
	return findings
}

func orParseError(ssh sshConfigView, v string) string {
	if !ssh.parsed {
		return "(sshd_config parse failed)"
	}
	if v == "" {
		return "(unset)"
	}
	return v
}

func formatBootAge(secs int64) string {
	if secs <= 0 {
		return "unknown"
	}
	d := time.Duration(secs) * time.Second
	return d.Truncate(time.Hour).String()
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}

func ifTrueElse(b bool, t, f string) string {
	if b {
		return t
	}
	return f
}
