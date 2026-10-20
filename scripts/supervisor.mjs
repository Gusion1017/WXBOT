#!/usr/bin/env node
/**
 * M7 进程监控 / 崩溃自愈（不含开机自启）。
 *
 * 启动 reader → bridge → adapter → console，并持续健康检查：
 * - 端口/健康失败连续 3 次 → 杀掉进程树并重启（指数退避，上限 30s）
 * - 进程意外退出 → 立即按退避重启
 * - 状态写入 state/supervisor.json（原子写），供 manage.ps1 / 控制台读取
 * - 收到 SIGINT/SIGTERM：按依赖逆序杀整棵进程树后退出
 *
 * 用法：node scripts/supervisor.mjs [--no-http]  # 状态只写文件，不额外开端口
 */
import { spawn, spawnSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { readFile, writeFile, statfs } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { loadConfig } from './lib/core/config.mjs';
import { inspectToken } from './lib/core/tokens.mjs';
import { projectPath, PROJECT_ROOT } from './lib/core/paths.mjs';
import { writeJsonAtomic } from './lib/core/atomic-write.mjs';

const HEALTH_INTERVAL_MS = 5000;
const HEALTH_TIMEOUT_MS = 2500;
const FAILS_BEFORE_RESTART = 3;
const RESTART_BASE_MS = 2000;
const RESTART_MAX_MS = 30_000;
const HEALTHY_RESET_MS = 60_000;
const LOG_RETENTION_DAYS = 7;
const MIN_FREE_BYTES = 1024 * 1024 * 1024;

const { config } = await loadConfig();
const tokens = {};
for (const channel of ['reader', 'onebot', 'adapter', 'console']) {
  const info = await inspectToken(channel);
  tokens[channel] = info.token;
}

const nodeExe = process.execPath;
const runtimePython = path.join(PROJECT_ROOT, 'runtime', 'python', 'python.exe');
const pythonExe = existsSync(runtimePython)
  ? runtimePython
  : path.join(PROJECT_ROOT, '.venv', 'Scripts', 'python.exe');
const startAt = Date.now();

/** 服务定义（按依赖顺序）。 */
const SERVICES = [
  {
    name: 'reader',
    program: pythonExe,
    args: [path.join(PROJECT_ROOT, 'scripts', 'reader-api.py')],
    port: Number(config.ports.reader),
    health: async () => {
      const body = await getJson(Number(config.ports.reader), '/api/v1/reader/status', { authorization: `Bearer ${tokens.reader}` });
      return { ok: body?.ready === true && body?.success !== false, detail: body?.lastError ?? '' };
    },
  },
  {
    name: 'bridge',
    program: nodeExe,
    args: [path.join(PROJECT_ROOT, 'scripts', 'bridge.mjs')],
    port: Number(config.ports.onebot),
    health: async () => {
      const body = await getJson(Number(config.ports.onebot), '/health', { authorization: `Bearer ${tokens.onebot}` });
      return { ok: body?.ok === true, detail: `connected=${body?.connected}` };
    },
  },
  {
    name: 'adapter',
    program: nodeExe,
    args: [path.join(PROJECT_ROOT, 'scripts', 'adapter.mjs')],
    port: Number(config.ports.adapter),
    health: async () => {
      const body = await getJson(Number(config.ports.adapter), '/status', { authorization: `Bearer ${tokens.adapter}` });
      const ok = body?.ok === true && body?.bridgeConnected === true && body?.readerConnected === true;
      return { ok, detail: `bridge=${body?.bridgeConnected} reader=${body?.readerConnected}` };
    },
  },
  {
    name: 'console',
    program: nodeExe,
    args: [path.join(PROJECT_ROOT, 'scripts', 'console-server.mjs')],
    port: Number(config.ports.console),
    health: async () => {
      const body = await getJson(Number(config.ports.console), '/api/meta', { 'x-console-token': tokens.console });
      return { ok: body?.success === true, detail: '' };
    },
  },
];

const state = {
  version: 1,
  supervisorPid: process.pid,
  startedAt: startAt,
  updatedAt: Date.now(),
  shuttingDown: false,
  disk: { freeBytes: null, totalBytes: null, low: false, checkedAt: null },
  services: Object.fromEntries(SERVICES.map((service) => [service.name, {
    name: service.name,
    status: 'starting',
    pid: null,
    restarts: 0,
    consecutiveFailures: 0,
    startedAt: null,
    healthyAt: null,
    lastError: '',
    nextRestartAt: null,
  }])),
};
const children = new Map();
let shuttingDown = false;
const restartTimers = new Map();

mkdirSync(path.join(PROJECT_ROOT, 'state', 'logs'), { recursive: true });

/**
 * 本机 GET JSON（带超时）。
 * @param {number} port 端口。
 * @param {string} apiPath 路径。
 * @param {Record<string,string>} headers 请求头。
 * @returns {Promise<any>} JSON。
 */
function getJson(port, apiPath, headers) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: '127.0.0.1',
      port,
      path: apiPath,
      timeout: HEALTH_TIMEOUT_MS,
      headers,
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error('BAD_JSON'));
        }
      });
      response.on('error', reject);
    });
    request.on('timeout', () => { request.destroy(); reject(new Error('TIMEOUT')); });
    request.on('error', reject);
  });
}

/**
 * 杀整棵进程树（Windows taskkill /T）。
 * @param {number} pid 进程 pid。
 * @param {(event: string, fields?: any) => void} log 日志函数。
 * @returns {void}
 */
function killTree(pid, log) {
  if (!pid) return;
  try {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    killer.on('error', () => {});
  } catch (error) {
    log('supervisor.kill_failed', { pid, type: error?.name });
  }
}

/**
 * 记录日志（stdout/stderr 由 manage.ps1 重定向到文件）。
 * @param {string} event 事件。
 * @param {Record<string, any>} [fields] 字段。
 * @returns {void}
 */
function log(event, fields = {}) {
  console.error(JSON.stringify({ time: new Date().toISOString(), event, ...fields }));
}

/** 原子写状态文件（带重试与直写兜底；Windows 上可能被短暂占用）。 */
async function persistState() {
  state.updatedAt = Date.now();
  const target = projectPath('state', 'supervisor.json');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      await writeJsonAtomic(target, state);
      return;
    } catch (error) {
      if (attempt === 2) {
        log('supervisor.persist_failed', { code: error?.code ?? '', message: error?.message ?? '' });
      } else {
        await new Promise((resolve) => setTimeout(resolve, 120));
      }
    }
  }
  try {
    await writeFile(target, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  } catch (error) {
    log('supervisor.persist_fallback_failed', { code: error?.code ?? '', message: error?.message ?? '' });
  }
}

/**
 * 打开服务日志文件（按天滚动）；Windows 上同名文件被占用时退回时间戳文件名。
 * @param {string} name 服务名。
 * @param {'stdout'|'stderr'} kind 类型。
 * @returns {number} 文件描述符。
 */
function openLogFile(name, kind) {
  const now = new Date();
  const day = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
  const base = path.join(PROJECT_ROOT, 'state', 'logs', `${name}.${kind}.${day}.log`);
  try {
    return openSync(base, 'a');
  } catch (error) {
    log('supervisor.log_open_retry', { file: base, type: error?.code ?? error?.name });
    return openSync(path.join(PROJECT_ROOT, 'state', 'logs', `${name}.${kind}.${Date.now()}.log`), 'a');
  }
}

/**
 * 清理过期日志（按修改时间，保留 LOG_RETENTION_DAYS 天）。
 * @returns {number} 删除数量。
 */
function cleanupOldLogs() {
  const dir = path.join(PROJECT_ROOT, 'state', 'logs');
  let removed = 0;
  try {
    const deadline = Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.log')) continue;
      const file = path.join(dir, name);
      try {
        if (statSync(file).mtimeMs < deadline) {
          unlinkSync(file);
          removed += 1;
        }
      } catch {
        // 占用/不存在时跳过
      }
    }
  } catch {
    // 目录不存在
  }
  return removed;
}

/**
 * 检查磁盘剩余空间（低于阈值记告警）。
 * @returns {Promise<void>} 完成。
 */
async function checkDisk() {
  try {
    const info = await statfs(PROJECT_ROOT);
    const freeBytes = Number(info.bavail) * Number(info.bsize);
    const totalBytes = Number(info.blocks) * Number(info.bsize);
    if (freeBytes > 0 && totalBytes > 0) {
      state.disk = { freeBytes, totalBytes, low: freeBytes < MIN_FREE_BYTES, checkedAt: Date.now(), source: 'statfs' };
      if (state.disk.low) log('supervisor.disk_low', { freeMB: Math.round(freeBytes / 1048576) });
      return;
    }
  } catch {
    // Windows 上 statfs 可能不可用，走 PowerShell 兜底
  }
  try {
    const drive = path.parse(PROJECT_ROOT).root.replace(/\\$/, '');
    const result = spawnSync('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command',
      `$d=Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'"; Write-Output ($d.FreeSpace); Write-Output ($d.Size)`,
    ], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    const [freeLine, totalLine] = String(result.stdout ?? '').trim().split(/\r?\n/);
    const freeBytes = Number(freeLine);
    const totalBytes = Number(totalLine);
    if (Number.isFinite(freeBytes) && freeBytes > 0 && Number.isFinite(totalBytes) && totalBytes > 0) {
      state.disk = { freeBytes, totalBytes, low: freeBytes < MIN_FREE_BYTES, checkedAt: Date.now(), source: 'powershell' };
      if (state.disk.low) log('supervisor.disk_low', { freeMB: Math.round(freeBytes / 1048576) });
      return;
    }
  } catch (error) {
    state.disk = { ...state.disk, checkedAt: Date.now(), source: 'unknown', error: error?.code ?? error?.name };
    return;
  }
  state.disk = { ...state.disk, checkedAt: Date.now(), source: 'unknown' };
}

/**
 * 启动一个服务。
 * @param {any} service 服务定义。
 * @returns {void}
 */
function startService(service) {
  if (shuttingDown) return;
  const record = state.services[service.name];
  if (children.has(service.name)) return;
  const stdoutFd = openLogFile(service.name, 'stdout');
  const stderrFd = openLogFile(service.name, 'stderr');
  let child;
  try {
    child = spawn(service.program, service.args, {
      cwd: PROJECT_ROOT,
      windowsHide: true,
      stdio: ['ignore', stdoutFd, stderrFd],
    });
  } catch (error) {
    closeSync(stdoutFd);
    closeSync(stderrFd);
    record.status = 'failed';
    record.lastError = `SPAWN_FAILED:${error?.message ?? error}`;
    log('supervisor.spawn_failed', { service: service.name, message: String(error?.message ?? error) });
    scheduleRestart(service);
    return;
  }
  // 父进程不再持有日志句柄（子进程已继承）
  try { closeSync(stdoutFd); } catch { /* ignore */ }
  try { closeSync(stderrFd); } catch { /* ignore */ }
  children.set(service.name, child);
  record.pid = child.pid;
  record.status = 'running';
  record.startedAt = Date.now();
  record.lastError = '';
  record.nextRestartAt = null;
  log('supervisor.spawned', { service: service.name, pid: child.pid });
  child.on('exit', (code, signal) => {
    children.delete(service.name);
    const uptime = Date.now() - Number(record.startedAt ?? Date.now());
    if (uptime > HEALTHY_RESET_MS) record.restarts = 0;
    record.pid = null;
    if (shuttingDown) {
      record.status = 'stopped';
      void persistState();
      return;
    }
    record.status = 'crashed';
    record.lastError = `EXIT code=${code ?? ''} signal=${signal ?? ''}`;
    log('supervisor.exited', { service: service.name, code, signal });
    void persistState();
    scheduleRestart(service);
  });
  void persistState();
}

/**
 * 安排重启（指数退避）。
 * @param {any} service 服务定义。
 * @returns {void}
 */
function scheduleRestart(service) {
  const record = state.services[service.name];
  if (shuttingDown || restartTimers.has(service.name)) return;
  record.restarts = Number(record.restarts ?? 0) + 1;
  const delay = Math.min(RESTART_MAX_MS, RESTART_BASE_MS * 2 ** Math.max(0, record.restarts - 1));
  record.nextRestartAt = Date.now() + delay;
  log('supervisor.restart_scheduled', { service: service.name, delayMs: delay, restarts: record.restarts });
  const timer = setTimeout(() => {
    restartTimers.delete(service.name);
    if (!shuttingDown) startService(service);
  }, delay);
  if (typeof timer.unref === 'function') timer.unref();
  restartTimers.set(service.name, timer);
  void persistState();
}

/**
 * 健康检查一轮。
 * @returns {Promise<void>} 完成。
 */
async function healthRound() {
  if (shuttingDown) return;
  for (const service of SERVICES) {
    const record = state.services[service.name];
    if (!children.has(service.name)) continue;
    let result = { ok: false, detail: 'HEALTH_FAILED' };
    try {
      result = await service.health();
    } catch (error) {
      result = { ok: false, detail: error?.message ?? 'HEALTH_ERROR' };
    }
    if (result.ok) {
      record.consecutiveFailures = 0;
      record.healthyAt = Date.now();
      record.status = 'healthy';
      record.lastError = '';
    } else {
      record.consecutiveFailures = Number(record.consecutiveFailures ?? 0) + 1;
      record.status = 'unhealthy';
      record.lastError = result.detail || 'HEALTH_FAILED';
      log('supervisor.unhealthy', { service: service.name, fails: record.consecutiveFailures, detail: record.lastError });
      if (record.consecutiveFailures >= FAILS_BEFORE_RESTART) {
        log('supervisor.restarting_unhealthy', { service: service.name, pid: record.pid });
        record.consecutiveFailures = 0;
        killTree(record.pid, log);
        children.delete(service.name);
        record.pid = null;
        scheduleRestart(service);
      }
    }
  }
  await persistState();
}

/**
 * 按依赖顺序启动服务并等待健康。
 * @param {number} timeoutMs 等待上限。
 * @returns {Promise<void>} 完成。
 */
async function bootServices(timeoutMs = 45_000) {
  for (const service of SERVICES) {
    startService(service);
  }
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let allHealthy = true;
    for (const service of SERVICES) {
      const record = state.services[service.name];
      if (record.status === 'healthy') continue;
      try {
        const result = await service.health();
        if (result.ok) {
          record.status = 'healthy';
          record.healthyAt = Date.now();
          record.consecutiveFailures = 0;
          record.lastError = '';
        } else {
          allHealthy = false;
          record.lastError = result.detail || 'HEALTH_FAILED';
          log('supervisor.boot_unhealthy', { service: service.name, detail: record.lastError });
        }
      } catch (error) {
        allHealthy = false;
        record.lastError = error?.message ?? 'HEALTH_ERROR';
        log('supervisor.boot_unhealthy', { service: service.name, detail: record.lastError });
      }
    }
    if (allHealthy) {
      log('supervisor.boot_healthy');
      await persistState();
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  await persistState();
  log('supervisor.boot_timeout', { timedOut: SERVICES.filter((s) => state.services[s.name].status !== 'healthy').map((s) => s.name) });
}

/** 优雅停止。 */
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  state.shuttingDown = true;
  await persistState();
  for (const timer of restartTimers.values()) clearTimeout(timer);
  restartTimers.clear();
  for (const service of [...SERVICES].reverse()) {
    const record = state.services[service.name];
    if (record.pid) {
      log('supervisor.stopping', { service: service.name, pid: record.pid });
      killTree(record.pid, log);
      record.status = 'stopped';
      record.pid = null;
    }
  }
  await persistState();
  // 给 taskkill 一点时间
  await new Promise((resolve) => setTimeout(resolve, 300));
  process.exit(0);
}

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('uncaughtException', (error) => log('supervisor.uncaught', { type: error?.name, message: error?.message }));
process.on('unhandledRejection', (error) => log('supervisor.unhandled_rejection', { message: String(error?.message ?? error) }));

log('supervisor.starting', { pid: process.pid, services: SERVICES.map((service) => service.name) });
await bootServices();
const removedLogs = cleanupOldLogs();
log('supervisor.log_retention', { removed: removedLogs });
await checkDisk();
setInterval(() => { void healthRound(); }, HEALTH_INTERVAL_MS).unref?.();
setInterval(() => { void persistState(); }, 15_000).unref?.();
setInterval(() => {
  const removed = cleanupOldLogs();
  if (removed) log('supervisor.log_retention', { removed });
}, 6 * 60 * 60 * 1000).unref?.();
setInterval(() => { void checkDisk(); }, 60_000).unref?.();
console.log(JSON.stringify({ ok: true, supervisorPid: process.pid, statusFile: projectPath('state', 'supervisor.json') }));
