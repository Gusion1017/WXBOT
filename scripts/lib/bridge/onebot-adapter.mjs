/**
 * OneBot 适配器纯函数（M5）：reader SSE 事件 → OneBot v11 事件、目标索引、@ 合成。
 * 便于单测；运行时逻辑在 scripts/adapter.mjs。
 */
import { normalizeGroupName, onebotId } from './onebot-id.mjs';

/**
 * 由 reader 会话列表构造「数字 ID → 真实 talker」索引。
 * @param {Array<{ talker: string, displayName: string, sessionType: string }>} sessions 会话列表。
 * @returns {{ byPrivate: Map<string, any>, byGroup: Map<string, any> }} 索引。
 */
export function buildTargetIndex(sessions) {
  const byPrivate = new Map();
  const byGroup = new Map();
  for (const session of sessions ?? []) {
    if (!session?.talker) continue;
    if (session.sessionType === 'group') {
      byGroup.set(onebotId(normalizeGroupName(session.displayName || session.talker)), {
        talker: session.talker,
        kind: 'group',
        displayName: session.displayName || session.talker,
      });
    } else {
      byPrivate.set(onebotId(session.talker), {
        talker: session.talker,
        kind: 'private',
        displayName: session.displayName || session.talker,
      });
    }
  }
  return { byPrivate, byGroup };
}

/**
 * reader 推送事件 → OneBot v11 消息事件。
 * @param {any} event reader SSE 事件（message.new）。
 * @param {object} options 选项。
 * @param {string} options.selfId OneBot 自己的数字 ID。
 * @param {string} options.selfDisplay 自己在群里的显示名（用于 @ 合成）。
 * @param {{ private: Set<string>, groups: Set<string> }} options.whitelist 白名单数字 ID 集合。
 * @returns {any|null} OneBot 事件；不需要转发返回 null。
 */
export function toOneBotEvent(event, options) {
  if (!event || event.event !== 'message.new') return null;
  const { selfId, selfDisplay = '', whitelist } = options;
  const isGroup = event.sessionType === 'group';
  const groupIdentity = normalizeGroupName(event.groupName || event.sessionId || '');
  const peerIdentity = event.sessionId || '';
  const numericPeer = isGroup ? onebotId(event.senderName || event.talkerId || '') : onebotId(peerIdentity);
  const whitelisted = isGroup
    ? whitelist?.groups?.has(onebotId(groupIdentity))
    : whitelist?.private?.has(onebotId(peerIdentity));
  if (!whitelisted) return null;

  const content = String(event.content ?? '');
  const segments = [];
  if (isGroup && selfDisplay && content.includes(`@${selfDisplay}`)) {
    segments.push({ type: 'at', data: { qq: String(selfId) } });
  }
  segments.push({ type: 'text', data: { text: content } });
  return {
    time: Number(event.timestamp ?? Math.floor(Date.now() / 1000)),
    self_id: Number(selfId),
    post_type: 'message',
    message_type: isGroup ? 'group' : 'private',
    sub_type: isGroup ? 'normal' : 'friend',
    message_id: String(event.rawid ?? ''),
    message_seq: 0,
    raw_message: content,
    font: 0,
    user_id: Number(numericPeer),
    ...(isGroup ? { group_id: Number(onebotId(groupIdentity)) } : {}),
    sender: {
      user_id: Number(numericPeer),
      nickname: String(event.senderName || event.talkerId || ''),
      card: String(event.senderName || ''),
    },
    message: segments,
    raw_event: {
      talkerId: event.talkerId ?? '',
      sessionId: event.sessionId ?? '',
      quote: Boolean(event.quoteReply),
      forwarded: Boolean(event.forwardedRecord),
      pat: Boolean(event.pat),
    },
  };
}

/**
 * 从联系人列表里找自己的显示名。
 * @param {Array<{ username: string, displayName: string }>} contacts 联系人。
 * @param {string} ownWxid 自己的 wxid（已去掉目录后缀）。
 * @returns {string} 显示名或空串。
 */
export function findSelfDisplay(contacts, ownWxid) {
  const match = (contacts ?? []).find((contact) => contact?.username === ownWxid);
  return String(match?.displayName ?? '');
}
