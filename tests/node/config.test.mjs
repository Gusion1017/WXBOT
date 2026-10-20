/**
 * M0 配置加载/校验/合并 单测。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  ConfigError,
  defaultConfig,
  loadConfig,
  mergeConfig,
  validateConfig,
} from '../../scripts/lib/core/config.mjs';

/**
 * 建一个临时工程根目录。
 * @returns {Promise<string>} 临时目录。
 */
async function makeRoot() {
  return mkdtemp(path.join(tmpdir(), 'wxbot-config-'));
}

test('mergeConfig 深合并且保留未知字段', () => {
  const merged = mergeConfig(
    { version: 1, ports: { reader: 5031 }, custom: { keep: true } },
    { ports: { reader: 6000 }, extra: 'user-value' },
  );
  assert.equal(merged.ports.reader, 6000);
  assert.equal(merged.custom.keep, true);
  assert.equal(merged.extra, 'user-value');
});

test('validateConfig 接受默认配置', () => {
  assert.doesNotThrow(() => validateConfig(defaultConfig()));
});

test('validateConfig 拒绝非法端口', () => {
  const config = defaultConfig();
  config.ports.reader = 70000;
  assert.throws(() => validateConfig(config), (error) => {
    assert.ok(error instanceof ConfigError);
    assert.equal(error.code, 'CONFIG_INVALID');
    return true;
  });
});

test('validateConfig 拒绝重复端口', () => {
  const config = defaultConfig();
  config.ports.reader = config.ports.adapter;
  assert.throws(() => validateConfig(config), /端口重复/);
});

test('validateConfig 拒绝非字符串白名单', () => {
  const config = defaultConfig();
  config.wechat.whitelist.private = [123];
  assert.throws(() => validateConfig(config), /wechat\.whitelist\.private/);
});

test('validateConfig 拒绝非法日志级别', () => {
  const config = defaultConfig();
  config.logging.level = 'verbose';
  assert.throws(() => validateConfig(config), /logging\.level/);
});

test('loadConfig 缺失且未允许创建时抛 CONFIG_MISSING', async () => {
  const root = await makeRoot();
  await assert.rejects(() => loadConfig({ root }), (error) => {
    assert.equal(error.code, 'CONFIG_MISSING');
    return true;
  });
});

test('loadConfig createIfMissing 生成 app.json 并保留未知字段', async () => {
  const root = await makeRoot();
  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(
    path.join(root, 'config', 'app.example.json'),
    JSON.stringify({ version: 1, ports: { reader: 5031, adapter: 8766, onebot: 11229, aiRuntime: 11230, console: 3210 }, userNote: 'keep-me' }),
    'utf8',
  );
  const first = await loadConfig({ root, createIfMissing: true });
  assert.equal(first.created, true);
  assert.equal(first.config.userNote, 'keep-me');
  const generated = JSON.parse(await readFile(path.join(root, 'config', 'app.json'), 'utf8'));
  assert.equal(generated.userNote, 'keep-me');
  assert.equal(generated.reader.backend, 'sqlcipher-nt');

  const second = await loadConfig({ root, createIfMissing: true });
  assert.equal(second.created, false);
});

test('loadConfig 对坏 JSON 抛 CONFIG_PARSE_ERROR', async () => {
  const root = await makeRoot();
  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(path.join(root, 'config', 'app.json'), '{ not json', 'utf8');
  await assert.rejects(() => loadConfig({ root }), (error) => {
    assert.equal(error.code, 'CONFIG_PARSE_ERROR');
    return true;
  });
});

test('坏配置会被备份（手册 §11 故障注入）', async () => {
  const root = await makeRoot();
  await mkdir(path.join(root, 'config'), { recursive: true });
  await writeFile(path.join(root, 'config', 'app.json'), '{ broken!', 'utf8');
  await assert.rejects(() => loadConfig({ root }), /已备份到/);
  const entries = await readdir(path.join(root, 'config'));
  const backups = entries.filter((name) => name.startsWith('app.json.broken-'));
  assert.equal(backups.length, 1);
  assert.equal(await readFile(path.join(root, 'config', backups[0]), 'utf8'), '{ broken!');
});
