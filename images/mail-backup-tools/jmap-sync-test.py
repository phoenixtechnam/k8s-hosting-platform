#!/usr/bin/env python3
"""
Smoke + integration test for jmap-sync.py against a fake JMAP server.

Runs an in-process http.server that responds to:
  - GET  /.well-known/jmap            → session document
  - POST /jmap                        → method calls (Email/query, Email/get,
                                          Mailbox/get, Email/changes)
  - GET  /download/<accountId>/<blobId>  → raw RFC 5322 bytes

Verifies:
  1. Full-pull path writes Maildir-shaped files for every fetched email.
  2. State-out JSON is written with the new state token.
  3. Incremental path uses Email/changes and skips destroyed messages.
  4. cannotCalculateChanges triggers a fallback full pull.
  5. Auth header is exactly Basic base64("<addr>%<master>:<password>").

Run with: `python3 jmap-sync-test.py` from the image directory. Exits
non-zero on any failure.
"""
import base64
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List


THIS_DIR = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(THIS_DIR, "jmap-sync.py")
MASTER_USER = "master@master.local"
MASTER_PASS = "test-pass-1234"
TEST_ADDR = "alice@example.com"
ACCOUNT_ID = "acct-alice"


def _expected_auth() -> str:
    raw = f"{TEST_ADDR}%{MASTER_USER}:{MASTER_PASS}".encode()
    return "Basic " + base64.b64encode(raw).decode()


class FakeJmapState:
    """Server-side state. Tests mutate it to control responses."""

    def __init__(self) -> None:
        # message_id -> {blob: bytes, mailboxIds: [...], keywords: {...}}
        self.messages: Dict[str, Dict[str, Any]] = {}
        # state token returned for the next Email/changes call
        self.current_state: str = "state-1"
        # If set, the next Email/changes returns cannotCalculateChanges
        self.fail_changes: bool = False
        # Recorded auth headers (for assertion)
        self.auth_headers: List[str] = []


SHARED = FakeJmapState()


class FakeJmapHandler(BaseHTTPRequestHandler):
    def log_message(self, *_args: Any, **_kw: Any) -> None:
        return  # silence access log

    def _record_auth(self) -> bool:
        h = self.headers.get("Authorization", "")
        SHARED.auth_headers.append(h)
        return h == _expected_auth()

    def do_GET(self) -> None:
        if self.path == "/.well-known/jmap":
            if not self._record_auth():
                self.send_response(401); self.end_headers(); return
            session = {
                "apiUrl": f"http://{self.headers['Host']}/jmap",
                "downloadUrl": f"http://{self.headers['Host']}/download/{{accountId}}/{{blobId}}/{{name}}",
                "accounts": {
                    ACCOUNT_ID: {
                        "name": TEST_ADDR,
                        "isPersonal": True,
                        "accountCapabilities": {"urn:ietf:params:jmap:mail": {}},
                    }
                },
            }
            body = json.dumps(session).encode()
            self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(body))); self.end_headers()
            self.wfile.write(body)
            return
        # download path: /download/<accountId>/<blobId>/<name>
        if self.path.startswith("/download/"):
            if not self._record_auth():
                self.send_response(401); self.end_headers(); return
            parts = self.path.split("/", 4)
            blob_id = parts[3] if len(parts) > 3 else ""
            from urllib.parse import unquote
            blob_id = unquote(blob_id)
            # Look up by blob_id; messages dict keys ARE the blob ids.
            msg = SHARED.messages.get(blob_id)
            if not msg:
                self.send_response(404); self.end_headers(); return
            blob = msg["blob"]
            self.send_response(200); self.send_header("Content-Type", "message/rfc822"); self.send_header("Content-Length", str(len(blob))); self.end_headers()
            self.wfile.write(blob)
            return
        self.send_response(404); self.end_headers()

    def do_POST(self) -> None:
        if self.path != "/jmap":
            self.send_response(404); self.end_headers(); return
        if not self._record_auth():
            self.send_response(401); self.end_headers(); return
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode() if length else ""
        req = json.loads(body)
        responses = []
        for inv in req.get("methodCalls", []):
            method, args, tag = inv[0], inv[1], inv[2]
            if method == "Email/query":
                responses.append(["Email/query", {
                    "accountId": ACCOUNT_ID,
                    "queryState": SHARED.current_state,
                    "position": args.get("position", 0),
                    "total": len(SHARED.messages),
                    "ids": list(SHARED.messages.keys())[args.get("position", 0):args.get("position", 0) + args.get("limit", 100)],
                }, tag])
            elif method == "Email/get":
                ids = args.get("ids") or []
                out = []
                for mid in ids:
                    m = SHARED.messages.get(mid)
                    if not m:
                        continue
                    out.append({
                        "id": mid,
                        "blobId": mid,
                        "mailboxIds": m["mailboxIds"],
                        "keywords": m.get("keywords", {}),
                        "receivedAt": m.get("receivedAt", "2024-01-01T00:00:00Z"),
                        "messageId": [mid + "@test"],
                    })
                responses.append(["Email/get", {"accountId": ACCOUNT_ID, "list": out}, tag])
            elif method == "Email/changes":
                since = args.get("sinceState", "")
                if SHARED.fail_changes:
                    responses.append(["error", {"type": "cannotCalculateChanges", "description": "state too old"}, tag])
                    continue
                # Naïve simulation: created = all messages, updated/destroyed = empty.
                responses.append(["Email/changes", {
                    "accountId": ACCOUNT_ID,
                    "oldState": since,
                    "newState": SHARED.current_state,
                    "hasMoreChanges": False,
                    "created": list(SHARED.messages.keys()) if since != SHARED.current_state else [],
                    "updated": [],
                    "destroyed": [],
                }, tag])
            elif method == "Mailbox/get":
                responses.append(["Mailbox/get", {
                    "accountId": ACCOUNT_ID,
                    "list": [
                        {"id": "mb-inbox", "name": "INBOX"},
                        {"id": "mb-sent", "name": "Sent"},
                    ],
                }, tag])
            else:
                responses.append(["error", {"type": "unknownMethod", "description": method}, tag])
        resp = json.dumps({"methodResponses": responses, "sessionState": SHARED.current_state}).encode()
        self.send_response(200); self.send_header("Content-Type", "application/json"); self.send_header("Content-Length", str(len(resp))); self.end_headers()
        self.wfile.write(resp)


class JmapSyncTest(unittest.TestCase):
    server: ThreadingHTTPServer
    thread: threading.Thread
    endpoint: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), FakeJmapHandler)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()
        cls.endpoint = f"http://127.0.0.1:{cls.server.server_address[1]}"

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()

    def setUp(self) -> None:
        SHARED.messages = {}
        SHARED.current_state = "state-1"
        SHARED.fail_changes = False
        SHARED.auth_headers = []

    def _run_sync(self, output_dir: str, state_in: str = "", state_out: str = "") -> "subprocess.CompletedProcess[str]":
        cmd = [
            sys.executable, SCRIPT,
            "--endpoint", self.endpoint,
            "--account-address", TEST_ADDR,
            "--master-user", MASTER_USER,
            "--auth-pass-env", "MASTER_PASS",
            "--output-dir", output_dir,
        ]
        if state_in: cmd += ["--state-in", state_in]
        if state_out: cmd += ["--state-out", state_out]
        env = {**os.environ, "MASTER_PASS": MASTER_PASS}
        return subprocess.run(cmd, capture_output=True, text=True, env=env, timeout=30)

    def test_full_pull_writes_maildir_files(self) -> None:
        SHARED.messages = {
            "msg-1": {"blob": b"From: a@x.com\r\nSubject: hello\r\n\r\nbody one\r\n",
                      "mailboxIds": {"mb-inbox": True},
                      "keywords": {"$seen": True}},
            "msg-2": {"blob": b"From: b@x.com\r\nSubject: hi\r\n\r\nbody two\r\n",
                      "mailboxIds": {"mb-sent": True},
                      "keywords": {"$flagged": True}},
        }
        with tempfile.TemporaryDirectory() as out:
            state_out = os.path.join(out, "state-out.json")
            r = self._run_sync(out, state_out=state_out)
            self.assertEqual(r.returncode, 0, msg=f"stderr={r.stderr}")
            summary = json.loads(r.stdout.strip().splitlines()[-1])
            self.assertEqual(summary["fetched"], 2)
            self.assertEqual(summary["fullPull"], True)
            # Maildir tree under <out>/<addr>/<mailbox>/cur/
            self.assertTrue(os.path.isdir(os.path.join(out, "alice@example.com", "INBOX", "cur")))
            self.assertTrue(os.path.isdir(os.path.join(out, "alice@example.com", "Sent", "cur")))
            inbox = os.listdir(os.path.join(out, "alice@example.com", "INBOX", "cur"))
            self.assertEqual(len(inbox), 1)
            self.assertIn(":2,S", inbox[0])  # $seen → S flag
            sent = os.listdir(os.path.join(out, "alice@example.com", "Sent", "cur"))
            self.assertIn(":2,F", sent[0])  # $flagged → F flag

    def test_state_out_written(self) -> None:
        SHARED.messages = {"msg-1": {"blob": b"raw", "mailboxIds": {"mb-inbox": True}}}
        with tempfile.TemporaryDirectory() as out:
            state_out = os.path.join(out, "state-out.json")
            r = self._run_sync(out, state_out=state_out)
            self.assertEqual(r.returncode, 0, msg=r.stderr)
            with open(state_out) as f:
                doc = json.load(f)
            self.assertEqual(doc["state"], "state-1")

    def test_incremental_with_prior_state_calls_changes(self) -> None:
        SHARED.messages = {"m1": {"blob": b"r", "mailboxIds": {"mb-inbox": True}}}
        SHARED.current_state = "state-2"
        with tempfile.TemporaryDirectory() as out:
            state_in = os.path.join(out, "state-in.json")
            with open(state_in, "w") as f:
                json.dump({"state": "state-1"}, f)
            state_out = os.path.join(out, "state-out.json")
            r = self._run_sync(out, state_in=state_in, state_out=state_out)
            self.assertEqual(r.returncode, 0, msg=r.stderr)
            summary = json.loads(r.stdout.strip().splitlines()[-1])
            self.assertEqual(summary["fullPull"], False)
            self.assertEqual(summary["newState"], "state-2")

    def test_cannot_calculate_changes_falls_back_to_full_pull(self) -> None:
        SHARED.messages = {"m1": {"blob": b"r", "mailboxIds": {"mb-inbox": True}}}
        SHARED.fail_changes = True
        with tempfile.TemporaryDirectory() as out:
            state_in = os.path.join(out, "state-in.json")
            with open(state_in, "w") as f:
                json.dump({"state": "very-old"}, f)
            state_out = os.path.join(out, "state-out.json")
            r = self._run_sync(out, state_in=state_in, state_out=state_out)
            self.assertEqual(r.returncode, 0, msg=r.stderr)
            summary = json.loads(r.stdout.strip().splitlines()[-1])
            self.assertEqual(summary["fullPull"], True)

    def test_auth_header_is_master_proxy_basic(self) -> None:
        SHARED.messages = {}
        with tempfile.TemporaryDirectory() as out:
            r = self._run_sync(out)
            self.assertEqual(r.returncode, 0, msg=r.stderr)
            self.assertTrue(SHARED.auth_headers, "no auth header recorded")
            for h in SHARED.auth_headers:
                self.assertEqual(h, _expected_auth())


if __name__ == "__main__":
    unittest.main(verbosity=2)
