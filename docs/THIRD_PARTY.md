# 第三方组件与来源声明（THIRD_PARTY）

本项目为个人自用实验；只复用 MIT 许可的公开实现思路，并按 MIT 要求保留来源声明。

| 组件/来源 | 许可 | 用途与范围 |
|---|---|---|
| [sourcepro5/WeChatAgent](https://github.com/sourcepro5/WeChatAgent) v0.3.6 | MIT（Copyright (c) 2026 Derpyu520 与 qq-bridge / QSH contributors） | 参考其整体架构、读取接口契约、`InitializeHook/PollKeyData/GetStatusMessage/CleanupHook` 调用方式、DPAPI 与进程识别做法、引用/合并转发解析结构。本仓库代码为独立重写，不直接复制其业务代码。 |
| [zhuobichen/weflow-cli](https://github.com/zhuobichen/weflow-cli)（经 WeChatAgent 分发） | MIT | 参考其 SQLCipher 分片读取、`Name2Id`/`contact` 表结构与消息解码边界（引用/转发/拍一拍的深度与长度上限）。 |
| `wx_key.dll`（闭源第三方组件） | 上游单独授权 | 仅用于一次性捕获本机微信库密钥；从 WeChatAgent v0.3.6 官方安装器提取，放在 `state/tools/wx_key/`（已 gitignore，不随仓库分发）。本仓库不修改、不逆向该二进制。 |
| `version.dll`（Send 通道 Hook，预编译） | 上游 WeChatAgent 构建（upstream aixed/WeChat-Hook，仓库无 SPDX 许可声明） | 来自 WeChatAgent v0.3.6 安装器 `payload/resources/vendor/hook/`；integration `WeChatAgent-1`、targetVersion 4.1.10.27、SHA256 `cffeb948…`；放在 `state/hook/native/`（已 gitignore）。仅本机个人使用，不随仓库分发。 |
| 微信 4.1.10.27 独立客户端副本 | 腾讯专有软件 | 来自 WeChatAgent v0.3.6 安装器 `payload/resources/vendor/wechat/`，复制到 `state/wechat-hook-client/`（已 gitignore），仅本机个人测试使用，不再分发；未修改客户端文件。 |
| `sqlcipher3-wheels` | MIT/BSD（上游 SQLCipher 社区版 BSD 风格） | Python 绑定；Windows 上替代只有 Linux wheel 的 `sqlcipher3-binary`。 |
| [zetaloop/BetterWX](https://github.com/zetaloop/BetterWX) 的 coexist 思路 | Unlicense（完全放弃权利） | 参考其“共存补丁”做法：等长修改 `Weixin.dll` 的 Mutex/窗口类名/自动登录文件名，使固定版微信可与用户自己的微信同时运行。本项目仅修改自有固定版客户端副本，原 DLL 备份在 `state/backups/weixin-4.1.10.27-original.dll`；Hook 偏移不变。 |
| [MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 的 `assets/DSniang1.png` → 本项目 `assets/whale-girl.png` | **素材 as-is，不适用 MIT**（仓库代码 MIT；assets 由 AI 工具生成、PROVENANCE 明确不授予再许可） | 桌面 UI 的“大肥鱼”头像（原鲸鱼娘形象素材，裁切/透明化后嵌入 exe）。本仓库随源码原样附带该素材并保留上游来源/不授予再许可声明；本项目不主张其版权，如权利方主张将立即替换/移除。详见该仓库 `PROVENANCE.md`。 |

## 本仓库的独立实现

以下模块为 WXBOT 自行实现，仅在结构上参考上述来源：

- `scripts/capture-key.py`：微信主进程识别、wx_key.dll 调用、HMAC 校验、DPAPI 保存。
- `scripts/lib/reader/dbkey.py`：SQLCipher page-1 HMAC 校验 + 多账号 DPAPI 存储。
- `scripts/lib/reader/accounts.py`：账号目录探测。
- `scripts/lib/reader/wechat_decode.py`：消息解码、引用/合并转发/拍一拍解析、占位文本。
- `scripts/lib/reader/wechat_db.py`：只读库访问、会话/联系人/消息查询、增量轮询与 SSE。
- `scripts/reader-api.py`：读取层 HTTP 服务。

## 合规红线（手册 §1）

- 个人自用，不对外提供服务，不做群发/营销；只读库不改库、不写明文副本。
- 聊天内容一旦送往模型厂商 = 数据外发，需自行告知同聊人；默认配置关闭自动回复与发送（`bridge.autoReply=false`、`sender.enabled=false`），启用后请自行承担该风险。
- 密钥只以 DPAPI 保护串落盘；日志脱敏（token / 64-hex / 聊天正文）。
