#!/usr/bin/env node
/**
 * M5 桥接服务（bridge，127.0.0.1:11229/ws）：OneBot v11 反向 WS 服务端 + 业务引擎。
 *
 * 入站：adapter（反向 WS 客户端）推送 OneBot 事件 → 白名单/缓冲/去抖/限流 → decision
 * 出站：decision 产生回复 → OneBot action（send_private_msg/send_group_msg）→ adapter 调 Hook
 *
 * M6 之前 decision 默认 SILENT（安全）；config.model.enabled 后接模型 API（路线 A）。
 */
import process from 'node:process';
import { readFile, stat } from 'node:fs/promises';
import { loadConfig } from './lib/core/config.mjs';
import { inspectToken } from './lib/core/tokens.mjs';
import { projectPath } from './lib/core/paths.mjs';
import { OneBotServer } from './lib/bridge/onebot-server.mjs';
import { SocialEngine } from './lib/bridge/social-engine.mjs';
import { MemoryStore } from './lib/memory/memory-store.mjs';
import { StickerStore } from './lib/sticker/sticker-store.mjs';
import { attachMatchedSticker, stickerOfferDecision } from './lib/sticker/sticker-policy.mjs';
import { decide as modelDecide, loadModelSettings, summarizeConversation } from './lib/model/model-client.mjs';

/**
 * 读取通道 token。
 * @param {string} channel 通道名。
 * @returns {Promise<string>} token。
 */
async function tokenOf(channel) {
  const info = await inspectToken(channel);
  if (!info.token) throw new Error(`${channel.toUpperCase()}_TOKEN_MISSING：请先运行 npm run init`);
  return info.token;
}

/**
 * 结构化日志（脱敏：不打印聊天正文）。
 * @param {string} event 事件名。
 * @param {Record<string, any>} fields 字段。
 * @returns {void}
 */
function log(event, fields = {}) {
  const safe = { ...fields };
  delete safe.text;
  delete safe.messages;
  console.error(JSON.stringify({ time: new Date().toISOString(), event, ...safe }));
}

const { config } = await loadConfig();
if (!config.bridge?.autoReply && config.model?.enabled) {
  log('bridge.auto_reply_disabled', { note: 'model 已启用但 bridge.autoReply=false，决策仍走 SILENT' });
}
const token = await tokenOf('onebot');

// 表情通用设置保存后无需重启：按 mtime 动态重读 config.sticker。
let liveConfig = config;
let stickerConfigMtime = -1;
const lastStickerAt = new Map();
const recentStickerTimes = [];

/**
 * 同步最新配置（仅表情相关字段需要热更新；失败保留旧配置）。
 * @returns {Promise<void>} 完成。
 */
async function syncLiveConfig() {
  try {
    const configPath = projectPath('config', 'app.json');
    const info = await stat(configPath);
    if (info.mtimeMs === stickerConfigMtime) return;
    stickerConfigMtime = info.mtimeMs;
    const parsed = JSON.parse(await readFile(configPath, 'utf8'));
    if (parsed && typeof parsed === 'object') {
      liveConfig = parsed;
      if (stickerStore) stickerStore.applyConfig(liveConfig);
      log('bridge.sticker_config_ready', {
        enabled: liveConfig.sticker?.enabled !== false,
        mode: liveConfig.sticker?.mode ?? 'smart',
        cooldownSeconds: Number(liveConfig.sticker?.cooldownSeconds ?? 0),
      });
    }
  } catch (error) {
    log('bridge.sticker_config_failed', { type: error?.name ?? 'Error' });
  }
}

/**
 * 判断本会话本小时是否还能提供表情。
 * @param {any} request 决策请求。
 * @returns {Promise<boolean>} 是否允许。
 */
async function canOfferSticker(request) {
  if (!stickerStore) return false;
  await syncLiveConfig();
  if (stickerStore) stickerStore.applyConfig(liveConfig);
  const result = stickerOfferDecision({
    config: liveConfig,
    request,
    now: Date.now(),
    lastStickerAt: lastStickerAt.get(request.sessionKey),
    recentStickerTimes,
  });
  return result.allowed;
}

/**
 * 记录一次成功受理的表情发送（用于冷却/每小时上限）。
 * @param {string} sessionKey 会话键。
 * @returns {void}
 */
function recordStickerSent(sessionKey) {
  const now = Date.now();
  if (sessionKey) lastStickerAt.set(sessionKey, now);
  recentStickerTimes.push(now);
  const cutoff = now - 3_600_000;
  while (recentStickerTimes.length > 0 && recentStickerTimes[0] < cutoff) recentStickerTimes.shift();
}

let modelSettings = null;
let modelSettingsError = '';
if (config.bridge?.autoReply && config.model?.enabled) {
  try {
    modelSettings = await loadModelSettings(config);
    log('bridge.model_ready', { provider: config.model.provider, model: config.model.model, personaChars: modelSettings.persona.length });
  } catch (error) {
    modelSettingsError = error.code ?? error.name;
    log('bridge.model_unavailable', { code: modelSettingsError });
  }
}

/**
 * M6 决策：model 启用且 autoReply 打开时走模型 API（路线 A）；否则 SILENT。
 * @param {any} request 决策请求。
 * @returns {Promise<{action: 'SILENT'|'RESPOND', text?: string}>} 决策。
 */
async function decision(request) {
  if (!config.bridge.autoReply || !config.model.enabled) return { action: 'SILENT' };
  if (!modelSettings) return { action: 'SILENT', error: modelSettingsError ?? 'MODEL_UNAVAILABLE' };
  let stickerAllowed = false;
  let occasionMatches = [];
  try {
    stickerAllowed = await canOfferSticker(request);
    request.stickers = stickerAllowed ? await stickerStore.promptCatalog() : '';
    if (stickerAllowed && stickerStore) {
      occasionMatches = stickerStore.matchText(request.messages);
    }
  } catch (error) {
    log('bridge.sticker_catalog_failed', { type: error?.name ?? 'Error' });
  }
  const rawResult = await modelDecide({ config, request, settings: modelSettings });
  if (rawResult.error) log('bridge.model_silent', { error: rawResult.error });
  // 对话命中表情“适合发送的时机”时，文字回复自动附带最匹配的表情；
  // 没有命中则保持普通文字，避免每条都发表情。
  const result = attachMatchedSticker(rawResult, occasionMatches, stickerAllowed);
  if (result !== rawResult) {
    log('bridge.sticker_auto_matched', {
      stickerId: result.stickerId ?? '',
      score: occasionMatches[0]?.score ?? 0,
    });
  }
  if (result.stickerId || result.action === 'STICKER') {
    log('bridge.sticker_chosen', { stickerId: result.stickerId ?? '', mode: result.action });
  }
  return result;
}

/**
 * 通过 OneBot action 让 adapter 发送（adapter 负责 Hook 调用 + 回执闭环）。
 * @param {any} request 发送请求。
 * @returns {Promise<{ state: string, serverId?: string, messageId?: string, localId?: number }>} 结果。
 */
async function sender(request) {
  const isGroup = request.kind === 'group';
  const targetKey = isGroup ? { group_id: Number(request.targetId) } : { user_id: Number(request.targetId) };
  let textResult = null;
  if (request.text) {
    const action = isGroup ? 'send_group_msg' : 'send_private_msg';
    const params = isGroup
      ? { group_id: Number(request.targetId), message: request.text }
      : { user_id: Number(request.targetId), message: request.text };
    const response = await server.action(action, params);
    const data = response?.data ?? {};
    textResult = {
      state: String(data.state ?? 'accepted'),
      serverId: data.serverId ? String(data.serverId) : undefined,
      messageId: data.message_id ? String(data.message_id) : undefined,
      localId: data.localId ? Number(data.localId) : undefined,
    };
    if (textResult.state === 'rejected') return textResult;
  }
  if (request.stickerId) {
    if (!stickerStore || liveConfig.sticker?.enabled === false) {
      const rejected = { state: 'rejected', reason: 'STICKER_DISABLED' };
      return textResult ? { ...textResult, stickerState: 'rejected', stickerReason: rejected.reason } : rejected;
    }
    let staged;
    try {
      staged = await stickerStore.stage(request.stickerId);
    } catch (error) {
      log('bridge.sticker_stage_failed', { code: error?.message ?? error?.name ?? 'Error' });
      const rejected = { state: 'rejected', reason: error?.message ?? 'STICKER_STAGE_FAILED' };
      return textResult ? { ...textResult, stickerState: 'rejected', stickerReason: rejected.reason } : rejected;
    }
    const response = await (async () => {
      try {
        return await server.action('send_sticker', {
          ...targetKey,
          sticker_id: request.stickerId,
          path: staged.path,
          sticker: staged.fields,
        });
      } catch (error) {
        log('bridge.sticker_send_failed', { code: error?.code ?? error?.name ?? 'Error' });
        return null;
      }
    })();
    if (!response) {
      return textResult
        ? { ...textResult, stickerState: 'rejected', stickerReason: 'STICKER_ACTION_FAILED' }
        : { state: 'rejected', reason: 'STICKER_ACTION_FAILED' };
    }
    const data = response?.data ?? {};
    const stickerState = String(data.state ?? 'accepted');
    if (stickerState !== 'rejected') recordStickerSent(request.sessionKey);
    const stickerResult = {
      state: stickerState,
      serverId: data.serverId ? String(data.serverId) : undefined,
      messageId: data.message_id ? String(data.message_id) : undefined,
      localId: data.localId ? Number(data.localId) : undefined,
      stickerId: request.stickerId,
    };
    if (textResult) {
      return { ...textResult, stickerState: stickerResult.state, stickerId: request.stickerId };
    }
    return stickerResult;
  }
  return textResult ?? { state: 'rejected', reason: 'EMPTY_REPLY' };
}

let memoryStore = null;
if (config.memory?.enabled !== false) {
  memoryStore = new MemoryStore({
    dir: projectPath('state', 'memory'),
    config: config.memory ?? {},
    log,
    summarize: async (entries) => {
      if (!modelSettings) throw new Error('MODEL_UNAVAILABLE');
      return summarizeConversation({
        settings: modelSettings,
        entries,
        maxChars: config.memory?.summaryMaxChars ?? 500,
      });
    },
  });
  log('bridge.memory_ready', {
    enabled: true,
    shortTermLimit: memoryStore.shortTermLimit,
    halfLifeDays: memoryStore.halfLifeDays,
  });
}

const stickerStore = config.sticker ? new StickerStore({ config, log }) : null;
if (stickerStore) {
  await stickerStore.refresh();
  log('bridge.sticker_ready', {
    enabled: config.sticker?.enabled !== false,
    count: stickerStore.getEnabled().length,
  });
}

const engine = new SocialEngine({
  config,
  decision,
  sender,
  memory: memoryStore,
  storePath: projectPath('state', 'messages.json'),
  log,
});
await engine.load();
const server = new OneBotServer({
  host: '127.0.0.1',
  port: config.ports.onebot,
  path: config.onebot.path,
  token,
  requestTimeoutMs: config.onebot.requestTimeoutMs,
  maxFrameBytes: config.onebot.maxFrameBytes,
  statusProvider: () => ({
    bridge: true,
    autoReply: Boolean(config.bridge.autoReply),
    modelEnabled: Boolean(config.model.enabled),
    memoryEnabled: Boolean(memoryStore),
    stickerEnabled: Boolean(stickerStore && liveConfig.sticker?.enabled !== false),
    summary: engine.summary(),
  }),
});
server.on('event', (event) => {
  engine.receive(event).catch((error) => log('bridge.receive_failed', {
    type: error?.name ?? 'Error',
    code: error?.code ?? '',
    message: error?.message ?? '',
  }));
});
server.on('invalid', (reason) => log('bridge.invalid_frame', { reason }));
server.on('open', () => log('bridge.adapter_connected', { sessions: engine.summary().chats }));
server.on('close', () => log('bridge.adapter_disconnected'));
server.on('error', (error) => log('bridge.socket_error', { type: error?.name ?? 'Error' }));

await server.start();

// 重启后 pending 恢复：只核对回执（不重发），延迟 pendingReplayDelayMs 执行
const replayDelay = Number(config.bridge.pendingReplayDelayMs ?? 30000);
if (replayDelay > 0) {
  setTimeout(async () => {
    try {
      const count = await engine.replayPending(async (request) => {
        if (!request.deliveryId) return { state: 'unknown' };
        const response = await server.action('verify_delivery', { delivery_id: request.deliveryId });
        return response?.data ?? { state: 'unknown' };
      });
      if (count) log('bridge.pending_replayed', { count });
    } catch (error) {
      log('bridge.pending_replay_failed', { type: error?.name ?? 'Error' });
    }
  }, replayDelay).unref?.();
}

console.log(JSON.stringify({
  ok: true,
  listening: `ws://127.0.0.1:${config.ports.onebot}${config.onebot.path}`,
  autoReply: Boolean(config.bridge.autoReply),
  modelEnabled: Boolean(config.model.enabled),
  summary: engine.summary(),
}));

const shutdown = async () => {
  engine.close();
  await server.stop();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// 状态心跳（每 30s，仅日志，不含正文）
setInterval(() => {
  log('bridge.heartbeat', { connected: server.connected, summary: engine.summary() });
}, 30_000).unref?.();
