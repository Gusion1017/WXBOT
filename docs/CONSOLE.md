# 本机只读 API（127.0.0.1:3210）

> 桌面版 `WXBOT.exe` 通过本服务读取会话/消息/状态；**网页控制台界面已移除**（改用桌面窗口，不再打开浏览器）。
> 安全（手册 §10）：只绑本机、CSRF 请求头 + Host/Origin 校验、只读（GET/HEAD 之外 405）。

## 启动

```powershell
npm start          # supervisor 按序拉起 reader → bridge → adapter → console(API)
npm run status     # 节点健康检查
```

桌面版会自动连接该服务；不需要手动打开浏览器。

## 安全模型

| 机制 | 实现 |
|---|---|
| 只绑本机 | `server.listen(port, '127.0.0.1')` |
| Host/Origin | 只接受 `127.0.0.1/localhost/[::1]:<port>`，否则 403 |
| CSRF | 所有 `/api/*` 要求 `x-console-token: <state/tokens/console.txt>`（常量时间比较），否则 401 |
| token 不出服务端 | reader/onebot/adapter/hook token 只留在服务端代理 |
| 只读 | `GET/HEAD` 之外 405；无发送/配置写入接口 |
| 日志 | 不打印 URL 查询串与 64-hex |

## 接口

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/` | 服务说明 JSON（无网页） |
| GET | `/api/meta` | 聚合：四节点健康 + hook + supervisor + 回执摘要 + 模型/人格 + 密钥 + 白名单 |
| GET | `/api/live` | reader SSE 代理（实时消息流，桌面版用 fetch 流读取） |
| GET | `/api/sessions` / `/api/contacts` / `/api/messages` | reader 代理 |
| GET | `/api/images/<64hex>` | 图片解密代理（base64） |

所有 `/api/*` 需要 `x-console-token`。

## 自检

```powershell
$token = (Get-Content state/tokens/console.txt -Raw).Trim()
Invoke-RestMethod http://127.0.0.1:3210/                                   # 服务说明（无 token 也可）
Invoke-RestMethod http://127.0.0.1:3210/api/meta -Headers @{ 'x-console-token' = $token }
curl.exe -s -N -m 3 -H "x-console-token: $token" http://127.0.0.1:3210/api/live   # 应看到 heartbeat
```
