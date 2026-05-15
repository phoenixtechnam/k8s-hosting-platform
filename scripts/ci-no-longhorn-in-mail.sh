#!/usr/bin/env bash
# ci-no-longhorn-in-mail.sh — fail CI when any Longhorn reference creeps
# back into the mail subsystem.
#
# Background. After repeated benchmark + DR-testing rounds, the mail
# subsystem standardized on local-path PVC (the only storage class
# fast enough for `stalwart -e` import/export at production message
# volumes — see project_stalwart_storage_benchmark_2026_05_11.md).
# Longhorn-as-storage-for-mail is no longer supported, and the
# UI's old "longhorn vs local-path" picker is being deleted in the
# 2026-05-14 streamline.
#
# This probe enforces the deletion. New code that grows a Longhorn
# dependency in mail goes red.
#
# Acceptable false-positives: doc strings that explain the migration
# history. To allow them, drop `# ci-no-longhorn: ignore` on the line.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Mail-subsystem search scope. Longhorn IS supported cluster-wide for
# tenant PVCs; this probe ONLY enforces the deletion from the mail
# subsystem. We narrow by:
#   - dir scope: backend/src/modules/mail-admin, k8s/base/stalwart-mail,
#                packages/api-contracts/src/mail-*.ts
#   - filename prefix on the admin-panel: Mail*.tsx, use-mail-*.ts,
#                EmailManagement.tsx
declare -a TARGETS
# Backend mail-admin module + Stalwart manifests + mail API contracts.
[ -e backend/src/modules/mail-admin ] && TARGETS+=( backend/src/modules/mail-admin )
[ -e k8s/base/stalwart-mail ] && TARGETS+=( k8s/base/stalwart-mail )
mapfile -t MAIL_CONTRACTS < <(find packages/api-contracts/src -maxdepth 2 -name 'mail-*.ts' 2>/dev/null)
[ "${#MAIL_CONTRACTS[@]}" -gt 0 ] && TARGETS+=( "${MAIL_CONTRACTS[@]}" )
# Mail-named admin-panel files (frontend).
mapfile -t MAIL_COMPONENTS < <(find frontend/admin-panel/src/components -maxdepth 2 -name 'Mail*.tsx' 2>/dev/null)
[ "${#MAIL_COMPONENTS[@]}" -gt 0 ] && TARGETS+=( "${MAIL_COMPONENTS[@]}" )
mapfile -t MAIL_HOOKS < <(find frontend/admin-panel/src/hooks -maxdepth 2 -name 'use-mail-*.ts' 2>/dev/null)
[ "${#MAIL_HOOKS[@]}" -gt 0 ] && TARGETS+=( "${MAIL_HOOKS[@]}" )
[ -e frontend/admin-panel/src/pages/EmailManagement.tsx ] && TARGETS+=( frontend/admin-panel/src/pages/EmailManagement.tsx )

# Match longhorn (case-insensitive). `# ci-no-longhorn: ignore` lets
# docstring/migration-history mentions through.
mapfile -t HITS < <(
  grep -rniE 'longhorn' "${TARGETS[@]}" \
    --include='*.ts' \
    --include='*.tsx' \
    --include='*.yaml' \
    --include='*.yml' \
    --exclude='*.test.ts' \
    2>/dev/null \
    | grep -vE 'ci-no-longhorn: ignore' \
    | sort -u
)

if [ "${#HITS[@]}" -gt 0 ]; then
  echo "❌ ci-no-longhorn-in-mail: Longhorn reference(s) in mail subsystem."
  echo
  echo "  Hits:"
  for h in "${HITS[@]}"; do
    echo "    $h"
  done
  echo
  echo "  Mail is local-path-only. See"
  echo "  ~/.claude/projects/-workspace-k8s-hosting-platform/memory/project_mail_architecture_streamline_2026_05_14.md"
  echo
  echo "  To allow a doc-string reference, add a trailing comment:"
  echo "    ... 'longhorn' ...   # ci-no-longhorn: ignore"
  exit 1
fi

echo "✅ ci-no-longhorn-in-mail: no Longhorn references in mail subsystem."
