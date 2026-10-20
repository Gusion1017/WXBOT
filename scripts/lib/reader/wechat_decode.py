"""微信 4.x 消息内容解码（只读纯函数，便于单测）。

设计要点（手册 §5.5 / §13）：
- 内容 BLOB 先看 zstd 魔数再解压；非文本一律给占位文本，绝不返回空串。
- XML 用 ElementTree 取**直接子节点**，禁止在整段 XML 里全局搜 title；
  自闭合 `<title />` 取不到就是空；实体解引用；超长截断留省略号。
- 引用消息必须带出被引原文；合并转发限制递归深度/条数/字节数并拒绝 DOCTYPE/ENTITY。
- 群消息正文的 `wxid...:` 前缀只剥 Name2Id 里真实存在的 id。

来源说明：引用/合并转发的结构和边界参考 WeChatAgent（MIT）与 weflow-cli（MIT）
的公开实现，本文件为 WXBOT 独立重写；详见 docs/THIRD_PARTY.md。
"""
from __future__ import annotations

import html
import json
import re
import xml.etree.ElementTree as ET

ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"

APPMSG = 49
TEXT = 1
IMAGE = 3
VOICE = 34
CARD = 42
VIDEO = 43
STICKER = 47
LOCATION = 48
SYSTEM = 10000

APP_LINK_4 = 4
APP_LINK_5 = 5
APP_FILE = 6
APP_STICKER = 8
APP_FORWARDED = 19
APP_MINIPROGRAM = 33
APP_LIVE_51 = 51
APP_QUOTE = 57
APP_PAT = 62
APP_LIVE_63 = 63
APP_TRANSFER = 2000
APP_RED_PACKET = 2001

MAX_CONTENT = 4000
MAX_TITLE = 120
MAX_QUOTE_REFERENCE = 1600
MAX_QUOTE_DEPTH = 2
MAX_FORWARD_XML = 512_000
MAX_FORWARD_ITEMS = 50
MAX_FORWARD_TEXT = 6000
MAX_FORWARD_DEPTH = 3
MAX_SYSTEM = 4000

NON_TEXT_LABELS = {
    IMAGE: "图片",
    VOICE: "语音",
    CARD: "名片",
    VIDEO: "视频",
    STICKER: "表情包",
    LOCATION: "位置",
}

APPMSG_LABELS = {
    APP_LINK_4: "链接",
    APP_LINK_5: "链接",
    APP_FILE: "文件",
    APP_STICKER: "表情包",
    APP_FORWARDED: "合并转发聊天记录",
    APP_MINIPROGRAM: "小程序",
    APP_LIVE_51: "视频号",
    APP_QUOTE: "引用",
    APP_PAT: "拍一拍",
    APP_LIVE_63: "直播",
    APP_TRANSFER: "转账",
    APP_RED_PACKET: "红包",
}

QUOTE_SEP = " ｜ 引："
GROUP_PREFIX_RE = re.compile(r"^([A-Za-z0-9_@.-]{5,64})\s*[:：]\s")


def decode_content(raw) -> str:
    """消息内容 → 文本。bytes 先按 zstd 解压（4.x 全部内容都走压缩），失败回空串。"""
    if isinstance(raw, str):
        return raw
    if not raw:
        return ""
    data = bytes(raw)
    if data[:4] == ZSTD_MAGIC:
        try:
            import zstandard

            return zstandard.ZstdDecompressor().decompress(data).decode("utf-8", "ignore")
        except Exception:  # noqa: BLE001 - 坏内容按空串处理，调用方给占位
            return ""
    return data.decode("utf-8", "ignore")


def strip_group_prefix(text: str, known_ids) -> tuple[str, str | None]:
    """剥掉群消息正文前的 `wxid...:` 前缀（只接受 Name2Id 里存在的 id）。"""
    match = GROUP_PREFIX_RE.match(text or "")
    if not match:
        return text, None
    identifier = match.group(1)
    if identifier not in known_ids:
        return text, None
    return text[match.end():], identifier


def safe_xml(value: str, max_size: int = MAX_FORWARD_XML):
    """受限 XML 解析：限制大小、拒绝 DOCTYPE/ENTITY（防 XML 炸弹）。"""
    if not isinstance(value, str) or not value.strip():
        raise ValueError("INVALID_XML")
    if len(value) > max_size:
        raise ValueError("XML_TOO_LARGE")
    if re.search(r"<!\s*(?:DOCTYPE|ENTITY)\b", value, re.I):
        raise ValueError("UNSAFE_XML")
    return ET.fromstring(value)


def appmsg_root(value: str):
    """取 appmsg 元素；不是 appmsg 返回 None。"""
    try:
        root = safe_xml(value)
    except (ValueError, ET.ParseError, RecursionError):
        return None
    if root.tag == "appmsg":
        return root
    if root.tag == "msg":
        return root.find("appmsg")
    return None


def child_text(node, tag: str, limit: int | None = None) -> str:
    """取直接子节点的纯文本（含嵌套 itertext，但只看该子节点内部）。"""
    child = node.find(tag) if node is not None else None
    if child is None:
        return ""
    text = "".join(child.itertext()).strip()
    return text[:limit] if limit is not None else text


def child_raw(node, tag: str) -> str:
    """取子节点内容：若子节点还有嵌套 XML，序列化出来；否则取文本。"""
    child = node.find(tag) if node is not None else None
    if child is None:
        return ""
    if len(child):
        return "".join(ET.tostring(grandchild, encoding="unicode") for grandchild in child)
    return (child.text or "").strip()


def classify(local_type: int) -> dict:
    """把 local_type 拆成 base/apptype 与 kind/label。"""
    local_type = int(local_type or 0)
    base = local_type & 0xFFFFFFFF
    apptype = local_type >> 32
    if base == APPMSG:
        label = APPMSG_LABELS.get(apptype, "应用消息")
        return {"base": base, "apptype": apptype, "kind": f"appmsg:{apptype}", "label": label}
    labels = {TEXT: ("text", "文本"), SYSTEM: ("system", "系统消息"), **{
        key: (f"type:{key}", value) for key, value in NON_TEXT_LABELS.items()
    }}
    kind, label = labels.get(base, ("unknown", f"未识别类型 {base}"))
    return {"base": base, "apptype": apptype, "kind": kind, "label": label}


def _clip(text: str, limit: int) -> str:
    """截断并加省略号，避免"看起来说完了"。"""
    text = text or ""
    return text if len(text) <= limit else text[:limit] + "…"


def _nullish(value: str) -> bool:
    """XML 里常见的占位值按空处理。"""
    return (value or "").strip().lower() in ("", "null", "undefined", "(null)", "0")


def _unescape_xml(value: str) -> str:
    """引用/转发内容可能是多层转义 XML，最多解三层。"""
    text = value or ""
    for _ in range(3):
        if text.lstrip().startswith("<"):
            return text
        decoded = html.unescape(text)
        if decoded == text:
            return text
        text = decoded
    return text


# ---------------------------------------------------------------- 引用（appmsg/57）


def _quote_reference_text(kind: str, value: str, depth: int) -> tuple[str, bool, bool]:
    """把被引用消息渲染成文本；返回 (text, unavailable, truncated)。"""
    if kind == "1":
        if _nullish(value):
            return "[被引用文字不可用]", True, False
        return _clip(value, MAX_QUOTE_REFERENCE), False, len(value) > MAX_QUOTE_REFERENCE
    labels = {
        "3": "图片，未提供图片内容",
        "34": "语音，未转写",
        "43": "视频，未提供视频内容",
        "47": "表情包，未提供表情内容",
        "48": "位置，未解析位置内容",
        "10000": "系统消息",
    }
    if kind in labels:
        return "[" + labels[kind] + "]", True, False
    if kind.isdigit() and int(kind) & 0xFFFFFFFF == APPMSG:
        value = _unescape_xml(value)
        app = appmsg_root(value)
        if app is not None:
            subtype = child_text(app, "type")
            if subtype == str(APP_QUOTE):
                if depth >= MAX_QUOTE_DEPTH:
                    return "[嵌套引用过深，未展开]", True, True
                nested = parse_quote(value, depth + 1)
                if nested:
                    reference = nested["reference"]
                    text = "回复：" + nested["reply"] + "\n引用 " + reference["senderName"] + "：" + reference["text"]
                    truncated = bool(nested["truncated"] or reference["truncated"] or len(text) > MAX_QUOTE_REFERENCE)
                    return _clip(text, MAX_QUOTE_REFERENCE), bool(reference["unavailable"]), truncated
            if subtype == str(APP_FORWARDED):
                forwarded = parse_forwarded(value)
                if forwarded:
                    return _clip("[合并聊天记录] " + forwarded["title"], MAX_QUOTE_REFERENCE), True, forwarded["truncated"]
            label = {
                str(APP_LINK_4): "链接",
                str(APP_LINK_5): "链接",
                str(APP_FILE): "文件，未读取文件内容",
                str(APP_STICKER): "表情包，未提供表情内容",
                str(APP_MINIPROGRAM): "小程序",
                str(APP_LIVE_51): "视频号",
                str(APP_LIVE_63): "直播",
                str(APP_TRANSFER): "转账",
                str(APP_RED_PACKET): "红包",
            }.get(subtype, "应用消息，未解析附件")
            title = child_text(app, "title") if subtype in (
                str(APP_FILE), str(APP_LINK_4), str(APP_LINK_5), str(APP_MINIPROGRAM), str(APP_LIVE_51),
            ) else ""
            return "[" + label + "]" + (" " + _clip(title, MAX_TITLE) if title else ""), True, False
    return "[被引用消息类型未支持或正文不可用]", True, False


def parse_quote(value: str, depth: int = 0):
    """解析 appmsg/57 引用消息；不是引用返回 None。"""
    if depth > MAX_QUOTE_DEPTH:
        return None
    app = appmsg_root(value)
    if app is None or child_text(app, "type") != str(APP_QUOTE):
        return None
    reply = child_text(app, "title")
    ref = app.find("refermsg")
    if ref is None:
        return {
            "version": 1,
            "reply": _clip(reply, MAX_CONTENT),
            "truncated": len(reply) > MAX_CONTENT,
            "reference": {
                "senderId": "", "senderName": "未知发言人", "conversationId": "",
                "messageId": "", "time": "", "kind": "",
                "text": "[被引用消息不可用]", "unavailable": True, "truncated": False,
            },
        }
    source = child_text(ref, "fromusr", 128)
    member = child_text(ref, "chatusr", 128)
    group = source.endswith("@chatroom")
    sender = member if group else (source or member)
    kind = child_text(ref, "type")
    kind = kind if re.fullmatch(r"[0-9]{1,16}", kind) else ""
    raw = child_raw(ref, "content")
    reference_text, unavailable, ref_truncated = _quote_reference_text(kind, raw, depth)
    return {
        "version": 1,
        "reply": _clip(reply, MAX_CONTENT),
        "truncated": len(reply) > MAX_CONTENT,
        "reference": {
            "senderId": sender,
            "senderName": child_text(ref, "displayname", 80) or "未知发言人",
            "conversationId": source if group else "",
            "messageId": child_text(ref, "svrid", 32),
            "time": child_text(ref, "createtime", 64),
            "kind": kind,
            "text": reference_text,
            "unavailable": unavailable,
            "truncated": ref_truncated,
        },
    }


# ---------------------------------------------------------- 合并转发（appmsg/19）


def _record_root(node):
    """recorditem/recordxml 里可能是子树、CDATA 或多层转义 XML。"""
    if list(node):
        return node
    text = (node.text or "").strip()
    return safe_xml(_unescape_xml(text))


def parse_forwarded(value: str):
    """解析 appmsg/19 合并转发；不是合并转发返回 None。"""
    app = appmsg_root(value)
    if app is None or child_text(app, "type") != str(APP_FORWARDED):
        return None
    title = child_text(app, "title", 200) or "聊天记录"
    record = app.find("recorditem")
    if record is None:
        return {"version": 1, "title": title, "items": [], "truncated": False, "unavailable": True}
    try:
        container = _record_root(record)
    except (ValueError, ET.ParseError, RecursionError):
        return {"version": 1, "title": title, "items": [], "truncated": False, "unavailable": True}

    items: list[dict] = []
    truncated = False
    remaining = MAX_FORWARD_TEXT

    def collect(current, depth: int) -> None:
        nonlocal truncated, remaining
        data_list = current if current.tag == "datalist" else current.find("datalist")
        if data_list is None:
            info = current.find("recordinfo")
            data_list = info.find("datalist") if info is not None else None
        if data_list is None:
            return
        for item in data_list.findall("dataitem"):
            if len(items) >= MAX_FORWARD_ITEMS or remaining < 100:
                truncated = True
                break
            kind = str(item.get("datatype") or child_text(item, "datatype", 8))
            name = re.sub(r"[\r\n\t]+", " ", child_text(item, "sourcename", 80)) or "未知发言人"
            clock = re.sub(r"[\r\n\t]+", " ", child_text(item, "sourcetime", 64))
            full_desc = child_text(item, "datadesc", MAX_FORWARD_XML) or child_text(item, "content", MAX_FORWARD_XML)
            heading = child_text(item, "datatitle", 200)
            desc = full_desc
            if len(desc) > 800:
                desc, truncated = desc[:800] + "…", True
            if kind == "1":
                text = desc or heading or "[空文字消息]"
            elif kind == "14":
                text = "[嵌套聊天记录]" + (" " + heading if heading else "")
            else:
                label = {
                    "2": "图片，未提供图片内容",
                    "3": "语音，未转写",
                    "4": "视频，未提供视频内容",
                    "5": "链接",
                    "6": "位置",
                    "7": "音乐",
                    "8": "文件，未读取文件内容",
                }.get(kind, "未支持的消息")
                text = "[" + label + "]" + (" " + (heading or desc) if heading or desc else "")
            cost = len(name) + len(clock) + len(text) + 12
            if cost > remaining:
                text = text[: max(0, remaining - len(name) - len(clock) - 12)] + "…"
                truncated = True
            items.append({"sender": name, "time": clock, "kind": kind, "text": text, "depth": depth})
            remaining -= cost
            if kind == "14":
                nested = item.find("recordxml")
                if nested is None:
                    nested = item.find("recorditem")
                if nested is not None:
                    if depth >= MAX_FORWARD_DEPTH:
                        truncated = True
                    else:
                        try:
                            collect(_record_root(nested), depth + 1)
                        except (ValueError, ET.ParseError, RecursionError):
                            truncated = True

    try:
        collect(container, 0)
    except (ValueError, ET.ParseError, RecursionError):
        truncated = True
    return {
        "version": 1,
        "title": title,
        "items": items,
        "truncated": truncated,
        "unavailable": not items,
    }


# ---------------------------------------------------------------- 拍一拍（appmsg/62）


def parse_pat(value: str, sender: str, own_wxid: str):
    """解析拍一拍；只保留"拍的是自己、且不是自己拍的"那种。"""
    app = appmsg_root(value)
    if app is None or child_text(app, "type") != str(APP_PAT):
        return None
    info = app.find("patinfo")
    if info is None:
        return None
    actor = child_text(info, "fromusername")
    target = child_text(info, "pattedusername")
    own = clean_own_wxid(own_wxid)
    if not actor or (sender and actor != sender) or clean_own_wxid(actor) == own or target != own:
        return None
    return {"actor": actor, "target": target}


def clean_own_wxid(account_directory_or_wxid: str) -> str:
    """账号目录名（wxid_xxx_abcd）→ wxid_xxx；已是 wxid 原样返回。"""
    name = account_directory_or_wxid or ""
    parts = name.rsplit("_", 1)
    if len(parts) == 2 and len(parts[1]) == 4 and parts[1].isalnum():
        return parts[0]
    return name


def sender_is_self(sender: str, own_wxid: str) -> bool:
    """判断消息是否自己发出。"""
    if not own_wxid:
        return False
    own = clean_own_wxid(own_wxid)
    return sender == own_wxid or sender == own or (bool(sender) and sender.startswith(own))


# ---------------------------------------------------------------- 渲染与消息组装


def _system_display(text: str) -> str:
    """系统消息：能取到 <content> 就取正文，否则用原文；绝不返回空串。"""
    if text and text.lstrip().startswith("<"):
        try:
            root = safe_xml(text)
        except (ValueError, ET.ParseError, RecursionError):
            return "[系统消息]"
        for tag in ("content", "template", "plain"):
            node = root.find(f".//{tag}")
            if node is None:
                continue
            value = "".join(node.itertext()).strip()
            if value:
                return _clip(html.unescape(value), MAX_SYSTEM)
        return "[系统消息]"
    return _clip(html.unescape(text.strip()), MAX_SYSTEM) if text.strip() else "[系统消息]"


def render_content(local_type: int, text: str, sender: str, own_wxid: str) -> tuple[str, dict]:
    """把一条消息渲染成展示文本 + 结构化附加字段。

    @returns (content, extras)，extras 可能含 quoteReply/forwardedRecord/pat/typeText。
    """
    local_type = int(local_type or 0)
    info = classify(local_type)
    base, apptype = info["base"], info["apptype"]
    extras: dict = {"typeText": info["label"]}

    if base == TEXT:
        return _clip(html.unescape(text.strip()), MAX_CONTENT) or "[空文字消息]", extras
    if base == IMAGE:
        return "[图片]", extras
    if base == STICKER:
        return "[表情包]", extras
    if base == VOICE:
        return "[语音]", extras
    if base == VIDEO:
        return "[视频]", extras
    if base == CARD:
        return "[名片]", extras
    if base == LOCATION:
        return "[位置]", extras
    if base == SYSTEM:
        return _system_display(text), extras
    if base == APPMSG:
        if apptype == APP_QUOTE:
            quote = parse_quote(text)
            if quote:
                extras["quoteReply"] = quote
                reference = quote["reference"]
                content = quote["reply"] or "[引用回复，正文为空]"
                if reference and reference.get("text"):
                    content += QUOTE_SEP + reference["text"]
                return _clip(content, MAX_CONTENT), extras
            return "[引用消息，正文不可用]", extras
        if apptype == APP_FORWARDED:
            forwarded = parse_forwarded(text)
            if forwarded:
                extras["forwardedRecord"] = forwarded
                return f"[合并转发聊天记录] {forwarded['title']}", extras
            return "[合并转发聊天记录，内容不可用]", extras
        if apptype == APP_PAT:
            pat = parse_pat(text, sender, own_wxid)
            if pat:
                extras["pat"] = pat
                return "[拍一拍] 对方刚刚拍了拍你。", extras
            return "[拍一拍]", extras
        title = ""
        app = appmsg_root(text)
        if app is not None:
            title = child_text(app, "title") or child_text(app, "des")
            if _nullish(title):
                title = ""
            title = _clip(html.unescape(title), MAX_TITLE)
        label = info["label"]
        if apptype in (APP_LINK_4, APP_LINK_5):
            return f"[链接] {title}" if title else "[链接]", extras
        if apptype == APP_FILE:
            return f"[文件] {title}" if title else "[文件]", extras
        if apptype == APP_MINIPROGRAM:
            return f"[小程序] {title}" if title else "[小程序]", extras
        if apptype == APP_TRANSFER:
            return "[转账]" + (f" {title}" if title else ""), extras
        if apptype == APP_RED_PACKET:
            return "[红包]" + (f" {title}" if title else ""), extras
        if apptype in (APP_LIVE_51, APP_LIVE_63):
            return f"[{label}] {title}" if title else f"[{label}]", extras
        return f"[{label}] {title}" if title else f"[{label}]", extras
    return f"[未识别的消息类型 {local_type}]", extras


def raw_id(talker: str, server_id, local_id, create_time) -> str:
    """推送去重键：sha256(talker, serverId, localId, createTime)。"""
    import hashlib

    payload = json.dumps([talker, str(server_id or ""), int(local_id or 0), int(create_time or 0)],
                         separators=(",", ":"))
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def build_message(row: dict, *, talker: str, sender_map: dict, names: dict, own_wxid: str,
                  known_ids=None) -> dict:
    """消息行 → 内部消息结构（供 /messages 与推送共用）。"""
    local_type = int(row.get("local_type") or 0)
    create_time = int(row.get("create_time") or 0)
    real_sender_id = int(row.get("real_sender_id") or 0)
    is_group = "@chatroom" in (talker or "")
    sender = sender_map.get(real_sender_id, "") or ""
    decoded = decode_content(row.get("message_content"))
    prefix_sender = None
    if is_group:
        decoded, prefix_sender = strip_group_prefix(decoded, known_ids or set(names))
        if not sender and prefix_sender:
            sender = prefix_sender
    is_send = 1 if sender_is_self(sender, own_wxid) else 0
    content, extras = render_content(local_type, decoded, sender, own_wxid)
    sender_display = "" if is_send else names.get(sender, sender or "未知发言人")
    return {
        "localId": int(row.get("local_id") or 0),
        "serverId": str(row.get("server_id") or ""),
        "localType": local_type,
        "baseType": int(local_type) & 0xFFFFFFFF,
        "appType": int(local_type) >> 32,
        "createTime": create_time,
        "isSend": is_send,
        "senderUsername": sender,
        "senderDisplay": sender_display,
        "content": content,
        "typeText": extras.get("typeText", ""),
        "rawid": raw_id(talker, row.get("server_id"), row.get("local_id"), create_time),
        **({"quoteReply": extras["quoteReply"]} if "quoteReply" in extras else {}),
        **({"forwardedRecord": extras["forwardedRecord"]} if "forwardedRecord" in extras else {}),
        **({"pat": extras["pat"]} if "pat" in extras else {}),
    }


def push_payload(talker: str, message: dict, names: dict, own_wxid: str):
    """内部消息 → SSE message.new 事件；不入站/不需要推送的返回 None。"""
    if message.get("isSend"):
        return None
    local_type = int(message.get("localType") or 0)
    base = local_type & 0xFFFFFFFF
    apptype = local_type >> 32
    pushable = base in (TEXT, IMAGE, STICKER, SYSTEM) or (
        base == APPMSG and apptype in (
            APP_LINK_4, APP_LINK_5, APP_FILE, APP_STICKER, APP_FORWARDED,
            APP_MINIPROGRAM, APP_QUOTE, APP_PAT, APP_LIVE_51, APP_LIVE_63,
            APP_TRANSFER, APP_RED_PACKET,
        )
    )
    if not pushable:
        return None
    content = message.get("content", "")
    if not content or not content.strip():
        return None
    sender = message.get("senderUsername", "")
    group = "@chatroom" in (talker or "")
    image = None
    if base in (IMAGE, STICKER):
        image = {
            "localId": message.get("localId"),
            "serverId": message.get("serverId"),
            "createTime": message.get("createTime"),
            "localType": local_type,
        }
    return {
        "event": "message.new",
        "sessionId": talker,
        "sessionType": "group" if group else "private",
        "rawid": message.get("rawid"),
        "groupName": names.get(talker, talker) if group else "",
        "sourceName": names.get(sender, sender) if group else names.get(talker, talker),
        "senderName": names.get(sender, sender),
        "talkerId": sender,
        "content": content[:MAX_CONTENT],
        "type": int(local_type),
        "timestamp": message.get("createTime", 0),
        **({"pat": message["pat"]} if "pat" in message else {}),
        **({"forwardedRecord": message["forwardedRecord"]} if "forwardedRecord" in message else {}),
        **({"quoteReply": message["quoteReply"]} if "quoteReply" in message else {}),
        **({"image": image} if image else {}),
        **({"senderIsSelf": False} if False else {}),
    }
