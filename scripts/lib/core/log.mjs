/**
 * 结构化日志 + 脱敏（手册 §9：日志里禁止出现密钥、token、聊天正文）。
 *
 * 输出形态：每行一条 JSON，字段固定为 {time, level, event, ...fields}。
 * 默认把 64-hex 串、含 token/secret/key 的字段值、聊天正文字段替换为占位符。
 */
import { appendFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY_RE = /(token|secret|password|passphrase|apikey|api_key|authorization|credential|decryptkey)/i;
const CHAT_KEYS = new Set(['content', 'text', 'msg', 'message', 'reply', 'body', 'quote', 'forwardedrecord']);
const HEX_64_RE = /\b[0-9a-fA-F]{64}\b/g;

/**
 * 对单个值做脱敏。
 * @param {unknown} value 原始值。
 * @param {{ key?: string, includeChatContent?: boolean }} options 字段名与是否允许聊天正文。
 * @returns {unknown} 脱敏后的值。
 */
export function redactValue(value, options = {}) {
  const { key = '', includeChatContent = false } = options;
  if (typeof value === 'string') {
    if (SECRET_KEY_RE.test(key)) return '[已隐藏]';
    if (!includeChatContent && CHAT_KEYS.has(key.toLowerCase())) return '[聊天内容已隐藏]';
    return value.replace(HEX_64_RE, '[64hex已隐藏]');
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, options));
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      out[childKey] = redactValue(childValue, { ...options, key: childKey });
    }
    return out;
  }
  return value;
}

/**
 * 创建日志器。
 * @param {{ file?: string, level?: 'debug'|'info'|'warn'|'error', includeChatContent?: boolean, alsoConsole?: boolean }} [options] 选项。
 * @returns {{ debug: Function, info: Function, warn: Function, error: Function, file: string|null }} 日志器。
 */
export function createLogger(options = {}) {
  const level = options.level ?? 'info';
  const includeChatContent = options.includeChatContent ?? false;
  const alsoConsole = options.alsoConsole ?? true;
  const file = options.file ?? null;
  const threshold = LEVELS[level] ?? LEVELS.info;

  async function emit(levelName, event, fields = {}) {
    if ((LEVELS[levelName] ?? 0) < threshold) return;
    const record = {
      time: new Date().toISOString(),
      level: levelName,
      event,
      ...redactValue(fields, { includeChatContent }),
    };
    const line = JSON.stringify(record);
    if (alsoConsole) {
      const writer = levelName === 'error' || levelName === 'warn' ? console.error : console.log;
      writer(line);
    }
    if (file) {
      await mkdir(path.dirname(file), { recursive: true });
      await appendFile(file, `${line}\n`, 'utf8');
    }
  }

  return {
    file,
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
  };
}
