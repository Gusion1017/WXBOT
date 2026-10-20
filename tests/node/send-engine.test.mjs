/**
 * M4 发送闭环单测：假 Hook + 假 reader。
 *
 * 覆盖（手册 §11）：正常受理+回执确认、超时 unconfirmed、409 rejected、
 * 基线排除（不把历史消息当回执）、白名单 403、启用开关。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { SendError, pickReceipt, sendWithReceipt } from '../../scripts/lib/send/send-engine.mjs';
import { TextDeliveryStore } from '../../scripts/lib/send/text-delivery-store.mjs';

const TOKEN = 'a'.repeat(64);

/**
 * 起一个可编程的假服务。
 * @param {(request: any, response: any, body: any) => void} handler 处理器。
 * @returns {Promise<{ baseUrl: string, port: number, close: () => Promise<void>, state: any }>} 服务。
 */
async function fakeServer(handler) {
  const state = { requests: [] };
  const server = http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      state.requests.push({ url: request.url, method: request.method, body });
      handler(request, response, body, state);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    port,
    state,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function json(response, status, body) {
  const raw = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) });
  response.end(raw);
}

/**
 * 组装假环境：hook + reader。
 * @param {object} options 选项。
 * @returns {Promise<any>} 环境。
 */
async function environment(options = {}) {
  const messages = options.messages ?? [];
  const hookHandler = options.hookHandler ?? ((_request, response) => json(response, 200, { ret: 0, retmsg: 'accepted' }));
  const hook = await fakeServer(hookHandler);
  const reader = await fakeServer((_request, response, _body, state) => {
    if (options.readerStatus === 403) {
      json(response, 403, { success: false, error: 'CONVERSATION_NOT_ALLOWED' });
      return;
    }
    json(response, 200, { success: true, messages: options.messagesForReader?.(state, messages) ?? messages });
  });
  const store = new TextDeliveryStore({ dir: await mkdtemp(path.join(tmpdir(), 'wxbot-send-')) });
  const config = {
    ports: { reader: reader.port },
    reader: { accountDirectory: 'wxid_me_abcd' },
    hook: {
      baseUrl: hook.baseUrl,
      requestTimeoutMs: 1000,
      receiptPollMs: 20,
      receiptTimeoutMs: options.receiptTimeoutMs ?? 120,
    },
    sender: { enabled: options.enabled ?? true, maxConcurrentSends: 4, maxActions: 8 },
  };
  return {
    hook,
    reader,
    store,
    config,
    text: options.text ?? '测试回复',
    close: async () => { await hook.close(); await reader.close(); await store.clear(); },
  };
}

test('pickReceipt：排除基线/非自己/无 serverId/文本不符', () => {
  const baseline = new Set([1]);
  const since = 1000;
  const messages = [
    { localId: 1, isSend: 1, createTime: 1001, content: 'x', serverId: '5' },       // 基线
    { localId: 2, isSend: 0, createTime: 1001, content: 'x', serverId: '6' },       // 非自己
    { localId: 3, isSend: 1, createTime: 1001, content: 'x', serverId: '0' },       // 无 serverId
    { localId: 4, isSend: 1, createTime: 1001, content: 'y', serverId: '7' },       // 文本不符
    { localId: 5, isSend: 1, createTime: 1001, content: 'x', serverId: '8' },       // 命中
  ];
  assert.deepEqual(pickReceipt(messages, { baseline, text: 'x', since }), { serverId: '8', localId: 5 });
});

test('正常受理 + 数据库回执 → confirmed', async () => {
  let calls = 0;
  const env = await environment({
    messagesForReader: () => {
      calls += 1;
      // 第 1 次是发送前基线；之后模拟数据库里出现了自己发出的、带 serverId 的消息
      if (calls === 1) return [];
      return [{
        localId: 10,
        isSend: 1,
        createTime: Math.floor(Date.now() / 1000),
        content: '测试回复',
        serverId: '12345',
      }];
    },
  });
  try {
    const record = await sendWithReceipt({
      config: env.config, readerToken: TOKEN, hookToken: TOKEN, store: env.store,
      talker: 'wxid_target', text: env.text,
    });
    assert.equal(record.state, 'confirmed');
    assert.equal(record.serverId, '12345');
    assert.equal(record.receipt, 'wechat-server-id');
    const sendRequests = env.hook.state.requests.filter((item) => item.url === '/SendTextMsg');
    assert.equal(sendRequests.length, 1);
  } finally {
    await env.close();
  }
});

test('回执超时 → unconfirmed，且绝不重发', async () => {
  const env = await environment({ messagesForReader: () => [] });
  try {
    const record = await sendWithReceipt({
      config: env.config, readerToken: TOKEN, hookToken: TOKEN, store: env.store,
      talker: 'wxid_target', text: env.text,
    });
    assert.equal(record.state, 'unconfirmed');
    assert.equal(record.reason, 'TEXT_DELIVERY_UNCONFIRMED');
    const sends = env.hook.state.requests.filter((item) => item.url === '/SendTextMsg');
    assert.equal(sends.length, 1, 'unconfirmed 不允许自动重发');
    // 重放只核对，不二次提交
    const replay = await sendWithReceipt({
      config: env.config, readerToken: TOKEN, hookToken: TOKEN, store: env.store,
      talker: 'wxid_target', text: env.text,
    });
    assert.equal(replay.state, 'unconfirmed');
    assert.equal(env.hook.state.requests.filter((item) => item.url === '/SendTextMsg').length, 1);
  } finally {
    await env.close();
  }
});

test('Hook 409 → rejected（不重试）', async () => {
  const env = await environment({
    hookHandler: (_request, response) => json(response, 409, { ret: 1 }),
    messagesForReader: () => [],
  });
  try {
    const record = await sendWithReceipt({
      config: env.config, readerToken: TOKEN, hookToken: TOKEN, store: env.store,
      talker: 'wxid_target', text: env.text,
    });
    assert.equal(record.state, 'rejected');
    assert.equal(record.reason, 'HOOK_VERSION_OR_ACCOUNT_MISMATCH');
    // rejected 后不应再轮询 reader
    assert.equal(env.reader.state.requests.filter((item) => item.url.startsWith('/api/v1/messages')).length, 1);
  } finally {
    await env.close();
  }
});

test('reader 403（白名单外）→ CONVERSATION_NOT_ALLOWED，且不发送', async () => {
  const env = await environment({ readerStatus: 403, messagesForReader: () => [] });
  try {
    await assert.rejects(() => sendWithReceipt({
      config: env.config, readerToken: TOKEN, hookToken: TOKEN, store: env.store,
      talker: 'wxid_target', text: env.text,
    }), (error) => error instanceof SendError && error.code === 'CONVERSATION_NOT_ALLOWED');
    assert.equal(env.hook.state.requests.length, 0);
  } finally {
    await env.close();
  }
});

test('sender.enabled=false → SENDER_DISABLED，且不落盘不发送', async () => {
  const env = await environment({ enabled: false });
  try {
    await assert.rejects(() => sendWithReceipt({
      config: env.config, readerToken: TOKEN, hookToken: TOKEN, store: env.store,
      talker: 'wxid_target', text: env.text,
    }), (error) => error.code === 'SENDER_DISABLED');
    assert.equal(env.hook.state.requests.length, 0);
    assert.deepEqual(await env.store.list(), []);
  } finally {
    await env.close();
  }
});
