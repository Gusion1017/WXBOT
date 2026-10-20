#!/usr/bin/env python
"""Hook 移植辅助：vtable 函数映射 + 旧函数在新版 DLL 中的相似函数搜索。

用法：
    # 反汇编旧版函数（看结构/长度）
    python scripts/dev/hook-port-assist.py dump --old path\\Weixin.dll --rva 0x1677A30 --max 80

    # 在旧版函数处提取签名，搜索新版 DLL 中的相似函数
    python scripts/dev/hook-port-assist.py find --old old.dll --new new.dll --rva 0x1677A30 --name send_message

    # 用 vtable 候选地址映射旧→新的函数指针（按 vtable 索引）
    python scripts/dev/hook-port-assist.py vtables --old old.dll --new new.dll --json

说明：
- 仅用于个人本机研究；结果必须经 IDA/Ghidra 动态验证，不能直接视为可用偏移。
- 依赖：pip install capstone pefile。
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import struct
from pathlib import Path

import capstone
import pefile

HELPER = Path(__file__).with_name("hook-offsets.py")


def load_offset_helper():
    spec = importlib.util.spec_from_file_location("hook_offsets_helper", HELPER)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)  # type: ignore[union-attr]
    return module


class Dll:
    def __init__(self, path: Path):
        self.path = path
        self.pe = pefile.PE(str(path), fast_load=True)
        self.image_base = self.pe.OPTIONAL_HEADER.ImageBase
        self.size_of_image = self.pe.OPTIONAL_HEADER.SizeOfImage
        self.data = path.read_bytes()
        self.sections = []
        for section in self.pe.sections:
            self.sections.append({
                "name": section.Name.rstrip(b"\0").decode("ascii", "replace"),
                "rva": section.VirtualAddress,
                "vsize": max(section.Misc_VirtualSize, section.SizeOfRawData),
                "raw_ptr": section.PointerToRawData,
                "raw_size": section.SizeOfRawData,
            })
        self.cs = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
        self.cs.detail = True

    def rva_to_offset(self, rva: int) -> int | None:
        for section in self.sections:
            start = section["rva"]
            if start <= rva < start + section["vsize"] and rva - start < section["raw_size"]:
                return section["raw_ptr"] + (rva - start)
        return None

    def offset_to_rva(self, offset: int) -> int | None:
        for section in self.sections:
            if section["raw_ptr"] <= offset < section["raw_ptr"] + section["raw_size"]:
                rva = section["rva"] + (offset - section["raw_ptr"])
                if rva < section["rva"] + section["vsize"]:
                    return rva
        return None

    def in_image(self, value: int) -> bool:
        return self.image_base <= value < self.image_base + self.size_of_image

    def to_rva(self, value: int) -> int | None:
        return value - self.image_base if self.in_image(value) else None

    def read(self, rva: int, size: int) -> bytes | None:
        offset = self.rva_to_offset(rva)
        if offset is None:
            return None
        return self.data[offset:offset + size]

    def disasm(self, rva: int, max_instructions: int = 120) -> list:
        offset = self.rva_to_offset(rva)
        if offset is None:
            return []
        code = self.data[offset:offset + 4096]
        return list(self.cs.disasm(code, rva, count=max_instructions))


def operand_kind(insn, operand) -> str:
    if operand.type == capstone.x86.X86_OP_REG:
        return "reg"
    if operand.type == capstone.x86.X86_OP_MEM:
        return "mem"
    if operand.type == capstone.x86.X86_OP_IMM:
        return "imm"
    return "?"


def normalized_token(insn) -> str:
    mnemonic = insn.mnemonic
    if mnemonic.startswith("j") or mnemonic == "call":
        return mnemonic + "|rel"
    operands = [operand_kind(insn, operand) for operand in insn.operands]
    return mnemonic + "|" + ",".join(operands)


def signature_from_instructions(instructions: list, max_insns: int) -> tuple[bytes, bytes]:
    """生成 opcode 保留、立即数/位移掩码的签名。"""
    pattern = bytearray()
    mask = bytearray()
    for insn in instructions[:max_insns]:
        raw = bytearray(insn.bytes)
        raw_mask = bytearray(b"\x01" * len(raw))
        imm_offset = getattr(insn, "imm_offset", 0)
        imm_size = getattr(insn, "imm_size", 0)
        if imm_size and imm_offset + imm_size <= len(raw):
            raw_mask[imm_offset:imm_offset + imm_size] = b"\x00" * imm_size
        disp_offset = getattr(insn, "disp_offset", 0)
        disp_size = getattr(insn, "disp_size", 0)
        if disp_size and disp_offset + disp_size <= len(raw):
            raw_mask[disp_offset:disp_offset + disp_size] = b"\x00" * disp_size
        pattern.extend(raw)
        mask.extend(raw_mask)
    return bytes(pattern), bytes(mask)


def find_function_candidates(old: Dll, new: Dll, old_rva: int, max_insns: int = 24,
                             max_candidates: int = 20) -> list[dict]:
    instructions = old.disasm(old_rva, max(max_insns, 120))
    if not instructions:
        return []
    pattern, mask = signature_from_instructions(instructions, max_insns)
    # 选择连续 8 字节全是 opcode 作为锚点
    anchor = None
    for index in range(0, len(pattern) - 8):
        if all(mask[index:index + 8]):
            anchor = pattern[index:index + 8]
            break
    if anchor is None:
        anchor = pattern[:8]
    candidates = []
    seen = set()
    search_from = 0
    while True:
        index = new.data.find(anchor, search_from)
        if index < 0:
            break
        search_from = index + 1
        # 校验掩码签名
        start = index - 0  # 锚点即签名起点（简化：签名从函数开头开始）
        if index + len(pattern) > len(new.data):
            continue
        if not all(mask[i] == 0 or new.data[index + i] == pattern[i] for i in range(len(pattern))):
            continue
        rva = new.offset_to_rva(index)
        if rva is None or rva in seen:
            continue
        seen.add(rva)
        candidate_instructions = new.disasm(rva, len(instructions))
        old_tokens = [normalized_token(i) for i in instructions]
        new_tokens = [normalized_token(i) for i in candidate_instructions]
        common = 0
        for old_token, new_token in zip(old_tokens, new_tokens):
            if old_token != new_token:
                break
            common += 1
        score = common / max(1, min(len(old_tokens), 40))
        candidates.append({
            "newRva": rva,
            "matchedInstructions": common,
            "score": round(score, 3),
            "preview": " ; ".join(f"{i.mnemonic} {' '.join(i.op_str.split())}" for i in candidate_instructions[:8]),
        })
        if len(candidates) >= max_candidates * 5:
            break
    candidates.sort(key=lambda item: item["score"], reverse=True)
    return candidates[:max_candidates]


def command_dump(args) -> int:
    dll = Dll(args.old)
    instructions = dll.disasm(args.rva, args.max)
    for index, insn in enumerate(instructions):
        print(f"0x{insn.address:09X}  {insn.mnemonic:<10} {insn.op_str}")
        if index >= args.max - 1:
            break
    print(f"\ninstructions={len(instructions)}")
    return 0


def command_find(args) -> int:
    old = Dll(args.old)
    new = Dll(args.new)
    candidates = find_function_candidates(old, new, args.rva, args.max)
    if args.json:
        print(json.dumps({"name": args.name, "oldRva": args.rva, "candidates": candidates}, ensure_ascii=False, indent=2))
        return 0
    print(f"{args.name} oldRva=0x{args.rva:X} candidates={len(candidates)}")
    for item in candidates:
        print(f"  newRva=0x{item['newRva']:09X} score={item['score']:.3f} matched={item['matchedInstructions']}")
        print(f"    {item['preview']}")
    if not candidates:
        print("  未找到相似函数：函数结构在版本间变化较大，需要动态分析。")
    return 0


def command_vtables(args) -> int:
    helper = load_offset_helper()
    old = Dll(args.old)
    new = Dll(args.new)
    old_pe = helper.PeFile(args.old)
    new_pe = helper.PeFile(args.new)
    rows = []
    for name, rva in helper.OFFSETS.items():
        if "VTABLE" not in name.upper() and "vtbl" not in name and "vtable" not in name:
            continue
        built = helper.build_pattern(old_pe, rva, 32)
        if not built:
            continue
        pattern, mask = built
        hits = helper.count_candidates(new_pe, pattern, mask)
        if len(hits) != 1:
            continue
        new_rva = hits[0]
        old_raw = old.read(rva, 8 * args.entries)
        new_raw = new.read(new_rva, 8 * args.entries)
        if not old_raw or not new_raw:
            continue
        mapping = []
        for index in range(min(len(old_raw), len(new_raw)) // 8):
            old_ptr = struct.unpack_from("<Q", old_raw, index * 8)[0]
            new_ptr = struct.unpack_from("<Q", new_raw, index * 8)[0]
            old_func = old.to_rva(old_ptr)
            new_func = new.to_rva(new_ptr)
            if old_func is None and new_func is None:
                continue
            mapping.append({
                "index": index,
                "oldFunctionRva": old_func,
                "newFunctionRva": new_func,
                "delta": (new_func - old_func) if old_func is not None and new_func is not None else None,
            })
        rows.append({"vtable": name, "oldRva": rva, "newRva": new_rva, "entries": mapping})
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2, default=lambda value: f"0x{value:X}" if isinstance(value, int) else value))
        return 0
    for row in rows:
        print(f"{row['vtable']}: old=0x{row['oldRva']:09X} new=0x{row['newRva']:09X}")
        for entry in row["entries"]:
            old_func = f"0x{entry['oldFunctionRva']:09X}" if entry["oldFunctionRva"] is not None else "-"
            new_func = f"0x{entry['newFunctionRva']:09X}" if entry["newFunctionRva"] is not None else "-"
            delta = f"{entry['delta']:+d}" if entry["delta"] is not None else "-"
            print(f"  [{entry['index']:02d}] {old_func} -> {new_func}  ({delta})")
    if not rows:
        print("没有可映射的 vtable（候选不唯一或无匹配）。")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="WeChat Hook 移植辅助工具")
    sub = parser.add_subparsers(dest="command", required=True)

    dump = sub.add_parser("dump")
    dump.add_argument("--old", type=Path, required=True)
    dump.add_argument("--rva", type=lambda value: int(value, 0), required=True)
    dump.add_argument("--max", type=int, default=80)
    dump.set_defaults(handler=command_dump)

    find = sub.add_parser("find")
    find.add_argument("--old", type=Path, required=True)
    find.add_argument("--new", type=Path, required=True)
    find.add_argument("--rva", type=lambda value: int(value, 0), required=True)
    find.add_argument("--name", default="function")
    find.add_argument("--max", type=int, default=24)
    find.add_argument("--json", action="store_true")
    find.set_defaults(handler=command_find)

    vtables = sub.add_parser("vtables")
    vtables.add_argument("--old", type=Path, required=True)
    vtables.add_argument("--new", type=Path, required=True)
    vtables.add_argument("--entries", type=int, default=24)
    vtables.add_argument("--json", action="store_true")
    vtables.set_defaults(handler=command_vtables)

    args = parser.parse_args()
    if not Path(args.old).is_file():
        print(f"找不到旧 DLL：{args.old}")
        return 2
    if hasattr(args, "new") and not Path(args.new).is_file():
        print(f"找不到新 DLL：{args.new}")
        return 2
    return args.handler(args)


if __name__ == "__main__":
    raise SystemExit(main())
