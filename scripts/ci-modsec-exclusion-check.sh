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
# This guard catches the mistake at PR time. Two surfaces:
#   1. k8s/base/modsecurity-crs/*.yaml — static, repo-versioned
#      exclusion ConfigMaps.
#   2. backend/src/modules/waf-rule-exclusions/renderer.ts — pure
#      function that generates SecRule strings for the DB-rendered
#      exclusion ConfigMap (F4). If the renderer ever emits
#      REQUEST_HEADERS:Host the runtime-produced .conf will silently
#      fail in the same way, so we grep the source too.
#
# Exit codes:
#   0 — no offending rules
#   1 — at least one SecRule (static or rendered) matches Host

set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CONFIG_DIR="$ROOT/k8s/base/modsecurity-crs"
RENDERER="$ROOT/backend/src/modules/waf-rule-exclusions/renderer.ts"

[[ -d "$CONFIG_DIR" ]] || { echo "ci-modsec-exclusion-check: $CONFIG_DIR missing" >&2; exit 1; }

HITS=0

# Invariant 1: static YAML SecRule lines.
while IFS= read -r file; do
  if grep -nE 'SecRule[[:space:]]+REQUEST_HEADERS:Host[^a-zA-Z-]' "$file" | grep -v '^[[:space:]]*#'; then
    HITS=$((HITS + 1))
    echo "ci-modsec-exclusion-check: $file uses REQUEST_HEADERS:Host — Traefik plugin proxies Host=modsec-svc-name, this rule will never fire. Use REQUEST_HEADERS:X-Forwarded-Host instead." >&2
  fi
done < <(find "$CONFIG_DIR" -name '*.yaml' -type f)

# Invariant 2: F4 renderer must emit X-Forwarded-Host.
# Match literal `REQUEST_HEADERS:Host` (NOT followed by alpha/dash so we
# don't catch X-Forwarded-Host substrings or *Host* in templates).
if [[ -f "$RENDERER" ]]; then
  if grep -nE 'REQUEST_HEADERS:Host[^a-zA-Z-]' "$RENDERER" | grep -v '^[[:space:]]*//\|^[[:space:]]*\*'; then
    HITS=$((HITS + 1))
    echo "ci-modsec-exclusion-check: $RENDERER references REQUEST_HEADERS:Host — runtime-rendered SecRule will silently fail. Use REQUEST_HEADERS:X-Forwarded-Host instead." >&2
  fi
  # Invariant 3: renderer MUST positively reference X-Forwarded-Host.
  # Defense-in-depth: if someone deletes the matcher entirely the rule
  # body becomes meaningless and we want CI to scream.
  if ! grep -q 'REQUEST_HEADERS:X-Forwarded-Host' "$RENDERER"; then
    HITS=$((HITS + 1))
    echo "ci-modsec-exclusion-check: $RENDERER no longer references REQUEST_HEADERS:X-Forwarded-Host — F4 exclusions would never fire." >&2
  fi
else
  echo "ci-modsec-exclusion-check: $RENDERER missing — F4 renderer expected at this path" >&2
  HITS=$((HITS + 1))
fi

if (( HITS > 0 )); then
  exit 1
fi

echo "✓ modsec-crs exclusion rules: no Host-vs-X-Forwarded-Host footguns found"
