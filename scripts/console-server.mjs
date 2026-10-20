#!/usr/bin/env node
/**
 * WXBOT 本机只读 API 服务（桌面版数据接口；网页界面已移除）。
 *
 * 安全（手册 §10）：只绑 127.0.0.1；Host/Origin 校验；所有 /api/* 要求
 * `x-console-token`（常量时间比较）；只读（GET/HEAD 之外 405）。
 * 代理：reader token / onebot token / adapter token / hook token 只留在服务端。
 */
import crypto from 'node:crypto';
import http from 'node:http';
import https from 'node:https';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { projectPath, PROJECT_ROOT } from './lib/core/paths.mjs';
import { loadConfig } from './lib/core/config.mjs';
import { inspectToken } from './lib/core/tokens.mjs';
import {
  isAllowedHost,
  isAllowedOrigin,
  safeLogText,
  tokenEquals,
} from './lib/console/console-security.mjs';

const HOST = '127.0.0.1';

/**
 * 读取配置、token 与端口。
 * @returns {Promise<any>} 设置。
 */
async function loadSettings() {
  const { config } = await loadConfig();
  const tokens = {};
  for (const channel of ['console', 'reader', 'onebot', 'adapter', 'hook']) {
    const info = await inspectToken(channel);
    tokens[channel] = info.token;
  }
  if (!tokens.console) throw new Error('CONSOLE_TOKEN_MISSING：请先运行 npm run init');
  if (!tokens.reader) throw new Error('READER_TOKEN_MISSING：请先运行 npm run init');
  const portArg = process.argv.indexOf('--port');
  const port = portArg > 0 ? Number(process.argv[portArg + 1]) : Number(config.ports.console);
  return {
    config,
    tokens,
    port,
    readerPort: Number(config.ports.reader),
    bridgePort: Number(config.ports.onebot),
    adapterPort: Number(config.ports.adapter),
    hookBaseUrl: String(config.hook?.baseUrl ?? ''),
  };
}

/**
 * 发 JSON 响应。
 * @param {import('node:http').ServerResponse} response 响应。
 * @param {number} status 状态码。
 * @param {unknown} body 响应体。
 * @returns {void}
 */
function sendJson(response, status, body) {
  const raw = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(raw),
    'cache-control': 'no-store',
    connection: 'close',
  });
  response.end(raw);
}

/**
 * GET JSON（localhost，带超时）。
 * @param {number} port 端口。
 * @param {string} apiPath 路径。
 * @param {Record<string,string>} [headers] 请求头。
 * @param {number} [timeoutMs] 超时。
 * @returns {Promise<any>} JSON（失败返回 null）。
 */
function httpJson(port, apiPath, headers = {}, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const request = http.get({ host: HOST, port, path: apiPath, timeout: timeoutMs, headers }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(null); }
      });
      response.on('error', () => resolve(null));
    });
    request.on('timeout', () => { request.destroy(); resolve(null); });
    request.on('error', () => resolve(null));
  });
}

/**
 * GET 完整 URL JSON（用于 hook 客户端）。
 * @param {string} targetUrl 完整 URL。
 * @param {Record<string,string>} headers 请求头。
 * @param {number} [timeoutMs] 超时。
 * @returns {Promise<any>} JSON（失败 null）。
 */
function httpJsonUrl(targetUrl, headers = {}, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let url;
    try { url = new URL(targetUrl); } catch { resolve(null); return; }
    const transport = url.protocol === 'https:' ? https : http;
    const request = transport.get({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      timeout: timeoutMs,
      headers,
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch { resolve(null); }
      });
      response.on('error', () => resolve(null));
    });
    request.on('timeout', () => { request.destroy(); resolve(null); });
    request.on('error', () => resolve(null));
  });
}

/**
 * 读取配送状态摘要。
 * @returns {Promise<{ summary: Record<string, number>, recent: any[] }>} 摘要与最近记录。
 */
async function readDeliveries() {
  const summary = { dispatching: 0, accepted: 0, confirmed: 0, unconfirmed: 0, rejected: 0 };
  const recent = [];
  try {
    const dir = projectPath('state', 'text-deliveries');
    const files = (await readdir(dir)).filter((name) => name.endsWith('.json'));
    for (const file of files) {
      try {
        const record = JSON.parse(await readFile(path.join(dir, file), 'utf8'));
        summary[record.state] = (summary[record.state] ?? 0) + 1;
        recent.push({
          deliveryId: String(record.deliveryId ?? '').slice(0, 12),
          state: record.state,
          target: record.target,
          kind: record.kind,
          textLength: record.textLength,
          serverId: record.serverId,
          reason: record.reason,
          updatedAt: record.updatedAt,
        });
      } catch {
        // 坏文件跳过
      }
    }
  } catch {
    // 目录不存在
  }
  recent.sort((left, right) => String(right.updatedAt).localeCompare(String(left.updatedAt)));
  return { summary, recent: recent.slice(0, 8) };
}

/**
 * 读取 supervisor 状态。
 * @returns {Promise<any|null>} 状态。
 */
async function readSupervisor() {
  try {
    return JSON.parse(await readFile(projectPath('state', 'supervisor.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 聚合元信息（不含 token 明文）。
 * @param {any} settings 设置。
 * @returns {Promise<any>} 元信息。
 */
async function buildMeta(settings) {
  const { config, tokens } = settings;
  const [readerStatus, bridgeHealth, adapterStatus, hookHealth, supervisor, deliveries] = await Promise.all([
    httpJson(settings.readerPort, '/api/v1/reader/status', { authorization: `Bearer ${tokens.reader}` }),
    httpJson(settings.bridgePort, '/health', { authorization: `Bearer ${tokens.onebot}` }),
    httpJson(settings.adapterPort, '/status', { authorization: `Bearer ${tokens.adapter}` }),
    settings.hookBaseUrl ? httpJsonUrl(`${settings.hookBaseUrl}/WeChatAgent/health`, { authorization: `Bearer ${tokens.hook}` }) : null,
    readSupervisor(),
    readDeliveries(),
  ]);
  return {
    success: true,
    generatedAt: new Date().toISOString(),
    projectRoot: PROJECT_ROOT,
    ports: config.ports,
    accountDirectory: config.reader.accountDirectory,
    whitelist: config.wechat.whitelist,
    autoReply: Boolean(config.bridge.autoReply),
    model: {
      enabled: Boolean(config.model.enabled),
      provider: config.model.provider,
      model: config.model.model,
      personaFile: config.model.personaFile,
    },
    services: {
      reader: readerStatus,
      bridge: bridgeHealth,
      adapter: adapterStatus,
      hook: hookHealth,
      supervisor,
    },
    deliveries,
  };
}

/**
 * 代理 reader SSE 到本机客户端（桌面版/调试工具用 fetch 流读取，带 CSRF 校验）。
 * @param {any} settings 设置。
 * @param {import('node:http').ServerRequest} request 请求。
 * @param {import('node:http').ServerResponse} response 响应。
 * @returns {void}
 */
function proxyLiveStream(settings, request, response) {
  const upstream = http.get({
    host: HOST,
    port: settings.readerPort,
    path: '/api/v1/push/messages',
    headers: { authorization: `Bearer ${settings.tokens.reader}` },
  }, (upstreamResponse) => {
    if (upstreamResponse.statusCode !== 200) {
      sendJson(response, 503, { success: false, error: 'READER_STREAM_UNAVAILABLE' });
      upstreamResponse.resume();
      return;
    }
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-store',
      connection: 'close',
      'x-accel-buffering': 'no',
    });
    upstreamResponse.pipe(response);
  });
  upstream.on('error', () => {
    if (!response.headersSent) sendJson(response, 503, { success: false, error: 'READER_STREAM_UNAVAILABLE' });
    else response.end();
  });
  request.on('close', () => {
    try { upstream.destroy(); } catch { /* ignore */ }
  });
}

const settings = await loadSettings();

const server = http.createServer(async (request, response) => {
  const port = settings.port;
  if (!isAllowedHost(request.headers.host, port) || !isAllowedOrigin(request.headers.origin, port)) {
    sendJson(response, 403, { success: false, error: 'CONSOLE_ORIGIN_REJECTED' });
    return;
  }
  const url = new URL(request.url ?? '/', `http://${HOST}:${port}`);
  const method = request.method ?? 'GET';
  if (method !== 'GET' && method !== 'HEAD') {
    sendJson(response, 405, { success: false, error: 'READ_ONLY_CONSOLE' });
    return;
  }

  // 本服务只提供本机 API（网页界面已移除）；根路径返回服务说明
  if (url.pathname === '/' || url.pathname === '/index.html') {
    sendJson(response, 200, {
      success: true,
      service: 'wxbot-local-api',
      note: '桌面版 WXBOT.exe 通过本 API 读取数据；网页控制台界面已移除。',
      endpoints: [
        'GET /api/meta',
        'GET /api/live',
        'GET /api/sessions',
        'GET /api/contacts',
        'GET /api/messages',
        'GET /api/images/<64hex>',
      ],
      auth: '所有 /api/* 需要 x-console-token 请求头',
    });
    return;
  }
  if (!url.pathname.startsWith('/api/')) {
    sendJson(response, 404, { success: false, error: 'NOT_FOUND' });
    return;
  }
  if (!tokenEquals(request.headers['x-console-token'], settings.tokens.console)) {
    sendJson(response, 401, { success: false, error: 'CONSOLE_UNAUTHORIZED' });
    return;
  }

  try {
    if (url.pathname === '/api/meta') {
      sendJson(response, 200, await buildMeta(settings));
      return;
    }
    if (url.pathname === '/api/live') {
      proxyLiveStream(settings, request, response);
      return;
    }
    const forward = new Map([
      ['/api/sessions', '/api/v1/sessions'],
      ['/api/contacts', '/api/v1/contacts'],
      ['/api/messages', '/api/v1/messages'],
    ]);
    if (forward.has(url.pathname)) {
      const query = url.searchParams.toString();
      const body = await httpJson(
        settings.readerPort,
        `${forward.get(url.pathname)}${query ? `?${query}` : ''}`,
        { authorization: `Bearer ${settings.tokens.reader}` },
      );
      if (body === null) sendJson(response, 503, { success: false, error: 'READER_PROXY_FAILED' });
      else sendJson(response, 200, body);
      return;
    }
    const imageMatch = url.pathname.match(/^\/api\/images\/([a-f0-9]{64})$/);
    if (imageMatch) {
      const body = await httpJson(
        settings.readerPort,
        `/api/v1/images/${imageMatch[1]}`,
        { authorization: `Bearer ${settings.tokens.reader}` },
        30000,
      );
      if (body === null) sendJson(response, 503, { success: false, error: 'IMAGE_PROXY_FAILED' });
      else sendJson(response, 200, body);
      return;
    }
    sendJson(response, 404, { success: false, error: 'NOT_FOUND' });
  } catch (error) {
    console.error(`[console] request failed: ${safeLogText(url.pathname)} ${error?.name ?? ''}`);
    sendJson(response, 503, { success: false, error: 'CONSOLE_PROXY_FAILED' });
  }
});

server.listen(settings.port, HOST, () => {
  console.log(JSON.stringify({
    ok: true,
    listening: `http://${HOST}:${settings.port}`,
    ready: true,
    readerPort: settings.readerPort,
    bridgePort: settings.bridgePort,
    adapterPort: settings.adapterPort,
  }));
});

const shutdown = () => server.close(() => process.exit(0));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
