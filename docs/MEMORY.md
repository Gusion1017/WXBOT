# 会话记忆

WXBOT 的模型决策不再是“只看当前这一批消息”，而是按会话维护短期与长期记忆。

## 机制

- **作用范围**：每个私聊/群聊各自独立；不会把 A 聊天的记忆带进 B 聊天。
- **短期记忆**：最近 `shortTermLimit`（默认 10）条“对话条目”，包含对方消息和机器人回复。
- **长期记忆**：短期记忆超过上限时，把最旧的溢出条目交给模型整理成一条摘要；模型失败时使用确定性拼接摘要兜底。
- **时间权重**：长期记忆按 `weight = 0.5 ^ (ageDays / halfLifeDays)` 计算，默认半衰期 7 天；越近权重越高。提示词里长期记忆按权重从高到低排列，并标注“今天/昨天/N 天前”和权重。
- **提示词**：模型收到人设 + 该会话记忆 + 当前未读批次；记忆和聊天内容都放在 `untrusted_memory` / `untrusted_chat` 标签内，作为不可信数据。
- **记录时机**：回复成功（含 unconfirmed）后记录对方消息与机器人回复；SILENT/发送被拒绝时只记录对方消息；发送异常时不记录，避免重试造成重复。
- **摘要调用**：摘要在回复发送之后异步执行，不阻塞本次回复；失败只影响记忆质量，不影响回复主流程。

## 文件位置

- 数据源（程序读写）：`state/memory/<会话标识>-<短哈希>.json`
- 人类可读文档：`state/memory/<会话标识>-<短哈希>.md`
- Markdown 只是展示/备份，手改 Markdown 不会回写；以 JSON 为准。

## 配置

`config/app.json`：

```json
"memory": {
  "enabled": true,
  "shortTermLimit": 10,
  "halfLifeDays": 7,
  "maxPromptChars": 1600,
  "maxEntries": 120,
  "summaryMaxChars": 500,
  "summarizeWithModel": true
}
```

| 字段 | 说明 |
| --- | --- |
| `enabled` | 总开关；关闭后不读不写记忆 |
| `shortTermLimit` | 短期记忆条数（2-100） |
| `halfLifeDays` | 长期记忆时间权重半衰期（天） |
| `maxPromptChars` | 注入模型的最大记忆字符数 |
| `maxEntries` | 单会话长期记忆条数上限，超出后保留较新的 |
| `summaryMaxChars` | 单条长期记忆摘要最大长度 |
| `summarizeWithModel` | 是否用模型摘要；false 时只用确定性拼接摘要 |

## 隐私与清理

- 记忆文件在**本机明文**保存，属于聊天内容；不会写入普通日志。
- 关闭：`memory.enabled=false`。
- 清空：停止服务后删除 `state/memory/` 下对应文件；勿在服务运行时直接改 JSON。
- 备份/迁移：复制 `state/memory/` 即可；Markdown 可单独查看。

## 说明

- 记忆只影响回复时的模型上下文，不改变白名单、唤醒词、限流、发送回执等安全链路。
- 摘要调用使用同一模型配置（DeepSeek），会产生额外 token 消耗；默认在半衰期 7 天下每溢出一次摘要一次。
- 记忆文档时间权重用于长期记忆排序，不是硬删除；低权重旧记忆仍保留到 `maxEntries` 上限。
