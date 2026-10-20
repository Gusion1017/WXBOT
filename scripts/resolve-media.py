#!/usr/bin/env python
"""图片解密子进程（手册 §5.7：子进程 + 超时 + 大小上限，避免一张坏图卡死 reader）。

stdin 一个 JSON：
    {"accountDir": "...", "ownWxid": "...", "talker": "...", "md5": "...",
     "imageAesKey": "", "imageXorKey": null, "maxBytes": 8388608}
stdout 最后一行 JSON：
    成功 {"ok": true, "b64": "...", "mime": "image/jpeg", "bytes": N, "file": "..."}
    失败 {"ok": false, "error": "IMAGE_*"}
"""
from __future__ import annotations

import base64
import json
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from lib.reader import wechat_media  # noqa: E402


def main() -> int:
    """入口：读描述 → 解码 → 输出 JSON。"""
    try:
        descriptor = json.loads(sys.stdin.read(65536))
    except (ValueError, OSError):
        print(json.dumps({"ok": False, "error": "IMAGE_DESCRIPTOR_INVALID"}))
        return 1
    try:
        account_dir = str(descriptor.get("accountDir", ""))
        own_wxid = str(descriptor.get("ownWxid", ""))
        talker = str(descriptor.get("talker", ""))
        md5 = str(descriptor.get("md5", ""))
        candidates = [str(item) for item in (descriptor.get("md5Candidates") or []) if item]
        if md5 and len(md5) == 32:
            candidates.append(md5)
        candidates = list(dict.fromkeys(candidates))
        fallbacks = [str(item) for item in (descriptor.get("fallbackNames") or []) if item]
        max_bytes = int(descriptor.get("maxBytes") or wechat_media.MAX_MEDIA_BYTES)
        if not account_dir or not talker or not candidates:
            raise wechat_media.MediaError("IMAGE_DESCRIPTOR_INVALID")
        keys = wechat_media.derive_image_keys(
            account_dir,
            own_wxid,
            image_aes_key=str(descriptor.get("imageAesKey", "") or ""),
            image_xor_key=descriptor.get("imageXorKey"),
        )
        if keys is None:
            raise wechat_media.MediaError("IMAGE_KEY_UNAVAILABLE", "无法派生/验证图片密钥")
        resolved = wechat_media.resolve_image_candidates(
            account_dir, talker, candidates,
            aes_key=keys["aesKey"], xor_key=keys["xorKey"],
            fallback_names=fallbacks, max_bytes=max_bytes,
        )
        print(json.dumps({
            "ok": True,
            "b64": base64.b64encode(resolved["data"]).decode("ascii"),
            "mime": resolved["mime"],
            "bytes": resolved["bytes"],
            "file": resolved["file"],
            "keySource": keys["source"],
        }, ensure_ascii=False))
        return 0
    except wechat_media.MediaError as error:
        print(json.dumps({"ok": False, "error": error.code, "message": error.message}, ensure_ascii=False))
        return 1
    except Exception as error:  # noqa: BLE001 - 子进程边界，只回错误类型
        print(json.dumps({"ok": False, "error": "IMAGE_RESOLUTION_FAILED", "message": type(error).__name__}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
