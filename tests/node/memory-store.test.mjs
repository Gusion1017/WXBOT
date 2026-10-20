/**
 * 会话记忆层单测：短期上限、超限摘要、时间衰减排序、会话隔离、摘要失败降级、Markdown 输出。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemoryStore, timeDecayWeight } from '../../scripts/lib/memory/memory-store.mjs';

const DAY = 86_400_000;

/**
 * 创建记忆仓库。
 * @param {object} [options] 选项。
 * @returns {Promise<{ store: MemoryStore, summaries: string[][] }>} 仓库。
 */
async function makeStore(options = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wxbot-memory-'));
  const summaries = [];
  const summarize = options.summarize ?? (async (entries) => {
    summaries.push(entries);
    return `摘要：${entries[0].text}`;
  });
  const store = new MemoryStore({
    dir,
    config: {
      enabled: true,
      shortTermLimit: 10,
      halfLifeDays: 7,
      maxPromptChars: 1600,
      maxEntries: 120,
      summaryMaxChars: 500,
      summarizeWithModel: true,
      ...options.config,
    },
    summarize,
    now: options.now ?? (() => Date.now()),
    log: options.log,
  });
  return { store, summaries };
}

test('MemoryStore：10 条内不摘要，超过后只保留 10 条并生成长期记忆', async () => {
  let now = 1_790_000_000_000;
  const { store, summaries } = await makeStore({ now: () => now });
  for (let i = 1; i <= 5; i += 1) {
    now += 1000;
    const result = await store.recordExchange('wechat:private:wxid_a', {
      incoming: [{ senderName: '对方', text: `消息${i}`, timestamp: now }],
      reply: `回复${i}`,
    });
    assert.equal(result.summarized, false);
  }
  let state = await store.load('wechat:private:wxid_a');
  assert.equal(state.longTerm.length, 0);
  assert.ok(state.shortTerm.length <= 10);

  now += 1000;
  const overflow = await store.recordExchange('wechat:private:wxid_a', {
    incoming: [{ senderName: '对方', text: '消息11', timestamp: now }],
  });
  assert.equal(overflow.summarized, true);
  assert.equal(summaries.length, 1);
  state = await store.load('wechat:private:wxid_a');
  assert.equal(state.shortTerm.length, 10);
  assert.equal(state.longTerm.length, 1);
  assert.match(state.longTerm[0].text, /摘要/);

  const files = store.filesFor('wechat:private:wxid_a');
  const markdown = await readFile(files.markdown, 'utf8');
  assert.match(markdown, /## 长期记忆/);
  assert.match(markdown, /## 临时记忆/);
  assert.match(markdown, /摘要/);
});

test('MemoryStore：长期记忆按时间权重排序，越近越靠前', async () => {
  let now = 1_790_000_000_000;
  const { store } = await makeStore({ now: () => now });
  // 先制造一条 30 天前的长期记忆
  for (let i = 0; i < 11; i += 1) {
    now += 1000;
    await store.recordExchange('wechat:group:g1', {
      incoming: [{ senderName: '群友', text: `旧消息${i}`, timestamp: now - 30 * DAY }],
    });
  }
  // 再制造一条今天的新长期记忆
  for (let i = 0; i < 10; i += 1) {
    now += 1000;
    await store.recordExchange('wechat:group:g1', {
      incoming: [{ senderName: '群友', text: `新消息${i}`, timestamp: now }],
    });
  }
  now += 1000;
  await store.recordExchange('wechat:group:g1', {
    incoming: [{ senderName: '群友', text: '新消息触发', timestamp: now }],
  });
  const state = await store.load('wechat:group:g1');
  assert.ok(state.longTerm.length >= 2);
  const context = await store.context('wechat:group:g1');
  const newPos = context.indexOf('新消息');
  const oldPos = context.indexOf('旧消息');
  assert.ok(newPos >= 0 && oldPos >= 0);
  assert.ok(newPos < oldPos, '新记忆应排在旧记忆前面');
  assert.ok(timeDecayWeight(now, now, 7) > timeDecayWeight(now - 30 * DAY, now, 7));
});

test('MemoryStore：会话隔离，互不读取对方记忆', async () => {
  let now = 1_790_000_000_000;
  const { store } = await makeStore({ now: () => now });
  await store.recordExchange('wechat:private:wxid_a', {
    incoming: [{ senderName: 'A', text: '只属于A的记忆', timestamp: now }],
  });
  await store.recordExchange('wechat:private:wxid_b', {
    incoming: [{ senderName: 'B', text: '只属于B的记忆', timestamp: now }],
  });
  const a = await store.context('wechat:private:wxid_a');
  const b = await store.context('wechat:private:wxid_b');
  assert.match(a, /只属于A/);
  assert.doesNotMatch(a, /只属于B/);
  assert.match(b, /只属于B/);
  assert.doesNotMatch(b, /只属于A/);
  assert.notEqual(store.filesFor('wechat:private:wxid_a').json, store.filesFor('wechat:private:wxid_b').json);
});

test('MemoryStore：摘要模型失败时使用确定性降级摘要', async () => {
  let now = 1_790_000_000_000;
  const { store } = await makeStore({
    now: () => now,
    summarize: async () => { throw new Error('summary down'); },
  });
  for (let i = 0; i < 11; i += 1) {
    now += 1000;
    await store.recordExchange('wechat:private:wxid_c', {
      incoming: [{ senderName: 'C', text: `消息${i}`, timestamp: now }],
    });
  }
  const state = await store.load('wechat:private:wxid_c');
  assert.equal(state.longTerm.length, 1);
  assert.ok(state.longTerm[0].text.length > 0);
  const context = await store.context('wechat:private:wxid_c');
  assert.ok(context.length > 0);
});

test('MemoryStore：禁用时不写文件、不返回上下文', async () => {
  const { store } = await makeStore({ config: { enabled: false } });
  const result = await store.recordExchange('wechat:private:wxid_d', {
    incoming: [{ senderName: 'D', text: 'hello', timestamp: Date.now() }],
  });
  assert.equal(result.added, 0);
  assert.equal(await store.context('wechat:private:wxid_d'), '');
});
