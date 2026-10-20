#!/usr/bin/env node
/**
 * 开发自检：图片解密（M3）。
 *
 * 用法：node scripts/dev-media-check.mjs
 * 做法：找一个含图片的会话 → 取最近一张图片消息 → GET /api/v1/images/<id>，
 *       断言解密成功并已落到本地文件；不打印聊天正文。
 */
import { readFile, stat } from 'node:fs/promises';
import http from 'node:http';
import { projectPath } from './lib/paths.mjs';

const HOST = '127.0.0.1';

/**
 * 发 GET 请求并解析 JSON。
 * @param {{ port: number, token: string }} settings 服务信息。
 * @param {string} apiPath 路径。
 * @returns {Promise<any>} JSON。
 */
function getJson(settings, apiPath) {
  return new Promise((resolve, reject) => {
    const request = http.get({
      host: HOST,
      port: settings.port,
      path: apiPath,
      headers: { authorization: `Bearer ${settings.token}` },
    }, (response) => {
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', (chunk) => { raw += chunk; });
      response.on('end', () => {
        try {
          resolve(JSON.parse(raw));
        } catch {
          reject(new Error(`HTTP ${response.statusCode}：响应不是 JSON`));
        }
      });
    });
    request.on('error', reject);
  });
}

const config = JSON.parse(await readFile(projectPath('config', 'app.json'), 'utf8'));
const token = (await readFile(projectPath('state', 'tokens', 'reader.txt'), 'utf8')).trim();
const settings = { port: config.ports.reader, token };

const status = await getJson(settings, '/api/v1/reader/status');
console.log(JSON.stringify({
  ready: status.ready,
  imagesRegistered: status.imagesRegistered,
  imageKeySource: status.imageKeySource,
  lastImageError: status.lastImageError,
}));

const sessions = await getJson(settings, '/api/v1/sessions?limit=20');
let found = null;
for (const session of sessions.sessions || []) {
  const listed = await getJson(
    settings,
    `/api/v1/messages?talker=${encodeURIComponent(session.talker)}&limit=100`,
  );
  // 只看普通图片（type=3）；表情（47）的本地文件命名不同，单独处理。
  const image = (listed.messages || []).find((message) => message.baseType === 3 && message.image?.id);
  if (image) {
    found = { session, image };
    break;
  }
}
if (!found) {
  console.log('MEDIA_CHECK_SKIPPED: 没有可用的图片消息');
  process.exit(0);
}
const { image } = found;
const resolved = await getJson(settings, `/api/v1/images/${image.image.id}`);
if (!resolved.success) {
  console.log(`MEDIA_CHECK_FAILED: ${resolved.error}`);
  process.exit(1);
}
const info = await stat(resolved.savedFile);
console.log(JSON.stringify({
  ok: true,
  mime: resolved.mime,
  bytes: resolved.bytes,
  savedFile: resolved.savedFile,
  savedBytes: info.size,
  keySource: resolved.keySource,
}));
