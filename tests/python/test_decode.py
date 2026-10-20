"""M1/M2 解码层单测（手册 §11：XML/引用/转发/拍一拍/占位文本/去重键）。"""
from __future__ import annotations

import json

import pytest

from lib.reader import wechat_decode as decode


def test_decode_content_zstd_and_plain():
    """zstd BLOB 能解压成 UTF-8；纯字符串原样返回。"""
    import zstandard

    raw = zstandard.ZstdCompressor().compress("你好 世界".encode("utf-8"))
    assert decode.decode_content(raw) == "你好 世界"
    assert decode.decode_content("plain") == "plain"
    assert decode.decode_content(b"plain-bytes") == "plain-bytes"
    assert decode.decode_content(None) == ""
    assert decode.decode_content(b"\x00\x01") == "\x00\x01"


@pytest.mark.parametrize(
    ("local_type", "expected"),
    [
        (3, "[图片]"),
        (34, "[语音]"),
        (42, "[名片]"),
        (43, "[视频]"),
        (47, "[表情包]"),
        (48, "[位置]"),
    ],
)
def test_non_text_placeholders(local_type, expected):
    """非文本消息必须给占位文本，不能是空串。"""
    content, _extras = decode.render_content(local_type, "", "wxid_x", "wxid_me")
    assert content == expected


def test_unknown_type_has_placeholder():
    content, extras = decode.render_content(999999, "", "wxid_x", "wxid_me")
    assert content.startswith("[未识别的消息类型 ")
    assert extras["typeText"].startswith("未识别类型")


def test_text_entities_unescaped():
    content, _ = decode.render_content(1, "a&amp;b &lt;tag&gt;", "wxid_x", "wxid_me")
    assert content == "a&b <tag>"


def test_system_message_extracts_content():
    xml = "<sysmsg><revokemsg><content>某某撤回了一条消息</content></revokemsg></sysmsg>"
    content, _ = decode.render_content(10000, xml, "wxid_x", "wxid_me")
    assert content == "某某撤回了一条消息"


def test_plain_system_message_kept():
    content, _ = decode.render_content(10000, "你已添加了对方为朋友", "wxid_x", "wxid_me")
    assert content == "你已添加了对方为朋友"


def test_self_closing_title_does_not_swallow_following_xml():
    xml = '<msg><appmsg><type>5</type><title /></appmsg></msg>'
    content, _ = decode.render_content((5 << 32) | 49, xml, "wxid_x", "wxid_me")
    assert content == "[链接]"


def test_nested_title_container_uses_direct_child():
    """嵌套容器里的同名 <title> 不能被当成消息标题（手册 §13.7）。"""
    xml = (
        "<msg><appmsg><type>5</type><title>真实标题</title>"
        "<emotionpageshared><title>嵌套错标题</title></emotionpageshared></appmsg></msg>"
    )
    content, _ = decode.render_content((5 << 32) | 49, xml, "wxid_x", "wxid_me")
    assert content == "[链接] 真实标题"


def test_link_title_clipped_with_ellipsis():
    xml = "<msg><appmsg><type>4</type><title>" + "长" * 500 + "</title></appmsg></msg>"
    content, _ = decode.render_content((4 << 32) | 49, xml, "wxid_x", "wxid_me")
    assert content.startswith("[链接] ")
    assert content.endswith("…")


def test_quote_reply_carries_reference_text():
    xml = (
        "<msg><appmsg><title>我的回复</title><type>57</type><refermsg>"
        "<type>1</type><svrid>7</svrid><fromusr>wxid_friend</fromusr>"
        "<chatusr>wxid_friend</chatusr><displayname>好友</displayname>"
        "<content>被引用的原话</content><createtime>1790000001</createtime>"
        "</refermsg></appmsg></msg>"
    )
    content, extras = decode.render_content((57 << 32) | 49, xml, "wxid_friend", "wxid_me")
    assert content == "我的回复" + decode.QUOTE_SEP + "被引用的原话"
    quote = extras["quoteReply"]
    assert quote["reply"] == "我的回复"
    assert quote["reference"]["text"] == "被引用的原话"
    assert quote["reference"]["kind"] == "1"
    assert quote["reference"]["unavailable"] is False


def test_quote_self_closing_content_is_unavailable():
    xml = (
        "<msg><appmsg><title>回复</title><type>57</type><refermsg>"
        "<type>1</type><fromusr>wxid_friend</fromusr><content /></refermsg></appmsg></msg>"
    )
    _content, extras = decode.render_content((57 << 32) | 49, xml, "wxid_friend", "wxid_me")
    assert extras["quoteReply"]["reference"]["unavailable"] is True
    assert extras["quoteReply"]["reference"]["text"] == "[被引用文字不可用]"


def test_quote_of_forwarded_is_bounded():
    inner = (
        "<msg><appmsg><title>聊天记录</title><type>19</type><recorditem><![CDATA["
        "<recordinfo><datalist><dataitem datatype=\"1\"><sourcename>A</sourcename>"
        "<sourcetime>t</sourcetime><datadesc>hi</datadesc></dataitem></datalist></recordinfo>"
        "]]></recorditem></appmsg></msg>"
    )
    xml = (
        "<msg><appmsg><title>回复转发</title><type>57</type><refermsg>"
        "<type>49</type><fromusr>wxid_friend</fromusr><content>" + inner + "</content>"
        "</refermsg></appmsg></msg>"
    )
    _content, extras = decode.render_content((57 << 32) | 49, xml, "wxid_friend", "wxid_me")
    assert "合并聊天记录" in extras["quoteReply"]["reference"]["text"]


def test_forwarded_record_items_parsed():
    xml = (
        "<msg><appmsg><title>三个人的群聊记录</title><type>19</type><recorditem><![CDATA["
        "<recordinfo><datalist>"
        "<dataitem datatype=\"1\"><sourcename>张三</sourcename><sourcetime>2026-01-01</sourcetime>"
        "<datadesc>第一句</datadesc></dataitem>"
        "<dataitem datatype=\"3\"><sourcename>李四</sourcename><sourcetime>2026-01-02</sourcetime>"
        "<datadesc>语音</datadesc></dataitem>"
        "</datalist></recordinfo>]]></recorditem></appmsg></msg>"
    )
    content, extras = decode.render_content((19 << 32) | 49, xml, "wxid_x", "wxid_me")
    assert content == "[合并转发聊天记录] 三个人的群聊记录"
    forwarded = extras["forwardedRecord"]
    assert forwarded["title"] == "三个人的群聊记录"
    assert [item["sender"] for item in forwarded["items"]] == ["张三", "李四"]
    assert forwarded["items"][0]["text"] == "第一句"
    assert forwarded["items"][1]["text"].startswith("[语音")


def test_forwarded_rejects_doctype():
    xml = (
        "<msg><appmsg><type>19</type><title>x</title><recorditem>"
        "<!DOCTYPE foo><recordinfo><datalist/></recordinfo></recorditem></appmsg></msg>"
    )
    content, extras = decode.render_content((19 << 32) | 49, xml, "wxid_x", "wxid_me")
    assert content.startswith("[合并转发聊天记录")
    assert "forwardedRecord" not in extras


def test_pat_requires_target_self_and_other_actor():
    xml = (
        "<msg><appmsg><type>62</type><patinfo>"
        "<fromusername>wxid_actor</fromusername><pattedusername>wxid_me</pattedusername>"
        "</patinfo></appmsg></msg>"
    )
    content, extras = decode.render_content((62 << 32) | 49, xml, "wxid_actor", "wxid_me")
    assert content == "[拍一拍] 对方刚刚拍了拍你。"
    assert extras["pat"] == {"actor": "wxid_actor", "target": "wxid_me"}

    # 拍的不是自己 -> 不产生 pat 结构化信息
    xml_other = xml.replace("wxid_me</pattedusername>", "wxid_someone</pattedusername>")
    content_other, extras_other = decode.render_content((62 << 32) | 49, xml_other, "wxid_actor", "wxid_me")
    assert content_other == "[拍一拍]"
    assert "pat" not in extras_other


def test_group_prefix_stripped_only_for_known_ids():
    known = {"wxid_friend"}
    text, sender = decode.strip_group_prefix("wxid_friend:\n你好", known)
    assert (text, sender) == ("你好", "wxid_friend")

    untouched, sender2 = decode.strip_group_prefix("note: 这不是id前缀", known)
    assert untouched == "note: 这不是id前缀"
    assert sender2 is None


def test_build_message_group_image():
    row = {
        "local_id": 1,
        "server_id": 2001,
        "local_type": 3,
        "real_sender_id": 3,
        "create_time": 1790000003,
        "message_content": None,
    }
    message = decode.build_message(
        {**row, "message_content": __import__("zstandard").ZstdCompressor().compress(
            "<msg><img /></msg>".encode())},
        talker="123@chatroom",
        sender_map={3: "wxid_friend"},
        names={"wxid_friend": "好友"},
        own_wxid="wxid_me",
        known_ids={"wxid_friend"},
    )
    assert message["content"] == "[图片]"
    assert message["senderUsername"] == "wxid_friend"
    assert message["senderDisplay"] == "好友"
    assert message["isSend"] == 0
    assert message["rawid"] == decode.raw_id("123@chatroom", 2001, 1, 1790000003)


def test_build_message_self_detection():
    row = {
        "local_id": 2,
        "server_id": 1002,
        "local_type": 1,
        "real_sender_id": 2,
        "create_time": 1790000002,
        "message_content": __import__("zstandard").ZstdCompressor().compress("我自己的回复".encode()),
    }
    message = decode.build_message(
        row, talker="wxid_friend_abcd", sender_map={2: "wxid_me_abcd"},
        names={}, own_wxid="wxid_me_abcd", known_ids=set(),
    )
    assert message["isSend"] == 1
    assert message["content"] == "我自己的回复"
    assert message["senderDisplay"] == ""


def test_push_payload_skips_self_and_builds_image():
    message = {
        "rawid": "r" * 64,
        "localId": 1,
        "serverId": "2",
        "localType": 3,
        "createTime": 1790000003,
        "isSend": 0,
        "senderUsername": "wxid_friend",
        "content": "[图片]",
    }
    payload = decode.push_payload("123@chatroom", message, {"wxid_friend": "好友"}, "wxid_me")
    assert payload["event"] == "message.new"
    assert payload["sessionType"] == "group"
    assert payload["image"]["localId"] == 1
    assert payload["content"] == "[图片]"
    assert payload["groupName"] == "好友" or payload["groupName"] == "123@chatroom"

    assert decode.push_payload("123@chatroom", {**message, "isSend": 1}, {}, "wxid_me") is None


def test_push_payload_never_empty():
    message = {
        "rawid": "r" * 64, "localId": 1, "serverId": "2", "localType": 1,
        "createTime": 1, "isSend": 0, "senderUsername": "wxid_friend", "content": "   ",
    }
    assert decode.push_payload("wxid_friend", message, {}, "wxid_me") is None


def test_raw_id_stable_and_sensitive_to_fields():
    a = decode.raw_id("t", 1, 2, 3)
    b = decode.raw_id("t", 1, 2, 3)
    c = decode.raw_id("t", 1, 2, 4)
    assert a == b and a != c and len(a) == 64
