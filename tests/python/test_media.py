"""M3 图片解密单测（合成 V2 容器；不依赖真实微信）。"""
from __future__ import annotations

import hashlib
import struct

import pytest

import helpers
from lib.reader import wechat_media


def _jpeg(prefix: bytes = b"") -> bytes:
    """构造一段以 JPEG 魔数开头的假图片内容。"""
    return prefix + b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"\x00" * 20


def test_detect_mime_variants():
    assert wechat_media.detect_mime(b"\xff\xd8rest") == "image/jpeg"
    assert wechat_media.detect_mime(b"\x89PNGrest") == "image/png"
    assert wechat_media.detect_mime(b"GIF89a") == "image/gif"
    assert wechat_media.detect_mime(b"RIFF" + b"\x00" * 4 + b"WEBP") == "image/webp"
    assert wechat_media.detect_mime(b"not-image") is None


def test_decode_v2_without_xor():
    plaintext = _jpeg()
    aes_key = bytes.fromhex(helpers.IMAGE_AES_KEY_HEX)
    container = helpers.make_v2_dat(plaintext, aes_key, helpers.IMAGE_XOR_KEY)
    decoded = wechat_media.decode_v2(container, aes_key, helpers.IMAGE_XOR_KEY)
    assert decoded is not None
    data, mime = decoded
    assert data == plaintext
    assert mime == "image/jpeg"


def test_decode_v2_with_xor_tail():
    from Crypto.Cipher import AES
    from Crypto.Util import Padding

    aes_key = bytes.fromhex(helpers.IMAGE_AES_KEY_HEX)
    xor_key = 0x5A
    head = _jpeg()[:16]          # AES 段（16 字节整块）
    middle = b"MIDD"             # 中段原样
    tail_plain = b"TAIL!"        # 尾部 XOR
    tail_cipher = bytes(value ^ xor_key for value in tail_plain)
    magic = wechat_media.V2_MAGIC
    header = struct.pack("<6sLLx", magic, len(head), len(tail_plain))
    encrypted = AES.new(aes_key, AES.MODE_ECB).encrypt(Padding.pad(head, 16))
    container = header + encrypted + middle + tail_cipher
    decoded = wechat_media.decode_v2(container, aes_key, xor_key)
    assert decoded is not None
    data, mime = decoded
    assert data == head + middle + tail_plain
    assert mime == "image/jpeg"


def test_decode_v2_rejects_non_v2_and_oversize():
    aes_key = bytes.fromhex(helpers.IMAGE_AES_KEY_HEX)
    assert wechat_media.decode_v2(b"not-v2", aes_key, 0) is None
    big = helpers.make_v2_dat(b"x" * 100, aes_key, 0)
    assert wechat_media.decode_v2(big, aes_key, 0, max_bytes=50) is None


def test_extract_media_md5s_and_blob():
    xml = '<msg><img md5="' + "ab" * 16 + '" cdnthumbmd5="' + "cd" * 16 + '" /></msg>'
    md5s = wechat_media.extract_media_md5s(xml)
    assert md5s[0] == "ab" * 16
    assert "cd" * 16 in md5s
    assert wechat_media.extract_image_md5(xml) == "ab" * 16
    blob = b"\x01\x02" + bytes.fromhex("ef" * 16) + b"|garbage|" + ("12" * 16).encode()
    candidates = wechat_media.extract_blob_md5s(blob)
    assert "ef" * 16 in candidates          # raw 16 字节切片
    assert "12" * 16 in candidates          # ASCII hex


def test_derive_image_keys_from_config(tmp_path):
    account = tmp_path / "acc"
    (account / "msg").mkdir(parents=True)
    keys = wechat_media.derive_image_keys(
        account, helpers.OWN_WXID,
        image_aes_key=helpers.IMAGE_AES_KEY_HEX, image_xor_key=helpers.IMAGE_XOR_KEY,
    )
    assert keys is not None
    assert keys["source"] == "config"
    assert keys["aesKey"] == bytes.fromhex(helpers.IMAGE_AES_KEY_HEX)
    assert keys["xorKey"] == helpers.IMAGE_XOR_KEY


def test_derive_image_keys_rejects_bad_config(tmp_path):
    account = tmp_path / "acc"
    account.mkdir()
    with pytest.raises(wechat_media.MediaError) as error:
        wechat_media.derive_image_keys(account, helpers.OWN_WXID, image_aes_key="zz")
    assert error.value.code == "IMAGE_KEY_INVALID"


def test_derive_image_keys_from_kvcomm(tmp_path):
    from Crypto.Cipher import AES

    account = tmp_path / "acc"
    image_dir = account / "msg" / "attach" / "deadbeef" / "2026-01" / "Img"
    image_dir.mkdir(parents=True)
    kvcomm = tmp_path / "kvcomm"
    kvcomm.mkdir()
    code = 4242
    wxid = helpers.OWN_WXID.rsplit("_", 1)[0]
    aes_key = hashlib.md5(f"{code}{wxid}".encode()).hexdigest()[:16].encode("ascii")
    template_plain = b"\xff\xd8\xff\xe0\x00\x10JFIF\x00" + b"\x00" * 5   # 16 字节
    template_cipher = AES.new(aes_key, AES.MODE_ECB).encrypt(template_plain)
    header = struct.pack("<6sLLx", wechat_media.V2_MAGIC, 16, 0)
    (image_dir / "sample_t.dat").write_bytes(header + template_cipher)
    (kvcomm / f"key_{code}_1_1792_1_3600_input.statistic").write_bytes(b"stat")

    keys = wechat_media.derive_image_keys(
        account, helpers.OWN_WXID, kvcomm=kvcomm,
    )
    assert keys is not None
    assert keys["source"] == "kvcomm"
    assert keys["code"] == code
    assert keys["aesKey"] == aes_key
    assert keys["xorKey"] == code & 0xFF


def test_resolve_image_candidates_uses_thumbnail(tmp_path):
    account = tmp_path / "acc"
    talker = helpers.GROUP_TALKER
    image_dir = account / "msg" / "attach" / hashlib.md5(talker.encode()).hexdigest() / "2026-01" / "Img"
    image_dir.mkdir(parents=True)
    plaintext = _jpeg()
    aes_key = bytes.fromhex(helpers.IMAGE_AES_KEY_HEX)
    (image_dir / f"{helpers.IMAGE_MD5}_t.dat").write_bytes(
        helpers.make_v2_dat(plaintext, aes_key, helpers.IMAGE_XOR_KEY)
    )
    resolved = wechat_media.resolve_image_candidates(
        account, talker, [helpers.IMAGE_MD5, "00" * 16],
        aes_key=aes_key, xor_key=helpers.IMAGE_XOR_KEY,
    )
    assert resolved["mime"] == "image/jpeg"
    assert resolved["data"] == plaintext
    assert resolved["file"].endswith("_t.dat")
