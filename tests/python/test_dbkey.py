"""M1 密钥校验与存储单测（手册 §11：正确/错误/坏输入；DPAPI；多账号迁移）。"""
from __future__ import annotations

import base64
import json
import os

import pytest

from lib.reader import dbkey


def test_verify_key_hmac_true_false_none(tmp_path):
    path = tmp_path / "message_0.db"
    conn = __import__("helpers").create_db(path)
    conn.close()
    assert dbkey.verify_key_hmac(__import__("helpers").PASSPHRASE, path) is True
    assert dbkey.verify_key_hmac("ff" * 32, path) is False
    assert dbkey.verify_key_hmac("zz" * 32, path) is None
    assert dbkey.verify_key_hmac(__import__("helpers").PASSPHRASE, tmp_path / "missing.db") is None


@pytest.mark.skipif(os.name != "nt", reason="DPAPI 仅 Windows")
def test_protect_unprotect_roundtrip():
    key = "ab" * 32
    stored = dbkey.protect_key(key)
    assert stored.startswith("userdpapi:")
    assert dbkey.unprotect_key(stored) == key
    assert "ab" * 4 not in stored


def test_protect_rejects_non_hex():
    with pytest.raises(dbkey.KeyErrorBase):
        dbkey.protect_key("not-a-key")


def test_unprotect_rejects_plaintext():
    with pytest.raises(dbkey.KeyErrorBase):
        dbkey.unprotect_key("ab" * 32)


def test_save_and_read_account_key(tmp_path, monkeypatch):
    monkeypatch.setattr(dbkey, "KEYS_PATH", tmp_path / "state" / "keys.json")
    record = dbkey.save_account_key("wxid_a_11aa", str(tmp_path / "wxid_a_11aa"), "cd" * 32)
    assert record["keySource"] == "wx_key.dll"
    assert dbkey.read_account_key("wxid_a_11aa") == "cd" * 32
    payload = json.loads((tmp_path / "state" / "keys.json").read_text(encoding="utf-8"))
    assert payload["version"] == 2
    assert "accounts" in payload


def test_v1_keys_migrated_to_v2(tmp_path, monkeypatch):
    keys_path = tmp_path / "state" / "keys.json"
    keys_path.parent.mkdir(parents=True, exist_ok=True)
    protected = dbkey.protect_key("ef" * 32) if os.name == "nt" else "userdpapi:" + base64.b64encode(b"x").decode()
    keys_path.write_text(json.dumps({
        "version": 1,
        "accountDirectory": "wxid_old_abcd",
        "accountPath": str(tmp_path / "wxid_old_abcd"),
        "keySource": "wx_key.dll",
        "capturedAt": "2026-01-01T00:00:00+0800",
        "key": protected,
    }), encoding="utf-8")
    monkeypatch.setattr(dbkey, "KEYS_PATH", keys_path)
    payload = dbkey.load_key_file()
    assert payload["version"] == 2
    assert "wxid_old_abcd" in payload["accounts"]
    migrated = json.loads(keys_path.read_text(encoding="utf-8"))
    assert migrated["version"] == 2
    assert migrated["accounts"]["wxid_old_abcd"]["key"] == protected


def test_read_missing_account_raises(tmp_path, monkeypatch):
    monkeypatch.setattr(dbkey, "KEYS_PATH", tmp_path / "state" / "keys.json")
    with pytest.raises(dbkey.KeyErrorBase) as error:
        dbkey.read_account_key("wxid_none_0000")
    assert error.value.code == "KEY_MISSING"
