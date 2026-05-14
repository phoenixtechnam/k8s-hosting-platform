#!/usr/bin/env bash
# ci-mail-sdk-shape.sh — fail CI when a call site in backend/src/modules/mail-admin/
# uses the SDK v0-style positional-args calling convention for any
# @kubernetes/client-node API method.
#
# Background. @kubernetes/client-node went through a v0 → v1 rewrite. v0
# took positional args:
#   await core.readNode(name)
#   await apps.readNamespacedDeployment(name, namespace)
# v1 takes object args:
#   await core.readNode({ name })
#   await apps.readNamespacedDeployment({ name, namespace })
#
# v0 calls SILENTLY pass on the v1 SDK — the first arg is interpreted
# as the args object, fails internally with something like
# "name.startsWith is not a function", and the typical .catch()
# translates it to a misleading high-level error.
#
# Real bug shapes this script catches:
#   migration.ts:84 "Node 'staging1' not found" while node was healthy
#     (v0 readNode(string) → v1 SDK threw, .catch translated)
#   dr-watcher.ts:isNodeReady false-negatives for the same reason
#   migration.ts:waitForReplicaCount silently timing out
#
# Rule. Every call to a known @kubernetes/client-node API method MUST
# be either:
#   (a) Direct: `await client.method({ ... })` with object args, OR
#   (b) Cast: `await (client as ...).method({ ... }, override)` with
#       object args.
# Anywhere a positional-style cast `... as { method: (name: string, ns: string) => ...`
# appears, fail.
#
# Implementation: Python multi-line scanner (file-by-file). Earlier
# single-line grep missed casts that broke across lines for readability;
# multi-line is required to catch them.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

if ! command -v python3 >/dev/null 2>&1; then
  echo "❌ ci-mail-sdk-shape: python3 is required (multi-line cast detection)" >&2
  exit 2
fi

# Two forms of v0 cast we detect:
#
#   (a) Single-line cast:
#       as unknown as { readNode: (name: string) => ... }
#
#   (b) Multi-line cast (broken across lines for readability):
#       as unknown as {
#         readNamespacedPersistentVolumeClaim: (name: string, ns: string) => ...
#       }
#
# Both are caught with the same multi-line regex. The give-away is a
# positional first arg typed as `name: string` — v1 object-args never
# take a bare `name: string` as their first parameter (always a
# `{ name, namespace, ... }` request object).

python3 - <<'PY'
import re, sys, pathlib

SCAN_DIR = pathlib.Path("backend/src/modules/mail-admin")
PATTERN = re.compile(
    r"as unknown as\s*\{\s*"
    r"(?:read|patch|delete|create|list|replace)"
    r"(?:Namespaced[A-Za-z]+|Node)"
    r"\s*:\s*\(name: string",
    flags=re.DOTALL,
)

hits = []
for p in sorted(SCAN_DIR.rglob("*.ts")):
    if p.name.endswith(".test.ts"):
        continue
    text = p.read_text()
    for m in PATTERN.finditer(text):
        line_no = text.count("\n", 0, m.start()) + 1
        snippet = text[m.start():m.end()].splitlines()[0]
        hits.append(f"{p}:{line_no}: {snippet[:120]}")

if hits:
    for h in hits:
        print(f"  {h}")
    print()
    print("❌ ci-mail-sdk-shape: v0-positional @kubernetes/client-node call(s) in mail-admin/")
    print()
    print("  Switch to v1 object-args:")
    print("    BEFORE:  await (core as unknown as { readNode: (name: string) => ... }).readNode(name)")
    print("    AFTER:   await core.readNode({ name })")
    print()
    print("  See ~/.claude/projects/-workspace-k8s-hosting-platform/memory/project_mail_architecture_streamline_2026_05_14.md")
    sys.exit(1)

print("✅ ci-mail-sdk-shape: all mail-admin K8s API calls use v1 object-args.")
PY
