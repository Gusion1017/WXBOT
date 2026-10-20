#!/usr/bin/env python
"""开发诊断工具：只读打开微信 4.x 本地库，打印库/表结构信息。

只输出结构（表名、列名、行数），不输出聊天正文；需要预览时显式加 --preview
（且只打印很短的截断内容），便于开发期确认解码逻辑。

用法：
    python scripts/dev-db-inspect.py                     # 列出各库的表
    python scripts/dev-db-inspect.py --schema Msg_xxx    # 打印某表建表语句
    python scripts/dev-db-inspect.py --count             # 各表行数
    python scripts/dev-db-inspect.py --preview Msg_xxx --limit 3
"""
from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from lib import dbkey  # noqa: E402

CONFIG_PATH = ROOT / "config" / "app.json"


def load_config() -> dict:
    """读取 config/app.json。"""
    return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))


def account_path() -> pathlib.Path:
    """配置账号目录。"""
    config = load_config()
    reader = config.get("reader", {})
    data_root = reader.get("dataRoot") or r"D:\Tencent\xwechat_files"
    account = reader.get("accountDirectory", "")
    if account:
        return pathlib.Path(data_root) / account
    return pathlib.Path(data_root)


def derive_db_key(file_key: str, db_path: pathlib.Path) -> str:
    """按文件自己的 salt 派生 SQLCipher raw key（手册 §5.3）。"""
    salt = db_path.read_bytes()[:16]
    key = hashlib.pbkdf2_hmac("sha512", bytes.fromhex(file_key), salt, 256000, 32)
    return key.hex() + salt.hex()


def open_db(db_path: pathlib.Path, file_key: str):
    """只读打开一个 SQLCipher 库。"""
    from sqlcipher3 import dbapi2

    conn = dbapi2.connect(str(db_path))
    conn.execute(f'PRAGMA key = "x\'{derive_db_key(file_key, db_path)}\'";')
    conn.execute("PRAGMA query_only = ON;")
    conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
    return conn


def tables(conn) -> list[str]:
    """列非内部表。"""
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    return [row[0] for row in rows]


def _magic(value) -> str:
    """内容开头的魔数（hex），用于判断压缩/加密容器。"""
    if value is None:
        return "-"
    raw = value.encode("utf-8", errors="replace") if isinstance(value, str) else value
    return raw[:4].hex()


def _try_zstd(raw: bytes) -> int | None:
    """尝试 zstd 解压，成功返回解压后字节数。"""
    try:
        import zstandard

        return len(zstandard.ZstdDecompressor().decompress(raw, max_output_size=8 * 1024 * 1024))
    except Exception:  # noqa: BLE001
        return None


def probe_message_table(conn, table: str, limit: int) -> dict:
    """探测消息表内容编码（只输出结构统计，不输出正文）。"""
    columns = [row[1] for row in conn.execute(f'PRAGMA table_info("{table}")')]
    select_cols = [name for name in (
        "local_id", "server_id", "local_type", "real_sender_id", "create_time",
        "status", "WCDB_CT_message_content", "message_content", "compress_content",
    ) if name in columns]
    rows = conn.execute(
        f'SELECT {", ".join(select_cols)} FROM "{table}" ORDER BY local_id DESC LIMIT ?', (limit,)
    ).fetchall()
    records = []
    for row in rows:
        record = dict(zip(select_cols, row))
        content = record.get("message_content")
        compress = record.get("compress_content")
        content_bytes = (
            content.encode("utf-8", errors="replace") if isinstance(content, str) else content
        ) if content is not None else b""
        record_out = {
            "local_id": record.get("local_id"),
            "server_id": record.get("server_id"),
            "local_type": record.get("local_type"),
            "real_sender_id": record.get("real_sender_id"),
            "create_time": record.get("create_time"),
            "content_ct": record.get("WCDB_CT_message_content"),
            "content_pytype": type(content).__name__ if content is not None else "None",
            "content_len": len(content_bytes),
            "content_magic": _magic(content),
            "content_zstd_len": _try_zstd(content_bytes) if content_bytes else None,
            "compress_len": len(compress) if isinstance(compress, (bytes, str)) else None,
            "compress_magic": _magic(compress) if compress is not None else "-",
        }
        records.append(record_out)
    types: dict[str, int] = {}
    for row in conn.execute(f'SELECT local_type, count(*) FROM "{table}" GROUP BY local_type ORDER BY 2 DESC LIMIT 20'):
        types[str(row[0])] = row[1]
    return {"table": table, "columns": columns, "localTypeCounts": types, "records": records}


def main() -> int:
    """命令行入口。"""
    parser = argparse.ArgumentParser(description="微信本地库结构诊断（只读）")
    parser.add_argument("--db", default="", help="指定库文件（默认 message_0.db）")
    parser.add_argument("--schema", default="", help="打印某表建表语句")
    parser.add_argument("--count", action="store_true", help="打印各表行数")
    parser.add_argument("--probe", default="", help="探测某消息表的内容编码（不输出正文）")
    parser.add_argument("--preview", default="", help="预览某表前 N 行（敏感，默认关闭）")
    parser.add_argument("--limit", type=int, default=3)
    args = parser.parse_args()

    account = account_path()
    config = load_config()
    file_key = dbkey.read_account_key(config["reader"]["accountDirectory"])
    db_path = pathlib.Path(args.db) if args.db else account / "db_storage" / "message" / "message_0.db"
    if not db_path.is_absolute():
        db_path = account / "db_storage" / "message" / db_path
    if not db_path.is_file():
        print(json.dumps({"ok": False, "code": "DB_UNREADABLE", "path": str(db_path)}, ensure_ascii=False))
        return 1
    try:
        conn = open_db(db_path, file_key)
    except Exception as error:  # noqa: BLE001 - 诊断工具需要原样报告
        print(json.dumps({"ok": False, "code": "OPEN_FAILED", "message": str(error)}, ensure_ascii=False))
        return 1
    try:
        names = tables(conn)
        print(json.dumps({"ok": True, "db": str(db_path), "tableCount": len(names), "tables": names[:200]}, ensure_ascii=False))
        if args.schema:
            row = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='table' AND name=?", (args.schema,)
            ).fetchone()
            print(row[0] if row else "(not found)")
        if args.count:
            counts = {}
            for name in names:
                try:
                    counts[name] = conn.execute(f'SELECT count(*) FROM "{name}"').fetchone()[0]
                except Exception:  # noqa: BLE001
                    counts[name] = None
            print(json.dumps({"counts": counts}, ensure_ascii=False))
        if args.probe:
            target = args.probe
            if target == "auto":
                target = next((name for name in names if name.startswith("Msg_")), "")
            print(json.dumps(probe_message_table(conn, target, args.limit), ensure_ascii=False))
        if args.preview:
            columns = [row[1] for row in conn.execute(f'PRAGMA table_info("{args.preview}")')]
            rows = conn.execute(f'SELECT * FROM "{args.preview}" LIMIT ?', (args.limit,)).fetchall()
            preview = []
            for row in rows:
                record = {}
                for name, value in zip(columns, row):
                    if isinstance(value, bytes):
                        record[name] = f"<bytes {len(value)}>"
                    elif isinstance(value, str):
                        record[name] = value[:80]
                    else:
                        record[name] = value
                preview.append(record)
            print(json.dumps({"columns": columns, "preview": preview}, ensure_ascii=False))
    finally:
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
