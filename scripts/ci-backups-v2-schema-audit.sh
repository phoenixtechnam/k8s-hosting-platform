#!/usr/bin/env bash
# ci-backups-v2-schema-audit.sh — fail CI when a new client-FK'd table
# lands in db/schema.ts without being added to CONFIG_DUMP_TABLES or
# the exclusion allowlist.
#
# Why: the config component dumps a hand-curated list of tables. Every
# time someone adds a new client-scoped table (ziti, zrok, mTLS
# providers all landed in the last month), they must also wire it into
# the dump — otherwise that table silently stops being backed up.
# Unit tests don't catch this; only an explicit audit does.
#
# How: parse schema.ts for `references(() => clients.id)` matches,
# extract the surrounding `export const <name> = pgTable` name, and
# compare against the union of CONFIG_DUMP_TABLES + the
# CONFIG_DUMP_EXCLUDED_CLIENT_FK_TABLES Map keys in config.ts.
#
# Anything in the schema but not in either list = build fails.
#
# Output: human-readable diff naming the missing tables + the
# canonical place to fix.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SCHEMA="$ROOT/backend/src/db/schema.ts"
CONFIG="$ROOT/backend/src/modules/backups-v2/components/config.ts"

if [[ ! -f "$SCHEMA" ]]; then
  echo "❌ ci-backups-v2-schema-audit: $SCHEMA not found" >&2
  exit 2
fi
if [[ ! -f "$CONFIG" ]]; then
  echo "❌ ci-backups-v2-schema-audit: $CONFIG not found" >&2
  exit 2
fi

# 1. Direct client-FK'd tables (the awk walks pgTable boundaries so we
#    correctly attribute the references() call to the enclosing const).
SCHEMA_TABLES=$(awk '
  /^export const [a-zA-Z0-9]+ = pgTable/ { name=$3 }
  /references\(\(\) => clients\.id/ { print name }
' "$SCHEMA" | sort -u)

# 2. CONFIG_DUMP_TABLES contents — string array of camelCase names.
DUMP_TABLES=$(awk '
  /^export const CONFIG_DUMP_TABLES = \[/ { in_arr=1; next }
  in_arr && /^\s*\] as const;/ { in_arr=0 }
  in_arr {
    line=$0
    # Strip inline trailing comments before whitespace gsub so the
    # array tolerates `'"'"'foo'"'"', // comment` entries.
    sub(/[ \t]*\/\/.*$/, "", line)
    gsub(/[ \t,'"'"']/, "", line)
    if (line != "" && line !~ /^\/\//) print line
  }
' "$CONFIG" | sort -u)

# 3. CONFIG_DUMP_EXCLUDED_CLIENT_FK_TABLES — Map keys.
EXCLUDED=$(grep -E "^\s*\['[a-zA-Z0-9]+'," "$CONFIG" \
  | sed -E "s/^\s*\['([a-zA-Z0-9]+)',.*/\1/" \
  | sort -u)

KNOWN=$(printf '%s\n%s\n' "$DUMP_TABLES" "$EXCLUDED" | sort -u)

# 4. Tables in the schema but NOT in either list.
MISSING=$(comm -23 <(echo "$SCHEMA_TABLES") <(echo "$KNOWN"))

echo "── ci-backups-v2-schema-audit ──"
echo "  schema client-FK tables:   $(echo "$SCHEMA_TABLES" | wc -l)"
echo "  CONFIG_DUMP_TABLES:        $(echo "$DUMP_TABLES" | wc -l)"
echo "  EXCLUDED list:             $(echo "$EXCLUDED" | wc -l)"

if [[ -z "$MISSING" ]]; then
  echo "✅ All client-FK'd tables are accounted for."
  exit 0
fi

echo
echo "❌ Found tables with a FK to clients.id that are NEITHER in"
echo "   CONFIG_DUMP_TABLES nor in the exclusion list:"
echo
while IFS= read -r t; do
  echo "      - $t"
done <<<"$MISSING"
echo
echo "Decision tree (apply in $CONFIG):"
echo "  1. If this table holds tenant config the operator would expect"
echo "     to be restored from a bundle (mailbox settings, deployment"
echo "     spec, ingress auth, …) → add the camelCase name to"
echo "     CONFIG_DUMP_TABLES AND a SELECT case in selectClientRows."
echo "  2. If this table is platform-owned audit/billing/runtime state"
echo "     → add an entry to CONFIG_DUMP_EXCLUDED_CLIENT_FK_TABLES with"
echo "     the rationale."
echo
echo "Either choice keeps the audit + the dump in sync. The cost of"
echo "doing nothing is silent data loss on restore."
exit 1
