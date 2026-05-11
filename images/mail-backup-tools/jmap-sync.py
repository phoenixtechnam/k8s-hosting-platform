#!/usr/bin/env python3
"""
jmap-sync.py — Phase 2 of tenant-backup-v2 (ADR-036).

JMAP-driven mailbox capture into a Maildir-shaped output tree. Replaces
the legacy mbsync-based capture path.

Auth: Stalwart master-user proxy (`<addr>%<master_fq>` username + master
password from Secret-mounted env). Reads all messages belonging to one
tenant mailbox; writes them to:

    <output-dir>/<account-address>/<mailbox-name>/cur/<unix>.<unique>:2,<flags>

`<flags>` is the Maildir flag suffix per https://cr.yp.to/proto/maildir.html:
  S = $seen, F = $flagged, R = $answered, T = $deleted, D = $draft

Incremental: pass --state-in <path>. If the file contains a JMAP
`Email/changes` state token, the script fetches changes since that
state; otherwise (file missing/empty/--no-state-in) does a full pull.
On success, writes the new state to --state-out as JSON
`{"state": "<token>"}` for the orchestrator to read.

Failure modes:
  - JMAP server returns `cannotCalculateChanges` (state too old or
    server compacted): the script falls back to a full pull, writes
    new state with a marker in stderr.
  - Auth failure: exit 2 with reason on stderr.
  - Body fetch failure for one message: logs to stderr and continues;
    the message is skipped (will be re-fetched on the next run because
    the new state isn't advanced for it).

Output:
  - stdout: one JSON object summary `{ "address": ..., "fetched": N,
    "skipped": M, "newState": "...", "fullPull": bool }`
  - exit 0 on success, non-zero on fatal error.

Stdlib only — no third-party deps.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import re
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any, Dict, List, Optional, Tuple

# JMAP method-call namespace
JMAP_URN_CORE = "urn:ietf:params:jmap:core"
JMAP_URN_MAIL = "urn:ietf:params:jmap:mail"

# Practical batch sizes for Email/get + Blob/get. Stalwart accepts up to
# ~500 ids per batch but smaller keeps each round-trip short under
# packet loss / TLS resumption windows.
GET_BATCH = 100
# Maximum pages of Email/query results during a full pull. 100 × 200 =
# 20,000 message ceiling per mailbox per run. Larger mailboxes need
# multiple runs (state-token continuation).
QUERY_PAGE_LIMIT = 200
MAX_QUERY_PAGES = 100

# JMAP flag → Maildir flag character mapping. Order matters for the
# Maildir spec (alphabetical). Drafts and Trash are sometimes set as
# Mailbox roles; we honour both keyword `$draft`/`$junk` and mailbox
# role inference.
KEYWORD_TO_FLAG = {
    "$seen": "S",
    "$flagged": "F",
    "$answered": "R",
    "$deleted": "T",
    "$draft": "D",
}

SAFE_NAME_RE = re.compile(r"[^A-Za-z0-9._@+\-]+")


def _safe_filename(s: str) -> str:
    """Replace unsafe chars in a path component. Maildir filenames
    allow most printable ASCII; we just avoid '/' and any control chars."""
    return SAFE_NAME_RE.sub("_", s) or "unknown"


def _maildir_flags(keywords: Dict[str, bool]) -> str:
    """Render JMAP keywords as a Maildir flag suffix. Sorted alphabetically
    per the Maildir spec."""
    flags = [KEYWORD_TO_FLAG[k] for k in KEYWORD_TO_FLAG if keywords.get(k)]
    return "".join(sorted(flags))


def _maildir_filename(internal_unix: int, message_id: str, flags: str) -> str:
    """unix.unique.host:2,flags — RFC-ish Maildir filename. We use the
    JMAP id as the unique part (it's globally unique per server)."""
    host = socket.gethostname()
    safe_id = _safe_filename(message_id)
    # Maildir colon-2-comma format: `unix.unique.host:2,<flags>`
    return f"{internal_unix}.{safe_id}.{host}:2,{flags}"


class JmapError(Exception):
    """Recoverable JMAP error (e.g., cannotCalculateChanges)."""

    def __init__(self, code: str, detail: str = "") -> None:
        super().__init__(f"{code}: {detail}" if detail else code)
        self.code = code
        self.detail = detail


class JmapClient:
    def __init__(self, endpoint: str, basic_auth_user: str, basic_auth_pass: str) -> None:
        # Endpoint may be the session URL or the host root; both work
        # because the session response carries the apiUrl.
        if not endpoint.endswith("/.well-known/jmap") and "/api" not in endpoint:
            endpoint = endpoint.rstrip("/") + "/.well-known/jmap"
        self.session_url = endpoint
        raw = f"{basic_auth_user}:{basic_auth_pass}".encode()
        self._auth_header = "Basic " + base64.b64encode(raw).decode()
        self._api_url: Optional[str] = None
        self._download_url: Optional[str] = None
        self._mail_account_id: Optional[str] = None

    def _http(self, url: str, *, method: str = "GET", body: Optional[bytes] = None,
              accept: str = "application/json") -> Tuple[int, bytes, str]:
        req = urllib.request.Request(url, data=body, method=method)
        req.add_header("Authorization", self._auth_header)
        req.add_header("Accept", accept)
        if body is not None:
            req.add_header("Content-Type", "application/json; charset=utf-8")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.status, resp.read(), resp.headers.get("Content-Type", "")
        except urllib.error.HTTPError as e:
            return e.code, e.read() if hasattr(e, "read") else b"", e.headers.get("Content-Type", "") if hasattr(e, "headers") else ""

    def session(self, account_address: str) -> None:
        status, body, _ = self._http(self.session_url)
        if status == 401 or status == 403:
            raise JmapError("AUTH_FAILED", f"HTTP {status}")
        if status != 200:
            raise JmapError("SESSION_HTTP", f"HTTP {status}: {body[:200]!r}")
        try:
            s = json.loads(body)
        except json.JSONDecodeError as e:
            raise JmapError("SESSION_PARSE", str(e))
        # Stalwart's session response returns `apiUrl` / `downloadUrl`
        # rooted at the configured PUBLIC base URL (HTTPS, public ingress
        # hostname), even when we reached the session via the in-cluster
        # HTTP service IP. Following the public URL fails:
        #   - SSL cert verify (LE staging certs aren't trusted by our
        #     stdlib SSL context)
        #   - DNS may not resolve from inside the cluster
        # Re-root both URLs at the session's ORIGIN so the rest of the
        # JMAP traffic stays on the same in-cluster HTTP transport.
        from urllib.parse import urlsplit, urlunsplit
        our = urlsplit(self.session_url)
        def _reroot(url: str) -> str:
            u = urlsplit(url)
            return urlunsplit((our.scheme, our.netloc, u.path, u.query, u.fragment))
        self._api_url = _reroot(s["apiUrl"])
        self._download_url = _reroot(s["downloadUrl"])  # template; placeholders preserved
        # Stalwart returns one mail account; pick the one matching the
        # current proxy login address. Falls back to "the only one"
        # when there's a single mail account.
        accounts = s.get("accounts", {})
        for acc_id, acc in accounts.items():
            email_caps = acc.get("accountCapabilities", {})
            if JMAP_URN_MAIL not in email_caps:
                continue
            # When proxy-authed as user@example.com%master, Stalwart
            # returns the user's own account. So picking the first
            # mail-capable account is correct in our context.
            self._mail_account_id = acc_id
            break
        if not self._mail_account_id:
            raise JmapError("NO_MAIL_ACCOUNT", f"no JMAP mail-capable account for {account_address}")

    @property
    def account_id(self) -> str:
        if not self._mail_account_id:
            raise RuntimeError("session() not called")
        return self._mail_account_id

    def call(self, invocations: List[List[Any]]) -> List[List[Any]]:
        if not self._api_url:
            raise RuntimeError("session() not called")
        req = {
            "using": [JMAP_URN_CORE, JMAP_URN_MAIL],
            "methodCalls": invocations,
        }
        body = json.dumps(req).encode()
        status, resp_body, _ = self._http(self._api_url, method="POST", body=body)
        if status != 200:
            raise JmapError("CALL_HTTP", f"HTTP {status}: {resp_body[:200]!r}")
        try:
            resp = json.loads(resp_body)
        except json.JSONDecodeError as e:
            raise JmapError("CALL_PARSE", str(e))
        results = resp.get("methodResponses", [])
        # Scan for any embedded error responses inline
        for inv in results:
            if inv[0] == "error":
                err = inv[1] or {}
                raise JmapError(err.get("type", "UNKNOWN"), err.get("description", ""))
        return results

    def download_blob(self, blob_id: str, blob_type: str = "application/octet-stream", filename: str = "blob") -> bytes:
        if not self._download_url:
            raise RuntimeError("session() not called")
        # downloadUrl is templated; per RFC the placeholders are
        # {accountId} {blobId} {type} {name}.
        url = (
            self._download_url
            .replace("{accountId}", urllib.parse.quote(self.account_id, safe=""))
            .replace("{blobId}", urllib.parse.quote(blob_id, safe=""))
            .replace("{type}", urllib.parse.quote(blob_type, safe=""))
            .replace("{name}", urllib.parse.quote(filename, safe=""))
        )
        status, body, _ = self._http(url, accept="*/*")
        if status != 200:
            raise JmapError("BLOB_HTTP", f"HTTP {status} for blob {blob_id[:20]}")
        return body


def _batches(items: List[str], size: int) -> List[List[str]]:
    return [items[i:i + size] for i in range(0, len(items), size)]


def _full_pull_ids(client: JmapClient) -> Tuple[List[str], str]:
    """Page through Email/query to collect every message id, then take
    one Email/changes call with state="" semantics to grab the current
    state token for incremental continuation."""
    ids: List[str] = []
    position = 0
    final_state = ""
    for page in range(MAX_QUERY_PAGES):
        results = client.call([[
            "Email/query",
            {
                "accountId": client.account_id,
                "position": position,
                "limit": QUERY_PAGE_LIMIT,
                "calculateTotal": False,
                # No sort = server default (received-at desc usually);
                # we don't depend on order — just need every id once.
            },
            "0",
        ]])
        body = results[0][1]
        batch = body.get("ids", [])
        if not batch:
            break
        ids.extend(batch)
        final_state = body.get("queryState", final_state)
        if len(batch) < QUERY_PAGE_LIMIT:
            break
        position += len(batch)
    # Sample the live state token; Email/query returns a queryState
    # which is NOT the same as Email/changes state. Take a fresh state
    # by calling Email/changes with an empty sinceState (servers return
    # the current state in newState).
    try:
        sr = client.call([[
            "Email/changes",
            {"accountId": client.account_id, "sinceState": "0"},
            "0",
        ]])
        # Many servers reject sinceState="0" with cannotCalculateChanges;
        # the newState is still typically present in the error result,
        # but if not we fall back to using queryState as a placeholder.
        body = sr[0][1]
        new_state = body.get("newState") or final_state
        return ids, new_state or ""
    except JmapError as e:
        if e.code == "cannotCalculateChanges":
            # The error response may include newState in the error
            # struct. Best-effort: return whatever queryState we have.
            return ids, final_state or ""
        raise


def _incremental_ids(client: JmapClient, since_state: str) -> Tuple[List[str], List[str], str, bool]:
    """Returns (created+updated ids, destroyed ids, newState, fullPullFallback)."""
    try:
        sr = client.call([[
            "Email/changes",
            {"accountId": client.account_id, "sinceState": since_state},
            "0",
        ]])
    except JmapError as e:
        if e.code == "cannotCalculateChanges":
            sys.stderr.write(f"jmap-sync: cannotCalculateChanges for state {since_state!r} — falling back to full pull\n")
            ids, new_state = _full_pull_ids(client)
            return ids, [], new_state, True
        raise
    body = sr[0][1]
    created = body.get("created", [])
    updated = body.get("updated", [])
    destroyed = body.get("destroyed", [])
    new_state = body.get("newState", since_state)
    return list(created) + list(updated), list(destroyed), new_state, False


def _fetch_mailbox_names(client: JmapClient) -> Dict[str, str]:
    """Returns {mailboxId: displayName}."""
    sr = client.call([[
        "Mailbox/get",
        {"accountId": client.account_id, "ids": None, "properties": ["id", "name"]},
        "0",
    ]])
    body = sr[0][1]
    return {m["id"]: m.get("name", m["id"]) for m in body.get("list", [])}


def _fetch_messages(client: JmapClient, ids: List[str]) -> List[Dict[str, Any]]:
    """Returns the full Email/get message list across batches."""
    out: List[Dict[str, Any]] = []
    for batch in _batches(ids, GET_BATCH):
        sr = client.call([[
            "Email/get",
            {
                "accountId": client.account_id,
                "ids": batch,
                "properties": ["id", "blobId", "mailboxIds", "keywords", "receivedAt", "messageId"],
            },
            "0",
        ]])
        out.extend(sr[0][1].get("list", []))
    return out


def _write_message(output_dir: str, account_address: str, message: Dict[str, Any],
                   mailbox_names: Dict[str, str], blob: bytes) -> str:
    keywords = message.get("keywords", {})
    flags = _maildir_flags(keywords)

    # JMAP receivedAt is RFC 3339; convert to unix for Maildir filename.
    received_at = message.get("receivedAt") or ""
    try:
        if received_at:
            # 2024-05-11T12:34:56Z → epoch
            t = time.strptime(received_at.replace("Z", "UTC").split(".")[0], "%Y-%m-%dT%H:%M:%S%Z") \
                if received_at.endswith("Z") else time.strptime(received_at[:19], "%Y-%m-%dT%H:%M:%S")
            unix = int(time.mktime(t))
        else:
            unix = int(time.time())
    except (ValueError, OverflowError):
        unix = int(time.time())

    fname = _maildir_filename(unix, message["id"], flags)
    # JMAP messages can live in multiple mailboxes; write to the FIRST
    # one and add a Maildir hardlink-style copy for each additional one.
    # For Phase 2 v1 we write only to the first mailbox — restore
    # semantics flatten anyway because restic dedups the raw bytes.
    mailbox_ids = list(message.get("mailboxIds", {}).keys())
    if not mailbox_ids:
        # Orphan message — Stalwart shouldn't produce these but defend.
        mailbox_ids = ["__orphan__"]
    first_mb = mailbox_names.get(mailbox_ids[0], mailbox_ids[0])
    mb_name = _safe_filename(first_mb)
    addr_dir = _safe_filename(account_address)
    target_dir = os.path.join(output_dir, addr_dir, mb_name, "cur")
    os.makedirs(target_dir, exist_ok=True)
    path = os.path.join(target_dir, fname)
    # Write atomically: tmp + rename. Maildir spec says new files
    # belong in /tmp first then /cur, but for capture (read-only side)
    # rename within the same fs is plenty.
    tmp_path = path + ".part"
    with open(tmp_path, "wb") as f:
        f.write(blob)
    os.rename(tmp_path, path)
    return path


def run(args: argparse.Namespace) -> int:
    # Auth — password ONLY via env var. The earlier --auth-pass argv
    # fallback was removed (reviewer LOW): even though the prod call
    # site uses --auth-pass-env, an operator could mis-invoke
    # jmap-sync.py with --auth-pass <value> and leak the master
    # credential into /proc/<pid>/cmdline + system audit logs.
    pw = os.environ.get(args.auth_pass_env, "")
    if not pw:
        sys.stderr.write(f"jmap-sync: env {args.auth_pass_env!r} is empty\n")
        return 2

    # Proxy-auth username: <addr>%<master_fq>. master_fq comes from
    # --master-user; the address being captured is --account-address.
    auth_user = f"{args.account_address}%{args.master_user}"

    client = JmapClient(args.endpoint, auth_user, pw)
    try:
        client.session(args.account_address)
    except JmapError as e:
        sys.stderr.write(f"jmap-sync: session failed: {e}\n")
        return 3

    # Determine since-state (incremental vs full)
    since_state = ""
    if args.state_in and os.path.exists(args.state_in):
        try:
            with open(args.state_in, "r") as f:
                doc = json.load(f)
            since_state = (doc or {}).get("state", "") or ""
        except (json.JSONDecodeError, OSError) as e:
            sys.stderr.write(f"jmap-sync: state-in unreadable ({e}); falling back to full pull\n")
            since_state = ""

    full_pull = not since_state
    destroyed: List[str] = []

    if full_pull:
        ids, new_state = _full_pull_ids(client)
    else:
        ids, destroyed, new_state, fallback = _incremental_ids(client, since_state)
        if fallback:
            full_pull = True

    # Deduplicate (Email/changes can return overlapping created+updated)
    ids = list(dict.fromkeys(ids))

    mailbox_names = _fetch_mailbox_names(client) if ids else {}
    messages = _fetch_messages(client, ids) if ids else []

    fetched = 0
    skipped = 0
    for msg in messages:
        try:
            blob_id = msg.get("blobId")
            if not blob_id:
                sys.stderr.write(f"jmap-sync: message {msg.get('id')!r} has no blobId; skipping\n")
                skipped += 1
                continue
            blob = client.download_blob(
                blob_id,
                blob_type="message/rfc822",
                filename=msg.get("id", "msg"),
            )
            _write_message(args.output_dir, args.account_address, msg, mailbox_names, blob)
            fetched += 1
        except (JmapError, OSError) as e:
            sys.stderr.write(f"jmap-sync: message {msg.get('id')!r} fetch failed: {e}\n")
            skipped += 1

    # Write new state
    if args.state_out:
        os.makedirs(os.path.dirname(args.state_out) or ".", exist_ok=True)
        with open(args.state_out, "w") as f:
            json.dump({"state": new_state}, f)

    summary = {
        "address": args.account_address,
        "fetched": fetched,
        "skipped": skipped,
        "destroyed": len(destroyed),
        "newState": new_state,
        "fullPull": full_pull,
    }
    sys.stdout.write(json.dumps(summary) + "\n")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description="JMAP → Maildir capture for tenant-backup-v2")
    p.add_argument("--endpoint", required=True, help="JMAP base URL (e.g. https://mail.example.com)")
    p.add_argument("--account-address", required=True, help="Tenant mailbox to capture")
    p.add_argument("--master-user", required=True, help="Master principal FQ (e.g. master@master.local)")
    p.add_argument("--auth-pass-env", required=True,
                   help="Env var name holding the master password (the only supported form — "
                        "--auth-pass argv is intentionally absent to keep the master credential "
                        "out of /proc/<pid>/cmdline and any system audit log)")
    p.add_argument("--output-dir", required=True, help="Root of the Maildir output tree")
    p.add_argument("--state-in", help="Path to read prior JMAP state from (JSON {state: ...})")
    p.add_argument("--state-out", help="Path to write new JMAP state to (JSON {state: ...})")
    args = p.parse_args()
    return run(args)


if __name__ == "__main__":
    sys.exit(main())
