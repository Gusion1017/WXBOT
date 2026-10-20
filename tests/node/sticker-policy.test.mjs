/**
 * 表情通用策略单测：总开关、群聊、明确要求、冷却、每小时上限。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { attachMatchedSticker, isExplicitStickerRequest, matchStickerOccasions, stickerOfferDecision } from '../../scripts/lib/sticker/sticker-policy.mjs';

const base = {
  sticker: {
    enabled: true,
    groupsEnabled: true,
    mode: 'smart',
    cooldownSeconds: 60,
    maxPerHour: 10,
  },
};

/**
 * 决策请求。
 * @param {string} text 文本。
 * @param {string} kind 类型。
 * @returns {any} 请求。
 */
function request(text, kind = 'private') {
  return { kind, sessionKey: 'wechat:' + kind + ':1', messages: [{ text }] };
}

test('stickerOfferDecision：默认智能模式允许', () => {
  assert.equal(stickerOfferDecision({ config: base, request: request('在吗'), now: 1000 }).allowed, true);
});

test('stickerOfferDecision：关闭总开关/群聊关闭时拒绝', () => {
  assert.equal(stickerOfferDecision({ config: { sticker: { ...base.sticker, enabled: false } }, request: request('在吗'), now: 1000 }).allowed, false);
  assert.equal(stickerOfferDecision({ config: { sticker: { ...base.sticker, groupsEnabled: false } }, request: request('在吗', 'group'), now: 1000 }).allowed, false);
  assert.equal(stickerOfferDecision({ config: { sticker: { ...base.sticker, groupsEnabled: false } }, request: request('在吗', 'private'), now: 1000 }).allowed, true);
});

test('stickerOfferDecision：explicit 模式只对明确要表情的文本开放', () => {
  const config = { sticker: { ...base.sticker, mode: 'explicit' } };
  assert.equal(isExplicitStickerRequest(request('发个开心表情包')), true);
  assert.equal(isExplicitStickerRequest(request('在吗')), false);
  assert.equal(stickerOfferDecision({ config, request: request('发个表情包'), now: 1000 }).allowed, true);
  assert.equal(stickerOfferDecision({ config, request: request('在吗'), now: 1000 }).allowed, false);
});

test('stickerOfferDecision：会话冷却与每小时上限', () => {
  const cooldown = stickerOfferDecision({
    config: base,
    request: request('在吗'),
    now: 30_000,
    lastStickerAt: 1000,
  });
  assert.equal(cooldown.allowed, false);
  assert.equal(cooldown.reason, 'cooldown');
  const hourly = stickerOfferDecision({
    config: { sticker: { ...base.sticker, cooldownSeconds: 0, maxPerHour: 2 } },
    request: request('在吗'),
    now: 1000,
    recentStickerTimes: [900, 800],
  });
  assert.equal(hourly.allowed, false);
  assert.equal(hourly.reason, 'hourly_limit');
});


test('matchStickerOccasions：对话命中时机关键词，没命中不硬凑', () => {
  const stickers = [
    { id: 's_happy', name: '嬉笑', occasion: '搞怪，嘲笑，临机一动', enabled: true },
    { id: 's_food', name: '等饭', occasion: '想吃饭，饿了，想要Token，吃白饭', enabled: true },
    { id: 's_no', name: '哒咩', occasion: '委婉拒绝', enabled: true },
  ];
  const laugh = matchStickerOccasions(stickers, '哈哈哈嘲笑你一下');
  assert.equal(laugh[0].id, 's_happy');
  const hungry = matchStickerOccasions(stickers, '我好饿想吃饭');
  assert.equal(hungry[0].id, 's_food');
  assert.deepEqual(matchStickerOccasions(stickers, '今天天气不错'), []);
});

test('attachMatchedSticker：只在文字回复上追加，且不覆盖纯表情/SILENT', () => {
  const matches = [{ id: 's_happy' }];
  assert.deepEqual(attachMatchedSticker({ action: 'RESPOND', text: '好呀' }, matches, true), {
    action: 'RESPOND', text: '好呀', stickerId: 's_happy',
  });
  assert.deepEqual(attachMatchedSticker({ action: 'RESPOND', text: '好呀', stickerId: 'own' }, matches, true), {
    action: 'RESPOND', text: '好呀', stickerId: 'own',
  });
  assert.deepEqual(attachMatchedSticker({ action: 'SILENT' }, matches, true), { action: 'SILENT' });
  assert.deepEqual(attachMatchedSticker({ action: 'RESPOND', text: '好呀' }, matches, false), {
    action: 'RESPOND', text: '好呀',
  });
});
