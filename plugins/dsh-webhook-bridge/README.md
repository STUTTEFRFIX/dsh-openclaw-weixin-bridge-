# dsh-webhook-bridge

DSH（DeepSeek Harness）侧的 Cordis 插件：注册一个**受共享密钥保护的精确 POST 路由**，
每收到一个请求就通过 DSH 官方的 webhook 运行时（`ctx.webhookRuntime`）**创建一个新的
Workspace 会话**，并把请求里的文本作为 prompt 投递进去；可选同步等待本轮结束并回传回复正文。

用途：`OpenClaw（微信通道）→ HTTP POST → 本路由 → DSH 新会话`。

## 插件形态

| 项 | 值 |
| --- | --- |
| 插件名 | `webhook-bridge` |
| `inject` | `["webServer", "webhookRuntime"]` |
| 入口 | `lib/index.js`（`export { Config, apply, inject, name }`） |
| 组合方式 | 通过 `cordis.patch.yml`（`package.json` 的 `dsh.bundle.patch` 指向它）插入运行树 |
| 依赖 | `@deepseek-ai/dsh-webhook`（提供 `ctx.webhookRuntime`）、`@deepseek-ai/schemastery` |

## HTTP 契约

请求：

```
POST <path>                              # 精确匹配，无结尾斜杠/查询/片段
Content-Type: application/json; charset=utf-8
Authorization: Bearer <shared-secret>    # 或 x-bridge-secret: <shared-secret>

{ "text": "...", "title": "...", "workspacePath": "...", "sender": "...", "wait": true }
```

- `text` 必填且非空；`title`/`workspacePath`/`sender` 可选；`wait: true` 时同步等待本轮结束。
- t6 新增可选字段：`conversationId`（会话亲和键）、`fragments`（hook 侧已合并的段数）、
  `forwardRule`（hook 的命中规则，仅用于日志/审计）。
- 其它方法 → 405；content-type 非 JSON → 415；非 UTF-8 / 超大 / 非法 JSON → 400/413；
  密钥错 → 401；密钥未配置 → 503；`sender` 不在白名单 → 403；
  `workspacePath` 越界 → 403、不存在 → 404。

响应（JSON）：

| 状态 | 场景 | 正文要点 |
| --- | --- | --- |
| 202 | 已受理且**确认**新会话出现 | `{ status:"accepted", sessionId, requestId, originKey, reused, fragments, workspacePath, title }` |
| 202 | 命中会话亲和窗口（**不新建会话**） | `{ status:"merged", reused:true, deferred, sessionId, originKey, fragments, … }`：上一轮仍在跑时把正文并入下一次派发 |
| 200 | `wait:true` 且回合结束/需要输入 | `{ status, state, kind, sessionId, originKey, fragments, completedTurns, replyCount, replyText, replies, … }` |
| 200 | `state:"needs_input"`（**立即返回，不再等到超时**） | 额外带 `questionKind`、`question`、`questionHeader`、`options[]`、`multiSelect`；`replyText` 是**纯文本编号选项** |
| 400/401/403/404/405/413/415 | 请求被拒（`message` 不含请求数据） | `{ status:"error", code, message }` |
| 502 | 已派发但在 `confirmTimeoutMs` 内没发现新会话 | 同上 |
| 503 | 内部异常 / 密钥不可用 | 同上 |
| 504 | `wait:true` 但 `waitTimeoutMs` 内未结束（needs_input 与结束都会提前返回） | 同上 |

回合 `status` 取值：`completed` / `needs_input` / `aborted` / `error` / `blocked` / `running` / `merged` / `accepted`。
判定依据是会话日志的事件流（`turn/end.reason.kind`、未配对的 `ask_user_question` / `approval/asked`），
细节见 `docs/zh-CN/session-reuse-and-input.md`。

## 配置

见 `cordis.patch.yml`（本包内的默认值）与仓库 `config/dsh-webhook-bridge.patch.sample.yml`
（**占位符**版本，用于复制到你自己的 profile 组合文件）。关键项：

| 键 | 说明 |
| --- | --- |
| `path` | 精确路由，必须以 `/` 开头、非根、无结尾斜杠/查询/片段 |
| `source` | 桥接实例名，进入投递来源标识 |
| `secretFile` / `secretEnv` | 共享密钥来源。**环境变量 `DSH_BRIDGE_SECRET_FILE` 优先**（可指向别的密钥文件），未设置时用 `secretFile`（本机默认路径）兜底，两者都读不到再回退到 `secretEnv` 指定的环境变量。每次请求重读，便于轮换 |
| `workspaceRoot` | 允许创建会话的工作区根目录（请求里的 `workspacePath` 必须落在其内且已存在） |
| `permissionPreset` / `agentPreset` | 会话权限档位与 agent preset |
| `allowSenders` | 发送者白名单，留空表示不校验 |
| `maxBodyBytes` / `confirmTimeoutMs` / `waitTimeoutMs` | 体积上限与两段超时 |
| `affinityWindowMs` / `minIntervalMs` | 会话亲和窗口与节流间隔（毫秒）；窗口内复用同一会话边界，过期新建并写日志 |
| `maxFragments` / `maxMergedChars` | 一次派发最多合并多少段 / 合并文本字符上限 |
| `questionTools` | 判定 `needs_input` 的工具名（默认 `["ask_user_question"]`） |
| `relay` | `true` 时把 `text` 直接作为新会话 prompt |
| `logFile` / `diagnostic` | 诊断日志与运行期探针（亲和/回合判定都会写进这里） |

## 安全边界

1. 共享密钥比较使用恒定时间（`timingSafeEqual`，先 SHA-256），长度差异不泄露。
2. `workspacePath` 做围栏校验（Windows 下大小写不敏感），且**不会**替调用方创建目录。
3. 请求体有字节上限、只接受严格 UTF-8、`Content-Length` 歧义写法直接拒绝。
4. 错误响应里的 `message` 不回带请求数据。
5. 密钥本身不写日志；`logFile` 只记录派发/规则命中等诊断信息。

## 验证

```bash
# 仓库级：语法 + 配置样例门禁
npm run check

# 联调（需要 DSH 正在运行、密钥文件存在）：
pwsh -File scripts/test-bridge.ps1 -NegativeCase   # 先跑负例：错误密钥必须 401
pwsh -File scripts/test-bridge.ps1                 # 正例：预期 202 且响应含 sessionId
pwsh -File scripts/test-bridge.ps1 -Wait           # 同步等待并回传回复正文

# 会话侧排查（三个脚本的第 1 个参数是会话存储根目录，默认 <stateDir>/sessions）：
node scripts/list-sessions.mjs   "$env:USERPROFILE\.dsh\sessions"
node scripts/inspect-session.mjs "$env:USERPROFILE\.dsh\sessions"
node scripts/read-reply.mjs      "$env:USERPROFILE\.dsh\sessions" <sessionId 片段> 3
node scripts/verify-fence.mjs                       # 工作区围栏逻辑自检（自带用例，无需参数）
```

## 相关

- OpenClaw 侧的调用方：`plugins/openclaw-hook-dsh-bridge/`（把微信入站正文 POST 到本路由）。
- 已知限制：本插件只负责「微信 → DSH」；把 DSH 的回复送回微信**尚未实现**（见仓库根 README）。
