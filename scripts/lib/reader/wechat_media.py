"""微信 4.x 图片 `.dat`（V2 容器）解密（手册 §5.7）。

职责：
- 定位图片文件：`<account>/msg/attach/<md5(talker)>/<YYYY-MM>/Img/<md5>{,_h,_t}.dat`
- 密钥来源两条：配置里的 `reader.imageAesKey/imageXorKey`，或 kvcomm 统计文件名派生
  `md5(f"{code}{wxid}")[:16]` 并用真实 `_t.dat` 头验证
- V2 容器：魔数 `07 08 56 32 08 07`，头 `struct.unpack('<6sLLx')` → `aes_size, xor_size`；
  前 `aes_size` 走 AES-128-ECB + PKCS7，剩余中段原样，尾部 `xor_size` 单字节 XOR
- 严格上限：单文件 ≤8MiB；只读、不落明文库；结果由调用方缓存

来源：容器结构与 kvcomm 派生方式参考 weflow-cli / WeChatAgent（MIT），本文件独立重写。
"""
from __future__ import annotations

import hashlib
import os
import pathlib
import re
import struct

from lib.reader.accounts import clean_own_wxid

V2_MAGIC = b"\x07\x08V2\x08\x07"
V2_HEADER_SIZE = 15
MAX_MEDIA_BYTES = 8 * 1024 * 1024
MAX_TEMPLATES = 32
STATISTIC_RE = re.compile(r"key_(\d+)_.+\.statistic", re.IGNORECASE)
MD5_RE = re.compile(r"(?<![0-9a-f])([0-9a-f]{32})(?![0-9a-f])", re.IGNORECASE)


class MediaError(Exception):
    """带错误码的媒体处理错误。"""

    def __init__(self, code: str, message: str = ""):
        super().__init__(message or code)
        self.code = code
        self.message = message or code


def detect_mime(header: bytes) -> str | None:
    """按文件头识别常见图片格式。"""
    if header[:2] == b"\xff\xd8":
        return "image/jpeg"
    if header[:4] == b"\x89PNG":
        return "image/png"
    if header[:3] == b"GIF":
        return "image/gif"
    if header[:4] == b"RIFF" and len(header) >= 12 and header[8:12] == b"WEBP":
        return "image/webp"
    return None


def kvcomm_dir() -> pathlib.Path:
    """微信 kvcomm 统计文件目录。"""
    appdata = os.environ.get("APPDATA", "")
    return pathlib.Path(appdata) / "Tencent" / "xwechat" / "net" / "kvcomm"


def _statistic_codes(directory: pathlib.Path) -> list[int]:
    """从 key_<code>_....statistic 文件名提取 code，升序。"""
    try:
        return sorted({
            int(match.group(1))
            for name in os.listdir(directory)
            if (match := STATISTIC_RE.fullmatch(name))
        })
    except (OSError, ValueError):
        return []


def _template_headers(account_dir: pathlib.Path, limit: int = MAX_TEMPLATES) -> list[bytes]:
    """采集真实 `_t.dat` 的 16 字节密文头，用于验证派生密钥。"""
    templates: list[bytes] = []
    for root_name in ("msg", "cache", "resource"):
        base = account_dir / root_name
        if not base.is_dir():
            continue
        for current, _dirs, files in os.walk(base):
            for name in files:
                if not name.lower().endswith("_t.dat"):
                    continue
                path = pathlib.Path(current) / name
                try:
                    header = path.read_bytes()[: V2_HEADER_SIZE + 16]
                except OSError:
                    continue
                if header.startswith(V2_MAGIC) and len(header) >= V2_HEADER_SIZE + 16:
                    templates.append(header[V2_HEADER_SIZE:V2_HEADER_SIZE + 16])
                if len(templates) >= limit:
                    return templates
    return templates


def _try_aes_key(aes_key: bytes, templates: list[bytes]) -> bool:
    """用模板密文头验证 AES 密钥（解密后应是图片/`wxgf` 头）。"""
    try:
        from Crypto.Cipher import AES

        cipher = AES.new(aes_key, AES.MODE_ECB)
    except (ImportError, ValueError):
        return False
    for template in templates:
        try:
            plain = cipher.decrypt(template)
        except ValueError:
            continue
        if detect_mime(plain) or plain.startswith((b"wxgf", b"WXGF")):
            return True
    return False


def derive_image_keys(
    account_dir: str | pathlib.Path,
    own_wxid: str,
    *,
    image_aes_key: str = "",
    image_xor_key: int | None = None,
    kvcomm: str | pathlib.Path | None = None,
) -> dict | None:
    """派生并验证图片 AES/XOR 密钥。

    @returns `{aesKey: bytes(16), xorKey: int, source: "config"|"kvcomm", code?: int}`，失败 None。
    """
    account = pathlib.Path(account_dir)
    wxids = list(dict.fromkeys(filter(None, (
        clean_own_wxid(own_wxid),
        clean_own_wxid(account.name),
    ))))
    templates = _template_headers(account)

    # 来源①：配置文件显式给出（hex 32 / 整数 xor）
    if image_aes_key:
        try:
            aes_key = bytes.fromhex(image_aes_key)
        except ValueError:
            raise MediaError("IMAGE_KEY_INVALID", "imageAesKey 不是 hex") from None
        if len(aes_key) != 16:
            raise MediaError("IMAGE_KEY_INVALID", "imageAesKey 必须是 32-hex（16 字节）")
        xor_key = int(image_xor_key) if image_xor_key is not None else 0
        if not 0 <= xor_key <= 0xFF:
            raise MediaError("IMAGE_KEY_INVALID", "imageXorKey 必须是 0-255")
        # 有模板时仍做一次验证，避免配置写错静默解出坏图。
        if templates and not _try_aes_key(aes_key, templates):
            raise MediaError("IMAGE_KEY_REJECTED", "配置的图片密钥未通过 _t.dat 验证")
        return {"aesKey": aes_key, "xorKey": xor_key, "source": "config"}

    # 来源②：kvcomm 统计文件名 + 真实 _t.dat 验证
    if not templates:
        return None
    directory = pathlib.Path(kvcomm) if kvcomm else kvcomm_dir()
    codes = _statistic_codes(directory)
    if not codes:
        return None
    for wxid in wxids:
        for code in codes:
            aes_key = hashlib.md5(f"{code}{wxid}".encode()).hexdigest()[:16].encode("ascii")
            if _try_aes_key(aes_key, templates):
                return {"aesKey": aes_key, "xorKey": code & 0xFF, "source": "kvcomm", "code": code}
    return None


def extract_image_md5(xml: str) -> str | None:
    """从图片/表情 XML 里取第一个 32-hex md5（优先 `<img md5=...>`）。"""
    md5s = extract_media_md5s(xml)
    return md5s[0] if md5s else None


def extract_media_md5s(value: str) -> list[str]:
    """取出文本里出现的全部 32-hex（XML 里的 md5/cdnthumbmd5 等都可能是文件名）。"""
    if not value:
        return []
    return list(dict.fromkeys(match.lower() for match in MD5_RE.findall(str(value))))


def extract_blob_md5s(blob) -> list[str]:
    """从 `MessageResourceInfo.packed_info` 里提取候选文件名（hex 串 + 原始 16 字节切片）。"""
    if blob is None:
        return []
    if isinstance(blob, memoryview):
        data = blob.tobytes()
    elif isinstance(blob, (bytes, bytearray)):
        data = bytes(blob)
    else:
        data = str(blob).encode("utf-8", errors="ignore")
    result: list[str] = []
    for match in re.finditer(rb"(?i)([0-9a-f]{32})(?:[._][thbc])?\.dat", data):
        result.append(match.group(1).decode("ascii").lower())
    for match in re.finditer(rb"(?i)(?<![0-9a-f])([0-9a-f]{32})(?![0-9a-f])", data):
        result.append(match.group(1).decode("ascii").lower())
    # packed_info 常见把 MD5 存成 raw 16 字节，逐字节切片作为候选（随后按文件存在性过滤）。
    for offset in range(0, max(0, len(data) - 15)):
        chunk = data[offset:offset + 16]
        if chunk in (b"\x00" * 16, b"\xff" * 16):
            continue
        result.append(chunk.hex())
    return list(dict.fromkeys(result))


def _talker_file_index(account_dir: str | pathlib.Path, talker: str) -> dict[str, pathlib.Path]:
    """建立某会话的图片文件名索引（basename → 路径），避免对每个候选都全盘扫描。"""
    account = pathlib.Path(account_dir)
    talker_hash = hashlib.md5(talker.encode("utf-8")).hexdigest()
    base = account / "msg" / "attach" / talker_hash
    index: dict[str, pathlib.Path] = {}
    if base.is_dir():
        for current, _dirs, files in os.walk(base):
            for name in files:
                if name.lower().endswith(".dat"):
                    index.setdefault(name.lower(), pathlib.Path(current) / name)
        if index:
            return index
    # 兜底：整个 attach 目录扫一次（极端情况下文件不在按会话分目录里）。
    attach = account / "msg" / "attach"
    if attach.is_dir():
        for current, _dirs, files in os.walk(attach):
            for name in files:
                if name.lower().endswith(".dat"):
                    index.setdefault(name.lower(), pathlib.Path(current) / name)
    return index


def image_file_candidates(account_dir: str | pathlib.Path, talker: str, md5: str) -> list[pathlib.Path]:
    """按优先级返回候选图片文件：原图 > 高清 > 缩略图。"""
    index = _talker_file_index(account_dir, talker)
    candidates: list[pathlib.Path] = []
    for suffix in ("", "_h", "_t"):
        found = index.get(f"{md5}{suffix}.dat".lower())
        if found is not None:
            candidates.append(found)
    return candidates


def decode_v2(data: bytes, aes_key: bytes, xor_key: int, max_bytes: int = MAX_MEDIA_BYTES) -> tuple[bytes, str] | None:
    """解码 V2 容器；不是 V2 或解码失败返回 None。"""
    if not data or len(data) > max_bytes + V2_HEADER_SIZE or not data.startswith(V2_MAGIC):
        return None
    try:
        from Crypto.Cipher import AES
        from Crypto.Util import Padding

        signature, aes_size, xor_size = struct.unpack("<6sLLx", data[:V2_HEADER_SIZE])
        if signature != V2_MAGIC or aes_size <= 0 or aes_size > max_bytes:
            return None
        encrypted_size = aes_size + 16 - aes_size % 16
        encrypted = data[V2_HEADER_SIZE:V2_HEADER_SIZE + encrypted_size]
        if len(encrypted) != encrypted_size:
            return None
        decrypted = Padding.unpad(AES.new(aes_key, AES.MODE_ECB).decrypt(encrypted), 16)
        remainder = data[V2_HEADER_SIZE + encrypted_size:]
        if xor_size:
            if xor_size > len(remainder):
                return None
            raw = remainder[:-xor_size]
            tail = bytes(value ^ xor_key for value in remainder[-xor_size:])
        else:
            raw, tail = remainder, b""
        output = decrypted + raw + tail
        if len(output) > max_bytes:
            return None
        mime = detect_mime(output[:16])
        return (output, mime) if mime else None
    except (ImportError, ValueError, struct.error):
        return None


def read_media_file(path: pathlib.Path, max_bytes: int = MAX_MEDIA_BYTES) -> bytes:
    """读取媒体文件并检查大小上限。"""
    try:
        size = path.stat().st_size
    except OSError as error:
        raise MediaError("IMAGE_FILE_NOT_FOUND", str(error)) from None
    if size > max_bytes + V2_HEADER_SIZE:
        raise MediaError("IMAGE_TOO_LARGE", f"{size} bytes")
    try:
        return path.read_bytes()
    except OSError as error:
        raise MediaError("IMAGE_FILE_NOT_FOUND", str(error)) from None


def resolve_image_file(
    account_dir: str | pathlib.Path,
    talker: str,
    md5: str,
    *,
    aes_key: bytes,
    xor_key: int,
    max_bytes: int = MAX_MEDIA_BYTES,
) -> dict:
    """定位并解码一张图片，返回 {data, mime, bytes, file}。"""
    return resolve_image_candidates(
        account_dir, talker, [md5], aes_key=aes_key, xor_key=xor_key, max_bytes=max_bytes,
    )


def resolve_image_candidates(
    account_dir: str | pathlib.Path,
    talker: str,
    candidates: list[str],
    *,
    aes_key: bytes,
    xor_key: int,
    fallback_names: list[str] | None = None,
    max_bytes: int = MAX_MEDIA_BYTES,
) -> dict:
    """按候选文件名逐个定位并解码，返回第一张成功的图。"""
    index = _talker_file_index(account_dir, talker)
    errors: list[str] = []
    searched = 0

    def try_file(path: pathlib.Path):
        nonlocal searched
        searched += 1
        try:
            raw = read_media_file(path, max_bytes)
        except MediaError as error:
            errors.append(error.code)
            return None
        decoded = decode_v2(raw, aes_key, xor_key, max_bytes)
        if decoded is None:
            errors.append("IMAGE_DECODE_FAILED")
            return None
        data, mime = decoded
        return {"data": data, "mime": mime, "bytes": len(data), "file": str(path)}

    seen: set[str] = set()
    for candidate in candidates:
        candidate = (candidate or "").lower()
        if len(candidate) != 32 or not re.fullmatch(r"[0-9a-f]{32}", candidate):
            continue
        for suffix in ("", "_h", "_t"):
            name = f"{candidate}{suffix}.dat"
            if name in seen:
                continue
            seen.add(name)
            path = index.get(name)
            if path is None:
                continue
            resolved = try_file(path)
            if resolved:
                return resolved
    # 退路：部分缩略图直接以 `<localId>_<createTime>_t.dat` 命名。
    for name in fallback_names or []:
        for suffix in ("_t.dat", "_h.dat", ".dat"):
            filename = (name + suffix).lower()
            if filename in seen:
                continue
            seen.add(filename)
            path = index.get(filename)
            if path is None:
                continue
            resolved = try_file(path)
            if resolved:
                return resolved
    raise MediaError(
        "IMAGE_FILE_NOT_FOUND" if not errors else errors[-1],
        f"未找到可解码的图片文件（talker={talker[:6]}*** tried={searched}）",
    )
