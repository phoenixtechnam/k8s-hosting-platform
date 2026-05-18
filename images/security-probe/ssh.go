package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
)

// sshConfigDir holds the merged sshd_config view + sha256 + parse
// status. Empty slices/maps are still safe to consume.
type sshConfigView struct {
	flags        SSHFlags
	parsed       bool
	parseError   error
	sourceFiles  []string
	mergedText   string
}

// parseSSHDConfig reads `<hostRoot>/etc/ssh/sshd_config`, follows any
// Include directives (including drop-in dir `/etc/ssh/sshd_config.d/`),
// and returns the FIRST-occurrence value for each directive sshd
// honors (sshd's own precedence rule for non-Match-scoped directives).
//
// We deliberately ignore Match blocks: a per-user Match could
// override a global PermitRootLogin yes back to no, but for posture
// reporting we want the most-permissive global default so operators
// see what an unauthenticated visitor encounters.
//
// On any parse failure we return parsed=false and a zero-value
// SSHFlags with port=22 (the IANA default). Callers MUST check
// parsed before treating flags as authoritative.
func parseSSHDConfig(hostRoot string) sshConfigView {
	root := filepath.Join(hostRoot, "etc/ssh/sshd_config")
	view := sshConfigView{
		flags: SSHFlags{Port: 22, AllowUsers: []string{}, ConfigSha256: emptySHA256},
	}

	files, mergedBytes, err := readAllSSHDConfig(root, filepath.Dir(root), hostRoot)
	if err != nil {
		view.parseError = err
		view.flags.ConfigSha256 = sha256Hex(mergedBytes)
		return view
	}
	// No main sshd_config readable — we cannot claim to have parsed
	// the config, even though the walk didn't error.
	if len(files) == 0 {
		view.parseError = fmt.Errorf("sshd_config not readable at %q", root)
		view.flags.ConfigSha256 = sha256Hex(mergedBytes)
		return view
	}

	view.sourceFiles = files
	view.mergedText = string(mergedBytes)
	view.flags.ConfigSha256 = sha256Hex(mergedBytes)

	// First-occurrence values across the merged stream.
	seen := map[string]string{}
	port := 0
	allow := []string{}
	scanner := bufio.NewScanner(strings.NewReader(view.mergedText))
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	inMatch := false
	for scanner.Scan() {
		raw := scanner.Text()
		line := strings.TrimSpace(raw)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		// Cheap Match-scope skip. sshd's grammar terminates a Match
		// block at the next Match line or EOF; we want only the
		// global scope.
		if strings.HasPrefix(strings.ToLower(line), "match ") || strings.EqualFold(line, "match all") {
			inMatch = true
			continue
		}
		if inMatch && (strings.HasPrefix(line, " ") || strings.HasPrefix(line, "\t")) {
			continue
		}
		if !strings.HasPrefix(raw, " ") && !strings.HasPrefix(raw, "\t") {
			inMatch = false
		}
		// Directive name is case-insensitive in sshd; normalise.
		parts := strings.Fields(line)
		if len(parts) == 0 {
			continue
		}
		k := strings.ToLower(parts[0])
		val := strings.TrimSpace(strings.TrimPrefix(line, parts[0]))
		switch k {
		case "permitrootlogin", "passwordauthentication", "kbdinteractiveauthentication", "challengeresponseauthentication":
			// sshd treats ChallengeResponseAuthentication as the
			// pre-7.6 alias for KbdInteractiveAuthentication. Map
			// it forward so the wire format is stable.
			canonical := k
			if k == "challengeresponseauthentication" {
				canonical = "kbdinteractiveauthentication"
			}
			if _, ok := seen[canonical]; !ok {
				seen[canonical] = strings.ToLower(val)
			}
		case "port":
			if port == 0 {
				if p, perr := strconv.Atoi(val); perr == nil && p > 0 && p < 65536 {
					port = p
				}
			}
		case "allowusers":
			allow = append(allow, parts[1:]...)
		}
	}
	if err := scanner.Err(); err != nil {
		view.parseError = fmt.Errorf("scan merged sshd_config: %w", err)
		return view
	}

	view.parsed = true
	if port > 0 {
		view.flags.Port = port
	}
	if v, ok := seen["permitrootlogin"]; ok {
		v := v
		view.flags.PermitRootLogin = &v
	}
	if v, ok := seen["passwordauthentication"]; ok {
		v := v
		view.flags.PasswordAuthentication = &v
	}
	if v, ok := seen["kbdinteractiveauthentication"]; ok {
		v := v
		view.flags.KbdInteractiveAuthentication = &v
	}
	// Deduplicate AllowUsers — sshd treats it as the union of all
	// listed users so duplicates are harmless but noisy.
	view.flags.AllowUsers = dedupeStrings(allow)
	return view
}

// readAllSSHDConfig walks the main sshd_config plus any Include
// targets (relative paths resolved against /etc/ssh/, glob patterns
// expanded). Returns a merged stream that preserves sshd's natural
// processing order: when an Include directive appears on line N of
// the parent file, the included file's content is inserted INTO the
// merged stream at line N+1, BEFORE the rest of the parent file's
// lines. This is what sshd actually does — first-occurrence rules
// applied to the merged stream match sshd's runtime behaviour.
//
// files lists every path actually read in walk order. Maximum 16
// includes total — a hard cap to defuse pathological Include-
// Include recursion.
func readAllSSHDConfig(mainPath, etcSshDir, hostRoot string) ([]string, []byte, error) {
	const maxFiles = 16
	visited := map[string]bool{}
	var files []string
	var merged strings.Builder

	var walk func(path string) error
	walk = func(path string) error {
		if len(files) >= maxFiles {
			return fmt.Errorf("sshd_config Include chain exceeded %d files (refusing to follow further)", maxFiles)
		}
		// Resolve relative paths against /etc/ssh/ per sshd
		// man-page.
		if !filepath.IsAbs(path) {
			path = filepath.Join(etcSshDir, path)
		} else if hostRoot != "" && hostRoot != "/" && !strings.HasPrefix(path, hostRoot+"/") {
			// Rewrite host-absolute Include targets to hostRoot-
			// prefixed paths. sshd_config commonly contains
			// `Include /etc/ssh/sshd_config.d/*.conf`; the probe
			// reads via /host/etc/ssh/ so that absolute path on the
			// container side would point at the wrong filesystem.
			path = filepath.Join(hostRoot, path)
		}
		// Glob may yield ZERO matches — sshd treats that as benign,
		// so do we.
		matches, err := filepath.Glob(path)
		if err != nil {
			return fmt.Errorf("glob %q: %w", path, err)
		}
		sort.Strings(matches)
		for _, m := range matches {
			if visited[m] {
				continue
			}
			// Path-containment guard: every resolved file must live
			// under hostRoot. A crafted sshd_config with
			// `Include /etc/ssh/ssh_host_ed25519_key` (or worse,
			// `Include /etc/ssh/../../etc/shadow`) would otherwise
			// have the probe read host-private material into the
			// merged stream. The mount narrowing in daemonset.yaml
			// is the primary defense; this is defense-in-depth.
			if hostRoot != "" && hostRoot != "/" {
				cleaned := filepath.Clean(m)
				rel, relErr := filepath.Rel(hostRoot, cleaned)
				if relErr != nil || strings.HasPrefix(rel, "..") || rel == ".." {
					continue
				}
			}
			visited[m] = true
			b, rerr := os.ReadFile(m)
			if rerr != nil {
				// Skip unreadable drop-ins (mode 0600, etc.). Don't
				// fail the whole parse.
				continue
			}
			files = append(files, m)
			// Walk line-by-line, splicing Include targets INLINE
			// (before continuing parent's remaining lines) so the
			// merged stream's first-occurrence ordering matches the
			// order sshd processes directives at runtime.
			scanner := bufio.NewScanner(strings.NewReader(string(b)))
			for scanner.Scan() {
				line := scanner.Text()
				merged.WriteString(line)
				merged.WriteString("\n")
				trim := strings.TrimSpace(line)
				if strings.HasPrefix(strings.ToLower(trim), "include ") {
					parts := strings.Fields(trim)
					for _, target := range parts[1:] {
						if werr := walk(target); werr != nil {
							return werr
						}
					}
				}
			}
			merged.WriteString("# ---END FILE: " + m + "---\n")
		}
		return nil
	}

	if err := walk(mainPath); err != nil {
		return files, []byte(merged.String()), err
	}
	return files, []byte(merged.String()), nil
}

func dedupeStrings(in []string) []string {
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, s := range in {
		if s == "" || seen[s] {
			continue
		}
		seen[s] = true
		out = append(out, s)
	}
	sort.Strings(out)
	return out
}

func sha256Hex(b []byte) string {
	h := sha256.Sum256(b)
	return hex.EncodeToString(h[:])
}

// Empty-input sha256 — used as the placeholder when sshd_config is
// missing or unreadable, so the UI can still display a stable
// fingerprint string without a parse.
var emptySHA256 = sha256Hex(nil)
