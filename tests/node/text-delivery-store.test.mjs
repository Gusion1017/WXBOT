/**
 * M4 发送 attempt 状态机单测（先落盘、终结态不可变、正文不落盘）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  TextDeliveryStore,
  deliveryIdFor,
  textHashOf,
} from '../../scripts/lib/send/text-delivery-store.mjs';

async function makeStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'wxbot-deliveries-'));
  return { store: new TextDeliveryStore({ dir }), dir };
}

const BASE = {
  kind: 'private',
  target: 'wxid_target',
  text: '这是一条测试回复',
  accountDirectory: 'wxid_test_abcd',
  baselineLocalIds: [1, 2, 3],
};

test('deliveryId 稳定；begin 幂等（重放不新建）', async () => {
  const { store } = await makeStore();
  const id = deliveryIdFor({ kind: 'private', target: 'wxid_x', text: 'hello' });
  assert.equal(id.length, 64);
  assert.equal(id, deliveryIdFor({ kind: 'private', target: 'wxid_x', text: 'hello' }));

  const first = await store.begin({ ...BASE, deliveryId: id });
  assert.equal(first.reused, false);
  assert.equal(first.record.state, 'dispatching');
  assert.deepEqual(first.record.baselineLocalIds, [1, 2, 3]);

  const second = await store.begin({ ...BASE, deliveryId: id });
  assert.equal(second.reused, true);
  assert.equal(second.record.deliveryId, id);
});

test('落盘内容不含聊天正文（只存哈希与长度）', async () => {
  const { store, dir } = await makeStore();
  const { record } = await store.begin(BASE);
  const raw = await readFile(path.join(dir, `${record.deliveryId}.json`), 'utf8');
  assert.ok(!raw.includes(BASE.text));
  assert.equal(record.textHash, textHashOf(BASE.text));
  assert.equal(record.textLength, BASE.text.length);
});

test('状态机 dispatching → accepted → confirmed', async () => {
  const { store } = await makeStore();
  const { record } = await store.begin(BASE);
  await store.markAccepted(record.deliveryId);
  const confirmed = await store.markConfirmed(record.deliveryId, {
    serverId: '123456789', localId: 42,
  });
  assert.equal(confirmed.state, 'confirmed');
  assert.equal(confirmed.serverId, '123456789');
  assert.equal(confirmed.localId, 42);
  assert.equal(confirmed.receipt, 'wechat-server-id');
  assert.equal(confirmed.attempts.length, 3);
});

test('unconfirmed / rejected 也是终结态，不可回改', async () => {
  const { store } = await makeStore();
  const first = await store.begin({ ...BASE, target: 'wxid_a' });
  await store.markUnconfirmed(first.record.deliveryId, 'receipt timeout');
  await assert.rejects(() => store.markConfirmed(first.record.deliveryId, { serverId: '1', localId: 1 }), /已终结/);

  const second = await store.begin({ ...BASE, target: 'wxid_b' });
  await store.markRejected(second.record.deliveryId, 'HOOK_BUSY');
  const record = await store.get(second.record.deliveryId);
  assert.equal(record.state, 'rejected');
  assert.equal(record.reason, 'HOOK_BUSY');
});

test('summary/list 统计与排序', async () => {
  const { store } = await makeStore();
  const a = await store.begin({ ...BASE, target: 'wxid_a' });
  const b = await store.begin({ ...BASE, target: 'wxid_b' });
  await store.markAccepted(a.record.deliveryId);
  await store.markConfirmed(a.record.deliveryId, { serverId: '1', localId: 1 });
  await store.markRejected(b.record.deliveryId, 'nope');
  const summary = await store.summary();
  assert.equal(summary.confirmed, 1);
  assert.equal(summary.rejected, 1);
  const list = await store.list();
  assert.equal(list.length, 2);
  assert.deepEqual(await readdir(store.dir), expectTwoFiles(list));
});

function expectTwoFiles(list) {
  return list.map((item) => `${item.deliveryId}.json`).sort();
}

test('transition 未知状态 / 不存在记录报错', async () => {
  const { store } = await makeStore();
  const { record } = await store.begin(BASE);
  await assert.rejects(() => store.transition(record.deliveryId, 'nope'), /未知状态/);
  await assert.rejects(() => store.transition('f'.repeat(64), 'accepted'), /不存在/);
});
