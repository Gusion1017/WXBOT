/**
 * 控制台安全辅助（手册 §10：控制器/控制台加 CSRF + Host/Origin 校验）。
 *
 * 纯函数，便于单测：不做 IO，不读进程环境。
 */
import crypto from 'node:crypto';

/**
 * 判断 Host 头是否指向本机控制台端口。
 * @param {string|undefined} hostHeader 请求头 Host。
 * @param {number} port 控制台端口。
 * @returns {boolean} 是否允许。
 */
export function isAllowedHost(hostHeader, port) {
  if (!hostHeader) return false;
  const allowed = new Set([
    `127.0.0.1:${port}`,
    `localhost:${port}`,
    `[::1]:${port}`,
  ]);
  return allowed.has(hostHeader.trim().toLowerCase());
}

/**
 * 判断 Origin 头是否同源（没有 Origin 的导航请求放行）。
 * @param {string|undefined} originHeader 请求头 Origin。
 * @param {number} port 控制台端口。
 * @returns {boolean} 是否允许。
 */
export function isAllowedOrigin(originHeader, port) {
  if (!originHeader) return true;
  const allowed = new Set([
    `http://127.0.0.1:${port}`,
    `http://localhost:${port}`,
    `http://[::1]:${port}`,
  ]);
  return allowed.has(originHeader.trim().toLowerCase());
}

/**
 * 常量时间比较 CSRF token。
 * @param {string} supplied 请求头里的 token。
 * @param {string} expected 服务端 token。
 * @returns {boolean} 是否一致。
 */
export function tokenEquals(supplied, expected) {
  if (typeof supplied !== 'string' || typeof expected !== 'string') return false;
  const left = Buffer.from(supplied, 'utf8');
  const right = Buffer.from(expected, 'utf8');
  if (left.length !== right.length || left.length === 0) return false;
  return crypto.timingSafeEqual(left, right);
}

/**
 * 日志脱敏：去掉查询串（可能含 token）与 64-hex。
 * @param {string} value 原始文本。
 * @returns {string} 脱敏结果。
 */
export function safeLogText(value) {
  return String(value ?? '')
    .split('?')[0]
    .replace(/\b[0-9a-fA-F]{64}\b/g, '[64hex已隐藏]');
}

/**
 * 允许的静态资源名（防止路径穿越）。
 * @param {string} name 请求的静态文件名。
 * @returns {boolean} 是否允许。
 */
export function isStaticAssetName(name) {
  return /^[a-zA-Z0-9._-]+\.(?:html|js|css|svg|png|ico)$/.test(name) && !name.includes('..');
}
