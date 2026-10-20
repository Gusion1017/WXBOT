#!/usr/bin/env node
/**
 * 开发自检：验证 SSE 推送通道（M2）。
 *
 * 用法：node scripts/dev-sse-check.mjs
 * 做法：连上 /api/v1/push/messages，然后对一条已有消息 POST /api/v1/events/retry，
 *       断言 10s 内收到对应 data 事件；不打印聊天正文。
 * 说明：用 node:http 而不是 fetch/undici，避免中止流后进程句柄不释放的问题。
 */
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { projectPath } from './lib/paths.mjs';

const HOST = '127.0.0.1';
const TIMEOUT_MS = 10_000;

/**
 * 读取配置与 reader token。
 * @returns {Promise<{ port: number, token: string }>}
 */
async function loadSettings() {
  const config = JSON.parse(await readFile(projectPath('config', 'app.json'), 'utf8'));
  const token = (await readFile(projectPath('state', 'tokens', 'reader.txt'), 'utf8')).trim();
  if (!/^[0-9a-f]{64}$/.test(token)) throw new Error('reader token 无效');
  return { port: config.ports.reader, token };
}

/**
 * 发一个 JSON 请求。
 * @param {{ port: number, token: string }} settings 服务信息。
 * @param {string} path 路径。
 * @param {{ method?: string, body?: string }} [options] 选项。
 * @returns {Promise<any>} 解析后的 JSON。
 */
function requestJson(settings, path, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request({
      host: HOST,
      port: settings.port,
      path,
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${settings.token}`,
        ...(options.body
          ? {
            'content-type': 'application/json',
            'content-length': Buffer.byteLength(options.body),
          }
          : {}),
      },
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch (error) {
          reject(new Error(`响应不是 JSON：${error.message}`));
        }
      });
    });
    request.on('error', reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

/**
 * 主流程。
 * @returns {Promise<number>} 退出码。
 */
async function main() {
  const settings = await loadSettings();
  const sessions = await requestJson(settings, '/api/v1/sessions?limit=10');
  const talker = (sessions.sessions || []).map((item) => item.talker)[0];
  if (!talker) throw new Error('没有会话可用于测试');
  const listed = await requestJson(
    settings,
    `/api/v1/messages?talker=${encodeURIComponent(talker)}&limit=10`,
  );
  const candidate = (listed.messages || []).find((message) => !message.isSend);
  if (!candidate) throw new Error('没有可重推的入站消息');
  console.log(`SSE test: talker=${talker.slice(0, 6)}*** localId=${candidate.localId}`);

  return new Promise((resolve, reject) => {
    let settled = false;
    let heartbeat = false;
    const timer = setTimeout(() => finish(new Error('10s 内未收到 SSE 事件')), TIMEOUT_MS);

    /**
     * 结束测试。
     * @param {Error|null} error 失败原因。
     */
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      if (error) reject(error);
      else resolve(0);
    }

    const request = http.get({
      host: HOST,
      port: settings.port,
      path: '/api/v1/push/messages',
      headers: { authorization: `Bearer ${settings.token}` },
    }, (response) => {
      if (response.statusCode !== 200) {
        finish(new Error(`SSE 连接失败：HTTP ${response.statusCode}`));
        return;
      }
      let buffer = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => {
        buffer += chunk;
        if (buffer.includes(': heartbeat')) heartbeat = true;
        const blocks = buffer.split('\n\n');
        buffer = blocks.pop() ?? '';
        for (const block of blocks) {
          for (const line of block.split('\n')) {
            if (!line.startsWith('data: ')) continue;
            let event;
            try {
              event = JSON.parse(line.slice('data: '.length));
            } catch {
              continue;
            }
            if (event.rawid !== candidate.rawid) continue;
            console.log(JSON.stringify({
              ok: true,
              event: event.event,
              sessionType: event.sessionType,
              type: event.type,
              contentLength: String(event.content || '').length,
              hasQuote: Boolean(event.quoteReply),
              hasForward: Boolean(event.forwardedRecord),
              heartbeatSeen: heartbeat,
            }));
            finish(null);
            return;
          }
        }
      });
      response.on('error', (error) => finish(error));
    });
    request.on('error', (error) => finish(error));

    // SSE 连上后再触发一次显式重推
    setTimeout(async () => {
      try {
        const retry = await requestJson(settings, '/api/v1/events/retry', {
          method: 'POST',
          body: JSON.stringify({
            talker,
            localId: candidate.localId,
            createTime: candidate.createTime,
          }),
        });
        console.log(`retry pushed=${retry.pushed}`);
        if (!retry.pushed) finish(new Error('重推返回 pushed=false（事件已被推过？）'));
      } catch (error) {
        finish(error);
      }
    }, 300);
  });
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(`SSE_CHECK_FAILED: ${error.message}`);
    process.exit(1);
  });
