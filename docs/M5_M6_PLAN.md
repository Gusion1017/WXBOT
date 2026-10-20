# M5 桥接 / M6 模型层（路线 A）实施记录

## 状态：✅ M5 + M6 真机端到端验收通过（2026-10-18 04:40）

- 入站：白名单好友 → 本机账号 私聊「<测试消息>」（localId=266，serverId=2355170334783003392）
- 决策：DeepSeek `deepseek-chat` + persona（496 字），输出 `RESPOND: <测试回复>`
- 出站：Hook 发送 → 数据库回读 serverId=`2063964719836064283`、localId=267，state=confirmed
- 耗时：入站 createTime=1792269650 → 回复 createTime=1792269652（**2 秒**）
- 计数：adapter received/forwarded/sent = 1/1/1；bridge received/replied = 1/1；delivery store confirmed=1

## M5 组件

| 组件 | 位置 | 状态 |
|---|---|---|
| OneBot v11 反向 WS 服务端 | `scripts/lib/bridge/onebot-server.mjs` | ✅ 单连接（新踢旧）、Bearer token 常量时间、echo 关联/超时、1MB 帧上限、只允许 JSON 对象、断线清理 pending、`/health`（Bearer） |
| 合成数字 ID | `scripts/lib/bridge/onebot-id.mjs` | ✅ `sha256(identity)[:8] % 2147483647 + 1`；私聊 wxid、群去尾号显示名；白名单集合同算法推导 |
| 业务引擎 | `scripts/lib/bridge/social-engine.mjs` | ✅ 缓冲 300/3s 去抖/直呼（私聊、@、唤醒词、引用自己）/白名单二次校验/幂等/防环/行为锁/限流（群 15s、私聊 1s、3 条/分、10 条/10 分）/并发上限/pending 重放核对 |
| 适配器 | `scripts/adapter.mjs` + `scripts/lib/bridge/onebot-adapter.mjs` | ✅ reader SSE（35s watchdog、断线重连）→ OneBot 事件（@自己合成 at 段、白名单复核）→ 反向 WS 拨号；`send_*` action → resolve talker → M4 发送 + 回执；`get_friend_list/get_group_list`；8766 状态口（Bearer adapter token） |
| 管理编排 | `scripts/manage.ps1` | ✅ reader → bridge → adapter → console；`npm run status` 显示四个节点 health |

## M6 组件（路线 A：直连模型 API）

- `scripts/lib/model/model-client.mjs`：OpenAI 兼容 `POST {baseUrl}/chat/completions`（默认 DeepSeek）；key 从 `state/model-key.txt`（ACL 仅当前用户）或 `WXBOT_MODEL_API_KEY`；persona 从 `config/persona.md`；只接受 `SILENT` / `RESPOND:`，格式非法**只校正一次**；超时/HTTP 错误降级 SILENT。
- bridge `decision`：`bridge.autoReply=true && model.enabled=true` 时调模型；否则 SILENT。
- 默认人格见 `config/persona.md`（可随时编辑，重启 bridge 生效）。

## 开关

```jsonc
// config/app.json
"bridge": { "autoReply": true,  "groupMode": "hybrid" }, // autoReply=false 即只读不回复
"model":  { "enabled": true, "model": "deepseek-chat", "personaFile": "config/persona.md" },
"sender": { "enabled": true }                            // 发送总开关（false 时 adapter 拒绝发送）
```

## 已知限制 / 后续（M7）

- 群聊回复模式：`hybrid`（非 @ 也会在去抖后回复）与 `mention`（仅 @/唤醒）可切换；当前白名单只有一条私聊，群聊未启用。
- 自动回复期间，若 Hook 客户端退出，发送会 `unconfirmed` 不回退重发；reader 读取不受影响。
- M7（稳定性/自启/崩溃恢复）尚未做；当前进程由 `manage.ps1` 管理，重启后需重新 start。

