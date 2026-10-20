# M0–M3 验收记录（只读产品化）

本文件记录 M0–M3 各项的手动/自动验收结果，随实现更新。

## M2 真机验收 ✅

- 时间：2026-10-18 04:11:39 / 04:11:42（本地）
- 方式：`node scripts/dev/dev-watch.mjs 300` 挂着 SSE，用户从手机给 PC 登录的账号发微信消息
- 结果：两条 `message.new` 均实时推送，**延迟 1s / 0s**（目标 ≤2s）
- 证据摘录（不打印正文）：`{"event":"message.new","sessionType":"private","type":1,"contentLength":2,"latencySec":1}`、`…"contentLength":3,"latencySec":0`

## M3 验收项（手册 §3）

| 验收项 | 状态 | 证据 |
|---|---|---|
| 白名单外会话读取返回 403 | ✅ | `Reader.allowed` + 单测 `test_whitelist_enabled_denies_by_default`；HTTP 403 `CONVERSATION_NOT_ALLOWED` |
| 图片能落到本地文件并显示 | ✅ | `dev-media-check.mjs`：真实微信图片解密为 JPEG（13,563 bytes）写到 `state/media/<imageId>.jpg`；`test_image_resolution_end_to_end` 用合成 V2 容器覆盖同链路 |
| 控制台/CLI 展示 | ✅ CLI + Web 只读控制台 | CLI：`status/sessions/contacts/messages/images`；Web：`http://127.0.0.1:3210/`（页面 token 注入、`/api/*` CSRF、Host/Origin 校验、只读 405；实测 401/403/405 与图片代理解密通过），见 [CONSOLE.md](./CONSOLE.md) |
| 白名单语义 | ✅ | `enabled=true` 且列表为空 = 全拒；列表非空严格匹配；旧开发态（false+空）放行 |

## 手册 §11 故障注入表

| 注入 | 期望 | 实测 |
|---|---|---|
| 密钥改错 | `KEY_REJECTED`，不崩、不写坏状态 | ✅ `reader-api.py --check` → `{"ok":false,"code":"KEY_REJECTED"}`，退出码 1；恢复 keys.json 后 `ok:true` |
| 删一个消息分片 | 显式上报覆盖不全，其余照读 | ✅ 合成库集成测试：`status.shardFailures` 列出坏分片，正常分片仍可读 |
| 端口被占用 | 启动失败并给出占用者提示 | ✅ 第二次启动退出码 1：`{"error":"READER_PORT_UNAVAILABLE","code":10048,"ownerPid":"…","ownerImage":"python.exe"}` |
| 配置被改坏 | 启动时拒绝并保留备份 | ✅ `CONFIG_PARSE_ERROR` + `config/app.json.broken-<时间戳>.json`（Node 单测覆盖） |
| hook 卡死 / 模型超时 | 健康检查变红、释放 pending | n/a（C 路线未接发送/AI，M4/M6 再验） |

## 手册 §11 单元测试清单

| 项 | 状态 |
|---|---|
| 密钥 HMAC：正确 True、错误 False、坏输入 None | ✅ `test_dbkey.py` |
| 分片发现：排除 `_fts`/`_resource`、多分片、坏分片 | ✅ `test_reader_integration.py` |
| XML 解码：自闭合标签、嵌套同名标签、实体、DOCTYPE 拒收、超长截断 | ✅ `test_decode.py` |
| 引用/转发/拍一拍：正常、缺字段、深度超限、正文为空 | ✅ `test_decode.py` |
| 合成 ID / 决策解析 | M5/M6 里程碑（未开始） |
| 合成 SQLCipher 库跑完整读取链路 | ✅ `test_reader_integration.py`（不依赖真微信） |

## 自动化测试

```powershell
npm test                 # Node：86+ 个（配置/令牌/脱敏/控制台安全/OneBot/引擎/发送/模型）
npm run test:py          # Python：51 个（解码/密钥/媒体/合成库集成）
.\.venv\Scripts\python.exe scripts/reader-api.py --check   # 真实库自检
node scripts/dev/dev-sse-check.mjs                          # SSE 通道自检
node scripts/dev/dev-media-check.mjs                        # 真实图片解密自检
node scripts/wxbot-cli.mjs sessions                         # CLI 展示
```

## 已知限制 / 踩坑记录

- Windows 上 `SO_REUSEADDR` 允许第二个进程绑定同一端口（看似成功）；读取层已改用 `SO_EXCLUSIVEADDRUSE`，端口冲突才能正确失败并提示占用者。
- 表情（localType=47）本地缓存命名与普通图片不同，当前按普通图片候选找不到时返回 `IMAGE_FILE_NOT_FOUND`（不影响文字消息）。
- 图片只支持 V2 容器；非 V2 返回 `IMAGE_DECODE_FAILED`。
- 微信 4.1.15 的 `message_content` 全部是 zstd BLOB（文本也是）；图片文件名不总等于 XML md5，需要 `MessageResourceInfo.packed_info` 候选。
- 白名单真实配置待用户指定（当前开发态全放行）。
