#!/usr/bin/env node
/**
 * 发送适配器（M4）：Hook 通道自检 / attempt 状态 / 手工发送（受开关与白名单约束）。
 *
 *   node scripts/sender-adapter.mjs --check
 *      跨通道校验 reader + Hook（版本三重锁的调用方、账号锁）
 *   node scripts/sender-adapter.mjs --status
 *      查看 state/text-deliveries 状态统计
 *   node scripts/sender-adapter.mjs --send --target <wxid|群号|显示名> --text <文本> --yes
 *      发送一条文本并等待数据库回执（必须 config.sender.enabled=true 且显式 --yes）
 *
 * 安全约束：HTTP 200 只代表受理；只有数据库里出现 `isSend=1 + serverId>0 + 文本相等`
 * 才记 confirmed；超时记 unconfirmed 且绝不自动重发。
 */
import { randomBytes } from 'node:crypto';
import process from 'node:process';
import { loadConfig } from './lib/core/config.mjs';
import { inspectToken } from './lib/core/tokens.mjs';
import { projectPath } from './lib/core/paths.mjs';
import { TextDeliveryStore } from './lib/send/text-delivery-store.mjs';
import { sendWithReceipt } from './lib/send/send-engine.mjs';
import {
  HookError,
  checkNative,
  readHookToken,
  readerStatus,
  requestJson,
} from './lib/send/hook-client.mjs';

/**
 * 读取某通道 token（复用 tokens 模块的私有权限检查）。
 * @param {string} channel 通道名。
 * @returns {Promise<string>} token。
 */
async function tokenOf(channel) {
  const info = await inspectToken(channel);
  if (!info.token) throw new HookError(`${channel.toUpperCase()}_TOKEN_MISSING`, `缺少 state/tokens/${channel}.txt`);
  return info.token;
}

/**
 * --check：验证 reader 就绪 + Hook 版本/账号锁。
 * @returns {Promise<number>} 退出码。
 */
async function check() {
  const { config } = await loadConfig();
  const readerBaseUrl = `http://127.0.0.1:${config.ports.reader}`;
  const readerToken = await tokenOf('reader');
  try {
    const result = await checkNative({
      readerBaseUrl,
      readerToken,
      hookBaseUrl: config.hook.baseUrl,
      hookToken: await readHookToken(),
      expectedVersion: config.hook.expectedVersion,
      timeoutMs: config.hook.requestTimeoutMs,
    });
    console.log(JSON.stringify({
      ok: true,
      reader: {
        backend: result.reader.backend,
        accountDirectory: result.reader.accountDirectory,
        ownWxid: result.reader.ownWxid,
      },
      hook: {
        backend: result.hook.backend,
        integration: result.hook.integration,
        version: result.hook.version,
        pid: result.hook.pid,
        startupState: result.hook.startupState,
        databaseAccounts: result.hook.databaseAccounts,
      },
    }, null, 2));
    return 0;
  } catch (error) {
    console.log(JSON.stringify({
      ok: false,
      code: error.code ?? 'HOOK_CHECK_FAILED',
      message: error.message,
    }, null, 2));
    return 1;
  }
}

/**
 * --status：展示 attempt 状态统计与最近记录（不含正文）。
 * @returns {Promise<number>} 退出码。
 */
async function status() {
  const store = new TextDeliveryStore({ dir: projectPath('state', 'text-deliveries') });
  const summary = await store.summary();
  const records = (await store.list()).slice(0, 10).map((record) => ({
    deliveryId: `${record.deliveryId.slice(0, 12)}…`,
    state: record.state,
    kind: record.kind,
    target: record.target,
    textLength: record.textLength,
    serverId: record.serverId,
    reason: record.reason,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  }));
  console.log(JSON.stringify({ ok: true, summary, recent: records }, null, 2));
  return 0;
}

/**
 * 解析 --target：允许 wxid / 群号 / 会话显示名。
 * @param {any} config 配置。
 * @param {string} readerToken reader token。
 * @param {string} target 目标。
 * @returns {Promise<{ talker: string, kind: 'private'|'group', displayName: string }>} 目标信息。
 */
async function resolveTarget(config, readerToken, target) {
  if (/^wxid_[0-9A-Za-z_]+$/.test(target) || target.endsWith('@chatroom')) {
    return {
      talker: target,
      kind: target.endsWith('@chatroom') ? 'group' : 'private',
      displayName: target,
    };
  }
  const result = await requestJson({
    baseUrl: `http://127.0.0.1:${config.ports.reader}`,
    path: '/api/v1/sessions?limit=200',
    headers: { authorization: `Bearer ${readerToken}` },
    timeoutMs: 5000,
  });
  if (result.status !== 200 || !result.body?.sessions) {
    throw new HookError('TARGET_RESOLVE_FAILED', `sessions HTTP ${result.status}`);
  }
  const normalize = (value) => String(value ?? '').replace(/\s*\(\d+\)\s*$/, '').trim().toLowerCase();
  const matches = result.body.sessions.filter((session) => (
    session.displayName === target || normalize(session.displayName) === normalize(target)
  ));
  if (matches.length !== 1) {
    throw new HookError(
      matches.length ? 'TARGET_AMBIGUOUS' : 'TARGET_NOT_FOUND',
      `按显示名解析到 ${matches.length} 个会话：${target}`,
    );
  }
  return {
    talker: matches[0].talker,
    kind: matches[0].sessionType === 'group' ? 'group' : 'private',
    displayName: matches[0].displayName,
  };
}

/**
 * --send：手工发送一条文本并等待回执。
 * @param {Record<string,string>} options 参数。
 * @returns {Promise<number>} 退出码：0 confirmed / 3 unconfirmed / 4 rejected。
 */
async function send(options) {
  const { config } = await loadConfig();
  const target = options.target ?? '';
  const text = options.text ?? '';
  if (!target || !text) {
    console.error('用法：--send --target <wxid|群号|显示名> --text <文本> --yes');
    return 2;
  }
  if (!config.sender?.enabled) {
    console.error(JSON.stringify({ ok: false, code: 'SENDER_DISABLED', message: 'config.sender.enabled=false' }));
    return 2;
  }
  if (options.yes !== 'true') {
    console.error(JSON.stringify({ ok: false, code: 'CONFIRM_REQUIRED', message: '需要显式 --yes 才会真正发送' }));
    return 2;
  }
  const readerToken = await tokenOf('reader');
  const hookToken = await readHookToken();
  // 发送前先做跨通道校验，避免把消息发给错误账号/版本不符的 Hook
  await checkNative({
    readerBaseUrl: `http://127.0.0.1:${config.ports.reader}`,
    readerToken,
    hookBaseUrl: config.hook.baseUrl,
    hookToken,
    expectedVersion: config.hook.expectedVersion,
    timeoutMs: config.hook.requestTimeoutMs,
  });
  const resolved = await resolveTarget(config, readerToken, target);
  const store = new TextDeliveryStore({ dir: projectPath('state', 'text-deliveries') });
  const record = await sendWithReceipt({
    config,
    readerToken,
    hookToken,
    store,
    talker: resolved.talker,
    text,
    kind: resolved.kind,
    // 每次手工发送是一个独立 attempt（同一逻辑回复应复用同 salt）；随机 salt 便于人工多次测试。
    salt: randomBytes(8).toString('hex'),
    logger: (event, fields) => console.error(JSON.stringify({ event, ...fields })),
  });
  const summary = {
    ok: record.state === 'confirmed',
    state: record.state,
    deliveryId: record.deliveryId,
    kind: record.kind,
    target: record.target,
    targetDisplayName: resolved.displayName,
    textLength: record.textLength,
    serverId: record.serverId,
    localId: record.localId,
    reason: record.reason,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (record.state === 'confirmed') return 0;
  if (record.state === 'rejected') return 4;
  return 3;
}

const mode = process.argv[2] ?? '--help';
const options = {};
for (let index = 3; index < process.argv.length; index += 1) {
  const token = process.argv[index];
  if (!token.startsWith('--')) continue;
  const key = token.slice(2);
  const next = process.argv[index + 1];
  if (next === undefined || next.startsWith('--')) {
    options[key] = 'true';
  } else {
    options[key] = next;
    index += 1;
  }
}

try {
  if (mode === '--check') {
    process.exitCode = await check();
  } else if (mode === '--status') {
    process.exitCode = await status();
  } else if (mode === '--send') {
    process.exitCode = await send(options);
  } else {
    console.log('用法：node scripts/sender-adapter.mjs --check | --status | --send --target <..> --text <..> --yes');
    process.exitCode = 2;
  }
} catch (error) {
  console.error(JSON.stringify({
    ok: false,
    code: error.code ?? 'ADAPTER_FAILED',
    message: error.message,
  }));
  process.exitCode = 1;
}
