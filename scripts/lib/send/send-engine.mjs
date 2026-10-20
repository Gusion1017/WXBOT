/**
 * 发送引擎（M4）：落盘 → 发送 → 回读数据库拿 serverId 才算成功。
 *
 * 铁律（手册 §2 / §6.3）：
 * 1. 发送前先落盘 attempt（dispatching），崩溃重放不会二次提交；
 * 2. HTTP 200 只代表受理，必须在 reader 数据库里看到 `isSend=1 + serverId>0 + 文本相等`；
 * 3. 超时 → `unconfirmed`，**绝不自动重发**；
 * 4. 400/401/403/409/429 → `rejected`，不重试。
 */
import { createHash } from 'node:crypto';
import { requestJson, sendText } from './hook-client.mjs';
import { TextDeliveryStore, deliveryIdFor } from './text-delivery-store.mjs';

/** 发送错误码。 */
export class SendError extends Error {
  /**
   * @param {string} code 错误码。
   * @param {string} [message] 说明。
   */
  constructor(code, message = '') {
    super(message || code);
    this.name = 'SendError';
    this.code = code;
    this.message = message || code;
  }
}

const REJECT_CODES = new Set([
  'HOOK_BAD_REQUEST', 'HOOK_UNAUTHORIZED', 'HOOK_FORBIDDEN',
  'HOOK_VERSION_OR_ACCOUNT_MISMATCH', 'HOOK_BUSY', 'HOOK_TARGET_INVALID', 'HOOK_TEXT_INVALID',
]);

/**
 * 请求 reader 消息列表。
 * @param {object} options 选项。
 * @returns {Promise<any[]>} 消息列表。
 */
async function readerMessages({ readerBaseUrl, readerToken, talker, limit = 50, fromTime }) {
  const query = new URLSearchParams({ talker, limit: String(limit) });
  if (fromTime !== undefined) query.set('fromTime', String(fromTime));
  const result = await requestJson({
    baseUrl: readerBaseUrl,
    path: `/api/v1/messages?${query}`,
    headers: { authorization: `Bearer ${readerToken}` },
    timeoutMs: 5000,
  });
  if (result.status === 403) throw new SendError('CONVERSATION_NOT_ALLOWED', '会话不在白名单');
  if (result.status !== 200 || !result.body || result.body.success === false) {
    throw new SendError('READER_QUERY_FAILED', `messages HTTP ${result.status}`);
  }
  return Array.isArray(result.body.messages) ? result.body.messages : [];
}

/**
 * 从消息列表里找发送回执。
 * @param {any[]} messages 消息列表。
 * @param {{ baseline: Set<number>, text: string, since: number }} options 条件。
 * @returns {{ serverId: string, localId: number }|null} 命中回执。
 */
export function pickReceipt(messages, { baseline, text, since }) {
  for (const message of messages) {
    if (!message.isSend) continue;
    if (baseline.has(Number(message.localId))) continue;
    if (Number(message.createTime) < since - 30) continue;
    if (message.content !== text) continue;
    const serverId = String(message.serverId ?? '');
    if (!/^\d+$/.test(serverId) || Number(serverId) <= 0) continue;
    return { serverId, localId: Number(message.localId) };
  }
  return null;
}

/**
 * 发送一条文本并在数据库中确认回执。
 * @param {object} options 选项。
 * @returns {Promise<any>} 发送记录（state 为 confirmed/unconfirmed/rejected）。
 */
export async function sendWithReceipt(options) {
  const {
    config, readerToken, hookToken, store, talker, text,
    kind = 'private', salt = '', logger = () => {},
  } = options;
  if (!config?.sender?.enabled) throw new SendError('SENDER_DISABLED', 'config.sender.enabled=false，拒绝发送');
  if (!talker || !text) throw new SendError('SEND_INPUT_INVALID', '缺少 talker/text');
  const readerBaseUrl = `http://127.0.0.1:${config.ports.reader}`;
  const hookBaseUrl = config.hook.baseUrl;
  const accountDirectory = config.reader.accountDirectory;

  // 1) 发送前基线（只取最近消息，避免全表）
  const baselineMessages = await readerMessages({
    readerBaseUrl, readerToken, talker, limit: 30,
  });
  const baseline = new Set(baselineMessages.map((message) => Number(message.localId)));

  const deliveryId = deliveryIdFor({ kind, target: talker, text, salt });
  const existing = await store.get(deliveryId);
  if (existing) {
    // 重放只核对，不二次提交
    return { ...existing, reused: true };
  }
  const startedAt = Math.floor(Date.now() / 1000);
  const { record } = await store.begin({
    deliveryId, kind, target: talker, text, accountDirectory,
    baselineLocalIds: [...baseline],
  });
  logger('send.dispatch', { deliveryId: record.deliveryId, talkerKind: kind, textLength: text.length });

  // 2) 调用 Hook（200 只代表受理）
  try {
    await sendText({
      baseUrl: hookBaseUrl, token: hookToken, accountDirectory, target: talker, text,
      timeoutMs: config.hook.requestTimeoutMs,
    });
  } catch (error) {
    if (REJECT_CODES.has(error.code)) {
      await store.markRejected(deliveryId, error.code);
      logger('send.rejected', { deliveryId, code: error.code });
      return await store.get(deliveryId);
    }
    // 超时/网络错误：可能已发出，标 unconfirmed 且绝不重发
    await store.markUnconfirmed(deliveryId, error.code ?? 'HOOK_NETWORK_ERROR');
    logger('send.unconfirmed', { deliveryId, code: error.code ?? 'HOOK_NETWORK_ERROR' });
    return await store.get(deliveryId);
  }
  await store.markAccepted(deliveryId);
  logger('send.accepted', { deliveryId });

  // 3) 回读数据库确认 serverId
  const deadline = Date.now() + config.hook.receiptTimeoutMs;
  const pollMs = config.hook.receiptPollMs;
  while (Date.now() < deadline) {
    const messages = await readerMessages({
      readerBaseUrl, readerToken, talker, limit: 50, fromTime: startedAt - 30,
    });
    const receipt = pickReceipt(messages, { baseline, text, since: startedAt });
    if (receipt) {
      const confirmed = await store.markConfirmed(deliveryId, receipt);
      logger('send.confirmed', { deliveryId, serverId: receipt.serverId, localId: receipt.localId });
      return confirmed;
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  await store.markUnconfirmed(deliveryId, 'TEXT_DELIVERY_UNCONFIRMED');
  logger('send.unconfirmed', { deliveryId, code: 'TEXT_DELIVERY_UNCONFIRMED' });
  return await store.get(deliveryId);
}

/** 默认 store 位置（state/text-deliveries）。 */
export function createStore(rootDir) {
  return new TextDeliveryStore({ dir: rootDir });
}

/** deliveryId 辅助（测试用）。 */
export function stableDeliveryId({ kind, target, text }) {
  return createHash('sha256').update(JSON.stringify([kind, target, text])).digest('hex');
}
