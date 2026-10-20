"""Python 侧结构化日志 + 脱敏（与 Node 侧 scripts/lib/log.mjs 规则一致）。"""
from __future__ import annotations

import json
import re
import sys
import threading
import time

SECRET_KEY_RE = re.compile(r"(token|secret|password|passphrase|apikey|api_key|authorization|credential|decryptkey)", re.I)
CHAT_KEYS = {"content", "text", "msg", "message", "reply", "body", "quote", "forwardedrecord", "summary"}
HEX_64_RE = re.compile(r"\b[0-9a-fA-F]{64}\b")

_LEVELS = {"debug": 10, "info": 20, "warn": 30, "error": 40}
_lock = threading.Lock()
_context = {"file": None, "level": "info", "include_chat": False}


def configure(file=None, level: str = "info", include_chat: bool = False) -> None:
    """配置日志文件与级别。"""
    with _lock:
        _context["file"] = file
        _context["level"] = level if level in _LEVELS else "info"
        _context["include_chat"] = bool(include_chat)


def redact(value, key: str = "", include_chat: bool = False):
    """按字段名/内容做脱敏。"""
    if isinstance(value, str):
        if SECRET_KEY_RE.search(key):
            return "[已隐藏]"
        if not include_chat and key.lower() in CHAT_KEYS:
            return "[聊天内容已隐藏]"
        return HEX_64_RE.sub("[64hex已隐藏]", value)
    if isinstance(value, list):
        return [redact(item, key, include_chat) for item in value]
    if isinstance(value, dict):
        return {child: redact(item, child, include_chat) for child, item in value.items()}
    return value


def log(event: str, level: str = "info", **fields) -> None:
    """输出一行 JSON 日志；文件写入追加，控制台写 stderr 以免污染 JSON 接口输出。"""
    with _lock:
        threshold = _LEVELS.get(_context["level"], 20)
        if _LEVELS.get(level, 20) < threshold:
            return
        record = {"time": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "level": level, "event": event}
        record.update(redact(fields, include_chat=_context["include_chat"]))
        line = json.dumps(record, ensure_ascii=False)
        print(line, file=sys.stderr, flush=True)
        path = _context["file"]
    if path:
        try:
            import pathlib

            pathlib.Path(path).parent.mkdir(parents=True, exist_ok=True)
            with open(path, "a", encoding="utf-8") as handle:
                handle.write(line + "\n")
        except OSError:
            pass
