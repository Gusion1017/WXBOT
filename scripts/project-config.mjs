#!/usr/bin/env node
/**
 * 配置与令牌 CLI（M0）。
 *
 * 用法：
 *   node scripts/project-config.mjs init            生成/补全 config/app.json 与所有 token
 *   node scripts/project-config.mjs validate        校验配置
 *   node scripts/project-config.mjs status [--json]  健康检查：端口监听 + 令牌权限
 *   node scripts/project-config.mjs token <通道>     打印某通道 token 文件路径
 *   node scripts/project-config.mjs paths           打印关键路径
 */
import http from 'node:http';
import { connect } from 'node:net';
import path from 'node:path';
import process from 'node:process';
import { loadConfig, ConfigError } from './lib/core/config.mjs';
import { ensureAllTokens, inspectToken, tokenPath, TOKEN_CHANNELS } from './lib/core/tokens.mjs';
import { projectPath, PROJECT_ROOT } from './lib/core/paths.mjs';

const HOST = '127.0.0.1';

/**
 * TCP 探测端口是否在监听。
 * @param {number} port 端口。
 * @param {number} [timeoutMs] 超时毫秒。
 * @returns {Promise<boolean>} 是否可连接。
 */
function probePort(port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = connect({ host: HOST, port });
    const done = (value) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * 用 node:http 请求本机 JSON 端点（避免 Node 24 下 fetch/undici 在进程退出时的句柄断言）。
 * @param {number} port 端口。
 * @param {string} apiPath 路径。
 * @param {Record<string,string>} headers 请求头。
 * @param {number} [timeoutMs] 超时毫秒。
 * @returns {Promise<{ status: number, body: any, error?: string }>} 结果。
 */
function httpJson(port, apiPath, headers, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const request = http.request({
      host: HOST,
      port,
      path: apiPath,
      method: 'GET',
      headers,
      timeout: timeoutMs,
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        let body = null;
        try {
          body = JSON.parse(raw);
        } catch {
          finish({ status: response.statusCode ?? 0, body: null, error: 'BAD_JSON' });
          return;
        }
        finish({ status: response.statusCode ?? 0, body });
      });
      response.on('error', (error) => finish({ status: 0, body: null, error: error.code ?? error.message }));
    });
    request.on('timeout', () => {
      request.destroy();
      finish({ status: 0, body: null, error: 'timeout' });
    });
    request.on('error', (error) => finish({ status: 0, body: null, error: error.code ?? error.message }));
    request.end();
  });
}

/**
 * 请求读取层状态端点。
 * @param {number} port 端口。
 * @param {string} token reader token。
 * @returns {Promise<{ ok: boolean, body?: any, error?: string }>} 结果。
 */
async function fetchReaderStatus(port, token) {
  const result = await httpJson(port, '/api/v1/reader/status', { authorization: `Bearer ${token}` });
  const healthy = result.status >= 200 && result.status < 300 && Boolean(result.body)
    && result.body.success !== false && result.body.ready !== false;
  return {
    ok: healthy,
    body: result.body,
    error: healthy ? undefined : `HTTP ${result.status}${result.body?.error ? ` ${result.body.error}` : ''}`,
  };
}

/**
 * 请求控制台元信息端点。
 * @param {number} port 控制台端口。
 * @param {string} token console token。
 * @returns {Promise<{ ok: boolean, body?: any, error?: string }>} 结果。
 */
async function fetchConsoleMeta(port, token) {
  const result = await httpJson(port, '/api/meta', { 'x-console-token': token });
  const healthy = result.status >= 200 && result.status < 300 && Boolean(result.body)
    && result.body.success !== false;
  return {
    ok: healthy,
    body: result.body,
    error: healthy ? undefined : `HTTP ${result.status}${result.body?.error ? ` ${result.body.error}` : ''}`,
  };
}

/**
 * 请求桥接服务状态端点。
 * @param {number} port onebot 端口。
 * @param {string} token onebot token。
 * @returns {Promise<{ ok: boolean, body?: any, error?: string }>} 结果。
 */
async function fetchBridgeHealth(port, token) {
  const result = await httpJson(port, '/health', { authorization: `Bearer ${token}` });
  const healthy = result.status >= 200 && result.status < 300 && Boolean(result.body) && result.body.ok !== false;
  return {
    ok: healthy,
    body: result.body,
    error: healthy ? undefined : `HTTP ${result.status}${result.body?.error ? ` ${result.body.error}` : ''}`,
  };
}

/**
 * 请求适配器状态端点。
 * @param {number} port adapter 端口。
 * @param {string} token adapter token。
 * @returns {Promise<{ ok: boolean, body?: any, error?: string }>} 结果。
 */
async function fetchAdapterHealth(port, token) {
  const result = await httpJson(port, '/status', { authorization: `Bearer ${token}` });
  const healthy = result.status >= 200 && result.status < 300 && Boolean(result.body) && result.body.ok !== false;
  return {
    ok: healthy,
    body: result.body,
    error: healthy ? undefined : `HTTP ${result.status}${result.body?.error ? ` ${result.body.error}` : ''}`,
  };
}

/**
 * 生成健康检查报告。
 * @returns {Promise<any>} 报告对象。
 */
async function buildStatusReport() {
  const { config, path: configPath } = await loadConfig({ createIfMissing: true });
  await ensureAllTokens();
  const tokens = {};
  for (const channel of TOKEN_CHANNELS) {
    const info = await inspectToken(channel);
    tokens[channel] = {
      path: info.path,
      present: info.token !== null,
      private: info.private,
      privateReason: info.privateReason,
    };
  }
  const services = {};
  for (const [name, port] of Object.entries(config.ports)) {
    const listening = await probePort(port);
    services[name] = { host: HOST, port, listening };
  }
  const reader = services.reader;
  if (reader?.listening) {
    const tokenInfo = await inspectToken('reader');
    if (tokenInfo.token) {
      const health = await fetchReaderStatus(reader.port, tokenInfo.token);
      reader.health = health.ok
        ? { ok: true, ...health.body }
        : { ok: false, error: health.error };
    } else {
      reader.health = { ok: false, error: 'READER_TOKEN_MISSING' };
    }
  }
  const consoleService = services.console;
  if (consoleService?.listening) {
    const tokenInfo = await inspectToken('console');
    const meta = tokenInfo.token
      ? await fetchConsoleMeta(consoleService.port, tokenInfo.token)
      : { ok: false, error: 'CONSOLE_TOKEN_MISSING' };
    consoleService.health = meta.ok
      ? { ok: true, readerReady: Boolean(meta.body?.reader?.ready) }
      : { ok: false, error: meta.error };
  }
  const bridgeService = services.onebot;
  if (bridgeService?.listening) {
    const tokenInfo = await inspectToken('onebot');
    const health = tokenInfo.token
      ? await fetchBridgeHealth(bridgeService.port, tokenInfo.token)
      : { ok: false, error: 'ONEBOT_TOKEN_MISSING' };
    bridgeService.health = health.ok
      ? {
        ok: true,
        adapterConnected: Boolean(health.body?.connected),
        autoReply: Boolean(health.body?.autoReply),
        modelEnabled: Boolean(health.body?.modelEnabled),
      }
      : { ok: false, error: health.error };
  }
  const adapterService = services.adapter;
  if (adapterService?.listening) {
    const tokenInfo = await inspectToken('adapter');
    const health = tokenInfo.token
      ? await fetchAdapterHealth(adapterService.port, tokenInfo.token)
      : { ok: false, error: 'ADAPTER_TOKEN_MISSING' };
    adapterService.health = health.ok
      ? {
        ok: true,
        bridgeConnected: Boolean(health.body?.bridgeConnected),
        readerConnected: Boolean(health.body?.readerConnected),
        forwarded: Number(health.body?.forwarded ?? 0),
        sent: Number(health.body?.sent ?? 0),
      }
      : { ok: false, error: health.error };
  }
  return {
    generatedAt: new Date().toISOString(),
    projectRoot: PROJECT_ROOT,
    configPath,
    accountDirectory: config.reader.accountDirectory,
    services,
    tokens,
    ready: {
      reader: Boolean(services.reader?.listening && services.reader?.health?.ok),
      bridge: Boolean(services.onebot?.listening && services.onebot?.health?.ok),
      adapter: Boolean(services.adapter?.listening && services.adapter?.health?.ok),
      console: Boolean(services.console?.listening && services.console?.health?.ok),
      allTokensPrivate: Object.values(tokens).every((item) => item.private),
    },
  };
}

/**
 * 人类可读地打印健康检查报告。
 * @param {any} report buildStatusReport() 结果。
 * @returns {void}
 */
function printStatusReport(report) {
  console.log(`WXBOT 状态  (${report.generatedAt})`);
  console.log(`  配置   ${report.configPath}`);
  console.log(`  账号   ${report.accountDirectory || '(未配置，M1 自动探测)'}`);
  console.log('  端口：');
  for (const [name, service] of Object.entries(report.services)) {
    const mark = service.listening ? 'LISTEN' : 'down  ';
    const extra = service.health
      ? `  health=${service.health.ok ? 'ok' : `fail(${service.health.error ?? 'unknown'})`}`
      : '';
    console.log(`    ${name.padEnd(10)} ${service.host}:${String(service.port).padEnd(6)} ${mark}${extra}`);
  }
  console.log('  令牌（state/tokens/*.txt，仅当前用户可读写）：');
  for (const [channel, info] of Object.entries(report.tokens)) {
    console.log(`    ${channel.padEnd(10)} ${info.present ? 'present' : 'missing'}  ${info.private ? 'private' : `NOT_PRIVATE(${info.privateReason ?? '?'})`}`);
  }
  console.log(`  就绪：reader=${report.ready.reader ? 'yes' : 'no'}  bridge=${report.ready.bridge ? 'yes' : 'no'}  adapter=${report.ready.adapter ? 'yes' : 'no'}  console=${report.ready.console ? 'yes' : 'no'}  tokens=${report.ready.allTokensPrivate ? 'ok' : 'weak'}`);
}

/**
 * 入口。
 * @returns {Promise<number>} 退出码。
 */
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const json = rest.includes('--json');
  switch (command) {
    case 'init': {
      const { config, path: configPath, created } = await loadConfig({ createIfMissing: true });
      const tokens = await ensureAllTokens();
      console.log(`配置：${configPath}${created ? '（已由样例生成）' : ''}`);
      console.log(`读取后端：${config.reader.backend}`);
      for (const item of tokens) {
        console.log(`  token ${item.channel.padEnd(10)} ${item.rotated ? 'generated' : 'reused'}  ${item.path}`);
      }
      return 0;
    }
    case 'validate': {
      const { config, path: configPath, created } = await loadConfig({ createIfMissing: true });
      console.log(`配置校验通过：${configPath}${created ? '（已生成）' : ''}`);
      return 0;
    }
    case 'status': {
      const report = await buildStatusReport();
      if (json) console.log(JSON.stringify(report, null, 2));
      else printStatusReport(report);
      return 0;
    }
    case 'token': {
      const channel = rest[0];
      if (!channel || !TOKEN_CHANNELS.includes(channel)) {
        console.error(`用法：node scripts/project-config.mjs token <${TOKEN_CHANNELS.join('|')}>`);
        return 2;
      }
      await ensureAllTokens();
      console.log(tokenPath(channel));
      return 0;
    }
    case 'paths': {
      console.log(`root     ${PROJECT_ROOT}`);
      console.log(`config   ${projectPath('config', 'app.json')}`);
      console.log(`tokens   ${projectPath('state', 'tokens')}`);
      console.log(`logs     ${projectPath('state', 'logs')}`);
      console.log(`keys     ${projectPath('state', 'keys.json')}`);
      console.log(`runtime  ${projectPath('state', 'runtime.json')}`);
      return 0;
    }
    case undefined:
    case '--help':
    case '-h':
      console.log('用法：node scripts/project-config.mjs <init|validate|status|token|paths> [--json]');
      return command === undefined ? 2 : 0;
    default:
      console.error(`未知命令：${command}`);
      return 2;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    if (error instanceof ConfigError) {
      console.error(`[${error.code}] ${error.message}`);
      process.exit(3);
    }
    console.error(error?.stack ?? String(error));
    process.exit(1);
  });
