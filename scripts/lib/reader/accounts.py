"""微信账号目录探测（读取层与取密钥工具共用）。

判定标准（手册 §5.1）：目录内存在 `db_storage\\`，且 message/contact 子目录可读。
错误码：READER_PATH_MISSING / READER_DATABASE_MISSING / WECHAT_MULTIPLE_PROCESSES 由调用方组合。
"""
from __future__ import annotations

import os
import pathlib


class AccountError(Exception):
    """带错误码的账号探测错误。"""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


def _mtime(path: pathlib.Path) -> float:
    """文件 mtime；不存在返回 0。"""
    try:
        return path.stat().st_mtime
    except OSError:
        return 0.0


def candidate_roots(data_root: str = "") -> list[pathlib.Path]:
    """返回可能的账号目录扫描根（配置优先，其次注册表/常见位置）。"""
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
    return roots


def discover_accounts(data_root: str = "") -> list[dict]:
    """探测账号目录列表。

    @returns [{dbPath, myWxid, ready, messageMtime}]，按路径排序。
    """
    candidates: dict[str, dict] = {}
    for folder in candidate_roots(data_root):
        if folder.name.lower() == "db_storage":
            folder = folder.parent
        try:
            items = [folder] if (folder / "db_storage").is_dir() else [
                item for item in folder.iterdir() if item.is_dir()
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
    """选择账号：优先指定目录名；否则取最近写入的账号。"""
    if wanted:
        selected = [item for item in accounts if item["myWxid"].lower() == wanted.lower()]
        if len(selected) != 1:
            raise AccountError("READER_PATH_MISSING", f"找不到唯一账号目录：{wanted}")
        return selected[0]
    ready = [item for item in accounts if item["ready"]]
    if not ready:
        raise AccountError("READER_DATABASE_MISSING", "没有可读的账号目录（缺 message_0.db / contact.db）")
    return max(ready, key=lambda item: item["messageMtime"])


def clean_own_wxid(account_directory: str) -> str:
    """把账号目录名（wxid_xxx_abcd）还原成 wxid（wxid_xxx）。"""
    name = account_directory
    parts = name.rsplit("_", 1)
    if len(parts) == 2 and len(parts[1]) == 4 and parts[1].isalnum():
        return parts[0]
    return name
