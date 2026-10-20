/**
 * Hook 发送通道客户端（M4，手册 §6.2/§6.3）。
 *
 * 只与 127.0.0.1 上的 Hook HTTP 通信：
 * - `GET /WeChatAgent/health`：版本/账号/初始化状态（只读）
 * - `POST /SendTextMsg`：发送文本，HTTP 200 只代表"受理"
 *
 * 所有失败都转成带错误码的 HookError，便于上层落状态机。
 */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { projectPath } from '../core/paths.mjs';

/** Hook 通道错误码。 */
export class HookError extends Error {
  /**
   * @param {string} code 错误码。
   * @param {string} [message] 说明。
   */
  constructor(code, message = '') {
    super(message || code);
    this.name = 'HookError';
    this.code = code;
    this.message = message || code;
  }
}

/**
 * 校验 Hook 地址必须是 loopback http（手册 §10 配置校验）。
 * @param {string} baseUrl 基地址。
 * @returns {URL} 解析后的 URL。
 */
export function assertLoopback(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new HookError('HOOK_LOOPBACK_REQUIRED', `非法地址：${baseUrl}`);
  }
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port
    || url.username || url.password || (url.pathname !== '' && url.pathname !== '/')
    || url.search || url.hash) {
    throw new HookError('HOOK_LOOPBACK_REQUIRED', `Hook 必须是 http://127.0.0.1:<端口>：${baseUrl}`);
  }
  return url;
}

/**
 * 读取 Hook Bearer token（state/tokens/hook.txt，64-hex）。
 * @param {string} [root] 工程根目录。
 * @returns {Promise<string>} token。
 */
export async function readHookToken(root = projectPath()) {
  const file = path.join(root, 'state', 'tokens', 'hook.txt');
  try {
    const token = (await readFile(file, 'utf8')).trim();
    if (!/^[0-9a-f]{64}$/.test(token)) {
      throw new HookError('HOOK_TOKEN_INVALID', 'state/tokens/hook.txt 不是 64-hex');
    }
    return token;
  } catch (error) {
    if (error instanceof HookError) throw error;
    throw new HookError('HOOK_TOKEN_MISSING', '缺少 state/tokens/hook.txt，请运行 npm run init');
  }
}

/**
 * 发一个 HTTP JSON 请求（node:http，避免 fetch/undici 退出句柄问题）。
 * @param {object} options 选项。
 * @param {string} options.baseUrl 基地址。
 * @param {string} options.path 路径。
 * @param {'GET'|'POST'} [options.method] 方法。
 * @param {unknown} [options.body] JSON 请求体。
 * @param {Record<string,string>} [options.headers] 额外请求头。
 * @param {number} [options.timeoutMs] 超时。
 * @returns {Promise<{ status: number, body: any, raw: string }>} 响应。
 */
export async function requestJson({ baseUrl, path, method = 'GET', body, headers = {}, timeoutMs = 5000 }) {
  const url = assertLoopback(baseUrl);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn) => (value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), 'utf8');
    const request = http.request({
      host: url.hostname,
      port: Number(url.port),
      path,
      method,
      timeout: timeoutMs,
      headers: {
        ...headers,
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {}),
      },
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch {
          finish(reject)(new HookError('HOOK_INVALID_RESPONSE', '响应不是 JSON'));
          return;
        }
        finish(resolve)({ status: response.statusCode ?? 0, body: parsed, raw });
      });
      response.on('error', (error) => finish(reject)(new HookError('HOOK_NETWORK_ERROR', error.code ?? error.message)));
    });
    request.on('timeout', () => {
      request.destroy();
      finish(reject)(new HookError('HOOK_TIMEOUT', `请求超时（${timeoutMs}ms）`));
    });
    request.on('error', (error) => {
      const code = error.code === 'ECONNREFUSED' ? 'HOOK_NOT_LISTENING' : (error.code ?? 'HOOK_NETWORK_ERROR');
      finish(reject)(new HookError(code, error.message));
    });
    if (payload) request.write(payload);
    request.end();
  });
}

/**
 * 读取 Hook 健康信息。
 * @param {{ baseUrl: string, token: string, timeoutMs?: number }} options 选项。
 * @returns {Promise<any>} health 响应体。
 */
export async function health({ baseUrl, token, timeoutMs = 5000 }) {
  let result;
  try {
    result = await requestJson({
      baseUrl,
      path: '/WeChatAgent/health',
      headers: { authorization: `Bearer ${token}` },
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof HookError) throw error;
    throw new HookError('HOOK_HEALTH_FAILED', error.message);
  }
  if (result.status === 401) throw new HookError('HOOK_UNAUTHORIZED', 'Hook token 被拒绝');
  if (result.status !== 200 || !result.body || typeof result.body !== 'object') {
    throw new HookError('HOOK_HEALTH_FAILED', `health HTTP ${result.status}`);
  }
  return result.body;
}

/**
 * 发送文本消息；HTTP 200 只代表受理。
 * @param {{ baseUrl: string, token: string, accountDirectory: string, target: string, text: string, timeoutMs?: number }} options 选项。
 * @returns {Promise<{ ret: number, retmsg: string }>} 受理结果。
 */
export async function sendText({
  baseUrl, token, accountDirectory, target, text, timeoutMs = 5000,
}) {
  if (!target || typeof target !== 'string' || Buffer.byteLength(target) > 256) {
    throw new HookError('HOOK_TARGET_INVALID', 'wxidorgid 为空或超长');
  }
  if (typeof text !== 'string' || text.length === 0 || Buffer.byteLength(text) > 16000) {
    throw new HookError('HOOK_TEXT_INVALID', 'msg 为空或超长');
  }
  if (!accountDirectory) throw new HookError('HOOK_ACCOUNT_MISSING', '缺少账号目录，拒绝发送');
  let result;
  try {
    result = await requestJson({
      baseUrl,
      path: '/SendTextMsg',
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-wechatagent-account': accountDirectory,
      },
      body: { wxidorgid: target, msg: text },
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof HookError) throw error;
    throw new HookError('HOOK_SEND_FAILED', error.message);
  }
  const statusMap = {
    400: 'HOOK_BAD_REQUEST',
    401: 'HOOK_UNAUTHORIZED',
    403: 'HOOK_FORBIDDEN',
    409: 'HOOK_VERSION_OR_ACCOUNT_MISMATCH',
    429: 'HOOK_BUSY',
  };
  if (statusMap[result.status]) {
    throw new HookError(statusMap[result.status], `SendTextMsg HTTP ${result.status}`);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new HookError('HOOK_SEND_FAILED', `SendTextMsg HTTP ${result.status}`);
  }
  const body = result.body ?? {};
  if (Number(body.ret) !== 0) {
    throw new HookError('HOOK_SEND_REJECTED', `ret=${body.ret} retmsg=${body.retmsg ?? ''}`);
  }
  return { ret: Number(body.ret), retmsg: String(body.retmsg ?? 'accepted') };
}

/**
 * 发送原生表情包；HTTP 200 只代表受理。
 * @param {{ baseUrl: string, token: string, accountDirectory: string, target: string,
 *   stickerPath: string, fields: { md5: string, productid?: string, len: number, type?: number, width: number, height: number },
 *   timeoutMs?: number }} options 选项。
 * @returns {Promise<{ ret: number, retmsg: string }>} 受理结果。
 */
export async function sendSticker({
  baseUrl, token, accountDirectory, target, stickerPath, fields, timeoutMs = 5000,
}) {
  if (!target || typeof target !== 'string' || Buffer.byteLength(target) > 256) {
    throw new HookError('HOOK_TARGET_INVALID', 'wxidorgid 为空或超长');
  }
  if (!accountDirectory) throw new HookError('HOOK_ACCOUNT_MISSING', '缺少账号目录，拒绝发送');
  if (typeof stickerPath !== 'string' || !stickerPath) {
    throw new HookError('HOOK_STICKER_PATH_INVALID', '缺少表情文件路径');
  }
  const safeFields = {
    md5: String(fields?.md5 ?? ''),
    productid: String(fields?.productid ?? ''),
    len: Number(fields?.len ?? 0),
    type: Number(fields?.type ?? 2),
    width: Number(fields?.width ?? 0),
    height: Number(fields?.height ?? 0),
  };
  if (!/^[a-f0-9]{32}$/.test(safeFields.md5)) {
    throw new HookError('HOOK_STICKER_METADATA_INVALID', '表情 MD5 非法');
  }
  let result;
  try {
    result = await requestJson({
      baseUrl,
      path: '/SendStickerMsg',
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'x-wechatagent-account': accountDirectory,
      },
      body: { wxidorgid: target, sticker: safeFields, path: stickerPath },
      timeoutMs,
    });
  } catch (error) {
    if (error instanceof HookError) throw error;
    throw new HookError('HOOK_STICKER_SEND_FAILED', error.message);
  }
  const statusMap = {
    400: 'HOOK_STICKER_BAD_REQUEST',
    401: 'HOOK_UNAUTHORIZED',
    403: 'HOOK_FORBIDDEN',
    409: 'HOOK_VERSION_OR_ACCOUNT_MISMATCH',
    429: 'HOOK_BUSY',
  };
  if (statusMap[result.status]) {
    throw new HookError(statusMap[result.status], `SendStickerMsg HTTP ${result.status}`);
  }
  if (result.status < 200 || result.status >= 300) {
    throw new HookError('HOOK_STICKER_SEND_FAILED', `SendStickerMsg HTTP ${result.status}`);
  }
  const body = result.body ?? {};
  if (Number(body.ret) !== 0) {
    throw new HookError('HOOK_STICKER_REJECTED', `ret=${body.ret} error=${body.error ?? body.retmsg ?? ''}`);
  }
  return { ret: Number(body.ret), retmsg: String(body.retmsg ?? 'accepted') };
}

/**
 * 读取读取层状态（跨通道身份校验需要）。
 * @param {{ readerBaseUrl: string, readerToken: string, timeoutMs?: number }} options 选项。
 * @returns {Promise<any>} reader 状态。
 */
export async function readerStatus({ readerBaseUrl, readerToken, timeoutMs = 3000 }) {
  const url = new URL(readerBaseUrl);
  const result = await requestJson({
    baseUrl: `http://127.0.0.1:${url.port}`,
    path: '/api/v1/reader/status',
    headers: { authorization: `Bearer ${readerToken}` },
    timeoutMs,
  }).catch((error) => {
    throw error instanceof HookError ? error : new HookError('READER_UNREACHABLE', error.message);
  });
  if (result.status !== 200 || !result.body || result.body.success === false) {
    throw new HookError('READER_NOT_READY', `reader status HTTP ${result.status}`);
  }
  if (result.body.ready === false) {
    throw new HookError('READER_NOT_READY', result.body.lastError || 'reader 未就绪');
  }
  return result.body;
}

/**
 * Hook + reader 跨通道校验（手册 §4.6 / §6.2）：
 * 版本三重锁中的调用方期望值、账号锁（hook 报告的 db_storage 账号 == reader 账号目录）。
 * @param {object} options 选项。
 * @returns {Promise<{ reader: any, hook: any }>} 双方状态。
 */
export async function checkNative({
  readerBaseUrl, readerToken, hookBaseUrl, hookToken, expectedVersion, timeoutMs = 5000,
}) {
  const reader = await readerStatus({ readerBaseUrl, readerToken, timeoutMs });
  if (!reader.accountDirectory) {
    throw new HookError('READER_ACCOUNT_MISSING', 'reader 未报告 accountDirectory');
  }
  const hook = await health({ baseUrl: hookBaseUrl, token: hookToken, timeoutMs });
  if (hook.integration !== 'WeChatAgent-1') {
    throw new HookError('HOOK_INTEGRATION_MISMATCH', `未识别的 Hook 构建：${hook.integration ?? '(none)'}`);
  }
  if (hook.version !== expectedVersion) {
    throw new HookError('HOOK_VERSION_MISMATCH', `Hook 版本 ${hook.version} != ${expectedVersion}`);
  }
  if (hook.startupState && hook.startupState !== 'ready') {
    throw new HookError('HOOK_INITIALIZATION_PENDING', `startupState=${hook.startupState}`);
  }
  const accounts = Array.isArray(hook.databaseAccounts) ? hook.databaseAccounts : [];
  if (accounts.length !== 1
    || String(accounts[0] ?? '').toLowerCase() !== String(reader.accountDirectory).toLowerCase()) {
    throw new HookError(
      'HOOK_ACCOUNT_NOT_READY',
      `Hook 账号 ${accounts.join(',') || '(none)'} != reader 账号 ${reader.accountDirectory}`,
    );
  }
  return { reader, hook };
}

/**
 * 等待 Hook 就绪（只在 NOT_LISTENING / HEALTH_TIMEOUT / INITIALIZATION_PENDING 上重试）。
 * @param {object} options checkNative 参数 + deadlineMs/intervalMs。
 * @returns {Promise<{ reader: any, hook: any }>} 结果。
 */
export async function waitForNative(options) {
  const deadline = Date.now() + (options.deadlineMs ?? 35_000);
  const retryCodes = new Set(['HOOK_NOT_LISTENING', 'HOOK_TIMEOUT', 'HOOK_HEALTH_TIMEOUT', 'HOOK_INITIALIZATION_PENDING']);
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      return await checkNative(options);
    } catch (error) {
      lastError = error;
      if (!(error instanceof HookError) || !retryCodes.has(error.code)) throw error;
      await new Promise((resolve) => setTimeout(resolve, options.intervalMs ?? 250));
    }
  }
  throw lastError ?? new HookError('HOOK_INITIALIZATION_TIMEOUT');
}
