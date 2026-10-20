#!/usr/bin/env node
/**
 * 稳定性 soak 采样（M7）：每 N 秒记录一次 supervisor/服务/日志/磁盘/回执状态。
 *
 * 用法：
 *   node scripts/dev/dev-soak.mjs [--minutes 10] [--interval 30] [--out state/soak.jsonl]
 * 输出：逐样本 JSONL 追加 + 结束时打印汇总（重启次数、内存峰值、日志增长、磁盘最低值）。
 */
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { projectPath } from '../lib/paths.mjs';

/**
 * 解析参数。
 * @returns {{ minutes: number, intervalSec: number, out: string }} 参数。
 */
function parseArgs() {
  const args = process.argv.slice(2);
  const read = (name, fallback) => {
    const index = args.indexOf(`--${name}`);
    return index >= 0 && args[index + 1] ? Number(args[index + 1]) : fallback;
  };
  const outIndex = args.indexOf('--out');
  return {
    minutes: Math.max(1, read('minutes', 10)),
    intervalSec: Math.max(5, read('interval', 30)),
    out: outIndex >= 0 ? args[outIndex + 1] : projectPath('state', 'soak.jsonl'),
  };
}

/**
 * 读 supervisor 状态。
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
 * 统计日志目录大小。
 * @returns {Promise<{ bytes: number, files: number }>} 统计。
 */
async function logUsage() {
  const dir = projectPath('state', 'logs');
  let bytes = 0;
  let files = 0;
  try {
    for (const name of await readdir(dir)) {
      try {
        const info = await stat(path.join(dir, name));
        bytes += info.size;
        files += 1;
      } catch { /* 忽略 */ }
    }
  } catch { /* 目录不存在 */ }
  return { bytes, files };
}

/**
 * 统计发送回执数量。
 * @returns {Promise<Record<string, number>>} 各状态计数。
 */
async function deliveryCounts() {
  const counts = { dispatching: 0, accepted: 0, confirmed: 0, unconfirmed: 0, rejected: 0 };
  try {
    const dir = projectPath('state', 'text-deliveries');
    for (const name of await readdir(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const record = JSON.parse(await readFile(path.join(dir, name), 'utf8'));
        counts[record.state] = (counts[record.state] ?? 0) + 1;
      } catch { /* 忽略 */ }
    }
  } catch { /* 目录不存在 */ }
  return counts;
}

/**
 * 取进程内存（WorkingSet，KB）。
 * @param {number[]} pids 进程 id 列表。
 * @returns {Record<string, number>} pid → KB。
 */
function processMemory(pids) {
  const memory = {};
  if (!pids.length) return memory;
  const result = spawnSync('tasklist.exe', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  for (const line of String(result.stdout ?? '').split(/\r?\n/)) {
    const parts = line.trim().split('","').map((item) => item.replace(/^"|"$/g, ''));
    if (parts.length < 5) continue;
    const pid = Number(parts[1]);
    if (!pids.includes(pid)) continue;
    const kb = Number(String(parts[4]).replace(/[^\d]/g, ''));
    if (Number.isFinite(kb)) memory[pid] = kb;
  }
  return memory;
}

const options = parseArgs();
const deadline = Date.now() + options.minutes * 60_000;
const samples = [];
const baselineRestarts = {};
await mkdir(path.dirname(options.out), { recursive: true });
console.log(JSON.stringify({ ok: true, startedAt: new Date().toISOString(), minutes: options.minutes, intervalSec: options.intervalSec, out: options.out }));

while (Date.now() < deadline) {
  const supervisor = await readSupervisor();
  const logs = await logUsage();
  const deliveries = await deliveryCounts();
  const services = supervisor?.services ?? {};
  const pids = Object.values(services).map((service) => Number(service.pid)).filter((pid) => Number.isFinite(pid) && pid > 0);
  const memory = processMemory(pids);
  const restarts = Object.fromEntries(Object.entries(services).map(([name, service]) => {
    if (baselineRestarts[name] === undefined) baselineRestarts[name] = Number(service.restarts ?? 0);
    return [name, Number(service.restarts ?? 0) - baselineRestarts[name]];
  }));
  const sample = {
    at: Date.now(),
    services: Object.fromEntries(Object.entries(services).map(([name, service]) => [name, {
      status: service.status ?? 'unknown',
      restarts: Number(service.restarts ?? 0),
      failures: Number(service.consecutiveFailures ?? 0),
    }])),
    restartDelta: restarts,
    memoryKB: memory,
    totalRssMB: Math.round(Object.values(memory).reduce((sum, kb) => sum + kb, 0) / 1024),
    logBytes: logs.bytes,
    logFiles: logs.files,
    diskFreeMB: supervisor?.disk?.freeBytes ? Math.round(supervisor.disk.freeBytes / 1048576) : null,
    deliveries,
  };
  samples.push(sample);
  await appendFile(options.out, `${JSON.stringify(sample)}\n`, 'utf8');
  const unhealthy = Object.values(sample.services).filter((service) => service.status !== 'healthy').length;
  console.log(JSON.stringify({
    at: new Date(sample.at).toISOString(),
    unhealthy,
    rssMB: sample.totalRssMB,
    logMB: Number((sample.logBytes / 1048576).toFixed(2)),
    diskFreeMB: sample.diskFreeMB,
    confirmed: deliveries.confirmed,
    restarts: Object.values(restarts).reduce((sum, value) => sum + value, 0),
  }));
  const wait = Math.min(options.intervalSec * 1000, Math.max(0, deadline - Date.now()));
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
}

const summary = {
  ok: true,
  samples: samples.length,
  durationMinutes: options.minutes,
  unhealthySamples: samples.filter((sample) => Object.values(sample.services).some((service) => service.status !== 'healthy')).length,
  totalRestartDelta: samples.length
    ? Object.values(samples[samples.length - 1].restartDelta).reduce((sum, value) => sum + value, 0)
    : 0,
  maxTotalRssMB: Math.max(0, ...samples.map((sample) => sample.totalRssMB)),
  logGrowthBytes: samples.length ? samples[samples.length - 1].logBytes - samples[0].logBytes : 0,
  minDiskFreeMB: Math.min(...samples.map((sample) => sample.diskFreeMB ?? Infinity)),
  deliveries: samples.length ? samples[samples.length - 1].deliveries : {},
  out: options.out,
};
console.log(`SOAK_SUMMARY ${JSON.stringify(summary)}`);
