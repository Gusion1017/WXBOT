# M7 稳定性（不含开机自启）+ UI 升级

> 用户指示：M7 **不做开机自启**，其余继续；同时完善应用 UI，保证整洁美观。

## 1. 进程监控 / 崩溃自愈

- 入口：`scripts/manage.ps1 start` 只启动一个 **supervisor**（`scripts/supervisor.mjs`，WMI 分离启动）。
- supervisor 按依赖顺序拉起：`reader → bridge → adapter → console`，并：
  - 每 5s 做一次健康检查（reader `/status`、bridge `/health`、adapter `/status`（要求 bridge/reader 均连接）、console `/api/meta`，各自带正确 token；console 用 `x-console-token`）；
  - 进程意外退出 → 指数退避重启（2s → 30s 上限）；
  - 连续 3 次健康失败 → 杀掉进程树并重启；
  - 状态原子写入 `state/supervisor.json`（含 pid/状态/重启次数/最近错误）；
  - 收到 SIGINT/SIGTERM → 逆序杀整棵进程树。
- `npm run status` 同时显示四节点 health 与 supervisor 明细；`npm run stop` 用 `taskkill /T` 杀 supervisor 与全部子进程，并兜底清理残留。

### 崩溃自愈实测（真机）

| 操作 | 结果 |
|---|---|
| `taskkill /F` bridge | 2s 后重启，`restarts=1`，8s 内 `healthy` |
| `taskkill /F` adapter | 同上，`restarts=1`，`healthy` |
| `taskkill /T /F` reader（含 python 子进程） | 2s 后重启，`restarts=1`，10s 内 `healthy` |
| `taskkill /F` console（换新 UI 时） | 2s 后重启，`restarts=1`，`healthy` |
| 全部重启后 | `npm run status` → `reader/bridge/adapter/console` 全部 `LISTEN health=ok`，`sender-adapter --check ok:true` |

### 重启后 pending 恢复（不重复回复）

- bridge 启动 `pendingReplayDelayMs`（默认 30s）后调用 `engine.replayPending`：
  对 `state/messages.json` 里 `state=unconfirmed` 的回复，通过 adapter 的 `verify_delivery` action
  查 `state/text-deliveries/<deliveryId>.json`，只有确认过才改 `confirmed`，**绝不重发**。
- 实测：注入一条 pending（指向已 confirmed 的 deliveryId）→ kill bridge → 重启 30s 后
  `bridge.pending_replayed count=1`，pending 状态变为 `confirmed` 且 `serverId` 回填。
- 幂等：`processedIds` 落盘（会话键+message_id，10 分钟 TTL），重启后重复投递同一 message_id 返回
  `duplicate_processed`，不会重复回复（单测覆盖）。

## 2. UI 升级（当时网页控制台；后续由桌面版取代，API 保留）

- 全新三栏布局：左侧会话列表（搜索/未读/群标签）、中间聊天气泡（自己/对方、引用块、图片、占位文本）、
  右侧状态列（四节点 + supervisor 卡片、发送回执、模型与人格、联系人/群）。
- 顶部状态条：账号、自动回复开关、读取层/实时通道状态。
- 实时：`/api/live`（SSE 代理 reader 推送）；桌面版通过该接口刷新会话与聊天。
- 视觉：深色渐变 + 圆角卡片 + 状态点 + 回执状态色 + 自适应（窄屏单列）。
- 安全保持不变：Host/Origin 校验、`/api/*` 必须 `x-console-token`、只读 405、CSP `default-src 'self'`、
  聊天内容全部 `textContent` 渲染。
- `/api/meta` 聚合：四节点健康、hook 版本/账号、supervisor 状态、发送回执摘要、模型/人格、白名单。

## 3. 稳定性加固（M7 收尾）

- **日志按天滚动**：`state/logs/<service>.<stdout|stderr>.<YYYY-MM-DD>.log`（本地日期），
  supervisor 每天自动换文件；保留 7 天，过期自动删除；启动时记录清理数量。
- **磁盘监控**：supervisor 每 60s 采一次（Windows 上 `statfs` 不可用时用 PowerShell 兜底），
  `supervisor.json.disk = {freeBytes,totalBytes,low,source,checkedAt}`；低于 1GB 记 `disk_low` 告警。
- **缓冲清理**：`state/messages.json` 写盘前清理——无未读且最后消息超 7 天的会话删除、
  会话上限 500（按最后消息时间淘汰）、已确认 pending 超 7 天删除（引擎单测覆盖）。
- **密钥诊断（方案 A）**：
  - `npm run key:inspect`：逐账号 HMAC 校验，输出 `keyValid / code / capturedAt / keySource / keyDllSha256`，不输出密钥；
  - `GET /api/v1/reader/status` 增加 `keys` 段（当前账号 verified + 多账号列表）；
  - 控制台右栏「密钥诊断」卡片 + 顶部红色横幅（KEY_MISSING/KEY_REJECTED/DB_UNREADABLE 时提示重捕获命令，不自动执行）；
  - `node scripts/wxbot-cli.mjs keys` 同源展示。
- **短时 soak**（`npm run dev:soak -- --minutes 4 --interval 20`）：
  - 12 个样本：RSS 202→208MB 稳定；日志 4 分钟增长 3.2KB；磁盘剩余 698GB 稳定；
  - soak 期间人为 kill reader/console 制造 1 个 unhealthy 样本，supervisor 2 次重启后恢复，之后 0 unhealthy；
  - 汇总：`SOAK_SUMMARY {samples:12, unhealthySamples:1, totalRestartDelta:2, maxTotalRssMB:208, minDiskFreeMB:698878}`。

## 4. 未做 / 待确认

- **开机自启**：按用户要求不做。
- 7×24 长跑观察：自愈已覆盖崩溃场景，长时间运行（内存/日志滚动/磁盘）尚待实际挂机观察。
- 打包分发（单文件 exe）：尚未做，如需要再排期。
