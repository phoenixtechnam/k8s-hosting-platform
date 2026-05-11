# tenant-backup-tools (image still named mail-backup-tools for the
# Phase 1 window — rename to tenant-backup-tools deferred to a cleanup
# PR per ADR-036 roadmap).
#
# Used by:
#   - Tenant Backup Phase 1 files component (tar | curl --upload-file -
#     to platform-api restic-stream endpoint; restic runs server-side)
#   - Tenant Backup Phase 4 mailbox component (mbsync IMAP master-user
#     proxy → Maildir tarball; replaced by JMAP in Phase 2)
#
# Phase 1 (ADR-036) tooling additions:
#   - restic           — for cross-region restore Jobs (Phase 1.5+)
#   - debian:trixie-slim base — matches peer-firewall-reconciler so the
#                        platform's distinct base-image surface stays small.
#                        Container nft >= host nft constraint that the
#                        firewall image set lives by also matters here for
#                        future restic-running Jobs.
#
# Tools shipped:
#   - restic            — Phase 1.5+ cross-region restore inside tenant ns
#                         (server-side restic runs on platform-api;
#                         this image is for restore-side pulls)
#   - python3-minimal   — Phase 2 jmap-sync.py + existing restore-mailbox.py
#   - curl              — upload + download artifacts, HMAC tokens
#   - tar + gzip        — files-component pipeline
#   - coreutils         — sha256sum + standard tools (debian default)
#   - ca-certificates   — TLS to platform-api + S3
#   - isync             — mbsync, mailbox component (until Phase 2 JMAP)
#
# Image size budget: <120 MiB (debian:trixie-slim ~80 MiB base + restic
# ~25 MiB + python3-minimal ~10 MiB). Trivy CRITICAL/HIGH must pass.

FROM debian:trixie-slim

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      restic \
      isync \
      python3-minimal \
      curl \
      tar \
      gzip \
      coreutils \
      ca-certificates \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/* \
           /usr/share/doc/* /usr/share/man/*

# Restore script in-image — Python stdlib only, runs under sh -c
# from the orchestrator's Job spec. Argv:
#   restore-mailbox.py <imap_host> <imap_port> <username> <password> <mode> <maildir>
# where mode ∈ {merge-skip, merge-overwrite, replace}.
COPY restore-mailbox.py /usr/local/bin/restore-mailbox.py
RUN chmod 755 /usr/local/bin/restore-mailbox.py

# Legacy capture helper — wraps mbsync + Option F streaming upload.
# Argv: capture-mailbox.sh <addr> <upload_url>
# Superseded by jmap-sync.py in Phase 2 (ADR-036) but kept in the
# image while the orchestrator switches over so a rollback to the
# previous mailboxes.ts code path still works without a fresh image
# build. Removed in the cleanup PR after Phase 2 lands.
COPY capture-mailbox.sh /usr/local/bin/capture-mailbox.sh
RUN chmod 755 /usr/local/bin/capture-mailbox.sh

# Phase 2 (ADR-036): JMAP-driven Maildir capture. Replaces the
# mbsync flow above. Pure Python stdlib — no extra packages.
# Argv: jmap-sync.py --endpoint <url> --account-address <addr>
#       --master-user <fq> --auth-pass-env <ENV> --output-dir <dir>
#       [--state-in <file>] [--state-out <file>]
COPY jmap-sync.py /usr/local/bin/jmap-sync.py
RUN chmod 755 /usr/local/bin/jmap-sync.py

# Default to a no-op so `docker run …` doesn't error; the orchestrator
# always overrides command/args.
CMD ["sh", "-c", "echo tenant-backup-tools image ready; sleep 1"]
