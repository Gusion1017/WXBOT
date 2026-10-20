"""M1/M2/M3 集成测试：合成 SQLCipher 库 → Reader → 会话/联系人/消息/轮询/图片（手册 §11）。"""
from __future__ import annotations

import hashlib
import pathlib
import time

import pytest

import helpers
from lib.reader import dbkey
from lib.reader import paths as paths_lib
from lib.reader import wechat_db


@pytest.fixture()
def synthetic(tmp_path, monkeypatch):
    """造合成账号 + 配置 + keys.json，并把这些路径指到临时目录。"""
    built = helpers.build_account(tmp_path)
    config_path = helpers.write_config(tmp_path, built["dataRoot"], built["accountDirectory"])
    keys_path = tmp_path / "state" / "keys.json"
    monkeypatch.setattr(paths_lib, "CONFIG_PATH", config_path)
    monkeypatch.setattr(dbkey, "KEYS_PATH", keys_path)
    dbkey.save_account_key(
        built["accountDirectory"], str(built["account"]), helpers.PASSPHRASE, key_source="test"
    )
    return built


def test_reader_initializes_and_reads(synthetic):
    reader = wechat_db.Reader(root=synthetic["root"])
    try:
        status = reader.status()
        assert status["ready"] is True
        assert status["backend"] == "sqlcipher-nt"
        assert status["accountDirectory"] == helpers.OWN_WXID
        assert reader.own_wxid == helpers.OWN_WXID.rsplit("_", 1)[0]
        assert status["shards"][0]["opened"] is True
        assert status["shardFailures"] == []
        assert status["imageKeySource"] == "config"
        assert status["keys"]["current"]["verified"] is True
        assert status["keys"]["current"]["accountDirectory"] == helpers.OWN_WXID
        account = next(item for item in status["keys"]["accounts"] if item["accountDirectory"] == helpers.OWN_WXID)
        assert account["dbExists"] is True
        assert account["active"] is True

        sessions = reader.sessions(10)
        assert [item["talker"] for item in sessions] == [helpers.GROUP_TALKER, helpers.FRIEND_TALKER]
        by_talker = {item["talker"]: item for item in sessions}
        assert by_talker[helpers.GROUP_TALKER]["displayName"] == "测试群"
        assert by_talker[helpers.FRIEND_TALKER]["displayName"] == "好友备注"
        assert by_talker[helpers.GROUP_TALKER]["sessionType"] == "group"

        contacts = {item["username"]: item for item in reader.contacts(limit=50)}
        assert contacts[helpers.FRIEND_TALKER]["displayName"] == "好友备注"
        assert contacts[helpers.GROUP_TALKER]["kind"] == "group"
        assert contacts[helpers.GROUP_TALKER]["ambiguous"] is False

        friend_messages = reader.messages(helpers.FRIEND_TALKER, 10)
        assert len(friend_messages) == 2
        assert friend_messages[0]["isSend"] == 1
        assert friend_messages[0]["content"] == "我自己的回复"
        assert friend_messages[1]["isSend"] == 0
        assert friend_messages[1]["content"] == "你好，这是合成测试消息"
        assert friend_messages[1]["senderDisplay"] == "好友备注"

        group_messages = reader.messages(helpers.GROUP_TALKER, 10)
        assert len(group_messages) == 3
        by_local = {item["localId"]: item for item in group_messages}
        quote = by_local[2]
        assert "回你一句" in quote["content"]
        assert "被引用的原话" in quote["content"]
        assert quote["quoteReply"]["reference"]["text"] == "被引用的原话"
        assert by_local[1]["content"] == "[图片]"
        image = by_local[3]
        assert image["content"] == "[图片]"
        assert image["image"]["id"] and len(image["image"]["id"]) == 64
        assert image["rawid"] and len(image["rawid"]) == 64
    finally:
        reader.close()


def test_image_resolution_end_to_end(synthetic):
    """图片消息 → image.id → 子进程解密 → 落盘 JPEG。"""
    reader = wechat_db.Reader(root=synthetic["root"])
    try:
        messages = reader.messages(helpers.GROUP_TALKER, 10)
        image = next(item for item in messages if item["localId"] == 3)
        resolved = reader.resolve_image(image["image"]["id"])
        assert resolved["success"] is True
        assert resolved["mime"] == "image/jpeg"
        data = pathlib.Path(resolved["savedFile"]).read_bytes()
        assert data.startswith(b"\xff\xd8")
        assert len(data) == resolved["bytes"]
        # 第二次命中缓存
        again = reader.resolve_image(image["image"]["id"])
        assert again["imageId"] == resolved["imageId"]
        assert reader.status()["imagesRegistered"] >= 1
    finally:
        reader.close()


def test_whitelist_blocks_and_allows(synthetic):
    reader = wechat_db.Reader(root=synthetic["root"])
    try:
        reader.config["wechat"]["whitelist"]["private"] = ["wxid_nobody"]
        with pytest.raises(PermissionError):
            reader.messages(helpers.FRIEND_TALKER, 5)
        with pytest.raises(PermissionError):
            reader.messages(helpers.GROUP_TALKER, 5)

        reader.config["wechat"]["whitelist"]["private"] = [helpers.FRIEND_TALKER]
        assert len(reader.messages(helpers.FRIEND_TALKER, 5)) == 2
    finally:
        reader.close()


def test_whitelist_enabled_denies_by_default(synthetic):
    """M3 验收：开启白名单且列表为空时，任何会话读取都返回 403 语义。"""
    reader = wechat_db.Reader(root=synthetic["root"])
    try:
        reader.config["wechat"]["whitelist"]["enabled"] = True
        with pytest.raises(PermissionError):
            reader.messages(helpers.FRIEND_TALKER, 5)
        reader.config["wechat"]["whitelist"]["private"] = [helpers.FRIEND_TALKER]
        assert len(reader.messages(helpers.FRIEND_TALKER, 5)) == 2
        with pytest.raises(PermissionError):
            reader.messages(helpers.GROUP_TALKER, 5)
    finally:
        reader.close()


def test_poll_pushes_new_message_and_dedupes(synthetic):
    reader = wechat_db.Reader(root=synthetic["root"])
    try:
        client = reader.subscribe()
        conn = helpers.open_write(
            pathlib.Path(synthetic["account"]) / "db_storage" / "message" / "message_0.db"
        )
        table = "Msg_" + hashlib.md5(helpers.FRIEND_TALKER.encode()).hexdigest()
        conn.execute(
            f'INSERT INTO "{table}" (local_id, server_id, local_type, real_sender_id, create_time, '
            "message_content) VALUES (?,?,?,?,?,?)",
            (3, 3001, 1, 3, int(time.time()), helpers.compress("轮询新消息")),
        )
        conn.commit()
        conn.close()

        assert reader.poll_once() >= 1
        payload = client.get_nowait()
        assert payload["event"] == "message.new"
        assert payload["sessionType"] == "private"
        assert payload["content"] == "轮询新消息"
        assert payload["senderName"] == "好友备注"
        assert payload["rawid"]

        # 同一轮询不会重复推送
        assert reader.poll_once() == 0
        assert reader.status()["pushed"] >= 1
    finally:
        reader.close()


def test_shard_failure_is_reported_not_silent(synthetic):
    broken = pathlib.Path(synthetic["account"]) / "db_storage" / "message" / "message_1.db"
    conn = helpers.create_db(broken, passphrase_hex="ff" * 32)
    conn.execute("CREATE TABLE placeholder (x INTEGER)")
    conn.commit()
    conn.close()

    reader = wechat_db.Reader(root=synthetic["root"])
    try:
        failures = reader.status()["shardFailures"]
        assert any(item["name"] == "message_1.db" for item in failures)
        # 其余分片仍可读
        assert len(reader.messages(helpers.FRIEND_TALKER, 5)) == 2
    finally:
        reader.close()


def test_shard_discovery_excludes_fts_and_resource(synthetic):
    """分片发现要排除 message_fts.db / message_resource.db（手册 §5.3）。"""
    message_dir = pathlib.Path(synthetic["account"]) / "db_storage" / "message"
    for name in ("message_fts.db", "message_resource.db"):
        conn = helpers.create_db(message_dir / name)
        conn.execute("CREATE TABLE placeholder (x INTEGER)")
        conn.commit()
        conn.close()
    reader = wechat_db.Reader(root=synthetic["root"])
    try:
        names = [path.name for path in reader.discover_shards()]
        assert names == ["message_0.db"]
        assert [item["name"] for item in reader.status()["shards"]] == ["message_0.db"]
    finally:
        reader.close()


def test_wrong_key_reports_key_rejected(synthetic):
    """手册 §11 故障注入：密钥改错 → KEY_REJECTED，不崩、不静默。"""
    dbkey.save_account_key(
        synthetic["accountDirectory"], str(synthetic["account"]), "bb" * 32, key_source="test"
    )
    with pytest.raises(wechat_db.ReaderError) as error:
        wechat_db.Reader(root=synthetic["root"])
    assert error.value.code == "KEY_REJECTED"


def test_retry_event_pushes_exact_message(synthetic):
    reader = wechat_db.Reader(root=synthetic["root"])
    try:
        client = reader.subscribe()
        pushed = reader.retry_event(helpers.FRIEND_TALKER, 1, 1790000001)
        assert pushed is True
        payload = client.get_nowait()
        assert payload["content"] == "你好，这是合成测试消息"
        assert reader.retry_event(helpers.FRIEND_TALKER, 1, 1790000001) is False
    finally:
        reader.close()
