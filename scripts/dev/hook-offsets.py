#!/usr/bin/env python
"""Hook 偏移研究工具：从旧版 Weixin.dll 的目标偏移提取带指针掩码的签名，在新版中搜索候选。

用法：
    python scripts/dev/hook-offsets.py --list                  # 列出内置源码偏移表
    python scripts/dev/hook-offsets.py --old old.dll --new new.dll
    python scripts/dev/hook-offsets.py --old old.dll --new new.dll --length 64 --json

说明：
- 偏移是 RVA（相对模块基址），工具按 PE 节表转换到文件偏移。
- 签名中落在 [ImageBase, ImageBase+SizeOfImage) 的 8 字节值（绝对地址/vtable 指针）会被掩码。
- 结果只是"候选"，必须动态/反汇编验证；大版本重排时匹配率可能很低。
"""
from __future__ import annotations

import argparse
import json
import re
import struct
import sys
from pathlib import Path

# 来自 aixed/WeChat-Hook v411027_（include/global.h）
OFFSETS = {
    "XWECHAT_MAIN_CLAZZ_OFFSET": 0xA83AB20,
    "g_Patch_Revoke": 0x22D09E7,
    "XWECHAT_SQLITE3_VFS_OFFSET": 0xA6C0490,
    "XWECHAT_SQLITE3_API_ROUTINES_OFFSET": 0x8BB0D38,
    "XWECHAT_SQLCIPHER_API_ROUTINES_OFFSET": 0x8BB1570,
    "XWECHAT_SQLITE3_CODEC_GET_KEY_FUNC": 0x4EE64D0,
    "offset.send_message": 0x1677A30,
    "offset.create_param2": 0xDF40,
    "offset.txt_message_ctr": 0x6B2C30,
    "offset.txt_message_vtbl": 0x8279358,
    "offset.param1_vtable": 0x84EC9C8,
    "offset.param2": 0xA0CE0B0,
    "offset.param2_1": 0x8595F58,
    "offset.param2_2": 0x8595E98,
    "offset.param2_3": 0x8595DD8,
    "offset.img_msg_vtbl": 0x84F96B8,
    "offset.img_msg_vtb2": 0x84F9748,
    "offset.dec_pic_call": 0x493E70,
    "Offsets.IMAGE_FIELD_VTABLE": 0x80D1098,
    "Offsets.IMAGE_FIELD_VTABLE2": 0x80D1128,
    "Offsets.IMAGE_DATA_VTABLE": 0x7415D28,
    "Offsets.IMAGE_DATA_VTABLE2": 0x7415DB8,
    "Offsets.VIDEO_FIELD_VTABLE": 0x750C7F8,
    "Offsets.VIDEO_FIELD_VTABLE2": 0x750C888,
    "Offsets.ANIMATION_FIELD_VTABLE": 0x750CC18,
    "Offsets.ANIMATION_FIELD_VTABLE2": 0x750CCA8,
    "Offsets.MESSAGE_STRUCT_VTABLE": 0x76BD388,
    "Offsets.MESSAGE_STRUCT_VTABLE2": 0x76BD338,
    "Offsets.MESSAGE_PARAM_VTABLE": 0x76BCF38,
    "Offsets.FORWARD_XML_CALL": 0x1CF3D20,
}


class PeFile:
    """最小 PE 解析：ImageBase / SizeOfImage / RVA↔文件偏移。"""

    def __init__(self, path: Path):
        self.path = path
        self.data = path.read_bytes()
        if self.data[:2] != b"MZ":
            raise ValueError(f"不是 PE 文件：{path}")
        e_lfanew = struct.unpack_from("<I", self.data, 0x3C)[0]
        if self.data[e_lfanew:e_lfanew + 4] != b"PE\0\0":
            raise ValueError(f"缺少 PE 头：{path}")
        coff = e_lfanew + 4
        machine, section_count, _, _, _, optional_size, _ = struct.unpack_from("<HHIIIHH", self.data, coff)
        self.machine = machine
        opt = coff + 20
        magic = struct.unpack_from("<H", self.data, opt)[0]
        if magic == 0x20B:
            self.image_base = struct.unpack_from("<Q", self.data, opt + 24)[0]
            self.size_of_image = struct.unpack_from("<I", self.data, opt + 56)[0]
        elif magic == 0x10B:
            self.image_base = struct.unpack_from("<I", self.data, opt + 28)[0]
            self.size_of_image = struct.unpack_from("<I", self.data, opt + 56)[0]
        else:
            raise ValueError(f"未知 PE 可选头 magic：0x{magic:x}")
        self.sections = []
        sec = opt + optional_size
        for index in range(section_count):
            raw = self.data[sec + index * 40: sec + (index + 1) * 40]
            name = raw[:8].rstrip(b"\0").decode("ascii", "replace")
            virtual_size, virtual_address, raw_size, raw_ptr = struct.unpack_from("<IIII", raw, 8)
            self.sections.append({
                "name": name,
                "rva": virtual_address,
                "vsize": virtual_size,
                "raw_size": raw_size,
                "raw_ptr": raw_ptr,
            })

    def rva_to_offset(self, rva: int) -> int | None:
        for section in self.sections:
            start = section["rva"]
            size = max(section["vsize"], section["raw_size"])
            if start <= rva < start + size:
                delta = rva - start
                return section["raw_ptr"] + delta
        return None

    def offset_to_rva(self, offset: int) -> int | None:
        for section in self.sections:
            if section["raw_ptr"] <= offset < section["raw_ptr"] + section["raw_size"]:
                return section["rva"] + (offset - section["raw_ptr"])
        return None

    def is_pointer_like(self, value: int) -> bool:
        return self.image_base <= value < self.image_base + self.size_of_image


def build_pattern(pe: PeFile, rva: int, length: int) -> tuple[bytes, bytes] | None:
    """提取 (pattern, mask)；mask=1 表示参与比较，0 表示通配。"""
    file_offset = pe.rva_to_offset(rva)
    if file_offset is None:
        return None
    raw = pe.data[file_offset:file_offset + length]
    if len(raw) < length:
        return None
    mask = bytearray(b"\x01" * length)
    for index in range(0, length - 7):
        value = struct.unpack_from("<Q", raw, index)[0]
        if pe.is_pointer_like(value):
            mask[index:index + 8] = b"\x00" * 8
    return raw, bytes(mask)


def count_candidates(new_pe: PeFile, pattern: bytes, mask: bytes) -> list[int]:
    """在 new_pe 中搜索掩码签名，返回候选 RVA 列表。"""
    data = new_pe.data
    hits = []
    start = 0
    while True:
        index = data.find(pattern[:8], start)
        if index < 0:
            break
        if all((mask[i] == 0) or (data[index + i] == pattern[i]) for i in range(len(pattern))):
            rva = new_pe.offset_to_rva(index)
            if rva is not None:
                hits.append(rva)
        start = index + 1
    return hits


def command_list() -> int:
    print(f"{'name':<42} {'RVA':>10}")
    for name, rva in OFFSETS.items():
        print(f"{name:<42} 0x{rva:09X}")
    print(f"\n共 {len(OFFSETS)} 个偏移；来源 aixed/WeChat-Hook v411027_ include/global.h")
    return 0


def command_compare(old_path: Path, new_path: Path, length: int, as_json: bool) -> int:
    old_pe = PeFile(old_path)
    new_pe = PeFile(new_path)
    rows = []
    for name, rva in OFFSETS.items():
        item = {"name": name, "oldRva": rva, "oldOffset": old_pe.rva_to_offset(rva)}
        built = build_pattern(old_pe, rva, length)
        if built is None:
            item["status"] = "old_offset_out_of_range"
            rows.append(item)
            continue
        pattern, mask = built
        hits = count_candidates(new_pe, pattern, mask)
        item["candidates"] = hits[:8]
        item["candidateCount"] = len(hits)
        if len(hits) == 1:
            item["status"] = "unique"
            item["delta"] = hits[0] - rva
        elif len(hits) > 1:
            item["status"] = "ambiguous"
        else:
            item["status"] = "not_found"
        rows.append(item)
    if as_json:
        print(json.dumps({
            "old": str(old_path),
            "new": str(new_path),
            "oldImageBase": f"0x{old_pe.image_base:X}",
            "newImageBase": f"0x{new_pe.image_base:X}",
            "rows": rows,
        }, ensure_ascii=False, indent=2))
    else:
        print(f"old: {old_path} (ImageBase=0x{old_pe.image_base:X})")
        print(f"new: {new_path} (ImageBase=0x{new_pe.image_base:X})")
        print(f"{'name':<42} {'status':<10} {'newRva':>10} {'delta':>12}")
        for item in rows:
            candidates = item.get("candidates") or []
            new_rva = candidates[0] if candidates else None
            new_text = f"0x{new_rva:09X}" if new_rva is not None else "-"
            delta_text = f"{item.get('delta'):+d}" if isinstance(item.get("delta"), int) else "-"
            status = item.get("status", "unknown")
            print(f"{item['name']:<42} {status:<10} {new_text:>10} {delta_text:>12}")
        unique = sum(1 for item in rows if item["status"] == "unique")
        print(f"\nunique={unique}/{len(rows)} ambiguous={sum(1 for item in rows if item['status']=='ambiguous')} not_found={sum(1 for item in rows if item['status']=='not_found')}")
        print("提醒：候选必须经过反汇编/动态验证，不能直接用于生产。")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="WeChat 4.x Hook 偏移研究工具")
    parser.add_argument("--list", action="store_true", help="列出内置偏移表")
    parser.add_argument("--old", type=Path, help="旧版 Weixin.dll（已知偏移对应版本）")
    parser.add_argument("--new", type=Path, help="新版 Weixin.dll（待适配版本）")
    parser.add_argument("--length", type=int, default=48, help="签名长度（默认 48 字节）")
    parser.add_argument("--json", action="store_true", help="JSON 输出")
    args = parser.parse_args()
    if args.list or not args.old or not args.new:
        return command_list()
    if not args.old.is_file() or not args.new.is_file():
        print("找不到 --old/--new 指定的 DLL", file=sys.stderr)
        return 2
    return command_compare(args.old, args.new, max(16, args.length), args.json)


if __name__ == "__main__":
    raise SystemExit(main())
