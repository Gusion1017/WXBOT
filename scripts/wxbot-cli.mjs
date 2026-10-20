#!/usr/bin/env node
/**
 * WXBOT 只读 CLI（M3）：状态 / 会话 / 联系人 / 消息 / 图片落盘。
 *
 * 用法：
 *   node scripts/wxbot-cli.mjs status
 *   node scripts/wxbot-cli.mjs sessions [--limit 20]
 *   node scripts/wxbot-cli.mjs contacts [--keyword 关键字] [--kind group|private]
 *   node scripts/wxbot-cli.mjs messages --talker <wxid|群号> [--limit 20]
 *   node scripts/wxbot-cli.mjs images --talker <wxid|群号> [--limit 3] [--out state/media/cli]
 *   node scripts/wxbot-cli.mjs keys
 *
 * 说明：CLI 直接读本机 reader API，token 不落日志；图片按图片 id 解密后保存到本地文件。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { projectPath } from './lib/core/paths.mjs';

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

/**
 * 发 GET 请求并解析 JSON。
 * @param {{ port: number, token: string }} settings 服务信息。
 * @param {string} apiPath 路径（含 query）。
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

/**
 * 解析 `--key value` 形式的参数。
 * @param {string[]} argv 参数列表。
 * @returns {Record<string, string>} 参数字典。
 */
function parseOptions(argv) {
  /** @type {Record<string, string>} */
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      options[key] = 'true';
    } else {
      options[key] = next;
      index += 1;
    }
  }
  return options;
}

/**
 * 格式化时间戳。
 * @param {number} seconds unix 秒。
 * @returns {string} 本地时间字符串。
 */
function formatTime(seconds) {
  if (!seconds) return '-';
  return new Date(seconds * 1000).toLocaleString('zh-CN', { hour12: false });
}

/**
 * 打印表格（简单对齐）。
 * @param {string[]} headers 表头。
 * @param {Array<Array<string|number>>} rows 行。
 * @returns {void}
 */
function printTable(headers, rows) {
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...rows.map((row) => String(row[index] ?? '').length),
  ));
  const line = (cells) => cells.map((cell, index) => String(cell ?? '').padEnd(widths[index])).join('  ');
  console.log(line(headers));
  console.log(widths.map((width) => '-'.repeat(width)).join('  '));
  for (const row of rows) console.log(line(row));
}

/**
 * 截断长文本（CLI 展示用）。
 * @param {string} text 文本。
 * @param {number} limit 上限。
 * @returns {string} 截断结果。
 */
function clip(text, limit = 60) {
  const value = String(text ?? '');
  return value.length <= limit ? value : `${value.slice(0, limit)}…`;
}

/** 主入口。 */
async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const options = parseOptions(rest);
  const settings = await loadSettings();
  const limit = Math.max(1, Math.min(200, Number(options.limit ?? 20) || 20));

  switch (command) {
    case 'status': {
      const status = await getJson(settings, '/api/v1/reader/status');
      const ports = JSON.parse(await readFile(projectPath('config', 'app.json'), 'utf8')).ports;
      console.log(`读取层：${status.ready ? '就绪' : '未就绪'}  backend=${status.backend}  账号=${status.accountDirectory}`);
      console.log(`端口：reader=${ports.reader}  订阅者=${status.subscribers}  已推送=${status.pushed}  图片已登记=${status.imagesRegistered}`);
      console.log(`分片：${(status.shards || []).map((item) => `${item.name}${item.opened ? '✔' : `✘(${item.reason})`}`).join(' ')}`);
      if (status.lastError) console.log(`最近错误：${status.lastError}`);
      if (status.lastImageError) console.log(`图片错误：${status.lastImageError}  密钥来源=${status.imageKeySource || '-'}`);
      return 0;
    }
    case 'sessions': {
      const data = await getJson(settings, `/api/v1/sessions?limit=${limit}`);
      printTable(
        ['会话', '类型', '未读', '最后消息时间', '最后消息类型'],
        (data.sessions || []).map((item) => [
          clip(item.displayName, 30), item.sessionType, item.unreadCount,
          formatTime(item.lastTimestamp), item.lastMsgType,
        ]),
      );
      return 0;
    }
    case 'contacts': {
      const params = new URLSearchParams({ limit: String(limit) });
      if (options.keyword) params.set('keyword', options.keyword);
      if (options.kind) params.set('kind', options.kind);
      const data = await getJson(settings, `/api/v1/contacts?${params}`);
      printTable(
        ['用户名', '显示名', '类型', '同名群'],
        (data.contacts || []).map((item) => [
          clip(item.username, 32), clip(item.displayName, 24), item.kind, item.ambiguous ? '是' : '',
        ]),
      );
      return 0;
    }
    case 'messages': {
      if (!options.talker) {
        console.error('用法：node scripts/wxbot-cli.mjs messages --talker <wxid|群号> [--limit 20]');
        return 2;
      }
      const data = await getJson(
        settings,
        `/api/v1/messages?talker=${encodeURIComponent(options.talker)}&limit=${limit}`,
      );
      printTable(
        ['时间', '方向', '发送者', '类型', '内容'],
        (data.messages || []).map((item) => [
          formatTime(item.createTime),
          item.isSend ? '我→' : '←我',
          clip(item.senderDisplay || item.senderUsername, 16),
          clip(item.typeText, 10),
          clip(item.content, 50),
        ]),
      );
      return 0;
    }
    case 'images': {
      if (!options.talker) {
        console.error('用法：node scripts/wxbot-cli.mjs images --talker <wxid|群号> [--limit 3] [--out 目录]');
        return 2;
      }
      const outDir = path.resolve(
        projectPath(),
        options.out || path.join('state', 'media', 'cli'),
      );
      await mkdir(outDir, { recursive: true });
      const data = await getJson(
        settings,
        `/api/v1/messages?talker=${encodeURIComponent(options.talker)}&limit=100`,
      );
      const images = (data.messages || []).filter((item) => item.baseType === 3 || item.baseType === 47);
      if (!images.length) {
        console.log('该会话最近 100 条里没有图片/表情消息');
        return 0;
      }
      let saved = 0;
      for (const message of images.slice(0, limit)) {
        const descriptor = message.image || {};
        const imageId = descriptor.id;
        if (!imageId) {
          console.log(`localId=${message.localId} 未登记 image id（早于 reader 启动的图片）`);
          continue;
        }
        const image = await getJson(settings, `/api/v1/images/${imageId}`);
        if (!image.success) {
          console.log(`localId=${message.localId} 解密失败：${image.error}`);
          continue;
        }
        const extension = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' }[image.mime] || '.bin';
        const file = path.join(outDir, `${imageId}${extension}`);
        await writeFile(file, Buffer.from(image.b64, 'base64'));
        saved += 1;
        console.log(`已保存：${file}  (${image.mime}, ${image.bytes} bytes)`);
      }
      console.log(`完成：保存 ${saved} 张到 ${outDir}`);
      return saved > 0 ? 0 : 1;
    }
    case 'keys': {
      const status = await getJson(settings, '/api/v1/reader/status');
      const current = status.keys?.current ?? {};
      printTable(['字段', '值'], [
        ['当前账号', status.accountDirectory],
        ['密钥状态', current.verified ? '有效（HMAC 通过）' : `异常 ${current.error ?? 'unknown'}`],
        ['密钥来源', current.keySource ?? ''],
        ['读取层就绪', status.ready ? '是' : '否'],
      ]);
      printTable(
        ['账号目录', '数据库', '捕获时间', '来源', '当前'],
        (status.keys?.accounts ?? []).map((item) => [
          clip(item.accountDirectory, 34),
          item.dbExists ? '有' : '缺',
          item.capturedAt ? String(item.capturedAt).slice(0, 19) : '',
          clip(item.keySource, 16),
          item.active ? '★' : '',
        ]),
      );
      if (!current.verified) {
        console.log(`提示：${current.hint ?? '运行 npm run key:inspect 诊断'}`);
      }
      return current.verified ? 0 : 1;
    }
    default:
      console.log('用法：node scripts/wxbot-cli.mjs <status|sessions|contacts|messages|images|keys> [选项]');
      return command === undefined ? 2 : 0;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((error) => {
    console.error(`CLI_FAILED: ${error.message}`);
    process.exit(1);
  });
