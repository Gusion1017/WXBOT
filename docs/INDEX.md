# 文档索引

## 复刻指南（先读这份）

- [WXBOT 复刻开发指南](./REPLICATION_GUIDE.md)：**面向"照着做"的完整手册**——功能总览、每项功能的代码级实现（读取/推送/白名单/媒体/发送/桥接/模型/记忆/表情/自愈/桌面 UI/打包）、协议与状态文件参考、可执行的开发流程（环境/里程碑门禁/调试/测试/发布/维护）、分阶段路线图、踩坑与已知缺陷清单。仿造开发从这份开始。

## 参考材料（docs/reference/）

- [同类项目实现手册](./reference/同类项目实现手册.md)：本项目的施工手册（路线选择、分层、里程碑、验收清单、踩坑）。
- [WeChatAgent 架构与机制](./reference/WeChatAgent-架构与机制.md)：参考项目源码走读。
- [WeChatAgent 管线报告](./reference/WeChatAgent-pipeline-report.md)：参考项目端到端管线细节。

## 接口契约

- [读取层 READER_API](./READER_API.md)：`/api/v1/*`、SSE 推送、错误码、白名单语义。
- [本机只读 API CONSOLE](./CONSOLE.md)：127.0.0.1:3210 的安全模型与代理接口（桌面版数据源；无网页界面）。

## 阶段记录

- [M3 验收](./M3_ACCEPTANCE.md)：只读链路 + 故障注入 + M0–M3 验收证据。
- [M4 Hook 发送](./M4_HOOK.md)：固定版本客户端 + 预编译补丁版 DLL + 强回执。
- [M5/M6 桥接与模型](./M5_M6_PLAN.md)：OneBot 桥接、业务引擎、适配器、DeepSeek 路线 A。
- [会话记忆 MEMORY](./MEMORY.md)：10 条短期记忆、超限摘要、7 天半衰期时间权重、JSON+Markdown 存储与清理。
- [原生表情包 STICKER](./STICKER.md)：设置页上传 jpg/png/gif、转 GIF、名称/时机、模型选择与 Hook 原生发送回执。
- [M7 稳定性与 UI](./M7_STABILITY.md)：supervisor 自愈、pending 恢复、控制台 UI。

## 打包

- [打包说明 PACKAGING](./PACKAGING.md)：项目根 `WXBOT.exe` 启动器（方案 A）、构建与依赖边界。

## 维护与来源

- [MIT LICENSE](../LICENSE)：本项目代码许可；第三方组件/素材许可见 [THIRD_PARTY](./THIRD_PARTY.md)。
- [CI 工作流](../.github/workflows/ci.yml)：GitHub Actions 自动运行 Node/Python 单元测试。
- [维护说明 MAINTENANCE](./MAINTENANCE.md)：目录职责、可清理项、备份项、安装器重新获取方式。
- [性能优化 PERFORMANCE](./PERFORMANCE.md)：桌面版/后台服务资源测量与优化记录。
- [UI 风格 UI_STYLE](./UI_STYLE.md)：DeepSeek 大肥鱼配色、形象素材许可、统一滚动条、设置/主界面切换性能。
- [Hook 研究 HOOK_RESEARCH](./HOOK_RESEARCH.md)：version.dll 注入原理、版本偏移、编译/移植流程、自动更新防护。
- [第三方与来源 THIRD_PARTY](./THIRD_PARTY.md)：许可证/来源、闭源组件边界。
- [项目 README](../README.md)：快速开始与进度总表。
