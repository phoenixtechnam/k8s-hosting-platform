#!/usr/bin/env python3
"""
jmap-seed.py — synthesise + inject N marked messages into a mailbox via JMAP.

Used by the Phase 2 full-E2E harness. Mirrors jmap-sync.py's auth +
endpoint-rebase pattern. For each i in 1..N:
  1. Build an RFC 5322 message with subject "MARKER <prefix> i/N"
     and a fixed-line body containing the marker (so byte-level
     verification works after backup/restore round-trip).
  2. POST the raw bytes to JMAP's `uploadUrl` → get blobId.
  3. Call `Email/import` to attach the blob to INBOX with $seen.

Output: JSON summary on stdout `{ seeded, failed, mailboxId, blobIds }`.

Why Email/import vs. SMTP submission:
  - JMAP server-side: one round-trip per message (vs. SMTP needing
    full session + DATA stream).
  - No DKIM / SPF processing — these are imports, not new outbound.
  - Stalwart's Email/import accepts arbitrary keywords + receivedAt,
    matching exactly what jmap-sync.py reads back during capture.

Pure stdlib; no third-party deps.
"""
from __future__ import annotations

import argparse
import base64
import email.utils
import http.client
import json
import os
import random
import socket
import ssl
import sys
import threading
import time
import urllib.parse
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlsplit, urlunsplit

JMAP_URN_CORE = "urn:ietf:params:jmap:core"
JMAP_URN_MAIL = "urn:ietf:params:jmap:mail"


class JmapError(Exception):
    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code


class JmapClient:
    """Minimal JMAP client — same persistent http.client connection
    pattern as jmap-sync.py / jmap-restore.py. Keep-alive eliminates
    per-request TCP+TLS handshake cost; per-thread connections via
    thread-local storage make the client safe to share across
    concurrent uploads from a future parallel seeder."""

    def __init__(self, endpoint: str, basic_auth_user: str, basic_auth_pass: str) -> None:
        if not endpoint.endswith("/.well-known/jmap"):
            endpoint = endpoint.rstrip("/") + "/.well-known/jmap"
        self.session_url = endpoint
        raw = f"{basic_auth_user}:{basic_auth_pass}".encode()
        self._auth_header = "Basic " + base64.b64encode(raw).decode()
        self._api_url: Optional[str] = None
        self._upload_url: Optional[str] = None
        self._mail_account_id: Optional[str] = None
        self._tls_context = ssl.create_default_context()
        self._tls = threading.local()

    def _get_conn(self, netloc: str, is_https: bool) -> http.client.HTTPConnection:
        existing = getattr(self._tls, "conn", None)
        if existing is not None and getattr(self._tls, "netloc", "") == netloc:
            return existing
        if existing is not None:
            try:
                existing.close()
            except Exception:
                pass
        if is_https:
            conn: http.client.HTTPConnection = http.client.HTTPSConnection(
                netloc, timeout=60, context=self._tls_context)
        else:
            conn = http.client.HTTPConnection(netloc, timeout=60)
        self._tls.conn = conn
        self._tls.netloc = netloc
        return conn

    def _http(self, url: str, *, method: str = "GET", body: Optional[bytes] = None,
              content_type: str = "application/json; charset=utf-8",
              accept: str = "application/json") -> Tuple[int, bytes]:
        u = urlsplit(url)
        is_https = u.scheme == "https"
        netloc = u.netloc
        path = u.path or "/"
        if u.query:
            path = f"{path}?{u.query}"
        headers = {
            "Authorization": self._auth_header,
            "Accept": accept,
            "Connection": "keep-alive",
        }
        if body is not None:
            headers["Content-Type"] = content_type
            headers["Content-Length"] = str(len(body))

        attempts = 0
        redirects = 0
        while True:
            conn = self._get_conn(netloc, is_https)
            try:
                conn.request(method, path, body=body, headers=headers)
                resp = conn.getresponse()
                status = resp.status
                location = resp.getheader("Location") or ""
                data = resp.read()
                # Follow up to 3 redirects.
                if status in (301, 302, 307, 308) and location and redirects < 3:
                    if location.startswith("/"):
                        path = location
                    else:
                        lu = urlsplit(location)
                        if lu.netloc and lu.netloc != netloc:
                            netloc = lu.netloc
                            is_https = lu.scheme == "https"
                        path = lu.path + (f"?{lu.query}" if lu.query else "")
                    redirects += 1
                    continue
                if status == 400 and b"jmap:error:limit" in data and attempts < 8:
                    base = min(0.1 * (2 ** attempts), 2.0)
                    delay = base * (0.5 + random.random())
                    time.sleep(delay)
                    attempts += 1
                    continue
                return status, data
            except (http.client.HTTPException, OSError, socket.error) as e:
                try:
                    conn.close()
                except Exception:
                    pass
                self._tls.conn = None
                if attempts < 4:
                    time.sleep(0.1 * (2 ** attempts) * (0.5 + random.random()))
                    attempts += 1
                    continue
                raise JmapError("CONN_ERROR", f"{type(e).__name__}: {e}")

    def session(self) -> None:
        status, body = self._http(self.session_url)
        if status in (401, 403):
            raise JmapError("AUTH_FAILED", f"HTTP {status}")
        if status != 200:
            raise JmapError("SESSION_HTTP", f"HTTP {status}: {body[:200]!r}")
        s = json.loads(body)
        # Re-root apiUrl + uploadUrl onto session URL's origin to keep
        # all traffic in-cluster (Stalwart returns the public HTTPS
        # URL by default — see jmap-sync.py for context).
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
            raise JmapError("NO_MAIL_ACCOUNT", "no JMAP mail-capable account")

    @property
    def account_id(self) -> str:
        if not self._mail_account_id:
            raise RuntimeError("session() not called")
        return self._mail_account_id

    def call(self, invocations: List[List[Any]]) -> List[List[Any]]:
        if not self._api_url:
            raise RuntimeError("session() not called")
        req = {"using": [JMAP_URN_CORE, JMAP_URN_MAIL], "methodCalls": invocations}
        status, resp_body = self._http(self._api_url, method="POST", body=json.dumps(req).encode())
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
        """POST to uploadUrl; the {accountId} placeholder is substituted."""
        if not self._upload_url:
            raise RuntimeError("session() not called")
        url = self._upload_url.replace("{accountId}", urllib.parse.quote(self.account_id, safe=""))
        status, body = self._http(url, method="POST", body=data, content_type=mime)
        if status not in (200, 201):
            raise JmapError("UPLOAD_HTTP", f"HTTP {status}: {body[:200]!r}")
        d = json.loads(body)
        return d["blobId"]


def find_inbox_id(client: JmapClient) -> str:
    """Resolve the JMAP mailbox id of the account's INBOX. Stalwart
    creates one per account automatically when the principal is
    provisioned."""
    sr = client.call([[
        "Mailbox/get",
        {"accountId": client.account_id, "ids": None, "properties": ["id", "name", "role"]},
        "0",
    ]])
    for m in sr[0][1].get("list", []):
        # role=='inbox' is the canonical signal per RFC 8621 §2.
        if m.get("role") == "inbox":
            return m["id"]
        if m.get("name", "").lower() == "inbox":
            return m["id"]
    raise JmapError("NO_INBOX", "no INBOX mailbox on this account")


def build_rfc5322(*, addr: str, n: int, total: int, marker: str) -> bytes:
    """Build a minimal but real-world RFC 5322 message. Subject + body
    both carry the marker so verification can grep either field."""
    msg_id = f"<seed-{n:06d}-{marker}@e2e>"
    date = email.utils.formatdate(localtime=False)
    from_addr = "e2e-seeder@test.local"
    subject = f"MARKER {marker} message {n}/{total}"
    body = (
        f"This is e2e seed message {n} of {total}.\r\n"
        f"Marker: {marker}\r\n"
        f"Address: {addr}\r\n"
        f"Generated: {time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())}\r\n"
        f"--- begin payload ---\r\n"
        + ("the quick brown fox jumps over the lazy dog\r\n" * 10)
        + "--- end payload ---\r\n"
    )
    return (
        f"From: {from_addr}\r\n"
        f"To: {addr}\r\n"
        f"Subject: {subject}\r\n"
        f"Date: {date}\r\n"
        f"Message-ID: {msg_id}\r\n"
        f"Content-Type: text/plain; charset=utf-8\r\n"
        f"MIME-Version: 1.0\r\n"
        f"\r\n"
        f"{body}"
    ).encode("utf-8")


def main() -> int:
    p = argparse.ArgumentParser(description="Seed N marked messages into a mailbox via JMAP")
    p.add_argument("--endpoint", required=True)
    p.add_argument("--account-address", required=True)
    p.add_argument("--master-user", required=True)
    p.add_argument("--auth-pass-env", required=True)
    p.add_argument("--count", type=int, required=True)
    p.add_argument("--marker", default="e2e")
    p.add_argument("--mailbox-role", default="inbox",
                   help="Target mailbox role (inbox|sent|drafts|...) — defaults to inbox")
    p.add_argument("--flagged-every-n", type=int, default=0,
                   help="If >0, set $flagged on every Nth message")
    args = p.parse_args()

    pw = os.environ.get(args.auth_pass_env, "")
    if not pw:
        sys.stderr.write(f"jmap-seed: env {args.auth_pass_env!r} is empty\n")
        return 2
    auth_user = f"{args.account_address}%{args.master_user}"

    client = JmapClient(args.endpoint, auth_user, pw)
    try:
        client.session()
    except JmapError as e:
        sys.stderr.write(f"jmap-seed: session failed: {e}\n")
        return 3

    inbox_id = find_inbox_id(client)
    sys.stderr.write(f"jmap-seed: account={client.account_id} inbox={inbox_id}\n")

    seeded = 0
    failed = 0
    blob_ids: List[str] = []
    # Batch Email/import calls — Stalwart accepts up to ~50 per call.
    BATCH = 25
    pending: List[Dict[str, Any]] = []

    def flush_batch() -> None:
        nonlocal seeded, failed
        if not pending:
            return
        emails_map = {f"e{idx}": item for idx, item in enumerate(pending)}
        try:
            sr = client.call([[
                "Email/import",
                {"accountId": client.account_id, "emails": emails_map},
                "0",
            ]])
            body = sr[0][1]
            created = body.get("created") or {}
            not_created = body.get("notCreated") or {}
            seeded += len(created)
            failed += len(not_created)
            if not_created:
                for k, v in not_created.items():
                    sys.stderr.write(f"jmap-seed: Email/import notCreated[{k}]: {v}\n")
        except JmapError as e:
            sys.stderr.write(f"jmap-seed: Email/import batch failed: {e}\n")
            failed += len(pending)
        pending.clear()

    for i in range(1, args.count + 1):
        try:
            raw = build_rfc5322(addr=args.account_address, n=i, total=args.count, marker=args.marker)
            blob_id = client.upload_blob(raw)
            blob_ids.append(blob_id)
            keywords = {"$seen": True}
            if args.flagged_every_n and i % args.flagged_every_n == 0:
                keywords["$flagged"] = True
            pending.append({
                "blobId": blob_id,
                "mailboxIds": {inbox_id: True},
                "keywords": keywords,
                "receivedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            })
            if len(pending) >= BATCH:
                flush_batch()
            if i % 100 == 0:
                sys.stderr.write(f"jmap-seed: {i}/{args.count} uploaded\n")
        except JmapError as e:
            sys.stderr.write(f"jmap-seed: message {i} upload failed: {e}\n")
            failed += 1
    flush_batch()

    sys.stdout.write(json.dumps({
        "seeded": seeded,
        "failed": failed,
        "mailboxId": inbox_id,
        "blobIds": blob_ids[:10],  # first 10 only — keep output bounded
    }) + "\n")
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
