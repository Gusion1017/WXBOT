# WeChatAgent 0.3.6 消息→DSH→微信 回环技术报告

仓库 `sourcepro5/WeChatAgent`，commit `e048f0a`（release: v0.3.6）。所有结论均来自下述源码；推断处以「推断」标注。

## 0. 端到端管线（ASCII）

```
微信 PC 客户端 (NT 4.1.10.27, x64)
   │ 加密 SQLite 库 / 原生 DLL
   ▼
[1] scripts/reader-api.py        127.0.0.1:<ports.weflow>   Bearer = state/wechat-io-config.json#reader_token
   │  SSE  GET /api/v1/push/messages  （只登记白名单聊天的图片引用）
   ▼
[2] scripts/hook-onebot.mjs      127.0.0.1:<ports.adapter>  (OneBot v11 适配器 + /status 网页)
   │  incoming() 过滤 → enqueue() → WS 发送（hook 是 WS 客户端，反向连出）
   ▼
[3] components/qq-bridge/src/social-bridge.js
   │  ReverseOneBotServer 127.0.0.1:11229/ws（默认）；白名单 → SocialEngine.receive
   ▼  POST /followup  Bearer = state/social-dsh-token.txt
[4] DSH 桌面端 + packages/dsh-social-bridge-plugin/native-context.mjs   127.0.0.1:11230
   │  session id = social-<sha256(scope+conversationKey)[:32]> → agent.followup()
   ▼
   DSH 模型 deepseek-flash / preset `wechat-social`（空工具允许列表）
   │  输出 "RESPOND: …" | "SILENT"
   ▼
[3] decision-format.js 解析 → deliveryId → 逐条 part 发送
   │  OneBot action: send_private_msg / send_group_msg (+wechatagent_delivery_id)
   ▼
[2] action() → send() → POST /SendTextMsg（Bearer native-token, X-WeChatAgent-Account）
   ▼
   native hook 原生发送 → 回执核对 GET /api/v1/messages → serverId>0 即 confirmed
```

旁挂进程：`scripts/console-server.mjs`（127.0.0.1:3210，CSRF 头 `x-console-token`，Host/Origin 校验）。

## 1. 从「读到一条消息」到「发出回复」

**消费方**：`hook-onebot.mjs` 的 `receiveSse()` 用 `fetch` 拉 `/api/v1/push/messages`，35 s watchdog、单行 256 KB 上限，逐行 `data:` 解析后 `enqueue()`。`incoming()` 做白名单式准入：`event==='message.new'`、类型 ∈ {1,3,47,拍一拍,49,转发,引用}、非 `isSend`、非自己、`allowed(kind,target)`（读 `wechat.whitelist.private/groups`），再归一化成 OneBot v11 事件（`conversationId()` 用 `sha256` 取模把 wxid/群名映射成稳定数字 ID）。`flush()` 在真正 `socket.send` 前又 `reload()` 复查白名单，避免删白名单后仍转发积压事件。

**桥接**：`social-bridge.js` 中 `adapter.onMessage` 再查一次 `allowedGroups/allowedPrivate`，然后 `engine.receive(message)`。

**缓冲与去抖**：`MessageBuffer`（`core/message-buffer.js`）把消息持久化到 `state/social-messages.json`（version 1、每聊天默认 300 条、原子 rename）。`receive()` 先用 `findIncoming()` 按 `message_id+sender_id+text` 去重；`direct = 私聊 ‖ 拍一拍 ‖ isDirectMention()`（`@` segment 等于 self_id、命中 `wake_words`、或引用本账号发言）；群聊 + `modeFor(key)==='mention'` 且非 direct 直接不回复；direct 立即 `#run`，否则排 `batchMs`（默认 3000 ms）去抖定时器。

**调度**：`SocialEngine.#run()` 每个会话只允许一个 in-flight（`running`），取 `buffer.unread(key,20)`，受 4 图 / 12000 字符上限约束；`replyCooldown()` 实施三条限流（`reply_interval` 群 15 s、私聊 1 s；`minute_quota` 3；`ten_minute_quota` 10），未到期就按 `retry_at` 重排。`isBehaviorChangeCommand()` 命中的行被剔除（`LOCKED_BEHAVIOR_REPLY`）。

**提示词**：`buildSocialPrompt()` / `buildPrivatePrompt()` 把本批文本包进 `<untrusted_chat>…</untrusted_chat>`，附「上次发言：「N」分钟前」、上一条真实回复 `previous_reply`、拍一拍/转发/引用的专门说明。人格来自 `roles/<name>.md`（`selectRoleText(…,'v2')`），`persona.chats` 映射按 `wechat:private|group:<id>` 选择；同时作为 `metadata.persona/personaName` 发给插件做一致性校验，而非授权来源。

**会话选择/创建**：插件 `agentFor(key)`：`previousSid = mappings[key]`，否则 `accountSidFor(key,0)`；若该 sid 出现在 `workspaceRegistry.archivedSessionIds` 就 `generation+1` 换代重算 sid；活实例走 `ctx.agents.get(sid)`，否则 `ctx.agents.resume({resumeSessionId})`（同代）或 `ctx.agents.create({sessionId, meta:{agentPreset:'wechat-social'}})`，并在 `setup` 里 `agentPresets.mount(ctx,'wechat-social')`；映射写回 `state/accounts/<id>/dsh-sessions.json`（version 2）。

**人格注入**：`configure()` 读 `state/bridge-config.json`（`localPersona`），`assertLocalPersona` 不一致即 403 `BEHAVIOR_CHANGE_NOT_ALLOWED`。`initialization()` 由 `agent/pre-step` 在「未初始化」时前置一条 `user/message`（`source.socialBootstrap` 记 `digest/instructionsDigest/compactSeq`），内容 = 人格正文 + `stableChatInstructions()`（`CHAT_POLICY_NOTICE`、`CHAT_COHERENCE_NOTICE`、`SOCIAL_PROTOCOL_NOTICE`）。压缩成功（`compaction/end` 无 error）后补回一次；`agent/request` 覆盖单步内溢出的重试；旧初始化用 `surfaceOp:{op:'replace'}` 换成「已更新」说明，原始事件仍留日志。preset 前缀另在 `cordis.patch.yml` 固定为「你是普通微信聊天参与者…最终只输出 SILENT 或 RESPOND: 后接一条短消息」。

**回到正确聊天**：回复文本只取最后一条 assistant 消息（`assistantReplyText()`，含 tool call 的一律视为非回复）；`parseSocialDecision()` 只在 `RESPOND|回复:` 段内取正文，`SILENT` 则 `markProcessed()` 不发；`INVALID` 触发一次「格式校正」回合（`batchId` 派生 `format-repair-v3`）。投递目标取自 `pending.message`（该批的最后一条入站消息）→ `conversation_id` 即合成数字 ID → OneBot `user_id/group_id`，由 `resolveTarget()` 反查真实 wxid，因此不会串聊。

## 2. DSH 集成形态

DSH 是**独立桌面应用**（Electron/Cordis 运行时），插件通过本机 HTTP 暴露 RPC：`127.0.0.1:11230`，Token 由 `state/social-dsh-token.txt` 提供，逐请求 `crypto.timingSafeEqual` 校验。端点：`GET /health`、`GET /sessions`、`GET /dsh-catalog`、`GET /extensions`、`GET /skills`、`POST /followup`、`/configure`、`/compact`、`/context-maintenance`、`/sticker-pool-review`。`/health` 用版本化能力标记做握手下限：`contextMode:'native-session-v1'`、`behaviorPolicy:'local-config-only-v1'`、`imageInput:'native-attachment-v1'`、`sessionLifecycle:'archive-rotation-v1'`、`turnRecovery:'cancel-on-timeout-v1'`；控制台 `getStatus()` 必须全部匹配才判 `dshReady`，并要求 `health.project==='WeChatAgent'` 且 `projectRoot` 同路径。

插件职责：注册 `wechat-social` preset（无本地工具 + 隔离压缩组）；维护 conversationKey→session 映射与世代；回合内 RPC 超时（默认 120 s）后 `agent.cancel({kind:'user'})` 并清 `pending`；按 `batchId` 缓存幂等结果；`conversationAccess()` 生成该聊天的 `dshAccess.chats[key].skills/tools` 白名单，未授权工具不进工具声明；`retireSocialToolMetadata()` / `SOCIAL_TOOL_ISOLATION` 持续裁剪聊天注入的工具元数据。群聊成员记忆、dsh-meme、web-reader、model-search 均按 chat key 绑定并在执行时复查本机策略。

## 3. 回复发送：队列、回执、幂等、限流、重启

- 待发送记录先落盘：`buffer.rememberReply()`（`state/social-messages.json#pendingReplies`）→ 再逐 part 发送；part 状态机 `queued→sending→confirmed|unconfirmed|failed|cancelled|expired`。
- `deliveryId = sha256([key, self_id, throughId])`，同批次稳定；`replyDeliveryParts()` 给第 2 条文字/表情派生子 ID。
- 发送端在**原生提交前**写操作记录：`TextDeliveryStore`（`state/text-deliveries/<sha256([kind,target,id])>.json`），有 `dispatching/accepted/unconfirmed/rejected/confirmed`。同 ID 重放只核对回执或返回 `{…,reused:true}`，绝不二次 `POST /SendTextMsg`。
- 回执核验：`send()` 记录发送前 `baseline` 的 `localId` 集合，轮询 `GET /api/v1/messages?talker=`，取「新 localId + 文本完全相等 + createTime 偏差 30 s 内 + 非零 serverId」，绑定最早候选后 `state='confirmed'`，`receipt:'wechat-server-id'`；超时（默认 18 s）→ `TEXT_DELIVERY_UNCONFIRMED`，Bridge 记为 `unconfirmed` 且**不重发**，只作为「未确认的接话参考」。
- 限流/背压：`hook.maxConcurrentSends`（默认 4）与 `activeActions>8` 返回 `SENDER_BUSY`；Bridge 指数退避（500 ms 起，≤6 次，30 s 截止）后 `expired`。发送侧另有 60 s 指纹去环（`recentOutgoing`）与入站 `recentIncoming` 去重。
- 重启恢复：`SocialEngine` 构造时从 `pendingReplies` 恢复决策（有 parts 或仍有未读才保留），30 s `replay` 定时器重试；恢复后仍只走「核对回执」路径。不同入站批次各有操作 ID，因此相同短句可正常重复发送，不做跨批次文本黑名单。

## 4. 白名单/权限检查点

1. `hook-onebot.mjs`：`allowed()`（`incoming()`、`flush()`、`send()`、`sendSticker()`、`action()` 的 send_* 与 get_friend_list/get_group_list 过滤）。
2. `social-bridge.js`：`adapter.onMessage` 的 `allowedGroups/allowedPrivate`。
3. `conversation-policy.mjs`：`allowedConversation()`（控制台 `/api/chat-settings`、`/api/dsh-access`、`sessions-configure` 均复用它）；`conversationMode()` 只允许 `wechat:group:*` 且值 ∈ `hybrid|mention`。
4. `social-engine.js`：`isDirectMention()`、`modeFor(key)`、`patWaitUntil`、`isBehaviorChangeCommand()`。
5. 插件：`local-policy.mjs`（`BEHAVIOR_POLICY='local-config-only-v1'`、`assertLocalPersona`）、`conversationAccess()`、`social-tool-restrict.mjs`（preset 层工具守卫）。
6. 控制台 `validateConsoleConfig()`：人格名/聊天 ID/频率区间/端口互斥等，`roleName()` 挡路径穿越。

## 5. 公开仓库中缺失的部分

- 安装器 `WeChatAgent-Setup-0.3.6-x64.exe`（README 明确「本源码目录不包含它」）、`apps/console-desktop` 的发布产物。
- **微信 Hook 本体**：`state/hook/native` 由 `scripts/build-hook.ps1` 从私有源码编译，`docs/WECHAT_HOOK.md` 所述第三方 Hook 客户端、`wx_key.dll`（`components/weflow-cli/resources/key/win32/x64/`）均不在库内。
- DSH 桌面程序与 `@deepseek-ai/dsh-*`（`dsh-llm`、`dsh-agent-preset`、`dsh-persona`、`dsh-compaction-*`）为外部项目，仅以依赖/预设形式出现。
- 开发回归测试、合成数据生成器、独立模型验证脚本（README「公开副本不附带」）。
- 私有运行数据：`state/*.json`、`state/logs`、`state/media`、`bridge-config.json`、`config/wechatagent.json`（仅 example）、FFmpeg 程序。
- 本次未读取（但被引用、存在于仓库）：`scripts/reader-api.py`、`onebot/reverse-ws-server.js`、`core/wechat-events.js`、`core/sticker-policy.js`、`core/social-persona.js`、`image-input.mjs`、`docs/CONTEXT_LIMIT.md`、`docs/WECHAT_HOOK.md`。其行为仅由调用点与文档间接确认（推断已标注）。
