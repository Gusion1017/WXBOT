/**
 * 发送 attempt 状态机（M4，手册 §6.3 / §9）。
 *
 * 铁律：**先落盘再发送**；`unconfirmed` 绝不自动重发；同一 deliveryId 重放只核对回执。
 * 落盘只存文本哈希与元信息，不存聊天正文。
 */
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { writeJsonAtomic } from '../core/atomic-write.mjs';

/** deliveryId = sha256([kind, target, text, salt])：同一条回复稳定，可防重复提交。 */
export function deliveryIdFor({ kind, target, text, salt = '' }) {
  const digest = createHash('sha256')
    .update(JSON.stringify([kind, target, text, salt]))
    .digest('hex');
  return digest;
}

/** 文本哈希（落盘只存哈希，不存正文）。 */
export function textHashOf(text) {
  return createHash('sha256').update(String(text), 'utf8').digest('hex');
}

const STATE_ORDER = ['dispatching', 'accepted', 'confirmed', 'unconfirmed', 'rejected'];

/** 发送 attempt 存储。 */
export class TextDeliveryStore {
  /**
   * @param {{ dir?: string }} [options] 选项（dir 默认 state/text-deliveries）。
   */
  constructor(options = {}) {
    this.dir = options.dir ?? null;
  }

  /** 懒初始化目录。 */
  async ensureDir() {
    if (!this.dir) throw new Error('TextDeliveryStore 缺少 dir');
    await mkdir(this.dir, { recursive: true });
  }

  /**
   * 文件路径。
   * @param {string} deliveryId 投递 id。
   * @returns {string} 路径。
   */
  fileFor(deliveryId) {
    if (!/^[0-9a-f]{64}$/.test(deliveryId)) throw new Error('deliveryId 必须是 64-hex');
    return path.join(this.dir, `${deliveryId}.json`);
  }

  /**
   * 读取一条 attempt。
   * @param {string} deliveryId 投递 id。
   * @returns {Promise<any|null>} 记录或 null。
   */
  async get(deliveryId) {
    try {
      return JSON.parse(await readFile(this.fileFor(deliveryId), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  /**
   * 新建 attempt（**发送前**调用）。
   * @param {object} input 参数。
   * @returns {Promise<{ record: any, reused: boolean }>} 记录与是否复用。
   */
  async begin(input) {
    await this.ensureDir();
    const deliveryId = input.deliveryId ?? deliveryIdFor(input);
    const existing = await this.get(deliveryId);
    if (existing) return { record: existing, reused: true };
    const now = new Date().toISOString();
    const record = {
      version: 1,
      deliveryId,
      state: 'dispatching',
      kind: input.kind ?? 'private',
      target: String(input.target ?? ''),
      accountDirectory: String(input.accountDirectory ?? ''),
      textHash: textHashOf(input.text ?? ''),
      textLength: String(input.text ?? '').length,
      baselineLocalIds: Array.isArray(input.baselineLocalIds) ? input.baselineLocalIds.map(Number) : [],
      createdAt: now,
      updatedAt: now,
      acceptedAt: null,
      confirmedAt: null,
      serverId: null,
      localId: null,
      receipt: null,
      reason: null,
      attempts: [{ at: now, event: 'dispatching', actionId: input.actionId ?? randomUUID() }],
    };
    await writeJsonAtomic(this.fileFor(deliveryId), record);
    return { record, reused: false };
  }

  /**
   * 更新状态（按 CAS 语义只允许前进/覆盖终结态）。
   * @param {string} deliveryId 投递 id。
   * @param {string} state 新状态。
   * @param {Record<string, any>} [patch] 附加字段。
   * @returns {Promise<any>} 更新后的记录。
   */
  async transition(deliveryId, state, patch = {}) {
    if (!STATE_ORDER.includes(state)) throw new Error(`未知状态：${state}`);
    const record = await this.get(deliveryId);
    if (!record) throw new Error(`attempt 不存在：${deliveryId}`);
    const terminal = ['confirmed', 'unconfirmed', 'rejected'];
    if (terminal.includes(record.state)) {
      throw new Error(`attempt 已终结（${record.state}），拒绝改为 ${state}`);
    }
    const now = new Date().toISOString();
    const updated = {
      ...record,
      ...patch,
      state,
      updatedAt: now,
      attempts: [...(record.attempts ?? []), { at: now, event: state, ...(patch.reason ? { reason: patch.reason } : {}) }],
    };
    await writeJsonAtomic(this.fileFor(deliveryId), updated);
    return updated;
  }

  /** 便捷：标记受理。 */
  async markAccepted(deliveryId, acceptedAt = new Date().toISOString()) {
    return this.transition(deliveryId, 'accepted', { acceptedAt });
  }

  /** 便捷：标记确认（数据库回读到 serverId）。 */
  async markConfirmed(deliveryId, { serverId, localId, receipt = 'wechat-server-id' }) {
    return this.transition(deliveryId, 'confirmed', {
      serverId: String(serverId),
      localId: Number(localId),
      receipt,
      confirmedAt: new Date().toISOString(),
    });
  }

  /** 便捷：标记未确认（**不重发**）。 */
  async markUnconfirmed(deliveryId, reason) {
    return this.transition(deliveryId, 'unconfirmed', { reason });
  }

  /** 便捷：标记拒绝（4xx，不重试）。 */
  async markRejected(deliveryId, reason) {
    return this.transition(deliveryId, 'rejected', { reason });
  }

  /**
   * 列出全部 attempt（按创建时间倒序）。
   * @returns {Promise<any[]>} 记录列表。
   */
  async list() {
    await this.ensureDir();
    const files = (await readdir(this.dir)).filter((name) => name.endsWith('.json'));
    const records = [];
    for (const file of files) {
      try {
        records.push(JSON.parse(await readFile(path.join(this.dir, file), 'utf8')));
      } catch {
        // 坏文件跳过，不阻塞状态展示。
      }
    }
    return records.sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt)));
  }

  /**
   * 统计各状态数量。
   * @returns {Promise<Record<string, number>>} 计数。
   */
  async summary() {
    const counts = { dispatching: 0, accepted: 0, confirmed: 0, unconfirmed: 0, rejected: 0 };
    for (const record of await this.list()) {
      counts[record.state] = (counts[record.state] ?? 0) + 1;
    }
    return counts;
  }

  /** 清空（仅测试/人工维护用）。 */
  async clear() {
    await this.ensureDir();
    const files = await readdir(this.dir);
    for (const file of files) {
      if (file.endsWith('.json') || file.endsWith('.tmp')) {
        await rm(path.join(this.dir, file), { force: true });
      }
    }
  }
}
