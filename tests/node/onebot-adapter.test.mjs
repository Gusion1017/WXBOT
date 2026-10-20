/**
 * M5 适配器纯函数单测：reader 事件 → OneBot 事件、目标索引、@ 合成、白名单。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTargetIndex, findSelfDisplay, toOneBotEvent } from '../../scripts/lib/bridge/onebot-adapter.mjs';
import { normalizeGroupName, onebotId, whitelistIdSets } from '../../scripts/lib/bridge/onebot-id.mjs';

const WXID = 'wxid_friend_abcd';
const GROUP_NAME = '测试群(2)';
const SELF_ID = onebotId('wxid_me_abcd');
const WHITELIST = whitelistIdSets({ whitelist: { enabled: true, private: [WXID], groups: [GROUP_NAME] } });

test('buildTargetIndex：私聊用 wxid、群用去尾号显示名', () => {
  const index = buildTargetIndex([
    { talker: WXID, displayName: '好友', sessionType: 'private' },
    { talker: '123@chatroom', displayName: GROUP_NAME, sessionType: 'group' },
  ]);
  assert.equal(index.byPrivate.get(onebotId(WXID))?.talker, WXID);
  assert.equal(index.byGroup.get(onebotId('测试群'))?.talker, '123@chatroom');
  assert.equal(normalizeGroupName(GROUP_NAME), '测试群');
});

test('toOneBotEvent：私聊白名单事件映射正确', () => {
  const event = toOneBotEvent({
    event: 'message.new',
    sessionType: 'private',
    sessionId: WXID,
    rawid: 'r'.repeat(64),
    senderName: '好友',
    talkerId: WXID,
    content: '在吗',
    timestamp: 1790000000,
  }, { selfId: SELF_ID, selfDisplay: '我', whitelist: WHITELIST });
  assert.equal(event.message_type, 'private');
  assert.equal(event.user_id, Number(onebotId(WXID)));
  assert.equal(event.message_id, 'r'.repeat(64));
  assert.equal(event.raw_message, '在吗');
  assert.equal(event.self_id, Number(SELF_ID));
  assert.deepEqual(event.message, [{ type: 'text', data: { text: '在吗' } }]);
});

test('toOneBotEvent：群消息白名单 + @自己合成 at 段', () => {
  const event = toOneBotEvent({
    event: 'message.new',
    sessionType: 'group',
    sessionId: '123@chatroom',
    groupName: GROUP_NAME,
    rawid: 'g'.repeat(64),
    senderName: '群友',
    talkerId: 'wxid_sender',
    content: '@我 你看这个',
    timestamp: 1790000000,
  }, { selfId: SELF_ID, selfDisplay: '我', whitelist: WHITELIST });
  assert.equal(event.message_type, 'group');
  assert.equal(event.group_id, Number(onebotId('测试群')));
  assert.equal(event.message[0].type, 'at');
  assert.equal(event.message[0].data.qq, SELF_ID);
});

test('toOneBotEvent：白名单外会话返回 null', () => {
  assert.equal(toOneBotEvent({
    event: 'message.new',
    sessionType: 'private',
    sessionId: 'wxid_other',
    rawid: 'x'.repeat(64),
    content: 'hi',
    timestamp: 1,
  }, { selfId: SELF_ID, whitelist: WHITELIST }), null);
  assert.equal(toOneBotEvent({ event: 'other' }, { selfId: SELF_ID, whitelist: WHITELIST }), null);
});

test('toOneBotEvent：引用/转发/拍一拍标记进 raw_event', () => {
  const event = toOneBotEvent({
    event: 'message.new',
    sessionType: 'private',
    sessionId: WXID,
    rawid: 'q'.repeat(64),
    content: '回复',
    timestamp: 1,
    quoteReply: { reply: '回复' },
    pat: { actor: 'x', target: 'y' },
  }, { selfId: SELF_ID, whitelist: WHITELIST });
  assert.equal(event.raw_event.quote, true);
  assert.equal(event.raw_event.pat, true);
});

test('findSelfDisplay 按 ownWxid 找显示名', () => {
  const display = findSelfDisplay([
    { username: 'wxid_other', displayName: '别人' },
    { username: 'wxid_me_abcd', displayName: '我自己' },
  ], 'wxid_me_abcd');
  assert.equal(display, '我自己');
  assert.equal(findSelfDisplay([], 'wxid_me_abcd'), '');
});
