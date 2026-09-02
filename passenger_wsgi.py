"""Dependency-free Telegram DNS TXT bot for Passenger WSGI."""
from __future__ import annotations

import base64
import hmac
import io
import json
import logging
import os
import re
import sys
import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, urlopen

LOGGER = logging.getLogger("tg_dns_bot")
MAX_BODY_BYTES = 256 * 1024
MANAGED_PREFIX = "tgdn1:"
TELEGRAM_LIMIT = 4096
FQDN_RE = re.compile(r"^(?=.{1,253}\.?$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?\.?$", re.I)

# Passenger can load this file through a helper-script path.  Pin relative
# configuration and state to the application root rather than the loader's cwd.
APP_DIR = Path(__file__).resolve().parent
os.chdir(APP_DIR)
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


class ConfigurationError(RuntimeError):
    pass


class BotError(RuntimeError):
    pass


@dataclass(frozen=True)
class Config:
    telegram_token: str
    webhook_secret: str
    cloudflare_token: str
    allowed_zones: tuple[tuple[str, str], ...]
    send_enabled: bool = True
    inbox_enabled: bool = True
    help_enabled: bool = True
    ttl_seconds: int = 60
    timeout_seconds: int = 15
    telegram_api_base: str = "https://api.telegram.org"
    cloudflare_api_base: str = "https://api.cloudflare.com/client/v4"
    doh_endpoint: str = "https://cloudflare-dns.com/dns-query"
    state_file: str = "/tmp/tg-dns-bot-updates.json"
    sender_capacity: int = 5
    mailbox_capacity: int = 3
    rate_window_seconds: int = 60

    @classmethod
    def from_environ(cls) -> "Config":
        load_env_file()
        def required(*names: str) -> str:
            for name in names:
                value = os.environ.get(name, "").strip()
                if value:
                    return value
            raise ConfigurationError(f"missing {names[0]}")
        try:
            raw_zones = json.loads(required("ALLOWED_ZONE_MAP"))
            zones = tuple((str(item[0]).lower().rstrip("."), str(item[1])) for item in raw_zones)
            ttl = int(os.environ.get("DNS_TTL_SECONDS", "60"))
        except (ValueError, TypeError, IndexError) as exc:
            raise ConfigurationError("invalid configuration") from exc
        return cls(
            telegram_token=required("TELEGRAM_BOT_TOKEN", "BOT_TOKEN"),
            webhook_secret=required("TELEGRAM_WEBHOOK_SECRET"),
            cloudflare_token=required("CLOUDFLARE_API_TOKEN", "WORKER_CLOUDFLARE_API_TOKEN"),
            allowed_zones=zones,
            send_enabled=_bool_env("SEND_ENABLED", True),
            inbox_enabled=_bool_env("INBOX_ENABLED", _bool_env("READ_ENABLED", True)),
            help_enabled=_bool_env("HELP_ENABLED", True),
            ttl_seconds=ttl,
            telegram_api_base=os.environ.get("TELEGRAM_API_BASE_URL", "https://api.telegram.org").rstrip("/"),
            cloudflare_api_base=os.environ.get("CLOUDFLARE_API_BASE_URL", "https://api.cloudflare.com/client/v4").rstrip("/"),
            doh_endpoint=os.environ.get("DOH_URL", "https://cloudflare-dns.com/dns-query"),
            state_file=os.environ.get("UPDATE_STATE_PATH", str(Path(__file__).with_name("runtime-state.json"))),
        )


def _bool_env(name: str, default: bool) -> bool:
    value = os.environ.get(name)
    if value is None:
        return default
    if value.lower() in {"true", "1", "yes"}:
        return True
    if value.lower() in {"false", "0", "no"}:
        return False
    raise ConfigurationError(f"invalid {name}")


def load_env_file(path: str | None = None) -> None:
    file_path = Path(path or Path(__file__).with_name("bot.env"))
    try:
        lines = file_path.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return
    for line in lines:
        stripped = line.strip()
        if stripped and not stripped.startswith("#") and "=" in stripped:
            key, value = stripped.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip())


def canonicalize_mailbox(value: str) -> str | None:
    candidate = value.strip().lower().rstrip(".")
    if re.fullmatch(r"\d{1,3}(?:\.\d{1,3}){3}", candidate):
        return None
    if "://" in candidate or "/" in candidate or "@" in candidate or not FQDN_RE.fullmatch(candidate):
        return None
    try:
        result = ".".join(label.encode("idna").decode("ascii") for label in candidate.split("."))
    except UnicodeError:
        return None
    return result if len(result) <= 253 else None


def resolve_writable_mailbox(value: str, zones: tuple[tuple[str, str], ...]) -> tuple[str, str] | None:
    mailbox = canonicalize_mailbox(value)
    if mailbox is None:
        return None
    matches = [(suffix, zone) for suffix, zone in zones if mailbox.endswith("." + suffix)]
    if not matches:
        return None
    return mailbox, max(matches, key=lambda item: len(item[0]))[1]


def encode_managed_message(envelope: dict[str, Any]) -> str:
    ordered = {key: envelope[key] for key in ("v", "id", "i", "n", "uid", "username", "ts", "text")}
    raw = json.dumps(ordered, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    return MANAGED_PREFIX + base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def decode_managed_message(wire: str) -> dict[str, Any] | None:
    if not wire.startswith(MANAGED_PREFIX):
        return None
    try:
        result = json.loads(base64.urlsafe_b64decode(wire[6:] + "=" * (-len(wire[6:]) % 4)).decode("utf-8"))
    except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    return result if isinstance(result, dict) and result.get("v") == 1 else None


def split_telegram_text(text: str) -> list[str]:
    if len(text) <= TELEGRAM_LIMIT:
        return [text]
    payload_limit = TELEGRAM_LIMIT - 16
    pieces = [text[index:index + payload_limit] for index in range(0, len(text), payload_limit)]
    while True:
        total = len(pieces)
        rendered = [f"[{index}/{total}]\n{piece}" for index, piece in enumerate(pieces, 1)]
        if all(len(item) <= TELEGRAM_LIMIT for item in rendered):
            return rendered
        payload_limit -= 8
        pieces = [text[index:index + payload_limit] for index in range(0, len(text), payload_limit)]


def parse_cloudflare_txt_content(content: Any) -> str:
    if isinstance(content, list):
        return "".join(str(item) for item in content)
    value = str(content)
    if not value.startswith('"'):
        return value
    try:
        return json.loads("[" + value.replace('" "', '","') + "]")[0] if '" "' not in value else "".join(json.loads("[" + value.replace('" "', '","') + "]"))
    except json.JSONDecodeError:
        return value.strip('"')


def _http_json(url: str, *, method: str = "GET", headers: dict[str, str] | None = None,
               payload: Any = None, timeout: int = 15) -> tuple[int, Any]:
    request_headers = {"accept": "application/json", **(headers or {})}
    data = None
    if payload is not None:
        data = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        request_headers["content-type"] = "application/json"
    try:
        with urlopen(Request(url, data=data, method=method, headers=request_headers), timeout=timeout) as response:
            return response.status, json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        try:
            return exc.code, json.loads(exc.read().decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return exc.code, {}
    except (URLError, TimeoutError, OSError) as exc:
        raise BotError("network request failed") from exc


def _telegram_send(config: Config, chat_id: int, text: str) -> list[int] | None:
    try:
        message_ids: list[int] = []
        for chunk in split_telegram_text(text):
            status, body = _http_json(
                f"{config.telegram_api_base}/bot{config.telegram_token}/sendMessage",
                method="POST", payload={"chat_id": chat_id, "text": chunk}, timeout=config.timeout_seconds,
            )
            if status != 200 or not isinstance(body, dict) or body.get("ok") is not True:
                raise BotError("telegram failed")
            result = body.get("result")
            if not isinstance(result, dict) or not isinstance(result.get("message_id"), int):
                raise BotError("telegram invalid response")
            message_ids.append(result["message_id"])
        return message_ids
    except BotError:
        LOGGER.error("telegram_delivery_failed", extra={"chat_id": chat_id})
        return None


def _new_wire(text: str, sender: dict[str, Any]) -> str:
    envelope = {
        "v": 1, "id": str(uuid.uuid4()), "i": 1, "n": 1,
        "uid": sender["id"], "username": sender.get("username"),
        "ts": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "text": text,
    }
    return encode_managed_message(envelope)


def _cloudflare_replace(config: Config, mailbox: str, zone_id: str, wire: str) -> None:
    headers = {"authorization": f"Bearer {config.cloudflare_token}"}
    query = urlencode({"type": "TXT", "name": mailbox, "per_page": "100"})
    status, body = _http_json(f"{config.cloudflare_api_base}/zones/{quote(zone_id)}/dns_records?{query}", headers=headers, timeout=config.timeout_seconds)
    if status != 200 or not isinstance(body, dict) or body.get("success") is not True:
        raise BotError("cloudflare lookup failed")
    records = body.get("result")
    if not isinstance(records, list):
        raise BotError("cloudflare invalid response")
    payload = {"type": "TXT", "name": mailbox, "content": wire, "ttl": config.ttl_seconds}
    if records:
        record_id = str(records[0]["id"])
        url = f"{config.cloudflare_api_base}/zones/{quote(zone_id)}/dns_records/{quote(record_id)}"
        method = "PUT"
    else:
        record_id = ""
        url = f"{config.cloudflare_api_base}/zones/{quote(zone_id)}/dns_records"
        method = "POST"
    status, result = _http_json(url, method=method, headers=headers, payload=payload, timeout=config.timeout_seconds)
    if status not in {200, 201} or not isinstance(result, dict) or result.get("success") is not True:
        raise BotError("cloudflare mutation failed")
    mutation = result.get("result")
    if not isinstance(mutation, dict):
        raise BotError("cloudflare invalid mutation response")
    mutation_id = str(mutation.get("id", ""))
    if not mutation_id:
        raise BotError("cloudflare invalid mutation response")
    if record_id and mutation_id != record_id:
        raise BotError("cloudflare mutation record mismatch")
    if (mutation.get("type") != "TXT" or canonicalize_mailbox(str(mutation.get("name", ""))) != mailbox or
            parse_cloudflare_txt_content(mutation.get("content", "")) != wire or mutation.get("ttl") != config.ttl_seconds):
        raise BotError("cloudflare mutation result mismatch")
    status, verify = _http_json(f"{config.cloudflare_api_base}/zones/{quote(zone_id)}/dns_records?{query}", headers=headers, timeout=config.timeout_seconds)
    if status != 200 or not isinstance(verify, dict) or verify.get("success") is not True:
        raise BotError("cloudflare verification failed")
    verified_records = verify.get("result")
    if not isinstance(verified_records, list):
        raise BotError("cloudflare invalid verification response")
    matches = [
        record for record in verified_records
        if isinstance(record, dict)
        and str(record.get("id", "")) == mutation_id
        and record.get("type") == "TXT"
        and canonicalize_mailbox(str(record.get("name", ""))) == mailbox
        and parse_cloudflare_txt_content(record.get("content", "")) == wire
        and record.get("ttl") == config.ttl_seconds
    ]
    if len(matches) != 1:
        raise BotError("cloudflare verification mismatch")


def _decode_txt(value: str) -> str:
    if value.startswith('"'):
        try:
            return "".join(json.loads("[" + value.replace('" "', '","') + "]"))
        except json.JSONDecodeError:
            return value.strip('"')
    return value


def _resolve_txt(config: Config, mailbox: str) -> tuple[str, list[str]]:
    query = urlencode({"name": mailbox, "type": "TXT"})
    status, body = _http_json(f"{config.doh_endpoint}?{query}", headers={"accept": "application/dns-json"}, timeout=config.timeout_seconds)
    if status != 200 or not isinstance(body, dict) or not isinstance(body.get("Status"), int):
        return "invalid", []
    if body["Status"] == 3:
        return "missing", []
    if body["Status"] != 0:
        return "invalid", []
    answers = body.get("Answer", [])
    if not isinstance(answers, list):
        return "invalid", []
    return "ok", [_decode_txt(str(item["data"])) for item in answers if isinstance(item, dict) and item.get("type") == 16 and "data" in item]


def _help(config: Config) -> str:
    zones = "\n".join(suffix for suffix, _ in config.allowed_zones)
    return ("این بات برای هر صندوق عمومی فقط آخرین پیام را نگه میدارد.\n\n"
            "/send box.example.com متن پیام\n\n/inbox box.example.com\n\n"
            f"دامنههای مجاز نوشتن:\n{zones}\n\n"
            "رکوردها عمومی هستند و برای دادهٔ محرمانه مناسب نیستند.\n\n"
            f"زمان حافظهٔ نهان برحسب ثانیه:\n{config.ttl_seconds}")


def _inbox(mailbox: str, values: list[str]) -> str:
    if not values:
        return "رکورد متنی برای این نام وجود ندارد."
    managed = [item for item in (decode_managed_message(value) for value in values) if item]
    lines = [f"صندوق: {mailbox}"]
    if managed:
        item = max(managed, key=lambda value: str(value.get("ts", "")))
        try:
            utc = datetime.fromisoformat(str(item["ts"]).replace("Z", "+00:00"))
            iran = utc.astimezone(timezone(timedelta(hours=3, minutes=30))).isoformat(timespec="seconds")
        except (ValueError, TypeError):
            iran = str(item.get("ts", ""))
        lines.extend(["", "پیام:", str(item.get("text", "")), "", f"شناسه فرستنده: {item.get('uid')}", f"نام کاربری: {item.get('username') or 'ندارد'}", f"زمان ایران: {iran}"])
    raw = [value for value in values if decode_managed_message(value) is None]
    if raw:
        lines.extend(["", "رکوردهای خام:", *raw])
    return "\n".join(lines)


def _load_state(path: str) -> dict[str, Any]:
    try:
        data = json.loads(Path(path).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return {}


def _save_state(path: str, state: dict[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(json.dumps(state, separators=(",", ":")), encoding="utf-8")
    temporary.replace(target)


def _process(config: Config, update: Any) -> tuple[bool, list[int]]:
    if not isinstance(update, dict) or not isinstance(update.get("update_id"), int):
        raise ValueError("invalid update")
    state = _load_state(config.state_file)
    processed = state.get("processed_update_ids", [])
    if update["update_id"] in processed:
        return True, []
    message = update.get("message")
    if not isinstance(message, dict) or not isinstance(message.get("text"), str):
        return False, []
    chat, sender = message.get("chat"), message.get("from")
    if not isinstance(chat, dict) or not isinstance(chat.get("id"), int) or not isinstance(sender, dict) or not isinstance(sender.get("id"), int):
        return False, []
    command, _, arguments = message["text"].strip().partition(" ")
    command = command.split("@", 1)[0].lower()
    response: str | None = None
    if command in {"/help", "/start"}:
        response = _help(config) if config.help_enabled else "راهنما اکنون غیرفعال است."
    elif command == "/send":
        if not config.send_enabled:
            response = "ارسال پیام اکنون غیرفعال است."
        else:
            raw_name, separator, text = arguments.strip().partition(" ")
            writable = resolve_writable_mailbox(raw_name, config.allowed_zones)
            if not separator or not text.strip() or writable is None:
                response = "نام صندوق یا متن پیام نامعتبر است."
            else:
                try:
                    _cloudflare_replace(config, writable[0], writable[1], _new_wire(text.strip(), sender))
                    response = f"پیام با موفقیت در {writable[0]} ثبت شد. ممکن است حافظهٔ نهان تا {config.ttl_seconds} ثانیه مقدار قبلی را نشان دهد."
                except BotError:
                    LOGGER.error("cloudflare_operation_failed", extra={"update_id": update["update_id"]})
                    response = "ارتباط با کلودفلر ناموفق بود. لطفاً دوباره تلاش کنید."
    elif command == "/inbox":
        if not config.inbox_enabled:
            response = "خواندن صندوق اکنون غیرفعال است."
        else:
            mailbox = canonicalize_mailbox(arguments)
            if mailbox is None:
                response = "نام صندوق نامعتبر است."
            else:
                status, values = _resolve_txt(config, mailbox)
                response = "رکورد این نام وجود ندارد." if status == "missing" else ("پاسخ دامنه نامعتبر است." if status == "invalid" else _inbox(mailbox, values))
    telegram_message_ids = _telegram_send(config, chat["id"], response) if response is not None else []
    processed = (processed + [update["update_id"]])[-1000:]
    state["processed_update_ids"] = processed
    _save_state(config.state_file, state)
    return False, telegram_message_ids or []


def _json_response(start_response: Callable, status: str, payload: dict[str, Any]) -> list[bytes]:
    body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
    start_response(status, [("Content-Type", "application/json"), ("Content-Length", str(len(body)))])
    return [body]


def create_application(config: Config) -> Callable:
    def app(environ: dict[str, Any], start_response: Callable) -> Iterable[bytes]:
        path = environ.get("PATH_INFO", "")
        method = str(environ.get("REQUEST_METHOD", "GET")).upper()
        if path == "/health" and method == "GET":
            return _json_response(start_response, "200 OK", {"ok": True})
        if path != "/webhook" or method != "POST":
            return _json_response(start_response, "404 Not Found", {"error": "not_found"})
        if not hmac.compare_digest(str(environ.get("HTTP_X_TELEGRAM_BOT_API_SECRET_TOKEN", "")), config.webhook_secret):
            return _json_response(start_response, "401 Unauthorized", {"error": "unauthorized"})
        if str(environ.get("CONTENT_TYPE", "")).split(";", 1)[0].lower() != "application/json":
            return _json_response(start_response, "415 Unsupported Media Type", {"error": "unsupported_media_type"})
        try:
            length = int(environ.get("CONTENT_LENGTH", "0") or "0")
        except ValueError:
            return _json_response(start_response, "400 Bad Request", {"error": "invalid_payload"})
        if length < 0 or length > MAX_BODY_BYTES:
            return _json_response(start_response, "413 Payload Too Large", {"error": "payload_too_large"})
        try:
            raw = environ.get("wsgi.input", io.BytesIO()).read(length)
            update = json.loads(raw.decode("utf-8"))
            duplicate, telegram_message_ids = _process(config, update)
            return _json_response(start_response, "200 OK", {
                "ok": True,
                **({"duplicate": True} if duplicate else {}),
                **({"telegram_message_ids": telegram_message_ids} if telegram_message_ids else {}),
            })
        except (ValueError, UnicodeDecodeError, json.JSONDecodeError):
            return _json_response(start_response, "400 Bad Request", {"error": "invalid_payload"})
        except Exception:
            LOGGER.exception("webhook_handling_failed")
            return _json_response(start_response, "500 Internal Server Error", {"error": "update_failed"})
    return app


try:
    application = create_application(Config.from_environ())
except ConfigurationError:
    def application(environ: dict[str, Any], start_response: Callable) -> Iterable[bytes]:
        if environ.get("PATH_INFO") == "/health":
            return _json_response(start_response, "503 Service Unavailable", {"ok": False})
        return _json_response(start_response, "503 Service Unavailable", {"error": "misconfigured"})
