/**
 * 表情包通用策略（纯函数，便于测试）。
 *
 * - 总开关
 * - 群聊是否允许
 * - 选择方式：smart（按氛围）/ explicit（仅明确要求表情时）
 * - 每会话冷却
 * - 每小时全局上限
 */
const EXPLICIT_REQUEST_RE = /表情包?|贴图|动图|gif|发个图|来个图|图片?|发表情|来.表情/i;
const PHRASE_SPLIT_RE = /[，,、;；/|\\\s]+/;
const COMMON_PHRASE_RE = /^(?:适合|发送|时机|时候|可以|表情|表情包|回复|聊天|消息|对方|使用|场合|场景)$/;

/**
 * 提取一个表情的可匹配短语：名字 + 时机描述按标点拆分。
 * @param {any} sticker 表情条目。
 * @returns {string[]} 短语。
 */
function stickerPhrases(sticker) {
  const parts = [];
  const name = String(sticker?.name ?? '').trim();
  if (name.length >= 2) parts.push(name);
  for (const part of String(sticker?.occasion ?? '').split(PHRASE_SPLIT_RE)) {
    const phrase = part.trim();
    if (phrase.length >= 2 && !COMMON_PHRASE_RE.test(phrase)) parts.push(phrase);
  }
  return [...new Set(parts)];
}

/**
 * 对话中出现“适合发送的时机”关键词时，匹配对应表情。
 * 命中规则：短语完整出现最强；长短语允许命中两个以上的二字片段。
 * @param {any[]} stickers 启用表情。
 * @param {string} text 对话文本。
 * @returns {Array<{ id: string, name: string, phrase: string, score: number }>} 匹配结果（分数从高到低）。
 */
export function matchStickerOccasions(stickers, text) {
  const normalized = String(text ?? '').toLowerCase().replace(/\s+/g, '');
  if (!normalized) return [];
  const matches = [];
  for (const sticker of stickers ?? []) {
    if (!sticker?.id || sticker.enabled === false) continue;
    let best = null;
    for (const phrase of stickerPhrases(sticker)) {
      const word = phrase.toLowerCase().replace(/\s+/g, '');
      if (word.length < 2) continue;
      let score = 0;
      if (normalized.includes(word)) {
        score = word.length * 3;
      } else if (word.length >= 3) {
        const grams = [];
        for (let i = 0; i < word.length - 1; i += 1) grams.push(word.slice(i, i + 2));
        const hits = [...new Set(grams)].filter((gram) => normalized.includes(gram));
        if (hits.length >= 2 || (word.length <= 3 && hits.length >= 1)) score = hits.length * 2;
      }
      if (score > 0 && (!best || score > best.score)) {
        best = { id: String(sticker.id), name: String(sticker.name ?? ''), phrase, score };
      }
    }
    if (best) matches.push(best);
  }
  matches.sort((a, b) => b.score - a.score);
  return matches;
}

/**
 * 判断当前消息文本是否明确在要表情。
 * @param {any} request 决策请求。
 * @returns {boolean} 是否明确要求。
 */
export function isExplicitStickerRequest(request) {
  const text = (request?.messages ?? [])
    .map((message) => String(message?.text ?? ''))
    .join('\n');
  return EXPLICIT_REQUEST_RE.test(text);
}

/**
 * 在模型已经给出文字回复时，把命中的表情附到回复上。
 * 只处理“RESPOND 且没有表情”的情况；SILENT/纯表情/已有表情不覆盖。
 * @param {any} result 模型决策。
 * @param {Array<{ id: string }>} matches 匹配结果。
 * @param {boolean} allowed 策略是否允许。
 * @returns {any} 原结果或附加 stickerId 的新结果。
 */
export function attachMatchedSticker(result, matches, allowed) {
  if (!allowed || !result || result.action !== 'RESPOND' || !result.text || result.stickerId) return result;
  if (!Array.isArray(matches) || matches.length === 0) return result;
  return { ...result, stickerId: matches[0].id };
}

/**
 * 判断这次决策是否向模型提供表情目录。
 * @param {object} options 选项。
 * @param {any} options.config 应用配置。
 * @param {any} options.request 决策请求。
 * @param {number} options.now 当前时间（ms）。
 * @param {number} [options.lastStickerAt] 本会话上次发表情时间。
 * @param {number[]} [options.recentStickerTimes] 最近全局发表情时间。
 * @returns {{ allowed: boolean, reason: string }} 是否允许及原因。
 */
export function stickerOfferDecision(options) {
  const sticker = options.config?.sticker ?? {};
  if (sticker.enabled === false) return { allowed: false, reason: 'disabled' };
  if (options.request?.kind === 'group' && sticker.groupsEnabled === false) {
    return { allowed: false, reason: 'group_disabled' };
  }
  const mode = sticker.mode === 'explicit' ? 'explicit' : 'smart';
  if (mode === 'explicit' && !isExplicitStickerRequest(options.request)) {
    return { allowed: false, reason: 'explicit_only' };
  }
  const cooldownMs = Math.max(0, Number(sticker.cooldownSeconds ?? 60)) * 1000;
  const lastAt = Number(options.lastStickerAt ?? 0);
  if (cooldownMs > 0 && lastAt > 0 && Number(options.now) - lastAt < cooldownMs) {
    return { allowed: false, reason: 'cooldown' };
  }
  const maxPerHour = Math.max(0, Number(sticker.maxPerHour ?? 10));
  if (maxPerHour > 0) {
    const hourAgo = Number(options.now) - 3_600_000;
    const recent = (options.recentStickerTimes ?? []).filter((time) => Number(time) > hourAgo);
    if (recent.length >= maxPerHour) return { allowed: false, reason: 'hourly_limit' };
  }
  return { allowed: true, reason: '' };
}
