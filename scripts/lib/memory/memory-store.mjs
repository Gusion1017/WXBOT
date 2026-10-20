/**
 * 会话记忆层（每个会话独立）。
 *
 * - 短期记忆：最近 `shortTermLimit`（默认 10）条对话，包含对方消息与机器人回复；
 * - 超出上限：把最旧的溢出条目交给模型整理为一条长期记忆（失败时用确定性摘要降级）；
 * - 长期记忆按时间衰减权重排序：weight = 0.5 ^ (ageDays / halfLifeDays)；
 * - 持久化：`state/memory/<会话>.json` 为数据源，同时生成 `<会话>.md` 供人工查看；
 * - 不写聊天正文到日志；只在本地明文保存。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** 记忆状态版本。 */
const MEMORY_VERSION = 1;

/**
 * 截断文本并去掉换行，避免 Markdown/提示词结构被聊天内容破坏。
 * @param {string} value 文本。
 * @param {number} max 最大长度。
 * @returns {string} 处理后的文本。
 */
function oneLine(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * 计算时间衰减权重。
 * @param {number} timestamp 记忆时间（ms）。
 * @param {number} now 当前时间（ms）。
 * @param {number} halfLifeDays 半衰期（天）。
 * @returns {number} 0-1 权重。
 */
export function timeDecayWeight(timestamp, now, halfLifeDays) {
  const at = Number(timestamp ?? 0);
  if (!Number.isFinite(at) || at <= 0) return 0;
  const ageDays = Math.max(0, (Number(now) - at) / 86_400_000);
  const halfLife = Math.max(0.1, Number(halfLifeDays) || 7);
  return Math.max(0.01, Math.min(1, 0.5 ** (ageDays / halfLife)));
}

/**
 * 把时间戳格式化成“今天/昨天/N天前”。
 * @param {number} timestamp 时间戳（ms）。
 * @param {number} now 当前时间（ms）。
 * @returns {string} 描述。
 */
export function ageLabel(timestamp, now) {
  const ageDays = Math.max(0, (Number(now) - Number(timestamp ?? 0)) / 86_400_000);
  if (ageDays < 1) return '今天';
  if (ageDays < 2) return '昨天';
  return `${Math.floor(ageDays)}天前`;
}

/**
 * 把时间戳格式化成 HH:mm（本地时区）。
 * @param {number} timestamp 时间戳（ms）。
 * @returns {string} 时间。
 */
function clockLabel(timestamp) {
  try {
    return new Date(Number(timestamp) || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
  } catch {
    return '';
  }
}

/** 会话记忆存储。 */
export class MemoryStore {
  /**
   * @param {object} options 选项。
   * @param {string} options.dir 记忆目录。
   * @param {Record<string, any>} [options.config] `config.memory`。
   * @param {(entries: Array<{senderName: string, text: string, timestamp: number, role: string}>) => Promise<string>} [options.summarize] 摘要回调。
   * @param {() => number} [options.now] 时间源。
   * @param {(...args: any[]) => any} [options.log] 日志函数。
   */
  constructor(options) {
    this.dir = options.dir;
    this.config = options.config ?? {};
    this.enabled = this.config.enabled !== false;
    this.shortTermLimit = Math.max(2, Number(this.config.shortTermLimit ?? 10));
    this.halfLifeDays = Math.max(0.1, Number(this.config.halfLifeDays ?? 7));
    this.maxPromptChars = Math.max(200, Number(this.config.maxPromptChars ?? 1600));
    this.maxEntries = Math.max(10, Number(this.config.maxEntries ?? 120));
    this.summaryMaxChars = Math.max(50, Number(this.config.summaryMaxChars ?? 500));
    this.summarizeWithModel = this.config.summarizeWithModel !== false;
    this.summarize = typeof options.summarize === 'function' ? options.summarize : null;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
  }

  /**
   * 会话对应的文件名（可读前缀 + 短哈希，避免路径注入/冲突）。
   * @param {string} sessionKey 会话键。
   * @returns {{ json: string, markdown: string }} 路径。
   */
  filesFor(sessionKey) {
    const digest = createHash('sha1').update(String(sessionKey)).digest('hex').slice(0, 10);
    const readable = String(sessionKey)
      .replace(/^wechat:/, '')
      .replace(/[^A-Za-z0-9._-]+/g, '_')
      .slice(0, 60) || 'chat';
    const base = path.join(this.dir, `${readable}-${digest}`);
    return { json: `${base}.json`, markdown: `${base}.md` };
  }

  /**
   * 读取会话记忆；缺失/损坏时返回空状态。
   * @param {string} sessionKey 会话键。
   * @returns {Promise<any>} 状态。
   */
  async load(sessionKey) {
    const empty = {
      version: MEMORY_VERSION,
      sessionKey: String(sessionKey),
      updatedAt: new Date(this.now()).toISOString(),
      shortTerm: [],
      longTerm: [],
    };
    try {
      const raw = await readFile(this.filesFor(sessionKey).json, 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== MEMORY_VERSION || !Array.isArray(parsed.shortTerm) || !Array.isArray(parsed.longTerm)) {
        return empty;
      }
      return parsed;
    } catch {
      return empty;
    }
  }

  /**
   * 原子写入 JSON，并生成 Markdown 文档。
   * @param {string} sessionKey 会话键。
   * @param {any} state 状态。
   * @returns {Promise<void>} 完成。
   */
  async persist(sessionKey, state) {
    await mkdir(this.dir, { recursive: true });
    const files = this.filesFor(sessionKey);
    state.updatedAt = new Date(this.now()).toISOString();
    const json = `${JSON.stringify(state, null, 2)}\n`;
    const temp = `${files.json}.${process.pid}.tmp`;
    await writeFile(temp, json, 'utf8');
    await rename(temp, files.json);
    await writeFile(files.markdown, this.renderMarkdown(state), 'utf8');
  }

  /**
   * 生成给人看的 Markdown 记忆文档。
   * @param {any} state 状态。
   * @returns {string} Markdown。
   */
  renderMarkdown(state) {
    const now = this.now();
    const lines = [
      '# 会话记忆',
      '',
      `- 会话：\`${oneLine(state.sessionKey, 200)}\``,
      `- 更新时间：${new Date(now).toLocaleString('zh-CN', { hour12: false })}`,
      `- 规则：临时记忆保留最近 ${this.shortTermLimit} 条；长期记忆按 ${this.halfLifeDays} 天半衰期加权，越近权重越高。`,
      '',
      '## 长期记忆（按时间权重从高到低）',
      '',
    ];
    const longTerm = [...state.longTerm]
      .map((entry) => ({
        ...entry,
        weight: timeDecayWeight(entry.lastAt ?? entry.createdAt, now, this.halfLifeDays),
      }))
      .sort((a, b) => b.weight - a.weight);
    if (longTerm.length === 0) {
      lines.push('（暂无）');
    } else {
      for (const entry of longTerm) {
        lines.push(`- [${ageLabel(entry.lastAt ?? entry.createdAt, now)} · 权重 ${entry.weight.toFixed(2)}] ${oneLine(entry.text, this.summaryMaxChars)}`);
      }
    }
    lines.push('', `## 临时记忆（最近 ${this.shortTermLimit} 条）`, '');
    if (state.shortTerm.length === 0) {
      lines.push('（暂无）');
    } else {
      for (const entry of state.shortTerm) {
        const who = entry.role === 'assistant' ? '我' : (entry.senderName || '对方');
        lines.push(`- [${clockLabel(entry.timestamp)}] ${who}：${oneLine(entry.text, 500)}`);
      }
    }
    lines.push('');
    return lines.join('\n');
  }

  /**
   * 生成给模型的记忆提示词；没有记忆时返回空字符串。
   * @param {string} sessionKey 会话键。
   * @returns {Promise<string>} 记忆文本。
   */
  async context(sessionKey) {
    if (!this.enabled) return '';
    const state = await this.load(sessionKey);
    const now = this.now();
    const longLines = [];
    const longTerm = [...state.longTerm]
      .map((entry) => ({
        ...entry,
        weight: timeDecayWeight(entry.lastAt ?? entry.createdAt, now, this.halfLifeDays),
      }))
      .sort((a, b) => b.weight - a.weight);
    for (const entry of longTerm) {
      longLines.push(`- [${ageLabel(entry.lastAt ?? entry.createdAt, now)}，权重 ${entry.weight.toFixed(2)}] ${oneLine(entry.text, this.summaryMaxChars)}`);
    }
    const shortLines = state.shortTerm.slice(-this.shortTermLimit).map((entry) => {
      const who = entry.role === 'assistant' ? '我' : (entry.senderName || '对方');
      return `- [${clockLabel(entry.timestamp)}] ${who}：${oneLine(entry.text, 500)}`;
    });
    const parts = [];
    if (longLines.length > 0) {
      parts.push('【长期记忆·按时间权重排序，越近权重越高】', ...longLines);
    }
    if (shortLines.length > 0) {
      if (parts.length > 0) parts.push('');
      parts.push('【最近对话】', ...shortLines);
    }
    let text = parts.join('\n').trim();
    if (text.length === 0) return '';
    if (text.length > this.maxPromptChars) {
      text = `${text.slice(0, Math.max(0, this.maxPromptChars - 1))}…`;
    }
    return text;
  }

  /**
   * 把一批入站消息与可选的机器人回复写入记忆；超过上限时摘要溢出部分。
   * @param {string} sessionKey 会话键。
   * @param {{ incoming?: Array<{senderName?: string, text?: string, timestamp?: number}>, reply?: string }} batch 对话。
   * @returns {Promise<{ added: number, summarized: boolean, shortTerm: number, longTerm: number }>} 结果。
   */
  async recordExchange(sessionKey, batch = {}) {
    if (!this.enabled) return { added: 0, summarized: false, shortTerm: 0, longTerm: 0 };
    const state = await this.load(sessionKey);
    const now = this.now();
    let added = 0;
    for (const message of batch.incoming ?? []) {
      const text = String(message?.text ?? '').trim();
      if (!text) continue;
      state.shortTerm.push({
        role: 'user',
        senderName: String(message?.senderName ?? ''),
        text,
        timestamp: Number(message?.timestamp) || now,
      });
      added += 1;
    }
    const reply = String(batch.reply ?? '').trim();
    if (reply) {
      state.shortTerm.push({
        role: 'assistant',
        senderName: '我',
        text: reply,
        timestamp: now,
      });
      added += 1;
    }
    let summarized = false;
    if (state.shortTerm.length > this.shortTermLimit) {
      const overflowCount = state.shortTerm.length - this.shortTermLimit;
      const overflow = state.shortTerm.splice(0, overflowCount);
      const summary = await this.#summarizeOverflow(overflow);
      if (summary) {
        const lastAt = overflow.reduce((max, entry) => Math.max(max, Number(entry.timestamp) || 0), now);
        state.longTerm.push({
          id: `${now}-${Math.random().toString(16).slice(2, 8)}`,
          createdAt: now,
          lastAt,
          sourceCount: overflow.length,
          text: summary,
        });
        summarized = true;
      }
    }
    if (state.longTerm.length > this.maxEntries) {
      state.longTerm = [...state.longTerm]
        .sort((a, b) => Number(b.lastAt ?? b.createdAt ?? 0) - Number(a.lastAt ?? a.createdAt ?? 0))
        .slice(0, this.maxEntries);
    }
    await this.persist(sessionKey, state);
    return {
      added,
      summarized,
      shortTerm: state.shortTerm.length,
      longTerm: state.longTerm.length,
    };
  }

  /**
   * 摘要溢出条目；模型失败时降级为确定性摘要。
   * @param {Array<any>} overflow 溢出条目。
   * @returns {Promise<string>} 摘要。
   */
  async #summarizeOverflow(overflow) {
    if (overflow.length === 0) return '';
    const entries = overflow.map((entry) => ({
      role: entry.role,
      senderName: entry.senderName,
      text: oneLine(entry.text, 1200),
      timestamp: entry.timestamp,
    }));
    if (this.summarizeWithModel && this.summarize) {
      try {
        const summary = String(await this.summarize(entries) ?? '').trim();
        if (summary) return oneLine(summary, this.summaryMaxChars);
      } catch (error) {
        this.log('memory.summarize_failed', { type: error?.name ?? 'Error', code: error?.code ?? '' });
      }
    }
    const fallback = entries
      .map((entry) => `${entry.role === 'assistant' ? '我' : (entry.senderName || '对方')}：${oneLine(entry.text, 160)}`)
      .join('；');
    return oneLine(fallback, this.summaryMaxChars);
  }

  /**
   * 只读统计（日志用，不含正文）。
   * @param {string} sessionKey 会话键。
   * @returns {Promise<{ shortTerm: number, longTerm: number }>} 统计。
   */
  async stats(sessionKey) {
    if (!this.enabled) return { shortTerm: 0, longTerm: 0 };
    const state = await this.load(sessionKey);
    return { shortTerm: state.shortTerm.length, longTerm: state.longTerm.length };
  }
}
