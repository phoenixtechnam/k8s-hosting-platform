#!/usr/bin/env bash
# ci-no-secret-in-argv.sh — guard against accidental plaintext-secret
# inlining in cli args built by the platform-api process.
#
# The blob-store backend builds `stalwart-cli update BlobStore --field
# accessKey=...` argv. The ONLY safe source for the `accessKey=` /
# `secretKey=` values is a `$ENV_VAR` reference that the in-Pod shell
# expands at run time from a Secret-mounted env var. A regression that
# inlines plaintext from JS process memory would expose the keys via
# `kubectl describe pod` and apiserver audit logs.
#
# This guard greps the rendered cli-args path in blob-store.ts for any
# `--field 'secretKey=` or `--field 'accessKey=` followed by anything
# OTHER than `$VAR_NAME`. CI fails on a match.
#
# Run from repo root:  ./scripts/ci-no-secret-in-argv.sh
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="$ROOT/backend/src/modules/mail-admin/blob-store.ts"

if [ ! -f "$TARGET" ]; then
  echo "ci-no-secret-in-argv: target file not found: $TARGET" >&2
  exit 1
fi

# Allowed forms — exhaustively whitelist what `accessKey=` and
# `secretKey=` may resolve to in the cli arg constructor:
#   accessKey=$S3_ACCESS_KEY  ← from envFrom Secret (the safe form)
#   secretKey=$S3_SECRET_KEY  ← same
# The grep `-E` pattern below matches anything else.
violations=$(grep -nE "accessKey=[^\\\$\$]|secretKey=[^\\\$\$]" "$TARGET" \
  | grep -v "accessKey=\$S3_ACCESS_KEY" \
  | grep -v "secretKey=\$S3_SECRET_KEY" \
  | grep -v "^[^:]*://" || true)

if [ -n "$violations" ]; then
  echo "ci-no-secret-in-argv: FAIL — possible plaintext secret in cli args:" >&2
  echo "$violations" >&2
  echo "" >&2
  echo "  S3 access keys MUST flow via Secret + envFrom, never argv." >&2
  exit 1
fi

echo "ci-no-secret-in-argv: ok"
