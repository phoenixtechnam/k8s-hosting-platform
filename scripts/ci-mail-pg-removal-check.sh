#!/usr/bin/env bash
# Fails CI if any PG mail-db artifact is still referenced in non-doc files.
#
# Artifacts covered:
#   mail-pg-app-credentials  — Secret that held CNPG app credentials
#   mail-db-rw               — CNPG read-write service hostname
#   STALWART_PG_             — env vars injected into render-config
#   mail_pg / mailPg         — TypeScript / SQL identifiers referencing mail-pg
#   render-config            — initContainer name (PG-specific render step)
#
# False-positive exclusions:
#   docs/                    — architecture docs + ADRs (read-only reference)
#   memory/                  — Claude auto-memory files
#   MAIL_PG_PG_MAJOR_UPGRADE — doc about historical major upgrades
#   *.md files               — Markdown docs
#   this script itself       — avoids self-match

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

ARTIFACTS="mail-pg-app-credentials|mail-db-rw|STALWART_PG_|mail_pg|mailPg|render-config"
IGNORE="docs/|\.claude/worktrees/.*/memory/|MAIL_PG_PG_MAJOR_UPGRADE|\.md$|ci-mail-pg-removal-check\.sh|stalwart-016-spike-pg|mail-db/|no longer needed|Phase 1.*RocksDB|RocksDB.*removed|removed.*RocksDB|entropy note on mail_pg|was required by"

FOUND=$(grep -rE "$ARTIFACTS" "$REPO_ROOT" \
  --include="*.ts" \
  --include="*.yaml" \
  --include="*.sh" \
  --include="*.json" \
  --include="*.sql" \
  | grep -vE "$IGNORE" || true)

if [ -n "$FOUND" ]; then
  echo "ERROR: mail-pg artifact still referenced in non-doc file(s):" >&2
  echo "$FOUND" >&2
  exit 1
fi

echo "ci-mail-pg-removal-check: OK"
