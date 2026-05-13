#!/usr/bin/env bash
set -euo pipefail

# ci-job-ttl-check.sh — fail CI when a Job spec is created without
# `ttlSecondsAfterFinished` set. Covers two sources of Job creation:
#
#   1. TS code in backend/src that POSTs a Job to the apiserver
#      (modules like mail-imapsync, postgres-restore, tenant-bundles,
#      system-backup, etc.). Pattern:
#         { apiVersion: 'batch/v1', kind: 'Job', metadata: {...}, spec: {...} }
#
#   2. YAML manifests under k8s/ that define a top-level
#         apiVersion: batch/v1
#         kind: Job
#      (excluding kustomization patches and chart fragments under
#      vendor / node_modules).
#
# Background: completed Jobs (and their finished Pods) stay forever
# unless the kube-controller's TTL-after-finished controller has a
# deadline. At fleet scale (per-tenant restores, mail-imapsync, bundle
# exports, pg-dumps) Job clutter accumulates fast — etcd objects,
# Pod records, and even the Pod log inodes on each node. Requiring
# `ttlSecondsAfterFinished` at creation time keeps the cluster tidy
# without any runtime sweeper.
#
# Heuristics intentionally simple — pure textual scan, no AST:
#
#   • TS: only flag a `kind: 'Job'` line when `spec:` appears within
#     SPEC_LOOKAHEAD lines below it. This filters out ownerReferences
#     entries (which use kind: 'Job' inside a pure metadata literal,
#     and have no `spec:` sibling).
#   • TS: `.test.ts` / `.spec.ts` files are excluded — those build
#     mock V1Job objects for assertions, not real cluster creates.
#   • YAML: split on '---' document separators, then require
#     `ttlSecondsAfterFinished` per Job document.
#
# Recommended values:
#   • One-shot operator actions ............. 3600   (1 h)
#   • User-visible (logs read next day) ..... 86400  (24 h)
#   • CronJob jobTemplate ................... 604800 (7 d) — but also
#                                             rely on successfulJobsHistoryLimit
#
# If you have a deliberate exception (a Job whose history must persist
# for compliance reasons) — set the field anyway with a very long TTL
# rather than omitting it, so this guard stays meaningful.

TS_ROOT="${1:-backend/src}"
YAML_ROOT="${2:-k8s}"
SPEC_LOOKAHEAD=15
TTL_LOOKAHEAD=40

FAIL=0
FAIL_TS=()
FAIL_YAML=()

# ─── TS scan ────────────────────────────────────────────────────────
if [ -d "$TS_ROOT" ]; then
  mapfile -t HITS < <(
    grep -rnE "kind:\s*['\"]Job['\"]" "$TS_ROOT" \
      --include='*.ts' \
      --exclude-dir=node_modules \
      --exclude-dir=dist \
      --exclude='*.test.ts' \
      --exclude='*.spec.ts' \
      | awk -F: '{ print $1 ":" $2 }'
  )

  for hit in "${HITS[@]:-}"; do
    [ -z "$hit" ] && continue
    FILE="${hit%%:*}"
    LINE="${hit##*:}"

    # Is this a real Job spec (has `spec:` nearby) vs an ownerReferences
    # entry? OwnerReferences blocks end in 4-6 lines and never have spec:.
    SPEC_END=$((LINE + SPEC_LOOKAHEAD))
    SPEC_WINDOW=$(sed -n "${LINE},${SPEC_END}p" "$FILE")
    if ! echo "$SPEC_WINDOW" | grep -qE '^\s*spec:'; then
      continue   # ownerReferences / interface — skip
    fi

    TTL_END=$((LINE + TTL_LOOKAHEAD))
    TTL_WINDOW=$(sed -n "${LINE},${TTL_END}p" "$FILE")
    if echo "$TTL_WINDOW" | grep -q "ttlSecondsAfterFinished"; then
      continue
    fi

    FAIL=1
    FAIL_TS+=("${FILE}:${LINE}")
  done
fi

# ─── YAML scan ──────────────────────────────────────────────────────
# Split each YAML on '---' document boundaries and check each Job doc.
# python3 is required (alpine/k8s container has it; CI uses
# ubuntu-latest which has it pre-installed).
if [ -d "$YAML_ROOT" ]; then
  while IFS= read -r -d '' f; do
    # skip vendored / generated paths defensively
    case "$f" in
      */node_modules/*|*/charts/*|*/vendor/*) continue ;;
    esac
    out=$(python3 - "$f" <<'PY'
import sys, re
path = sys.argv[1]
with open(path, 'r', encoding='utf-8', errors='replace') as fh:
    text = fh.read()
docs = re.split(r'(?m)^---\s*$', text)
miss = []
for idx, doc in enumerate(docs):
    # find a top-level (column 0) "kind: Job" line
    if not re.search(r'(?m)^kind:\s*Job\s*$', doc):
        continue
    if 'ttlSecondsAfterFinished' in doc:
        continue
    # report the line number relative to the original file
    offset = sum(len(d) for d in docs[:idx]) + idx * 4  # rough; '---\n' chars
    line = text.count('\n', 0, offset) + 1
    miss.append(str(line))
if miss:
    print(','.join(miss))
PY
)
    if [ -n "$out" ]; then
      FAIL=1
      FAIL_YAML+=("${f}:${out}")
    fi
  done < <(find "$YAML_ROOT" -type f \( -name '*.yaml' -o -name '*.yml' \) -print0)
fi

# ─── Report ─────────────────────────────────────────────────────────
if [ $FAIL -ne 0 ]; then
  echo "❌ ci-job-ttl-check: Job spec(s) without ttlSecondsAfterFinished."
  if [ ${#FAIL_TS[@]} -gt 0 ]; then
    echo
    echo "  TS Job-spec creators missing TTL:"
    for s in "${FAIL_TS[@]}"; do
      echo "    $s"
    done
  fi
  if [ ${#FAIL_YAML[@]} -gt 0 ]; then
    echo
    echo "  YAML Job manifests missing TTL:"
    for s in "${FAIL_YAML[@]}"; do
      echo "    $s"
    done
  fi
  echo
  echo "  Fix: add ttlSecondsAfterFinished to spec. Recommended values:"
  echo "    • One-shot operator action ........ 3600   (1 h)"
  echo "    • User-visible (logs next day) .... 86400  (24 h)"
  echo "    • CronJob jobTemplate ............. 604800 (7 d)"
  exit 1
fi

echo "✅ ci-job-ttl-check: all Job specs declare ttlSecondsAfterFinished."
