#!/usr/bin/env python3
import base64
import json
import os
import re
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import quote, urlparse

API_BASE = "https://api.cloudflare.com/client/v4"
PROXY = "socks5h://127.0.0.1:2080"
MAX_BODY_BYTES = 64 * 1024
MAX_TEXT_CODEPOINTS = 2_000
MAILBOX_PATTERN = re.compile(
    r"^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+"
    r"[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$"
)
TOKEN_PATTERN = re.compile(r"^\S{20,512}$")
SHARED_SECRET_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,256}$")


def required_env(name: str, pattern: re.Pattern[str] | None = None) -> str:
    value = os.environ.get(name, "")
    if not value or (pattern is not None and pattern.fullmatch(value) is None):
        raise RuntimeError(f"invalid environment: {name}")
    return value


SHARED_SECRET = required_env("WRITER_SHARED_SECRET", SHARED_SECRET_PATTERN)
CLOUDFLARE_TOKEN = required_env("CLOUDFLARE_API_TOKEN", TOKEN_PATTERN)
ZONE_ID = required_env("CLOUDFLARE_ZONE_ID", re.compile(r"^[A-Za-z0-9_-]{20,64}$"))
ALLOWED_SUFFIX = required_env("ALLOWED_SUFFIX").lower().rstrip(".")
if MAILBOX_PATTERN.fullmatch(ALLOWED_SUFFIX) is None:
    raise RuntimeError("invalid environment: ALLOWED_SUFFIX")


def canonical_mailbox(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    name = value.strip().lower().rstrip(".")
    if MAILBOX_PATTERN.fullmatch(name) is None:
        return None
    return name


def writable_mailbox(value: object) -> str | None:
    name = canonical_mailbox(value)
    if name is None or not name.endswith("." + ALLOWED_SUFFIX):
        return None
    return name


def encode_wire(sender_id: int, username: str | None, text: str) -> str:
    envelope = {
        "v": 1,
        "id": str(uuid.uuid4()),
        "i": 1,
        "n": 1,
        "uid": sender_id,
        "username": username,
        "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "text": text,
    }
    canonical = json.dumps(envelope, ensure_ascii=False, separators=(",", ":"))
    return "tgdn1:" + base64.urlsafe_b64encode(canonical.encode()).decode().rstrip("=")


def run_curl(method: str, path: str, body: object | None = None) -> dict:
    command = [
        "curl", "--silent", "--show-error", "--fail-with-body", "--max-time", "20",
        "--proxy", PROXY, "--request", method,
        "--header", f"Authorization: Bearer {CLOUDFLARE_TOKEN}",
        "--header", "Accept: application/json",
    ]
    if body is not None:
        command += ["--header", "Content-Type: application/json", "--data-binary", "@-"]
    command.append(API_BASE + path)
    completed = subprocess.run(
        command,
        input=None if body is None else json.dumps(body, ensure_ascii=False, separators=(",", ":")),
        capture_output=True,
        text=True,
        timeout=25,
    )
    if completed.returncode != 0:
        raise RuntimeError("provider request failed")
    try:
        payload = json.loads(completed.stdout)
    except json.JSONDecodeError as error:
        raise RuntimeError("provider response invalid") from error
    if not isinstance(payload, dict) or payload.get("success") is not True:
        raise RuntimeError("provider rejected request")
    return payload


def list_records(name: str) -> list[dict]:
    path = (
        f"/zones/{quote(ZONE_ID, safe='')}/dns_records"
        f"?type=TXT&name.exact={quote(name, safe='')}&page=1&per_page=100"
    )
    payload = run_curl("GET", path)
    result = payload.get("result")
    if not isinstance(result, list):
        raise RuntimeError("provider response invalid")
    records = []
    for record in result:
        if not isinstance(record, dict) or not isinstance(record.get("id"), str):
            raise RuntimeError("provider response invalid")
        records.append(record)
    return records


def publish(name: str, wire: str) -> None:
    if len(wire.encode()) > 4096:
        raise ValueError("message too large")
    records = list_records(name)
    body = {"type": "TXT", "name": name, "content": wire, "ttl": 60}
    base = f"/zones/{quote(ZONE_ID, safe='')}/dns_records"
    if len(records) == 0:
        payload = run_curl("POST", base, body)
    elif len(records) == 1:
        payload = run_curl("PUT", f"{base}/{quote(records[0]['id'], safe='')}", body)
    else:
        raise RuntimeError("ambiguous existing records")
    result = payload.get("result")
    if not isinstance(result, dict) or result.get("type") != "TXT":
        raise RuntimeError("provider response invalid")


class Handler(BaseHTTPRequestHandler):
    server_version = "tg-dns-writer/1"

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write("writer_request " + (fmt % args) + "\n")

    def respond(self, status: int, body: object) -> None:
        encoded = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json; charset=utf-8")
        self.send_header("content-length", str(len(encoded)))
        self.send_header("cache-control", "no-store")
        self.end_headers()
        self.wfile.write(encoded)

    def do_GET(self) -> None:
        if urlparse(self.path).path == "/health":
            self.respond(200, {"ok": True})
        else:
            self.respond(404, {"error": "not_found"})

    def do_POST(self) -> None:
        if urlparse(self.path).path != "/publish":
            self.respond(404, {"error": "not_found"})
            return
        if self.headers.get("authorization") != "Bearer " + SHARED_SECRET:
            self.respond(401, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("content-length", "0"))
        except ValueError:
            self.respond(400, {"error": "invalid_request"})
            return
        if length < 1 or length > MAX_BODY_BYTES:
            self.respond(413, {"error": "payload_too_large"})
            return
        try:
            payload = json.loads(self.rfile.read(length))
            if not isinstance(payload, dict):
                raise ValueError("invalid request")
            name = writable_mailbox(payload.get("mailbox"))
            sender_id = payload.get("senderId")
            username = payload.get("senderUsername")
            text = payload.get("text")
            if (
                name is None or not isinstance(sender_id, int) or isinstance(sender_id, bool) or sender_id < 1
                or (username is not None and not isinstance(username, str))
                or not isinstance(text, str) or len(text) == 0 or len(text) > MAX_TEXT_CODEPOINTS
            ):
                raise ValueError("invalid request")
            publish(name, encode_wire(sender_id, username, text))
            self.respond(200, {"status": "published"})
        except ValueError:
            self.respond(400, {"error": "invalid_request"})
        except Exception:
            self.respond(502, {"error": "publication_failed"})


def main() -> None:
    port = int(os.environ.get("PORT", "8787"))
    server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
