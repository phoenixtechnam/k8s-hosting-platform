#!/usr/bin/env bash
set -euo pipefail

# ci-flux-escape-check.sh — fail CI when a CronJob/Job YAML has a bare
# `${VAR}` inside an `args:` or `command:` block.
#
# Background: every YAML under k8s/ is rendered by Flux Kustomization
# with `postBuild.substituteFrom` against the platform-cluster-config
# ConfigMap. Flux's drone/envsubst expands `${VAR}` against that
# ConfigMap before kubectl apply — variables that aren't in the
# ConfigMap (i.e. bash locals, pod-env vars) get replaced with empty
# strings, silently breaking the inline shell script.
#
# Real bug this prevents: 2026-05-10 job-gc CronJob's
# `${JOB_GC_DRY_RUN:-false}` got stripped to empty, the
# `[ "$DRY" = "true" ]` check failed, and live deletes ran during what
# should have been a preview. Plus 7 other CronJobs across k8s/base/
# had latent versions of the same bug (only safe because suspended).
#
# Rule: every shell variable reference inside `args:` / `command:`
# multi-line strings MUST be written as `$${VAR}` so Flux collapses
# `$$` → `$` at apply time, leaving `${VAR}` for bash to expand in
# the running pod. Bare `$VAR` (no braces) is already safe; only the
# braced form is matched by the substituter.
#
# Exemptions:
#   • `${VAR[@]}` and `${#VAR}` — bash-specific syntax that
#     drone/envsubst doesn't match (non-identifier chars), so Flux
#     leaves them alone.
#   • `${VAR:?error}` / `${VAR:-default}` — still matched by Flux, so
#     these must be escaped too.
#   • Lines containing the pragma `ci-flux-escape: ignore` are
#     allowed through (use sparingly for docstrings/teaching comments
#     where the literal `${VAR}` form needs to appear post-Flux).
#   • Files containing `ci-flux-escape: ignore-file` are skipped
#     entirely. Use for Jobs that are explicitly opted out of Flux's
#     reconcile loop (`kustomize.toolkit.fluxcd.io/reconcile: disabled`
#     + applied directly via bootstrap.sh or operator scripts), where
#     Flux postBuild substitution never runs on the manifest.
#
# Companion to feedback_flux_postbuild_escape.md.

ROOT="${1:-k8s}"

if [ ! -d "$ROOT" ]; then
  echo "ci-flux-escape-check: directory '$ROOT' not found"
  exit 2
fi

FAIL=0
FAIL_HITS=()

while IFS= read -r -d '' f; do
  case "$f" in
    */node_modules/*|*/charts/*|*/vendor/*) continue ;;
  esac

  # python pass: emit "FILE:LINE:COL:offending-text" for any bare ${VAR}
  # inside an args:/command: block.
  out=$(python3 - "$f" <<'PY'
import sys, re

path = sys.argv[1]
with open(path, 'r', encoding='utf-8', errors='replace') as fh:
    lines = fh.readlines()

joined = ''.join(lines)

# Quick reject: not a CronJob/Job manifest.
if not re.search(r'(?m)^kind:\s*(CronJob|Job)\s*$', joined):
    sys.exit(0)

# File-level opt-out: explicitly excluded from Flux's reconcile loop.
# Use for bootstrap Jobs that get applied directly by operator scripts
# (bootstrap.sh patching suspend=false) — Flux never substitutes their
# manifest, so bare ${VAR} is safe.
if 'ci-flux-escape: ignore-file' in joined:
    sys.exit(0)

# State machine: track when we're inside an args:/command: block.
# The block starts on a line ending in `args:` or `command:` (a bare
# key) and ends when indentation drops back to or below that key's
# indent on a non-comment, non-empty line.
in_block = False
block_indent = -1

# Pattern: a `${...}` not preceded by `$` (= escaped). Inside the
# braces we accept ALPHA, digit, _, and the envsubst default-value
# operators :- :? :+ (which Flux still expands). We exempt the bash
# special forms `${#VAR}` and `${VAR[@]}` because drone/envsubst's
# strict identifier regex doesn't match them.
RE_BARE = re.compile(r'(?<!\$)\$\{([A-Za-z_][A-Za-z0-9_]*)([:=+?\-][^}]*)?\}')

KEY_RE = re.compile(r'^(\s*)(args|command):\s*$')

for idx, raw in enumerate(lines, 1):
    line = raw.rstrip('\n')
    stripped = line.lstrip(' ')
    indent = len(line) - len(stripped)

    m = KEY_RE.match(line)
    if m:
        in_block = True
        block_indent = indent
        continue

    if in_block:
        # End of block: a non-empty, non-comment-only line at indent
        # ≤ block_indent that isn't a list-continuation or block-scalar.
        if (stripped.strip()
                and indent <= block_indent
                and not stripped.startswith(('-', '|', '>'))):
            in_block = False
            # fall through; this line is outside the block
        else:
            # Inside block — scan for bare ${VAR} unless line has the
            # opt-out pragma.
            if 'ci-flux-escape: ignore' in line:
                continue
            for hit in RE_BARE.finditer(line):
                # Skip ${VAR[@]} / ${#VAR} — but we matched on
                # identifier+optional-operator already, so these
                # forms don't reach here. Defensive double-check:
                inner = hit.group(0)
                if '[' in inner or '#' in inner.split('{', 1)[1].split('}', 1)[0]:
                    continue
                col = hit.start() + 1
                print(f"{path}:{idx}:{col}:{inner}")
PY
)
  if [ -n "$out" ]; then
    FAIL=1
    while IFS= read -r line; do
      [ -z "$line" ] && continue
      FAIL_HITS+=("$line")
    done <<< "$out"
  fi
done < <(find "$ROOT" -type f \( -name '*.yaml' -o -name '*.yml' \) -print0)

if [ $FAIL -ne 0 ]; then
  echo "❌ ci-flux-escape-check: bare \${VAR} inside CronJob/Job args/command block(s)."
  echo
  echo "  Flux postBuild.substituteFrom expands every \${VAR} against"
  echo "  platform-cluster-config. Bash locals and pod-env vars get"
  echo "  stripped to empty strings, silently breaking the script."
  echo
  echo "  Affected sites:"
  for h in "${FAIL_HITS[@]}"; do
    file_line_col_text=$h
    echo "    $file_line_col_text"
  done
  echo
  echo "  Fix: write the reference as \$\${VAR} so Flux collapses \$\$"
  echo "  to \$ at apply time, leaving \${VAR} for bash to expand in"
  echo "  the running pod. Bare \$VAR (no braces) is safe."
  echo
  echo "  If a literal \${VAR} must appear post-Flux (e.g. teaching"
  echo "  a pattern in a comment), add the inline pragma:"
  echo "    # ci-flux-escape: ignore"
  echo
  echo "  See feedback_flux_postbuild_escape.md / commit 0e836547 for context."
  exit 1
fi

echo "✅ ci-flux-escape-check: no bare \${VAR} inside CronJob/Job args/command blocks."
