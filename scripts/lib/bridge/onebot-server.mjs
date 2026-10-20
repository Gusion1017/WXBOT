/**
 * OneBot v11 反向 WebSocket 服务端（bridge 侧，手册 §7.2）。
 *
 * - 只绑 127.0.0.1；Bearer token 常量时间比较；单连接（新连接踢旧连接）。
 * - echo 关联 action 请求/响应，超时清理；帧上限 1MB；只接受 JSON 对象（拒绝数组）。
 * - 断线时所有 pending action 立即失败，不自动重连（重连由 I/O 服务主动拨号）。
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { WebSocketServer } from 'ws';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

/** OneBot 服务端错误。 */
export class OneBotServerError extends Error {
  /**
   * @param {string} code 错误码。
   * @param {string} [message] 说明。
   */
  constructor(code, message = '') {
    super(message || code);
    this.name = 'OneBotServerError';
    this.code = code;
    this.message = message || code;
  }
}

export class OneBotServer extends EventEmitter {
  /**
   * @param {object} options 选项。
   * @param {string} [options.host] 监听地址（只允许 loopback）。
   * @param {number} options.port 端口。
   * @param {string} [options.path] 路径。
   * @param {string} options.token Bearer token（64-hex，必填）。
   * @param {number} [options.requestTimeoutMs] action 超时。
   * @param {number} [options.maxFrameBytes] 单帧上限。
   */
  constructor(options) {
    super();
    this.config = {
      host: options.host ?? '127.0.0.1',
      port: Number(options.port),
      path: options.path ?? '/ws',
      token: String(options.token ?? ''),
      requestTimeoutMs: options.requestTimeoutMs ?? 15000,
      maxFrameBytes: options.maxFrameBytes ?? 1024 * 1024,
    };
    if (!LOOPBACK_HOSTS.has(this.config.host)) {
      throw new OneBotServerError('ONEBOT_LOOPBACK_REQUIRED', `只允许监听本机：${this.config.host}`);
    }
    if (!/^[0-9a-f]{64}$/.test(this.config.token)) {
      throw new OneBotServerError('ONEBOT_TOKEN_REQUIRED', 'OneBot token 必须是 64-hex');
    }
    this.httpServer = null;
    this.wss = null;
    this.socket = null;
    this.pending = new Map();
    this.connected = false;
    this.statusProvider = options.statusProvider ?? null;
  }

  /**
   * 启动监听。
   * @returns {Promise<void>} 启动完成。
   */
  async start() {
    if (this.httpServer) return;
    const server = http.createServer((request, response) => {
      // 本地只读状态端点（Bearer token 相同，避免同机任意进程读取内部状态）
      if (request.method === 'GET' && request.url === '/health') {
        const supplied = String(request.headers.authorization ?? '').replace(/^Bearer /i, '');
        const left = Buffer.from(supplied);
        const right = Buffer.from(this.config.token);
        if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
          response.writeHead(401, { 'content-type': 'application/json' });
          response.end('{"ok":false,"error":"UNAUTHORIZED"}');
          return;
        }
        let body = { ok: true, connected: this.connected };
        if (this.statusProvider) {
          try {
            body = { ...body, ...this.statusProvider() };
          } catch {
            body = { ...body, statusError: true };
          }
        }
        response.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify(body));
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end('{"error":"NOT_FOUND"}');
    });
    const wss = new WebSocketServer({ noServer: true, maxPayload: this.config.maxFrameBytes });
    server.on('upgrade', (request, socket, head) => {
      const reject = (code) => {
        socket.end(`HTTP/1.1 ${code}\r\nConnection: close\r\n\r\n`);
      };
      if (request.url !== this.config.path
        || (request.headers.upgrade ?? '').toLowerCase() !== 'websocket'
        || request.headers['sec-websocket-version'] !== '13') {
        reject('400 Bad Request');
        return;
      }
      const supplied = String(request.headers.authorization ?? '').replace(/^Bearer /i, '');
      const expected = this.config.token;
      const left = Buffer.from(supplied);
      const right = Buffer.from(expected);
      if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
        reject('401 Unauthorized');
        return;
      }
      // 单连接：新连接踢掉旧连接（4001 = 自定义关闭码）
      if (this.socket) {
        try {
          this.socket.close(4001, 'replaced');
        } catch {
          // 旧连接已坏时忽略
        }
        this.socket = null;
        this.connected = false;
      }
      wss.handleUpgrade(request, socket, head, (ws) => {
        this.#attach(ws);
      });
    });
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(this.config.port, this.config.host, resolve);
      });
    } catch (error) {
      server.close();
      throw new OneBotServerError('ONEBOT_PORT_UNAVAILABLE', error.message);
    }
    this.httpServer = server;
    this.wss = wss;
    this.emit('listening', { host: this.config.host, port: this.config.port });
  }

  /**
   * 挂接一个已升级的 WebSocket。
   * @param {import('ws').WebSocket} ws WebSocket。
   * @returns {void}
   */
  #attach(ws) {
    this.socket = ws;
    this.connected = true;
    this.emit('open', { connections: 1 });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.emit('invalid', 'binary_frame');
        return;
      }
      let payload;
      try {
        payload = JSON.parse(String(data));
      } catch {
        this.emit('invalid', 'invalid_json');
        return;
      }
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        this.emit('invalid', 'invalid_frame');
        return;
      }
      if (payload.echo !== undefined && payload.echo !== null) {
        this.#resolveAction(String(payload.echo), payload);
        return;
      }
      try {
        this.emit('event', payload);
      } catch (error) {
        this.emit('invalid', `event_handler_failed:${error?.message ?? error}`);
      }
    });
    ws.on('error', (error) => this.emit('error', error));
    ws.on('close', () => {
      if (this.socket !== ws) return;
      this.socket = null;
      this.connected = false;
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new OneBotServerError('ONEBOT_DISCONNECTED', 'OneBot 连接已断开'));
      }
      this.pending.clear();
      this.emit('close');
    });
  }

  /**
   * 处理 action 响应。
   * @param {string} echo echo。
   * @param {any} payload 响应帧。
   * @returns {void}
   */
  #resolveAction(echo, payload) {
    const pending = this.pending.get(echo);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(echo);
    if (payload.status === 'ok' && Number(payload.retcode ?? 0) === 0) {
      pending.resolve(payload);
      return;
    }
    const error = new OneBotServerError('ONEBOT_ACTION_FAILED',
      `action 失败：retcode=${payload.retcode ?? '?'} ${payload.message ?? ''}`.trim());
    error.data = payload.data;
    pending.reject(error);
  }

  /**
   * 向 I/O 服务发 action。
   * @param {string} action action 名。
   * @param {Record<string, any>} [params] 参数。
   * @returns {Promise<any>} 响应帧。
   */
  action(action, params = {}) {
    if (!this.socket || !this.connected) {
      return Promise.reject(new OneBotServerError('ONEBOT_DISCONNECTED', 'OneBot 未连接'));
    }
    const echo = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(echo);
        reject(new OneBotServerError('ONEBOT_ACTION_TIMEOUT', `action 超时：${action}`));
      }, this.config.requestTimeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ action, params, echo }), (error) => {
        if (error && this.pending.delete(echo)) {
          clearTimeout(timer);
          reject(new OneBotServerError('ONEBOT_SEND_FAILED', error.message));
        }
      });
    });
  }

  /**
   * 停止服务。
   * @returns {Promise<void>} 完成。
   */
  async stop() {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(new OneBotServerError('ONEBOT_STOPPED', 'OneBot 服务停止'));
    }
    this.pending.clear();
    try {
      this.socket?.close(1000, 'stopping');
    } catch {
      // 忽略
    }
    this.socket = null;
    this.connected = false;
    if (this.wss) this.wss.close();
    if (this.httpServer) await new Promise((resolve) => this.httpServer.close(resolve));
    this.wss = null;
    this.httpServer = null;
  }
}
