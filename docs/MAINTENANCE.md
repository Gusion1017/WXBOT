# 项目维护说明（MAINTENANCE）

> 最近一次整理：2026-10-18。`state/` 从 **4.8GB → 806MB**（删除安装器/解包产物与旧缓存）。

## 1. 目录职责

```text
scripts/                 运行期脚本（只放会参与运行的入口）
  manage.ps1             start/stop/status（只启动 supervisor）
  supervisor.mjs         进程监控/自愈
  reader-api.py          M1/M2 读取层
  bridge.mjs             M5 OneBot 桥接
  adapter.mjs            M5 I/O 适配器（SSE → OneBot → Hook 发送）
  console-server.mjs     本机只读 API（桌面版数据接口）
  capture-key.py         一次性密钥捕获
  launch-hook-wechat.ps1 启动固定版本微信 + Hook
  resolve-media.py       图片解密子进程（运行时）
  project-config.mjs     配置/令牌/健康检查 CLI
  wxbot-cli.mjs          只读 CLI
  sender-adapter.mjs     M4 发送自检/状态/手工发送
  lib/core/              配置/令牌/路径/日志/原子写/私有文件
  lib/reader/            账号探测/密钥/解码/DB/图片（Python）
  lib/send/              Hook 客户端/发送引擎/回执状态机
  lib/bridge/            OneBot 服务端/ID/适配器/业务引擎
  lib/model/             模型客户端
  lib/console/           控制台 API 安全工具
  dev/                   开发与验收工具（不参与生产）
config/                  配置样例 + 本机配置 + 人格
docs/                    文档（索引见 docs/INDEX.md）
tests/                   Node/Python 测试
state/                   运行时数据（gitignore，见下）
```

## 2. `state/` 内容与保留策略

| 路径 | 大小 | 是否可删 | 说明 |
|---|---|---|---|
| `state/wechat-hook-client/` | ~803MB | ❌ 不建议 | 固定版本微信 4.1.10.27 独立副本（Hook 发送依赖）；删了需重新准备 |
| `state/hook/native/` | ~0.5MB | ❌ | 预编译补丁版 `version.dll` + build 记录 |
| `state/tools/wx_key/` | ~0.2MB | ❌ | 取库密钥用的闭源 DLL（含 manifest） |
| `state/tokens/` | 小 | ❌ | 各通道 64-hex token（0600 等价 ACL） |
| `state/keys.json` / `state/model-key.txt` | 小 | ❌ | DPAPI 保护的库密钥 / 模型 API key（ACL 仅当前用户） |
| `state/logs/` | 小 | ✅ | 按天滚动（`<service>.<stdout|stderr>.<YYYY-MM-DD>.log`），保留 7 天 |
| `state/media/` | 小 | ✅ | 图片解密缓存（按 imageId，索引上限 1000，可随时重建） |
| `state/text-deliveries/` | 小 | ⚠️ | 发送 attempt 状态机（审计/回执证据）；清空会丢失历史回执 |
| `state/messages.json` | 小 | ⚠️ | 桥接缓冲 + pendingReplies + processedIds；清空会失去去重/pending 记录 |
| `state/downloads/` | 曾 4GB | ✅ 已删 | WeChatAgent 安装器与解包产物；重新获取方式见 §3 |
| `state/tools/7zip/` | 曾 4MB | ✅ 已删 | 仅用于解包安装器 |

## 3. 重新获取安装器资产（需要时）

来源：`https://github.com/sourcepro5/WeChatAgent` release `v0.3.6`，安装器
`WeChatAgent-Setup-0.3.6-x64.exe`，SHA256 `8570d6faff04a37e7c8ac3a3bfd95bb5185fa72681982675df562428cc3ef3aa`。

```powershell
# 1) 下载并校验
$u='https://github.com/sourcepro5/WeChatAgent/releases/download/v0.3.6/WeChatAgent-Setup-0.3.6-x64.exe'
Invoke-WebRequest $u -OutFile state\downloads\setup.exe   # 先建目录
(Get-FileHash state\downloads\setup.exe -Algorithm SHA256).Hash  # 应匹配上面的值

# 2) 解包（安装器是 NSIS，内层 app-64.7z；需要 7-Zip）
#    产物关键路径：
#    payload/resources/vendor/hook/version.dll           -> state/hook/native/
#    payload/resources/vendor/hook/build.json
#    payload/resources/vendor/wechat/                    -> state/wechat-hook-client/
#    payload/resources/project/components/weflow-cli/resources/key/win32/x64/wx_key.dll
#                                                        -> state/tools/wx_key/
#    payload/resources/project/                          （参考源码，可只读查阅）
```

`state/hook/native/build.record.json` 与 [M4_HOOK.md](./M4_HOOK.md) 记录了 DLL 的 SHA256、
targetVersion(4.1.10.27)、upstream commit 与 integration id，用于版本锁校验。

## 4. 备份建议

最小备份集（换机/重装时）：

- `config/app.json` + `config/persona.md`
- `state/keys.json`（DPAPI 只能当前 Windows 用户解密）
- `state/model-key.txt`
- `state/hook/native/{version.dll,build.json}`（或按 §3 重新获取）
- `state/wechat-hook-client/`（若不想重新准备固定版本客户端）
- `state/backups/weixin_4.1.10.27.exe`（固定版安装包备份，被自动升级后用于恢复）

## 5. 日常清理命令

```powershell
npm run stop
# 清日志（可随时）
Remove-Item state\logs\*.log -Force
# 清图片缓存（按需重新解密）
Remove-Item state\media\* -Force
# 清测试缓存
Remove-Item .pytest_cache -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -Recurse -Directory -Filter __pycache__ | Where-Object { $_.FullName -notmatch '\\.venv\\' } | Remove-Item -Recurse -Force
# 密钥诊断（只读，不输出密钥）
npm run key:inspect
npm start
```

## 6. 密钥诊断与重捕获（低风险流程）

- 诊断：`npm run key:inspect`（逐账号 HMAC 校验，输出 `keyValid/code/capturedAt/keySource/keyDllSha256`）；
  运行中的读取层 `/api/v1/reader/status` 也带 `keys` 段；桌面版右侧状态与「设置」中可见密钥校验结果。
- 启动自动校验：reader 启动时即校验当前账号密钥，失败返回 `KEY_MISSING / KEY_REJECTED / DB_UNREADABLE`；
  密钥异常时桌面版会提示重捕获命令（只提示，不自动执行）。
- 重新捕获（需要微信登录态变化时）：

```powershell
.\.venv\Scripts\python.exe scripts\capture-key.py --capture
# 按提示在微信里「退出登录 → 重新登录」，捕获成功后用 --inspect 或 npm run status 复核
```

- 多账号：`state/keys.json` 支持多账号（DPAPI 每账号一条），`key:inspect` 会列出全部并标出当前账号（★）。



## 不回复排查（2026-10-18）

自动回复需要**同时**满足：后台四服务运行 + 固定版微信运行并登录 + Hook ready。

1. 先看桌面版右下状态与登录卡；或用 `npm run status`。
2. 服务掉线：桌面版有独立看门狗（每 2.5s 探测 console 端口，连续失败自动执行 manage start），日志在 `state/logs/desktop-watchdog.log`。
3. 微信/Hook 未启动：点「启动微信并登录」（或手动运行 `scripts/launch-hook-wechat.ps1`），确认 Hook `/WeChatAgent/health` 的 `startupState=ready` 且账号匹配。
4. 发送失败/未确认：查看 `state/logs/adapter.stderr.*.log` 的 `adapter.sent` 状态；`unconfirmed` 表示 Hook 网络错误或回读超时，**不会自动重发**，需要等 Hook 恢复后重新触发。
5. 模型/白名单：检查 `config/app.json` 的 `bridge.autoReply`、`wechat.whitelist.private`、`model.enabled`；`state/logs/bridge.stderr.*.log` 会记录 `bridge.receive_failed`（含 code/message）、`bridge.model_silent`、`bridge.send_rejected`。
6. 实例状态：`state/logs/desktop-watchdog.log`、`state/supervisor.json`、`state/logs/*.log`。


## 双微信共存（固定版 + 用户自己的微信）

- 开关：`config/app.json` 的 `hook.allowCoexist=true`；
- 补丁脚本：`python scripts/dev/patch-wechat-coexist.py`（`--restore` 可还原原版 DLL）；
- 原 DLL 备份：`state/backups/weixin-4.1.10.27-original.dll`；补丁信息：`state/research/coexist-patch.json`；
- 原理：参考 BetterWX 共存补丁，等长修改 `Weixin.dll` 里的单实例 Mutex 名、窗口类名、自动登录重定向文件名；不改 Hook 偏移；
- 恢复客户端脚本 `scripts/restore-wechat-client.ps1` 在 `allowCoexist=true` 时会自动重打补丁；
- 注意：补丁只修改本项目自己的固定版客户端副本；不要对用户的正式微信安装目录操作。


## 适配器目标表竞态（2026-10-18 已修复）

- 现象：日志 `bridge.receive_failed ... ONEBOT_ACTION_FAILED TARGET_NOT_FOUND`，模型已生成回复但发送失败；
- 原因：adapter 启动时 reader 尚未就绪，目标索引为空；reader 连上后原先要等 30 秒定时刷新，期间消息回复找不到目标；
- 修复：reader SSE 连上后立即 `refreshTargets()`；发送 action 找不到目标时再刷新并重试一次；
- 验证：`state/logs/adapter.stderr.*.log` 出现 `adapter.targets_refreshed private=3 group=1`，随后 `adapter.sent state=confirmed`。

## 桌面版手动停止语义

用户点「停止服务」后 `userStopped=true`，看门狗**不会**自动重启服务（尊重手动停止）。需要重新点「启动服务」，或关闭重开 WXBOT.exe。

## 设置保存/重启加固

- `manage.ps1` 输出改为异步读取，避免子进程继承管道导致 `ReadToEnd` 死锁；
- 关闭时最多等待 15 秒，超时强制清理退出；
- 实测“保存设置后立即关闭”10.3 秒退出，重开正常。


## 启动服务失败（配置编码，2026-10-18 已修复）

- 现象：保存设置后重启后台失败，或点「启动服务」失败；`state/logs/desktop-manage.log` 里 `manage.ps1:129 ConvertFrom-Json` 报错；
- 原因：设置页把 `config/app.json` 写成 UTF-8（无 BOM），`manage.ps1` 原先用 `Get-Content -Raw` 默认 ANSI 读取，中文白名单/人格等内容导致 JSON 解析失败；
- 修复：`manage.ps1` 改为 `Get-Content -Raw -Encoding UTF8`；PowerShell 5.1 脚本本身保留 UTF-8 BOM（否则中文脚本会解析失败）；
- 验证：保存设置后重启，四服务全部 ready，配置中文值完整。
