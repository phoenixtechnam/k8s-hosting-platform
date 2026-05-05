#!/usr/bin/env python3
"""
restore-mailbox.py — restore a mailbox from a Maildir tarball into Stalwart via IMAP.

Argv:
    1  imap_host
    2  imap_port            (143 STARTTLS or 993 implicit TLS)
    3  username             ("<addr>%<master>" — IMAP master-user proxy)
    4  password             (cleartext master password from env-injected file)
    5  mode                 (merge-skip | merge-overwrite | replace)
    6  maildir              (filesystem path to extracted Maildir root)

Behaviour:
    merge-skip-duplicates (default):
        For each folder, fetch all existing Message-IDs once via
        UID FETCH 1:* (BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)]).
        APPEND only messages whose Message-ID is not in the set.
        Messages without Message-ID are always APPENDed (rare).

    merge-overwrite:
        APPEND every message unconditionally. Server keeps both copies
        for any duplicates.

    replace:
        Two-phase, crash-safe: rename existing folder to
        <name>.staging-<jobId> (server-side IMAP RENAME), APPEND from
        Maildir into the now-empty <name>, then delete the staging
        folder. If APPEND fails, the staging folder is left for
        operator inspection rather than silent data loss.

Exit codes:
    0   all folders restored successfully
    1   IMAP error (auth, network, append) or unsupported mode
    2   argv usage error

Stdout: human-readable progress + final RESULT line for the orchestrator.
Stderr: warnings + per-folder progress.

Security notes:
    - Password comes from argv ONLY in tests; production callers pipe
      it via env→file→argv to keep it out of `ps`. The Job spec wires
      this via /tmp/pwfile and `cat`.
    - IMAP server cert verification is OFF by default (in-cluster
      service); set MBSYNC_TLS_VERIFY=yes (and a valid CA bundle) to
      enable. Same convention as capture-mailbox.sh.
    - We never log the password.
"""

from __future__ import annotations

import imaplib
import os
import re
import ssl
import sys
import time
import uuid
from email import message_from_bytes
from pathlib import Path
from typing import Iterable

VALID_MODES = ("merge-skip-duplicates", "merge-overwrite", "replace")


def log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def out(msg: str) -> None:
    print(msg, flush=True)


def imap_connect(host: str, port: int, user: str, password: str) -> imaplib.IMAP4:
    verify = os.environ.get("MBSYNC_TLS_VERIFY", "no").lower() == "yes"
    if port == 993:
        ctx = ssl.create_default_context()
        if not verify:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        conn: imaplib.IMAP4 = imaplib.IMAP4_SSL(host, port, ssl_context=ctx)
    else:
        conn = imaplib.IMAP4(host, port)
        try:
            ctx = ssl.create_default_context()
            if not verify:
                ctx.check_hostname = False
                ctx.verify_mode = ssl.CERT_NONE
            conn.starttls(ssl_context=ctx)
        except imaplib.IMAP4.error as e:
            # STARTTLS not supported is an error in production; allow
            # plaintext only if explicitly opted in. Stalwart 0.16
            # advertises STARTTLS by default.
            if os.environ.get("ALLOW_PLAINTEXT_IMAP") != "yes":
                raise RuntimeError(f"IMAP server refused STARTTLS: {e}") from e
            log("WARN: STARTTLS refused, continuing in plaintext (ALLOW_PLAINTEXT_IMAP=yes)")
    # Stalwart 0.16 advertises AUTH=PLAIN AUTH=OAUTHBEARER AUTH=XOAUTH2
    # but NOT IMAP LOGIN. Other test servers (greenmail, dovecot) often
    # support LOGIN but not AUTH=PLAIN. Try AUTH PLAIN first; fall back
    # to LOGIN. PLAIN format: \0<user>\0<pass> (RFC 4616).
    auth_blob = f"\0{user}\0{password}".encode("utf-8")
    try:
        typ, data = conn.authenticate("PLAIN", lambda _challenge: auth_blob)
        if typ != "OK":
            raise imaplib.IMAP4.error(f"AUTH PLAIN: {data!r}")
    except imaplib.IMAP4.error as e:
        log(f"AUTH PLAIN unsupported ({e}); falling back to LOGIN")
        conn.login(user, password)
    return conn


def list_maildir_folders(maildir: Path) -> list[Path]:
    """
    Return every folder containing a Maildir (has cur/ + new/).

    Maildir++ layout:
        <root>/cur/        — INBOX cur
        <root>/new/        — INBOX new
        <root>/.Sent/cur/  — sub-folder cur
        <root>/.Drafts/cur/

    mbsync writes folder names with a leading dot for sub-folders;
    INBOX is at the root.
    """
    folders: list[Path] = []
    if (maildir / "cur").is_dir() or (maildir / "new").is_dir():
        folders.append(maildir)  # INBOX
    for child in sorted(maildir.iterdir()):
        if child.is_dir() and child.name.startswith("."):
            if (child / "cur").is_dir() or (child / "new").is_dir():
                folders.append(child)
    return folders


def folder_to_imap_name(maildir_root: Path, folder: Path) -> str:
    """
    Convert a Maildir++ subdirectory name to an IMAP folder name.

    INBOX (the root) stays "INBOX".
    `.Sent` → "Sent"
    `.Archive.2024` → "Archive/2024"   (Maildir++ uses dots as separators)
    """
    if folder == maildir_root:
        return "INBOX"
    name = folder.name.lstrip(".")
    return name.replace(".", "/")


def iter_messages(folder: Path) -> Iterable[tuple[Path, bytes, str | None]]:
    """
    Yield (path, raw_bytes, message_id) for every message in a Maildir
    folder (cur/ + new/). message_id is the unfolded header value
    (lower-cased, angle-brackets retained) or None if absent.
    """
    for sub in ("cur", "new"):
        d = folder / sub
        if not d.is_dir():
            continue
        for entry in sorted(d.iterdir()):
            if not entry.is_file():
                continue
            try:
                raw = entry.read_bytes()
            except OSError as e:
                log(f"WARN: skip unreadable {entry}: {e}")
                continue
            msg = message_from_bytes(raw)
            mid = msg.get("Message-ID") or msg.get("Message-Id") or msg.get("message-id")
            if mid:
                mid = mid.strip().lower()
            yield entry, raw, mid


def maildir_flags_to_imap(name: str) -> str:
    """
    Maildir++ filename suffix `:2,FRSDT` → IMAP flags `(\\Flagged \\Seen)`.

    Mapping:
        F → \\Flagged
        R → \\Answered
        S → \\Seen
        T → \\Deleted
        D → \\Draft
    """
    m = re.search(r":2,([A-Za-z]*)$", name)
    if not m:
        return ""
    suffix = m.group(1)
    flags: list[str] = []
    if "F" in suffix: flags.append("\\Flagged")
    if "R" in suffix: flags.append("\\Answered")
    if "S" in suffix: flags.append("\\Seen")
    if "T" in suffix: flags.append("\\Deleted")
    if "D" in suffix: flags.append("\\Draft")
    return "(" + " ".join(flags) + ")" if flags else ""


def existing_message_ids(conn: imaplib.IMAP4, folder: str) -> set[str]:
    """
    Bulk-fetch Message-IDs from a folder. Returns a lower-cased set
    (with angle-brackets retained, since Message-ID is canonically
    case-sensitive in spec but commonly lower-cased in practice; we
    pick one canonical form).
    """
    typ, _ = conn.select(f'"{folder}"', readonly=True)
    if typ != "OK":
        return set()
    typ, data = conn.uid("FETCH", "1:*", "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
    conn.close()
    if typ != "OK" or not data:
        return set()
    ids: set[str] = set()
    for item in data:
        if not isinstance(item, tuple) or len(item) < 2:
            continue
        body = item[1]
        if not isinstance(body, (bytes, bytearray)):
            continue
        mid_match = re.search(rb"^Message-ID:\s*(.+)$", body, re.IGNORECASE | re.MULTILINE)
        if mid_match:
            ids.add(mid_match.group(1).decode("utf-8", "replace").strip().lower())
    return ids


def ensure_folder(conn: imaplib.IMAP4, folder: str) -> None:
    """CREATE folder if missing. CREATE on existing is harmless (server returns NO)."""
    conn.create(f'"{folder}"')  # ignore result; SELECT will fail loudly if real problem


def append_message(conn: imaplib.IMAP4, folder: str, raw: bytes, flags: str) -> None:
    typ, data = conn.append(f'"{folder}"', flags, None, raw)
    if typ != "OK":
        raise RuntimeError(f"APPEND to {folder} failed: {typ} {data!r}")


def restore_folder_merge(
    conn: imaplib.IMAP4,
    maildir_root: Path,
    folder: Path,
    *,
    skip_duplicates: bool,
) -> tuple[int, int]:
    """Return (appended, skipped)."""
    imap_name = folder_to_imap_name(maildir_root, folder)
    ensure_folder(conn, imap_name)
    existing = existing_message_ids(conn, imap_name) if skip_duplicates else set()

    appended = 0
    skipped = 0
    for path, raw, mid in iter_messages(folder):
        if skip_duplicates and mid and mid in existing:
            skipped += 1
            continue
        flags = maildir_flags_to_imap(path.name)
        try:
            append_message(conn, imap_name, raw, flags)
            appended += 1
        except Exception as e:
            log(f"ERROR: APPEND failed for {path.name} → {imap_name}: {e}")
            raise
    return appended, skipped


def restore_folder_replace(
    conn: imaplib.IMAP4,
    maildir_root: Path,
    folder: Path,
    job_id: str,
) -> int:
    """
    Two-phase replace:
        1. RENAME <name> → <name>.staging-<jobId>   (atomic; preserves data)
        2. APPEND from Maildir into a fresh <name>
        3. DELETE <name>.staging-<jobId>            (irreversible — done last)

    If step 2 fails the staging folder is left in place for operator
    inspection — the original data is recoverable.
    """
    imap_name = folder_to_imap_name(maildir_root, folder)
    staging = f"{imap_name}.staging-{job_id}"

    typ, _ = conn.select(f'"{imap_name}"', readonly=True)
    folder_existed = typ == "OK"
    if folder_existed:
        try:
            conn.close()
        except Exception:
            pass
        typ, data = conn.rename(f'"{imap_name}"', f'"{staging}"')
        if typ != "OK":
            raise RuntimeError(f"RENAME {imap_name} → {staging} failed: {typ} {data!r}")

    ensure_folder(conn, imap_name)
    appended = 0
    for path, raw, _mid in iter_messages(folder):
        flags = maildir_flags_to_imap(path.name)
        append_message(conn, imap_name, raw, flags)
        appended += 1

    if folder_existed:
        typ, data = conn.delete(f'"{staging}"')
        if typ != "OK":
            log(f"WARN: failed to DELETE staging {staging}: {typ} {data!r}; left for cleanup")

    return appended


def main(argv: list[str]) -> int:
    if len(argv) != 7:
        print(__doc__, file=sys.stderr)
        print(f"\nERROR: expected 6 args, got {len(argv) - 1}", file=sys.stderr)
        return 2

    _, host, port_s, user, password, mode, maildir_s = argv

    if mode not in VALID_MODES:
        log(f"ERROR: unsupported mode {mode!r}, expected one of {VALID_MODES}")
        return 2

    try:
        port = int(port_s)
    except ValueError:
        log(f"ERROR: invalid port {port_s!r}")
        return 2

    maildir = Path(maildir_s)
    if not maildir.is_dir():
        log(f"ERROR: maildir not found: {maildir}")
        return 1

    folders = list_maildir_folders(maildir)
    if not folders:
        log(f"WARN: no Maildir folders found under {maildir} — nothing to restore")
        out(f"RESULT mode={mode} folders=0 appended=0 skipped=0")
        return 0

    log(f"Connecting to imap://{host}:{port} as {user} ({len(folders)} folder(s), mode={mode})")
    conn = imap_connect(host, port, user, password)

    job_id = uuid.uuid4().hex[:8]
    total_appended = 0
    total_skipped = 0
    try:
        for folder in folders:
            t0 = time.monotonic()
            if mode == "replace":
                a = restore_folder_replace(conn, maildir, folder, job_id)
                s = 0
            else:
                a, s = restore_folder_merge(
                    conn, maildir, folder,
                    skip_duplicates=(mode == "merge-skip-duplicates"),
                )
            total_appended += a
            total_skipped += s
            elapsed = time.monotonic() - t0
            imap_name = folder_to_imap_name(maildir, folder)
            log(f"folder={imap_name} appended={a} skipped={s} elapsed={elapsed:.1f}s")
    finally:
        try:
            conn.logout()
        except Exception:
            pass

    out(f"RESULT mode={mode} folders={len(folders)} appended={total_appended} skipped={total_skipped}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
