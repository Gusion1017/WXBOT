# 读取层接口契约（READER_API）

> 状态：M1/M2 已实现（M3 媒体接口待实现）。
> 所有服务只绑 `127.0.0.1`；鉴权头 `Authorization: Bearer <state/tokens/reader.txt>`（常量时间比较）。
> 错误统一 `{"success": false, "error": "CODE"}`：未授权 401、越权 403、未就绪 503。

## 1. 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/v1/reader/status` | 读取层状态（不含聊天正文） |
| GET | `/api/v1/sessions?limit=` | 会话列表（默认 100，1–500） |
| GET | `/api/v1/contacts?keyword=&kind=&limit=` | 联系人/群（`kind`=`group`/`private`/`friend`/…） |
| GET | `/api/v1/messages?talker=&limit=&fromTime=` | 历史消息（按 createTime 倒序；`fromTime` 为 unix 秒） |
| GET | `/api/v1/push/messages` | **SSE** 增量推送（M2） |
| POST | `/api/v1/events/retry` | 显式重推一条入站事件（M2） |
| GET | `/api/v1/images/<id>` | 取一张图的 base64（M3） |

## 2. `/api/v1/reader/status`

```json
{
  "success": true,
  "backend": "sqlcipher-nt",
  "ready": true,
  "ownWxid": "wxid_xxx",
  "accountDirectory": "wxid_xxx_abcd",
  "lastPoll": 1792267137.6,
  "lastError": "",
  "subscribers": 0,
  "pushed": 0,
  "shards": [{ "name": "message_0.db", "opened": true, "reason": "" }],
  "shardFailures": []
}
```

- 未就绪时该端点仍返回 200，但 `ready=false` 且 `lastError` 为错误码（如 `KEY_REJECTED` / `DB_UNREADABLE` / `READER_DEPENDENCY_MISSING`）。
- `shardFailures` 显式列出读不到的分片（不静默少读）。
- `imagesRegistered`：已登记图片数；`imageKeySource`：`kvcomm`（从 kvcomm 统计文件派生并验证）或 `config`（显式配置）；`lastImageError` 为最近一次图片错误码。

## 3. `/api/v1/sessions`

```json
{ "success": true, "sessions": [{
  "talker": "44484320158@chatroom",
  "displayName": "群显示名",
  "sessionType": "group",
  "kind": "group",
  "unreadCount": 0,
  "lastTimestamp": 1792171198,
  "sortTimestamp": 1792171198,
  "lastMsgType": 3,
  "lastSender": "wxid_xxx",
  "lastSenderDisplay": "某人",
  "hidden": false,
  "summary": "最近一条摘要（≤120 字）"
}]}
```

## 4. `/api/v1/contacts`

```json
{ "success": true, "contacts": [
  { "username": "wxid_xxx", "displayName": "备注 > 昵称 > 别名 > wxid", "kind": "friend", "ambiguous": false }
]}
```

- `ambiguous=true` 表示多个群去尾号后同名（白名单/Session 映射要小心）。
- `kind`：`group` / `friend` / `official` / `system` / `other`。

## 5. `/api/v1/messages`

```json
{ "success": true, "messages": [{
  "localId": 1783,
  "serverId": "7548414419946553532",
  "localType": 244813135921,
  "baseType": 49,
  "appType": 57,
  "createTime": 1792259082,
  "isSend": 0,
  "senderUsername": "wxid_xxx",
  "senderDisplay": "某人",
  "content": "回复正文 ｜ 引：被引用的原文",
  "typeText": "引用",
  "rawid": "sha256(...)",
  "quoteReply": { "version": 1, "reply": "...", "reference": { "...": "..." } }
}]}
```

- 非文本一律给占位文本（`[图片]`、`[表情包]`、`[视频]`、`[语音]`、`[位置]`、`[名片]`、`[系统消息]`、
  `[链接] 标题`、`[文件] 文件名`、`[小程序] 标题`、`[合并转发聊天记录] 标题`、`[拍一拍] …`、
  `[未识别的消息类型 N]`），**绝不返回空串**。
- 引用消息的 `content` 已带被引原文（`" ｜ 引："` 分隔），`quoteReply` 给结构化版本。
- 合并转发的 `forwardedRecord`：`{title, items:[{sender,time,kind,text,depth}], truncated, unavailable}`，
  限制：≤50 条 / ≤6000 字 / ≤3 层 / XML ≤512KB，拒收 DOCTYPE/ENTITY。
- `rawid = sha256(json([talker, serverId, localId, createTime]))`，是推送去重键。

### 白名单语义

`config/app.json` 的 `wechat.whitelist`：

```json
{ "enabled": true, "private": ["wxid_xxx"], "groups": ["群显示名"] }
```

- `enabled=false` 且两个列表都为空：M1 开发态，放行所有会话；
- 其余情况（`enabled=true` 或列表非空）：严格匹配 wxid / 群显示名（自动去尾部 `(n)`），否则 403 `CONVERSATION_NOT_ALLOWED`；
- `enabled=true` 且列表为空 = 全部拒绝（安全默认）。
- 图片接口同样受白名单约束（`IMAGE_NOT_AUTHORIZED` 403）。

## 6. 图片 `/api/v1/images/<id>`

- `<id>` 是 64-hex，等于 `sha256([ownWxid, talker, rawid])`；入站图片/表情在推送事件里带 `image.id`，`/messages` 里图片消息也会带 `image.id`。
- 解密链路（手册 §5.7）：XML 里取 32-hex 候选 + `MessageResourceInfo.packed_info` 的候选（hex 与原始 16 字节切片）→ 在 `msg/attach/<md5(talker)>/**/Img/<候选>{,.dat,_h.dat,_t.dat}` 定位 → V2 容器 AES-128-ECB + 尾部 XOR → 校验图片魔数。
- 图片密钥来源：配置 `reader.imageAesKey` / `reader.imageXorKey`（hex16 / 0-255），或 kvcomm 统计文件名派生 `md5(f"{code}{wxid}")[:16]` 并用真实 `_t.dat` 头验证。
- 解密在**子进程** `scripts/resolve-media.py` 里执行（超时 25s、单文件 ≤8MiB），结果缓存到 `state/media/<id>.json`，同时落盘 `state/media/<id>.jpg|png|gif|webp`。
- 响应：

```json
{
  "success": true,
  "imageId": "64-hex",
  "mime": "image/jpeg",
  "bytes": 13563,
  "b64": "/9j/4AAQ...",
  "savedFile": "…\\state\\media\\<id>.jpg",
  "sourceFile": "…\\msg\\attach\\…\\Img\\<候选>.dat",
  "keySource": "kvcomm"
}
```

## 6. SSE `/api/v1/push/messages`

- `text/event-stream` + chunked；`data: {json}\n\n`；空闲 2s 发 `: heartbeat\n\n`。
- 每客户端独立队列（500 条），满了直接踢连接。
- 事件形态：

```json
{
  "event": "message.new",
  "sessionId": "44484320158@chatroom",
  "sessionType": "group",
  "rawid": "sha256(...)",
  "groupName": "群显示名",
  "sourceName": "群内发言人或私聊对方显示名",
  "senderName": "发送者显示名",
  "talkerId": "wxid_xxx",
  "content": "占位或正文，≤4000 字",
  "type": 3,
  "timestamp": 1792259082,
  "pat": { "actor": "wxid_xxx", "target": "wxid_me" },
  "quoteReply": { "...": "..." },
  "forwardedRecord": { "...": "..." },
  "image": { "localId": 1, "serverId": "…", "createTime": 0, "localType": 3 }
}
```

- **启动不回放历史**：水位从进程启动时刻开始，只留 3s 重叠；重启后不补推旧消息。
- 去重：内存保留最近 `reader.dedupeCapacity`（默认 5000）条 `rawid`。
- 只推入站消息（`isSend=0`）；自己发出的不推。

## 7. POST `/api/v1/events/retry`

请求体：`{ "talker": "…", "localId": 1783, "createTime": 1792259082 }`
响应：`{ "success": true, "pushed": true }`（已推过返回 `false`）。
用于排查/重放单条事件；只按三元组精确定位，不重放历史。

## 8. 错误码

| 错误码 | HTTP | 含义 |
|---|---|---|
| `UNAUTHORIZED` | 401 | 缺少/错误的 Bearer token |
| `CONVERSATION_NOT_ALLOWED` | 403 | 会话不在白名单 |
| `TALKER_REQUIRED` / `INVALID_FROM_TIME` / `INVALID_BODY` | 400 | 参数错误 |
| `READER_NOT_READY` | 503 | 读取层初始化失败（看 `/status` 的 `lastError`） |
| `KEY_MISSING` / `KEY_REJECTED` | 503 | 没密钥 / 密钥对不上库 |
| `DB_UNREADABLE` | 503 | 库文件不可读（权限/损坏/缺文件） |
| `SCHEMA_MISMATCH` / `READER_QUERY_FAILED` / `EVENT_RETRY_FAILED` | 503 | 表结构不匹配 / 查询失败 / 重推失败 |
| `NOT_FOUND` | 404 | 未知路径 |

## 9. 初始化自检

```powershell
.\.venv\Scripts\python.exe scripts\reader-api.py --check
```

输出 `{ok, accountDirectory, ownWxid, shards, sessionCount, contactCount, sampleSessions}`；
退出码 0 表示密钥校验 + 库打开 + 会话/联系人读取都成功。
