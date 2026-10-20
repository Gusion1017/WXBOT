/**
 * M4 Hook 客户端单测：用假 Hook 服务器验证 401/409/429/超时/正常受理与版本/账号锁。
 * （手册 §11 集成测试：假 hook 服务器）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {
  HookError,
  checkNative,
  health,
  requestJson,
  sendText,
  waitForNative,
} from '../../scripts/lib/send/hook-client.mjs';

/**
 * 起一个假服务器。
 * @param {(request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, body: any) => void} handler 处理函数。
 * @returns {Promise<{ baseUrl: string, close: () => Promise<void> }>} 服务信息。
 */
async function fakeServer(handler) {
  const server = http.createServer((request, response) => {
    let raw = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { raw += chunk; });
    request.on('end', () => {
      let body = null;
      try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
      handler(request, response, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

function json(response, status, body) {
  const raw = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(raw) });
  response.end(raw);
}

const TOKEN = 'a'.repeat(64);

test('health 正常返回 health JSON', async () => {
  const server = await fakeServer((request, response) => {
    assert.match(request.headers.authorization ?? '', /^Bearer /);
    json(response, 200, { backend: 'wechat-hook', integration: 'WeChatAgent-1', version: '4.1.10.27' });
  });
  try {
    const body = await health({ baseUrl: server.baseUrl, token: TOKEN });
    assert.equal(body.integration, 'WeChatAgent-1');
  } finally {
    await server.close();
  }
});

test('health 401 -> HOOK_UNAUTHORIZED', async () => {
  const server = await fakeServer((_request, response) => json(response, 401, { error: 'Unauthorized' }));
  try {
    await assert.rejects(() => health({ baseUrl: server.baseUrl, token: TOKEN }), (error) => {
      assert.ok(error instanceof HookError);
      assert.equal(error.code, 'HOOK_UNAUTHORIZED');
      return true;
    });
  } finally {
    await server.close();
  }
});

test('health 非 JSON -> HOOK_INVALID_RESPONSE', async () => {
  const server = await fakeServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/plain' });
    response.end('not-json');
  });
  try {
    await assert.rejects(() => health({ baseUrl: server.baseUrl, token: TOKEN }), (error) => {
      assert.equal(error.code, 'HOOK_INVALID_RESPONSE');
      return true;
    });
  } finally {
    await server.close();
  }
});

test('health 超时 -> HOOK_TIMEOUT', async () => {
  const server = await fakeServer(() => { /* 永不响应 */ });
  try {
    await assert.rejects(
      () => health({ baseUrl: server.baseUrl, token: TOKEN, timeoutMs: 120 }),
      (error) => error.code === 'HOOK_TIMEOUT',
    );
  } finally {
    await server.close();
  }
});

test('sendText 正常受理 {ret:0}', async () => {
  const server = await fakeServer((request, response, body) => {
    assert.equal(request.url, '/SendTextMsg');
    assert.equal(request.headers['x-wechatagent-account'], 'wxid_test_abcd');
    assert.deepEqual(body, { wxidorgid: 'wxid_target', msg: 'hello' });
    json(response, 200, { ret: 0, retmsg: 'accepted' });
  });
  try {
    const result = await sendText({
      baseUrl: server.baseUrl, token: TOKEN,
      accountDirectory: 'wxid_test_abcd', target: 'wxid_target', text: 'hello',
    });
    assert.equal(result.ret, 0);
  } finally {
    await server.close();
  }
});

test('sendText 409/429 映射为明确错误码', async () => {
  for (const [status, code] of [[409, 'HOOK_VERSION_OR_ACCOUNT_MISMATCH'], [429, 'HOOK_BUSY']]) {
    const server = await fakeServer((_request, response) => json(response, status, { ret: 1 }));
    try {
      await assert.rejects(() => sendText({
        baseUrl: server.baseUrl, token: TOKEN,
        accountDirectory: 'wxid_a', target: 'wxid_b', text: 'x',
      }), (error) => error.code === code);
    } finally {
      await server.close();
    }
  }
});

test('sendText 参数校验：空文本/超长文本/超长目标', async () => {
  const base = { baseUrl: 'http://127.0.0.1:1', token: TOKEN, accountDirectory: 'wxid_a', target: 'wxid_b' };
  await assert.rejects(() => sendText({ ...base, text: '' }), (error) => error.code === 'HOOK_TEXT_INVALID');
  await assert.rejects(() => sendText({ ...base, text: 'x'.repeat(16001) }), (error) => error.code === 'HOOK_TEXT_INVALID');
  await assert.rejects(() => sendText({ ...base, text: 'x', target: 'w'.repeat(257) }), (error) => error.code === 'HOOK_TARGET_INVALID');
});

test('requestJson 拒绝非 loopback 地址', async () => {
  for (const baseUrl of ['http://0.0.0.0:30001', 'https://127.0.0.1:30001', 'http://127.0.0.1:30001/path']) {
    await assert.rejects(() => requestJson({ baseUrl, path: '/x' }), (error) => {
      assert.equal(error.code, 'HOOK_LOOPBACK_REQUIRED');
      return true;
    });
  }
});

/**
 * 起一对假 reader + 假 hook（用于 checkNative）。
 * @param {{ version?: string, account?: string, startupState?: string, integration?: string }} options 覆盖项。
 * @returns {Promise<{ reader: any, hook: any, close: () => Promise<void> }>} 服务。
 */
async function fakePair(options = {}) {
  const reader = await fakeServer((_request, response) => json(response, 200, {
    success: true,
    ready: true,
    backend: 'sqlcipher-nt',
    ownWxid: 'wxid_owner',
    accountDirectory: 'wxid_test_abcd',
  }));
  const hook = await fakeServer((_request, response) => json(response, 200, {
    backend: 'wechat-hook',
    integration: options.integration ?? 'WeChatAgent-1',
    version: options.version ?? '4.1.10.27',
    pid: 1234,
    startupState: options.startupState ?? 'ready',
    databaseAccounts: [options.account ?? 'wxid_test_abcd'],
  }));
  return {
    reader,
    hook,
    close: async () => { await reader.close(); await hook.close(); },
  };
}

function checkOptions(pair, version = '4.1.10.27') {
  return {
    readerBaseUrl: pair.reader.baseUrl,
    readerToken: TOKEN,
    hookBaseUrl: pair.hook.baseUrl,
    hookToken: TOKEN,
    expectedVersion: version,
    timeoutMs: 1000,
  };
}

test('checkNative 通过：版本/账号/集成一致', async () => {
  const pair = await fakePair();
  try {
    const result = await checkNative(checkOptions(pair));
    assert.equal(result.reader.accountDirectory, 'wxid_test_abcd');
    assert.equal(result.hook.version, '4.1.10.27');
  } finally {
    await pair.close();
  }
});

test('checkNative 版本不匹配 -> HOOK_VERSION_MISMATCH', async () => {
  const pair = await fakePair({ version: '4.1.15.13' });
  try {
    await assert.rejects(() => checkNative(checkOptions(pair)), (error) => error.code === 'HOOK_VERSION_MISMATCH');
  } finally {
    await pair.close();
  }
});

test('checkNative 账号不匹配 -> HOOK_ACCOUNT_NOT_READY', async () => {
  const pair = await fakePair({ account: 'wxid_other' });
  try {
    await assert.rejects(() => checkNative(checkOptions(pair)), (error) => error.code === 'HOOK_ACCOUNT_NOT_READY');
  } finally {
    await pair.close();
  }
});

test('checkNative 未完成初始化 -> HOOK_INITIALIZATION_PENDING', async () => {
  const pair = await fakePair({ startupState: 'waiting_for_module' });
  try {
    await assert.rejects(() => checkNative(checkOptions(pair)), (error) => error.code === 'HOOK_INITIALIZATION_PENDING');
  } finally {
    await pair.close();
  }
});

test('checkNative 非审查构建 -> HOOK_INTEGRATION_MISMATCH', async () => {
  const pair = await fakePair({ integration: 'unknown' });
  try {
    await assert.rejects(() => checkNative(checkOptions(pair)), (error) => error.code === 'HOOK_INTEGRATION_MISMATCH');
  } finally {
    await pair.close();
  }
});

test('waitForNative 对不可重试错误立即抛出', async () => {
  const pair = await fakePair({ version: '4.1.15.13' });
  try {
    const started = Date.now();
    await assert.rejects(
      () => waitForNative({ ...checkOptions(pair), deadlineMs: 2000, intervalMs: 50 }),
      (error) => error.code === 'HOOK_VERSION_MISMATCH',
    );
    assert.ok(Date.now() - started < 1000, '不可重试错误不应等待到 deadline');
  } finally {
    await pair.close();
  }
});

test('waitForNative 对 HOOK_NOT_LISTENING 重试直至超时', async () => {
  const options = {
    readerBaseUrl: 'http://127.0.0.1:1',
    readerToken: TOKEN,
    hookBaseUrl: 'http://127.0.0.1:2',
    hookToken: TOKEN,
    expectedVersion: '4.1.10.27',
    deadlineMs: 300,
    intervalMs: 50,
    timeoutMs: 100,
  };
  const started = Date.now();
  await assert.rejects(() => waitForNative(options), (error) => error.code === 'READER_UNREACHABLE' || error.code === 'HOOK_NOT_LISTENING');
  assert.ok(Date.now() - started < 2000);
});
