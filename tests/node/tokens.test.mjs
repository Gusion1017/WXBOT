/**
 * M0 令牌生成/复用/私有权限 单测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  TOKEN_CHANNELS,
  ensureAllTokens,
  ensureToken,
  inspectToken,
  tokenPath,
} from '../../scripts/lib/core/tokens.mjs';
import { checkPrivateFile } from '../../scripts/lib/core/private-file.mjs';

/**
 * 建一个临时工程根目录。
 * @returns {Promise<string>} 临时目录。
 */
async function makeRoot() {
  return mkdtemp(path.join(tmpdir(), 'wxbot-tokens-'));
}

test('ensureAllTokens 为每个通道生成 64-hex 私有文件', async (t) => {
  const root = await makeRoot();
  const results = await ensureAllTokens({ root });
  assert.deepEqual(results.map((item) => item.channel), TOKEN_CHANNELS);
  for (const item of results) {
    assert.match(item.token, /^[0-9a-f]{64}$/);
    assert.equal(item.rotated, true);
    const content = (await readFile(tokenPath(item.channel, root), 'utf8')).trim();
    assert.equal(content, item.token);
    const priv = await checkPrivateFile(tokenPath(item.channel, root));
    // CI/精简环境里 PowerShell 模块可能不可用，读不到 ACL 时跳过该环境的权限断言；
    // 能读到 ACL 的环境必须严格校验。
    if ((priv.reason ?? '').startsWith('ACL unavailable')) {
      t.diagnostic(`跳过 ACL 断言（当前环境无法读取 ACL）：${priv.reason}`);
      continue;
    }
    assert.equal(priv.private, true, `${item.channel}: ${priv.reason ?? ''}`);
  }
});

test('ensureToken 幂等：重复调用不轮换', async () => {
  const root = await makeRoot();
  const first = await ensureToken('reader', { root });
  const second = await ensureToken('reader', { root });
  assert.equal(first.token, second.token);
  assert.equal(second.rotated, false);
});

test('损坏的 token 文件会被轮换', async () => {
  const root = await makeRoot();
  const file = tokenPath('reader', root);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, 'not-a-token\n', 'utf8');
  const result = await ensureToken('reader', { root });
  assert.equal(result.rotated, true);
  assert.match(result.token, /^[0-9a-f]{64}$/);
});

test('未知通道抛错', async () => {
  const root = await makeRoot();
  await assert.rejects(() => ensureToken('nope', { root }), /未知 token 通道/);
});

test('inspectToken 报告缺失文件', async () => {
  const root = await makeRoot();
  const info = await inspectToken('console', { root });
  assert.equal(info.token, null);
  assert.equal(info.private, false);
});
