#!/usr/bin/env bash
set -euo pipefail

# ci-k8s-patch-check.sh — fail CI when a backend module calls
# patchNamespaced* / patchClusterCustomObject without an explicit
# Content-Type override.
#
# Background: @kubernetes/client-node v1.4 always sends
# `application/json-patch+json` (RFC 6902 op array) by default — every
# patch method bakes that as the first entry of its `consumes` list,
# and ObjectSerializer.getPreferredMediaType picks the first entry. A
# caller that passes a merge-object body (`{ data: {...} }`) without
# overriding the header gets:
#
#   error decoding patch: json: cannot unmarshal object into
#   Go value of type []handlers.jsonPatchOp
#
# The HIGH-3 finding from the Cut 3 mail review (commit 855b443) was a
# real regression of this flavour — and the diagnosis was the OPPOSITE
# of the actual default, so the "fix" introduced a new bug.
#
# Enforcement: every patchNamespaced* / patchClusterCustomObject call in
# backend/src — except inside `shared/k8s-patch.ts` itself and `*.test.ts`
# files — MUST be accompanied (within ~10 lines) by one of the explicit
# middleware shims:
#   • MERGE_PATCH            — application/merge-patch+json (RFC 7396)
#   • STRATEGIC_MERGE_PATCH  — application/strategic-merge-patch+json
#   • JSON_PATCH             — application/json-patch+json (RFC 6902)
#
# All three are exported from `backend/src/shared/k8s-patch.ts`.
#
# This script does a textual scan, not an AST scan; the look-ahead window
# (LOOKAHEAD lines) covers multi-line call expressions. Tune if the codebase
# starts having genuinely longer patch invocations.
#
# Known limitation: this guard cannot catch indirected calls such as
#   const fn = k8s.core.patchNamespacedSecret.bind(k8s.core);
#   await fn({ name, namespace, body }); // no shim → CI guard misses
# If you ever store a patch method in a variable, you are responsible for
# threading the shim through manually.

LOOKAHEAD=25
ROOT="${1:-backend/src}"

if [ ! -d "$ROOT" ]; then
  echo "ci-k8s-patch-check: directory '$ROOT' not found"
  exit 2
fi

# Find every line that invokes a patch method (not a type alias / interface
# declaration). We exclude:
#   - shared/k8s-patch.ts          → the helpers themselves
#   - **/*.test.ts                 → tests
#   - lines where the method is followed by `:` (type position) instead of `(`
PATCH_METHODS='patchNamespaced[A-Za-z]+|patchClusterCustomObject'

# Collect candidate hits as "FILE:LINE" pairs.
mapfile -t HITS < <(
  grep -rnE "\.(${PATCH_METHODS})[[:space:]]*\(" "$ROOT" \
    --include='*.ts' \
    --exclude-dir=node_modules \
    --exclude-dir=dist \
    --exclude='*.test.ts' \
    | grep -v '/shared/k8s-patch\.ts' \
    | awk -F: '{ print $1 ":" $2 }'
)

FAIL=0
FAIL_LINES=()

for hit in "${HITS[@]}"; do
  FILE="${hit%%:*}"
  LINE="${hit##*:}"
  END=$((LINE + LOOKAHEAD))
  # Look at LOOKAHEAD lines starting from the call site for one of the shims.
  WINDOW=$(sed -n "${LINE},${END}p" "$FILE")
  if echo "$WINDOW" | grep -qE '\b(MERGE_PATCH|STRATEGIC_MERGE_PATCH|JSON_PATCH)\b'; then
    continue
  fi
  FAIL=1
  FAIL_LINES+=("${FILE}:${LINE}")
done

if [ $FAIL -ne 0 ]; then
  echo "❌ ci-k8s-patch-check: patchNamespaced* / patchClusterCustomObject call sites are missing an explicit Content-Type middleware shim."
  echo
  echo "  Affected sites:"
  for s in "${FAIL_LINES[@]}"; do
    echo "    $s"
    sed -n "${s##*:}p" "${s%%:*}" | sed 's|^|        |'
  done
  echo
  echo "  Fix: import one of MERGE_PATCH | STRATEGIC_MERGE_PATCH | JSON_PATCH from"
  echo "       'backend/src/shared/k8s-patch.ts' and pass it as the second"
  echo "       positional argument to the patch call."
  echo
  echo "  Why: @kubernetes/client-node v1.4 defaults Content-Type to"
  echo "       'application/json-patch+json' regardless of body shape;"
  echo "       merge-object bodies without the override are rejected by"
  echo "       the apiserver with 'cannot unmarshal object into Go value"
  echo "       of type []handlers.jsonPatchOp'."
  exit 1
fi

echo "✅ ci-k8s-patch-check: ${#HITS[@]} patch call site(s) all carry an explicit Content-Type middleware."
