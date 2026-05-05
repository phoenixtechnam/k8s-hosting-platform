# mail-backup-tools — IMAP-driven mailbox backup/restore image.
#
# Used by Tenant Backup Phase 4 mailbox component (Stalwart 0.16
# dropped stalwart-cli, so per-account export now goes through IMAP
# master-user proxy auth at <mailbox>%<master>).
#
# Tools shipped:
#   - mbsync (isync)  — capture: IMAP → Maildir, UIDVALIDITY-aware
#   - python3 stdlib  — restore: imaplib APPEND with Message-ID dedup
#   - curl            — upload artefact, download artefact, HMAC token
#   - tar+gzip+busybox — Option F streaming pipeline
#   - sha256sum (coreutils) — integrity check
#
# Image size budget: <50 MiB (measured ~44 MiB on alpine 3.19 with
# python3 + isync + curl + ca-certificates + tar). Trivy CRITICAL
# must pass; HIGH currently advisory.

FROM alpine:3.19

RUN apk add --no-cache \
      isync \
      python3 \
      curl \
      tar \
      ca-certificates \
 && rm -rf /var/cache/apk/* /usr/lib/python3.*/test /usr/lib/python3.*/idlelib \
           /usr/lib/python3.*/lib2to3 /usr/lib/python3.*/ensurepip \
           /usr/lib/python3.*/__pycache__

# Restore script in-image — Python stdlib only, runs under sh -c
# from the orchestrator's Job spec. Argv:
#   restore-mailbox.py <imap_host> <imap_port> <username> <password> <mode> <maildir>
# where mode ∈ {merge-skip, merge-overwrite, replace}.
COPY restore-mailbox.py /usr/local/bin/restore-mailbox.py
RUN chmod 755 /usr/local/bin/restore-mailbox.py

# Capture helper — wraps mbsync + Option F streaming upload.
# Argv: capture-mailbox.sh <addr> <upload_url>
COPY capture-mailbox.sh /usr/local/bin/capture-mailbox.sh
RUN chmod 755 /usr/local/bin/capture-mailbox.sh

# Default to a no-op so `docker run mail-backup-tools` doesn't error;
# the orchestrator always overrides command/args.
CMD ["sh", "-c", "echo mail-backup-tools image ready; sleep 1"]
