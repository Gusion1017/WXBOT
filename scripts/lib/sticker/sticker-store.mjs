/**
 * 原生表情包存储：catalog.json + 本地 GIF 库 + Hook outgoing 暂存。
 *
 * Hook 的 `/SendStickerMsg` 只接受：
 * - `state/stickers/outgoing/<md5>.gif`
 * - 文件为 GIF/PNG/WEBP/JPG 魔数，文件名等于 MD5，≤8MB
 * - 请求体 `{ wxidorgid, sticker: {md5, productid, len, type, width, height}, path }`
 *
 * 本项目把「主文件」放在项目内 `state/stickers/library/<md5>.gif`，
 * 发送前再复制到 Hook 计算出的 outgoing 目录（兼容不同安装层级）。
 */
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectPath } from '../core/paths.mjs';
import { matchStickerOccasions } from './sticker-policy.mjs';

const CATALOG_VERSION = 1;
const MAX_STICKER_BYTES = 8 * 1024 * 1024;
const GIF_MAGIC = [Buffer.from('GIF87a'), Buffer.from('GIF89a')];

/**
 * 计算 Hook 认的 outgoing 目录。
 * Hook 内部从 Weixin.exe 路径向上 4 级再拼 `state/stickers/outgoing`；
 * 对可执行文件所在目录等价于向上 3 级。
 * @param {any} config 应用配置。
 * @param {string} [root] 项目根。
 * @returns {{ root: string, outgoing: string, library: string, catalog: string }} 路径。
 */
export function stickerPaths(config, root = projectPath()) {
  const exeValue = String(config?.hook?.wechatExecutable ?? 'state/wechat-hook-client/Weixin.exe');
  const exe = path.isAbsolute(exeValue) ? exeValue : path.join(root, exeValue);
  const exeDir = path.dirname(exe);
  const hookRoot = path.resolve(exeDir, '..', '..', '..');
  return {
    root,
    outgoing: path.join(hookRoot, 'state', 'stickers', 'outgoing'),
    library: path.join(root, 'state', 'stickers', 'library'),
    catalog: path.join(root, 'state', 'stickers', 'catalog.json'),
  };
}

/**
 * 校验 GIF 字节；返回错误码或 null。
 * @param {Buffer} raw 文件内容。
 * @returns {string|null} 错误码。
 */
export function validateGifBytes(raw) {
  if (!Buffer.isBuffer(raw) || raw.length === 0) return 'STICKER_FILE_EMPTY';
  if (raw.length > MAX_STICKER_BYTES) return 'STICKER_FILE_TOO_LARGE';
  if (!GIF_MAGIC.some((magic) => raw.subarray(0, magic.length).equals(magic))) return 'STICKER_NOT_GIF';
  return null;
}

/**
 * MD5（Hook 要求）。
 * @param {Buffer} raw 文件内容。
 * @returns {string} 小写 hex。
 */
export function md5Hex(raw) {
  return createHash('md5').update(raw).digest('hex');
}

/** 原生表情存储。 */
export class StickerStore {
  /**
   * @param {object} options 选项。
   * @param {any} options.config 应用配置。
   * @param {string} [options.root] 项目根。
   * @param {(...args: any[]) => any} [options.log] 日志函数。
   * @param {() => number} [options.now] 时间源。
   */
  constructor(options) {
    this.config = options.config;
    this.paths = stickerPaths(this.config, options.root ?? projectPath());
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.catalog = { version: CATALOG_VERSION, stickers: [] };
    this.loadedMtime = -1;
    this.enabled = options.config?.sticker?.enabled !== false;
    this.maxStickers = Math.max(1, Number(options.config?.sticker?.maxStickers ?? 50));
  }

  /**
   * 应用最新配置（设置页保存后无需重启）。
   * @param {any} config 应用配置。
   * @returns {void}
   */
  applyConfig(config) {
    this.config = config;
    this.enabled = config?.sticker?.enabled !== false;
    this.maxStickers = Math.max(1, Number(config?.sticker?.maxStickers ?? 50));
  }

  /**
   * 读取 catalog；缺失或损坏时返回空目录。
   * @returns {Promise<any>} catalog。
   */
  async load() {
    try {
      const raw = await readFile(this.paths.catalog, 'utf8');
      const parsed = JSON.parse(raw);
      const stickers = Array.isArray(parsed?.stickers) ? parsed.stickers : [];
      this.catalog = {
        version: CATALOG_VERSION,
        stickers: stickers.filter((item) => item && typeof item.id === 'string'
          && typeof item.name === 'string'
          && typeof item.md5 === 'string'
          && typeof item.file === 'string'),
      };
    } catch {
      this.catalog = { version: CATALOG_VERSION, stickers: [] };
    }
    return this.catalog;
  }

  /**
   * 按 mtime 刷新 catalog；设置页新增/删除后无需重启即可生效。
   * @returns {Promise<any>} catalog。
   */
  async refresh() {
    try {
      const info = await stat(this.paths.catalog);
      if (info.mtimeMs !== this.loadedMtime) {
        this.loadedMtime = info.mtimeMs;
        await this.load();
      }
    } catch {
      if (this.loadedMtime !== 0) {
        this.loadedMtime = 0;
        this.catalog = { version: CATALOG_VERSION, stickers: [] };
      }
    }
    return this.catalog;
  }

  /**
   * 保存 catalog（原子写）。
   * @param {any} catalog 目录。
   * @returns {Promise<void>} 完成。
   */
  async save(catalog) {
    await mkdir(path.dirname(this.paths.catalog), { recursive: true });
    const data = { version: CATALOG_VERSION, stickers: (catalog?.stickers ?? []).slice(0, this.maxStickers) };
    const temp = `${this.paths.catalog}.${process.pid}.tmp`;
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    await rename(temp, this.paths.catalog);
    this.catalog = data;
    this.loadedMtime = (await stat(this.paths.catalog)).mtimeMs;
  }

  /** 启用且可用的表情列表。 */
  getEnabled() {
    return this.catalog.stickers.filter((item) => item.enabled !== false);
  }

  /**
   * 按 id 查找。
   * @param {string} id 表情 id。
   * @returns {any|null} 条目。
   */
  find(id) {
    const value = String(id ?? '');
    return this.catalog.stickers.find((item) => item.id === value) ?? null;
  }

  /**
   * 匹配对话中出现的“适合发送的时机”关键词。
   * @param {Array<{text?: string}>} messages 当前批次消息。
   * @returns {Array<{ id: string, name: string, phrase: string, score: number }>} 匹配结果。
   */
  matchText(messages) {
    if (!this.enabled) return [];
    const text = (messages ?? []).map((message) => String(message?.text ?? '')).join('\n');
    return matchStickerOccasions(this.getEnabled(), text);
  }

  /**
   * 生成给模型的目录文本。
   * @returns {Promise<string>} 目录（空串表示无可用表情）。
   */
  async promptCatalog() {
    if (!this.enabled) return '';
    await this.refresh();
    const stickers = this.getEnabled().slice(0, 30);
    if (stickers.length === 0) return '';
    const lines = ['【可用表情包】'];
    for (const item of stickers) {
      const occasion = String(item.occasion ?? '').replace(/\s+/g, ' ').slice(0, 160);
      lines.push(`- ${item.id}：${String(item.name).slice(0, 60)}；适合发送的时机：${occasion || '未说明'}`);
    }
    const guidance = String(this.config?.sticker?.promptGuidance ?? '').trim();
    if (guidance) {
      lines.push('使用要求：' + guidance.slice(0, 800));
    }
    lines.push('如果当前氛围适合，可以只发一个表情包；没有合适表情时正常用文字回复。');
    return lines.join('\n');
  }

  /**
   * 把主文件暂存到 Hook 要求的 outgoing 目录。
   * @param {string} id 表情 id。
   * @returns {Promise<{ sticker: any, path: string }>} 暂存结果。
   */
  async stage(id) {
    await this.refresh();
    const sticker = this.find(id);
    if (!sticker || sticker.enabled === false) throw new Error('STICKER_NOT_FOUND');
    const source = path.isAbsolute(sticker.file) ? sticker.file : path.join(this.paths.root, sticker.file);
    const raw = await readFile(source);
    const invalid = validateGifBytes(raw);
    if (invalid) throw new Error(invalid);
    const md5 = md5Hex(raw);
    if (md5 !== sticker.md5) throw new Error('STICKER_MD5_MISMATCH');
    await mkdir(this.paths.outgoing, { recursive: true });
    const target = path.join(this.paths.outgoing, `${md5}.gif`);
    try {
      const existing = await readFile(target);
      if (!existing.equals(raw)) throw new Error('STICKER_OUTGOING_CONFLICT');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await copyFile(source, target);
    }
    return { sticker, path: target, fields: StickerStore.fieldsOf(sticker, raw) };
  }

  /**
   * Hook 请求需要的 sticker 字段。
   * @param {any} sticker 目录条目。
   * @param {Buffer} raw 文件内容。
   * @returns {{ md5: string, productid: string, len: number, type: number, width: number, height: number }} 字段。
   */
  static fieldsOf(sticker, raw) {
    return {
      md5: String(sticker.md5),
      productid: '',
      len: raw.length,
      type: 2,
      width: Math.max(0, Number(sticker.width) || 0),
      height: Math.max(0, Number(sticker.height) || 0),
    };
  }
}
