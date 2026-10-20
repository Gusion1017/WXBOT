#!/usr/bin/env python
"""给固定版微信 4.1.10.27 打“共存补丁”：让机器人的微信能和用户自己的微信同时运行。

参考 zetaloop/BetterWX 的 coexist 思路（Unlicense），针对本项目 4.1.10.27 客户端选择
最小等长字节修改，不改动 Hook 所需偏移：

1. XWeChat_App_Instance_Identity_Mutex_Name -> ...NamN    （单实例互斥锁改名）
2. xWechatWindow -> xWechatWindoN                        （窗口类名改名）
3. host-redirect.xml -> host-redirect.xmN                （自动登录重定向文件改名）

不修改 Weixin.exe / 文件名，因此 Hook 仍按 Weixin.dll 加载，偏移不变。
原 DLL 备份到 state/backups/weixin-4.1.10.27-original.dll。

用法：
    python scripts/dev/patch-wechat-coexist.py
    python scripts/dev/patch-wechat-coexist.py --index 2
    python scripts/dev/patch-wechat-coexist.py --restore
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
CLIENT = ROOT / "state" / "wechat-hook-client"
DLL = CLIENT / "4.1.10.27" / "Weixin.dll"
BACKUP = ROOT / "state" / "backups" / "weixin-4.1.10.27-original.dll"
INFO = ROOT / "state" / "research" / "coexist-patch.json"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def patch_once(data: bytes, old: bytes, new: bytes, label: str) -> bytes:
    if len(old) != len(new):
        raise SystemExit(f"{label}: 替换长度不一致 {len(old)} != {len(new)}")
    count = data.count(old)
    if count != 1:
        raise SystemExit(f"{label}: 期望出现 1 次，实际 {count} 次（客户端版本可能不匹配）")
    if data.count(new) > 0:
        raise SystemExit(f"{label}: 补丁似乎已经打过了（新特征已存在）")
    print(f"  {label}: 1 处 -> {new[:48]!r}")
    return data.replace(old, new)


def main() -> int:
    parser = argparse.ArgumentParser(description="WeChat 4.1.10.27 共存补丁")
    parser.add_argument("--index", type=int, default=2, help="共存编号 0-9（默认 2）")
    parser.add_argument("--restore", action="store_true", help="从备份恢复原始 DLL")
    args = parser.parse_args()
    if not DLL.is_file():
        raise SystemExit(f"找不到 Weixin.dll：{DLL}")
    BACKUP.parent.mkdir(parents=True, exist_ok=True)
    if not BACKUP.is_file():
        print(f"备份原始 DLL -> {BACKUP}")
        shutil.copy2(DLL, BACKUP)
    if args.restore:
        print(f"恢复原始 DLL：{BACKUP} -> {DLL}")
        shutil.copy2(BACKUP, DLL)
        return 0
    index = args.index
    if not (0 <= index <= 9):
        raise SystemExit("--index 必须在 0-9")
    data = BACKUP.read_bytes()  # 总是从原始备份开始，避免重复补丁
    suffix = str(index)
    mutex_old = "XWeChat_App_Instance_Identity_Mutex_Name"
    mutex_new = mutex_old[:-1] + suffix
    window_old = "xWechatWindow"
    window_new = window_old[:-1] + suffix
    host_old = "host-redirect.xml"
    host_new = "host-redirect.xm" + suffix
    print(f"目标：{DLL}")
    print(f"原始 sha256={sha256(BACKUP)}")
    data = patch_once(data, mutex_old.encode("utf-16le"), mutex_new.encode("utf-16le"), "Mutex 名")
    data = patch_once(data, window_old.encode("utf-16le"), window_new.encode("utf-16le"), "窗口类名")
    data = patch_once(data, host_old.encode("ascii"), host_new.encode("ascii"), "自动登录文件")
    print(f"写入补丁后 DLL（大小不变：{len(data)}）")
    DLL.write_bytes(data)
    info = {
        "patchedAt": datetime.now().astimezone().isoformat(),
        "index": index,
        "dll": str(DLL),
        "original": str(BACKUP),
        "originalSha256": sha256(BACKUP),
        "patchedSha256": sha256(DLL),
        "replacements": {
            "mutex": [mutex_old, mutex_new],
            "window": [window_old, window_new],
            "hostRedirect": [host_old, host_new],
        },
        "source": "zetaloop/BetterWX coexist 思路（Unlicense），适配 4.1.10.27",
    }
    INFO.parent.mkdir(parents=True, exist_ok=True)
    INFO.write_text(json.dumps(info, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"完成。补丁信息：{INFO}")
    print("请重新启动固定版微信。若要恢复原版：--restore")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
