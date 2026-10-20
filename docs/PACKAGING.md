# 打包（桌面版）

## 产物

| 产物 | 路径 | 体积 | 说明 |
|---|---|---|---|
| 桌面版 exe | `WXBOT.exe`（项目根） | 以构建输出为准 | WinForms 单 exe：窗口内查看会话/消息/状态、服务启停、设置中心；依赖本机 Node/Python/.venv |

> **获取方式**：`WXBOT.exe` 为构建产物，不提交到仓库（`.gitignore`），可从 [最新 Release](https://github.com/Gusion1017/WXBOT/releases/latest)、CI（GitHub Actions）的 `WXBOT-win-x64` Artifact，或本地 `npm run build:exe` 获取。

> 桌面版**不打开浏览器**。`console-server` 仍在本机运行，仅作为桌面 exe 的本地数据接口（网页界面已移除）。

## 桌面版界面

- 左侧：会话列表（群/私聊、最后消息时间）
- 中间：聊天记录（气泡、发送者/时间/类型、引用/图片按需显示、占位文本）
- 右侧：运行状态（reader/bridge/adapter/hook/supervisor）、模型与人格、密钥校验、最近发送回执
- 顶栏：**启动/停止合并为一个状态按钮**（运行时显示「停止服务」，停止时显示「启动服务」，颜色随状态切换）、刷新、**设置**、微信状态、服务状态与连接状态
- **显示图片**开关位于「设置 → 基本」，保存后写入 `desktop.showImages`，只影响聊天区缩略图显示，不影响读取/发送
- **单窗口设计**：点「设置」在当前窗口内嵌显示设置面板（含「返回主界面」），不再弹出独立设置窗口；错误/提示改为窗口内状态文字，不弹 MessageBox（仅极端启动失败保留系统提示）
- 交互细节：左侧会话搜索框（名称/wxid 过滤）、F5 刷新、聊天滚动位置保持、自动启动失败两次后才重试（避免网络抖动误触发）、启动/停止失败会在底部状态栏显示错误并写入 `state/logs/desktop-manage.log`
- 未启动时自动拉起后台服务（supervisor → reader/bridge/adapter/console）

### 微信登录（右侧「微信登录」卡片）

状态机：未启动 → 微信已启动等待 Hook → 等待扫码登录 → 已登录；异常时明确提示「Hook 版本不符」「登录账号与配置不一致」「检测到其它微信在运行」。

> 微信 PC 版是单实例：启动固定版前需要先退出其它微信；登录完成后可以重新打开其它微信正常使用。程序会明确提示，不会静默失败；不会强制关闭用户正在使用的微信。

- 点「启动微信并登录」→ 通过 `scripts\launch-hook-wechat.ps1` 启动固定版微信 4.1.10.27（检测到其它微信时给出内联提示，不弹窗）；支持把已运行客户端窗口提到前台；
- 登录判定：Hook 健康 + `startupState=ready` + `databaseAccounts` 包含配置账号；
- 关闭程序时：由程序启动的固定版微信会一并退出；外部自己开的微信不动。

### 设置中心（顶栏「设置」，内嵌面板）

| 页签 | 可调整项 |
|---|---|
| 基本 | 自动回复开关、白名单启用、私聊白名单（wxid 每行一个）、群白名单（去尾号群名每行一个） |
| 回复频率 | 私聊/群最小间隔、每分钟 / 每 10 分钟上限、去抖时间、并发上限、pending 回放延迟、群回复模式（hybrid/mention）、唤醒词 |
| AI | 模型启用、provider、baseUrl、model、temperature、maxTokens、**人格文本（直接编辑 config/persona.md）** |
| API | **API Key**（保存到 `state/model-key.txt`，仅当前用户可读）、超时、**连接测试**（直接请求 `/chat/completions` 验证 Key 可用） |
| 高级 | 发送通道启用、缓冲区大小；保存后可选「立即重启服务生效」 |

保存会写回 `config/app.json` 与 `config/persona.md`（原子写、UTF-8），并按选项重启后台服务使配置生效。

## 关闭与进程清理

- 关闭桌面窗口（点 X / Alt+F4）时，程序会先执行 `scripts\manage.ps1 stop`，停掉 supervisor 及其管理的 reader/bridge/adapter/console，再退出；
- 退出后端口全部释放、无后台残留（`runtime.json` 删除、`state/logs/desktop-manage.log` 记录 `action=close-stop exit=0`）；
- 关闭时若正在启动/停止服务，会等当前操作结束后再清理退出，避免竞态遗留进程；
- 重新打开 `WXBOT.exe` 会自动重新拉起后台服务。

## 使用

```text
双击 WXBOT.exe                 # 桌面窗口（自动启动后台服务）
WXBOT.exe --start              # 只启动后台服务（无窗口）
WXBOT.exe --stop               # 停止后台服务
WXBOT.exe --status             # 查看服务状态
WXBOT.exe --settings           # 直接打开设置窗口
WXBOT.exe --selftest           # 自检：配置/端口/API/会话数
```

## 构建

```powershell
npm run build:exe    # 编译桌面版 -> 项目根 WXBOT.exe
```

- 桌面版源码：`scripts/desktop/WXBOTDesktop.cs`
- 编译脚本：`scripts/build-desktop.ps1`（Windows PowerShell 5.1 自带 csc，无需额外 SDK）

## 无控制台窗口

桌面版仍是 console 子系统 exe（便于 `--selftest/--start/--stop` 输出），但启动 GUI 时会判断控制台归属：仅当控制台由本进程私有创建时调用 `FreeConsole()` 销毁，因此双击启动不会残留 `PseudoConsoleWindow` / `conhost.exe`；从终端启动时保留父控制台。设置/登录等提示全部在窗口内，不弹独立窗口。

## 双微信共存

`hook.allowCoexist=true` 时，`state/wechat-hook-client` 的固定版客户端会打 BetterWX 式共存补丁（Mutex/窗口名/自动登录文件改名），从而可以和用户自己的微信同时运行；Hook 偏移与发送能力不变。补丁脚本与还原方式见 [MAINTENANCE.md](./MAINTENANCE.md)。

## 固定版客户端与自动更新

微信 4.x 会自动升级，升级后 Hook（targetVersion 4.1.10.27）会失效。本项目：

- `scripts/block-wechat-update.ps1`：用 ACL 阻止 `%APPDATA%\Tencent\xwechat\update` 写入（update.data / patch / download），并重命名客户端里的 `*Update*.exe`；启动固定版前自动执行；
- 桌面版检测客户端版本，若被升级会显示「客户端版本不符」，并提供「恢复固定版客户端」按钮；
- `scripts/restore-wechat-client.ps1`：从 `state/backups/weixin_4.1.10.27.exe` 解包恢复 4.1.10.27（安装包可用 `scripts/dev/download-wx-4.1.10.27.ps1` 下载）；
- 详细原理/偏移/移植步骤见 [HOOK_RESEARCH.md](./HOOK_RESEARCH.md)。

## 与微信/后台服务的关系

- 桌面版只读取本机 HTTP API 并调用 `scripts/manage.ps1`，不触碰、不关闭任何微信进程。
- 发送使用固定版本微信客户端 + Hook（`state/wechat-hook-client`、`state/hook/native`，端口 30001）；同一微信账号不能同时登录两个客户端。
- 读取数据目录 `D:\Tencent\xwechat_files`（见 `config/app.json` 的 `reader.dataRoot`）。

## 安全提醒

`state/keys.json`（DPAPI，仅当前 Windows 用户可解）、`state/model-key.txt`、`state/tokens/*` 属敏感数据，仅本机保存；日志不输出密钥/聊天正文。

## 边界

- 不是“零依赖”：需要本机已安装 Node.js 22.13+、项目 `.venv\Scripts\python.exe`、固定版本微信客户端；微信登录仍需人工扫码。
- 未做开机自启（按要求）。
