"""读取层共享的密钥工具：SQLCipher page-1 HMAC 校验 + DPAPI 保护的 state/keys.json。

约定（手册 §5.2 / §9）：
- 明文密钥只在内存里出现，落盘只写 `userdpapi:<base64>`。
- keys.json 支持多账号：{version:2, accounts:{<账号目录>: {...}}}；v1 单账号格式自动迁移。
- 本模块不依赖 sqlcipher3，只用标准库 + DPAPI，便于配置阶段独立校验。
"""
from __future__ import annotations

import base64
import ctypes
from ctypes import wintypes
import hashlib
import hmac
import json
import os
import pathlib
import struct
import subprocess

ROOT = pathlib.Path(__file__).resolve().parent.parent.parent.parent
KEYS_PATH = ROOT / "state" / "keys.json"


class KeyErrorBase(Exception):
    """带错误码的密钥错误。"""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code
        self.message = message or code

    def __str__(self) -> str:  # pragma: no cover - 直接返回信息
        return f"{self.code}: {self.message}" if self.message else self.code


def verify_key_hmac(passphrase_hex: str, db_path: str | pathlib.Path) -> bool | None:
    """只用标准库校验 SQLCipher 4 page-1 HMAC。

    @returns True 密钥正确 / False 密钥错误 / None 输入或数据库不可读。
    """
    try:
        raw = bytes.fromhex(passphrase_hex)
    except ValueError:
        return None
    if len(raw) != 32:
        return None
    try:
        with open(db_path, "rb") as handle:
            page = handle.read(4096)
    except OSError:
        return None
    if len(page) < 4096 or page[:16] == b"\x00" * 16:
        return None
    salt = page[:16]
    mac_salt = bytes(byte ^ 0x3A for byte in salt)
    key = hashlib.pbkdf2_hmac("sha512", raw, salt, 256000, 32)
    mac_key = hashlib.pbkdf2_hmac("sha512", key, mac_salt, 2, 32)
    body_end = 4096 - 80 + 16
    mac = hmac.new(mac_key, page[16:body_end], hashlib.sha512)
    mac.update(struct.pack("<I", 1))
    return hmac.compare_digest(mac.digest(), page[body_end:body_end + 64])


class _Blob(ctypes.Structure):
    """Win32 DATA_BLOB。"""

    _fields_ = [("cbData", wintypes.DWORD), ("pbData", ctypes.POINTER(ctypes.c_ubyte))]


def _dpapi(value: str, protect: bool) -> str:
    """DPAPI 保护/解保护（仅 Windows）。"""
    if os.name != "nt":
        raise KeyErrorBase("READER_SECRET_UNAVAILABLE", "DPAPI 仅 Windows 可用")
    try:
        data = value.encode("utf-8") if protect else base64.b64decode(
            value.split(":", 1)[1], validate=True
        )
        buffer = (ctypes.c_ubyte * len(data)).from_buffer_copy(data)
        source, output = _Blob(len(data), buffer), _Blob()
        crypt = ctypes.WinDLL("crypt32", use_last_error=True)
        kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel.LocalFree.argtypes = [ctypes.c_void_p]
        kernel.LocalFree.restype = ctypes.c_void_p
        function = crypt.CryptProtectData if protect else crypt.CryptUnprotectData
        function.argtypes = [
            ctypes.POINTER(_Blob), ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p,
            ctypes.c_void_p, wintypes.DWORD, ctypes.POINTER(_Blob),
        ]
        function.restype = wintypes.BOOL
        if not function(ctypes.byref(source), None, None, None, None, 1, ctypes.byref(output)):
            raise KeyErrorBase("READER_SECRET_UNAVAILABLE", "DPAPI 调用失败")
        try:
            result = ctypes.string_at(output.pbData, output.cbData)
            return "userdpapi:" + base64.b64encode(result).decode("ascii") if protect else result.decode("utf-8")
        finally:
            kernel.LocalFree(output.pbData)
    except (ValueError, OSError, UnicodeError) as error:
        raise KeyErrorBase("READER_SECRET_UNAVAILABLE", str(error)) from None


def protect_key(key: str) -> str:
    """把 64-hex 密钥保护成 `userdpapi:...` 字符串。"""
    if not key or not all(char in "0123456789abcdefABCDEF" for char in key) or len(key) != 64:
        raise KeyErrorBase("KEY_INVALID", "密钥必须是 64-hex")
    return _dpapi(key, protect=True)


def unprotect_key(stored: str) -> str:
    """解保护 `userdpapi:...` 字符串，返回 64-hex 密钥。"""
    if not stored.startswith("userdpapi:"):
        raise KeyErrorBase("KEY_MISSING", "密钥不是 DPAPI 保护串（拒绝明文 'safe:' 旧格式）")
    key = _dpapi(stored, protect=False)
    if len(key) != 64 or not all(char in "0123456789abcdefABCDEF" for char in key):
        raise KeyErrorBase("KEY_INVALID", "解保护结果不是 64-hex")
    return key.lower()


def _restrict_file(path: pathlib.Path) -> None:
    """尽量收缩 keys.json 权限（Windows 用 icacls；失败不阻塞）。"""
    if os.name != "nt":
        try:
            path.chmod(0o600)
        except OSError:
            pass
        return
    user = os.environ.get("USERNAME", "")
    try:
        subprocess.run(
            ["icacls", str(path), "/inheritance:r", "/grant:r", f"{user}:F"],
            check=False, capture_output=True, timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def load_key_file() -> dict:
    """读取 keys.json（v1 自动迁移为 v2 结构）；不存在返回空 v2 骨架。"""
    if not KEYS_PATH.is_file():
        return {"version": 2, "accounts": {}}
    try:
        payload = json.loads(KEYS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise KeyErrorBase("KEY_FILE_INVALID", f"keys.json 不可读：{error}") from None
    if payload.get("version") == 1 and payload.get("accountDirectory"):
        account = str(payload["accountDirectory"])
        migrated = {
            "version": 2,
            "keyDllSha256": payload.get("keyDllSha256"),
            "accounts": {
                account: {
                    "accountPath": payload.get("accountPath"),
                    "keySource": payload.get("keySource", "manual"),
                    "capturedAt": payload.get("capturedAt"),
                    "key": payload.get("key"),
                }
            },
        }
        # 落盘迁移结果（保留原保护串，不重新加密）。
        KEYS_PATH.parent.mkdir(parents=True, exist_ok=True)
        tmp = KEYS_PATH.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(migrated, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(tmp, KEYS_PATH)
        _restrict_file(KEYS_PATH)
        return migrated
    if payload.get("version") != 2 or not isinstance(payload.get("accounts"), dict):
        raise KeyErrorBase("KEY_FILE_INVALID", "keys.json 版本/结构不受支持")
    return payload


def save_account_key(
    account_dir: str,
    account_path: str,
    key: str,
    *,
    key_source: str = "wx_key.dll",
    dll_sha256: str | None = None,
) -> dict:
    """写入/更新某账号的密钥；原子替换 keys.json。"""
    payload = load_key_file()
    payload["version"] = 2
    if dll_sha256:
        payload["keyDllSha256"] = dll_sha256
    payload.setdefault("accounts", {})[account_dir] = {
        "accountPath": account_path,
        "keySource": key_source,
        "capturedAt": __import__("time").strftime("%Y-%m-%dT%H:%M:%S%z"),
        "key": protect_key(key),
    }
    KEYS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = KEYS_PATH.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, KEYS_PATH)
    _restrict_file(KEYS_PATH)
    return payload["accounts"][account_dir]


def account_key(account_dir: str) -> dict:
    """取某账号的密钥记录；不存在抛 KEY_MISSING。"""
    payload = load_key_file()
    record = payload.get("accounts", {}).get(account_dir)
    if not record:
        raise KeyErrorBase("KEY_MISSING", f"state/keys.json 中没有账号 {account_dir} 的密钥")
    return record


def read_account_key(account_dir: str) -> str:
    """解保护读取某账号的 64-hex 密钥。"""
    return unprotect_key(account_key(account_dir)["key"])
