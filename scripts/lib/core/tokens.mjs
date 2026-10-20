/**
 * 每个通道独立随机 64-hex Bearer token（手册 §2 铁律 2 / §9）。
 *
 * 落盘位置：state/tokens/<channel>.txt，权限收缩为仅当前用户读写。
 */
import { randomBytes } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectPath } from './paths.mjs';
import { checkPrivateFile, restrictToCurrentUser, writePrivateFile } from './private-file.mjs';

/** 通道清单（每个端口/用途一个独立 token）。 */
export const TOKEN_CHANNELS = ['reader', 'adapter', 'onebot', 'aiRuntime', 'console', 'hook'];

const TOKEN_RE = /^[0-9a-f]{64}$/;

/**
 * token 文件路径。
 * @param {string} channel 通道名。
 * @param {string} [root] 工程根目录（测试可注入）。
 * @returns {string} 绝对路径。
 */
export function tokenPath(channel, root = projectPath()) {
  return path.join(root, 'state', 'tokens', `${channel}.txt`);
}

/**
 * 生成一个 64-hex 随机 token。
 * @returns {string} token。
 */
export function generateToken() {
  return randomBytes(32).toString('hex');
}

/**
 * 确保某个通道的 token 存在且合法；缺失/损坏则重新生成。
 * @param {string} channel 通道名。
 * @param {{ root?: string }} [options] 选项。
 * @returns {Promise<{ token: string, path: string, rotated: boolean }>} token 信息。
 */
export async function ensureToken(channel, options = {}) {
  if (!TOKEN_CHANNELS.includes(channel)) {
    throw new Error(`未知 token 通道：${channel}（可选：${TOKEN_CHANNELS.join(', ')}）`);
  }
  const root = options.root ?? projectPath();
  const file = tokenPath(channel, root);
  let rotated = false;
  let token = null;
  try {
    await access(file);
    const existing = (await readFile(file, 'utf8')).trim();
    if (TOKEN_RE.test(existing)) token = existing;
  } catch {
    // 文件不存在，走生成
  }
  if (token === null) {
    token = generateToken();
    await writePrivateFile(file, `${token}\n`);
    rotated = true;
  } else {
    // 已存在也每次校正 ACL（例如从别处拷贝进来、或旧版本没设权限）。
    await restrictToCurrentUser(file);
  }
  return { token, path: file, rotated };
}

/**
 * 确保所有通道 token 存在。
 * @param {{ root?: string }} [options] 选项。
 * @returns {Promise<Array<{ channel: string, token: string, path: string, rotated: boolean }>>} 结果列表。
 */
export async function ensureAllTokens(options = {}) {
  const results = [];
  for (const channel of TOKEN_CHANNELS) {
    const result = await ensureToken(channel, options);
    results.push({ channel, ...result });
  }
  return results;
}

/**
 * 读取某通道 token 并校验文件私有权限。
 * @param {string} channel 通道名。
 * @param {{ root?: string }} [options] 选项。
 * @returns {Promise<{ channel: string, token: string|null, path: string, private: boolean, privateReason?: string }>} 读取结果。
 */
export async function inspectToken(channel, options = {}) {
  const root = options.root ?? projectPath();
  const file = tokenPath(channel, root);
  let token = null;
  try {
    const raw = (await readFile(file, 'utf8')).trim();
    if (TOKEN_RE.test(raw)) token = raw;
  } catch {
    // 忽略：下面按缺失处理
  }
  const priv = await checkPrivateFile(file);
  return { channel, token, path: file, private: priv.private, privateReason: priv.reason };
}
