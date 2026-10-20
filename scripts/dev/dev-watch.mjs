#!/usr/bin/env node
/**
 * 开发自检：实时监听 SSE 推送（用于 M2 真机验收）。
 *
 * 用法：node scripts/dev-watch.mjs [等待秒数]
 * 输出：每个事件的接收时间、类型、内容长度与延迟（不打印聊天正文）。
 */
import { readFile } from 'node:fs/promises';
import http from 'node:http';
import { projectPath } from './lib/paths.mjs';

const HOST = '127.0.0.1';

/**
 * 读取配置与 reader token。
 * @returns {Promise<{ port: number, token: string }>}
 */
async function loadSettings() {
  const config = JSON.parse(await readFile(projectPath('config', 'app.json'), 'utf8'));
  const token = (await readFile(projectPath('state', 'tokens', 'reader.txt'), 'utf8')).trim();
  return { port: config.ports.reader, token };
}

const waitSeconds = Number(process.argv[2] ?? 120);
const settings = await loadSettings();
const deadline = Date.now() + waitSeconds * 1000;
console.log(`watching SSE ${waitSeconds}s on 127.0.0.1:${settings.port}`);

const request = http.get({
  host: HOST,
  port: settings.port,
  path: '/api/v1/push/messages',
  headers: { authorization: `Bearer ${settings.token}` },
}, (response) => {
  let buffer = '';
  response.setEncoding('utf8');
  response.on('data', (chunk) => {
    buffer += chunk;
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
        const receivedAt = Math.floor(Date.now() / 1000);
        const latency = typeof event.timestamp === 'number' ? receivedAt - event.timestamp : null;
        console.log(JSON.stringify({
          at: new Date().toISOString(),
          event: event.event,
          sessionType: event.sessionType,
          type: event.type,
          contentLength: String(event.content || '').length,
          placeholder: String(event.content || '').startsWith('['),
          hasQuote: Boolean(event.quoteReply),
          hasForward: Boolean(event.forwardedRecord),
          latencySec: latency,
        }));
      }
    }
  });
  response.on('end', () => {
    console.log('stream ended');
    process.exit(0);
  });
});
request.on('error', (error) => {
  console.error(`WATCH_FAILED: ${error.message}`);
  process.exit(1);
});
setTimeout(() => {
  request.destroy();
  console.log('watch finished');
  process.exit(0);
}, Math.max(5000, waitSeconds * 1000));
