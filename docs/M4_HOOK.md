# M4 发送层（Hook 路线 C）实施记录

> 用户已确认：白名单只加一个测试联系人；发送走 **路线 C（注入 Hook，强回执）**。
> **状态：✅ 真机强回执验收通过（2026-10-18 04:29）**。

## 0. 真机验收（已完成）

- 固定版本客户端 4.1.10.27 启动，Hook HTTP 只绑 `127.0.0.1:30001`，未带 token 请求 401。
- `node scripts/sender-adapter.mjs --check` → `ok:true`：
  - reader `accountDirectory = wxid_self_xxxx`（账号已脱敏）
  - hook `version = 4.1.10.27`、`integration = WeChatAgent-1`、`databaseAccounts = [wxid_self_xxxx]`、`startupState = ready`
- 真实发送（本机账号 → 白名单好友，私聊会话）：
  ```json
  {
    "ok": true,
    "state": "confirmed",
    "deliveryId": "e853573f…",
    "kind": "private",
    "target": "wxid_target_xxxx",
    "textLength": 29,
    "serverId": "7068354909744584549",
    "localId": 265
  }
  ```
  耗时 **712ms**；`sender-adapter --status` 显示 `confirmed: 1`。
- 回执核对方式：发送前记录 baseline localId；发送后从 reader 数据库取到 `isSend=1 + serverId>0 + 文本相等 + localId ∉ baseline` 的记录才算成功。

## 1. 已就绪的基础件

| 组件 | 位置 | 说明 |
|---|---|---|
| Hook DLL（预编译、已打补丁） | `state/hook/native/version.dll` | 来自 WeChatAgent 0.3.6 安装器 `payload/resources/vendor/hook`；SHA256 `cffeb948…` 与官方 `VERIFICATION.json` 一致；`build.json`：upstream `aixed/WeChat-Hook`、commit `e905d07a…`、integration `WeChatAgent-1`、targetVersion **4.1.10.27**、`deferred-module-v1` |
| 固定版本微信客户端 | `state/wechat-hook-client/` | 同安装器内置的独立副本：`Weixin.exe`（FileVersion 4.1.10.27，Authenticode 有效、签发者 Tencent）+ `4.1.10.27/` 运行库（约 803MB）；state/ 已 gitignore |
| Hook 客户端模块 | `scripts/lib/send/hook-client.mjs` | health / SendTextMsg / 跨通道校验（版本三重锁的调用方、账号锁）/ 错误码映射 / waitForNative |
| 回执状态机 | `scripts/lib/send/text-delivery-store.mjs` | `dispatching→accepted→confirmed|unconfirmed|rejected`；先落盘再发送；终结态不可变；只存文本哈希不存正文 |
| 发送引擎 | `scripts/lib/send/send-engine.mjs` | baseline → 落盘 → SendTextMsg → 400ms 轮询回读；超时 unconfirmed 不重发；4xx rejected |
| 启动脚本 | `scripts/launch-hook-wechat.ps1` | 版本/签名/DLL 哈希校验；拒绝其它桌面微信；复制 DLL+token；禁用更新器；`StartPort=30001 CallBackURL=.../unused` 启动；等待 30001 监听 |
| 自检/发送命令 | `scripts/sender-adapter.mjs` | `--check` / `--status` / `--send --target <..> --text <..> --yes`（需 `sender.enabled=true`） |

## 2. 手册 §6.2 必打补丁核对（预编译 DLL 已含）

预编译 DLL 来自 WeChatAgent 的 patched build（其 `build-hook.ps1` 记录了逐条补丁）：HTTP 只绑 `127.0.0.1`、延迟到 `Weixin.dll` 就绪再 Hook（≤30s）、Bearer token 校验、`set_payload_max_length`、注释掉 `Patch_Revoke`（不改微信撤回行为）、只注册本项目路由、`version.lib` 代理导出。

## 3. 真机联调步骤（需要用户操作）

1. **退出当前微信**（4.1.15.13，主账号已登录）——同一账号不能同时登录两个客户端。
2. 启动固定版本客户端（脚本会拒绝其它桌面微信）：
   ```powershell
   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/launch-hook-wechat.ps1
   ```
3. 在 4.1.10.27 客户端里**登录机器人账号**（才能给白名单里的联系人发送）。
4. 重新捕获库密钥（旧客户端数据目录与 4.1.15 不同）：
   ```powershell
   .\.venv\Scripts\python.exe scripts\capture-key.py --check
   .\.venv\Scripts\python.exe scripts\capture-key.py --capture --timeout 240
   ```
   （按提示在旧客户端里「退出登录 → 重新登录」触发一次）
5. 更新 `config/app.json`：`reader.dataRoot` / `reader.accountDirectory` 指向旧客户端数据目录，重启 reader+console。
6. 跨通道自检：`node scripts/sender-adapter.mjs --check`（应通过版本/账号锁）。
7. 首次真实发送测试（发给白名单联系人，人工确认）；随后验证回执闭环：reader 数据库里出现 `isSend=1 + serverId>0` 才算 confirmed。

## 4. 回执闭环设计（接下来实现）

```
1) 发送前：查一次该会话，记 baseline localId 集合
2) attempt 落盘 state/text-deliveries/<deliveryId>.json（state=dispatching）
3) POST /SendTextMsg（Bearer hook token + X-WeChatAgent-Account）
4) 400ms 轮询 reader /messages：新 localId ∉ baseline && 文本哈希相等
   && createTime ≥ startedAt-30s && serverId 是正整数 → confirmed
5) 18s 超时 → unconfirmed（**不重发**，等人工/后续核对）
6) 400/401/403/409/429 → rejected（不重试）；网络错误 → unconfirmed
```

## 5. 风险与边界（用户已知情）

- 注入式 Hook 违反微信用户协议、有封号风险；固定版本客户端不得升级（脚本已禁用更新器）。
- `accepted` ≠ 送达；`unconfirmed` 不自动重发。
- 发送只在 `sender.enabled=true` 且跨通道自检通过后才会启用；默认关闭。
- 本机主微信（4.1.15.13）与固定版本客户端**不能同时登录同一账号**；切换需要短暂下线。
