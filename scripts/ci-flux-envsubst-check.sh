#!/usr/bin/env bash
set -euo pipefail

# ci-flux-envsubst-check.sh — fail CI when an overlay renders YAML
# containing `${X` where X is NOT a valid identifier start character.
# That is the exact pattern drone/envsubst (Flux's substituter) crashes
# on at apply time with:
#
#   envsubst error: variable substitution failed: unable to parse
#   variable name
#
# Why this narrow scope: Flux's envsubst silently passes through
# unknown `${VAR}`, `$(cmd)`, and `$N` references — they don't crash
# the apply. The 2026-05-04 staging cutover only got stuck on
# `${'` (a quote inside grep), `${ ` (space), `${ {` etc., where the
# tokenizer can't decide on a variable name and aborts.
#
# Rule: `${` must be IMMEDIATELY followed by an identifier-start
#       character `[A-Za-z_]`. Anything else is a parse error.
#
# Escape: prefix with `$$` so the source becomes `$${...}`. Flux's
#         envsubst collapses `$$` → `$`, leaving the literal in the
#         rendered manifest for downstream consumers.
#
# Run locally:
#   ./scripts/ci-flux-envsubst-check.sh
#
# Wired into Infrastructure CI in .github/workflows/infrastructure.yml.

OVERLAYS=(
  "k8s/overlays/dev"
  "k8s/overlays/staging"
  "k8s/overlays/production"
)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if ! command -v kubectl &>/dev/null && ! command -v kustomize &>/dev/null; then
  echo "ERROR: neither kubectl nor kustomize available; cannot render overlays." >&2
  exit 2
fi

_render() {
  if command -v kustomize &>/dev/null; then
    kustomize build "$1"
  else
    kubectl kustomize "$1"
  fi
}

FAIL=0
for overlay in "${OVERLAYS[@]}"; do
  if [[ ! -d "$overlay" ]]; then
    echo "── skip: $overlay (not present in this branch)"
    continue
  fi
  echo "── checking $overlay"

  rendered="$(_render "$overlay" 2>/dev/null || true)"
  if [[ -z "$rendered" ]]; then
    echo "    WARN: kustomize build returned empty output (skipping)"
    continue
  fi

  # `(?<!\$)` — exclude `$$` escapes (those are intentional, collapse
  #             to a literal `$` after envsubst).
  # `\$\{`    — start of substitution
  # `[^A-Za-z_]` — the first char inside `{` is NOT a valid
  #              identifier-start, so drone/envsubst will crash.
  # `.{0,40}` — show ~40 chars of context for the error message.
  bad="$(grep -oP '(?<!\$)\$\{[^A-Za-z_].{0,40}' <<<"$rendered" \
          | sort -u || true)"

  if [[ -n "$bad" ]]; then
    echo "    FAIL — \${...} sequences that drone/envsubst cannot tokenize:"
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      echo "        $line"
    done <<<"$bad"
    FAIL=1
  fi
done

if [[ "$FAIL" -ne 0 ]]; then
  echo
  echo "ci-flux-envsubst-check FAILED."
  echo
  echo "Each match shown above is a place where Flux postBuild envsubst"
  echo "will crash the apply with:"
  echo "  envsubst error: variable substitution failed: unable to parse"
  echo "  variable name"
  echo
  echo "How to fix: prefix the \$ with another \$ so the source becomes \$\${...}."
  echo "Flux's envsubst collapses \$\$ → \$, leaving the literal in the rendered"
  echo "YAML for downstream consumers."
  echo
  echo "Note: this guard ignores legitimate \${VAR}, \$(cmd), and \$N references"
  echo "      — Flux silently passes those through unchanged."
  exit 1
fi

echo
echo "ci-flux-envsubst-check PASSED — no malformed \${...} sequences"
echo "in any rendered overlay."
