/**
 * 合成 OneBot 数字 ID（手册 §7.3）：
 *   id = sha256(identity) 前 8 字节大端 % 2147483647 + 1
 * 私聊 identity 用 wxid，群用**群显示名（去尾部 `(n)`）**，保证白名单与 session 键稳定。
 */
import { createHash } from 'node:crypto';

/**
 * 计算 OneBot 数字 ID。
 * @param {string} identity 身份字符串（wxid 或群显示名）。
 * @returns {string} 数字字符串。
 */
export function onebotId(identity) {
  const digest = createHash('sha256').update(String(identity ?? ''), 'utf8').digest();
  const value = digest.readBigUInt64BE(0) % 2147483647n + 1n;
  return value.toString();
}

/**
 * 群显示名归一化（去尾部 (n)）。
 * @param {string} displayName 显示名。
 * @returns {string} 归一化结果。
 */
export function normalizeGroupName(displayName) {
  return String(displayName ?? '').replace(/\s*\(\d+\)\s*$/, '').trim();
}

/**
 * 从配置白名单推导 OneBot 数字 ID 集合（bridge 与 adapter 共用同一算法）。
 * @param {{ whitelist?: { private?: string[], groups?: string[] } }} wechat 配置里的 wechat 段。
 * @returns {{ private: Set<string>, groups: Set<string> }} 数字 ID 集合。
 */
export function whitelistIdSets(wechat) {
  const whitelist = wechat?.whitelist ?? {};
  return {
    private: new Set((whitelist.private ?? []).map((entry) => onebotId(entry))),
    groups: new Set((whitelist.groups ?? []).map((entry) => onebotId(normalizeGroupName(entry)))),
  };
}

/**
 * 判断 OneBot 数字 ID 是否在白名单里。
 * @param {string|number} id OneBot id。
 * @param {{ private: Set<string>, groups: Set<string> }} sets 白名单集合。
 * @param {'private'|'group'} kind 类型。
 * @returns {boolean} 是否允许。
 */
export function isWhitelistedId(id, sets, kind) {
  const pool = kind === 'group' ? sets.groups : sets.private;
  return pool.has(String(id));
}
