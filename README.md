# WXBOT — 本地微信 AI 助手（读取本地库 + DeepSeek 回复 + Hook 发送）

[![CI](https://github.com/Gusion1017/WXBOT/actions/workflows/ci.yml/badge.svg)](https://github.com/Gusion1017/WXBOT/actions/workflows/ci.yml)
[![release](https://img.shields.io/badge/release-v0.1.0-blue)](https://github.com/Gusion1017/WXBOT/releases/latest)
![platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-blue)
![Node.js](https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=node.js&logoColor=white)
![Python](https://img.shields.io/badge/Python-3.12-3776AB?logo=python&logoColor=white)
![UI](https://img.shields.io/badge/UI-WinForms%20%C2%B7%20.NET%20Framework%204.x-512BD4)
![license](https://img.shields.io/badge/license-MIT-green)

**Windows 本地微信 AI 助手（Python + Node.js + WinForms）**：只读解密微信 PC 端本地 SQLCipher 数据库获取新消息，经 OneBot v11 桥接层做缓冲 / 去重 / 白名单 / 限流，调用 DeepSeek 生成拟人回复，再通过固定版本客户端 + 预编译注入 Hook 以**强回执**（回读 `serverId`）发回微信；附 WinForms 单 exe 桌面版（会话 / 消息 / 状态 / 设置 / AI 人格 / 表情包）。所有服务只监听本机回环地址。

A local Windows WeChat AI assistant built with **Python + Node.js + WinForms**: it reads new messages from the local WeChat PC SQLCipher database in read-only mode, passes them through an OneBot v11 bridge (buffering, debounce, whitelist, rate limiting), generates human-like replies with DeepSeek, and sends them back through a pinned WeChat client + a prebuilt injected hook with **strong receipts** (reads back the `serverId`). It ships with a single-exe WinForms desktop UI (chats, messages, status, settings, AI persona, stickers). Every service binds to loopback only.

> 设计目标：**数据不出本机、行为可审计、默认克制**。
> 读取层只读（`PRAGMA query_only=ON`），不产生明文库副本；发送默认关闭，只在白名单会话生效，先落盘再提交、`unconfirmed` 不重发；所有服务只绑 `127.0.0.1`，每个通道独立随机 64-hex token。
>
> Design goals: **data stays local, behaviour stays auditable, defaults stay conservative.** The reader is strictly read-only (`PRAGMA query_only=ON`) and never writes a plaintext database copy; sending is disabled by default, only ever targets the whitelist, is journaled before dispatch, and `unconfirmed` sends are never retried; every service binds to `127.0.0.1` and uses its own random 64-hex token.

> 本文件同时包含**简体中文**与 **English** 两个版本，向下滚动即可查看对应内容。
> This README contains **both Simplified Chinese and English**; scroll down for your language of choice.

---

## 简体中文

### 功能特性

- **读取层（只读）**：账号探测 → 密钥 HMAC 校验 → SQLCipher 分片只读打开 → 会话 / 联系人 / 消息解码（引用、合并转发、拍一拍、占位文本）；`PRAGMA query_only=ON`，不产生明文库副本；密钥以 DPAPI 保护串多账号保存。
- **增量推送**：1s 水位轮询 + 去重 + SSE（2s 心跳），启动不回放历史；白名单外会话请求返回 403。
- **OneBot v11 桥接**：反向 WS 服务端（单连接、Bearer token、echo、1MB 帧上限）+ 业务引擎（缓冲 / 去抖 / 直呼（私聊、@、唤醒词、引用自己）/ 白名单二次校验 / 限流 / 幂等 / 防环 / 行为锁 / pending 重放）。
- **AI 回复**：DeepSeek（OpenAI 兼容）直连；人格文件 + 每会话记忆；输出协议仅 `SILENT` / `RESPOND:`，聊天内容包 `<untrusted_chat>` 防提示注入，格式异常只校正一次。
- **会话记忆**：每会话最近 10 条短期记忆，超限交给模型整理为长期记忆；长期记忆按 7 天半衰期时间加权；JSON 为数据源并生成 Markdown。
- **原生表情包**：设置页上传 jpg / png / gif 统一转 GIF、填写名字与发送时机；模型在 `RESPOND` 后附 `STICKER: id`，经 Hook 以原生表情发送并回读确认。
- **发送层（可选 Hook 通道）**：固定版本微信 4.1.10.27 + 预编译补丁版 `version.dll`；baseline → 落盘 → `SendTextMsg` → 回读 `serverId` 强回执；`unconfirmed` 不重发；版本 / integration / 账号三重锁防错发。**默认关闭**。
- **稳定性**：supervisor 统一管理 reader / bridge / adapter / console（health 5s、连续 3 次失败重启、退避 2–30s）；bridge 重启后 pending 只核对回执不重发。
- **桌面版**：WinForms 单 exe（不依赖浏览器 / Electron / WebView），深色界面，内置会话 / 消息 / 状态、内嵌设置中心、微信登录卡、表情管理；关闭窗口即停服无残留；支持 `--start / --stop / --status / --settings / --selftest`。
- **本机只读 API**：`127.0.0.1:3210`（桌面版数据接口），CSRF + Host/Origin 校验，无网页界面；读取层 API 契约见 [docs/READER_API.md](./docs/READER_API.md)。

> **想仿造这个项目？** 先读 [WXBOT 复刻开发指南](./docs/REPLICATION_GUIDE.md)：功能、每层实现原理、开发流程、验收与踩坑都整理成了可照着做的完整手册。

### 环境要求

| 用途 | 要求 |
|---|---|
| 运行 | Windows 10 / 11 x64；微信 PC：读取层实测 **4.1.15.13**，发送层固定版客户端 **4.1.10.27**（Hook 兼容版本） |
| 后台服务 | Node.js ≥ 22.13（CI 用 24）；Python 3.12（项目内 `.venv`） |
| 桌面版 | Windows 自带 .NET Framework 4.x（用自带 `csc` 编译，无需 SDK / NuGet） |
| 外部资产（不随仓库分发） | `state/tools/wx_key/wx_key.dll`（一次性捕获库密钥）、`state/hook/native/version.dll`（Hook 发送）、`state/wechat-hook-client/`（固定版客户端）——获取与校验方式见 [docs/MAINTENANCE.md](./docs/MAINTENANCE.md) |

### 下载可执行文件

`WXBOT.exe` 是**构建产物**（WinForms 单 exe，约 1.2 MB），为保证仓库只含可审计源码而**不提交到仓库**（已写入 `.gitignore`），所以文件列表里看不到它。获取方式：

| 方式 | 说明 |
|---|---|
| **GitHub Release（推荐）** | 打开 [最新 Release](https://github.com/Gusion1017/WXBOT/releases/latest) 下载 `WXBOT.exe`，同目录附 SHA256 校验文件 |
| **GitHub Actions 构建产物** | 打开 [CI](https://github.com/Gusion1017/WXBOT/actions/workflows/ci.yml) 最新一次成功运行，在 **Artifacts** 下载 `WXBOT-win-x64` |
| **本地构建** | 仓库根执行 `npm run build:exe`（Windows 自带 `csc`，无需 SDK） |

> exe 只是桌面 UI 启动器，运行时仍需要本仓库目录 + Node.js / Python 环境 + 外部资产（固定版微信客户端、Hook DLL、`wx_key.dll`），详见 [docs/PACKAGING.md](./docs/PACKAGING.md)。

### 快速开始

```powershell
# 1) Python 环境
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt

# 2) Node 依赖 + 生成配置与各通道 token
npm install
npm run init

# 3) 健康检查（打印各端口监听状态与 token 权限）
npm run status

# 4) 读取层自检（密钥校验 + 库打开 + 会话/联系人）
.\.venv\Scripts\python.exe scripts\reader-api.py --check
npm run key:inspect     # 多账号密钥诊断（HMAC 结果/捕获时间/来源，不输出密钥）

# 5) 启动/停止（supervisor 统一管理 reader → bridge → adapter → console，崩溃自愈）
npm start
npm run stop

# 6) 桌面版 exe（WinForms 单 exe，不经过浏览器）
npm run build:exe       # 编译生成项目根 WXBOT.exe（大小以构建脚本输出为准）

# 7) 测试
npm test                # Node 单测：109 个
npm run test:py         # Python 单测：51 个（含合成 SQLCipher 库集成测试）
```

### 首次配置（一次性）

```powershell
# a) 从 WeChatAgent 官方 release 取 wx_key.dll（已做 SHA256 校验），放入：
#    state\tools\wx_key\wx_key.dll（源/哈希记录在 state\tools\wx_key\manifest.json）
# b) 捕获密钥（需要按提示在微信里「退出登录 → 重新登录」触发一次）：
.\.venv\Scripts\python.exe scripts\capture-key.py --capture
# c) 校验已保存密钥
.\.venv\Scripts\python.exe scripts\capture-key.py --verify
```

> 说明：微信 4.x 的库密钥只在登录动作时写入内存，`wx_key.dll` 需要一次登录事件才能捕获；
> 密钥仅以 `userdpapi:` 保护串落盘，日志不出现明文。

### 使用说明

| 入口 | 用法 |
|---|---|
| 桌面版 | 双击 `WXBOT.exe`：会话 / 消息 / 状态，自动启动后台服务；顶栏单一按钮启动 / 停止；「设置」为主窗口内嵌面板（自动回复、白名单、回复频率、AI 人格、API Key / 连接测试、发送通道、表情包） |
| 桌面版命令行 | `WXBOT.exe --start` / `--stop` / `--status` / `--settings` / `--selftest` |
| 后台服务 | `npm start` / `npm run stop` / `npm run restart` / `npm run status` |
| 只读 CLI | `node scripts/wxbot-cli.mjs sessions\|contacts\|messages\|images\|keys` |
| 发送自检 / 手工发送 | `node scripts/sender-adapter.mjs --check` / `--status` / `--send --target <..> --text <..> --yes`（需 `sender.enabled=true`） |
| 本机只读 API | `127.0.0.1:3210`，接口与安全说明见 [docs/CONSOLE.md](./docs/CONSOLE.md) |

> 桌面版「启动微信并登录」会自动检测扫码 / 账号 / Hook 版本；微信是单实例，启动固定版客户端前需退出其它微信（登录后可再开）。关闭窗口会自动停止 supervisor 与全部后台进程，无残留。

### 项目结构

```text
WXBOT.exe                 桌面版 exe（构建产物，gitignore；npm run build:exe 生成）
.github/workflows/ci.yml  GitHub Actions：Node / Python 单元测试
LICENSE                   MIT 代码许可
config/app.example.json   配置样例（不含机器路径）
config/app.json           本地配置（gitignore）
scripts/lib/core/         配置 / 令牌 / 路径 / 日志 / 原子写 / 私有文件
scripts/lib/reader/       账号探测 / 密钥 / 解码 / DB / 图片（Python）
scripts/lib/send/         Hook 客户端 / 发送引擎 / 回执状态机
scripts/lib/bridge/       OneBot 服务端 / ID / 适配器 / 业务引擎
scripts/lib/model/        模型客户端
scripts/lib/memory/       会话记忆
scripts/lib/sticker/      表情包存储与策略
scripts/lib/console/      控制台 API 安全工具
scripts/project-config.mjs 配置校验 + 令牌生成 + 端口健康检查 CLI
scripts/manage.ps1        进程编排入口（start / stop / status，WMI 分离启动 + taskkill /T）
scripts/supervisor.mjs    M7 进程监控 / 崩溃自愈
scripts/capture-key.py    一次性取密钥（wx_key.dll → HMAC 校验 → DPAPI）
scripts/reader-api.py     读取层 HTTP 服务
scripts/bridge.mjs        OneBot 桥接服务（11229 / ws）
scripts/adapter.mjs       I/O 适配器（reader SSE ↔ OneBot ↔ Hook 发送）
scripts/console-server.mjs 本机只读 API（127.0.0.1:3210）
scripts/wxbot-cli.mjs     只读 CLI
scripts/sender-adapter.mjs 发送自检 / 状态 / 手工发送 CLI
scripts/desktop/          桌面版 WinForms 源码（单 exe，无浏览器）
scripts/build-desktop.ps1 编译桌面版 -> 项目根 WXBOT.exe
scripts/dev/              开发 / 验收工具（库结构诊断、SSE / 媒体自检、soak）
docs/                     接口契约 / 阶段记录 / 复刻指南 / 来源声明（见 docs/INDEX.md）
docs/reference/           参考材料（同类项目实现手册、WeChatAgent 架构与管线报告）
state/                    运行时数据（gitignore）
tests/node/               Node 单测
tests/python/             Python 单测（含合成 SQLCipher 库集成测试）
```

### 接口与文档

- 文档索引：[docs/INDEX.md](./docs/INDEX.md)
- 读取层：[docs/READER_API.md](./docs/READER_API.md)（`/api/v1/reader/status`、`/sessions`、`/contacts`、`/messages`、`/push/messages` SSE、`/events/retry`、`/images/<id>`）
- 本机只读 API：[docs/CONSOLE.md](./docs/CONSOLE.md)
- 复刻指南：[docs/REPLICATION_GUIDE.md](./docs/REPLICATION_GUIDE.md)
- 第三方与来源声明：[docs/THIRD_PARTY.md](./docs/THIRD_PARTY.md)

### 安全底线

- 所有服务只绑 `127.0.0.1`；每个端口独立随机 64-hex token，常量时间比较，空值永远拒绝。
- 读取层只读（`PRAGMA query_only=ON`），不产生明文库副本；连接常驻，退出统一关闭。
- 密钥只以 DPAPI 保护串落盘（`state/keys.json`），日志脱敏：token / 64-hex / 聊天正文一律替换。
- 发送默认关闭；启用后仅白名单会话，先落盘再发送，`unconfirmed` 不重发；版本 / 账号不符直接拒绝。
- 聊天内容一旦送往模型厂商即数据外发，需自行告知同聊人；模型输出包在 `<untrusted_chat>` 中，降低提示注入风险。

### 测试与 CI

```powershell
npm test         # Node 单元测试（109 个用例，Windows）
npm run test:py  # Python 单元测试（51 个用例，含合成 SQLCipher 库）
```

CI（GitHub Actions）在 `windows-latest` 上跑同一套测试（Node 24 + Python 3.12），并额外编译桌面版 exe、上传 `WXBOT-win-x64` 构建产物；见 [.github/workflows/ci.yml](./.github/workflows/ci.yml)。

### 仓库范围与外部资产

本仓库**只提交源码、文档与测试**：`state/`（固定版微信客户端、Hook 二进制、密钥、日志等运行时数据）、本机配置 `config/app.json`、构建产物 `WXBOT.exe` 均已 gitignore，exe 通过 [Release](https://github.com/Gusion1017/WXBOT/releases/latest) 或 CI Artifacts 分发。外部资产获取方式见 [docs/MAINTENANCE.md](./docs/MAINTENANCE.md)。

### 许可证与免责声明

- 代码以 [MIT License](./LICENSE) 发布（© 2026 Gusion1017）。第三方组件、参考实现与 UI 素材的来源 / 许可见 [docs/THIRD_PARTY.md](./docs/THIRD_PARTY.md)。
- `assets/whale-girl.png`（大肥鱼头像）为第三方 AI 生成素材，按 as-is 附带并保留原始来源声明；本项目不主张其版权、不授予再许可，如权利方主张会立即替换 / 移除。
- **仅个人学习与自用**：所有服务只监听本机回环地址、不对外提供服务。读取微信本地数据库、使用注入式 Hook 等行为可能违反微信用户协议并带来账号风控 / 封号风险，使用前请自行评估；请勿用于群发、营销或侵犯他人隐私。

---

## English

### Features

- **Read-only reader**: account discovery → key HMAC verification → read-only SQLCipher shards → sessions / contacts / messages (quotes, merged forwards, pats, placeholders). `PRAGMA query_only=ON`; no plaintext database copies; keys stored as DPAPI-protected strings per account.
- **Incremental push**: 1s watermark polling + dedupe + SSE (2s heartbeat), no history replay at startup; non-whitelisted conversations return 403.
- **OneBot v11 bridge**: reverse-WS server (single connection, Bearer token, echo, 1MB frame cap) + business engine (buffering, debounce, direct addressing, whitelist re-check, rate limits, idempotency, loop protection, behaviour lock, pending replay).
- **AI replies**: direct DeepSeek (OpenAI-compatible) API; persona file + per-chat memory; output protocol is `SILENT` / `RESPOND:` only, chat text wrapped in `<untrusted_chat>` against prompt injection, one format-correction retry.
- **Chat memory**: 10 short-term messages per chat, summarised into long-term memory when exceeded, 7-day half-life weighting; JSON source of truth plus generated Markdown.
- **Native stickers**: upload jpg / png / gif in the settings page (normalised to GIF), name each sticker and describe when to use it; the model may append `STICKER: id` after `RESPOND:` and the hook sends it as a native sticker, confirmed by reading back the message.
- **Optional send path (hook)**: pinned WeChat 4.1.10.27 client + prebuilt patched `version.dll`; baseline → journal → `SendTextMsg` → read back `serverId` (strong receipt); `unconfirmed` is never retried; version / integration / account triple lock. **Disabled by default.**
- **Stability**: a supervisor manages reader / bridge / adapter / console (5s health checks, restart after 3 consecutive failures with 2–30s backoff); after a bridge restart, pending deliveries are only re-checked, never re-sent.
- **Desktop app**: single WinForms exe (no browser / Electron / WebView), dark UI, chats / messages / status, in-window settings centre, WeChat login card, sticker manager; closing the window stops all services cleanly; `--start / --stop / --status / --settings / --selftest`.
- **Local read-only API**: `127.0.0.1:3210` for the desktop UI (CSRF + Host/Origin checks, no web UI). Reader API contract: [docs/READER_API.md](./docs/READER_API.md).

### Requirements

| Purpose | Requirement |
|---|---|
| Run | Windows 10 / 11 x64; WeChat PC 4.1.15.13 (reader, tested) and 4.1.10.27 (pinned client for the send hook) |
| Backend | Node.js ≥ 22.13 (CI uses 24); Python 3.12 (project `.venv`) |
| Desktop build | .NET Framework 4.x shipped with Windows (built with the bundled `csc`; no SDK / NuGet) |
| External assets (not in this repo) | `wx_key.dll` (one-shot DB key capture), `version.dll` (send hook), pinned WeChat client copy — see [docs/MAINTENANCE.md](./docs/MAINTENANCE.md) |

### Download

`WXBOT.exe` is a **build artifact** (single WinForms exe, ~1.2 MB) and is intentionally **not committed** (it is gitignored, so it does not appear in the file list). Get it via:

| Option | How |
|---|---|
| **GitHub Release (recommended)** | Download `WXBOT.exe` (plus a SHA256 checksum file) from the [latest release](https://github.com/Gusion1017/WXBOT/releases/latest) |
| **GitHub Actions artifact** | Open the latest successful [CI](https://github.com/Gusion1017/WXBOT/actions/workflows/ci.yml) run and download `WXBOT-win-x64` from **Artifacts** |
| **Build locally** | Run `npm run build:exe` at the repo root (uses the bundled Windows `csc`; no SDK needed) |

> The exe is only the desktop UI launcher — it still needs this repository, Node.js / Python, and the external assets (pinned WeChat client, hook DLL, `wx_key.dll`). See [docs/PACKAGING.md](./docs/PACKAGING.md).

### Quick Start

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
npm install
npm run init                # generate config + per-channel tokens
npm run status              # health check
.\.venv\Scripts\python.exe scripts\reader-api.py --check
npm start                   # supervisor: reader -> bridge -> adapter -> console
npm run build:exe           # build the desktop exe
npm test                    # Node tests (109 cases)
npm run test:py             # Python tests (51 cases)
```

### Usage

| Entry point | How to use |
|---|---|
| Desktop | Double-click `WXBOT.exe`: chats / messages / status, starts the backend automatically; one toolbar button starts / stops; **Settings** is an in-window panel (auto-reply, whitelist, rates, AI persona, API key / connection test, send channel, stickers) |
| Desktop CLI | `WXBOT.exe --start` / `--stop` / `--status` / `--settings` / `--selftest` |
| Services | `npm start` / `npm run stop` / `npm run restart` / `npm run status` |
| Read-only CLI | `node scripts/wxbot-cli.mjs sessions\|contacts\|messages\|images\|keys` |
| Send self-check | `node scripts/sender-adapter.mjs --check` / `--status` / `--send --target <..> --text <..> --yes` (requires `sender.enabled=true`) |
| Local read-only API | `127.0.0.1:3210` — see [docs/CONSOLE.md](./docs/CONSOLE.md) |

### Security & Privacy

- Every service binds to `127.0.0.1` only; each channel has its own random 64-hex token compared in constant time; empty tokens are always rejected.
- The reader is strictly read-only (`PRAGMA query_only=ON`) and never creates plaintext database copies.
- Keys are stored only as DPAPI-protected strings (`state/keys.json`); logs redact tokens, 64-hex strings and chat content.
- Sending is disabled by default; when enabled it only targets the whitelist, is journaled before dispatch, and `unconfirmed` sends are never retried.
- Chat content sent to a model provider leaves the machine — inform your chat partners; model output is wrapped in `<untrusted_chat>` to reduce prompt-injection risk.

### Project Structure

```text
scripts/lib/{core,reader,send,bridge,model,memory,sticker,console}/   core modules
scripts/{reader-api.py,bridge.mjs,adapter.mjs,supervisor.mjs,...}     service entry points
scripts/desktop/                                                        WinForms single-exe UI
scripts/dev/                                                            dev / acceptance tools
docs/                                                                   API contracts, stage records, replication guide
tests/node/, tests/python/                                              unit / integration tests
.github/workflows/ci.yml                                                GitHub Actions CI
```

### What's Not in the Repo

Source code, docs and tests only. `state/` (pinned WeChat client, hook binaries, keys, logs) and the local `config/app.json` are gitignored. The built `WXBOT.exe` is not committed either — grab it from the latest release or CI artifacts, or build it with `npm run build:exe`. External assets are described in [docs/MAINTENANCE.md](./docs/MAINTENANCE.md).

### License & Disclaimer

- Code under the [MIT License](./LICENSE) © 2026 Gusion1017. Third-party components / references / assets are listed in [docs/THIRD_PARTY.md](./docs/THIRD_PARTY.md).
- `assets/whale-girl.png` is third-party AI-generated art included as-is with its provenance notice; no relicensing is claimed and it will be replaced / removed on request by its rights holder.
- **Personal and educational use only.** Reading the local WeChat database and injecting a hook may violate WeChat's terms of service and risk account restrictions — evaluate before use. Do not use it for spam, marketing or privacy violations.
