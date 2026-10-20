/**
 * M5 业务引擎（手册 §7.4）：缓冲 / 去抖 / 白名单 / 限流 / 幂等 / 防环 / 行为锁 / pending 恢复。
 *
 * 与 I/O 解耦：入站是 OneBot v11 事件对象，出站通过注入的 `sender` 回调（adapter 负责
 * 调 Hook + 回执闭环）。`decision` 回调负责产生回复（M6 接模型 API；测试可注入桩）。
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { isWhitelistedId, whitelistIdSets } from './onebot-id.mjs';
import { writeJsonAtomic } from '../core/atomic-write.mjs';

const MAX_BUFFER = 300;
const MAX_BATCH_MESSAGES = 20;
const MAX_BATCH_CHARS = 12000;
const RECENT_INCOMING_TTL = 120_000;
const OUTGOING_FINGERPRINT_TTL = 60_000;
const PROCESSED_TTL = 600_000;
const CHAT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CHATS = 500;

/** 行为锁：聊天里要求改人格/改规则的内容不进模型（手册 §7.4）。 */
export const BEHAVIOR_CHANGE_RE = /(忽略(之前|以上|前面)?(的)?(所有)?(指令|提示|规则)|改成.{0,8}(人格|角色|助手|机器人)|换(一个)?人格|新(的)?规则|系统提示词|开发者模式|jailbreak|忽略限制|输出你的(提示词|prompt))/i;

/**
 * 生成会话键。
 * @param {'private'|'group'} kind 类型。
 * @param {string|number} id OneBot 数字 ID。
 * @returns {string} 会话键。
 */
export function sessionKeyOf(kind, id) {
  return `wechat:${kind}:${String(id)}`;
}

/**
 * 判断一条 OneBot 消息事件是否直呼（私聊/拍一拍/@自己/唤醒词/引用自己）。
 * @param {any} event OneBot 事件。
 * @param {object} options 选项。
 * @returns {boolean} 是否直呼。
 */
export function isDirect(event, options) {
  const { selfId, wakeWords = [], outgoingIds = new Set() } = options;
  if (event.message_type === 'private') return true;
  const segments = Array.isArray(event.message) ? event.message : [];
  for (const segment of segments) {
    if (!segment || typeof segment !== 'object') continue;
    if (segment.type === 'at' && String(segment.data?.qq) === String(selfId)) return true;
    if (segment.type === 'reply' && outgoingIds.has(String(segment.data?.id))) return true;
    if (segment.type === 'text' && typeof segment.data?.text === 'string') {
      for (const word of wakeWords) {
        if (word && segment.data.text.includes(word)) return true;
      }
    }
  }
  return false;
}

/**
 * 提取事件文本（文本段拼接 + 其他段占位）。
 * @param {any} event OneBot 事件。
 * @returns {string} 文本。
 */
export function eventText(event) {
  if (typeof event.raw_message === 'string' && event.raw_message.length > 0) return event.raw_message;
  const segments = Array.isArray(event.message) ? event.message : [];
  const parts = [];
  for (const segment of segments) {
    if (segment?.type === 'text') parts.push(String(segment.data?.text ?? ''));
    else if (segment?.type === 'at') parts.push(`@${segment.data?.qq ?? ''}`);
    else if (segment?.type === 'image') parts.push('[图片]');
    else if (segment?.type === 'face') parts.push('[表情]');
    else parts.push(`[${segment?.type ?? '未知'}]`);
  }
  return parts.join('').trim();
}

/** M5 业务引擎。 */
export class SocialEngine {
  /**
   * @param {object} options 选项。
   * @param {any} options.config 配置。
   * @param {(request: any) => Promise<{action: 'RESPOND'|'SILENT', text?: string}>} options.decision 决策回调。
   * @param {(request: any) => Promise<{state: string, serverId?: string}>} options.sender 发送回调。
   * @param {string} options.storePath 持久缓冲路径。
   * @param {() => number} [options.now] 时间源（测试注入）。
   * @param {(...args: any[]) => any} [options.log] 日志函数。
   */
  constructor(options) {
    this.config = options.config;
    this.bridge = options.config.bridge ?? {};
    this.decision = options.decision;
    this.sender = options.sender;
    this.storePath = options.storePath;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
    this.whitelist = whitelistIdSets(options.config.wechat);
    this.memory = options.memory ?? null;
    this.selfId = '';
    this.state = { version: 1, chats: {}, pendingReplies: {}, processedIds: {} };
    this.timers = new Map();
    this.running = new Set();
    this.needsRun = new Set();
    this.recentIncoming = new Map();
    this.recentOutgoingHashes = new Map();
    this.outgoingIds = new Set();
    this.replyTimestamps = new Map();
    this.tenMinuteTimestamps = new Map();
    this.lastReplyAt = new Map();
    this.activeActions = 0;
    this.stats = { received: 0, replied: 0, silent: 0, locked: 0, dropped: 0, rateLimited: 0 };
    this.closed = false;
  }

  /** 读取持久缓冲。 */
  async load() {
    try {
      const raw = await readFile(this.storePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && parsed.version === 1 && parsed.chats) {
        this.state = {
          version: 1,
          chats: parsed.chats,
          pendingReplies: parsed.pendingReplies ?? {},
          processedIds: parsed.processedIds ?? {},
        };
      }
    } catch (error) {
      if (error.code !== 'ENOENT') this.log('bridge.state.load_failed', { type: error.name });
    }
  }

  /** 原子落盘（写前做缓冲/回执清理，避免 state/messages.json 无限增长）。 */
  async persist() {
    this.#pruneState();
    await mkdir(path.dirname(this.storePath), { recursive: true });
    await writeJsonAtomic(this.storePath, this.state);
  }

  /**
   * 清理过期会话缓冲与 pending：
   * - 无未读且最后消息超过 7 天的会话删除；
   * - 会话数上限 500（按最后消息时间淘汰最旧）；
   * - 已确认的 pending 超 7 天删除。
   * @returns {void}
   */
  #pruneState() {
    const ts = this.now();
    const cutoff = ts - CHAT_RETENTION_MS;
    const entries = Object.entries(this.state.chats);
    for (const [key, chat] of entries) {
      if (!Array.isArray(chat) || chat.length === 0) {
        delete this.state.chats[key];
        continue;
      }
      const hasUnread = chat.some((entry) => !entry.processed);
      const lastTimestamp = Number(chat[chat.length - 1]?.timestamp ?? 0);
      if (!hasUnread && lastTimestamp > 0 && lastTimestamp < cutoff) {
        delete this.state.chats[key];
      }
    }
    const remaining = Object.entries(this.state.chats);
    if (remaining.length > MAX_CHATS) {
      remaining.sort((left, right) => {
        const lastLeft = Number(left[1][left[1].length - 1]?.timestamp ?? 0);
        const lastRight = Number(right[1][right[1].length - 1]?.timestamp ?? 0);
        return lastLeft - lastRight;
      });
      for (const [key] of remaining.slice(0, remaining.length - MAX_CHATS)) {
        delete this.state.chats[key];
      }
    }
    for (const [key, pending] of Object.entries(this.state.pendingReplies)) {
      if (!pending) continue;
      if (pending.state === 'confirmed' && Number(pending.createdAt ?? 0) < cutoff) {
        delete this.state.pendingReplies[key];
      }
    }
  }

  /**
   * 处理一条入站 OneBot 事件。
   * @param {any} event 事件。
   * @returns {Promise<{skip: string}|{queued: boolean, sessionKey: string}>} 处理结果。
   */
  async receive(event) {
    if (this.closed) return { skip: 'closed' };
    if (!event || event.post_type !== 'message' || !['private', 'group'].includes(event.message_type)) {
      return { skip: 'not_message' };
    }
    this.selfId = String(event.self_id ?? this.selfId);
    const messageId = String(event.message_id ?? '');
    if (!messageId) return { skip: 'no_message_id' };
    const ts = this.now();
    const kind = event.message_type;
    const id = kind === 'group' ? event.group_id : event.user_id;
    const sessionKey = sessionKeyOf(kind, id);

    // 白名单再查一次（防御层）
    if (!isWhitelistedId(id, this.whitelist, kind)) {
      this.stats.dropped += 1;
      return { skip: 'not_whitelisted' };
    }
    // 自己发的 / 防环
    if (String(event.user_id) === this.selfId) {
      this.stats.dropped += 1;
      return { skip: 'self' };
    }
    // 幂等：相同 message_id 不重复处理（内存 + 落盘 processedIds，重启后仍有效）
    const incomingKey = `${sessionKey}:${messageId}`;
    const seenAt = this.recentIncoming.get(incomingKey);
    if (seenAt !== undefined && ts - seenAt < RECENT_INCOMING_TTL) {
      return { skip: 'duplicate' };
    }
    const processedAt = this.state.processedIds[incomingKey];
    if (processedAt && ts - Number(processedAt) < PROCESSED_TTL) {
      return { skip: 'duplicate_processed' };
    }
    this.recentIncoming.set(incomingKey, ts);
    this.#prune(ts);
    // 行为锁：改人格/改规则指令直接拒绝，不进模型
    const text = eventText(event);
    if (this.bridge.behaviorLock !== false && BEHAVIOR_CHANGE_RE.test(text)) {
      this.stats.locked += 1;
      this.log('bridge.locked', { sessionKey, messageId });
      return { skip: 'behavior_change_locked' };
    }
    // 防环：刚发出去的文本立刻回流则丢弃
    const textHash = this.#textHash(text);
    const outgoingAt = this.recentOutgoingHashes.get(`${sessionKey}:${textHash}`);
    if (outgoingAt !== undefined && ts - outgoingAt < OUTGOING_FINGERPRINT_TTL) {
      this.stats.dropped += 1;
      return { skip: 'echo' };
    }

    const direct = isDirect(event, {
      selfId: this.selfId,
      wakeWords: this.bridge.wakeWords ?? [],
      outgoingIds: this.outgoingIds,
    });
    const entry = {
      messageId,
      userId: String(event.user_id ?? ''),
      senderName: String(event.sender?.card || event.sender?.nickname || event.user_id || ''),
      text,
      timestamp: Number(event.time ? event.time * 1000 : ts),
      direct,
      processed: false,
      locked: false,
    };
    this.#appendChat(sessionKey, entry);
    this.stats.received += 1;
    await this.persist();

    if (direct) {
      await this.run(sessionKey);
      return { queued: false, sessionKey };
    }
    if ((this.bridge.groupMode ?? 'hybrid') === 'mention') {
      // 群聊仅 @/唤醒才回：非直呼消息只缓存，不排队
      return { queued: false, sessionKey };
    }
    this.#schedule(sessionKey, Math.max(0, Number(this.bridge.debounceMs ?? 3000)));
    return { queued: true, sessionKey };
  }

  /**
   * 处理某会话的未读消息（去抖到点或被直呼时触发）。
   * @param {string} sessionKey 会话键。
   * @returns {Promise<void>} 完成。
   */
  async run(sessionKey) {
    if (this.closed) return;
    if (this.running.has(sessionKey)) {
      this.needsRun.add(sessionKey);
      return;
    }
    this.running.add(sessionKey);
    try {
      do {
        this.needsRun.delete(sessionKey);
        await this.#runOnce(sessionKey);
      } while (this.needsRun.has(sessionKey) && !this.closed);
    } finally {
      this.running.delete(sessionKey);
    }
  }

  /**
   * 单次决策 + 发送。
   * @param {string} sessionKey 会话键。
   * @returns {Promise<void>} 完成。
   */
  async #runOnce(sessionKey) {
    if (this.activeActions >= Number(this.bridge.maxConcurrent ?? 4)) {
      this.stats.rateLimited += 1;
      this.#schedule(sessionKey, 1000);
      return;
    }
    const chat = this.state.chats[sessionKey] ?? [];
    const unread = chat.filter((entry) => !entry.processed);
    if (!unread.length) return;
    const batch = [];
    let chars = 0;
    for (const entry of unread) {
      if (batch.length >= MAX_BATCH_MESSAGES || chars + entry.text.length > MAX_BATCH_CHARS) break;
      batch.push(entry);
      chars += entry.text.length;
    }
    const cooldown = this.#cooldownRemaining(sessionKey, batch.some((entry) => entry.direct));
    if (cooldown > 0) {
      this.stats.rateLimited += 1;
      this.#schedule(sessionKey, cooldown);
      return;
    }
    const kind = sessionKey.includes(':group:') ? 'group' : 'private';
    const id = sessionKey.split(':').pop();
    this.activeActions += 1;
    try {
      const request = {
        sessionKey,
        kind,
        targetId: id,
        selfId: this.selfId,
        messages: batch.map((entry) => ({ senderName: entry.senderName, text: entry.text, timestamp: entry.timestamp })),
      };
      if (this.memory) {
        try {
          const memory = await this.memory.context(sessionKey);
          if (memory) request.memory = memory;
        } catch (error) {
          this.log('bridge.memory_context_failed', { sessionKey, type: error?.name ?? 'Error' });
        }
      }
      let decision;
      try {
        decision = await this.decision(request);
      } catch (error) {
        this.log('bridge.decision_failed', { sessionKey, type: error?.name ?? 'Error', code: error?.code ?? '' });
        decision = { action: 'SILENT' };
      }
      const isText = decision?.action === 'RESPOND' && decision.text && String(decision.text).trim();
      const stickerId = decision?.stickerId
        ? String(decision.stickerId).trim().slice(0, 64)
        : (decision?.action === 'STICKER' && decision.stickerId ? String(decision.stickerId).trim().slice(0, 64) : '');
      const isSticker = stickerId.length > 0;
      if (!isText && !isSticker) {
        this.stats.silent += 1;
        this.#markProcessed(unread, batch, sessionKey);
        await this.persist();
        await this.#recordMemory(sessionKey, batch, '');
        return;
      }
      const text = isText ? String(decision.text).trim().slice(0, 4000) : '';
      // deliveryId 由批次消息 id + 文本/表情决定：重放/重试不会二次发送（手册 §7.4 幂等）
      const deliveryId = this.#textHash(JSON.stringify([sessionKey, batch.map((entry) => entry.messageId), text, stickerId]));
      const delivered = await this.sender({ sessionKey, kind, targetId: id, text, stickerId, batch, deliveryId });
      if (delivered?.state === 'rejected') {
        this.log('bridge.send_rejected', { sessionKey, reason: delivered.reason ?? '' });
        this.#markProcessed(unread, batch, sessionKey);
        await this.persist();
        await this.#recordMemory(sessionKey, batch, '');
        return;
      }
      this.stats.replied += 1;
      const memoryReply = text ? (isSticker ? text + ' [表情包]' : text) : '[表情包]';
      this.#recordReply(sessionKey, memoryReply, delivered);
      // 有文字时记录文本 pending；纯表情不进入文本回执恢复。
      if (text) {
        this.state.pendingReplies[sessionKey] = {
          textHash: this.#textHash(text),
          textLength: text.length,
          deliveryId: delivered?.deliveryId ?? deliveryId,
          state: delivered?.state ?? 'unknown',
          serverId: delivered?.serverId ?? null,
          createdAt: this.now(),
        };
      }
      this.#markProcessed(unread, batch, sessionKey);
      await this.persist();
      await this.#recordMemory(sessionKey, batch, memoryReply);
    } finally {
      this.activeActions -= 1;
    }
  }

  /**
   * 写入会话记忆；失败不影响回复主流程。
   * @param {string} sessionKey 会话键。
   * @param {Array<any>} batch 本批消息。
   * @param {string} replyText 机器人回复；空串表示未回复。
   * @returns {Promise<void>} 完成。
   */
  async #recordMemory(sessionKey, batch, replyText) {
    if (!this.memory) return;
    try {
      const result = await this.memory.recordExchange(sessionKey, {
        incoming: batch.map((entry) => ({ senderName: entry.senderName, text: entry.text, timestamp: entry.timestamp })),
        reply: replyText,
      });
      if (result?.summarized) {
        this.log('bridge.memory_summarized', { sessionKey, shortTerm: result.shortTerm, longTerm: result.longTerm });
      }
    } catch (error) {
      this.log('bridge.memory_record_failed', { sessionKey, type: error?.name ?? 'Error' });
    }
  }

  /**
   * 重启后恢复 pending：只核对回执，不重发（手册 §6.3）。
   * @param {(request: any) => Promise<any>} verify 回执核对回调。
   * @returns {Promise<number>} 处理条数。
   */
  async replayPending(verify) {
    let count = 0;
    for (const [sessionKey, pending] of Object.entries(this.state.pendingReplies)) {
      if (!pending || pending.state !== 'unconfirmed') continue;
      try {
        const result = await verify({
          sessionKey,
          textHash: pending.textHash,
          textLength: pending.textLength,
          deliveryId: pending.deliveryId ?? '',
        });
        if (result?.state === 'confirmed') {
          pending.state = 'confirmed';
          pending.serverId = result.serverId ?? null;
          count += 1;
        }
      } catch (error) {
        this.log('bridge.pending_replay_failed', { sessionKey, type: error?.name ?? 'Error' });
      }
    }
    if (count) await this.persist();
    return count;
  }

  /**
   * 处理一条 OneBot action（适配器发来的发送请求）。
   * 说明：真正的发送由 adapter 的 sender 回调负责；引擎只做决策与记录。
   * @returns {void}
   */

  /** 状态摘要。 */
  summary() {
    return {
      connected: null,
      chats: Object.keys(this.state.chats).length,
      unread: Object.values(this.state.chats).reduce((sum, chat) => sum + chat.filter((entry) => !entry.processed).length, 0),
      pending: Object.values(this.state.pendingReplies).filter((item) => item?.state === 'unconfirmed').length,
      stats: { ...this.stats },
    };
  }

  /** 关闭：清理定时器。 */
  close() {
    this.closed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  /**
   * 追加到会话缓冲（上限 bufferPerChat）。
   * @param {string} sessionKey 会话键。
   * @param {any} entry 条目。
   * @returns {void}
   */
  #appendChat(sessionKey, entry) {
    const chat = this.state.chats[sessionKey] ?? (this.state.chats[sessionKey] = []);
    chat.push(entry);
    const limit = Math.max(1, Number(this.bridge.bufferPerChat ?? MAX_BUFFER));
    if (chat.length > limit) chat.splice(0, chat.length - limit);
  }

  /**
   * 安排一次去抖/重试运行。
   * @param {string} sessionKey 会话键。
   * @param {number} delayMs 延迟。
   * @returns {void}
   */
  #schedule(sessionKey, delayMs) {
    const existing = this.timers.get(sessionKey);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.timers.delete(sessionKey);
      this.run(sessionKey).catch((error) => this.log('bridge.run_failed', { sessionKey, type: error?.name ?? 'Error' }));
    }, Math.max(0, delayMs));
    if (typeof timer.unref === 'function') timer.unref();
    this.timers.set(sessionKey, timer);
  }

  /**
   * 计算限流冷却剩余毫秒（群 15s、私聊 1s；3 条/分；10 条/10 分）。
   * @param {string} sessionKey 会话键。
   * @param {boolean} direct 是否直呼（私聊立即回）。
   * @returns {number} 剩余毫秒。
   */
  #cooldownRemaining(sessionKey, direct) {
    const ts = this.now();
    const kind = sessionKey.includes(':group:') ? 'group' : 'private';
    const interval = kind === 'group'
      ? Number(this.bridge.minIntervalGroupMs ?? 15000)
      : Number(this.bridge.minIntervalPrivateMs ?? 1000);
    const last = this.lastReplyAt.get(sessionKey) ?? 0;
    if (ts - last < interval) return interval - (ts - last);
    const minute = (this.replyTimestamps.get(sessionKey) ?? []).filter((stamp) => ts - stamp < 60_000);
    this.replyTimestamps.set(sessionKey, minute);
    if (minute.length >= Number(this.bridge.perMinute ?? 3)) return 60_000 - (ts - minute[0]);
    const tenMinute = (this.tenMinuteTimestamps.get(sessionKey) ?? []).filter((stamp) => ts - stamp < 600_000);
    this.tenMinuteTimestamps.set(sessionKey, tenMinute);
    if (tenMinute.length >= Number(this.bridge.perTenMinute ?? 10)) return 600_000 - (ts - tenMinute[0]);
    return 0;
  }

  /**
   * 标记批次已处理，并清理过旧的 processed 记录。
   * @param {any[]} unread 全部未读。
   * @param {any[]} batch 已处理批次。
   * @param {string} sessionKey 会话键。
   * @returns {void}
   */
  #markProcessed(unread, batch, sessionKey) {
    const batchIds = new Set(batch.map((entry) => entry.messageId));
    for (const entry of unread) {
      if (batchIds.has(entry.messageId)) {
        entry.processed = true;
        this.state.processedIds[`${sessionKey}:${entry.messageId}`] = this.now();
      }
    }
    const ts = this.now();
    for (const [id, at] of Object.entries(this.state.processedIds)) {
      if (ts - at > PROCESSED_TTL) delete this.state.processedIds[id];
    }
  }

  /**
   * 记录发出回复（用于防环与限流）。
   * @param {string} sessionKey 会话键。
   * @param {string} text 文本。
   * @param {any} delivered 发送结果。
   * @returns {void}
   */
  #recordReply(sessionKey, text, delivered) {
    const ts = this.now();
    const textHash = this.#textHash(text);
    this.recentOutgoingHashes.set(`${sessionKey}:${textHash}`, ts);
    if (delivered?.messageId) this.outgoingIds.add(String(delivered.messageId));
    if (delivered?.localId) this.outgoingIds.add(String(delivered.localId));
    const minute = this.replyTimestamps.get(sessionKey) ?? [];
    minute.push(ts);
    this.replyTimestamps.set(sessionKey, minute);
    const tenMinute = this.tenMinuteTimestamps.get(sessionKey) ?? [];
    tenMinute.push(ts);
    this.tenMinuteTimestamps.set(sessionKey, tenMinute);
    this.lastReplyAt.set(sessionKey, ts);
  }

  /**
   * 清理过期防环/去重记录。
   * @param {number} ts 当前时间。
   * @returns {void}
   */
  #prune(ts) {
    for (const [key, at] of this.recentIncoming) {
      if (ts - at > RECENT_INCOMING_TTL) this.recentIncoming.delete(key);
    }
    for (const [key, at] of this.recentOutgoingHashes) {
      if (ts - at > OUTGOING_FINGERPRINT_TTL) this.recentOutgoingHashes.delete(key);
    }
  }

  /**
   * 文本哈希（不落正文）。
   * @param {string} text 文本。
   * @returns {string} sha256。
   */
  #textHash(text) {
    return createHash('sha256').update(String(text), 'utf8').digest('hex');
  }
}
