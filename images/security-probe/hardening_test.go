package main

import "testing"

// helper — minimal sshConfigView builder.
func sshView(permitRoot, password, kbdInt string, allowUsers []string, parsed bool) sshConfigView {
	v := sshConfigView{parsed: parsed}
	v.flags = SSHFlags{Port: 22, AllowUsers: allowUsers, ConfigSha256: emptySHA256}
	pr := permitRoot
	if permitRoot != "" {
		v.flags.PermitRootLogin = &pr
	}
	pw := password
	if password != "" {
		v.flags.PasswordAuthentication = &pw
	}
	ki := kbdInt
	if kbdInt != "" {
		v.flags.KbdInteractiveAuthentication = &ki
	}
	return v
}

func TestCISFindings_HappyPath(t *testing.T) {
	ssh := sshView("no", "no", "no", []string{"admin"}, true)
	h := Hardening{
		TimeSinceRebootSecs:      30 * 24 * 3600,
		Fail2banPresent:          true,
		UnattendedUpgradesActive: true,
	}
	findings := buildCISFindings(ssh, h, false)
	failingCount := 0
	for _, f := range findings {
		if !f.Passing && f.Severity != "info" {
			failingCount++
			t.Logf("failing: %s (%s) %s observed=%s expected=%s", f.ID, f.Severity, f.Title, f.Observed, f.Expected)
		}
	}
	if failingCount > 0 {
		t.Errorf("expected zero non-info failures on happy-path host; got %d", failingCount)
	}
}

func TestCISFindings_PublicSSHIsCritical(t *testing.T) {
	ssh := sshView("no", "no", "no", []string{"admin"}, true)
	h := Hardening{TimeSinceRebootSecs: 30 * 24 * 3600, Fail2banPresent: true, UnattendedUpgradesActive: true}
	findings := buildCISFindings(ssh, h, true /* ssh22Public */)
	var net001 *CISFinding
	for i, f := range findings {
		if f.ID == "NET-001" {
			net001 = &findings[i]
			break
		}
	}
	if net001 == nil {
		t.Fatal("NET-001 missing")
	}
	if net001.Passing {
		t.Errorf("NET-001 should fail when SSH is public")
	}
	if net001.Severity != "critical" {
		t.Errorf("NET-001 severity=%s want critical", net001.Severity)
	}
}

func TestCISFindings_ParseFailureSurfacesPlaceholders(t *testing.T) {
	ssh := sshConfigView{parsed: false}
	ssh.flags = SSHFlags{Port: 22}
	h := Hardening{TimeSinceRebootSecs: 1000}
	findings := buildCISFindings(ssh, h, true)
	// SSH-001..005 should all show "(sshd_config parse failed)" in
	// observed AND be marked non-passing.
	for _, f := range findings {
		if f.ID == "SSH-001" || f.ID == "SSH-002" || f.ID == "SSH-003" || f.ID == "SSH-005" {
			if f.Observed != "(sshd_config parse failed)" {
				t.Errorf("%s observed=%q want '(sshd_config parse failed)'", f.ID, f.Observed)
			}
			if f.Passing {
				t.Errorf("%s should NOT be passing when sshd_config parse failed", f.ID)
			}
		}
	}
}

func TestCISFindings_NeverPassingOnEmptyAllowUsers(t *testing.T) {
	ssh := sshView("no", "no", "no", []string{}, true)
	h := Hardening{TimeSinceRebootSecs: 1000, Fail2banPresent: true, UnattendedUpgradesActive: true}
	findings := buildCISFindings(ssh, h, false)
	for _, f := range findings {
		if f.ID == "SSH-003" && f.Passing {
			t.Errorf("SSH-003 should fail when AllowUsers is empty")
		}
	}
}
