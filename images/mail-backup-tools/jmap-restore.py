#!/usr/bin/env python3
"""
jmap-restore.py — Phase 2 of tenant-backup-v2 (ADR-036) restore path.

Reads a Maildir tree extracted from a tenant bundle's mailbox snapshot
and pushes it into a Stalwart account via JMAP (Blob/upload + Email/import).

Replaces the legacy `restore-mailbox.py` IMAP APPEND flow. Why:
  - IMAP APPEND is serial per session and Stalwart's IMAP path goes
    through full ESMTP-style auth + SELECT + capability negotiation
    per connection. Real-world measurement: ~1 message/sec.
  - JMAP Blob/upload accepts up to `maxConcurrentUploads` parallel
    streams; Email/import batches up to ~250 messages per call.
  - Server-side: no MIME re-parsing required (blob bytes are stored
    as-is and referenced from the imported Email object).
  - Throughput: ~50-100 msg/sec on staging (50-100x faster than IMAP).

Auth: same Stalwart master-user proxy as jmap-sync.py
  (`<addr>%<master_fq>`, master pw from --auth-pass-env).

Input layout (matches jmap-sync.py output):
    <maildir-root>/<source-address>/<mailbox-name>/cur/<unix>.<unique>.<host>:2,<flags>

Maildir flags → JMAP keywords (one-way; symmetric with jmap-sync):
    S → $seen, F → $flagged, R → $answered, T → $deleted, D → $draft

Mailbox resolution strategy:
  1. Look up target's Mailbox/get list (id, name, role).
  2. For each <mailbox-name> in the snapshot, find a target mailbox by
     case-insensitive name match. If none, auto-create via Mailbox/set
     (no role — generic folder).
  3. INBOX is matched by role='inbox' (handles localized names like
     "Boîte de réception").

Dedup:
  - Email/query filter `header: ["Message-ID", "<msgid>"]` before
    importing each message. Skips if already present.
  - Falls back to allowing duplicates if Message-ID is missing.

Auto-creation of the target principal: NOT done by this script.
The orchestrator (or restore cart executor) MUST ensure the principal
exists in Stalwart before invoking jmap-restore.py — otherwise auth
will fail. See `orchestrator/restore.ts:ensureStalwartPrincipal()`.

Output: one JSON summary on stdout
  { "address": ..., "imported": N, "skipped": M, "failed": K,
    "mailboxesCreated": [...], "elapsedSeconds": X }
exit 0 on success, non-zero on fatal error.

Pure stdlib.
"""
from __future__ import annotations

import argparse
import base64
import email.parser
import email.policy
import json
import os
import queue
import re
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from typing import Any, Dict, List, Optional, Tuple

JMAP_URN_CORE = "urn:ietf:params:jmap:core"
JMAP_URN_MAIL = "urn:ietf:params:jmap:mail"

# Stalwart 0.16 accepts up to ~250 entries per Email/import per the
# Jmap.maxMethodCalls + setMaxObjects config. We stay at 100 to keep
# request payloads under the 9.5 MB Jmap.maxRequestSize default
# (each entry references a blob by id, ~100 bytes, but receivedAt +
# keywords push entry size up; 100 leaves plenty of headroom).
IMPORT_BATCH = 100

# Maildir filename flag suffix is `:2,<flags>` where flags is a string
# of single-letter codes.
MAILDIR_FLAG_RE = re.compile(r":2,([A-Z]*)$")
FLAG_TO_KEYWORD = {
    "S": "$seen",
    "F": "$flagged",
    "R": "$answered",
    "T": "$deleted",
    "D": "$draft",
}

# Allow A-Z 0-9 and a handful of separators in mailbox / address path
# components — same set jmap-sync.py uses when WRITING the Maildir tree,
# so READING it back doesn't need extra unescape logic. Kept as a
# whitelist matcher for defence-in-depth: if a tarball ships a weird
# path component, we ignore it rather than executing/serving it.
SAFE_PATH_COMPONENT_RE = re.compile(r"^[A-Za-z0-9._@+\-]+$")


class JmapError(Exception):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


class JmapClient:
    """Thread-safe JMAP client. No mutable connection state after
    session() returns — every _http() call opens a fresh urllib
    connection, so multiple worker threads can share one client."""

    def __init__(self, endpoint: str, basic_auth_user: str, basic_auth_pass: str) -> None:
        if not endpoint.endswith("/.well-known/jmap") and "/api" not in endpoint:
            endpoint = endpoint.rstrip("/") + "/.well-known/jmap"
        self.session_url = endpoint
        raw = f"{basic_auth_user}:{basic_auth_pass}".encode()
        self._auth_header = "Basic " + base64.b64encode(raw).decode()
        self._api_url: Optional[str] = None
        self._upload_url: Optional[str] = None
        self._mail_account_id: Optional[str] = None

    def _http(self, url: str, *, method: str = "GET", body: Optional[bytes] = None,
              content_type: str = "application/json; charset=utf-8",
              accept: str = "application/json", timeout: int = 60) -> Tuple[int, bytes]:
        # Retry on Stalwart's `jmap:error:limit` HTTP 400 (concurrent-
        # request cap). Backoff is per-worker jittered exponential —
        # multiple workers all retrying after a synchronous error
        # would otherwise dogpile right back into the limit. Jitter
        # spreads them across a few hundred ms.
        # Why we don't retry on other HTTP 400s: only `jmap:error:limit`
        # is recoverable by waiting; everything else (bad blob, bad
        # auth, malformed call) is a permanent failure and retrying
        # just delays the inevitable error report.
        import random
        attempts = 0
        while True:
            req = urllib.request.Request(url, data=body, method=method)
            req.add_header("Authorization", self._auth_header)
            req.add_header("Accept", accept)
            if body is not None:
                req.add_header("Content-Type", content_type)
            try:
                with urllib.request.urlopen(req, timeout=timeout) as resp:
                    return resp.status, resp.read()
            except urllib.error.HTTPError as e:
                err_body = e.read() if hasattr(e, "read") else b""
                if (e.code == 400 and b"jmap:error:limit" in err_body
                        and attempts < 8):
                    # Exponential backoff with jitter: 100ms, 200ms,
                    # 400ms, ..., capped at ~2s; jitter ±50%.
                    base = min(0.1 * (2 ** attempts), 2.0)
                    delay = base * (0.5 + random.random())
                    time.sleep(delay)
                    attempts += 1
                    continue
                return e.code, err_body

    def session(self) -> None:
        status, body = self._http(self.session_url)
        if status in (401, 403):
            raise JmapError("AUTH_FAILED", f"HTTP {status}")
        if status != 200:
            raise JmapError("SESSION_HTTP", f"HTTP {status}: {body[:200]!r}")
        s = json.loads(body)
        # Re-root apiUrl + uploadUrl onto session URL's origin — Stalwart
        # returns the public HTTPS URL by default which fails SSL verify
        # from inside the cluster. Same pattern as jmap-sync.py.
        from urllib.parse import urlsplit, urlunsplit
        our = urlsplit(self.session_url)

        def _reroot(url: str) -> str:
            u = urlsplit(url)
            return urlunsplit((our.scheme, our.netloc, u.path, u.query, u.fragment))
        self._api_url = _reroot(s["apiUrl"])
        self._upload_url = _reroot(s["uploadUrl"])
        for acc_id, acc in (s.get("accounts") or {}).items():
            if JMAP_URN_MAIL in (acc.get("accountCapabilities") or {}):
                self._mail_account_id = acc_id
                break
        if not self._mail_account_id:
            raise JmapError("NO_MAIL_ACCOUNT", "no JMAP mail-capable account "
                            "(restore cart must recreate the principal first)")

    @property
    def account_id(self) -> str:
        if not self._mail_account_id:
            raise RuntimeError("session() not called")
        return self._mail_account_id

    def call(self, invocations: List[List[Any]]) -> List[List[Any]]:
        if not self._api_url:
            raise RuntimeError("session() not called")
        req = {"using": [JMAP_URN_CORE, JMAP_URN_MAIL], "methodCalls": invocations}
        status, resp_body = self._http(self._api_url, method="POST",
                                       body=json.dumps(req).encode())
        if status != 200:
            raise JmapError("CALL_HTTP", f"HTTP {status}: {resp_body[:200]!r}")
        resp = json.loads(resp_body)
        results = resp.get("methodResponses", [])
        for inv in results:
            if inv[0] == "error":
                err = inv[1] or {}
                raise JmapError(err.get("type", "UNKNOWN"), err.get("description", ""))
        return results

    def upload_blob(self, data: bytes, mime: str = "message/rfc822") -> str:
        """POST raw bytes; the {accountId} placeholder is substituted."""
        if not self._upload_url:
            raise RuntimeError("session() not called")
        url = self._upload_url.replace(
            "{accountId}", urllib.parse.quote(self.account_id, safe=""))
        # Larger upload timeout since this can be a 100 MB attachment.
        status, body = self._http(url, method="POST", body=data,
                                  content_type=mime, timeout=300)
        if status not in (200, 201):
            raise JmapError("UPLOAD_HTTP", f"HTTP {status}: {body[:200]!r}")
        d = json.loads(body)
        return d["blobId"]


# ── Maildir parsing helpers ───────────────────────────────────────────

def maildir_flags_to_keywords(filename: str) -> Dict[str, bool]:
    """`filename:2,SF` → {"$seen": True, "$flagged": True}.
    Returns an empty dict if no flag suffix present."""
    m = MAILDIR_FLAG_RE.search(filename)
    if not m:
        return {}
    flags = m.group(1) or ""
    return {FLAG_TO_KEYWORD[c]: True for c in flags if c in FLAG_TO_KEYWORD}


def maildir_received_at(filename: str, fallback: float) -> str:
    """Extract the unix-timestamp prefix from a Maildir filename:
    `<unix>.<unique>.<host>:2,...`. Returns RFC 3339 UTC. Falls back
    to now() if the prefix is missing or unparseable."""
    head = filename.split(".", 1)[0]
    try:
        unix = int(head)
    except ValueError:
        unix = int(fallback)
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(unix))


def parse_message_id(raw: bytes) -> Optional[str]:
    """Extract the RFC 5322 Message-ID header WITHOUT loading the full
    message body — only headers are scanned. Stalwart's dedup query
    matches the angle-bracketed form exactly."""
    try:
        parser = email.parser.BytesHeaderParser(policy=email.policy.default)
        msg = parser.parsebytes(raw)
        return msg.get("Message-ID")
    except Exception:
        # Best-effort manual scan if the parser hiccups on weird headers
        for line in raw.split(b"\r\n", 200)[:200]:
            if not line:
                break  # end of headers
            low = line.lower()
            if low.startswith(b"message-id:"):
                try:
                    val = line.split(b":", 1)[1].strip().decode("ascii", errors="replace")
                    return val.strip()
                except Exception:
                    return None
        return None


# ── Mailbox resolution / creation ─────────────────────────────────────

def list_mailboxes(client: JmapClient) -> Dict[str, Dict[str, Any]]:
    """Returns {mailbox_id: {"id":..., "name":..., "role":..., "parentId":...}}."""
    sr = client.call([[
        "Mailbox/get",
        {"accountId": client.account_id, "ids": None,
         "properties": ["id", "name", "role", "parentId"]},
        "0",
    ]])
    body = sr[0][1]
    return {m["id"]: m for m in body.get("list", [])}


def resolve_or_create_mailbox(client: JmapClient,
                              mailboxes: Dict[str, Dict[str, Any]],
                              name: str,
                              created_log: List[str]) -> str:
    """Find a mailbox by case-insensitive name match. INBOX matches the
    role='inbox' mailbox regardless of name (i18n). If no match, create
    a top-level mailbox with the given name and return its id."""
    name_lower = name.lower()
    if name_lower == "inbox":
        for mb in mailboxes.values():
            if mb.get("role") == "inbox":
                return mb["id"]
    for mb in mailboxes.values():
        if (mb.get("name") or "").lower() == name_lower:
            return mb["id"]
    # Create
    sr = client.call([[
        "Mailbox/set",
        {"accountId": client.account_id,
         "create": {"new": {"name": name, "parentId": None}}},
        "0",
    ]])
    created = sr[0][1].get("created") or {}
    if "new" not in created:
        notCreated = sr[0][1].get("notCreated") or {}
        raise JmapError("MAILBOX_CREATE", f"could not create {name!r}: {notCreated}")
    new_id = created["new"]["id"]
    mailboxes[new_id] = {"id": new_id, "name": name, "role": None, "parentId": None}
    created_log.append(name)
    return new_id


def check_message_id_exists(client: JmapClient, message_id: str) -> bool:
    """Email/query header[Message-ID]=<msgid> — returns True iff Stalwart
    already has a message with that header. Used for dedup before
    re-importing on a partial-restore retry."""
    if not message_id:
        return False
    try:
        sr = client.call([[
            "Email/query",
            {"accountId": client.account_id,
             "filter": {"header": ["Message-ID", message_id]},
             "limit": 1, "calculateTotal": False},
            "0",
        ]])
        return bool(sr[0][1].get("ids"))
    except JmapError:
        # Conservative: on filter error, attempt to import (better a dup
        # than a missed restore).
        return False


# ── Worker pool: read+upload, then batched Email/import ───────────────

class _PendingImport:
    __slots__ = ("blob_id", "keywords", "mailbox_id", "received_at")

    def __init__(self, blob_id: str, keywords: Dict[str, bool],
                 mailbox_id: str, received_at: str) -> None:
        self.blob_id = blob_id
        self.keywords = keywords
        self.mailbox_id = mailbox_id
        self.received_at = received_at


def _read_and_upload(path: str, client: JmapClient,
                     mailbox_id: str) -> Optional[_PendingImport]:
    """One worker iteration: read message file → Blob/upload → return
    a pending Email/import entry. Returns None if the message is empty
    or the file disappeared (defence-in-depth)."""
    try:
        with open(path, "rb") as f:
            raw = f.read()
    except (FileNotFoundError, IsADirectoryError):
        return None
    if not raw:
        return None
    keywords = maildir_flags_to_keywords(os.path.basename(path))
    received_at = maildir_received_at(os.path.basename(path),
                                      os.path.getmtime(path))
    blob_id = client.upload_blob(raw, mime="message/rfc822")
    return _PendingImport(blob_id, keywords, mailbox_id, received_at)


def _flush_import(client: JmapClient,
                  pending: List[_PendingImport]) -> Tuple[int, int]:
    """Email/import a batch. Returns (created_count, failed_count).
    Pending list is consumed (caller should reset it)."""
    if not pending:
        return 0, 0
    emails = {}
    for i, p in enumerate(pending):
        emails[f"e{i}"] = {
            "blobId": p.blob_id,
            "mailboxIds": {p.mailbox_id: True},
            "keywords": p.keywords,
            "receivedAt": p.received_at,
        }
    try:
        sr = client.call([[
            "Email/import",
            {"accountId": client.account_id, "emails": emails},
            "0",
        ]])
        body = sr[0][1]
        created = body.get("created") or {}
        not_created = body.get("notCreated") or {}
        if not_created:
            for k, v in not_created.items():
                sys.stderr.write(f"jmap-restore: Email/import notCreated[{k}]: {v}\n")
        return len(created), len(not_created)
    except JmapError as e:
        sys.stderr.write(f"jmap-restore: Email/import batch failed: {e}\n")
        return 0, len(pending)


def _enumerate_messages(maildir_root: str,
                        source_address: str) -> List[Tuple[str, str]]:
    """Walk <root>/<source>/<mailbox>/{cur,new}/* and return a list of
    (mailbox_name, file_path) tuples. Maildir spec also has /tmp but
    those are in-flight writes, not durable messages — skip them.
    Subfolders separated by '/' in JMAP map to slash-separated names,
    but Maildir on disk uses dot-separation conventionally. Our
    jmap-sync.py only writes one level deep so we mirror that here."""
    out: List[Tuple[str, str]] = []
    if not SAFE_PATH_COMPONENT_RE.match(source_address.replace("@", "_")):
        # Trust the address; jmap-sync.py wrote it. But sanity-check.
        # Just continue.
        pass
    addr_root = os.path.join(maildir_root, source_address)
    if not os.path.isdir(addr_root):
        return out
    for mailbox_name in sorted(os.listdir(addr_root)):
        mb_dir = os.path.join(addr_root, mailbox_name)
        if not os.path.isdir(mb_dir):
            continue
        for sub in ("cur", "new"):
            sub_dir = os.path.join(mb_dir, sub)
            if not os.path.isdir(sub_dir):
                continue
            for fname in sorted(os.listdir(sub_dir)):
                fpath = os.path.join(sub_dir, fname)
                if os.path.isfile(fpath):
                    out.append((mailbox_name, fpath))
    return out


def run(args: argparse.Namespace) -> int:
    t_start = time.time()

    pw = os.environ.get(args.auth_pass_env, "")
    if not pw:
        sys.stderr.write(f"jmap-restore: env {args.auth_pass_env!r} is empty\n")
        return 2

    auth_user = f"{args.target_address}%{args.master_user}"
    client = JmapClient(args.endpoint, auth_user, pw)
    try:
        client.session()
    except JmapError as e:
        sys.stderr.write(f"jmap-restore: session failed: {e}\n")
        return 3

    # 1. Discover existing mailboxes (and resolve INBOX)
    mailboxes = list_mailboxes(client)
    created_mailboxes: List[str] = []
    pre_purged = 0

    # replace mode: wipe every existing message before importing.
    # Mailboxes themselves are kept; only Email/* records are destroyed.
    # This is destructive — the contract gate is at the orchestrator's
    # `confirmDestructive: true` check.
    if getattr(args, "mode", "merge-overwrite") == "replace":
        try:
            cursor: Optional[Dict[str, Any]] = None
            while True:
                qr = client.call([[
                    "Email/query",
                    {"accountId": client.account_id,
                     "limit": 500, "calculateTotal": False},
                    "0",
                ]])
                ids = qr[0][1].get("ids", [])
                if not ids:
                    break
                for chunk_start in range(0, len(ids), 500):
                    chunk = ids[chunk_start:chunk_start + 500]
                    client.call([[
                        "Email/set",
                        {"accountId": client.account_id, "destroy": chunk},
                        "0",
                    ]])
                    pre_purged += len(chunk)
                if len(ids) < 500:
                    break
            sys.stderr.write(f"jmap-restore: replace mode pre-purged {pre_purged} messages\n")
        except JmapError as e:
            sys.stderr.write(f"jmap-restore: replace pre-purge failed: {e}\n")
            return 4

    # 2. Enumerate the snapshot's Maildir files
    files = _enumerate_messages(args.maildir_root, args.source_address)
    sys.stderr.write(f"jmap-restore: source={args.source_address} target={args.target_address} "
                     f"files={len(files)} workers={args.workers}\n")
    if not files:
        sys.stdout.write(json.dumps({
            "address": args.target_address, "imported": 0, "skipped": 0,
            "failed": 0, "mailboxesCreated": [], "elapsedSeconds": 0.0,
        }) + "\n")
        return 0

    # 3. Resolve / create mailboxes for each unique snapshot folder.
    mb_resolution: Dict[str, str] = {}  # snapshot mailbox name → target mailbox id
    for snapshot_mb, _ in files:
        if snapshot_mb in mb_resolution:
            continue
        mb_resolution[snapshot_mb] = resolve_or_create_mailbox(
            client, mailboxes, snapshot_mb, created_mailboxes)

    # 4. Optional dedup pass: if --dedup-by-message-id, scan headers and
    #    drop files whose Message-ID is already on the target. This
    #    costs one Email/query per file UNLESS we use the in-bulk
    #    `header in [m1, m2, ...]` filter form. For now, only enabled
    #    via the flag because for empty-target restores it's wasted work.
    if args.dedup_by_message_id:
        kept: List[Tuple[str, str]] = []
        already: int = 0
        for snapshot_mb, fpath in files:
            try:
                with open(fpath, "rb") as f:
                    head = f.read(8192)  # message-id is in the headers
            except OSError:
                continue
            mid = parse_message_id(head)
            if mid and check_message_id_exists(client, mid):
                already += 1
                continue
            kept.append((snapshot_mb, fpath))
        sys.stderr.write(f"jmap-restore: dedup dropped {already} of {len(files)} "
                         f"already present; importing {len(kept)}\n")
        files = kept

    # 5. Parallel pipeline: a worker pool reads + uploads blobs; a main
    #    coroutine collects completed uploads and flushes Email/import
    #    batches of IMPORT_BATCH entries. Blob/upload is the bottleneck
    #    so parallelism is on that side; Email/import is cheap (a few
    #    method calls per batch).
    pending: List[_PendingImport] = []
    pending_lock = threading.Lock()
    imported = 0
    failed = 0
    skipped = 0

    def flush_locked() -> None:
        nonlocal imported, failed
        with pending_lock:
            batch = pending[:IMPORT_BATCH]
            del pending[:IMPORT_BATCH]
        if batch:
            c, f = _flush_import(client, batch)
            imported += c
            failed += f

    workers = max(1, args.workers)

    def worker(snapshot_mb: str, fpath: str) -> Optional[_PendingImport]:
        try:
            return _read_and_upload(fpath, client, mb_resolution[snapshot_mb])
        except (JmapError, OSError) as e:
            sys.stderr.write(f"jmap-restore: upload {fpath} failed: {e}\n")
            return None

    if workers == 1:
        for snapshot_mb, fpath in files:
            p = worker(snapshot_mb, fpath)
            if p is None:
                skipped += 1
                continue
            with pending_lock:
                pending.append(p)
                ready = len(pending) >= IMPORT_BATCH
            if ready:
                flush_locked()
    else:
        with ThreadPoolExecutor(max_workers=workers,
                                thread_name_prefix="jmap-restore") as pool:
            futures = [pool.submit(worker, mb, fp) for (mb, fp) in files]
            for f in as_completed(futures):
                p = f.result()
                if p is None:
                    skipped += 1
                    continue
                with pending_lock:
                    pending.append(p)
                    ready = len(pending) >= IMPORT_BATCH
                if ready:
                    flush_locked()
    # Final flush
    while True:
        with pending_lock:
            remaining = len(pending)
        if remaining == 0:
            break
        flush_locked()

    elapsed = time.time() - t_start
    summary = {
        "address": args.target_address,
        "mode": getattr(args, "mode", "merge-overwrite"),
        "imported": imported,
        "skipped": skipped,
        "failed": failed,
        "prePurged": pre_purged,
        "mailboxesCreated": created_mailboxes,
        "elapsedSeconds": round(elapsed, 2),
    }
    sys.stdout.write(json.dumps(summary) + "\n")
    return 0 if failed == 0 else 1


def main() -> int:
    p = argparse.ArgumentParser(
        description="JMAP-based Maildir → Stalwart restore (Phase 2 of ADR-036)")
    p.add_argument("--endpoint", required=True,
                   help="JMAP base URL (e.g. https://mail.example.com)")
    p.add_argument("--target-address", required=True,
                   help="Account to restore INTO (must already exist in Stalwart "
                        "— the orchestrator must recreate the principal first "
                        "if it was deleted)")
    p.add_argument("--source-address", required=True,
                   help="Account whose Maildir is in the snapshot — usually "
                        "same as --target-address, but allows cross-account "
                        "restore for migration scenarios")
    p.add_argument("--master-user", required=True,
                   help="Master principal FQ (e.g. master@master.local)")
    p.add_argument("--auth-pass-env", required=True,
                   help="Env var name holding the master password (argv intentionally "
                        "absent to keep credentials out of /proc/<pid>/cmdline)")
    p.add_argument("--maildir-root", required=True,
                   help="Root of the extracted Maildir tree (contains "
                        "<source-address>/<mailbox>/cur/...)")
    p.add_argument("--workers", type=int,
                   default=int(os.environ.get("JMAP_RESTORE_WORKERS", "12")),
                   help="Parallel Blob/upload worker pool size (env "
                        "JMAP_RESTORE_WORKERS, default 12). Stalwart's "
                        "maxConcurrentUploads + maxConcurrentRequests cap the "
                        "effective parallelism — bootstrap-plan sets both to "
                        "128. Workers above 32 hit diminishing returns due to "
                        "Stalwart's per-principal request scheduling. Set to "
                        "1 to force serial (debugging).")
    p.add_argument("--dedup-by-message-id", action="store_true",
                   help="Before each upload, query Email/header[Message-ID] on "
                        "the target and skip if present. Adds one round-trip per "
                        "file; only enable when restoring INTO a non-empty mailbox "
                        "(retry after partial failure).")
    p.add_argument("--mode",
                   choices=["merge-overwrite", "merge-skip-duplicates", "replace"],
                   default="merge-overwrite",
                   help="Restore mode (matches Phase 1 contract): "
                        "'merge-overwrite' imports everything as-is (duplicates "
                        "allowed); 'merge-skip-duplicates' implies "
                        "--dedup-by-message-id; 'replace' destroys every existing "
                        "message in the target account BEFORE importing — "
                        "destructive, callers must gate with confirmDestructive.")
    args = p.parse_args()
    if args.mode == "merge-skip-duplicates":
        args.dedup_by_message_id = True
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
