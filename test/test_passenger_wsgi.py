import base64
import io
import json
import os
import tempfile
import threading
import unittest
from contextlib import contextmanager
from dataclasses import replace
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlparse

import passenger_wsgi as bot


class _Server(ThreadingHTTPServer):
    def __init__(self, responses):
        super().__init__(("127.0.0.1", 0), _Handler)
        self.responses = list(responses)
        self.requests = []


class _Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self._handle()

    def do_POST(self):
        self._handle()

    def do_PUT(self):
        self._handle()

    def _handle(self):
        length = int(self.headers.get("content-length", "0"))
        body = self.rfile.read(length)
        self.server.requests.append(
            {"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body}
        )
        status, headers, payload = self.server.responses.pop(0)
        encoded = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
        self.send_response(status)
        for name, value in headers.items():
            self.send_header(name, value)
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, _format, *_args):
        pass


@contextmanager
def server(responses):
    instance = _Server(responses)
    thread = threading.Thread(target=instance.serve_forever, daemon=True)
    thread.start()
    try:
        yield instance
    finally:
        instance.shutdown()
        instance.server_close()
        thread.join()


def json_response(payload, status=200, content_type="application/json"):
    return status, {"content-type": content_type}, payload


def cloudflare_list(records):
    return {
        "success": True,
        "result": records,
        "result_info": {
            "page": 1,
            "per_page": 100,
            "count": len(records),
            "total_count": len(records),
            "total_pages": 1,
        },
    }


def doh_payload(name, records=None, status=0):
    payload = {"Status": status, "Question": [{"name": name + ".", "type": 16}]}
    if records is not None:
        payload["Answer"] = [
            {"name": name + ".", "type": 16, "TTL": 60, "data": json.dumps(value)}
            for value in records
        ]
    return payload


class PassengerApplicationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.state_path = str(Path(self.temp.name) / "updates.json")

    def config(self, telegram_url, cloudflare_url="https://api.cloudflare.test", doh_url="https://dns.test/query", **overrides):
        values = dict(
            telegram_token="123:test-token",
            webhook_secret="webhook-secret",
            cloudflare_token="cloudflare-secret",
            allowed_zones=(("salam.ifrom.ir", "zone-1"),),
            send_enabled=True,
            inbox_enabled=True,
            help_enabled=True,
            ttl_seconds=60,
            timeout_seconds=2,
            telegram_api_base=telegram_url,
            cloudflare_api_base=cloudflare_url,
            doh_endpoint=doh_url,
            state_file=self.state_path,
            sender_capacity=5,
            mailbox_capacity=3,
            rate_window_seconds=60,
        )
        values.update(overrides)
        return bot.Config(**values)

    def call(self, app, path="/webhook", method="POST", payload=None, secret="webhook-secret", stream=None):
        raw = b"" if payload is None else json.dumps(payload, ensure_ascii=False).encode()
        environ = {
            "REQUEST_METHOD": method,
            "PATH_INFO": path,
            "CONTENT_LENGTH": str(len(raw)),
            "CONTENT_TYPE": "application/json",
            "HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN": secret,
            "wsgi.input": stream if stream is not None else io.BytesIO(raw),
        }
        result = {}

        def start_response(status, headers):
            result["status"] = int(status.split()[0])
            result["headers"] = dict(headers)

        body = b"".join(app(environ, start_response))
        result["json"] = json.loads(body)
        return result

    @staticmethod
    def update(update_id, text, chat_id=42, sender_id=7, username="saeb"):
        return {
            "update_id": update_id,
            "message": {
                "message_id": update_id,
                "chat": {"id": chat_id},
                "from": {"id": sender_id, "username": username},
                "text": text,
            },
        }

    def test_health_is_controlled_and_does_not_require_network(self):
        app = bot.create_application(self.config("http://127.0.0.1:1"))
        response = self.call(app, path="/health", method="GET")
        self.assertEqual(200, response["status"])
        self.assertEqual({"ok": True}, response["json"])

    def test_webhook_rejects_bad_secret_before_reading_body(self):
        class ExplodingBody:
            def read(self, _size=-1):
                raise AssertionError("body must not be read")

        app = bot.create_application(self.config("http://127.0.0.1:1"))
        response = self.call(app, secret="wrong", stream=ExplodingBody())
        self.assertEqual(401, response["status"])
        self.assertEqual({"error": "unauthorized"}, response["json"])

    def test_help_and_start_send_explicit_help_with_zone_and_ttl(self):
        responses = [json_response({"ok": True, "result": {"message_id": 1}})] * 2
        with server(responses) as telegram:
            app = bot.create_application(self.config(f"http://127.0.0.1:{telegram.server_port}"))
            for update_id, command in ((1, "/help"), (2, "/start")):
                response = self.call(app, payload=self.update(update_id, command))
                self.assertEqual(200, response["status"])
            self.assertEqual(2, len(telegram.requests))
            sent = json.loads(telegram.requests[0]["body"])
            self.assertEqual(42, sent["chat_id"])
            self.assertIn("salam.ifrom.ir", sent["text"])
            self.assertIn("60", sent["text"])
            self.assertIn("عمومی", sent["text"])

    def test_valid_send_atomically_replaces_record_and_reports_success(self):
        existing = {"id": "record-1", "type": "TXT", "name": "hello.salam.ifrom.ir", "content": '"old"', "ttl": 60}
        cf_responses = [
            json_response(cloudflare_list([existing])),
            json_response({"success": True, "result": {"id": "record-1", "type": "TXT", "name": "hello.salam.ifrom.ir", "content": None, "ttl": 60}}),
            _EchoCloudflareReadback(json_response({})),
        ]
        with server(cf_responses) as cloudflare, server([
            json_response({"ok": True, "result": {"message_id": 9}})
        ]) as telegram:
            # The mock must echo the exact submitted content in the mutation result.
            original = cloudflare.responses[1]
            cloudflare.responses[1] = _EchoCloudflareMutation(original)
            app = bot.create_application(self.config(
                f"http://127.0.0.1:{telegram.server_port}",
                cloudflare_url=f"http://127.0.0.1:{cloudflare.server_port}",
            ))
            response = self.call(app, payload=self.update(3, "/send HELLO.SALAM.IFROM.IR. سلام 👋"))
            self.assertEqual(200, response["status"])
            self.assertEqual(["GET", "PUT", "GET"], [request["method"] for request in cloudflare.requests])
            mutation = json.loads(cloudflare.requests[1]["body"])
            self.assertEqual("TXT", mutation["type"])
            self.assertEqual("hello.salam.ifrom.ir", mutation["name"])
            self.assertEqual(60, mutation["ttl"])
            wire = bot.parse_cloudflare_txt_content(mutation["content"])
            envelope = bot.decode_managed_message(wire)
            self.assertEqual("سلام 👋", envelope["text"])
            self.assertEqual(7, envelope["uid"])
            self.assertEqual("saeb", envelope["username"])
            sent = json.loads(telegram.requests[0]["body"])["text"]
            self.assertIn("hello.salam.ifrom.ir", sent)
            self.assertIn("موفق", sent)
            self.assertIn("حافظه", sent)

    def test_invalid_send_name_and_disabled_feature_have_no_cloudflare_effect(self):
        with server([]) as cloudflare, server([
            json_response({"ok": True, "result": {}}),
            json_response({"ok": True, "result": {}}),
        ]) as telegram:
            config = self.config(
                f"http://127.0.0.1:{telegram.server_port}",
                cloudflare_url=f"http://127.0.0.1:{cloudflare.server_port}",
            )
            app = bot.create_application(config)
            first = self.call(app, payload=self.update(10, "/send https://hello.salam.ifrom.ir no"))
            second_app = bot.create_application(replace(config, send_enabled=False, state_file=self.state_path + ".disabled"))
            second = self.call(second_app, payload=self.update(11, "/send hello.salam.ifrom.ir no"))
            self.assertEqual(200, first["status"])
            self.assertEqual(200, second["status"])
            self.assertEqual([], cloudflare.requests)
            texts = [json.loads(request["body"])["text"] for request in telegram.requests]
            self.assertIn("نامعتبر", texts[0])
            self.assertIn("غیرفعال", texts[1])

    def test_cloudflare_failure_gets_operational_reply_without_failing_webhook(self):
        with server([json_response({"success": False, "errors": [{"message": "secret leak"}]}, status=403)]) as cloudflare, server([
            json_response({"ok": True, "result": {}})
        ]) as telegram:
            app = bot.create_application(self.config(
                f"http://127.0.0.1:{telegram.server_port}",
                cloudflare_url=f"http://127.0.0.1:{cloudflare.server_port}",
            ))
            response = self.call(app, payload=self.update(12, "/send hello.salam.ifrom.ir text-secret"))
            self.assertEqual(200, response["status"])
            sent = json.loads(telegram.requests[0]["body"])["text"]
            self.assertIn("کلودفلر", sent)
            self.assertNotIn("secret leak", sent)
            self.assertNotIn("cloudflare-secret", sent)
            self.assertNotIn("text-secret", sent)

    def test_send_does_not_report_success_when_cloudflare_readback_lacks_the_written_record(self):
        with server([
            json_response(cloudflare_list([])),
            _EchoCloudflareMutation(json_response({})),
            json_response(cloudflare_list([])),
        ]) as cloudflare, server([
            json_response({"ok": True, "result": {}})
        ]) as telegram:
            app = bot.create_application(self.config(
                f"http://127.0.0.1:{telegram.server_port}",
                cloudflare_url=f"http://127.0.0.1:{cloudflare.server_port}",
            ))
            response = self.call(
                app,
                payload=self.update(13, "/send verify.salam.ifrom.ir must-not-report-success"),
            )
            self.assertEqual(200, response["status"])
            sent = json.loads(telegram.requests[0]["body"])["text"]
            self.assertIn("کلودفلر", sent)
            self.assertNotIn("موفقیت", sent)
            self.assertNotIn("با موفقیت", sent)

    def test_inbox_reconstructs_managed_record_and_also_shows_raw_records(self):
        wire = bot.encode_managed_message({
            "v": 1,
            "id": "123e4567-e89b-42d3-a456-426614174000",
            "i": 1,
            "n": 1,
            "uid": 7,
            "username": "saeb",
            "ts": "2026-09-01T08:00:00.000Z",
            "text": "متن صندوق 👋",
        })
        name = "public.example.com"
        with server([json_response(doh_payload(name, [wire, "raw value"]), content_type="application/dns-json")]) as doh, server([
            json_response({"ok": True, "result": {}})
        ]) as telegram:
            app = bot.create_application(self.config(
                f"http://127.0.0.1:{telegram.server_port}",
                doh_url=f"http://127.0.0.1:{doh.server_port}/query",
            ))
            response = self.call(app, payload=self.update(20, "/inbox public.example.com"))
            self.assertEqual(200, response["status"])
            request_query = parse_qs(urlparse(doh.requests[0]["path"]).query)
            self.assertEqual([name], request_query["name"])
            sent = json.loads(telegram.requests[0]["body"])["text"]
            self.assertIn("متن صندوق 👋", sent)
            self.assertIn("شناسه فرستنده", sent)
            self.assertIn("7", sent)
            self.assertIn("saeb", sent)
            self.assertIn("زمان ایران", sent)
            self.assertIn("raw value", sent)

    def test_inbox_distinguishes_missing_record_and_invalid_dns_response(self):
        name1 = "missing.example.com"
        name2 = "broken.example.com"
        responses = [
            json_response(doh_payload(name1, None, status=3), content_type="application/dns-json"),
            json_response({"Status": "bad"}, content_type="application/dns-json"),
        ]
        with server(responses) as doh, server([
            json_response({"ok": True, "result": {}}),
            json_response({"ok": True, "result": {}}),
        ]) as telegram:
            app = bot.create_application(self.config(
                f"http://127.0.0.1:{telegram.server_port}",
                doh_url=f"http://127.0.0.1:{doh.server_port}/query",
            ))
            self.call(app, payload=self.update(21, f"/inbox {name1}"))
            self.call(app, payload=self.update(22, f"/inbox {name2}"))
            texts = [json.loads(request["body"])["text"] for request in telegram.requests]
            self.assertIn("وجود ندارد", texts[0])
            self.assertIn("نامعتبر", texts[1])

    def test_duplicate_update_is_acknowledged_without_second_side_effect(self):
        with server([json_response({"ok": True, "result": {}})]) as telegram:
            app = bot.create_application(self.config(f"http://127.0.0.1:{telegram.server_port}"))
            update = self.update(30, "/help")
            first = self.call(app, payload=update)
            second = self.call(app, payload=update)
            self.assertEqual(200, first["status"])
            self.assertEqual(200, second["status"])
            self.assertTrue(second["json"]["duplicate"])
            self.assertEqual(1, len(telegram.requests))
            persisted = json.loads(Path(self.state_path).read_text())
            self.assertIn(30, persisted["processed_update_ids"])

    def test_telegram_delivery_failure_is_logged_safely_and_webhook_still_succeeds(self):
        with server([json_response({"ok": False, "description": "message secret"}, status=500)]) as telegram:
            app = bot.create_application(self.config(f"http://127.0.0.1:{telegram.server_port}"))
            with self.assertLogs("tg_dns_bot", level="ERROR") as logs:
                response = self.call(app, payload=self.update(40, "/help"))
            self.assertEqual(200, response["status"])
            joined = "\n".join(logs.output)
            self.assertIn("telegram_delivery_failed", joined)
            self.assertNotIn("message secret", joined)
            self.assertNotIn("test-token", joined)
            self.assertNotIn("webhook-secret", joined)


class ContractsTests(unittest.TestCase):
    def test_managed_codec_is_canonical_and_round_trips_unicode(self):
        envelope = {
            "v": 1,
            "id": "123e4567-e89b-42d3-a456-426614174000",
            "i": 1,
            "n": 1,
            "uid": 1234567890123,
            "username": None,
            "ts": "2026-09-01T08:00:00.000Z",
            "text": 'فارسی 👋 "quote" \\ slash',
        }
        wire = bot.encode_managed_message(envelope)
        self.assertTrue(wire.startswith("tgdn1:"))
        self.assertNotIn("=", wire)
        self.assertEqual(envelope, bot.decode_managed_message(wire))
        decoded_json = base64.urlsafe_b64decode(wire[6:] + "==").decode()
        self.assertEqual(
            ['v', 'id', 'i', 'n', 'uid', 'username', 'ts', 'text'],
            list(json.loads(decoded_json).keys()),
        )

    def test_mailbox_canonicalization_rejects_urls_addresses_and_suffix_tricks(self):
        self.assertEqual("hello.salam.ifrom.ir", bot.canonicalize_mailbox("HELLO.SALAM.IFROM.IR."))
        for invalid in (
            "https://hello.salam.ifrom.ir",
            "127.0.0.1",
            "hello.salam.ifrom.ir/path",
            "-bad.salam.ifrom.ir",
        ):
            self.assertIsNone(bot.canonicalize_mailbox(invalid), invalid)
        zones = (("salam.ifrom.ir", "zone"),)
        self.assertEqual(("hello.salam.ifrom.ir", "zone"), bot.resolve_writable_mailbox("hello.salam.ifrom.ir", zones))
        self.assertIsNone(bot.resolve_writable_mailbox("evilsalam.ifrom.ir", zones))
        self.assertIsNone(bot.resolve_writable_mailbox("salam.ifrom.ir", zones))

    def test_invalid_feature_configuration_stops_safely(self):
        environment = {
            "TELEGRAM_BOT_TOKEN": "token",
            "TELEGRAM_WEBHOOK_SECRET": "secret",
            "SEND_ENABLED": "sometimes",
            "INBOX_ENABLED": "true",
            "HELP_ENABLED": "true",
        }
        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaises(bot.ConfigurationError):
                bot.Config.from_environ()

    def test_long_telegram_text_is_numbered_and_never_exceeds_limit(self):
        text = "👋" * 5000
        chunks = bot.split_telegram_text(text)
        self.assertGreater(len(chunks), 1)
        self.assertTrue(chunks[0].startswith("[1/"))
        self.assertTrue(chunks[-1].startswith(f"[{len(chunks)}/{len(chunks)}]"))
        self.assertTrue(all(len(chunk) <= 4096 for chunk in chunks))
        reconstructed = "".join(chunk.split("\n", 1)[1] for chunk in chunks)
        self.assertEqual(text, reconstructed)


class _EchoCloudflareMutation:
    """Response factory consumed by the test server after seeing a mutation."""

    def __init__(self, fallback):
        self.fallback = fallback

    def __iter__(self):
        return iter(self.fallback)


class _EchoCloudflareReadback:
    """Response factory returning the preceding mutation as provider state."""

    def __init__(self, fallback):
        self.fallback = fallback

    def __iter__(self):
        return iter(self.fallback)


# Teach the tiny test server to resolve response factories only where needed.
_original_handle = _Handler._handle


def _factory_handle(self):
    length = int(self.headers.get("content-length", "0"))
    body = self.rfile.read(length)
    request = {"method": self.command, "path": self.path, "headers": dict(self.headers), "body": body}
    self.server.requests.append(request)
    response = self.server.responses.pop(0)
    if isinstance(response, _EchoCloudflareMutation):
        submitted = json.loads(body)
        payload = {"success": True, "result": {"id": "record-1", **submitted}}
        status, headers = 200, {"content-type": "application/json"}
    elif isinstance(response, _EchoCloudflareReadback):
        submitted = json.loads(self.server.requests[-2]["body"])
        payload = cloudflare_list([{"id": "record-1", **submitted}])
        status, headers = 200, {"content-type": "application/json"}
    else:
        status, headers, payload = response
    encoded = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
    self.send_response(status)
    for name, value in headers.items():
        self.send_header(name, value)
    self.send_header("content-length", str(len(encoded)))
    self.end_headers()
    self.wfile.write(encoded)


_Handler._handle = _factory_handle


if __name__ == "__main__":
    unittest.main()
