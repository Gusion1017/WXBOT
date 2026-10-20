# WeChatAgent 0.3.6 架构与机制（源码走读合并版）

- 仓库：`sourcepro5/WeChatAgent`，`main` @ `e048f0a`（release v0.3.6）
- 分析方式：逐文件读取公开源码 + 官方文档；证据与未验证项见附录 B
- 本文回答两个问题：**它怎么"连"上微信、怎么"读"到消息**；顺带把读到的消息如何变成回复、如何回写微信讲清楚

---

## 0. 摘要

> **读**靠离线解密微信 4.x 本地 SQLCipher 数据库 + 1 秒轮询；
> **写**靠把自编译的 `version.dll` 代理 DLL 注入微信进程，在进程内起一个只监听 127.0.0.1 的 HTTP 服务，调用微信自己的发送函数；
> 两条通道互不依赖，靠"数据库里出现带 serverId 的发出记录"做发送回执，靠"hook 报告的 db_storage 账号 == reader 报告的账号目录"做跨通道身份绑定。

不依赖：微信官方 API、协议逆向、UI 自动化、屏幕 OCR。
依赖三个外部件：第三方 Hook（aixed/WeChat-Hook）、微信客户端固定版本、DSH 桌面端。

---

## 1. 全景

```
┌────────────────────── 微信 PC 客户端 4.1.10.27 x64（独立副本）──────────────────────┐
│  Weixin.exe                                                                        │
│   └ version.dll（本项目构建的代理/劫持 DLL）                                         │
│       └ DllMain → 延迟初始化线程（等 Weixin.dll ≤30s）→ MinHook inline hook           │
│            └ 进程内 HTTP：GET /WeChatAgent/health  POST /SendTextMsg  ...            │
└────────┬───────────────────────────────────────────────────┬───────────────────────┘
         │ ① 读：直接解密 db_storage/*.db（不经过 hook）           │ ② 写：127.0.0.1:30001
         │                                                      │ Bearer 64hex
         ▼                                                      ▼
 reader-api.py（Python，127.0.0.1:5031）              hook-onebot.mjs（Node，127.0.0.1:8766）
  · SQLCipher 解密                                   · 消费 reader SSE，转 OneBot v11 事件
  · 白名单会话增量轮询（1s）                          · 收 OneBot action，调 hook 发送
  · SSE /api/v1/push/messages                        · 回读数据库确认 serverId 回执
         │                                                      │
         └──────────────► SSE（text/event-stream）◄──────────────┘
                                 │
                                 ▼  反向 WebSocket（hook-onebot 主动拨号）
                    social-bridge.js（Node，127.0.0.1:11229/ws）
                    ReverseOneBotServer → WechatOneBotAdapter
                    → MessageBuffer（落盘去抖）→ SocialEngine（白名单/限流/人格/会话）
                                 │ HTTP 127.0.0.1:11230  Bearer social-dsh-token
                                 ▼
                    DSH 桌面端 + dsh-social-bridge-plugin（进程内插件）
                    session = social-<sha256(key)[:32]>，preset wechat-social（空工具）
                    模型只输出：RESPOND: <短回复> 或 SILENT
                                 │
                                 └──► 回到 SocialEngine → OneBot action → hook-onebot → hook
```

旁挂：`scripts/console-server.mjs`（127.0.0.1:3210，CSRF 头 `x-console-token` + Host/Origin 校验）；进程编排在 `scripts/manage.ps1`。

---

## 2. 为什么是两条通道

| | 读（数据库） | 写（进程内 Hook） |
|---|---|---|
| 权威性 | 数据库是事实源：历史、引用、撤回、媒体元信息、**服务器消息 ID** 都在 | 只有客户端内部发送函数能真正发消息 |
| 可靠性 | 崩溃重启不受影响，可补读；但只能轮询 | 实时；但注入失败/版本失配就完全不可用 |
| 取舍 | 入站**不用** hook 回调（`CallBackURL` 被指向 `/unused`，hook 也没有任何接收路由） | 下行只用 hook，发送前的账号/版本校验也靠 hook |
| 交叉验证 | hook 报告"当前进程打开了哪个 db_storage"（账号） | 发送后回读数据库，拿到 serverId 才算送达 |

结论：**hook 挂了只是发不出去，读不受影响**；数据面和控制面分离，也避免了"hook 回调丢消息/重复消息"这类常见坑。

---

## 3. 进程 / 端口 / 凭据

| 进程 | 端口（默认） | 作用 | 凭据来源 |
|---|---|---|---|
| `Weixin.exe` + `version.dll` | 30001 | 原生发送、health、表情 | `wechatagent-hook.token`（与 DLL 同目录） |
| `reader-api.py` | 5031（`ports.weflow`） | 读库 + SSE 推送 | `state/wechat-io-config.json#reader_token` |
| `hook-onebot.mjs` | 8766（`ports.adapter`） | OneBot 适配 + `/status` 网页 | `native-token.txt`、reader_token |
| `social-bridge.js` | 11229（`ports.onebot`）`/ws` | 反向 WS 服务端、缓冲、引擎 | `bridge-config.json` 内 token |
| DSH 插件 | 11230（`ports.dshPlugin`） | 会话/人格/工具/压缩 | `state/social-dsh-token.txt` |
| `console-server.mjs` | 3210 | 桌面控制台后端 | 控制台 CSRF token |

令牌生成：`project-config.mjs` 用 `crypto.randomBytes(32).toString('hex')` 写 `native-token.txt`（mode 0600）与 `wechat-io-config.json`；`checkNative` 强校验 hook baseUrl 必须是 `http:` + `hostname==='127.0.0.1'` + 无 user/pass/path/query，否则 `HOOK_LOOPBACK_REQUIRED`。

---

## 4. 连接层：注入 + 进程内 HTTP（发送通道）

### 4.1 上游与构建补丁

上游 [aixed/WeChat-Hook](https://github.com/aixed/WeChat-Hook)，commit 锁 `e905d07ade50d2c6472e4eb3bd4f3fe19cf662c6`，工程 `x64_Version_dll.vcxproj`，产物 `x64\Release\version.dll` → `state/hook/native/version.dll`，并写 `build.json`（upstream/commit/targetVersion/integration=`WeChatAgent-1`/initialization=`deferred-module-v1`/moduleWaitTimeoutMs/`sha256`）。

`scripts/build-hook.ps1` 用 `Replace-Checked`（找不到原文就报错）逐条打补丁：

| 原代码 | 改成 | 原因 |
|---|---|---|
| `g_httpServer->Start("0.0.0.0", …)` | `"127.0.0.1"` | 只允许本机访问 |
| `Patch_Revoke()` | 注释掉 | 不改变微信撤回行为 |
| `HideModuleFromPEB(hModule)` | 注释掉 | 便于诊断 |
| `CustomInit(hModule)` | `ScheduleWeChatAgentInit(hModule)` | 延迟到 `Weixin.dll` 就绪后再 Hook |
| `DllMain` 无 DETACH 处理 | 加 `CancelWeChatAgentInit()` | 卸载时取消等待 |
| `MH_Initialize() != MH_OK` 视为失败 | 容忍 `MH_ERROR_ALREADY_INITIALIZED` | 上游已初始化不报错 |
| `src/http_routes.cpp` | 重写为只调 `RegisterWeChatAgentRoutes` | 只暴露本项目路由 |
| 链接库 | 追加 `version.lib` | 代理 `version.dll` 导出 |

补充源文件：`wechatagent_hook.cpp`、`sticker_sender.cpp`、`sticker_trace.cpp`、`deferred_init.cpp`。

### 4.2 注入与启动

加载方式：**DLL 代理（搜索顺序劫持）**，不是 CreateRemoteThread / SetWindowsHookEx / 命名管道。

`scripts/launch-hook-wechat.ps1` 做的事：
1. 校验 `runtime.sender === 'wechat-hook'`、客户端文件版本 `== expectedVersion`（4.1.10.27）、Authenticode 签名 Subject 含 Tencent；
2. 不允许已有其它 `Weixin.exe`；hook 端口未被占用；
3. 把 `state/hook/native/version.dll` 复制到微信目录（hash 与 `build.json` 一致），同时复制 `state/hook/native-token.txt` → `wechatagent-hook.token`；
4. `pin-hook-client.ps1`：把 `WeixinUpdate.exe` 改名 `.disabled`，并给客户端目录加当前用户 `Deny(Write/Delete)` ACL——**防自动升级导致偏移错配**；
5. 启动：

```
Weixin.exe  StartPort=30001  CallBackURL="http://127.0.0.1:8766/unused"
```

`CallBackURL` 指向 `/unused` 是刻意为之：上游的入站回调通道**弃用**。

### 4.3 进程内初始化状态机（`deferred_init.cpp`）

`DllMain` 里不做事，`CreateThread` 起 `Initialize`：`GetModuleHandleExW(L"Weixin.dll")` 轮询 ≤30s → `CustomInit`（MinHook）→ `HttpServer::Start("127.0.0.1", port)` → 状态置 `ready`。状态机：`idle / waiting_for_module / initializing / ready / failed / cancelled`，通过 `startupState` 暴露，日志写 `logs/hook-init.log`：

`waiting_for_weixin_dll` → `weixin_dll_ready` → `http_listening` → `initialization_ready`；异常有 `module_wait_timeout` / `http_bind_failed` / `initialization_failed`。

`http_server.cpp` 里硬判 `if (host != "127.0.0.1" || !bind_to_port(...))`，绑定失败即视为未就绪。

### 4.4 进程内 HTTP 接口

鉴权：`Authorization: Bearer <64 hex>`，常量时间比较；token 从 **DLL 同目录** `wechatagent-hook.token` 读一行；`set_payload_max_length(65536)`；未知路由统一 404 `{}`。

| 路由 | 关键校验 | 响应 |
|---|---|---|
| `GET /WeChatAgent/health` | token | `{backend, integration, version, pid, databaseAccounts, nativeStickerSend, initialization, startupState}` |
| `POST /SendTextMsg` | token + `X-WeChatAgent-Account` + 版本 + 唯一账号；`wxidorgid` ≤256、`msg` ≤16000；`timed_mutex` try_lock 1s | `{"ret":0,"retmsg":"accepted"}`（**仅受理**）；409 版本/账号不匹配；429 Busy |
| `POST /SendStickerMsg` | 同上 + 路径必须在 `state/stickers/outgoing`、文件名==md5、magic+MD5(BCrypt)、≤8MB | `accepted` / 400 |
| `POST/GET /WeChatAgent/sticker-trace` | 同上 | 原生表情发送探测结果 |

版本判断：`CoreVersion()` 读 `Weixin.dll` 的 `GetFileVersionInfoW`，**硬编码要求 4.1.10.27**。

### 4.5 账号识别（不看数据库）

`DatabaseAccounts()`：`NtQueryInformationProcess(ProcessInformation=51)` 枚举本进程句柄 → `GetFinalPathNameByHandleW` → 只认路径含 `\db_storage\` 的 `contact\contact.db(-wal)`、`session\session.db`、`message\message_*` → 取上一级目录名（即 `wxid_xxx_abcd`）。要求数量恰为 1，且等于请求头里的账号。

### 4.6 Node 侧监督与错误码

`HookOneBot.checkNative()` 顺序：
1. reader `GET /api/v1/reader/status` → 要求 `backend==='weflow-cli-nt'`、有 `ownWxid`、有 `accountDirectory`；
2. hook `GET /WeChatAgent/health`（超时 `requestTimeoutMs` 5000）；
3. 判 `integration/backend` → `REVIEWED_HOOK_BUILD_REQUIRED`；
4. 判 `version==4.1.10.27` → `HOOK_VERSION_MISMATCH`；
5. 判 `databaseAccounts[0] === reader.accountDirectory.toLowerCase()` → `HOOK_ACCOUNT_NOT_READY`。

错误码映射：`ECONNREFUSED→HOOK_NOT_LISTENING`、超时→`HOOK_HEALTH_TIMEOUT`、JSON 错→`HOOK_HEALTH_INVALID_RESPONSE`、重试超时→`HOOK_INITIALIZATION_TIMEOUT`（对应 DLL 等 30s）。`waitForNative` 只对 NOT_LISTENING/HEALTH_TIMEOUT 重试（35s/250ms）；`start()` 后 5s 常驻 healthTimer；OneBot 断线 1500ms 重连。

进程编排 `scripts/manage.ps1`：按序起 `reader` → （先 `node hook-onebot.mjs --check`）→ `bridge` → `adapter`；`runtime.json` 记 pid+exe+marker（不认识的不杀）；TCP 700ms 探端口；日志 `state/logs/*.stderr.log`。`console-server.mjs` 用 `:8766/status` 的 `ob_connected/hook_connected/hook_account_verified/reader_connected/version/last_error` 汇总"是否就绪"。

---

## 5. 读取层：解密本地库 + 轮询

### 5.1 凭据链路

```
Weixin.exe 4.1.10.27
  └ wx_key.dll（外部组件，公开仓库 404，安装器内置）
       InitializeHook(pid) → PollKeyData(buf,128) → GetStatusMessage → CleanupHook
       轮询 ≤180s 直到 ^[0-9a-fA-F]{64}$
  └ scripts/reader_setup.py::capture_key
       进程识别：CreateToolhelp32Snapshot + QueryFullProcessImageNameW
       失败码：WECHAT_MULTIPLE_PROCESSES / WECHAT_PROCESS_IDENTITY_UNCLEAR / READER_KEY_COMPONENT_MISSING
       校验：verify_database()（page-1 HMAC）
       保存：CryptProtectData → WeFlow-config.json: decryptKey = "userdpapi:<base64>"
```

即：**首次配置时靠外部 DLL 取一次密钥，之后只用 DPAPI 保护的那串**。`local_secret()` 用 `CryptUnprotectData` 解；旧的 `safe:` 前缀直接拒绝。公开源码缺 `wx_key.dll` 时只能手填密钥。

> 说明：仓库 `SECURITY.md`、`nt_decrypt.py` 头注释均声明"不获取凭据、不发现进程、不扫描内存"——扫描发生在未分发的 `wx_key.dll` 内部。

### 5.2 解密参数与校验

微信 4.x 库是 SQLCipher 4：页 4096、保留区 80 字节（16 IV + 64 HMAC）、AES-256-CBC、HMAC-SHA512、PBKDF2-HMAC-SHA512 **256000** 次。

`verify_passphrase_native()`（纯标准库，不依赖 sqlcipher3）：

```
salt     = page[:16]
mac_salt = salt XOR 0x3a
key      = PBKDF2-HMAC-SHA512(passphrase, salt, 256000, 32)
mac_key  = PBKDF2-HMAC-SHA512(key, mac_salt, 2, 32)
body_end = 4096 - 80 + 16 = 4032
HMAC-SHA512(mac_key, page[16:4032] || LE32(1)) == page[4032:4096]
```

打开：`sqlcipher3`，`PRAGMA key = "x'<key_hex><salt_hex>'"`（原始密钥模式）；**每个分片**用自己的 16 字节头 salt 重新 PBKDF2（`nt_common.derive_database_key`），失败回退配置对。逐分片 `SELECT count(*) FROM sqlite_master` 验活，失败标 `KEY_REJECTED` / `OPEN_FAILED`，reader 对 failures 直接报错（不静默降级）。连接后 `PRAGMA query_only=ON`，**全程只读、不落明文副本**。

### 5.3 读哪些库表

| 目标 | 路径 | 说明 |
|---|---|---|
| 账号根 | `dbPath` 含 `db_storage` 则用它，否则 `dbPath/<myWxid>` | `myWxid` 来自 `state/weflow/WeFlow-config.json` |
| 消息 | `<account>/db_storage/message/message_0.db` + `message_*.db` | 排除 `message_fts.db`、`message_resource.db` |
| 会话表 | `Msg_<md5(talker)>` | 列 `local_id, server_id, local_type, real_sender_id, create_time, message_content` |
| 发言人 | 同分片 `Name2Id(rowid → user_name)` | 群正文前缀 `wxid...:` 只剥 `Name2Id` 认识的 id |
| 联系人 | `contact/contact.db` 的 `contact` 表 | `COALESCE(NULLIF(remark,''), NULLIF(nick_name,''), NULLIF(alias,''), username)` |
| 资源 | `message/message_resource.db` → `MessageResourceInfo.packed_info` | 按 `message_svr_id + message_local_id + message_create_time` 查 |
| 附件 | `<account>/msg/attach/<md5(talker)>/<YYYY-MM>/Img/<md5>{.dat,_h.dat,_t.dat}` | 见 5.6 |

> 源码里没有"按微信版本切路径"的逻辑；4.1.10.27 只出现在 `hook.expectedVersion` 与 `hook-onebot.mjs` 的硬校验里。

### 5.4 内容解码（全部 XML + zstd，无 protobuf）

- BLOB 内容先看 zstd 魔数 `28 B5 2F FD` → `zstandard` 解压 → UTF-8
- `local_type & 0xFFFFFFFF == 49` 是 appmsg，`apptype = local_type >> 32`：

| apptype | 含义 | apptype | 含义 |
|---|---|---|---|
| 4/5 | 链接 | 33 | 小程序 |
| 6 | 文件 | 57 | **引用** |
| 19 | **合并转发** | 63 | 直播 |
| 2000/2001 | 转账/红包 | — | — |

- 非 appmsg：3 图片、34 语音（不转写）、42 名片、43 视频、47 表情、48 位置、10000 系统消息（撤回/入群等）
- XML 取值：`_xml_block` / `_xml_text`（起始标签禁含 `/` 防自闭合误配、`html.unescape` 解实体、超长截断留省略号）
- **引用** `wechat_quote.py`：`QUOTE_TYPE=(57<<32)|49`；`title` 是回复正文，被引原文在 `refermsg/{fromusr,chatusr,type,content,svrid,createtime}`；群里 `fromusr` 是房间，引用人取 `chatusr`；深度 ≤2
- **合并转发** `wechat_forwarded.py`：`FORWARD_TYPE=(19<<32)|49`；`recorditem → datalist/dataitem[...]`；递归 ≤3 层、≤50 条、≤512KB、≤6000 字；禁 DOCTYPE/ENTITY
- **拍一拍** `PAT_TYPE=(62<<32)|49`：要求 `pattedusername == 自己` 且 actor ≠ 自己，否则丢弃
- 非文本一律给占位文本（`[图片]` / `[表情包]` / `[拍一拍] 对方刚刚拍了拍你。` / `[合并转发聊天记录] …`），**绝不返回空串**

### 5.5 轮询与推送

`Reader.poll()` 后台线程：

```
since = 启动时刻
loop:
  for talker in selected_talkers():          # 白名单
      msgs = messages(talker, limit=0, from_time=max(started_at, since-3))
      for m in reversed(msgs): 组装 payload → 去重 → 各订阅队列 put_nowait
      since = max(newest)
  wait(1s)                                   # 轮询间隔 1 秒
```

- 启动**不回放历史**（`started_at` 兜住），只留 3 秒重叠
- 去重键 `rawid = sha256([talker, serverId, localId, createTime])`，内存 `OrderedDict` 上限 5000
- 推送事件：`{event:"message.new", sessionId, sessionType, rawid, groupName, sourceName, senderName, talkerId, content(≤4000), type, timestamp, pat?, forwardedRecord?, quoteReply?, image?}`
- 对外 SSE：`GET /api/v1/push/messages`（chunked `text/event-stream`，2s 心跳，单客户端队列 500，满了踢客户端）
- 其余只读端点：`/api/v1/sessions`、`/contacts`、`/messages`、`/reader/status`、`/images/<64hex>`、`/stickers…`；POST：`/stickers/labels`、`/events/retry`、`/images/<id>/retry`
- 鉴权：`Authorization: Bearer <reader_token>`，GET 额外兼容 `?access_token=`；日志不打 URL（token 可能在 query 里）
- 越权：`messages()` / `image_talker_allowed()` 每次重读配置，不在白名单抛 `PermissionError` → 403

### 5.6 媒体

图片 `.dat` V2 容器：

| 项 | 值 |
|---|---|
| 魔数 | `07 08 56 32 08 07`（`\x07\x08V2\x08\x07`） |
| 头 | `struct.unpack('<6sLLx')` → `aes_size, xor_size` |
| 算法 | `AES-128-ECB` 解前 `aes_size`（PKCS7）+ 尾部 `xor_size` 单字节 XOR → 拼 → MIME 探测 |
| 密钥① | `WeFlow-config.json.imageAesKey`(hex32) / `imageXorKey` |
| 密钥② | `%APPDATA%/Tencent/xwechat/net/kvcomm/key_<code>_*.statistic` → `md5(f"{code}{wxid}")[:16]`，用真实 `_t.dat` 头验证 |
| 上限/并发 | 8MiB；子进程 65s；future 70s；2 线程 |
| 产物 | `state/media/<sha256>.json`（含 b64），索引上限 1000 条 |

表情：先本机缓存；`allowStickerCdn` / `allowStickerCdnAlias` 默认 **false**，开启才回源 `wxapp.tc.qq.com`（强制 HTTPS、禁重定向、≤8MiB/20s、解密后须与原 XML 的 md5 相符）。

送模型：DSH 插件转成原生附件（≤4 张/批、最长边 1280、单张 ≤768KiB、共 75s），轮次结束追加 `image/offload` 卸载。

---

## 6. 桥接层：OneBot v11 作为内部契约

### 6.1 入站方向

`hook-onebot.mjs` 是 **OneBot 客户端**（反向 WS 主动拨号），`social-bridge.js` 是 **服务端**（`ReverseOneBotServer` 自实现握手/掩码/分片/心跳，单连接，echo 关联请求，Bearer + `timingSafeEqual`）。

```
reader SSE → hook-onebot.receiveSse()（35s watchdog，单行 ≤256KB）
           → incoming()：只认 message.new、type ∈ {1,3,47,拍一拍,49,转发,引用}、非 isSend、非自己、白名单
           → OneBot v11 event（message_id=rawid；群带 at segment；图片 wechatagent://image/<id>）
           → flush() 前再 reload() 复查白名单 → WS 发送
```

合成 ID：`id = sha256(x)[:8] 大端 % 2147483647 + 1`；私聊用 wxid，**群聊用群显示名（去尾部 `(n)`）**——白名单与 DSH session 键因此稳定。

### 6.2 出站方向与回执闭环

```
SocialEngine 决策
 → adapter.sendText/OneBot action（send_private_msg/send_group_msg，带 wechatagent_delivery_id）
 → hook-onebot.action()：白名单 → resolveTarget()（合成 ID → 真 wxid，查 /api/v1/sessions）
 → 基线 localId 落盘（TextDeliveryStore，state/text-deliveries/）
 → POST /SendTextMsg（Bearer native-token + X-WeChatAgent-Account）
 → 400ms 轮询 /api/v1/messages：新 localId + isSend + 文本全等 + createTime ≥ startedAt-30s + serverId>0
 → confirmed（receipt='wechat-server-id', delivered='database-confirmed'）
 → 否则 18s 超时 → TEXT_DELIVERY_UNCONFIRMED（不重发、也不冒充送达）
```

关键设计：**hook 的 HTTP 200 只代表"调用被接受"，数据库里出现服务器 ID 才代表"真的发出去了"**。

### 6.3 缓冲 / 去抖 / 限流 / 幂等

| 机制 | 参数（默认） |
|---|---|
| 持久缓冲 | `state/social-messages.json`，每聊天 300 条，原子 rename |
| 去抖 | `social.batch_ms = 3000` |
| 直呼判定 | 私聊 / 拍一拍 / `@自己` / 唤醒词 / 引用自己发言 → 立即；否则走后 |
| 群回复模式 | `hybrid` / `mention`（`modeFor()`） |
| 限流 | 群 15s、私聊 1s 最小间隔；3 条/分钟；10 条/10 分钟 |
| 并发 | `hook.maxConcurrentSends = 4`；`activeActions > 8` → `SENDER_BUSY`；同会话串行 |
| 幂等 | `deliveryId = sha256([key, self_id, throughId])`；part 状态 `queued→sending→confirmed|unconfirmed|failed|expired`；重放只核对回执，**绝不二次提交** |
| 防环 | `recentOutgoing` 指纹 60s；`recentIncoming` 按 `message_id+指纹`；自己的 wxid 丢弃 |
| 重启 | 从 `pendingReplies` 恢复决策，30s 后重试；仍只走回执核对 |
| 行为锁 | 聊天里要求改人格/改规则的指令被 `isBehaviorChangeCommand()` 拦下，不进模型 |

---

## 7. 模型层（DSH）

- DSH 是独立桌面应用（Cordis/Electron 运行时），插件以本机 HTTP RPC 暴露：`GET /health /sessions /dsh-catalog /extensions /skills`，`POST /followup /configure /compact /context-maintenance /sticker-pool-review`，Token `state/social-dsh-token.txt`，逐请求 `timingSafeEqual`
- **能力握手下限**：`/health` 必须返回 `contextMode:'native-session-v1'`、`behaviorPolicy:'local-config-only-v1'`、`imageInput:'native-attachment-v1'`、`sessionLifecycle:'archive-rotation-v1'`、`turnRecovery:'cancel-on-timeout-v1'`，外加 `project==='WeChatAgent'` 与相同 projectRoot
- **会话**：`session id = social-<sha256(scope+conversationKey)[:32]>`；`ctx.agents.get` → `resume` → `create`；归档后 `generation+1` 换代；映射写 `state/accounts/<id>/dsh-sessions.json`（v2）
- **人格**：以本机 `state/bridge-config.json` 快照为准；请求里的 persona 只做一致性校验，不一致 403 `BEHAVIOR_CHANGE_NOT_ALLOWED`；首次/换代/成功压缩后各补一次初始化（`agent/pre-step` 前置 `user/message`，`surfaceOp: replace` 清理旧初始化）
- **工具限制**：preset `wechat-social` 为**空工具允许列表** + 隔离压缩组；`conversationAccess()` 产出逐会话白名单，未授权工具不进工具声明；群聊原文无法改工具权限
- **协议**：模型只输出 `RESPOND: <一条短回复>` 或 `SILENT`；`parseSocialDecision()` 只取 RESPOND 段，SILENT 则标记已处理不发送；格式非法触发一次校正回合；只取最后一条 assistant 消息（含 tool call 不算回复）
- **超时**：回合 120s → `agent.cancel({kind:'user'})` + 清 `pending`；按 `batchId` 缓存幂等结果

---

## 8. 安全与权限

**六处独立白名单检查**：
1. `hook-onebot.incoming()/flush()/send()/action()`（白名单 `wechat.whitelist.{groups,private}`，值为数字 OneBot ID，`project-config.mjs` 强校验 `/^\d+$/`）
2. `social-bridge.js` 的 `allowedGroups/allowedPrivate`
3. `conversation-policy.mjs` 的 `allowedConversation()`
4. `social-engine.js` 的唤醒判定、`modeFor`、行为变更拦截
5. 插件 `local-policy.mjs` + `social-tool-restrict.mjs`
6. `console-server.mjs` 的配置校验（人格名、聊天 ID、频率区间、端口互斥、路径穿越）

**通道安全**：全部只绑 127.0.0.1；DLL 内硬判 host；64-hex 常量时间比较；hook 校验版本三重锁（`build.json.targetVersion` / DLL 内硬编码 / Node `expectedVersion`）；账号锁（句柄枚举 == reader 账号目录）；表情文件路径白名单 + MD5 + 大小/魔术数；微信目录 ACL pin + 禁用 updater + 安装包签名校验；控制台日志用 `safeText()` 把 token 与 64-hex 串替换为 `[已隐藏]`。

**隐私与合规**：消息一旦交给模型即外发到配置的模型服务；注入式 Hook 违反微信用户协议、有封号风险；仓库自带免责声明。

---

## 9. 风险与限制

- **版本硬锁**：微信升级即失效（偏移与 SQLCipher 参数需重新适配），`pin-hook-client` 只是降低概率
- **发送不确定性**：`accepted` ≠ 送达；超时是 `unconfirmed`，不做自动重发（避免重复轰炸）
- **读取是轮询**：1s 粒度；进程重启不回放历史（刻意的安全取舍）
- **公开源码不完整**：见附录 B
- **性能**：每次查询新建 sqlcipher 连接、每分片建连；消息表 `Msg_*` 按会话建表，群多时查询面变大

---

## 10. 若要复刻，需要准备什么

1. 授权可用的第三方 Hook 源码（对应微信 4.1.10.27）+ VS C++ 工具链 → `npm run hook:build`
2. 对应版本微信客户端副本 + `wx_key.dll`（取库密钥）
3. Node 22.13+ / Python 3.10+（`sqlcipher3、cryptography、zstandard、pycryptodome、Pillow、imageio-ffmpeg`）
4. DSH 桌面端 0.2.0-rc.2 并启用本项目插件
5. 逐项验收：`hook:check` → reader `--check` → 白名单 → 首发消息看 `serverId` 回执

---

## 附录 A：关键文件索引

| 层 | 文件 |
|---|---|
| 原生 Hook | `scripts/native-hook/{wechatagent_hook.cpp,deferred_init.cpp,http_server.cpp,sticker_sender.cpp,sticker_trace.cpp}`、`scripts/build-hook.ps1`、`scripts/launch-hook-wechat.ps1`、`scripts/pin-hook-client.ps1`、`scripts/configure-hook.mjs` |
| 读取 | `scripts/reader-api.py`、`scripts/reader_setup.py`、`components/weflow-cli/scripts/{nt_decrypt.py,nt_common.py}`、`scripts/{wechat_media.py,resolve-wechat-image.py,wechat_quote.py,wechat_forwarded.py}` |
| 桥接 | `scripts/hook-onebot.mjs`、`scripts/text-delivery-store.mjs`、`components/qq-bridge/src/{social-bridge.js,onebot/reverse-ws-server.js,adapters/wechat/wechat-onebot-adapter.js,core/*}` |
| 模型 | `packages/dsh-social-bridge-plugin/{native-context.mjs,local-policy.mjs,cordis.patch.yml}` |
| 编排/控制台 | `scripts/manage.ps1`、`scripts/console-server.mjs`、`public/console/*` |
| 文档 | `docs/{WECHAT_HOOK.md,DSH_SESSIONS.md,DSH_CHAT_ACCESS.md,TEXT_DELIVERY.md,IMAGE_INPUT.md}` |

## 附录 B：证据强度与未验证项

- **我直读全文**：`reader-api.py`（含 `serve()` / `poll()` / handler，故 SSE 路由与 1s 间隔为实证）、`nt_decrypt.py`、`nt_common.py`、`wechatagent_hook.cpp`、`deferred_init.cpp`、`hook-onebot.mjs`、`reverse-ws-server.js`、`wechat-onebot-adapter.js`、`build-hook.ps1`、`launch-hook-wechat.ps1`、`config/wechatagent.example.json`、`docs/WECHAT_HOOK.md`、`docs/DSH_SESSIONS.md`
- **由子任务读取、我未二次核对**：`reader_setup.py`（`capture_key` 三个接口名与 180s）、`wechat_media.py`/`resolve-wechat-image.py`（V2 容器与 AES-128-ECB/XOR）、`wechat_quote.py`/`wechat_forwarded.py`（结构与上限）、`sticker_sender.cpp`（`EmojiFactory=0x1B09F90` 等 RVA）、`pin-hook-client.ps1`（改名 updater + Deny ACL）、`manage.ps1`（启动顺序/`runtime.json`）、`console-server.mjs`、`social-engine.js`/`session-router.mjs`/`native-context.mjs`（缓冲/限流/会话/人格细节）
- **推断**：上游 `wx_send.h`/`global.h`/`version_proxy.cpp` 不在仓库，`SendText` 的具体偏移与 `StartPort` 解析属上游实现；`wx_key.dll` 内部的取 key 方式（内存扫描）不可见
- **仓库不含**：Hook 上游源码与编译产物、`wx_key.dll`、微信客户端、DSH 程序与 `@deepseek-ai/dsh-*`、安装器、开发回归测试、私有 `state/` 运行数据
