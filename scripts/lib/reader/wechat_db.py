"""读取层：只读打开微信 4.x 本地库 + 会话/联系人/消息查询 + 增量轮询。

设计要点（手册 §5、§2）：
- 只读：`PRAGMA query_only=ON`，绝不写库；不产生明文库副本。
- 每个分片用自己的前 16 字节 salt 派生密钥（手册 §13.3）；`PRAGMA key` 后必须真实读一次。
- 分片读取失败显式上报（不静默少读）；连接常驻并在出错时重开，退出时统一 close。
- 启动不回放历史：水位从进程启动时刻开始，只留 3s 重叠；去重键 = sha256(talker, serverId, localId, createTime)。
- 推送按 SSE 订阅者各自队列，队列满踢连接。
"""
from __future__ import annotations

import base64
import collections
import hashlib
import json
import pathlib
import queue
import re
import subprocess
import sys
import threading
import time

from lib.reader import accounts, dbkey
from lib.reader import paths as paths_lib
from lib.reader import wechat_decode as decode
from lib.reader import wechat_media
from lib.reader.log import log

try:  # sqlcipher3 是运行时依赖；缺失时给明确错误码
    from sqlcipher3 import dbapi2 as sqlcipher
except ImportError:  # pragma: no cover - 环境缺依赖
    sqlcipher = None

MESSAGE_COLUMNS = ("local_id", "server_id", "local_type", "real_sender_id", "create_time", "message_content")
SHARD_EXCLUDE = {"message_fts.db", "message_resource.db"}


class ReaderError(RuntimeError):
    """带错误码的读取层错误。"""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


def _digest(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest()


class Reader:
    """读取层主体。初始化失败抛 ReaderError（错误码可直接对外）。"""

    def __init__(self, root: pathlib.Path | None = None):
        self.root = pathlib.Path(root or paths_lib.ROOT)
        self.config = paths_lib.load_config()
        reader_cfg = self.config.get("reader", {})
        self.lock = threading.RLock()
        self.stop = threading.Event()
        self.clients: set[queue.Queue] = set()
        self.seen: collections.OrderedDict[str, bool] = collections.OrderedDict()
        self.dedupe_capacity = int(reader_cfg.get("dedupeCapacity", 5000))
        self.started_at = int(time.time())
        self._since = self.started_at
        self.last_poll = 0.0
        self.last_error = ""
        self.pushed = 0
        self.shard_failures: list[dict] = []
        self.shards: list[dict] = []

        if sqlcipher is None:
            raise ReaderError("READER_DEPENDENCY_MISSING", "缺少 sqlcipher3（pip install -r requirements.txt）")

        accounts_found = accounts.discover_accounts(reader_cfg.get("dataRoot", ""))
        if not accounts_found:
            raise ReaderError("READER_PATH_MISSING", "找不到任何微信账号目录")
        account = accounts.pick_account(accounts_found, reader_cfg.get("accountDirectory", ""))
        self.account = account
        self.account_dir = account["myWxid"]
        self.account_path = pathlib.Path(account["dbPath"])
        self.own_wxid = accounts.clean_own_wxid(self.account_dir)

        # 账号目录按探测结果回写配置（手册 M1：记下账号目录）。
        if not reader_cfg.get("accountDirectory"):
            self.config.setdefault("reader", {})["accountDirectory"] = self.account_dir
            paths_lib.save_config_atomic(self.config)

        try:
            self._key = dbkey.read_account_key(self.account_dir)
        except dbkey.KeyErrorBase as error:
            raise ReaderError(error.code, error.message) from None
        message_db = self.account_path / "db_storage" / "message" / "message_0.db"
        verdict = dbkey.verify_key_hmac(self._key, str(message_db))
        if verdict is not True:
            raise ReaderError(
                "KEY_REJECTED" if verdict is False else "DB_UNREADABLE",
                "密钥与当前账号库不匹配" if verdict is False else "无法读取 message_0.db",
            )

        self.contact_db = self.account_path / "db_storage" / "contact" / "contact.db"
        self.session_db = self.account_path / "db_storage" / "session" / "session.db"
        self.message_root = self.account_path / "db_storage" / "message"
        self.resource_db = self.message_root / "message_resource.db"
        self.resource_error = ""
        self.connections: dict[str, object] = {}
        self._names: dict[str, str] = {}
        self._kinds: dict[str, str] = {}
        self._names_refreshed_at = 0.0
        self._open_all()
        self.refresh_names(max_age=0)

        # M3：图片索引与密钥（派生失败不阻塞读取层）
        media_cfg = reader_cfg.get("media", {}) or {}
        cache_dir = pathlib.Path(media_cfg.get("cacheDir") or "state/media")
        self.image_dir = cache_dir if cache_dir.is_absolute() else pathlib.Path(self.root) / cache_dir
        self.image_dir.mkdir(parents=True, exist_ok=True)
        self.image_index_file = self.image_dir / "index.json"
        self.image_index: dict[str, dict] = {}
        try:
            if self.image_index_file.is_file():
                loaded = json.loads(self.image_index_file.read_text(encoding="utf-8"))
                if isinstance(loaded, dict):
                    self.image_index = loaded
        except (OSError, json.JSONDecodeError):
            self.image_index = {}
        self.image_error = ""
        self.image_keys: dict | None = None
        self.image_key_error = ""
        self.image_max_bytes = int(media_cfg.get("maxBytes") or wechat_media.MAX_MEDIA_BYTES)
        try:
            self.image_keys = wechat_media.derive_image_keys(
                self.account_path,
                self.own_wxid,
                image_aes_key=reader_cfg.get("imageAesKey", "") or "",
                image_xor_key=reader_cfg.get("imageXorKey"),
            )
        except wechat_media.MediaError as error:
            self.image_key_error = error.code
        if self.image_keys is None and not self.image_key_error:
            self.image_key_error = "IMAGE_KEY_UNAVAILABLE"

    # ------------------------------------------------------------ 连接管理

    def _open(self, path: pathlib.Path):
        """只读打开单个 SQLCipher 库：每库用自己的 salt 派生密钥。"""
        salt = path.read_bytes()[:16]
        if len(salt) != 16:
            raise ReaderError("DB_UNREADABLE", f"无法读取数据库头：{path.name}")
        key = hashlib.pbkdf2_hmac("sha512", bytes.fromhex(self._key), salt, 256000, 32)
        try:
            conn = sqlcipher.connect(str(path), check_same_thread=False)
            conn.execute(f'PRAGMA key = "x\'{key.hex()}{salt.hex()}\'";')
            conn.execute("PRAGMA query_only = ON;")
            conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
        except Exception as error:  # noqa: BLE001 - 统一转错误码
            raise ReaderError("KEY_REJECTED", f"{path.name}: {type(error).__name__}") from None
        return conn

    def discover_shards(self) -> list[pathlib.Path]:
        """消息分片：message_*.db，排除 fts/resource。"""
        shards = []
        for path in sorted(self.message_root.glob("message_*.db")):
            if path.name.lower() in SHARD_EXCLUDE:
                continue
            shards.append(path)
        return shards

    def _open_all(self) -> None:
        """打开联系人/会话库与全部消息分片；失败分片显式记录。"""
        for name, path in (("contact", self.contact_db), ("session", self.session_db)):
            if not path.is_file():
                raise ReaderError("DB_UNREADABLE", f"缺少数据库：{path.name}")
            self.connections[name] = self._open(path)
        # 图片资源库（可选）：读不到只影响图片解密，不影响文字消息。
        if self.resource_db.is_file():
            try:
                self.connections["resource"] = self._open(self.resource_db)
            except ReaderError as error:
                self.resource_error = error.code
        self.shards = []
        self.shard_failures = []
        for path in self.discover_shards():
            entry = {"name": path.name, "opened": False, "reason": ""}
            try:
                self.connections[f"shard:{path.name}"] = self._open(path)
                entry["opened"] = True
            except ReaderError as error:
                entry["reason"] = error.code
                self.shard_failures.append({"name": path.name, "reason": error.code})
            self.shards.append(entry)
        if not any(entry["opened"] for entry in self.shards):
            raise ReaderError("DB_UNREADABLE", "所有消息分片都无法读取")

    def _reopen(self, name: str) -> object | None:
        """按需重开一个连接（WeChat 更新文件后旧句柄可能失效）。"""
        mapping = {"contact": self.contact_db, "session": self.session_db}
        try:
            if name in mapping:
                conn = self._open(mapping[name])
            elif name.startswith("shard:"):
                conn = self._open(self.message_root / name.split(":", 1)[1])
            else:
                return None
        except ReaderError:
            return None
        with self.lock:
            old = self.connections.get(name)
            self.connections[name] = conn
            if old is not None:
                try:
                    old.close()
                except Exception:  # noqa: BLE001
                    pass
        return conn

    def close(self) -> None:
        """关闭所有连接（Windows 上泄漏句柄会锁文件）。"""
        with self.lock:
            for conn in self.connections.values():
                try:
                    conn.close()
                except Exception:  # noqa: BLE001
                    pass
            self.connections.clear()

    # ------------------------------------------------------------ 名称映射

    def refresh_names(self, max_age: float = 30.0) -> None:
        """刷新 wxid → 显示名 映射（remark > nick_name > alias > username）。"""
        with self.lock:
            if max_age and time.monotonic() - self._names_refreshed_at < max_age:
                return
            conn = self.connections.get("contact")
            try:
                rows = conn.execute(
                    "SELECT username, local_type, alias, remark, nick_name FROM contact"
                ).fetchall()
            except Exception:  # noqa: BLE001 - 连接可能因微信写库失效
                conn = self._reopen("contact")
                if conn is None:
                    raise ReaderError("DB_UNREADABLE", "contact.db 读取失败") from None
                rows = conn.execute(
                    "SELECT username, local_type, alias, remark, nick_name FROM contact"
                ).fetchall()
            names, kinds = {}, {}
            for username, local_type, alias, remark, nick_name in rows:
                if not username:
                    continue
                display = remark or nick_name or alias or username
                names[username] = display
                if username.endswith("@chatroom"):
                    kinds[username] = "group"
                elif username.startswith("gh_") or username == "weixin":
                    kinds[username] = "official"
                elif username == "filehelper":
                    kinds[username] = "system"
                elif int(local_type or 0) & 1:
                    kinds[username] = "friend"
                else:
                    kinds[username] = "other"
            self._names = names
            self._kinds = kinds
            self._names_refreshed_at = time.monotonic()

    @property
    def names(self) -> dict[str, str]:
        """当前显示名映射（拷贝，避免外部改内部状态）。"""
        return dict(self._names)

    # ------------------------------------------------------------ 会话/联系人

    def session_talkers(self) -> list[str]:
        """当前会话列表里的 talker（用于轮询）。"""
        with self.lock:
            conn = self.connections.get("session")
            try:
                rows = conn.execute(
                    "SELECT username FROM SessionTable WHERE is_hidden = 0 ORDER BY sort_timestamp DESC"
                ).fetchall()
            except Exception:  # noqa: BLE001
                conn = self._reopen("session")
                if conn is None:
                    return []
                rows = conn.execute(
                    "SELECT username FROM SessionTable WHERE is_hidden = 0 ORDER BY sort_timestamp DESC"
                ).fetchall()
        return [row[0] for row in rows if row[0]]

    def sessions(self, limit: int = 100) -> list[dict]:
        """会话列表：SessionTable + contact 显示名。"""
        self.refresh_names(max_age=30)
        with self.lock:
            conn = self.connections.get("session")
            sql = (
                "SELECT username, type, unread_count, summary, last_timestamp, sort_timestamp, "
                "last_msg_type, last_msg_sender, last_sender_display_name, is_hidden "
                "FROM SessionTable ORDER BY sort_timestamp DESC LIMIT ?"
            )
            try:
                rows = conn.execute(sql, (limit,)).fetchall()
            except Exception:  # noqa: BLE001
                conn = self._reopen("session")
                if conn is None:
                    raise ReaderError("DB_UNREADABLE", "session.db 读取失败") from None
                rows = conn.execute(sql, (limit,)).fetchall()
        names = self._names
        result = []
        for (username, kind, unread, summary, last_ts, sort_ts, last_type,
             last_sender, sender_display, hidden) in rows:
            result.append({
                "talker": username,
                "displayName": names.get(username, username),
                "sessionType": "group" if "@chatroom" in (username or "") else "private",
                "kind": self._kinds.get(username, "other"),
                "unreadCount": int(unread or 0),
                "lastTimestamp": int(last_ts or 0),
                "sortTimestamp": int(sort_ts or 0),
                "lastMsgType": int(last_type or 0),
                "lastSender": last_sender or "",
                "lastSenderDisplay": sender_display or names.get(last_sender or "", last_sender or ""),
                "hidden": bool(hidden),
                "summary": (summary or "")[:120],
            })
        return result

    def contacts(self, keyword: str = "", kind: str = "", limit: int = 100) -> list[dict]:
        """联系人/群列表；同名群标 ambiguous。"""
        self.refresh_names(max_age=30)
        keyword = (keyword or "").strip().casefold()
        counts: dict[str, int] = {}
        for username, display in self._names.items():
            if "@chatroom" in username:
                identity = re.sub(r"\s*\(\d+\)\s*$", "", display).strip()
                counts[identity] = counts.get(identity, 0) + 1
        result = []
        for username, display in self._names.items():
            entry_kind = self._kinds.get(username, "other")
            if kind in ("groups", "group") and entry_kind != "group":
                continue
            if kind in ("private", "friends") and entry_kind != "friend":
                continue
            if keyword and keyword not in (username + display).casefold():
                continue
            identity = re.sub(r"\s*\(\d+\)\s*$", "", display).strip()
            result.append({
                "username": username,
                "displayName": display,
                "kind": entry_kind,
                "ambiguous": entry_kind == "group" and counts.get(identity, 0) > 1,
            })
            if len(result) >= limit:
                break
        return result

    # ------------------------------------------------------------ 白名单

    def allowed(self, talker: str) -> bool:
        """白名单判定。

        - `wechat.whitelist.enabled=false` 且列表为空：M1 开发态，放行所有会话；
        - 其余情况：严格匹配 `private/groups` 里的 wxid 或群显示名（去尾部 `(n)`）。
        """
        wechat = self.config.get("wechat", {})
        whitelist = wechat.get("whitelist", {}) or {}
        private = [str(item) for item in whitelist.get("private", []) or []]
        groups = [str(item) for item in whitelist.get("groups", []) or []]
        enabled = bool(whitelist.get("enabled")) or bool(private) or bool(groups)
        if not enabled:
            return True
        display = self._names.get(talker, "")
        normalized = re.sub(r"\s*\(\d+\)\s*$", "", display).strip()
        entries = groups if "@chatroom" in talker else private
        return talker in entries or display in entries or normalized in entries

    # ------------------------------------------------------------ 消息查询

    def _query_shard(self, shard_name: str, table: str, from_time: int | None, limit: int):
        """在一个分片里查询某会话消息；返回 (rows, sender_map) 或抛异常。"""
        conn = self.connections.get(f"shard:{shard_name}")
        if conn is None:
            raise ReaderError("DB_UNREADABLE", f"{shard_name} 未打开")
        exists = conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?", (table,)
        ).fetchone()[0]
        if not exists:
            return [], {}
        available = {row[1] for row in conn.execute(f'PRAGMA table_info("{table}")')}
        selected = [column for column in MESSAGE_COLUMNS if column in available]
        if not {"local_id", "create_time"} <= available:
            raise ReaderError("SCHEMA_MISMATCH", f"{shard_name} 缺少关键列")
        sql = f'SELECT {", ".join(selected)} FROM "{table}"'
        params: list = []
        if from_time is not None:
            sql += ' WHERE "create_time" >= ?'
            params.append(int(from_time))
        sql += ' ORDER BY "create_time" DESC, "local_id" DESC'
        if limit > 0:
            sql += " LIMIT ?"
            params.append(int(limit))
        rows = [dict(zip(selected, values)) for values in conn.execute(sql, params).fetchall()]
        sender_map: dict[int, str] = {}
        if conn.execute(
            "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='Name2Id'"
        ).fetchone()[0]:
            sender_map = {
                int(rowid): username
                for rowid, username in conn.execute("SELECT rowid, user_name FROM Name2Id").fetchall()
            }
        return rows, sender_map

    def _attach_image(self, talker: str, message: dict) -> dict:
        """给图片/表情消息补 image.id（懒登记，供面板/CLI 按 id 取图）。"""
        if message.get("baseType") not in (decode.IMAGE, decode.STICKER):
            return message
        image_id = self._image_id(talker, message["rawid"])
        if image_id not in self.image_index:
            with self.lock:
                self.image_index[image_id] = {
                    "imageId": image_id,
                    "talker": talker,
                    "account": self.account_dir,
                    "sender": message.get("senderUsername", ""),
                    "localId": message.get("localId"),
                    "serverId": message.get("serverId"),
                    "createTime": message.get("createTime"),
                    "localType": message.get("localType"),
                }
                self._save_image_index()
        message["image"] = {
            "id": image_id,
            "localId": message.get("localId"),
            "serverId": message.get("serverId"),
            "createTime": message.get("createTime"),
            "localType": message.get("localType"),
        }
        return message

    def messages(self, talker: str, limit: int = 100, from_time: int | None = None) -> list[dict]:
        """跨分片读取某会话最近消息（按时间倒序）。"""
        if not talker:
            raise ValueError("TALKER_REQUIRED")
        if not self.allowed(talker):
            raise PermissionError("CONVERSATION_NOT_ALLOWED")
        table = f"Msg_{_digest(talker)}"
        collected: list[dict] = []
        is_group = "@chatroom" in talker
        with self.lock:
            for entry in list(self.shards):
                if not entry.get("opened"):
                    continue
                shard_name = entry["name"]
                try:
                    rows, sender_map = self._query_shard(shard_name, table, from_time, limit)
                except Exception:  # noqa: BLE001 - 尝试重开一次
                    if self._reopen(f"shard:{shard_name}") is None:
                        entry["opened"] = False
                        entry["reason"] = "READ_FAILED"
                        continue
                    try:
                        rows, sender_map = self._query_shard(shard_name, table, from_time, limit)
                    except Exception:  # noqa: BLE001
                        entry["opened"] = False
                        entry["reason"] = "READ_FAILED"
                        continue
                known = set(self._names)
                for row in rows:
                    message = decode.build_message(
                        row,
                        talker=talker,
                        sender_map=sender_map,
                        names=self._names,
                        own_wxid=self.own_wxid,
                        known_ids=known,
                    )
                    collected.append(self._attach_image(talker, message))
        collected.sort(key=lambda item: (item["createTime"], item["localId"]), reverse=True)
        return collected[:limit] if limit > 0 else collected

    # ------------------------------------------------------------ 增量轮询 / SSE

    def subscribe(self) -> queue.Queue:
        """登记一个 SSE 订阅者队列（上限 500 条）。"""
        client: queue.Queue = queue.Queue(maxsize=500)
        with self.lock:
            self.clients.add(client)
        return client

    def unsubscribe(self, client: queue.Queue) -> None:
        with self.lock:
            self.clients.discard(client)

    def _broadcast(self, payload: dict) -> None:
        with self.lock:
            for client in list(self.clients):
                try:
                    client.put_nowait(payload)
                except queue.Full:
                    self.clients.discard(client)

    def _remember(self, rawid: str) -> None:
        self.seen[rawid] = True
        while len(self.seen) > self.dedupe_capacity:
            self.seen.popitem(last=False)

    # ------------------------------------------------------------ 图片（M3）

    def _image_id(self, talker: str, rawid: str) -> str:
        """图片 ID = sha256([ownWxid, talker, rawid])，与消息一一对应。"""
        payload = json.dumps([self.own_wxid, talker, rawid], separators=(",", ":"))
        return hashlib.sha256(payload.encode("utf-8")).hexdigest()

    def _save_image_index(self) -> None:
        """原子落盘图片索引（上限 1000 条，淘汰最旧并删缓存）。"""
        while len(self.image_index) > 1000:
            oldest = next(iter(self.image_index))
            self.image_index.pop(oldest, None)
            for leftover in self.image_dir.glob(f"{oldest}.*"):
                try:
                    leftover.unlink()
                except OSError:
                    pass
        tmp = self.image_index_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(self.image_index, ensure_ascii=False), encoding="utf-8")
        tmp.replace(self.image_index_file)

    def remember_image(self, talker: str, payload: dict) -> str:
        """登记一条入站图片/表情，返回 image_id（不在此处解密）。"""
        image_id = self._image_id(talker, payload["rawid"])
        descriptor = {
            "imageId": image_id,
            "talker": talker,
            "account": self.account_dir,
            "sender": payload.get("talkerId", ""),
            "localId": payload["image"].get("localId"),
            "serverId": payload["image"].get("serverId"),
            "createTime": payload["image"].get("createTime"),
            "localType": payload["image"].get("localType"),
        }
        with self.lock:
            self.image_index[image_id] = descriptor
            self._save_image_index()
        return image_id

    def _media_xml(self, talker: str, local_id, create_time, server_id) -> str | None:
        """按三元组回读消息，返回解码后的 XML/正文（用于取图片 md5）。"""
        table = f"Msg_{_digest(talker)}"
        with self.lock:
            for entry in list(self.shards):
                if not entry.get("opened"):
                    continue
                conn = self.connections.get(f"shard:{entry['name']}")
                if conn is None:
                    continue
                try:
                    row = conn.execute(
                        f'SELECT message_content FROM "{table}" '
                        "WHERE local_id=? AND create_time=? AND server_id=? LIMIT 1",
                        (int(local_id or 0), int(create_time or 0), int(server_id or 0)),
                    ).fetchone()
                except Exception:  # noqa: BLE001 - 读不到就换下一个分片
                    continue
                if row:
                    return decode.decode_content(row[0])
        return None

    def _resource_blobs(self, server_id, local_id, create_time) -> list[bytes]:
        """按 server/local/time 取 `MessageResourceInfo.packed_info`（图片文件名候选来源）。"""
        if "resource" not in self.connections or not int(server_id or 0):
            return []
        conn = self.connections["resource"]
        try:
            rows = conn.execute(
                "SELECT packed_info FROM MessageResourceInfo "
                "WHERE message_svr_id=? AND message_local_id=? AND message_create_time=? LIMIT 8",
                (int(server_id), int(local_id or 0), int(create_time or 0)),
            ).fetchall()
        except Exception:  # noqa: BLE001 - 资源库读不到就只靠 XML 候选
            return []
        return [row[0] for row in rows if row and row[0]]

    def resolve_image(self, image_id: str) -> dict:
        """解密一张已登记图片；结果缓存到 state/media/<imageId>.json + 图片文件。"""
        if not re.fullmatch(r"[0-9a-f]{64}", image_id or ""):
            raise ReaderError("IMAGE_ID_INVALID", "图片 id 必须是 64-hex")
        descriptor = self.image_index.get(image_id)
        if not descriptor or descriptor.get("account") != self.account_dir:
            raise PermissionError("IMAGE_NOT_AUTHORIZED")
        talker = descriptor["talker"]
        if not self.allowed(talker):
            raise PermissionError("IMAGE_NOT_AUTHORIZED")
        cache = self.image_dir / f"{image_id}.json"
        if cache.is_file():
            try:
                return json.loads(cache.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                pass
        if self.image_keys is None:
            raise ReaderError(self.image_key_error or "IMAGE_KEY_UNAVAILABLE", "图片密钥不可用")
        xml = self._media_xml(
            talker, descriptor.get("localId"), descriptor.get("createTime"), descriptor.get("serverId")
        )
        candidates = wechat_media.extract_media_md5s(xml or "")
        for blob in self._resource_blobs(
            descriptor.get("serverId"), descriptor.get("localId"), descriptor.get("createTime")
        ):
            candidates.extend(wechat_media.extract_blob_md5s(blob))
        candidates = list(dict.fromkeys(candidates))[:256]
        if not candidates:
            raise ReaderError("IMAGE_MD5_MISSING", "消息里没有图片 md5/资源候选")
        request = {
            "accountDir": str(self.account_path),
            "ownWxid": self.own_wxid,
            "talker": talker,
            "md5Candidates": candidates,
            "fallbackNames": [f"{descriptor.get('localId')}_{descriptor.get('createTime')}"],
            "imageAesKey": self.image_keys["aesKey"].hex(),
            "imageXorKey": self.image_keys["xorKey"],
            "maxBytes": self.image_max_bytes,
        }
        script = pathlib.Path(paths_lib.ROOT) / "scripts" / "resolve-media.py"
        try:
            process = subprocess.run(
                [sys.executable, "-B", str(script)],
                input=json.dumps(request), capture_output=True, text=True, encoding="utf-8",
                timeout=25, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        except subprocess.TimeoutExpired:
            self.image_error = "IMAGE_PROCESS_TIMEOUT"
            raise ReaderError(self.image_error, "图片解密超时") from None
        except OSError:
            self.image_error = "IMAGE_PROCESS_START_FAILED"
            raise ReaderError(self.image_error, "无法启动图片解密子进程") from None
        payload = None
        for line in reversed((process.stdout or "").strip().splitlines()):
            try:
                payload = json.loads(line)
                break
            except json.JSONDecodeError:
                continue
        if payload is None or not payload.get("ok"):
            self.image_error = (payload or {}).get("error") or "IMAGE_RESOLUTION_FAILED"
            detail = (payload or {}).get("message", "") or (process.stderr or "").strip()[-800:]
            raise ReaderError(self.image_error, detail)
        try:
            data = base64.b64decode(payload["b64"], validate=True)
        except (KeyError, ValueError):
            self.image_error = "IMAGE_RESOLUTION_EMPTY"
            raise ReaderError(self.image_error, "解密结果为空") from None
        mime = payload.get("mime") or "application/octet-stream"
        extension = {"image/jpeg": ".jpg", "image/png": ".png", "image/gif": ".gif", "image/webp": ".webp"}.get(mime, ".bin")
        saved = self.image_dir / f"{image_id}{extension}"
        try:
            tmp = saved.with_suffix(saved.suffix + ".tmp")
            tmp.write_bytes(data)
            tmp.replace(saved)
        except OSError:
            pass
        result = {
            "success": True,
            "imageId": image_id,
            "mime": mime,
            "bytes": len(data),
            "b64": payload["b64"],
            "savedFile": str(saved),
            "sourceFile": payload.get("file", ""),
            "keySource": payload.get("keySource", ""),
            "cachedAt": int(time.time()),
        }
        try:
            tmp = cache.with_suffix(".tmp")
            tmp.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
            tmp.replace(cache)
        except OSError:
            pass
        self.image_error = ""
        return result

    def poll_once(self) -> int:
        """一轮增量轮询（启动不回放历史，只留 3s 重叠）。"""
        since = self._since
        newest = since
        pushed = 0
        talkers = self.session_talkers()
        for talker in talkers:
            from_time = max(self.started_at, since - 3)
            try:
                messages = self.messages(talker, limit=0, from_time=from_time)
            except PermissionError:
                continue
            for message in reversed(messages):
                newest = max(newest, message.get("createTime", 0))
                payload = decode.push_payload(talker, message, self._names, self.own_wxid)
                if not payload or payload["rawid"] in self.seen:
                    continue
                if payload.get("image"):
                    payload["image"]["id"] = self.remember_image(talker, payload)
                self._remember(payload["rawid"])
                self._broadcast(payload)
                self.pushed += 1
                pushed += 1
        self._since = max(newest, since)
        self.last_poll = time.time()
        self.last_error = ""
        return pushed

    def poll_forever(self) -> None:
        """后台轮询线程主体。"""
        self._since = self.started_at
        interval = max(0.2, int(self.config.get("reader", {}).get("pollIntervalMs", 1000)) / 1000)
        log("reader.poll.started", intervalMs=int(interval * 1000), sessions=len(self.session_talkers()))
        while not self.stop.is_set():
            try:
                self.poll_once()
                self.refresh_names(max_age=30)
            except Exception as error:  # noqa: BLE001 - 轮询不能因单次失败退出
                self.last_error = getattr(error, "code", type(error).__name__)
                log("reader.poll.failed", code=self.last_error)
            self.stop.wait(interval)
        log("reader.poll.stopped")

    def retry_event(self, talker: str, local_id: int, create_time: int) -> bool:
        """显式重推一条确定的入站事件（手册 §5.8 POST /events/retry）。

        只按 (talker, localId, createTime) 精确定位，不重推历史；已推过返回 False。
        """
        if not talker:
            raise ReaderError("TALKER_REQUIRED", "缺少 talker")
        if not self.allowed(talker):
            raise PermissionError("CONVERSATION_NOT_ALLOWED")
        messages = self.messages(talker, limit=0, from_time=max(0, int(create_time or 0) - 2))
        row = next(
            (item for item in messages
             if item["localId"] == int(local_id or 0) and item["createTime"] == int(create_time or 0)),
            None,
        )
        if row is None:
            raise ReaderError("EVENT_NOT_FOUND", "找不到对应消息")
        payload = decode.push_payload(talker, row, self._names, self.own_wxid)
        if not payload:
            raise ReaderError("EVENT_NOT_PUSHABLE", "该消息类型不产生推送事件")
        if payload.get("image"):
            payload["image"]["id"] = self.remember_image(talker, payload)
        if payload["rawid"] in self.seen:
            return False
        self._remember(payload["rawid"])
        self._broadcast(payload)
        self.pushed += 1
        return True

    def status(self) -> dict:
        """读取层状态（/api/v1/reader/status）。"""
        # 密钥诊断信息（多账号，不含密钥明文）
        keys: dict = {"current": {}, "accounts": []}
        try:
            payload = dbkey.load_key_file()
            accounts = []
            for account_dir, record in sorted(payload.get("accounts", {}).items()):
                account_path = str(record.get("accountPath") or "")
                db_path = pathlib.Path(account_path) / "db_storage" / "message" / "message_0.db"
                accounts.append({
                    "accountDirectory": account_dir,
                    "dbExists": db_path.is_file(),
                    "capturedAt": record.get("capturedAt"),
                    "keySource": record.get("keySource"),
                    "keyDllSha256": record.get("keyDllSha256") or payload.get("keyDllSha256"),
                    "active": account_dir.lower() == self.account_dir.lower(),
                })
            keys = {
                "current": {
                    "accountDirectory": self.account_dir,
                    "verified": True,
                    "keySource": self.config.get("reader", {}).get("keySource", ""),
                    "hint": "",
                },
                "accounts": accounts,
            }
        except dbkey.KeyErrorBase as error:
            keys = {
                "current": {
                    "accountDirectory": self.account_dir,
                    "verified": False,
                    "error": error.code,
                    "hint": "运行 .venv\\Scripts\\python.exe scripts/capture-key.py --capture，并在微信里退出登录→重新登录",
                },
                "accounts": [],
            }
        return {
            "success": True,
            "backend": "sqlcipher-nt",
            "ready": True,
            "ownWxid": self.own_wxid,
            "accountDirectory": self.account_dir,
            "lastPoll": self.last_poll,
            "lastError": self.last_error,
            "subscribers": len(self.clients),
            "pushed": self.pushed,
            "startedAt": self.started_at,
            "shards": list(self.shards),
            "shardFailures": list(self.shard_failures),
            "imagesRegistered": len(self.image_index),
            "lastImageError": self.image_error or self.image_key_error,
            "imageKeySource": (self.image_keys or {}).get("source", ""),
            "keys": keys,
        }
