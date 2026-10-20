#!/usr/bin/env python
"""从运行中的微信进程捕获本地 SQLCipher 库密钥（一次性配置工具）。

来源与许可说明：
- 调用契约（InitializeHook / PollKeyData / GetStatusMessage / CleanupHook）、
  进程识别与 DPAPI 用法参考自 WeChatAgent（MIT，Copyright (c) 2026 Derpyu520
  与 qq-bridge / QSH contributors）；本文件为 WXBOT 独立实现，保留此来源声明。
- wx_key.dll 为上游闭源组件，需用户自行取得授权并放入 state/tools/wx_key/；
  本仓库不分发该二进制（state/ 已 gitignore）。

用法：
    python scripts/capture-key.py --check          # 账号目录/数据库/微信状态探测
    python scripts/capture-key.py --capture        # 捕获密钥 -> HMAC 校验 -> DPAPI 落盘
    python scripts/capture-key.py --verify         # 校验 keys.json 中所有账号的密钥
    python scripts/capture-key.py --list-processes # 打印微信主进程识别结果
    python scripts/capture-key.py --capture --account wxid_xxx   # 指定目标账号

安全约定（手册 §1 / §9）：
- 密钥只在内存中出现，落盘只写 DPAPI 保护串 state/keys.json，不打印、不写日志。
- 只读取微信进程内存中的库密钥，不修改微信数据、不写库。
"""
from __future__ import annotations

import argparse
import ctypes
from ctypes import wintypes
import hashlib
import json
import os
import pathlib
import re
import sys
import time

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from lib.reader import dbkey  # noqa: E402  （依赖 sys.path 注入）

CONFIG_PATH = ROOT / "config" / "app.json"
KEY_DLL = ROOT / "state" / "tools" / "wx_key" / "wx_key.dll"
WECHAT_EXE = pathlib.Path(r"D:\Tencent\Weixin\Weixin.exe")
HEX64 = re.compile(r"^[0-9a-fA-F]{64}$")


class CaptureError(Exception):
    """带错误码的取密钥失败。"""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


def emit(event: dict) -> None:
    """打印一行 JSON 事件（不含密钥）。"""
    print(json.dumps(event, ensure_ascii=False), flush=True)


def _decode_ansi(raw: bytes) -> str:
    """解码 DLL 返回的 ANSI 文本（中文 Windows 为 GBK，混有 UTF-8 时兼容处理）。"""
    if not raw:
        return ""
    for encoding in ("utf-8", "gbk"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            continue
    return raw.decode("utf-8", errors="replace")


def load_config() -> dict:
    """读取 config/app.json；不存在时返回空配置。"""
    try:
        return json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _mtime(path: pathlib.Path) -> float:
    """文件 mtime；不存在返回 0。"""
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def discover_accounts(data_root: str = "") -> list[dict]:
    """探测微信账号目录（含 db_storage 的目录）。

    @param data_root 配置的 dataRoot；为空时按常见位置与注册表探测。
    @returns 账号列表 [{dbPath, myWxid, ready, messageMtime}]。
    """
    roots: list[pathlib.Path] = []
    if data_root:
        roots.append(pathlib.Path(data_root))
    else:
        home = pathlib.Path.home()
        documents = [home / "Documents", home]
        for name in ("OneDrive", "OneDriveConsumer", "OneDriveCommercial"):
            if os.environ.get(name):
                documents.append(pathlib.Path(os.environ[name]) / "Documents")
        if os.name == "nt":
            import winreg

            for key, value in (
                (r"Software\Microsoft\Windows\CurrentVersion\Explorer\User Shell Folders", "Personal"),
                (r"Software\Tencent\WeChat", "FileSavePath"),
                (r"Software\Tencent\Weixin", "FileSavePath"),
            ):
                try:
                    with winreg.OpenKey(winreg.HKEY_CURRENT_USER, key) as handle:
                        location = winreg.QueryValueEx(handle, value)[0]
                        if isinstance(location, str) and location not in ("", "MyDocument:"):
                            documents.append(pathlib.Path(os.path.expandvars(location)))
                except OSError:
                    pass
        for folder in documents:
            roots.extend([folder, folder / "xwechat_files", folder / "WeChat Files"])
        roots.append(pathlib.Path(r"D:\Tencent\xwechat_files"))

    candidates: dict[str, dict] = {}
    for folder in roots:
        if folder.name.lower() == "db_storage":
            folder = folder.parent
        try:
            items = [folder] if (folder / "db_storage").is_dir() else [
                p for p in folder.iterdir() if p.is_dir()
            ]
        except OSError:
            continue
        for candidate in items:
            if not (candidate / "db_storage").is_dir():
                continue
            try:
                full = str(candidate.resolve())
            except OSError:
                continue
            candidates[os.path.normcase(full)] = {
                "dbPath": full,
                "myWxid": candidate.name,
                "ready": (candidate / "db_storage" / "message" / "message_0.db").is_file()
                and (candidate / "db_storage" / "contact" / "contact.db").is_file(),
                "messageMtime": _mtime(candidate / "db_storage" / "message" / "message_0.db"),
            }
    return sorted(candidates.values(), key=lambda item: item["dbPath"].casefold())


def pick_account(accounts: list[dict], wanted: str = "") -> dict:
    """选择目标账号：优先指定账号目录，否则取最近写入的账号。"""
    if wanted:
        selected = [item for item in accounts if item["myWxid"].lower() == wanted.lower()]
        if len(selected) != 1:
            raise CaptureError("READER_PATH_MISSING", f"找不到唯一账号目录：{wanted}")
        return selected[0]
    ready = [item for item in accounts if item["ready"]]
    if not ready:
        raise CaptureError("READER_DATABASE_MISSING", "没有可读的账号目录（缺 message_0.db / contact.db）")
    return max(ready, key=lambda item: item["messageMtime"])


def message_db(account: dict) -> pathlib.Path:
    """账号的 message_0.db 路径。"""
    return pathlib.Path(account["dbPath"]) / "db_storage" / "message" / "message_0.db"


def wechat_pids(executable: pathlib.Path) -> list[int]:
    """返回微信主进程 pid 列表（排除同可执行的 renderer/utility 子进程）。"""
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)

    class ProcessEntry(ctypes.Structure):
        _fields_ = [
            ("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD),
            ("th32ProcessID", wintypes.DWORD), ("th32DefaultHeapID", ctypes.c_size_t),
            ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
            ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", wintypes.LONG),
            ("dwFlags", wintypes.DWORD), ("szExeFile", wintypes.WCHAR * 260),
        ]

    kernel.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel.Process32FirstW.argtypes = kernel.Process32NextW.argtypes = [
        wintypes.HANDLE, ctypes.POINTER(ProcessEntry)
    ]
    kernel.Process32FirstW.restype = kernel.Process32NextW.restype = wintypes.BOOL
    kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel.OpenProcess.restype = wintypes.HANDLE
    kernel.QueryFullProcessImageNameW.argtypes = [
        wintypes.HANDLE, wintypes.DWORD, wintypes.LPWSTR, ctypes.POINTER(wintypes.DWORD)
    ]
    kernel.QueryFullProcessImageNameW.restype = wintypes.BOOL
    kernel.CloseHandle.argtypes = [wintypes.HANDLE]
    kernel.CloseHandle.restype = wintypes.BOOL

    snapshot = kernel.CreateToolhelp32Snapshot(2, 0)
    if snapshot == ctypes.c_void_p(-1).value:
        raise CaptureError("READER_KEY_ACCESS_DENIED", "无法创建进程快照")
    matches: list[int] = []
    parents: dict[int, int] = {}
    denied = False
    try:
        entry = ProcessEntry()
        entry.dwSize = ctypes.sizeof(entry)
        exists = kernel.Process32FirstW(snapshot, ctypes.byref(entry))
        while exists:
            parents[entry.th32ProcessID] = entry.th32ParentProcessID
            if entry.szExeFile.casefold() == executable.name.casefold():
                process = kernel.OpenProcess(0x1000, False, entry.th32ProcessID)
                if process:
                    try:
                        size = wintypes.DWORD(32768)
                        full = ctypes.create_unicode_buffer(size.value)
                        if kernel.QueryFullProcessImageNameW(process, 0, full, ctypes.byref(size)):
                            if os.path.normcase(os.path.abspath(full.value)) == os.path.normcase(
                                os.path.abspath(str(executable))
                            ):
                                matches.append(entry.th32ProcessID)
                    finally:
                        kernel.CloseHandle(process)
                else:
                    denied = True
            exists = kernel.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel.CloseHandle(snapshot)
    if not matches and denied:
        raise CaptureError("READER_KEY_ACCESS_DENIED", "无法打开微信进程（权限不足）")
    return _main_process_pids(matches, parents)


def _main_process_pids(matches: list[int], parents: dict[int, int]) -> list[int]:
    """过滤出进程树根（父链里没有其他微信进程的才算主进程）。"""
    matching = set(matches)
    roots: list[int] = []
    for pid in dict.fromkeys(matches):
        ancestor = parents.get(pid, 0)
        seen = {pid}
        nested = False
        while ancestor:
            if ancestor in seen:
                raise CaptureError("WECHAT_PROCESS_IDENTITY_UNCLEAR", "进程父链存在环")
            if ancestor in matching:
                nested = True
                break
            seen.add(ancestor)
            ancestor = parents.get(ancestor, 0)
        if not nested:
            roots.append(pid)
    return roots


def load_key_library():
    """加载 wx_key.dll 并绑定导出函数签名。"""
    if not KEY_DLL.is_file():
        raise CaptureError(
            "READER_KEY_COMPONENT_MISSING",
            f"缺少 {KEY_DLL}（从 WeChatAgent 安装器提取后放入该路径）",
        )
    try:
        library = ctypes.CDLL(str(KEY_DLL))
        library.InitializeHook.argtypes = [wintypes.DWORD]
        library.InitializeHook.restype = ctypes.c_bool
        library.PollKeyData.argtypes = [ctypes.c_void_p, ctypes.c_int]
        library.PollKeyData.restype = ctypes.c_bool
        library.CleanupHook.argtypes = []
        library.CleanupHook.restype = ctypes.c_bool
        library.GetStatusMessage.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.POINTER(ctypes.c_int)]
        library.GetStatusMessage.restype = ctypes.c_bool
        library.GetLastErrorMsg.argtypes = []
        library.GetLastErrorMsg.restype = ctypes.c_char_p
    except (OSError, AttributeError) as error:
        raise CaptureError("READER_KEY_COMPONENT_MISSING", f"wx_key.dll 加载失败：{error}") from None
    return library


def capture_key(executable: pathlib.Path, account: dict, timeout: float = 120.0) -> str:
    """挂接微信进程轮询库密钥；返回 HMAC 校验通过的 64-hex 密钥。"""
    library = load_key_library()
    db_path = str(message_db(account))
    deadline = time.monotonic() + timeout
    attached: int | None = None
    observed = False
    buffer = ctypes.create_string_buffer(128)
    emit({
        "type": "progress",
        "message": "已加载 wx_key.dll，等待微信主进程并读取库密钥（不会修改微信数据）…",
    })
    try:
        while time.monotonic() < deadline:
            pids = wechat_pids(executable)
            if len(pids) > 1:
                raise CaptureError("WECHAT_MULTIPLE_PROCESSES", f"发现多个微信主进程：{pids}")
            pid = pids[0] if pids else None
            if attached is not None and pid != attached:
                library.CleanupHook()
                attached = None
            if pid is None:
                if not observed:
                    raise CaptureError("WECHAT_NOT_RUNNING", "微信未运行")
                time.sleep(0.5)
                continue
            if attached is None:
                if not library.InitializeHook(pid):
                    text = _decode_ansi(library.GetLastErrorMsg() or b"")
                    code = (
                        "READER_KEY_ACCESS_DENIED"
                        if ("ACCESS_DENIED" in text or "0xC0000022" in text)
                        else "READER_SETUP_FAILED"
                    )
                    raise CaptureError(code, f"InitializeHook 失败：{text}")
                attached = pid
                observed = True
                emit({"type": "progress", "message": f"已挂接微信主进程 pid={pid}，轮询密钥…"})
            if library.PollKeyData(buffer, len(buffer)):
                candidate = buffer.value.decode("ascii", errors="ignore")
                if HEX64.fullmatch(candidate):
                    verdict = dbkey.verify_key_hmac(candidate, db_path)
                    if verdict is True:
                        emit({"type": "progress", "message": "密钥已通过 SQLCipher page-1 HMAC 校验"})
                        return candidate
                    emit({
                        "type": "progress",
                        "message": "捕获到的密钥与目标账号库不匹配（可能登录的是另一个账号），继续等待…",
                    })
            for _ in range(8):
                status = ctypes.create_string_buffer(512)
                level = ctypes.c_int()
                if not library.GetStatusMessage(status, len(status), ctypes.byref(level)):
                    break
                text = _decode_ansi(status.value).strip()
                if text:
                    emit({"type": "status", "level": level.value, "message": text})
            time.sleep(0.12)
    finally:
        try:
            library.CleanupHook()
        except OSError:
            pass
    raise CaptureError(
        "READER_SETUP_TIMEOUT",
        f"{timeout:.0f}s 内未捕获到可用密钥：Hook 已挂上，但需要在微信中"
        "「退出登录 → 重新登录」触发密钥写入（本机微信版本可能与组件目标版本不同）",
    )


def _sha256(path: pathlib.Path) -> str | None:
    """文件 sha256；不存在返回 None。"""
    if not path.is_file():
        return None
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def check_command() -> int:
    """探测账号目录与数据库可读性。"""
    config = load_config()
    accounts = discover_accounts(config.get("reader", {}).get("dataRoot", ""))
    if not accounts:
        emit({"type": "result", "ok": False, "code": "READER_PATH_MISSING"})
        return 1
    active = pick_account(accounts, config.get("reader", {}).get("accountDirectory", ""))
    page = message_db(active)
    saved_accounts = []
    try:
        saved_accounts = sorted(dbkey.load_key_file().get("accounts", {}).keys())
    except dbkey.KeyErrorBase:
        saved_accounts = []
    emit({
        "type": "result",
        "ok": True,
        "accounts": accounts,
        "active": active,
        "sqlcipherPageReadable": _read_first_16(page) is not None,
        "wechatRunning": bool(wechat_pids(WECHAT_EXE)) if WECHAT_EXE.is_file() else False,
        "keyDllPresent": KEY_DLL.is_file(),
        "savedKeyAccounts": saved_accounts,
    })
    return 0


def _read_first_16(path: pathlib.Path) -> bytes | None:
    """读取数据库前 16 字节 salt；不可读返回 None。"""
    try:
        with open(path, "rb") as handle:
            return handle.read(16)
    except OSError:
        return None


def capture_command(timeout: float, wanted_account: str = "") -> int:
    """捕获密钥并保存。"""
    config = load_config()
    accounts = discover_accounts(config.get("reader", {}).get("dataRoot", ""))
    if not accounts:
        emit({"type": "result", "ok": False, "code": "READER_PATH_MISSING"})
        return 1
    wanted = wanted_account or config.get("reader", {}).get("accountDirectory", "")
    active = pick_account(accounts, wanted)
    try:
        key = capture_key(WECHAT_EXE, active, timeout)
        dbkey.save_account_key(
            active["myWxid"],
            active["dbPath"],
            key,
            key_source="wx_key.dll",
            dll_sha256=_sha256(KEY_DLL),
        )
        loaded = dbkey.read_account_key(active["myWxid"])
        if dbkey.verify_key_hmac(loaded, str(message_db(active))) is not True:
            raise CaptureError("KEY_REJECTED", "落盘后复核失败")
        emit({"type": "result", "ok": True, "account": active["myWxid"], "keySaved": True})
        return 0
    except dbkey.KeyErrorBase as error:
        emit({"type": "result", "ok": False, "code": error.code, "message": error.message})
        return 1
    except CaptureError as error:
        emit({"type": "result", "ok": False, "code": error.code, "message": error.message})
        return 1


def verify_command() -> int:
    """校验 keys.json 中所有账号的密钥（按记录的 accountPath 定位库）。"""
    try:
        payload = dbkey.load_key_file()
    except dbkey.KeyErrorBase as error:
        emit({"type": "result", "ok": False, "code": error.code, "message": error.message})
        return 1
    results = []
    ok = True
    for account_dir, record in sorted(payload.get("accounts", {}).items()):
        account_path = record.get("accountPath") or ""
        db = pathlib.Path(account_path) / "db_storage" / "message" / "message_0.db"
        try:
            key = dbkey.unprotect_key(record.get("key", ""))
            verdict = dbkey.verify_key_hmac(key, str(db))
        except dbkey.KeyErrorBase as error:
            results.append({"account": account_dir, "ok": False, "code": error.code})
            ok = False
            continue
        results.append({
            "account": account_dir,
            "ok": verdict is True,
            "code": None if verdict is True else "KEY_REJECTED",
            "dbPath": str(db),
            "capturedAt": record.get("capturedAt"),
            "keySource": record.get("keySource"),
        })
        ok = ok and verdict is True
    emit({"type": "result", "ok": ok and bool(results), "accounts": results})
    return 0 if ok and results else 1


def list_processes_command() -> int:
    """打印微信进程树识别结果（调试用）。"""
    if not WECHAT_EXE.is_file():
        emit({"type": "result", "ok": False, "code": "WECHAT_NOT_RUNNING", "message": f"缺少 {WECHAT_EXE}"})
        return 1
    pids = wechat_pids(WECHAT_EXE)
    emit({"type": "result", "ok": True, "executable": str(WECHAT_EXE), "mainProcessIds": pids})
    return 0


def inspect_command() -> int:
    """多账号密钥诊断：显示 keys.json 各账号的捕获信息与 HMAC 校验结果（不输出密钥）。"""
    config = load_config()
    active = str(config.get("reader", {}).get("accountDirectory", ""))
    try:
        payload = dbkey.load_key_file()
    except dbkey.KeyErrorBase as error:
        emit({"type": "result", "ok": False, "code": error.code, "message": error.message})
        return 1
    accounts = []
    any_valid = False
    for account_dir, record in sorted(payload.get("accounts", {}).items()):
        account_path = str(record.get("accountPath") or "")
        db_path = pathlib.Path(account_path) / "db_storage" / "message" / "message_0.db"
        item = {
            "accountDirectory": account_dir,
            "accountPath": account_path,
            "dbExists": db_path.is_file(),
            "capturedAt": record.get("capturedAt"),
            "keySource": record.get("keySource"),
            "keyDllSha256": record.get("keyDllSha256") or payload.get("keyDllSha256"),
            "active": account_dir.lower() == active.lower(),
        }
        try:
            key = dbkey.unprotect_key(record.get("key", ""))
            verdict = dbkey.verify_key_hmac(key, str(db_path)) if db_path.is_file() else None
            item["keyValid"] = verdict is True
            item["code"] = None if verdict is True else ("KEY_REJECTED" if verdict is False else "DB_UNREADABLE")
        except dbkey.KeyErrorBase as error:
            item["keyValid"] = False
            item["code"] = error.code
        any_valid = any_valid or item["keyValid"]
        accounts.append(item)
    result = {"type": "result", "ok": any_valid, "activeAccount": active, "accounts": accounts}
    active_valid = any(item["active"] and item.get("keyValid") for item in accounts)
    if not active_valid:
        result["hint"] = (
            "当前账号密钥不可用：运行 .venv\\Scripts\\python.exe scripts\\capture-key.py --capture，"
            "并在微信里「退出登录 → 重新登录」一次"
        )
    emit(result)
    return 0 if any_valid and active_valid else 1


def main() -> int:
    """命令行入口。"""
    parser = argparse.ArgumentParser(description="WXBOT 本地库密钥捕获工具")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--check", action="store_true", help="探测账号目录/数据库/微信状态")
    group.add_argument("--capture", action="store_true", help="捕获并 DPAPI 保存密钥")
    group.add_argument("--verify", action="store_true", help="校验 keys.json 中所有账号密钥")
    group.add_argument("--inspect", action="store_true", help="诊断多账号密钥（含 HMAC 结果，不输出密钥）")
    group.add_argument("--list-processes", action="store_true", help="列出微信主进程识别结果")
    parser.add_argument("--timeout", type=float, default=120.0, help="捕获超时秒数（默认 120）")
    parser.add_argument("--account", default="", help="目标账号目录名（默认读配置/最近活动账号）")
    args = parser.parse_args()
    if args.capture:
        return capture_command(args.timeout, args.account)
    if args.verify:
        return verify_command()
    if args.inspect:
        return inspect_command()
    if args.list_processes:
        return list_processes_command()
    return check_command()


if __name__ == "__main__":
    sys.exit(main())
