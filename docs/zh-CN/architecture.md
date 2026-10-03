# 架构与组件（中文）

本文说明项目**是什么、由哪几块组成、请求怎么流动、每块能提供什么能力**，
以及每条能力声明对应仓库里的哪个文件/命令。

## 1. 项目定位

把**微信（OpenClaw 微信通道）** 的入站消息交给 **DSH（DeepSeek Harness）** 处理：

```text
微信用户 ──> OpenClaw Gateway（微信通道插件）
                 └─ 内部 hook（本仓库 hook pack）
                        └─ HTTP POST（共享密钥）────> DSH webServer 路由
                                                          └─ 新建 Workspace 会话（prompt = 微信正文）
```

**方向只有一条：微信 → DSH。** 反方向（把 DSH 的回复发回微信）**本仓库未实现**，
原因与后果见 `known-issues.md` 的 KI-2 / KI-3。

它由三块可独立安装/卸载的部件 + 三块支撑资产组成，见下表。

## 2. 组件

| 部件 | 位置 | 角色 | 形态 |
| --- | --- | --- | --- |
| DSH 侧桥接插件 | `plugins/dsh-webhook-bridge/` | 注册受共享密钥保护的精确 POST 路由；每收到一个请求就通过 `ctx.webhookRuntime` **创建一个新 Workspace 会话**并投递 prompt；可选同步等待回合结束并回传回复正文 | Cordis 函数插件（`lib/index.js` 导出 `Config / apply / inject / name`，`inject = ["webServer", "webhookRuntime"]`；组合片段 `cordis.patch.yml`） |
| 亲和与三态纯逻辑 | `plugins/dsh-webhook-bridge/lib/affinity.mjs` | 会话亲和槽（origin = `conversationId`，缺失时退化为 `sender`）、节流、多段合并、`detectTurnState` 三态判定 | 纯函数模块，无 I/O，可被自测直接 import |
| OpenClaw hook pack | `plugins/openclaw-hook-dsh-bridge/` | 订阅 `message:received`（判断 → 合并 → POST）与 `message:sent`（出站标记环，防自回环）；把三态与 `needs_input` 文本选项写进审计日志与返回值 | hook pack（`package.json` 的 `openclaw.hooks: ["."]`、`type: module`、无 `openclaw.extensions`），处理器 `handler.js` |
| 运行时修复包 | `packages/openclaw-weixin-runtime-fix/` | 修补 OpenClaw 发行包 `worker-task-pool-*.mjs` 的结构化克隆失败（`DataCloneError`）导致的「消息可收不可回」；含补丁生成器、apply/revert、门禁与回滚说明 | 非受支持改法（改 `node_modules`），见 `known-issues.md` 的 KI-1 |
| 配置样例 | `config/` | DSH 组合片段、OpenClaw hooks 片段、hook 旁挂 JSON 的**占位符**样例 | 全部为占位符；门禁 `scripts/check-config-samples.mjs` |
| 仓库级校验 | `scripts/` | 语法门禁、配置样例门禁、敏感内容门禁、桥接联调、会话排查 | 可直接 `node` / `pwsh` 运行 |
| 文档 | `docs/zh-CN/`、`docs/en/` | 本目录与英文对应页 | 逐页对应，见 `README.md` |

## 3. 数据流（含配置项落点）

```text
微信 App
  │
  ▼
OpenClaw Gateway —— 微信通道插件（本机核对的是 @tencent-weixin/openclaw-weixin）
  │  事件 message:received（context: from / content / channelId / metadata / conversationId…）
  ▼
plugins/openclaw-hook-dsh-bridge/handler.js
  │  ① 判断 decideForward（顺序即优先级，命中即停）：
  │       显式前缀 #dsh → 回复标记 [dsh] → 出站标记环 → judgment 开关(off 即转发)
  │       → 闲聊/问候/确认/追问（仅 ≤12 字）→ 能力信号（路径/命令/关键词/多行/长度≥30）
  │       → 默认结果 defaultDecision（默认 skip）
  │      每条判断写 bridge-forward.log（decision= / rule=）
  │  ② 同源多段合并（coalesceMs=1500ms，硬上限 coalesceMaxMs=5000ms）
  │  ③ POST <DSH_BRIDGE_URL>
  │     headers: Authorization: Bearer <secret>、content-type: application/json
  │     body:    { text, title?, workspacePath?, sender?, conversationId?,
  │                fragments?, forwardRule?, wait=true }
  ▼
plugins/dsh-webhook-bridge（DSH webServer 精确路由，默认 /openclaw-wechat）
  │  密钥校验（恒定时间比较）→ content-type/UTF-8/体积门禁 → 白名单 → 工作区围栏
  │  ctx.webhookRuntime.dispatch(...) → 亲和槽（affinityWindowMs=900000、minIntervalMs=1500）
  ▼
DSH 新建 Workspace 会话（prompt = 合并后的微信正文；权限档位 permissionPreset）
  │  turn/end（completed / aborted / error / blocked…）或未配对的 ask_user_question
  ▼
回执 JSON → hook 写 Gateway 日志（[dsh-bridge] …）与审计日志
  { ok, status, state, kind, sessionId, fragments, forwardRule, replyText, optionCount }
  state ∈ completed / needs_input / aborted / error / blocked / running / accepted / merged
```

依据：判断与合并见 `plugins/openclaw-hook-dsh-bridge/handler.js` 的 `JUDGMENT_CONFIG` /
`decideForward` / `resolveConfig`；请求体字段见同文件 `buildPayload`；路由与响应见
`plugins/dsh-webhook-bridge/lib/index.js` 与 `plugins/dsh-webhook-bridge/README.md` 的契约表。

## 4. HTTP 契约（DSH 侧）

| 方法/状态 | 场景 | 正文要点 |
| --- | --- | --- |
| `202` | 已受理且确认新会话出现 | `{ status:"accepted", sessionId, requestId, originKey, reused, fragments, workspacePath, title }` |
| `202` | 命中会话亲和窗口（不新建会话） | `{ status:"merged", reused:true, deferred, sessionId, originKey, fragments }` |
| `200` | `wait:true` 且回合结束 | `{ status, state, kind, sessionId, replyText, replies, … }` |
| `200` | `state:"needs_input"`（立即返回） | 额外带 `questionKind` / `question` / `questionHeader` / `options[]` / `multiSelect`；`replyText` 是纯文本编号选项 |
| `400 / 401 / 403 / 404 / 405 / 413 / 415` | 请求被拒（`message` 不含请求数据） | `{ status:"error", code, message }` |
| `502` | 已派发但 `confirmTimeoutMs` 内未见新会话 | 同上 |
| `503` | 内部异常 / 密钥不可用 | 同上 |
| `504` | `wait:true` 但 `waitTimeoutMs` 内未结束 | 同上 |

依据：`plugins/dsh-webhook-bridge/lib/index.js`；逐条说明见该包的 `README.md`。

## 5. 配置面（谁归谁）

| 适用侧 | 配置载体 | 键 | 文档 |
| --- | --- | --- | --- |
| DSH 桥接插件 | `<profile>` 内的 `cordis.patch.yml`（本机真实值） | `path` / `source` / `secretFile` / `secretEnv` / `workspaceRoot` / `permissionPreset` / `agentPreset` / `allowSenders` / `maxBodyBytes` / `confirmTimeoutMs` / `waitTimeoutMs` / `affinityWindowMs` / `minIntervalMs` / `maxFragments` / `maxMergedChars` / `questionTools` / `relay` / `logFile` / `diagnostic` | `plugins/dsh-webhook-bridge/README.md`、`config/dsh-webhook-bridge.patch.sample.yml` |
| hook（OpenClaw 侧） | 默认值 < 旁挂 JSON < Gateway 进程环境变量 < 事件内 per-hook env | `url` / `secret` / `workspacePath` / `channels` / `judgment` / `defaultDecision` / `forwardPrefix` / `replyMarker` / `botIds` / `loopWindowMs` / `coalesceMs` / `maxFragments` / `maxMergedChars` / `wait` / `timeoutMs` / `includeTitle` / `logBody` / `forwardLog` / `configFile` | `plugins/openclaw-hook-dsh-bridge/HOOK.md` 的配置表 |
| 联调脚本 | 环境变量 | `DSH_BRIDGE_BASE_URL`、`DSH_BRIDGE_SECRET_FILE` | `scripts/test-bridge.ps1` 的参数默认值 |

> 易错点：`minIntervalMs` / `affinityWindowMs` **只在 DSH 侧**生效；hook 侧没有这两个键。
> 工作区围栏也只有 DSH 侧的 `workspaceRoot`，**没有** `DSH_BRIDGE_WORKSPACE_ROOT` 这个 hook 变量
> （依据：`config/README.md`、`handler.js` 的 `pickEnvironmentOverrides`）。

## 6. 校验映射（能力声明 ↔ 命令）

`npm run check` 依次执行下面四步；其余命令按需单独跑（定义见根 `package.json`）。

| 命令 | 覆盖什么 | 涉及文件 |
| --- | --- | --- |
| `npm run check` | ① 语法 ② 配置样例 ③ 敏感内容 ④ 文档 | 下方四条 |
| `node scripts/check-syntax.mjs` | 仓库内全部 `.js/.mjs/.cjs` 过 `node --input-type=module --check` | `scripts/check-syntax.mjs` |
| `node scripts/check-config-samples.mjs` | `config/` 的 JSON 可解析、YAML 键骨架与参考样例一致、仅占位符 | `scripts/check-config-samples.mjs` |
| `node scripts/scan-repo-hygiene.mjs` | 受控文件 + `.git` 对象全量扫描，区分「真实命中」与「占位符命中」 | `scripts/scan-repo-hygiene.mjs` |
| `node scripts/check-docs.mjs` | 文档门禁：相对链接存在、代码块带语言、标题层级不跳级、表格列数一致、`docs/zh-CN` 与 `docs/en` 逐页对应、文档无敏感标识 | `scripts/check-docs.mjs` |
| `npm run test:hook-handler` | hook 行为：判断 / 前缀 / 自回环 / 合并窗口 / needs_input | `plugins/openclaw-hook-dsh-bridge/test-handler.mjs` |
| `npm run test:hook` | hook 包契约 + `HOOK.md` + 宿主 discovery 实测 + 空宿主安全 | `plugins/openclaw-hook-dsh-bridge/test/self-test.mjs` |
| `npm run test:fix` | 净化语义 + 补丁生成器 + `--real/--no-real` 开关 | `packages/openclaw-weixin-runtime-fix/test/verify-clone-fix.mjs` |
| `npm run test:gate` | apply/revert 门禁（全程在 `%TEMP%` 的合成夹具副本上） | `packages/openclaw-weixin-runtime-fix/test/apply-gate-test.ps1` |
| `npm test` | 依次跑 `check` → `test:hook-handler` → `test:hook` → `test:fix` → `test:gate` | 根 `package.json` |

断言条数以脚本输出为准，不在文档里写死。
