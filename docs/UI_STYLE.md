# UI 风格与交互规范（DeepSeek 大肥鱼）

## 1. 设计方向

- **底色**：DeepSeek 深海蓝，低亮度、低对比刺激，适合长时间挂着。
- **主色**：DeepSeek 蓝（#4D6BFE），点缀青色（#77E7FF）与大肥鱼粉（#FFAECD）。
- **形象**：大肥鱼头像作为品牌/空状态/登录卡/设置页的统一视觉锚点。
- **交互**：所有提示内联在窗口内；设置是主窗口内的覆盖层，不弹独立窗口；服务启停/保存全部不阻塞 UI 线程。

## 2. 色彩 Token

| Token | 值 | 用途 |
|---|---|---|
| `UiTheme.Bg` | `#070C18` | 窗口总背景 |
| `UiTheme.PanelBg` | `#0D1628` | 侧栏 / 卡片 / 面板 |
| `UiTheme.PanelBg2` | `#121E36` | 输入框 / 次级面板 |
| `UiTheme.PanelBg3` | `#182846` | 悬停 / 选中 / 卡片渐变顶部 |
| `UiTheme.Line` | `#213558` | 边框 / 分割线 |
| `UiTheme.TextColor` | `#EAF1FF` | 主文字 |
| `UiTheme.Muted` | `#8B9EC3` | 次要文字 |
| `UiTheme.Accent` | `#4D6BFE` | 主按钮 / 选中态 |
| `UiTheme.AccentBright` | `#7A98FF` | 按钮悬停 |
| `UiTheme.Cyan` | `#77E7FF` | 强调 / 滚动条高亮 |
| `UiTheme.Pink` | `#FFAECD` | 大肥鱼点缀 / 未读 / 停止按钮 |
| `UiTheme.Ok/Warn/Err` | `#4AE2AE` / `#FFC96C` / `#FF809E` | 状态色 |

字体：Microsoft YaHei UI（正文 9pt、标题 12pt Bold、小字 8pt）；窗口标题栏通过 DWM 切换为深色，并设置标题/正文颜色。

## 3. 形象素材与许可

- 文件：`assets/whale-girl.png`（512×512 透明底，裁切自原始头像）。
- 来源：[MeteorNOX/DeepSeek-Balance-Whale-Widget](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget) 的 `assets/DSniang1.png`。
- 该仓库 **代码为 MIT**，但 `assets/**` 美术素材 **不在 MIT 覆盖范围**、按 as-is 随插件分发，PROVENANCE 明确说明素材由 AI 工具生成、出处不可考、不授予再许可。详见原仓库 [`PROVENANCE.md`](https://github.com/MeteorNOX/DeepSeek-Balance-Whale-Widget/blob/main/PROVENANCE.md)。
- 本仓库按上游 as-is 方式附带该素材并保留来源声明，不主张版权、不授予再许可；如权利方主张会立即替换/移除。素材已嵌入 `WXBOT.exe`（`scripts/desktop/WXBOTMascotData.cs`，base64），因此单 exe 不依赖外部图片文件。
- 所有自绘控件（圆角卡片、按钮、气泡、滚动条、深色导航）均为本项目原创代码，不复制该仓库代码。

## 4. 组件

| 组件 | 说明 |
|---|---|
| `WhaleMascotControl` | 任意缩放的大肥鱼头像；工具栏 34px、登录卡 42px、空状态 140px、设置页水印 30px |
| `CardPanel` | 圆角渐变卡片（登录卡等） |
| `RoundButton` | 圆角按钮，带 hover/pressed 与轻微投影 |
| `BubblePanel` / `AvatarControl` | 消息气泡（出站 DeepSeek 蓝渐变、入站深色）；出站头像直接使用大肥鱼裁切 |
| 运行状态面板 | 使用 `FlowLayoutPanel + Label` 自绘状态行（服务/模型/密钥/回执），右侧 400px 宽，可完整换行并通过细滚动条查看，不再依赖 RichTextBox 原生滚动 |
| `SlimScrollBar` | 8px 深色细滚动条：轨道 `PanelBg2`，滑块 Accent→Cyan 渐变，hover/drag 高亮 |
| `SlimScrollArea` | 包裹滚动目标：隐藏原生滚动条、绑定细滚动条、220ms 同步 + 滚轮路由 |
| `WheelRouter` | 全局消息过滤器：滚轮按光标位置路由到对应滚动区域 |
| 设置导航 | 自定义 5 个胶囊标签（基本 / 回复频率 / AI 与人格 / API / 高级），替代原生 TabControl |

## 5. 滚动条统一策略

覆盖区域：
- 聊天消息流
- 会话列表
- 运行状态 RichTextBox
- 设置内容页
- 设置中的多行文本域（persona / 白名单）

实现要点：
1. 每个滚动区域由 `SlimScrollArea` 包裹，隐藏原生垂直滚动条（`ShowScrollBar(SB_VERT,false)`），并用 `SetWindowLongPtr` 移除 `WS_VSCROLL`；同时通过 `NativeWindow` 钩子监听 `WM_NCCALCSIZE / WM_NCPAINT / WM_VSCROLL / WM_STYLECHANGED` 等消息，在 WinForms 重新加回样式时立即再次移除，彻底消除“第二条滚动条闪烁”。
2. 细滚动条支持拖动滑块、点击轨道翻页；`WheelRouter` 让鼠标滚轮在任意子控件上都能驱动所属滚动区域。
3. 同步定时器 220ms，仅在滚动状态/尺寸变化时刷新，不重建内容。

## 6. 交互性能

| 操作 | 优化前 | 优化后 |
|---|---|---|
| 设置 → 主界面切换（实测点击处理耗时） | 240–286ms（同步 `RefreshAll` 重建 16 条气泡） | **7–14ms**（只切可见性，消息交给聊天定时器） |
| 主界面 → 设置首次打开 | 157ms（创建整棵设置控件树） | **38ms**（启动后预热覆盖层；后续 10–13ms） |
| 停止服务 / 启动服务 / 设置保存并重启 | 可能冻结 2–20s（同步 HTTP + `manage.ps1 restart`） | **0 个阻塞采样 / 128，最大 18ms** |

关键实现：
- 设置保存不再在 UI 线程执行 `manage.ps1 restart`，由主窗口异步 `RunManage("restart")` 接管；
- 服务操作期间 `busy` 标记让定时刷新暂停；操作结束只刷新状态/会话，不重建聊天；
- HTTP 刷新前先做端口探测（120ms），服务未启动时快速失败；API 超时 2.5s（Hook health 0.7s）；
- 登录卡/进程探测/版本读取均有缓存；图片缓存最多 64 张（LRU）。

## 7. 验证

- 启动应用 → 设置 → 返回主界面，重复 3 次；用 `SendMessageTimeout(WM_NULL)` 采样，见 `state/logs/desktop-responsiveness.json`。
- 服务停止/启动/设置保存并重启：`blocked=0/128，max=18ms`。
- 滚轮测试：聊天区向上滚动、设置 AI 页滚动、状态区滚动均只出现一条细滚动条。
- 截图：为避免暴露本机微信数据，UI 截图不随仓库分发；需要时可在本机自行截图。

## 8. 已知限制

- NumericUpDown 的上下箭头、ComboBox 下拉列表仍是系统原生样式（非滚动条）。
- 固定版微信登录仍需用户扫码；首次启动后固定版窗口在桌面显示。
- 大肥鱼素材为 as-is 第三方 AI 素材，许可见第 3 节。


## 11. 提示时长

- 按钮悬浮 ToolTip：鼠标停留 **1.8s** 后才显示（避免一放上去就弹），显示后停留 20s，切换到其它控件需再停留 1.2s；
- 状态栏操作结果（保存/启停/重启）：至少停留 10s；错误提示停留 15s；
- 周期性的「已连接 · 刷新」不会在这段时间内覆盖操作提示。


## 复制账号（白名单快捷入口）

- 聊天头部右侧有「复制账号 / 复制群名」按钮：私聊复制 wxid，群聊复制群名；
- 左侧会话列表右键菜单：复制账号（白名单用）/ 复制显示名 / 复制会话 ID；
- 复制成功会在底部状态栏提示，可直接粘贴到「设置 → 白名单」；
- 白名单规则：私聊粘贴 wxid，群聊粘贴群名（不带成员数字）。
