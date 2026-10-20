# 原生表情包

设置页「表情包」标签支持上传 jpg / png / gif，保存为 GIF，填写名称和适合发送的时机；机器人可在回复时选择发送，使用微信原生 appmsg-8 表情消息。

## 使用

1. 设置 → 表情包 → 上传图片
2. 选择 jpg / png / gif（≤8MB，边长 ≤4096px）
3. 填写「表情包名字」和「适合发送的时机」
4. 点「保存信息」
5. 机器人下一次回复会自动读取最新目录，不需要手动重启后台

## 存储

- 索引：`state/stickers/catalog.json`
- 主文件：`state/stickers/library/<md5>.gif`
- 发送暂存：由 Hook 的客户端路径计算出的 `state/stickers/outgoing/<md5>.gif`。

> 本项目固定版客户端在 `state/wechat-hook-client/Weixin.exe` 时，Hook 计算出的 outgoing 目录是**项目根父目录**下的 `state/stickers/outgoing`（例如 `<项目根>\..\state\stickers\outgoing`）。这是 Hook 的路径校验规则，程序自动计算，不要手动移动文件。

## 格式转换

- gif：保留原始字节/动画
- png / jpg：设置页用 GDI+ 转为单帧 GIF
- 统一用 MD5 命名，Hook 要求文件名等于文件 MD5
- 单文件 ≤8MB，不支持的格式（如 webp 上传）直接拒绝

## 模型选择

后台启动时把启用表情的 `id / 名字 / 适合时机` 注入模型提示词；模型可以输出：

```text
SILENT
RESPOND: <一条文字>
RESPOND: <文字>
STICKER: <表情 id>
```

默认是“文字为主、表情补充”：先发 RESPOND 文字，氛围合适时下一行再附 STICKER，bridge 会先发文字再发原生表情；一条回复最多附 1 个表情。纯 STICKER 仅作为兼容兜底，不应作为默认输出。表情 id 不存在、已停用、文件校验失败或发送失败时不会重试，也不会伪造文字回复。

### 时机关键词自动附带

bridge 还会检查当前消息是否出现某个表情的「适合发送的时机」短语（按，、；；/ 空格拆分，名字也参与匹配）：

- 命中（如“我饿了想吃饭”命中“想吃饭”、“哈哈哈嘲笑你”命中“嘲笑”、“委婉拒绝你”命中“委婉拒绝”）且策略允许时，模型文字回复会自动附上匹配度最高的一个表情；
- 没有命中（如“你好在吗”）→ 只回文字，不硬凑；
- 模型已经自己选了表情 → 不重复附加；
- 命中后仍受总开关、冷却、每小时上限、群聊限制、选择方式约束。

这样“表情包设置里适合发送的时机”会直接成为对话触发词，而不用等对方明确要求。

## 发送与回执

1. bridge 从 catalog 找到表情并把主文件暂存到 outgoing
2. adapter 校验路径、GIF 魔数、文件名/内容 MD5、大小
3. 调 Hook `POST /SendStickerMsg`：
   ```json
   {
     "wxidorgid": "目标 talker",
     "sticker": { "md5": "...", "productid": "", "len": 123, "type": 2, "width": 240, "height": 240 },
     "path": "…/state/stickers/outgoing/<md5>.gif"
   }
   ```
4. Hook 返回 `ret=0 accepted` 后，adapter 轮询 reader `/messages`，只有看到新的 `isSend=1`、`serverId>0` 且 localType 为表情/appmsg-8 的消息才算 `confirmed`；超时标记 `unconfirmed`，不自动重发

## 限制与风险

- 只支持白名单会话；群聊仍遵守 @/唤醒词直呼
- 表情发送依赖 Hook 原生布局；Hook health 的 `nativeStickerSend` 必须为 `true`（当前 4.1.10.27 已验证 true）
- 这是版本相关能力，微信升级后可能失效；失败时不会退回普通图片
- 表情包属于账号内容，默认只在本机保存；请勿上传不适合外发的图片
- 频繁发送可能有账号风控风险，建议低频使用
- 删除表情只删本地 catalog/主文件；已暂存到 outgoing 的副本可手动清理

## 排查

- 设置页上传后 catalog 不更新：看 `state/stickers/catalog.json` 权限/磁盘。
- 机器人不发表情：看 bridge 日志 `bridge.sticker_ready`，确认 catalog 有启用项；看 `bridge.sticker_stage_failed` / adapter 日志 `adapter.sticker_sent`。
- Hook 报 `Invalid sticker file`：路径必须在 Hook 计算的 outgoing 下、文件名必须等于 MD5、必须是 GIF/PNG/WEBP/JPG 魔数。
- Hook health `nativeStickerSend=false`：当前客户端版本/布局不支持原生表情，暂停使用。

## 优化后的管理界面

- 左侧缩略图卡片列表：选中高亮、启用状态小圆点、名字/发送时机两行摘要
- 顶部搜索框：按名字或发送时机过滤；无结果时显示空状态
- 批量上传：添加图片支持一次多选，也支持把图片直接拖到列表
- 右侧：GIF 预览、名字/时机编辑、启用/停用、删除、文件尺寸/动画信息
- 顶部操作：添加图片、打开表情目录；右上角显示已添加/上限/启用数量
- 保存修改、停用/启用、删除均为立即保存；服务下一次回复自动读取新目录

## 通用设置

入口：表情包页右上角「通用设置」。

| 设置 | 说明 |
| --- | --- |
| 启用表情包发送 | 总开关；关闭后模型完全不会选择表情包 |
| 选择方式 | 「智能自动」由模型按聊天氛围选择；「仅明确要求」只在对方提到表情/图片/动图等时提供表情候选 |
| 允许群聊使用表情 | 群聊中仍先满足 @ / 唤醒词直呼；关闭后群聊不提供表情 |
| 同一会话冷却（秒） | 两次表情之间至少间隔；0 = 不限制 |
| 每小时最多发送 | 全局滑动一小时上限；0 = 不限制 |
| 使用提示 | 注入模型表情目录提示词，控制何时用表情；默认要求克制、只在明显合适时附一个 |

保存后写入 `config/app.json` 的 `sticker` 字段，bridge 在**下一次回复时动态读取**，不需要重启后台；冷却/小时计数在 bridge 进程内维护，后台重启后清零。

对应配置：

```json
"sticker": {
  "enabled": true,
  "mode": "smart",
  "groupsEnabled": true,
  "cooldownSeconds": 60,
  "maxPerHour": 10,
  "promptGuidance": "表情包只作为文字后的点缀：默认只回文字；只有出现大笑、吃饭/饿、明确拒绝等明显场景且目录里有匹配表情时才附一个；普通聊天、信息问答、正事沟通和连续对话不要硬凑表情。"
}
```


