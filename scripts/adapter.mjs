#!/usr/bin/env node
/**
 * M5 I/O 适配器（127.0.0.1:8766 状态口）：
 *   reader SSE（微信入站）→ OneBot v11 事件 → 反向 WS 拨号到 bridge
 *   bridge 的 send_private_msg/send_group_msg action → resolve 真实 talker → M4 Hook 发送 + 回执
 *
 * 只读边：读取层 token；发送边：Hook token（M4）；两者都由 adapter 进程持有，不出本机。
 */
import http from 'node:http';
import crypto from 'node:crypto';
import process from 'node:process';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { WebSocket } from 'ws';
import { loadConfig } from './lib/core/config.mjs';
import { inspectToken } from './lib/core/tokens.mjs';
import { projectPath } from './lib/core/paths.mjs';
import { TextDeliveryStore } from './lib/send/text-delivery-store.mjs';
import { sendWithReceipt } from './lib/send/send-engine.mjs';
import { sendSticker } from './lib/send/hook-client.mjs';
import { stickerPaths, validateGifBytes, md5Hex } from './lib/sticker/sticker-store.mjs';
import { buildTargetIndex, findSelfDisplay, toOneBotEvent } from './lib/bridge/onebot-adapter.mjs';
import { normalizeGroupName, onebotId, whitelistIdSets } from './lib/bridge/onebot-id.mjs';

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
 * 日志（不含聊天正文）。
 * @param {string} event 事件名。
 * @param {Record<string, any>} fields 字段。
 * @returns {void}
 */
function log(event, fields = {}) {
  console.error(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

/**
 * 本机 GET JSON。
 * @param {number} port 端口。
 * @param {string} apiPath 路径。
 * @param {string} token Bearer token。
 * @param {number} [timeoutMs] 超时。
 * @returns {Promise<any>} JSON。
 */
function getJson(port, apiPath, token, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1',
      port,
      path: apiPath,
      timeout: timeoutMs,
      headers: { authorization: `Bearer ${token}` },
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(`BAD_JSON HTTP ${response.statusCode}`));
        }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => {
      request.destroy();
      reject(new Error('TIMEOUT'));
    });
    request.on('error', reject);
  });
}

const { config } = await loadConfig();
const readerToken = await tokenOf('reader');
const onebotToken = await tokenOf('onebot');
const adapterToken = await tokenOf('adapter');
const readerPort = Number(config.ports.reader);
const bridgeUrl = `ws://127.0.0.1:${config.ports.onebot}${config.onebot.path}`;
const deliveryStore = new TextDeliveryStore({ dir: projectPath('state', 'text-deliveries') });
const whitelist = whitelistIdSets(config.wechat);

const state = {
  bridgeConnected: false,
  readerConnected: false,
  selfId: '',
  selfDisplay: '',
  targets: { byPrivate: new Map(), byGroup: new Map() },
  queue: [],
  received: 0,
  forwarded: 0,
  sent: 0,
  dropped: 0,
  lastError: '',
  lastEventAt: 0,
  startedAt: Date.now(),
};
let ws = null;
let readerRequest = null;
let readerLastByteAt = 0;
let reconnectTimer = null;
let closing = false;

/**
 * 刷新目标索引（数字 ID → 真实 talker）与自己的显示名。
 * @returns {Promise<void>} 完成。
 */
async function refreshTargets() {
  try {
    const sessions = await getJson(readerPort, '/api/v1/sessions?limit=500', readerToken);
    state.targets = buildTargetIndex(sessions.sessions ?? []);
    const status = await getJson(readerPort, '/api/v1/reader/status', readerToken);
    if (!state.selfId && status.ownWxid) {
      state.selfId = onebotId(status.ownWxid);
      try {
        const contacts = await getJson(readerPort, '/api/v1/contacts?limit=500', readerToken);
        state.selfDisplay = findSelfDisplay(contacts.contacts ?? [], status.ownWxid);
      } catch {
        state.selfDisplay = '';
      }
    }
  } catch (error) {
    state.lastError = `TARGET_REFRESH_FAILED:${error.message}`;
    log('adapter.targets_refresh_failed', { message: error.message });
  }
  log('adapter.targets_refreshed', {
    private: state.targets.byPrivate.size,
    group: state.targets.byGroup.size,
  });
}

/**
 * 发送或缓存 OneBot 事件（未连上 bridge 时缓冲）。
 * @param {any} event OneBot 事件。
 * @returns {void}
 */
function sendOrQueue(event) {
  if (ws && state.bridgeConnected) {
    ws.send(JSON.stringify(event));
    return;
  }
  state.queue.push(event);
  if (state.queue.length > 300) state.queue.shift();
}

/**
 * 处理 reader SSE 事件。
 * @param {any} event reader 推送事件。
 * @returns {void}
 */
function handleReaderEvent(event) {
  state.received += 1;
  state.lastEventAt = Date.now();
  const onebotEvent = toOneBotEvent(event, {
    selfId: state.selfId,
    selfDisplay: state.selfDisplay,
    whitelist,
  });
  if (!onebotEvent) {
    state.dropped += 1;
    return;
  }
  state.forwarded += 1;
  sendOrQueue(onebotEvent);
}

/** 连接 reader SSE（带 watchdog 与重连）。 */
function connectReader() {
  if (closing) return;
  const request = http.get({
    host: '127.0.0.1',
    port: readerPort,
    path: '/api/v1/push/messages',
    headers: { authorization: `Bearer ${readerToken}` },
  }, (response) => {
    if (response.statusCode !== 200) {
      state.lastError = `READER_SSE_HTTP_${response.statusCode}`;
      response.resume();
      scheduleReaderReconnect(1500);
      return;
    }
    readerRequest = request;
    state.readerConnected = true;
    readerLastByteAt = Date.now();
    log('adapter.reader_connected');
    // reader 刚就绪时立即刷新目标表，否则前 30 秒收到消息会 TARGET_NOT_FOUND
    void refreshTargets();
    let buffer = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      readerLastByteAt = Date.now();
      buffer += chunk;
      const blocks = buffer.split('\n\n');
      buffer = blocks.pop() ?? '';
      for (const block of blocks) {
        for (const line of block.split('\n')) {
          if (!line.startsWith('data: ')) continue;
          try {
            handleReaderEvent(JSON.parse(line.slice('data: '.length)));
          } catch {
            log('adapter.reader_event_invalid');
          }
        }
      }
    });
    response.on('end', () => {
      state.readerConnected = false;
      log('adapter.reader_sse_ended');
      scheduleReaderReconnect(1500);
    });
    response.on('error', () => {
      state.readerConnected = false;
      scheduleReaderReconnect(1500);
    });
  });
  request.on('error', (error) => {
    state.readerConnected = false;
    state.lastError = `READER_SSE_ERROR:${error.code ?? error.message}`;
    scheduleReaderReconnect(1500);
  });
}

/**
 * 安排重连 reader。
 * @param {number} delayMs 延迟。
 * @returns {void}
 */
function scheduleReaderReconnect(delayMs) {
  if (closing) return;
  setTimeout(connectReader, delayMs).unref?.();
}

/** 连接 bridge（反向 WS 客户端，每 1.5s 重连）。 */
function connectBridge() {
  if (closing) return;
  ws = new WebSocket(bridgeUrl, { headers: { authorization: `Bearer ${onebotToken}` } });
  ws.on('open', () => {
    state.bridgeConnected = true;
    state.lastError = '';
    log('adapter.bridge_connected');
    ws.send(JSON.stringify({
      time: Math.floor(Date.now() / 1000),
      self_id: Number(state.selfId || 0),
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: 'connect',
    }));
    const buffered = state.queue.splice(0, state.queue.length);
    for (const event of buffered) ws.send(JSON.stringify(event));
  });
  ws.on('message', (data) => {
    try {
      const frame = JSON.parse(String(data));
      if (frame && frame.action) handleAction(frame);
    } catch {
      log('adapter.bridge_frame_invalid');
    }
  });
  ws.on('close', () => {
    state.bridgeConnected = false;
    log('adapter.bridge_disconnected');
    if (!closing) setTimeout(connectBridge, 1500).unref?.();
  });
  ws.on('error', (error) => {
    state.bridgeConnected = false;
    state.lastError = `BRIDGE_WS_ERROR:${error.code ?? error.message}`;
  });
}

/**
 * 应答 OneBot action。
 * @param {any} frame 请求帧。
 * @param {{status: string, retcode: number, data?: any, message?: string}} result 结果。
 * @returns {void}
 */
function respondAction(frame, result) {
  if (!ws || !state.bridgeConnected) return;
  ws.send(JSON.stringify({ ...result, echo: frame.echo }));
}

/**
 * 发送原生表情并轮询 reader 回执。
 * @param {object} options 选项。
 * @returns {Promise<{ state: string, serverId?: string|null, localId?: number|null, stickerId?: string }>} 回执。
 */
async function sendStickerWithReceipt(options) {
  const { talker, stickerPath, fields, stickerId, hookToken } = options;
  const expectedDir = stickerPaths(config).outgoing;
  const absolute = path.resolve(stickerPath);
  const raw = await readFile(absolute);
  const invalid = validateGifBytes(raw);
  if (invalid) throw Object.assign(new Error(invalid), { code: invalid });
  const md5 = md5Hex(raw);
  if (path.dirname(absolute).toLowerCase() !== expectedDir.toLowerCase()
    || path.basename(absolute, path.extname(absolute)).toLowerCase() !== md5.toLowerCase()) {
    throw Object.assign(new Error('STICKER_PATH_INVALID'), { code: 'STICKER_PATH_INVALID' });
  }
  const safeFields = {
    md5,
    productid: String(fields?.productid ?? ''),
    len: raw.length,
    type: Number(fields?.type ?? 2),
    width: Number(fields?.width ?? 0),
    height: Number(fields?.height ?? 0),
  };
  let baseline = 0;
  try {
    const before = await getJson(readerPort, `/api/v1/messages?talker=${encodeURIComponent(talker)}&limit=5`, readerToken, 3000);
    for (const message of before.messages ?? []) {
      baseline = Math.max(baseline, Number(message.localId ?? 0));
    }
  } catch {
    baseline = 0;
  }
  try {
    await sendSticker({
      baseUrl: config.hook.baseUrl,
      token: hookToken,
      accountDirectory: config.reader.accountDirectory,
      target: talker,
      stickerPath: absolute,
      fields: safeFields,
      timeoutMs: config.hook.requestTimeoutMs,
    });
  } catch (error) {
    log('adapter.sticker_rejected', { code: error.code ?? error.name });
    return { state: 'rejected', stickerId, reason: error.code ?? 'HOOK_STICKER_REJECTED' };
  }
  const deadline = Date.now() + Number(config.hook.receiptTimeoutMs ?? 18000);
  const pollMs = Math.max(200, Number(config.hook.receiptPollMs ?? 400));
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    try {
      const after = await getJson(readerPort, `/api/v1/messages?talker=${encodeURIComponent(talker)}&limit=10`, readerToken, 3000);
      for (const message of after.messages ?? []) {
        const localId = Number(message.localId ?? 0);
        const serverId = String(message.serverId ?? '');
        const localType = Number(message.localType ?? 0);
        const stickerType = localType === 47 || localType === 49 || localType === 34359738417;
        const sent = message.isSend === true || Number(message.isSend) === 1;
        if (localId > baseline && sent && /^\d+$/.test(serverId)
          && Number(serverId) > 0 && stickerType) {
          return { state: 'confirmed', serverId, localId, stickerId };
        }
      }
    } catch {
      // reader 暂时不可用，继续重试
    }
  }
  log('adapter.sticker_unconfirmed', { stickerId });
  return { state: 'unconfirmed', stickerId };
}

/**
 * 处理 bridge 发来的 action。
 * @param {any} frame action 帧。
 * @returns {void}
 */
function handleAction(frame) {
  const { action, params } = frame;
  void (async () => {
    try {
      if (action === 'get_friend_list') {
        const friends = [...state.targets.byPrivate.entries()].map(([id, target]) => ({
          user_id: Number(id), nickname: target.displayName, remark: target.displayName,
        }));
        respondAction(frame, { status: 'ok', retcode: 0, data: friends });
        return;
      }
      if (action === 'get_group_list') {
        const groups = [...state.targets.byGroup.entries()].map(([id, target]) => ({
          group_id: Number(id), group_name: target.displayName,
        }));
        respondAction(frame, { status: 'ok', retcode: 0, data: groups });
        return;
      }
      if (action === 'verify_delivery') {
        const record = await deliveryStore.get(String(params?.delivery_id ?? ''));
        respondAction(frame, {
          status: 'ok',
          retcode: 0,
          data: record
            ? { state: record.state, serverId: record.serverId ?? null, localId: record.localId ?? null, deliveryId: record.deliveryId }
            : { state: 'unknown', serverId: null, localId: null, deliveryId: String(params?.delivery_id ?? '') },
        });
        return;
      }
      if (action === 'send_sticker') {
        const isGroup = Boolean(params?.group_id);
        const id = String(params?.group_id ?? params?.user_id ?? '');
        let target = isGroup ? state.targets.byGroup.get(id) : state.targets.byPrivate.get(id);
        if (!target) {
          await refreshTargets();
          target = isGroup ? state.targets.byGroup.get(id) : state.targets.byPrivate.get(id);
        }
        if (!target) {
          respondAction(frame, { status: 'failed', retcode: 1, message: 'TARGET_NOT_FOUND', data: null });
          return;
        }
        const stickerId = String(params?.sticker_id ?? '');
        const stickerPath = String(params?.path ?? '');
        try {
          const record = await sendStickerWithReceipt({
            talker: target.talker,
            stickerPath,
            fields: params?.sticker,
            stickerId,
            hookToken: await tokenOf('hook'),
          });
          state.sent += 1;
          log('adapter.sticker_sent', { kind: target.kind, state: record.state, serverId: record.serverId ?? '', stickerId });
          respondAction(frame, {
            status: 'ok',
            retcode: 0,
            data: {
              message_id: record.localId ?? 0,
              state: record.state,
              serverId: record.serverId ?? null,
              localId: record.localId ?? null,
              stickerId,
            },
          });
        } catch (error) {
          log('adapter.sticker_action_failed', { code: error.code ?? error.name });
          respondAction(frame, {
            status: 'ok',
            retcode: 0,
            data: { state: 'rejected', reason: error.code ?? 'STICKER_ACTION_FAILED', stickerId },
          });
        }
        return;
      }
      if (action === 'send_private_msg' || action === 'send_group_msg') {
        const isGroup = action === 'send_group_msg';
        const id = String(params?.group_id ?? params?.user_id ?? '');
        const text = String(params?.message ?? '');
        let target = isGroup ? state.targets.byGroup.get(id) : state.targets.byPrivate.get(id);
        if (!target) {
          // reader 刚就绪/目标表为空：立即刷新一次再查，避免启动竞态导致误报 TARGET_NOT_FOUND
          await refreshTargets();
          target = isGroup ? state.targets.byGroup.get(id) : state.targets.byPrivate.get(id);
        }
        if (!target) {
          respondAction(frame, { status: 'failed', retcode: 1, message: 'TARGET_NOT_FOUND', data: null });
          return;
        }
        const record = await sendWithReceipt({
          config,
          readerToken,
          hookToken: await tokenOf('hook'),
          store: deliveryStore,
          talker: target.talker,
          text,
          kind: target.kind,
          salt: String(params?.delivery_id ?? frame.echo ?? ''),
        });
        state.sent += 1;
        log('adapter.sent', { kind: target.kind, state: record.state, serverId: record.serverId ?? '' });
        respondAction(frame, {
          status: 'ok',
          retcode: 0,
          data: {
            message_id: record.localId ?? 0,
            state: record.state,
            serverId: record.serverId ?? null,
            localId: record.localId ?? null,
            deliveryId: record.deliveryId,
            textLength: record.textLength,
          },
        });
        return;
      }
      respondAction(frame, { status: 'failed', retcode: 1404, message: 'UNKNOWN_ACTION', data: null });
    } catch (error) {
      state.lastError = error.code ?? error.name;
      log('adapter.action_failed', { action, code: error.code ?? error.name });
      respondAction(frame, { status: 'failed', retcode: 1, message: error.code ?? 'ACTION_FAILED', data: null });
    }
  })();
}

// 状态口：只读，Bearer adapter token（常量时间比较）
const statusServer = http.createServer((request, response) => {
  const supplied = String(request.headers.authorization ?? '').replace(/^Bearer /i, '');
  const left = Buffer.from(supplied);
  const right = Buffer.from(adapterToken);
  const authorized = request.method === 'GET'
    && left.length === right.length
    && crypto.timingSafeEqual(left, right);
  if (!authorized) {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end('{"ok":false,"error":"UNAUTHORIZED"}');
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify({
    ok: true,
    bridgeConnected: state.bridgeConnected,
    readerConnected: state.readerConnected,
    selfId: state.selfId,
    selfDisplayLength: state.selfDisplay.length,
    received: state.received,
    forwarded: state.forwarded,
    sent: state.sent,
    dropped: state.dropped,
    queued: state.queue.length,
    lastError: state.lastError,
    lastEventAt: state.lastEventAt,
    startedAt: state.startedAt,
  }));
});
statusServer.listen(Number(config.ports.adapter), '127.0.0.1');

await refreshTargets();
setInterval(() => { refreshTargets().catch(() => {}); }, 30_000).unref?.();
connectReader();
connectBridge();
log('adapter.started', { bridge: bridgeUrl, readerPort, statusPort: Number(config.ports.adapter) });
console.log(JSON.stringify({
  ok: true,
  bridge: bridgeUrl,
  status: `http://127.0.0.1:${config.ports.adapter}/status`,
  selfId: state.selfId,
}));

const shutdown = () => {
  closing = true;
  try { ws?.close(1000, 'stopping'); } catch { /* ignore */ }
  try { readerRequest?.destroy(); } catch { /* ignore */ }
  statusServer.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
