/**
 * M0 原子写/日志脱敏 单测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeJsonAtomic } from '../../scripts/lib/core/atomic-write.mjs';
import { redactValue } from '../../scripts/lib/core/log.mjs';

test('writeJsonAtomic 写入合法 JSON 且不留临时文件', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wxbot-atomic-'));
  const file = path.join(root, 'nested', 'state.json');
  await writeJsonAtomic(file, { hello: '世界', version: 1 });
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  assert.deepEqual(parsed, { hello: '世界', version: 1 });
  const entries = await readdir(path.join(root, 'nested'));
  assert.deepEqual(entries, ['state.json']);
});

test('redactValue 隐藏 64-hex、token 字段与聊天正文', () => {
  const token = 'a'.repeat(64);
  const redacted = redactValue({
    token,
    authorization: `Bearer ${token}`,
    content: '今晚吃什么',
    nested: { decryptKey: 'userdpapi:xxx', text: '你好' },
    note: `raw=${token}`,
  });
  assert.equal(redacted.token, '[已隐藏]');
  assert.equal(redacted.authorization, '[已隐藏]');
  assert.equal(redacted.content, '[聊天内容已隐藏]');
  assert.equal(redacted.nested.decryptKey, '[已隐藏]');
  assert.equal(redacted.nested.text, '[聊天内容已隐藏]');
  assert.equal(redacted.note, 'raw=[64hex已隐藏]');
});

test('redactValue 允许显式开启聊天正文', () => {
  const redacted = redactValue(
    { content: '保留正文', token: 'b'.repeat(64) },
    { includeChatContent: true },
  );
  assert.equal(redacted.content, '保留正文');
  assert.equal(redacted.token, '[已隐藏]');
});
