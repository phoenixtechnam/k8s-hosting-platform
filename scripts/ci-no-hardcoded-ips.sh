#!/usr/bin/env bash
# ci-no-hardcoded-ips.sh
#
# Fail the build if any IPv4 literal (other than well-known reserved /
# documentation ranges and CIDR blocks used by NetworkPolicy egress
# allowlists) leaks into a k8s/ manifest.
#
# Why this guard exists
# ─────────────────────
# In 2026-05-16 a re-bootstrap of testing.phoenix-host.net surfaced a
# hardcoded `externalIPs: - 89.167.3.56` (staging3's public IP) inside
# k8s/overlays/staging/stalwart-mail/kustomization.yaml. The mail
# Service bound the wrong IP on every cluster except staging3 — silently
# breaking inbound SMTP/IMAP for tenants. The IP wasn't visible to any
# review because it lived inside an inline kustomize patch.
#
# Fix: per-cluster IPs come from the `platform-cluster-config` ConfigMap
# (key STALWART_EXTERNAL_IP, written by bootstrap.sh's detect_public_ipv4)
# and are resolved by Flux postBuild substituteFrom. This guard exists
# so a future kustomize patch can't re-introduce a literal.
#
# Allowlisted ranges (network-policy egress, well-known reserved):
#   - 0.0.0.0/0, ::/0          (default routes — match-anything CIDRs)
#   - 127.0.0.0/8              (loopback)
#   - 169.254.0.0/16           (link-local — used by cloud metadata)
#   - 10.0.0.0/8               (RFC1918 — k8s pod/service CIDRs)
#   - 172.16.0.0/12            (RFC1918 — docker default)
#   - 192.168.0.0/16           (RFC1918)
#   - 100.64.0.0/10            (CGNAT — NetBird/Tailscale meshes)
#   - 224.0.0.0/4, 240.0.0.0/4 (multicast / reserved)
#   - 192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24 (documentation)
#
# Anything else under k8s/ (or its overlays/components) is a public IP
# literal and fails the check. To add a new allowlist entry append it to
# the regex below — and explain WHY in this header.

set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

# Files we scan. Skip the guard script itself (this file's allowlist
# obviously contains IP literals) and the CI scripts directory.
mapfile -t TARGETS < <(
  find k8s/ -type f \( -name '*.yaml' -o -name '*.yml' \) 2>/dev/null
)

if [[ "${#TARGETS[@]}" -eq 0 ]]; then
  echo "ci-no-hardcoded-ips: no k8s/ YAML files to scan"
  exit 0
fi

# IPv4 regex — four octets 0-255, optional /prefix.
# (Doesn't need to be RFC-perfect; this is a lint, not a parser.)
ipv4_re='(^|[^0-9.])([0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})(/[0-9]{1,2})?([^0-9.]|$)'

# Allowlist (full-octet match, no anchoring on prefix length).
allow_re='^(0\.0\.0\.0|127\.|169\.254\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.|192\.168\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.|224\.|225\.|226\.|227\.|228\.|229\.|23[0-9]\.|24[0-9]\.|25[0-5]\.|192\.0\.2\.|198\.51\.100\.|203\.0\.113\.)'

fail=0
violations=()

# Lines that legitimately contain IP-shaped strings (image tags, CRD
# description examples, etc.):
#   - container image refs: `image: foo/bar:1.2.3.4` (tag) or `@sha256:`
#   - version pragmas: `version: x.y.z.w`
#   - CRD docstring examples: `1.2.3.4`, `192.0.2.x` (RFC5737 reserved)
#   - any line whose substring contains "example" or "e.g." (case-insens)
skip_line_re='(^[[:space:]]*-?[[:space:]]*image:[[:space:]])|@sha256:|(^[[:space:]]*version:[[:space:]])|[Ee][Xx][Aa][Mm][Pp][Ll][Ee]|e\.g\.|\(1\.2\.3\.4\)'

for f in "${TARGETS[@]}"; do
  while IFS= read -r hit; do
    # grep -nH would prefix the filename but we already know $f. Strip
    # just the leading "<lineno>:" so the rest is the full line content.
    lineno="${hit%%:*}"
    line_content="${hit#*:}"

    # Skip image refs and version strings outright
    if [[ "$line_content" =~ $skip_line_re ]]; then
      continue
    fi

    # Strip YAML comments — a literal IP inside `# ...` is documentation
    code_part="${line_content%%#*}"

    # Extract every IPv4 candidate from the code part
    while [[ "$code_part" =~ $ipv4_re ]]; do
      ip="${BASH_REMATCH[2]}"
      code_part="${code_part#*${BASH_REMATCH[2]}}"
      if [[ "$ip" =~ $allow_re ]]; then
        continue
      fi
      violations+=("${f}:${lineno}  →  literal IPv4 ${ip}")
      fail=1
    done
  done < <(grep -nE "$ipv4_re" "$f" 2>/dev/null || true)
done

if [[ $fail -ne 0 ]]; then
  echo "❌ ci-no-hardcoded-ips: hardcoded public-IP literal(s) found in k8s/" >&2
  printf '   %s\n' "${violations[@]}" >&2
  echo "" >&2
  echo "Per-cluster IPs must come from the platform-cluster-config ConfigMap" >&2
  echo "and be resolved by Flux postBuild substituteFrom (\${STALWART_EXTERNAL_IP}," >&2
  echo "etc). bootstrap.sh writes them via detect_public_ipv4." >&2
  exit 1
fi

echo "✅ ci-no-hardcoded-ips: clean (${#TARGETS[@]} files scanned)"
exit 0
