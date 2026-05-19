#!/usr/bin/env bash
# ci-modsec-exclusion-check.sh — guard against the "match Host
# instead of X-Forwarded-Host" footgun in modsec-crs exclusion files.
#
# The Traefik modsecurity plugin proxies every inspected request
# with `Host: modsec-crs.traefik.svc.cluster.local` (the modsec
# Service hostname) and puts the ORIGINAL hostname in
# X-Forwarded-Host. Any `SecRule REQUEST_HEADERS:Host ...` rule in
# an exclusion file will silently never fire — the rule is dead
# code and CRS continues to block production requests.
#
# This guard catches the mistake at PR time: any SecRule in
# k8s/base/modsecurity-crs/*.yaml that references REQUEST_HEADERS:Host
# without using REQUEST_HEADERS:X-Forwarded-Host fails the build.
#
# Exit codes:
#   0 — no offending rules
#   1 — at least one SecRule matches Host (dead rule)

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CONFIG_DIR="$ROOT/k8s/base/modsecurity-crs"

[[ -d "$CONFIG_DIR" ]] || { echo "ci-modsec-exclusion-check: $CONFIG_DIR missing" >&2; exit 1; }

# Find SecRule lines that scan REQUEST_HEADERS:Host (case-insensitive
# literal "host" header name). Allow REQUEST_HEADERS:X-Forwarded-Host.
HITS=0
while IFS= read -r file; do
  if grep -nE 'SecRule[[:space:]]+REQUEST_HEADERS:Host[^a-zA-Z-]' "$file" | grep -v '^[[:space:]]*#'; then
    HITS=$((HITS + 1))
    echo "ci-modsec-exclusion-check: $file uses REQUEST_HEADERS:Host — Traefik plugin proxies Host=modsec-svc-name, this rule will never fire. Use REQUEST_HEADERS:X-Forwarded-Host instead." >&2
  fi
done < <(find "$CONFIG_DIR" -name '*.yaml' -type f)

if (( HITS > 0 )); then
  exit 1
fi

echo "✓ modsec-crs exclusion rules: no Host-vs-X-Forwarded-Host footguns found"
