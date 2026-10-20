"""测试辅助：合成 SQLCipher 库（不依赖真实微信）。

手册 §11：用 sqlcipher 造合成库（固定页参数）跑完整读取链路。
"""
from __future__ import annotations

import hashlib
import json
import os
import pathlib

import zstandard
from sqlcipher3 import dbapi2

PASSPHRASE = "a1" * 32  # 64-hex
OWN_WXID = "wxid_selftest_abcd"
GROUP_TALKER = "12345678@chatroom"
FRIEND_TALKER = "wxid_friend_abcd"
IMAGE_MD5 = "ab" * 16
IMAGE_AES_KEY_HEX = "11" * 16
IMAGE_XOR_KEY = 7


def _derived(path: pathlib.Path, passphrase_hex: str) -> str:
    """按文件自己的 salt 派生 raw key（与 Reader._open 一致）。"""
    salt = path.read_bytes()[:16]
    key = hashlib.pbkdf2_hmac("sha512", bytes.fromhex(passphrase_hex), salt, 256000, 32)
    return key.hex() + salt.hex()


def create_db(path: pathlib.Path, passphrase_hex: str = PASSPHRASE):
    """新建一个合成 SQLCipher 库并返回连接（调用方负责 commit/close）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    salt = os.urandom(16)
    key = hashlib.pbkdf2_hmac("sha512", bytes.fromhex(passphrase_hex), salt, 256000, 32)
    conn = dbapi2.connect(str(path), check_same_thread=False)
    conn.execute(f'PRAGMA key = "x\'{key.hex()}{salt.hex()}\'";')
    conn.execute("CREATE TABLE _bootstrap (id INTEGER)")
    conn.execute("DROP TABLE _bootstrap")
    return conn


def open_write(path: pathlib.Path, passphrase_hex: str = PASSPHRASE):
    """只写打开已有合成库（用于插入新消息验证轮询）。"""
    conn = dbapi2.connect(str(path), check_same_thread=False)
    conn.execute(f'PRAGMA key = "x\'{_derived(path, passphrase_hex)}\'";')
    conn.execute("SELECT count(*) FROM sqlite_master").fetchone()
    return conn


def compress(text: str) -> bytes:
    """消息内容按微信 4.x 的做法存 zstd BLOB。"""
    return zstandard.ZstdCompressor().compress(text.encode("utf-8"))


def make_v2_dat(plaintext: bytes, aes_key: bytes, xor_key: int) -> bytes:
    """构造一个 V2 图片容器（供测试解密；无 XOR 尾段时 xor_size=0）。"""
    import struct

    from Crypto.Cipher import AES
    from Crypto.Util import Padding

    magic = b"\x07\x08V2\x08\x07"
    aes_size = len(plaintext)
    header = struct.pack("<6sLLx", magic, aes_size, 0)
    encrypted = AES.new(aes_key, AES.MODE_ECB).encrypt(Padding.pad(plaintext, 16))
    return header + encrypted


def _name2id(conn) -> None:
    conn.execute("CREATE TABLE Name2Id (user_name TEXT PRIMARY KEY, is_session INTEGER)")
    conn.executemany(
        "INSERT INTO Name2Id (user_name, is_session) VALUES (?, ?)",
        [(GROUP_TALKER, 1), (OWN_WXID, 0), (FRIEND_TALKER, 0)],
    )


def _msg_table(conn, talker: str) -> str:
    table = "Msg_" + hashlib.md5(talker.encode()).hexdigest()
    conn.execute(
        f'CREATE TABLE "{table}" (local_id INTEGER PRIMARY KEY AUTOINCREMENT, server_id INTEGER, '
        "local_type INTEGER, sort_seq INTEGER, real_sender_id INTEGER, create_time INTEGER, "
        "status INTEGER, upload_status INTEGER, download_status INTEGER, server_seq INTEGER, "
        "origin_source INTEGER, source TEXT, message_content TEXT, compress_content TEXT, "
        "packed_info_data BLOB, WCDB_CT_message_content INTEGER DEFAULT NULL, "
        "WCDB_CT_source INTEGER DEFAULT NULL)"
    )
    return table


def build_account(root: pathlib.Path) -> dict:
    """在 root 下造一个可被 Reader 读取的合成账号（含 contact/session/message 库）。"""
    account = root / "data" / "wxid_selftest_abcd"
    db_storage = account / "db_storage"
    message_dir = db_storage / "message"
    contact_dir = db_storage / "contact"
    session_dir = db_storage / "session"
    for folder in (message_dir, contact_dir, session_dir):
        folder.mkdir(parents=True, exist_ok=True)

    contact = create_db(contact_dir / "contact.db")
    contact.execute(
        "CREATE TABLE contact (id INTEGER PRIMARY KEY, username TEXT, local_type INTEGER, "
        "alias TEXT, encrypt_username TEXT, flag INTEGER, delete_flag INTEGER, "
        "verify_flag INTEGER, remark TEXT, nick_name TEXT)"
    )
    contact.executemany(
        "INSERT INTO contact (id, username, local_type, alias, remark, nick_name) VALUES (?,?,?,?,?,?)",
        [
            (1, OWN_WXID, 1, "", "", "我自己"),
            (2, FRIEND_TALKER, 1, "", "好友备注", "好友昵称"),
            (3, GROUP_TALKER, 1, "", "", "测试群"),
        ],
    )
    contact.commit()
    contact.close()

    session = create_db(session_dir / "session.db")
    session.execute(
        "CREATE TABLE SessionTable (username TEXT PRIMARY KEY, type INTEGER, unread_count INTEGER, "
        "unread_first_msg_srv_id INTEGER, unread_first_pat_msg_local_id INTEGER, "
        "unread_first_pat_msg_sort_seq INTEGER, is_hidden INTEGER, summary TEXT, draft TEXT, "
        "status INTEGER, last_timestamp INTEGER, sort_timestamp INTEGER, "
        "last_clear_unread_timestamp INTEGER, last_msg_locald_id INTEGER, last_msg_type INTEGER, "
        "last_msg_sub_type INTEGER, last_msg_sender TEXT, last_sender_display_name TEXT, "
        "last_msg_ext_type INTEGER)"
    )
    session.executemany(
        "INSERT INTO SessionTable (username, type, unread_count, is_hidden, summary, "
        "last_timestamp, sort_timestamp, last_msg_type, last_msg_sender, last_sender_display_name) "
        "VALUES (?,?,?,?,?,?,?,?,?,?)",
        [
            (GROUP_TALKER, 0, 2, 0, "", 1790000200, 1790000200, 3, FRIEND_TALKER, "好友"),
            (FRIEND_TALKER, 0, 0, 0, "", 1790000100, 1790000100, 1, FRIEND_TALKER, "好友"),
        ],
    )
    session.commit()
    session.close()

    message = create_db(message_dir / "message_0.db")
    _name2id(message)
    friend_table = _msg_table(message, FRIEND_TALKER)
    group_table = _msg_table(message, GROUP_TALKER)
    message.executemany(
        f'INSERT INTO "{friend_table}" (local_id, server_id, local_type, real_sender_id, '
        "create_time, message_content) VALUES (?,?,?,?,?,?)",
        [
            (1, 1001, 1, 3, 1790000001, compress("你好，这是合成测试消息")),
            (2, 1002, 1, 2, 1790000002, compress("我自己的回复")),
        ],
    )
    message.executemany(
        f'INSERT INTO "{group_table}" (local_id, server_id, local_type, real_sender_id, '
        "create_time, message_content) VALUES (?,?,?,?,?,?)",
        [
            (1, 2001, 3, 2, 1790000003, compress("<msg><img md5=\"x\" /></msg>")),
            (
                2,
                2002,
                244813135921,
                3,
                1790000004,
                compress(
                    "<msg><appmsg><title>回你一句</title><type>57</type>"
                    "<refermsg><type>1</type><svrid>1001</svrid><fromusr>" + FRIEND_TALKER + "</fromusr>"
                    "<chatusr>" + FRIEND_TALKER + "</chatusr><displayname>好友</displayname>"
                    "<content>被引用的原话</content><createtime>1790000001</createtime>"
                    "</refermsg></appmsg></msg>"
                ),
            ),
            (
                3,
                2003,
                3,
                2,
                1790000005,
                compress(f'<msg><img md5="{IMAGE_MD5}" /></msg>'),
            ),
        ],
    )
    message.commit()
    message.close()

    # 图片文件：msg/attach/<md5(群)>/<YYYY-MM>/Img/<md5>.dat（V2 容器）
    long_md5 = hashlib.md5(GROUP_TALKER.encode()).hexdigest()
    image_dir = account / "msg" / "attach" / long_md5 / "2026-01" / "Img"
    image_dir.mkdir(parents=True, exist_ok=True)
    jpeg = b"\xff\xd8\xff\xe0" + b"wxbot-test-image".ljust(28, b"\x00")
    (image_dir / f"{IMAGE_MD5}.dat").write_bytes(
        make_v2_dat(jpeg, bytes.fromhex(IMAGE_AES_KEY_HEX), IMAGE_XOR_KEY)
    )
    return {
        "account": account,
        "accountDirectory": account.name,
        "dataRoot": str(root / "data"),
        "root": root,
    }


def write_config(root: pathlib.Path, data_root: str, account_directory: str) -> pathlib.Path:
    """写一份最小可用的 config/app.json。"""
    config_path = root / "config" / "app.json"
    config_path.parent.mkdir(parents=True, exist_ok=True)
    config = {
        "version": 1,
        "project": "WXBOT",
        "ports": {"reader": 5031, "adapter": 8766, "onebot": 11229, "aiRuntime": 11230, "console": 3210},
        "reader": {
            "backend": "sqlcipher-nt",
            "dataRoot": data_root,
            "accountDirectory": account_directory,
            "pollIntervalMs": 1000,
            "startupGraceSec": 3,
            "dedupeCapacity": 5000,
            "keySource": "manual",
            "imageAesKey": IMAGE_AES_KEY_HEX,
            "imageXorKey": IMAGE_XOR_KEY,
            "media": {"enabled": True, "cacheDir": "state/media", "maxBytes": 8388608},
        },
        "wechat": {
            "whitelist": {"enabled": False, "groups": [], "private": []},
            "minIntervalMs": {"group": 15000, "private": 1000},
            "quota": {"perMinute": 3, "perTenMinutes": 10},
        },
        "logging": {"level": "info", "dir": "state/logs", "includeChatContent": False},
    }
    config_path.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    return config_path
