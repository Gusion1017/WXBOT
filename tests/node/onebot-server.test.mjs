/**
 * M5 OneBot 服务端单测：鉴权/单连接踢旧/echo 关联/超时/非法帧/断开清理。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { OneBotServer } from '../../scripts/lib/bridge/onebot-server.mjs';

const TOKEN = 'b'.repeat(64);

/**
 * 启动一个测试服务并返回实际端口。
 * @param {object} [options] 覆盖配置。
 * @returns {Promise<{ server: OneBotServer, port: number, url: string, close: () => Promise<void> }>} 服务信息。
 */
async function startServer(options = {}) {
  const server = new OneBotServer({
    port: 0,
    path: '/ws',
    token: TOKEN,
    requestTimeoutMs: 200,
    maxFrameBytes: 1024,
    ...options,
  });
  await server.start();
  const { port } = server.httpServer.address();
  return {
    server,
    port,
    url: `ws://127.0.0.1:${port}/ws`,
    close: () => server.stop(),
  };
}

/**
 * 建立客户端连接。
 * @param {string} url 地址。
 * @param {string} [token] token。
 * @returns {Promise<WebSocket>} 连接。
 */
function connect(url, token = TOKEN) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    const timer = setTimeout(() => reject(new Error('connect timeout')), 2000);
    socket.once('open', () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

/**
 * 等待消息。
 * @param {WebSocket} socket 连接。
 * @param {number} [timeoutMs] 超时。
 * @returns {Promise<any>} 解析后的消息。
 */
function nextMessage(socket, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('message timeout')), timeoutMs);
    socket.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(String(data)));
    });
  });
}

test('错误 token 拒绝连接（401）', async () => {
  const env = await startServer();
  try {
    await assert.rejects(() => connect(env.url, 'c'.repeat(64)));
  } finally {
    await env.close();
  }
});

test('正确 token 可连接并触发 open 事件', async () => {
  const env = await startServer();
  const events = [];
  env.server.on('open', () => events.push('open'));
  try {
    const socket = await connect(env.url);
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(env.server.connected, true);
    assert.ok(events.includes('open'));
    socket.close();
  } finally {
    await env.close();
  }
});

test('action echo 正确关联并返回数据', async () => {
  const env = await startServer();
  try {
    const socket = await connect(env.url);
    socket.on('message', (data) => {
      const frame = JSON.parse(String(data));
      if (frame.action === 'send_private_msg') {
        socket.send(JSON.stringify({
          status: 'ok', retcode: 0, data: { message_id: 42, serverId: '100' }, echo: frame.echo,
        }));
      }
    });
    const response = await env.server.action('send_private_msg', { user_id: 1, message: 'hi' });
    assert.equal(response.data.message_id, 42);
    socket.close();
  } finally {
    await env.close();
  }
});

test('action 超时 -> ONEBOT_ACTION_TIMEOUT 且清理 pending', async () => {
  const env = await startServer({ requestTimeoutMs: 100 });
  try {
    const socket = await connect(env.url);
    await assert.rejects(() => env.server.action('noop'), (error) => error.code === 'ONEBOT_ACTION_TIMEOUT');
    assert.equal(env.server.pending.size, 0);
    socket.close();
  } finally {
    await env.close();
  }
});

test('非法 JSON / 数组帧 -> invalid 事件', async () => {
  const env = await startServer();
  const invalid = [];
  env.server.on('invalid', (reason) => invalid.push(reason));
  try {
    const socket = await connect(env.url);
    socket.send('not-json');
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.send(JSON.stringify([1, 2, 3]));
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.ok(invalid.includes('invalid_json'));
    assert.ok(invalid.includes('invalid_frame'));
    socket.close();
  } finally {
    await env.close();
  }
});

test('新连接踢掉旧连接（单连接模型）', async () => {
  const env = await startServer();
  try {
    const first = await connect(env.url);
    const firstClosed = new Promise((resolve) => first.once('close', resolve));
    const second = await connect(env.url);
    await firstClosed;
    assert.equal(env.server.connected, true);
    second.close();
  } finally {
    await env.close();
  }
});

test('断开连接时 pending action 立即失败', async () => {
  const env = await startServer({ requestTimeoutMs: 5000 });
  try {
    const socket = await connect(env.url);
    const pending = env.server.action('noop');
    socket.close();
    await assert.rejects(() => pending, (error) => error.code === 'ONEBOT_DISCONNECTED');
  } finally {
    await env.close();
  }
});

test('未连接时 action 直接拒绝', async () => {
  const env = await startServer();
  try {
    await assert.rejects(() => env.server.action('noop'), (error) => error.code === 'ONEBOT_DISCONNECTED');
  } finally {
    await env.close();
  }
});
