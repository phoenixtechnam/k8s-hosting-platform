#!/usr/bin/env python3
"""
jmap-verify.py — verify a Maildir tarball captured by Phase 2 contains
the expected marker messages.

Args:
  --tarball <path>          — Maildir tarball (uncompressed tar) to inspect
  --marker <string>         — marker prefix the seeder used
  --expect-count N          — assert at least N messages contain the marker
  --expect-flagged N        — assert N messages have the F (flagged) Maildir flag
  --sample-bytes N          — sha256 N sampled messages so the orchestrator can
                              compare back to the seeder's view (optional)

Output: JSON `{ totalFiles, markerMatches, flaggedCount, samples: [{path,sha256}], ok }`
Exit 0 on success, 1 on missed assertion.

Pure stdlib.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
import re
import sys
import tarfile
from typing import Dict, List


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--tarball", required=True)
    p.add_argument("--marker", required=True)
    p.add_argument("--expect-count", type=int, default=0)
    p.add_argument("--expect-flagged", type=int, default=0)
    p.add_argument("--sample-bytes", type=int, default=10)
    args = p.parse_args()

    total = 0
    marker_matches = 0
    flagged = 0
    sample_pool: List[str] = []  # candidate paths for hashing
    samples: List[Dict[str, str]] = []
    per_dir_counts: Dict[str, int] = {}

    cur_re = re.compile(r"/cur/[^/]+:2,([A-Z]*)$")
    marker_token = args.marker.encode()

    with tarfile.open(args.tarball, "r:") as tf:
        for member in tf:
            if not member.isfile():
                continue
            m = cur_re.search(member.name)
            if not m:
                continue
            total += 1
            flags = m.group(1) or ""
            if "F" in flags:
                flagged += 1
            # Per-mailbox-dir count: /<addr>/<mailbox>/cur/...
            parts = member.name.strip("/").split("/")
            if len(parts) >= 3 and parts[-2] == "cur":
                dir_key = "/".join(parts[:-2])
                per_dir_counts[dir_key] = per_dir_counts.get(dir_key, 0) + 1
            # Sample marker substring search — only read first 4 KiB to keep
            # the scan cheap for big files.
            f = tf.extractfile(member)
            if f is not None:
                head = f.read(4096)
                if marker_token in head:
                    marker_matches += 1
                # collect a small set of candidates for hashing
                if len(sample_pool) < 100:
                    sample_pool.append(member.name)

    # sha256 a random sample for return-trip comparison
    random.seed(0)
    chosen = random.sample(sample_pool, min(args.sample_bytes, len(sample_pool)))
    with tarfile.open(args.tarball, "r:") as tf:
        for name in chosen:
            member = tf.getmember(name)
            f = tf.extractfile(member)
            if f is None:
                continue
            h = hashlib.sha256()
            while chunk := f.read(65536):
                h.update(chunk)
            samples.append({"path": name, "sha256": h.hexdigest()})

    ok = True
    issues = []
    if args.expect_count and marker_matches < args.expect_count:
        ok = False
        issues.append(f"marker_matches={marker_matches} < expected={args.expect_count}")
    if args.expect_flagged and flagged < args.expect_flagged:
        ok = False
        issues.append(f"flagged={flagged} < expected={args.expect_flagged}")

    out = {
        "tarball": args.tarball,
        "totalFiles": total,
        "markerMatches": marker_matches,
        "flaggedCount": flagged,
        "perDirCounts": per_dir_counts,
        "samples": samples,
        "ok": ok,
        "issues": issues,
    }
    print(json.dumps(out, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
