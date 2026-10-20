# Hook 研究笔记（WeChat 4.x / version.dll 注入）

> 目的：弄清当前发送通道的 Hook 原理、版本相关偏移、编译/移植方法，为微信升级后自行适配 Hook 做准备。
> 本文基于上游开源项目 [aixed/WeChat-Hook](https://github.com/aixed/WeChat-Hook) 的源码（tag `v411027_`，commit `53ba84e`）与本地反编译/行为验证整理。
> **合规提醒**：Hook 微信客户端属于逆向/注入行为，仅限个人本机实验，风险自负；不要用于群发、营销或违反微信条款的用途。

## 1. 总体架构（version.dll 代理）

```
Weixin.exe（微信主进程）
  └─ 启动时按 DLL 搜索顺序加载同目录的 version.dll（伪造/代理 DLL）
       ├─ DllMain(DLL_PROCESS_ATTACH)
       │    ├─ 解析命令行：StartPort= / RecvType= / CallBackURL=
       │    ├─ 判断主进程（跳过 --type= / --crashpad-handler 子进程）
       │    ├─ 隐藏模块（PEB）
       │    ├─ 加载系统真实 version.dll 并转发 17 个导出函数
       │    └─ Evt_WeixinLoad()
       │         ├─ 取 Weixin.dll 基址
       │         ├─ 打防撤回补丁（Patch_Revoke）
       │         ├─ 启动本地 HTTP 服务（默认 0.0.0.0:30001）
       │         └─ 读取 wx.ini 的 recv_url（可选回调）
       ├─ 提供 /SendTextMsg /SendImgMsg /ForwardXMLMsg /Decode_Pic /GetSelfProfile /QueryDB/*
       └─ 通过硬编码偏移直接调用 Weixin.dll 内部函数（发送消息、解密图片、查库）
```

要点：
- **注入方式**：DLL 搜索顺序劫持（把 `version.dll` 放到微信 exe 同目录），不需要注入器；系统自带 `version.dll` 由代理 DLL 转发。
- **主进程判断**：微信会启动多个 `--type=...` 子进程，Hook 只在主进程初始化，其他进程直接 `FreeLibraryAndExitThread`。
- **HTTP 服务**：`httplib` 单头库，监听 `g_StartPort`，与我们的 `hook-client.mjs` 对接。
- **登录状态**：Hook 本身不主动 hook 登录函数，`/QueryDB/status` 的 `g_IsLogin` 来自登录监控/DB 逻辑；我们桌面版通过 `databaseAccounts` 与账号匹配判断登录。

## 2. 版本相关偏移（4.1.10.27）

全部硬编码在 `include/global.h`（模块基址 + 偏移，RVA）。当前 Hook 只对 `4.1.10.27` 的 `Weixin.dll` 有效。

| 常量 | 值（RVA） | 用途 |
|---|---|---|
| `XWECHAT_MAIN_CLAZZ_OFFSET` | `0xA83AB20` | 微信主类全局指针（低版本补丁用） |
| `g_Patch_Revoke` | `0x22D09E7` | 防撤回补丁位置 |
| `offset::send_message` | `0x1677A30` | 发送消息主函数 |
| `offset::txt_message_ctr` | `0x6B2C30` | 文本消息对象构造函数 |
| `offset::txt_message_vtbl` | `0x8279358` | 文本消息 vtable |
| `offset::create_param2` | `0xDF40` | 发送参数构造子函数 |
| `offset::param2` | `0xA0CE0B0` | 发送参数全局值 |
| `offset::param1_vtable` | `0x84EC9C8` | 发送参数1 vtable |
| `offset::param2_1/2/3` | `0x8595F58 / 0x8595E98 / 0x8595DD8` | 发送参数2 三个子对象 vtable |
| `offset::img_msg_vtbl/vtb2` | `0x84F96B8 / 0x84F9748` | 图片消息 vtable |
| `offset::dec_pic_call` | `0x493E70` | 图片解密函数 |
| `XWECHAT_SQLITE3_VFS_OFFSET` | `0xA6C0490` | sqlite3 VFS |
| `XWECHAT_SQLITE3_API_ROUTINES_OFFSET` | `0x8BB0D38` | sqlite3 API 表（查库用） |
| `XWECHAT_SQLCIPHER_API_ROUTINES_OFFSET` | `0x8BB1570` | SQLCipher API 表 |
| `XWECHAT_SQLITE3_CODEC_GET_KEY_FUNC` | `0x4EE64D0` | 取库密钥（可废弃） |
| `Offsets::*`（4.1.5.30 XML） | 见 global.h | 转发 XML/图片/视频消息结构 vtable |

> 另有 `wx_send.cpp` 中 `TextMessage` 结构布局偏移（`receiver @0xB0`、`uuid @0x6A8`、`content @0x708` 等）与 `unknown` 参数结构，这些也随版本可能变化；发送失败时优先核对这些布局。

## 3. 发送文本的调用链（4.1.10.27）

```
POST /SendTextMsg {wxidorgid,msg}
  └─ WeixinSend::SendText()
       ├─ HeapAlloc 0x768*8 字节消息缓冲
       ├─ BuildTextMessage():
       │    ptr[0] = Weixin.dll + txt_message_vtbl
       │    ptr[1] = 0x200000005
       │    call Weixin.dll + txt_message_ctr(消息对象)   // 构造文本消息
       │    SetWeixinString(receiver @0xB0, wxid)
       │    SetWeixinString(content @0x708, msg)
       │    msg_len = len; type = 1
       ├─ 组 data/arg1（param1_vtable + 指针）
       ├─ BuildSendParam2_Text(): 构造 0xE8 参数（create_param2 + 3 个 vtable 子对象 + 全局值）
       └─ call Weixin.dll + send_message(arg1, arg2)   // 真正发送
```
接收侧不是 Hook 回调，而是我们 reader 直接读 SQLCipher 库；Hook 主要提供发送/查库/资料接口。

## 4. 自动更新防护（上游做法 + 本项目加固）

上游 `防止微信自动更新/4.x禁止微信自动升级.bat` 的思路（已在本项目实现为 `scripts/block-wechat-update.ps1`）：

```bat
:: 让更新开关文件不可访问
cacls "%USERPROFILE%\AppData\Roaming\Tencent\xwechat\update\update.data" /T /P %USERNAME%:N
:: 清空并锁死 patch 暂存目录
rd /s /q "...\update\patch" & md "...\update\patch"
cacls "...\update\patch" /T /P %USERNAME%:N
```

本项目实现：
- 对 `%APPDATA%\Tencent\xwechat\update\update.data`、`patch`、`download` 用 `icacls /deny` 拒绝当前用户写入/删除；
- 清空 patch 缓存；
- 递归把客户端目录里的 `*Update*.exe` 改名为 `.disabled`；
- 启动脚本 `launch-hook-wechat.ps1` 每次启动前自动执行该防护。
- 注意：这是**本地阻止升级**；如果腾讯服务端强制旧版无法登录，只能等匹配新版本的 Hook，或改用 UI 自动化路线。

## 5. 自行适配新版本 Hook（移植流程）

### 5.1 准备
1. 源码：`https://github.com/aixed/WeChat-Hook`（tag 对应目标版本，若无对应 tag 则取 main）。
2. 编译环境：Windows + Visual Studio 2019/2022（x64 工具集 + Windows SDK 10）；项目为 `x64_Version_dll.sln`，依赖 MinHook、httplib、nlohmann-json（仓库内已 vendor）。
3. 目标版本 `Weixin.dll`（从安装包解出，必须与要登录的微信版本完全一致）。
4. 一个**测试账号**与单独的数据目录，先验证登录、发送、查库，再接入正式使用。

### 5.2 找偏移（核心工作）
当前偏移全部是静态 RVA，需要按新版本重新确定。推荐顺序：
1. **从旧版源码/二进制对照**：用 `scripts/dev/hook-offsets.py` 把 4.1.10.27 的偏移处字节取成带指针掩码的签名，在新版 `Weixin.dll` 里搜索候选（工具已提供）。
2. **特征字符串/xref**：用 IDA/Ghidra/Binary Ninja 对 `send_message` 等调用点下断，顺着参数结构找构造函数和 vtable；源码中 `TextMessage` 字段偏移（0xB0/0x6A8/0x708）可作为辅助校验。
3. **动态验证**：写一个只读的测试 DLL/调试器，打印候选地址处机器码并与旧版对比；vtable 偏移可通过“对象首 8 字节指向代码段”识别。
4. **不要凭偏移差整体平移**：微信每次大版本重排段/优化函数，简单 delta 不可靠；必须逐项验证。

### 5.3 更新与编译
1. 修改 `include/global.h` 中偏移常量；
2. 如结构布局变化，同步修改 `wx_send.cpp` 的 `TextMessage`/参数结构；
3. 用 MSBuild 编译：
   ```powershell
   MSBuild.exe x64_Version_dll.vcxproj /m /t:Build /p:Configuration=Release /p:Platform=x64
   ```
4. 产物 `x64\Release\version.dll`，替换 `state\hook\native\version.dll`，更新 `state/hook/native/build.json`（targetVersion/sha256）与 `config.hook.expectedVersion`。
5. 启动客户端，验证 `/WeChatAgent/health`、`/SendTextMsg`、`/QueryDB/status`；发送一条测试消息并用 reader 回读 serverId 确认。

### 5.4 验收清单
- [ ] `version.dll` 能被微信加载（Hook 端口 30001 监听）
- [ ] `/WeChatAgent/health` 返回正确版本/账号
- [ ] `/SendTextMsg` 返回 ret=0，reader 能回读到 `isSend=1 + serverId>0`
- [ ] 重启客户端后仍可发送（不崩溃、不卡死）
- [ ] 防撤回/图片解密等非核心功能可降级
- [ ] 更新阻断已生效（`block-wechat-update.ps1` 写入探测被拒绝）

## 6. 工具与脚本

| 脚本 | 作用 |
|---|---|
| `scripts/block-wechat-update.ps1` | 阻止微信自动升级（ACL + 清理 patch + 重命名更新器） |
| `scripts/restore-wechat-client.ps1` | 从 `state/backups/weixin_4.1.10.27.exe` 解包恢复固定版客户端 |
| `scripts/dev/download-wx-4.1.10.27.ps1` | 并行下载 4.1.10.27 安装包并校验 SHA256 |
| `scripts/dev/hook-offsets.py` | 偏移签名提取/跨版本搜索（移植辅助） |

## 7. 风险与边界

- Hook 属于注入/逆向，可能被杀软误报、被微信检测、导致账号风险；仅在个人测试账号使用。
- 微信服务端强制升级时，本地阻断可能只能延后、不能永久阻止；此时需要适配新 Hook 或改用 UI 自动化（弱回执）。
- 编译/分发 Hook DLL 涉及第三方闭源客户端，不要随代码仓库对外分发。
- 本项目保持 **Hook 失败时只读链路仍可用**，不会因 Hook 异常影响 reader/控制台。


## 8. 4.1.15.13 移植研究（实测，2026-10-18）

### 8.1 结论更正：数据段的“vtable 匹配”是误报

最初的 48 字节签名比对中，部分“vtable”候选（如 `0x80C4D28`）实际是**字符串常量/数据**，不是函数指针表：

```text
old=0x7415D28  entries: 0x321864f7e8678a37 ...   # 不是代码指针
new=0x80C4D28  entries: 相同字符串
```

因此不能把之前的 `unique=15/30` 当作可用 vtable 偏移。数据段整体存在固定平移，但只有**函数级验证**才可信。

### 8.2 函数级的有效进展

用 `scripts/dev/hook-port-assist.py find`（capstone 指令归一化 + 前 N 条指令同构匹配）得到：

| 旧偏移 | 新版本候选 | 匹配度 | 说明 |
|---|---|---|---|
| `offset.send_message` `0x1677A30` | `0x19D0BC0` / `0x19D1C70` / `0x19D2770` / `0x19D33B0` | 前 120 条指令同构 | 4 个消息类型克隆，prologue/栈帧完全一致（push rbp,r14,rsi,rdi,rbx; sub rsp,0x1e0; lea rbp,[rsp+0x80]） |
| `offset.txt_message_ctr` `0x6B2C30` | `0x766680` | 107/120 条指令同构 | 文本消息构造函数候选 |
| （构造函数内写入）旧 `0x82793E8` | `0x8E53588` | 结构对应 | 文本消息对象 vtable 候选（旧 `0x6B2C9B` lea → 新 `0x7666EB` lea） |

同时观察到**类 vtable 按索引对齐**的规律，可用于继续找同族函数：

```text
OLD class vtable 0x84ECAA8: [0x1678180, 0xA820, 0x1678320, 0x1678650, 0x1678660, 0x9760, 0, 1]
NEW class vtable 0x91123E8: [0x19D11E0, 0xAF10, 0x19D1380, 0x19D16B0, 0x19D16C0, 0x9EC0, 0, 1]
```

即同一类的新旧 vtable 表项按 index 一一对应，可把“旧函数 → 新函数”批量映射，再用 4 个 `send_message` 克隆各自的 vtable 第一项判断哪一个属于文本消息。

### 8.3 仍需解决

- 在 4 个 `send_message` 克隆中确定**文本消息**使用的那一个（可用类 vtable 索引映射 + 动态断点验证）；
- 定位 `param1_vtable`、`param2`/`param2_1/2_3` 等参数结构：`send` 里出现的 `0x8D84F50`、`0x9117C48` 经检查是**字符串常量**（不是 vtable），不能直接套用；
- 当前机器没有 MSVC/Windows SDK 编译器，只有 capstone/pefile 分析环境；完整移植前需要装 VS Build Tools 并做动态验证；
- 若短期不能完成，继续采用“固定 4.1.10.27 + 阻止自动更新 + 备份恢复”策略（已实现）。

> 研究脚本：`scripts/dev/hook-offsets.py`（签名扫描）、`scripts/dev/hook-port-assist.py`（函数相似搜索 / vtable 对齐辅助）。所有候选都必须经 IDA/Ghidra 或运行时断点验证，不能直接用于生产 Hook。
