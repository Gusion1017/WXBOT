#!/usr/bin/env python
"""WXBOT 读取层 HTTP 服务（M1/M2）。

对外契约（手册 §5.8，详见 docs/READER_API.md）：
    GET  /api/v1/reader/status      读取层状态（不含聊天正文）
    GET  /api/v1/sessions?limit=    会话列表
    GET  /api/v1/contacts?keyword=&kind=  联系人/群
    GET  /api/v1/messages?talker=&limit=  历史消息
    GET  /api/v1/push/messages      SSE 增量推送（M2）
    POST /api/v1/events/retry       显式重试某条事件（M2）
错误统一 {success:false, error:"CODE"}；越权 403、未就绪 503、未授权 401。

用法：
    python scripts/reader-api.py            # 按 config/app.json 的 ports.reader 启动
    python scripts/reader-api.py --check    # 初始化自检（不监听端口）
    python scripts/reader-api.py --port 5031
"""
from __future__ import annotations

import hmac
import json
import os
import queue
import re
import signal
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlsplit

import pathlib

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from lib.reader import log as log_lib  # noqa: E402
from lib.reader import paths as paths_lib  # noqa: E402
from lib.reader import wechat_db  # noqa: E402


def _clamp(value: str | None, default: int, minimum: int = 1, maximum: int = 500) -> int:
    """解析并钳制整数查询参数。"""
    try:
        number = int(value if value is not None else default)
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(maximum, number))


class ReaderHandler(BaseHTTPRequestHandler):
    """读取层 HTTP 处理器。"""

    protocol_version = "HTTP/1.1"
    reader: wechat_db.Reader | None = None
    token: str = ""
    init_error: str = ""

    def log_message(self, *_args) -> None:  # noqa: D401 - 覆盖父类，避免 URL/token 进日志
        """不打印访问日志（URL 可能含敏感参数）。"""

    # ------------------------------------------------------------ 基础工具

    def _supplied_token(self) -> str:
        header = self.headers.get("Authorization", "")
        return header[len("Bearer "):] if header.lower().startswith("bearer ") else ""

    def _authorized(self) -> bool:
        supplied = self._supplied_token()
        if not self.token or not supplied:
            return False
        return hmac.compare_digest(supplied.strip(), self.token)

    def _send_json(self, body: dict, status: int = 200) -> None:
        raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Cache-Control", "no-store")
        # 本地工具服务：一次性连接，避免 keep-alive 下的残留帧影响后续请求解析。
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass

    def _send_error_code(self, code: str, status: int) -> None:
        self._send_json({"success": False, "error": code}, status)

    def _not_ready(self) -> bool:
        """读取层未就绪时返回 503 并说明原因。"""
        if self.reader is not None:
            return False
        self._send_error_code(self.init_error or "READER_NOT_READY", 503)
        return True

    # ------------------------------------------------------------ GET

    def do_GET(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler 约定
        """处理只读查询与 SSE。"""
        url = urlsplit(self.path)
        query = parse_qs(url.query)
        if not self._authorized():
            self._send_error_code("UNAUTHORIZED", 401)
            return
        try:
            if url.path == "/api/v1/push/messages":
                self._stream_events()
                return
            if url.path == "/api/v1/reader/status":
                if self.reader is None:
                    self._send_json({
                        "success": True,
                        "ready": False,
                        "backend": "sqlcipher-nt",
                        "lastError": self.init_error or "READER_NOT_READY",
                    })
                else:
                    self._send_json(self.reader.status())
                return
            if self._not_ready():
                return
            if url.path == "/api/v1/sessions":
                limit = _clamp(query.get("limit", ["100"])[0], 100)
                self._send_json({"success": True, "sessions": self.reader.sessions(limit)})
                return
            if url.path == "/api/v1/contacts":
                keyword = query.get("keyword", [""])[0][:80]
                kind = query.get("kind", [""])[0]
                limit = _clamp(query.get("limit", ["100"])[0], 100, maximum=500)
                self._send_json({"success": True, "contacts": self.reader.contacts(keyword, kind, limit)})
                return
            if url.path == "/api/v1/messages":
                talker = query.get("talker", [""])[0]
                limit = _clamp(query.get("limit", ["100"])[0], 100)
                if not talker:
                    self._send_error_code("TALKER_REQUIRED", 400)
                    return
                from_time = query.get("fromTime", [None])[0]
                try:
                    from_ts = int(from_time) if from_time is not None else None
                except (TypeError, ValueError):
                    self._send_error_code("INVALID_FROM_TIME", 400)
                    return
                self._send_json({
                    "success": True,
                    "messages": self.reader.messages(talker, limit, from_time=from_ts),
                })
                return
            if re.fullmatch(r"/api/v1/images/[0-9a-f]{64}", url.path):
                image_id = url.path.rsplit("/", 1)[1]
                try:
                    self._send_json(self.reader.resolve_image(image_id))
                except wechat_db.ReaderError as error:
                    self._send_error_code(error.code, 503)
                except PermissionError:
                    self._send_error_code("IMAGE_NOT_AUTHORIZED", 403)
                return
            self._send_error_code("NOT_FOUND", 404)
        except PermissionError:
            self._send_error_code("CONVERSATION_NOT_ALLOWED", 403)
        except wechat_db.ReaderError as error:
            self._send_error_code(error.code, 503)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        except Exception as error:  # noqa: BLE001 - 对外只暴露错误类型，不泄露细节
            log_lib.log("reader.request.failed", level="error", path=url.path, type=type(error).__name__)
            self._send_error_code("READER_QUERY_FAILED", 503)

    # ------------------------------------------------------------ SSE

    def _stream_events(self) -> None:
        """SSE：每客户端独立队列 + 2s 心跳；队列满踢连接。"""
        if self.reader is None:
            self._send_error_code(self.init_error or "READER_NOT_READY", 503)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.send_header("Transfer-Encoding", "chunked")
        self.end_headers()
        client = self.reader.subscribe()
        try:
            while not self.reader.stop.is_set():
                try:
                    payload = client.get(timeout=2)
                    line = "data: " + json.dumps(payload, ensure_ascii=False) + "\n\n"
                except queue.Empty:
                    line = ": heartbeat\n\n"
                raw = line.encode("utf-8")
                self.wfile.write(("%x\r\n" % len(raw)).encode("ascii") + raw + b"\r\n")
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass
        finally:
            self.reader.unsubscribe(client)
            self.close_connection = True

    # ------------------------------------------------------------ POST

    def do_POST(self) -> None:  # noqa: N802 - BaseHTTPRequestHandler 约定
        """处理显式重试事件（M2）。"""
        url = urlsplit(self.path)
        if not self._authorized():
            self._send_error_code("UNAUTHORIZED", 401)
            return
        if self._not_ready():
            return
        if url.path != "/api/v1/events/retry":
            self._send_error_code("NOT_FOUND", 404)
            return
        if self.headers.get("Transfer-Encoding", "").lower() == "chunked":
            self._send_error_code("UNSUPPORTED_TRANSFER_ENCODING", 400)
            return
        try:
            size = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            size = 0
        if not 0 < size <= 1024:
            self._send_error_code("INVALID_BODY", 400)
            return
        try:
            descriptor = json.loads(self.rfile.read(size))
            talker = str(descriptor.get("talker", ""))
            local_id = int(descriptor.get("localId", 0))
            create_time = int(descriptor.get("createTime", 0))
        except (ValueError, TypeError):
            self._send_error_code("INVALID_BODY", 400)
            return
        try:
            pushed = self.reader.retry_event(talker, local_id, create_time)
            self._send_json({"success": True, "pushed": pushed})
        except PermissionError:
            self._send_error_code("CONVERSATION_NOT_ALLOWED", 403)
        except wechat_db.ReaderError as error:
            self._send_error_code(error.code, 503)
        except Exception as error:  # noqa: BLE001
            log_lib.log("reader.retry.failed", level="error", type=type(error).__name__)
            self._send_error_code("EVENT_RETRY_FAILED", 503)


class ReaderServer(ThreadingHTTPServer):
    """带优雅关闭的线程化 HTTP 服务。

    Windows 上必须用 SO_EXCLUSIVEADDRUSE：默认的 SO_REUSEADDR 语义允许第二个
    进程也绑定同一端口（看似"启动成功"实则抢流量），手册 §11 要求端口被占用时
    启动失败并提示占用者。
    """

    daemon_threads = True
    allow_reuse_address = os.name != "nt"

    def server_bind(self) -> None:
        """绑定前设置独占（Windows）/可复用（POSIX）标志。"""
        if os.name == "nt":
            try:
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
            except OSError:
                pass
        else:
            try:
                self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            except OSError:
                pass
        super().server_bind()


def _port_owner(port: int) -> tuple[str, str] | None:
    """端口被占用时给出占用者 pid/进程名（手册 §11：端口被占用要提示占用者）。"""
    try:
        output = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True, timeout=8,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        ).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 5 or parts[0].upper() != "TCP":
            continue
        if not parts[1].endswith(f":{port}") or parts[3].upper() != "LISTENING":
            continue
        pid = parts[4]
        try:
            task = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                capture_output=True, text=True, timeout=8,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            ).stdout.strip()
            image = task.split(",")[0].strip('"') if task else ""
        except (OSError, subprocess.SubprocessError):
            image = ""
        return pid, image
    return None


def serve(reader: wechat_db.Reader | None, port: int, token: str, init_error: str = "") -> int:
    """启动服务并阻塞；reader 为空时只暴露 /status（503 语义）。"""
    ReaderHandler.reader = reader
    ReaderHandler.token = token
    ReaderHandler.init_error = init_error
    try:
        server = ReaderServer(("127.0.0.1", port), ReaderHandler)
    except OSError as error:
        code = getattr(error, "winerror", None) or error.errno
        owner = _port_owner(port)
        log_lib.log("reader.listen.failed", level="error", port=port, code=code,
                    ownerPid=owner[0] if owner else "", ownerImage=owner[1] if owner else "")
        print(json.dumps({
            "ok": False,
            "error": "READER_PORT_UNAVAILABLE",
            "port": port,
            "code": code,
            "ownerPid": owner[0] if owner else None,
            "ownerImage": owner[1] if owner else None,
        }, ensure_ascii=False), file=sys.stderr)
        return 1
    stop = threading.Event()
    # 绑定成功后再启动轮询，避免端口冲突时留下无意义的轮询日志。
    if reader is not None:
        threading.Thread(target=reader.poll_forever, daemon=True, name="reader-poll").start()

    def _shutdown(*_args) -> None:
        stop.set()
        if reader is not None:
            reader.stop.set()
        threading.Thread(target=server.shutdown, daemon=True).start()

    for name in ("SIGINT", "SIGTERM"):
        try:
            signal.signal(getattr(signal, name), _shutdown)
        except (AttributeError, ValueError):
            pass
    log_lib.log("reader.listening", port=port, ready=reader is not None, error=init_error or "")
    print(json.dumps({
        "ok": True,
        "listening": f"http://127.0.0.1:{port}",
        "ready": reader is not None,
        "error": init_error or None,
    }, ensure_ascii=False), flush=True)
    try:
        server.serve_forever(poll_interval=0.5)
    finally:
        if reader is not None:
            reader.stop.set()
            reader.close()
        server.server_close()
        log_lib.log("reader.stopped")
    return 0


def main() -> int:
    """命令行入口。"""
    config = paths_lib.load_config()
    reader_cfg = config.get("reader", {})
    log_lib.configure(file=paths_lib.log_file(), level=config.get("logging", {}).get("level", "info"))
    token = paths_lib.reader_token()

    port_arg = None
    if "--port" in sys.argv:
        try:
            port_arg = int(sys.argv[sys.argv.index("--port") + 1])
        except (IndexError, ValueError):
            print("--port 需要端口号", file=sys.stderr)
            return 2
    port = port_arg or int(config.get("ports", {}).get("reader", 5031))

    reader: wechat_db.Reader | None = None
    init_error = ""
    try:
        reader = wechat_db.Reader()
    except wechat_db.ReaderError as error:
        init_error = error.code
        log_lib.log("reader.init.failed", level="error", code=error.code, detail=error.message)
    except Exception as error:  # noqa: BLE001
        init_error = "READER_INIT_FAILED"
        log_lib.log("reader.init.failed", level="error", code=init_error, type=type(error).__name__)

    if "--check" in sys.argv:
        if reader is None:
            print(json.dumps({"ok": False, "code": init_error}, ensure_ascii=False))
            return 1
        try:
            sessions = reader.sessions(20)
            contacts = reader.contacts(limit=20)
            print(json.dumps({
                "ok": True,
                "backend": "sqlcipher-nt",
                "accountDirectory": reader.account_dir,
                "ownWxid": reader.own_wxid,
                "shards": reader.shards,
                "sessionCount": len(sessions),
                "contactCount": len(contacts),
                "sampleSessions": [item["displayName"] for item in sessions[:5]],
            }, ensure_ascii=False))
            return 0 if sessions or contacts else 1
        finally:
            reader.close()

    return serve(reader, port, token, init_error)


if __name__ == "__main__":
    sys.exit(main())
