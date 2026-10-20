/**
 * 配置加载与校验（手册 §9：配置写入保留未知字段；启动时校验并迁移）。
 */
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { projectPath } from './paths.mjs';
import { writeJsonAtomic } from './atomic-write.mjs';

/** 配置错误码（对外可判别）。 */
export class ConfigError extends Error {
  /**
   * @param {string} code 错误码，如 CONFIG_MISSING / CONFIG_PARSE_ERROR / CONFIG_INVALID。
   * @param {string} message 错误说明。
   * @param {unknown} [detail] 附加信息。
   */
  constructor(code, message, detail) {
    super(message);
    this.name = 'ConfigError';
    this.code = code;
    this.detail = detail;
  }
}

/** 默认配置（与 config/app.example.json 保持一致）。 */
export function defaultConfig() {
  return {
    version: 1,
    project: 'WXBOT',
    ports: {
      reader: 5031,
      adapter: 8766,
      onebot: 11229,
      aiRuntime: 11230,
      console: 3210,
    },
    reader: {
      backend: 'sqlcipher-nt',
      dataRoot: '',
      accountDirectory: '',
      pollIntervalMs: 1000,
      startupGraceSec: 3,
      dedupeCapacity: 5000,
      keySource: 'manual',
      media: {
        enabled: false,
        cacheDir: 'state/media',
        maxBytes: 8388608,
      },
    },
    wechat: {
      whitelist: { enabled: false, groups: [], private: [] },
      minIntervalMs: { group: 15000, private: 1000 },
      quota: { perMinute: 3, perTenMinutes: 10 },
    },
    logging: {
      level: 'info',
      dir: 'state/logs',
      includeChatContent: false,
    },
    hook: {
      baseUrl: 'http://127.0.0.1:30001',
      expectedVersion: '4.1.10.27',
      wechatExecutable: '',
      requestTimeoutMs: 5000,
      receiptPollMs: 400,
      receiptTimeoutMs: 18000,
    },
    sender: {
      enabled: false,
      maxConcurrentSends: 4,
      maxActions: 8,
    },
    onebot: {
      path: '/ws',
      requestTimeoutMs: 15000,
      maxFrameBytes: 1048576,
    },
    bridge: {
      bufferPerChat: 300,
      debounceMs: 3000,
      pendingReplayDelayMs: 30000,
      minIntervalPrivateMs: 1000,
      minIntervalGroupMs: 15000,
      perMinute: 3,
      perTenMinute: 10,
      maxConcurrent: 4,
      groupMode: 'hybrid',
      wakeWords: [],
      behaviorLock: true,
      autoReply: false,
    },
    memory: {
      enabled: true,
      shortTermLimit: 10,
      halfLifeDays: 7,
      maxPromptChars: 1600,
      maxEntries: 120,
      summaryMaxChars: 500,
      summarizeWithModel: true,
    },
    sticker: {
      enabled: true,
      libraryDir: 'state/stickers/library',
      maxStickers: 50,
      mode: 'smart',
      groupsEnabled: true,
      cooldownSeconds: 60,
      maxPerHour: 10,
      promptGuidance: '只在对方明确想要表情、或氛围明显合适时发送一个；不要连续刷表情。',
    },
    desktop: {
      showImages: true,
    },
    model: {
      provider: 'deepseek',
      baseUrl: 'https://api.deepseek.com',
      model: 'deepseek-chat',
      enabled: false,
      apiKeyFile: 'state/model-key.txt',
      personaFile: 'config/persona.md',
      timeoutMs: 120000,
      maxTokens: 200,
      temperature: 1.0,
    },
  };
}

/**
 * 深合并配置：以 base 为默认值，overlay 覆盖；overlay 里未知字段原样保留。
 * @param {Record<string, unknown>} base 默认配置。
 * @param {Record<string, unknown>} overlay 用户配置。
 * @returns {Record<string, unknown>} 合并结果（新对象）。
 */
export function mergeConfig(base, overlay) {
  if (Array.isArray(base) || Array.isArray(overlay)) {
    return overlay === undefined ? structuredClone(base) : structuredClone(overlay);
  }
  const isPlainObject = (value) =>
    value !== null && typeof value === 'object' && !Array.isArray(value);
  if (!isPlainObject(base) || !isPlainObject(overlay)) {
    return overlay === undefined ? structuredClone(base) : structuredClone(overlay);
  }
  const out = {};
  for (const key of Object.keys(base)) out[key] = structuredClone(base[key]);
  for (const [key, value] of Object.entries(overlay)) {
    out[key] = key in base && isPlainObject(base[key]) && isPlainObject(value)
      ? mergeConfig(base[key], value)
      : structuredClone(value);
  }
  return out;
}

/**
 * 校验并规范化配置；不合法时抛 ConfigError(CONFIG_INVALID)。
 * @param {Record<string, any>} config 待校验配置。
 * @returns {Record<string, any>} 同一对象（原地补默认空值）。
 */
export function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new ConfigError('CONFIG_INVALID', '配置必须是 JSON 对象');
  }
  if (config.version !== 1) {
    throw new ConfigError('CONFIG_INVALID', `不支持的配置版本：${String(config.version)}（期望 1）`);
  }

  const ports = config.ports;
  if (!ports || typeof ports !== 'object') {
    throw new ConfigError('CONFIG_INVALID', 'ports 必须是对象');
  }
  const seenPorts = new Map();
  for (const [name, port] of Object.entries(ports)) {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) {
      throw new ConfigError('CONFIG_INVALID', `ports.${name} 不是合法端口：${String(port)}`);
    }
    if (seenPorts.has(port)) {
      throw new ConfigError(
        'CONFIG_INVALID',
        `ports.${name} 与 ports.${seenPorts.get(port)} 端口重复：${port}`,
      );
    }
    seenPorts.set(port, name);
  }

  const reader = config.reader;
  if (!reader || typeof reader !== 'object') {
    throw new ConfigError('CONFIG_INVALID', 'reader 必须是对象');
  }
  if (typeof reader.backend !== 'string' || reader.backend.length === 0) {
    throw new ConfigError('CONFIG_INVALID', 'reader.backend 必须是非空字符串');
  }
  if (!Number.isInteger(reader.pollIntervalMs) || reader.pollIntervalMs < 100) {
    throw new ConfigError('CONFIG_INVALID', 'reader.pollIntervalMs 必须是 >=100 的整数');
  }
  if (!Number.isInteger(reader.dedupeCapacity) || reader.dedupeCapacity < 1) {
    throw new ConfigError('CONFIG_INVALID', 'reader.dedupeCapacity 必须是正整数');
  }
  for (const key of ['dataRoot', 'accountDirectory', 'keySource']) {
    if (typeof reader[key] !== 'string') {
      throw new ConfigError('CONFIG_INVALID', `reader.${key} 必须是字符串`);
    }
  }

  const wechat = config.wechat;
  if (!wechat || typeof wechat !== 'object' || !wechat.whitelist) {
    throw new ConfigError('CONFIG_INVALID', 'wechat.whitelist 必须存在');
  }
  if ('enabled' in wechat.whitelist && typeof wechat.whitelist.enabled !== 'boolean') {
    throw new ConfigError('CONFIG_INVALID', 'wechat.whitelist.enabled 必须是布尔值');
  }
  for (const kind of ['groups', 'private']) {
    const list = wechat.whitelist[kind];
    if (!Array.isArray(list) || list.some((item) => typeof item !== 'string')) {
      throw new ConfigError('CONFIG_INVALID', `wechat.whitelist.${kind} 必须是字符串数组`);
    }
  }

  const logging = config.logging;
  if (!logging || typeof logging !== 'object') {
    throw new ConfigError('CONFIG_INVALID', 'logging 必须是对象');
  }
  if (!['debug', 'info', 'warn', 'error'].includes(logging.level)) {
    throw new ConfigError('CONFIG_INVALID', `logging.level 非法：${String(logging.level)}`);
  }
  if (typeof logging.includeChatContent !== 'boolean') {
    throw new ConfigError('CONFIG_INVALID', 'logging.includeChatContent 必须是布尔值');
  }

  // hook 配置（M4）：读取层之外的发送通道，必须只指向本机 http。
  const hook = config.hook;
  if (!hook || typeof hook !== 'object') {
    throw new ConfigError('CONFIG_INVALID', 'hook 必须是对象');
  }
  if (typeof hook.baseUrl !== 'string' || hook.baseUrl.length === 0) {
    throw new ConfigError('CONFIG_INVALID', 'hook.baseUrl 必须是非空字符串');
  }
  let hookUrl;
  try {
    hookUrl = new URL(hook.baseUrl);
  } catch {
    throw new ConfigError('CONFIG_INVALID', `hook.baseUrl 不是合法 URL：${hook.baseUrl}`);
  }
  if (hookUrl.protocol !== 'http:'
    || hookUrl.hostname !== '127.0.0.1'
    || hookUrl.username !== ''
    || hookUrl.password !== ''
    || !hookUrl.port
    || (hookUrl.pathname !== '' && hookUrl.pathname !== '/')
    || hookUrl.search !== ''
    || hookUrl.hash !== '') {
    throw new ConfigError(
      'HOOK_LOOPBACK_REQUIRED',
      `hook.baseUrl 必须是 http://127.0.0.1:<端口> 且无 user/path/query：${hook.baseUrl}`,
    );
  }
  if (typeof hook.expectedVersion !== 'string' || !/^\d+\.\d+\.\d+\.\d+$/.test(hook.expectedVersion)) {
    throw new ConfigError('CONFIG_INVALID', 'hook.expectedVersion 必须是四段版本号');
  }
  for (const key of ['requestTimeoutMs', 'receiptPollMs', 'receiptTimeoutMs']) {
    if (!Number.isInteger(hook[key]) || hook[key] < 50) {
      throw new ConfigError('CONFIG_INVALID', `hook.${key} 必须是 >=50 的整数`);
    }
  }

  const sender = config.sender;
  if (!sender || typeof sender !== 'object') {
    throw new ConfigError('CONFIG_INVALID', 'sender 必须是对象');
  }
  if (typeof sender.enabled !== 'boolean') {
    throw new ConfigError('CONFIG_INVALID', 'sender.enabled 必须是布尔值');
  }
  for (const key of ['maxConcurrentSends', 'maxActions']) {
    if (!Number.isInteger(sender[key]) || sender[key] < 1) {
      throw new ConfigError('CONFIG_INVALID', `sender.${key} 必须是正整数`);
    }
  }

  // OneBot / 桥接 / 模型（M5/M6）
  const onebot = config.onebot;
  if (!onebot || typeof onebot !== 'object' || typeof onebot.path !== 'string' || !onebot.path.startsWith('/')) {
    throw new ConfigError('CONFIG_INVALID', 'onebot.path 必须是 / 开头的字符串');
  }
  for (const key of ['requestTimeoutMs', 'maxFrameBytes']) {
    if (!Number.isInteger(onebot[key]) || onebot[key] < 100) {
      throw new ConfigError('CONFIG_INVALID', `onebot.${key} 必须是 >=100 的整数`);
    }
  }
  const bridge = config.bridge;
  if (!bridge || typeof bridge !== 'object') throw new ConfigError('CONFIG_INVALID', 'bridge 必须是对象');
  for (const key of ['bufferPerChat', 'debounceMs', 'pendingReplayDelayMs', 'minIntervalPrivateMs',
    'minIntervalGroupMs', 'perMinute', 'perTenMinute', 'maxConcurrent']) {
    if (!Number.isInteger(bridge[key]) || bridge[key] < 0) {
      throw new ConfigError('CONFIG_INVALID', `bridge.${key} 必须是非负整数`);
    }
  }
  if (!['hybrid', 'mention'].includes(bridge.groupMode)) {
    throw new ConfigError('CONFIG_INVALID', `bridge.groupMode 只能是 hybrid/mention：${bridge.groupMode}`);
  }
  if (!Array.isArray(bridge.wakeWords) || bridge.wakeWords.some((word) => typeof word !== 'string')) {
    throw new ConfigError('CONFIG_INVALID', 'bridge.wakeWords 必须是字符串数组');
  }
  if (typeof bridge.behaviorLock !== 'boolean' || typeof bridge.autoReply !== 'boolean') {
    throw new ConfigError('CONFIG_INVALID', 'bridge.behaviorLock/autoReply 必须是布尔值');
  }
  const memory = config.memory;
  if (!memory || typeof memory !== 'object') throw new ConfigError('CONFIG_INVALID', 'memory 必须是对象');
  for (const key of ['shortTermLimit', 'halfLifeDays', 'maxPromptChars', 'maxEntries', 'summaryMaxChars']) {
    if (!Number.isInteger(memory[key]) || memory[key] < 1) {
      throw new ConfigError('CONFIG_INVALID', `memory.${key} 必须是正整数`);
    }
  }
  if (typeof memory.enabled !== 'boolean' || typeof memory.summarizeWithModel !== 'boolean') {
    throw new ConfigError('CONFIG_INVALID', 'memory.enabled/summarizeWithModel 必须是布尔值');
  }
  if (memory.shortTermLimit < 2 || memory.shortTermLimit > 100) {
    throw new ConfigError('CONFIG_INVALID', 'memory.shortTermLimit 必须在 2-100 之间');
  }
  if (memory.maxPromptChars < 200 || memory.maxPromptChars > 20000) {
    throw new ConfigError('CONFIG_INVALID', 'memory.maxPromptChars 必须在 200-20000 之间');
  }
  const sticker = config.sticker;
  if (!sticker || typeof sticker !== 'object') throw new ConfigError('CONFIG_INVALID', 'sticker 必须是对象');
  if (typeof sticker.enabled !== 'boolean') throw new ConfigError('CONFIG_INVALID', 'sticker.enabled 必须是布尔值');
  if (!Number.isInteger(sticker.maxStickers) || sticker.maxStickers < 1 || sticker.maxStickers > 500) {
    throw new ConfigError('CONFIG_INVALID', 'sticker.maxStickers 必须在 1-500 之间');
  }
  if (typeof sticker.libraryDir !== 'string' || sticker.libraryDir.length === 0) {
    throw new ConfigError('CONFIG_INVALID', 'sticker.libraryDir 必须是非空字符串');
  }
  if (!['smart', 'explicit'].includes(sticker.mode)) {
    throw new ConfigError('CONFIG_INVALID', 'sticker.mode 只能是 smart/explicit');
  }
  if (typeof sticker.groupsEnabled !== 'boolean') {
    throw new ConfigError('CONFIG_INVALID', 'sticker.groupsEnabled 必须是布尔值');
  }
  for (const key of ['cooldownSeconds', 'maxPerHour']) {
    if (!Number.isInteger(sticker[key]) || sticker[key] < 0 || sticker[key] > 3600) {
      throw new ConfigError('CONFIG_INVALID', `sticker.${key} 必须是 0-3600 的整数`);
    }
  }
  if (typeof sticker.promptGuidance !== 'string' || sticker.promptGuidance.length > 800) {
    throw new ConfigError('CONFIG_INVALID', 'sticker.promptGuidance 必须是 ≤800 字字符串');
  }
  const desktop = config.desktop;
  if (desktop !== undefined) {
    if (!desktop || typeof desktop !== 'object') throw new ConfigError('CONFIG_INVALID', 'desktop 必须是对象');
    if (typeof desktop.showImages !== 'boolean') throw new ConfigError('CONFIG_INVALID', 'desktop.showImages 必须是布尔值');
  }
  const model = config.model;
  if (!model || typeof model !== 'object') throw new ConfigError('CONFIG_INVALID', 'model 必须是对象');
  for (const key of ['provider', 'baseUrl', 'model', 'apiKeyFile', 'personaFile']) {
    if (typeof model[key] !== 'string' || model[key].length === 0) {
      throw new ConfigError('CONFIG_INVALID', `model.${key} 必须是非空字符串`);
    }
  }
  try {
    const modelUrl = new URL(model.baseUrl);
    if (!['http:', 'https:'].includes(modelUrl.protocol)) throw new Error('bad protocol');
  } catch {
    throw new ConfigError('CONFIG_INVALID', `model.baseUrl 不是合法 http(s) URL：${model.baseUrl}`);
  }
  if (typeof model.enabled !== 'boolean') throw new ConfigError('CONFIG_INVALID', 'model.enabled 必须是布尔值');
  for (const key of ['timeoutMs', 'maxTokens']) {
    if (!Number.isInteger(model[key]) || model[key] < 1) {
      throw new ConfigError('CONFIG_INVALID', `model.${key} 必须是正整数`);
    }
  }
  if (typeof model.temperature !== 'number' || model.temperature < 0 || model.temperature > 2) {
    throw new ConfigError('CONFIG_INVALID', 'model.temperature 必须在 0-2 之间');
  }
  return config;
}

/** 配置加载结果。 @typedef {{ config: Record<string, any>, path: string, created: boolean }} LoadedConfig */

/**
 * 读取 config/app.json；可选在缺失时用样例模板生成。
 * @param {{ root?: string, createIfMissing?: boolean }} [options] 选项。
 * @returns {Promise<LoadedConfig>} 配置与路径。
 */
export async function loadConfig(options = {}) {
  const root = options.root ?? projectPath();
  const configPath = path.join(root, 'config', 'app.json');
  const createIfMissing = options.createIfMissing ?? false;
  let raw;
  let created = false;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') {
      throw new ConfigError('CONFIG_UNREADABLE', `无法读取配置 ${configPath}：${error.message}`);
    }
    if (!createIfMissing) {
      throw new ConfigError('CONFIG_MISSING', `缺少配置 ${configPath}，请先运行 npm run init`);
    }
    const examplePath = path.join(root, 'config', 'app.example.json');
    try {
      raw = await readFile(examplePath, 'utf8');
    } catch {
      raw = JSON.stringify(defaultConfig(), null, 2);
    }
    await writeJsonAtomic(configPath, JSON.parse(raw));
    created = true;
  }
  let userConfig;
  try {
    userConfig = JSON.parse(raw);
  } catch (error) {
    // 手册 §11 故障注入：配置被改坏时拒绝启动，并保留一份坏配置备份。
    const backupPath = path.join(root, 'config', `app.json.broken-${Date.now()}.json`);
    await writeFile(backupPath, raw, 'utf8').catch(() => {});
    throw new ConfigError(
      'CONFIG_PARSE_ERROR',
      `配置不是合法 JSON（${configPath}）：${error.message}；已备份到 ${backupPath}`,
    );
  }
  const merged = mergeConfig(defaultConfig(), userConfig);
  validateConfig(merged);
  if (created) {
    // 生成时写入“默认值 + 样例覆盖”的完整配置，方便用户直接改。
    await writeJsonAtomic(configPath, merged);
  }
  return { config: merged, path: configPath, created };
}
