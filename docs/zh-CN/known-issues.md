# 已知问题与警告（中文）

本文是**独立的风险章节**，与根 `README.md` 的「已知问题与限制」互为详略版。
每条都给出：现象 → 原因 → 依据（仓库内文件/命令） → 缓解或处置 → 状态。

**状态口径**：`未解决` = 本项目内没有修法；`设计取舍` = 有意如此，靠配置或流程规避；
`已缓解` = 有护栏但无法根除；`未验证` = 没有实测证据，请勿当成可用能力。

## 汇总

| ID | 严重度 | 一句话 | 状态 |
| --- | --- | --- | --- |
| KI-1 | 高 | 运行时补丁落在 `node_modules` 内，OpenClaw 每次升级即丢失 | 未解决（非受支持改法） |
| KI-2 | 高 | 本仓库**不把 DSH 的回复发回微信**；微信出站受逐条 `contextToken` 限制，回传稳定性有限 | 未解决 |
| KI-3 | 中 | 同一条微信消息可能被「通道自带的 agent 回复」与「DSH 桥接回传」**两条路径各回一次** | 未解决（本仓库不做出站，风险来自部署方补的出站路径） |
| KI-4 | 中 | DSH 工作区协议（`AGENTS.md`）会让闲聊/短消息被反问或中止 | 设计取舍（靠 `default-skip` 与专用工作区规避） |
| KI-5 | 高 | `permissionPreset: danger-full-access` 等同于把可写全盘的会话交给一把共享密钥 | 设计取舍（默认 `workspace-write`） |
| KI-6 | 高 | 共享密钥缺失/不一致/泄漏的后果（503 / 401 / 被他人建会话） | 已缓解 |
| KI-7 | 中 | 工作区围栏缺失或过宽 → 任意路径都能拿到会话；过窄 → 转发全部 403 | 已缓解 |
| KI-8 | 中 | 默认 `default-skip`：闲聊/确认/追问类短消息**不转发**（会漏） | 设计取舍 |
| KI-9 | 中 | `needs_input` 只能给纯文本选项，不能替用户点击，也不能从微信收回「1」 | 未解决 |
| KI-10 | 中 | 会话亲和是「合并到同一次派发」，**不是**追加进同一会话历史 | 未解决（运行时无 API） |
| KI-11 | 低 | 转发判断是启发式规则，未在真实消息流上长期观察 | 未验证 |
| KI-12 | 中 | 审计日志含发送者标识与会话键（隐私） | 已缓解 |
| KI-13 | 中 | 自动化验证全是离线/合成；真实微信端到端未验证 | 未验证 |
| KI-14 | 低 | 运行时修复的固有代价：噪声日志、深度上限、只认一种结构指纹 | 设计取舍 |
| KI-15 | 中 | `DSH_BRIDGE_ECHO_BACK` 会被解析但**没有任何实现** | 未解决（勿误以为打开即可回传） |
| KI-16 | 中 | hook 与 Gateway 同进程运行，属受信任代码 | 设计取舍 |
| KI-17 | 中 | `message:received` 下 per-hook env 不可靠 | 已缓解（改用环境变量/旁挂 JSON） |
| KI-18 | 中 | DSH 侧插件没有安装器；运行时生效的是 `<profile>` 内那一份配置 | 设计取舍 |
| KI-19 | 低 | 微信把一句话拆成多段 → 需要合并窗口，硬上限 5000ms | 已缓解 |
| KI-20 | 低 | 中文页与英文页必须同步维护，否则双语漂移 | 流程要求 |

---

## KI-1 运行时补丁随 OpenClaw 升级丢失（高）

- **现象**：打完补丁后微信回复恢复正常；某次 OpenClaw 升级后「消息收得到、回复发不出去」复发。
- **原因**：补丁直接改写 OpenClaw 发行包内的 `node_modules/openclaw/dist/worker-task-pool-*.mjs`。
  升级会覆盖该文件，补丁与 `.orig-bak` 一并失效。
- **依据**：`packages/openclaw-weixin-runtime-fix/README.md`（「性质」「回滚要点」）、
  `packages/openclaw-weixin-runtime-fix/scripts/patch-worker-pool.ps1`（备份名固定 `<目标>.orig-bak`）。
- **缓解**：升级后重跑
  `pwsh -NoProfile -File packages/openclaw-weixin-runtime-fix/scripts/apply.ps1 -DistPath "<openclaw>\dist\worker-task-pool-XXXX.mjs"`；
  升级若留下旧的 `.orig-bak`，**不要**拷回去覆盖新版（版本不一致），直接删掉。
- **警告**：这是**非受支持改法**，不属于 OpenClaw 扩展点。`apply` 会先过语法/结构门禁再落盘，
  任何一步失败都不写目标文件（断言见 `test/apply-gate-test.ps1`）。

## KI-2 回复回传未实现 + 微信出站受 `contextToken` 限制（高）

- **现象**：本仓库安装后，DSH 处理完了，但微信里收不到任何回复。
- **原因一（本仓库的设计边界）**：OpenClaw 的 `Reply delivery` 规则里，`event.messages` 只在
  `/new`、`/reset` 这类 command 路径被消费，message 事件被明确列为“Ignored as replies”。
  因此 `plugins/openclaw-hook-dsh-bridge/handler.js` **不写** `event.messages`（避免制造“已回复”的假象），
  只把回复正文/`needs_input` 文本写进日志与返回值。
- **原因二（出站令牌）**：微信通道的出站调用需要**逐条消息**下发的 `contextToken`，
  它由微信 `getupdates` 接口随入站消息给出，由通道插件按「账号 + 用户」保存在自己的
  内存/持久化存储里，并且在发送请求里作为 `context_token` 传回。hook 事件里**拿不到**这个令牌，
  所以「用 hook 自己把回复发出去」这条路不稳定；能用的只有通道插件自己的发送路径或官方发送接口。
- **依据**：`handler.js`（全文件 `grep` `spawn` / `message send` / `sendBack` **0 命中**）、
  `plugins/openclaw-hook-dsh-bridge/HOOK.md` 的「它不做什么」、OpenClaw 自带文档
  `docs/automation/hooks/writing-hooks.md` 的 Reply delivery 表；
  令牌机制见本机通道包 `@tencent-weixin/openclaw-weixin` 的
  `dist/src/messaging/inbound.js`（`setContextToken` / `getContextToken` /
  `persistContextTokens`）与 `dist/src/api/api.js`（`context_token: params.contextToken`）。
- **旁证（仓库外，非本仓库结论）**：本机曾有一个**未随仓库发布**的部署版 hook，用
  `openclaw message send` CLI 做出站回传：9 次入站里 6 次成功、3 次以 `error=send timeout` 失败
  （30 秒超时）。记录见 DSH 工作区 `reports/notice-to-weixin-bridge-2026-10-03.md`（**仓库外**）。
- **缓解**：把回传交给部署方自己实现（官方发送接口/插件层 typed hook），并接受「令牌缺失或过期即失败」；
  或只把 `replyText` 当成审计产物。
- **别被误导**：本仓库没有回传实现，读到 KI-15 时也请注意 `DSH_BRIDGE_ECHO_BACK` 是空开关。

## KI-3 可能「双回复」（中）

- **现象**：同一条微信消息，用户可能收到两条回复——一条来自微信通道**自带的 agent 回复**，
  另一条来自「DSH 桥接的回复回传」。
- **原因**：这是两条**互不知情**的路径。通道插件自己会按 agent 流程回复该条消息；
  而本仓库的桥接在 DSH 侧另开一个会话处理同一段正文。一旦部署方补上出站回传（KI-2），
  两条路径就会各自发一条。KI-2 的旁证里，出站回传正是用 `openclaw message send` 另发了一条。
- **依据**：`handler.js` 的判断顺序与自回环过滤（回复标记 `[dsh]` + 出站标记环
  `loopWindowMs=180000` / 50 条）；`docs/zh-CN/hook-judgment.md` 的「防自回环」一节。
- **缓解**：只允许**一条**路径负责回复（要么关掉通道自带 agent 的自动回复，要么不做桥接回传）；
  若两条都要留，必须让回传文本带 `[dsh]` 之类标记，靠标记环把环路口拦掉。
- **注意**：本仓库自身**不会**产生双回复（它不做出站），该风险只在部署方补齐出站后出现。

## KI-4 DSH 工作区协议（`AGENTS.md`）会让闲聊被反问/中止（中）

- **现象**：转发过去的「你好」「这个可以吗」「继续」这类消息，DSH 侧回的是反问
  （比如“需求还不明确，请先确认范围”）或 `turn/end: aborted`，用户看不到有用的结果。
- **原因**：桥接创建的会话运行在你指定的 `workspaceRoot` 里，**该工作区的 `AGENTS.md`
  工作区协议会作为指令注入**。常见协议要求“先列需求清单、先方案后动手、有疑必问”，
  于是闲聊/短消息被当成不完整需求处理：要么反问，要么直接中止。
- **依据**：`docs/zh-CN/hook-judgment.md` 第 1 节记录了这条“文档改不动 hook 路径”的教训
  （`AGENTS.md` 约束的是 agent 主动调用，通道层 hook 是宿主事件驱动的自动转发）；
  状态语义见 `docs/zh-CN/session-reuse-and-input.md` 的三态判定表
  （`aborted` 来自 `turn/end.data.reason.kind`）。
- **缓解**：给桥接用一个**专门的、协议更宽松的工作区**（`workspaceRoot` / `workspacePath`
  指向它）；并依赖 hook 的默认判断（`judgment=on` + `defaultDecision=skip`）先把闲聊挡在门外。
- **代价**：这会漏掉一部分“其实需要 DSH”的模糊消息，见 KI-8。

## KI-5 `danger-full-access` 的风险（高）

- **现象**：把 `permissionPreset` 设为 `danger-full-access` 后，任何拿到共享密钥的人
  都能让桥接**新建一个可写全盘、可执行命令的会话**。
- **原因**：桥接的入口权限就是一把共享密钥，而 DSH 侧没有第二道身份校验（`allowSenders`
  是可选的、基于调用方自报的 `sender`）。`danger-full-access` 把“可写文件系统/可执行”的
  会话能力直接暴露在这把密钥后面。
- **依据**：`plugins/dsh-webhook-bridge/lib/index.js` 的 `Config.permissionPreset`
  （默认 `workspace-write`）与 `allowSenders`（默认 `[]` = 不校验）；
  `config/dsh-webhook-bridge.patch.sample.yml` 的注释。
- **缓解**：保持 `workspace-write`（默认值）；把 `workspaceRoot` 限到一个专用目录；
  填 `allowSenders`；只在本机/受信网段暴露 DSH 入口；轮换密钥。
- **推论**：`minIntervalMs`（默认 1500ms）只是节流，不是速率限制；密钥泄漏后仍可高频建会话。

## KI-6 共享密钥缺失、不一致或泄漏的后果（高）

- **现象与对应行为**：DSH 侧读不到密钥 → `503`；密钥不匹配 → `401`；
  hook 侧没配 `url`/`secret` → 只写一行日志、**不转发**（`result=unconfigured`）。
- **依据**：`plugins/dsh-webhook-bridge/README.md` 的响应表与安全边界；
  `handler.js` 的 `redact()`（密钥与 `Bearer …` 载荷出不了日志）。
- **缓解**：密钥文件放仓库外并限制权限（`DSH_BRIDGE_SECRET_FILE`）；
  不推荐把密钥塞进进程环境变量（`secretEnv`，容易随环境快照泄漏）；
  DSH 侧每次请求重读密钥文件，便于轮换（hook 侧改完需重启 Gateway）。
- **警告**：仓库里的样例一律是占位符；`.gitignore` 只排除常见文件名，
  提交前务必跑 `npm run check`（内含 `scan-repo-hygiene`）。

## KI-7 工作区围栏缺失或过宽的后果（中）

- **现象**：`workspaceRoot` 写成盘根/主目录时，任何 `workspacePath` 都能通过校验；
  写成过窄的具体目录时，hook 转发的 `workspacePath` 一律 `403`；写一个不存在的目录则 `404`。
- **原因**：DSH 侧只做“是否落在 `workspaceRoot` 之内且**已存在**”的校验（Windows 下大小写不敏感），
  并且**不会替你创建目录**。
- **依据**：`plugins/dsh-webhook-bridge/README.md` 的安全边界；
  `scripts/verify-fence.mjs`（围栏逻辑自带用例自检）；
  `config/README.md` 明确写了“**没有** `DSH_BRIDGE_WORKSPACE_ROOT` 这个 hook 侧变量”。
- **缓解**：`workspaceRoot` 用专用目录；hook 侧的 `workspacePath` 用同一个专用子目录；
  先跑 `node scripts/verify-fence.mjs` 与 `pwsh -File scripts/test-bridge.ps1 -NegativeCase`。

## KI-8 默认 `default-skip` 会漏转发（中，设计取舍）

- **现象**：闲聊 / 问候 / 致谢 / 纯表情 / 追问 / 确认类**短消息（默认 ≤12 字）**
  以及无法判定的消息不会转发，也不会新建 DSH 会话；只留一行 `decision=skip rule=…`。
- **原因**：这是刻意的保守默认，用来修掉“每条微信消息都新建一个会话”的会话爆炸。
- **依据**：`plugins/openclaw-hook-dsh-bridge/handler.js` 的 `decideForward` 与 `JUDGMENT_CONFIG`
  （`judgment=on`、`defaultDecision=skip`、`shortMessageMaxChars=12`、`capabilityMinChars=30`）；
  规则表见 `docs/zh-CN/hook-judgment.md`。
- **缓解（三选一）**：消息加显式前缀 `#dsh `；`DSH_BRIDGE_DEFAULT_DECISION=forward`；
  `DSH_BRIDGE_JUDGMENT=off`。后两者会回到“更激进转发”的行为。
  随后用 `rule=` 审计日志收紧或放宽。

## KI-9 `needs_input` 只能给文本（中）

- **现象**：DSH 等用户选择时，桥接会**立即**返回 `state:"needs_input"` 与纯文本编号选项
  （`replyText` 形如 `1) … 2) …`），但**不会**替用户点击，也**不会**把用户的「1」
  写回 DSH 的那个回合。
- **原因**：回传未实现（KI-2）；且 `@deepseek-ai/dsh-webhook` 只提供“创建并投递一个会话”这一个动作，
  没有“向已存在会话追加消息/回答”的 API。
- **依据**：`docs/zh-CN/session-reuse-and-input.md` 第 4 节与第 3 节；
  `plugins/dsh-webhook-bridge/lib/affinity.mjs` 的 `detectTurnState`；
  `handler.js` 的 `formatOptionsText`。
- **缓解**：把 `replyText` 当成给人工的待办（日志里能看到）；不要把它当作已闭环的交互。

## KI-10 会话亲和 ≠ 追加历史（中）

- **现象**：窗口内同一来源的消息可能被**合并到一次派发**，但上一轮**已经结束**后，
  下一条消息就是一个**新会话**（日志 `affinity-new-turn`），历史不连续。
- **原因**：DSH 的 `@deepseek-ai/dsh-webhook`（0.1.7-rc.2）只做 “create and prompt one root
  Session”，没有 continue/append API。
- **依据**：`docs/zh-CN/session-reuse-and-input.md` 第 3 节（含上游 README 原文引用）；
  `plugins/dsh-webhook-bridge/lib/affinity.mjs`。
- **缓解**：把 `affinityWindowMs` 调大只是“同一会话边界”的时间窗，**不能**让已结束的会话续接；
  真正的续接需要上游提供 resume/append，或本桥接改走 agent/session 层自持句柄（未实现）。

## KI-11 判断规则是启发式，未长期观察（低，未验证）

- **现象**：阈值（12 / 30 字）与中英关键词表是**按现象设计的启发式**，你的用语可能不匹配，
  于是出现漏报/误报。
- **依据**：`docs/zh-CN/hook-judgment.md` 第 6 节「未验证项」；规则实现见 `handler.js` 的 `PATTERNS`。
- **缓解**：用 `bridge-forward.log` 的 `rule=` 事后复盘，按需调整；
  不要指望它等同于语义判断。

## KI-12 审计日志的隐私边界（中）

- **现象**：`<stateDir>/logs/bridge-forward.log` 每行含 `from=<sender id>`、`origin=<会话键>`
  与命中规则；打开 `DSH_BRIDGE_LOG_BODY=1` 后**还会写入正文与回复全文**。
- **依据**：`handler.js` 的 `appendForwardLog`；`HOOK.md` 的「边界与风险」；
  `docs/zh-CN/hook-judgment.md` 第 5 节。
- **缓解**：限制文件权限、定期轮转/清理；不要把该文件提交进仓库或贴进公开 issue；
  默认保持 `logBody=false`（只写长度）。

## KI-13 端到端未验证（中，未验证）

- **未验证清单**：
  1. 自动化验证全部是**离线/合成**的（不联网、不需要真实微信账号、不改动已部署环境）；
  2. **没有**做过“微信消息 → DSH → 回复文本回到微信”的真实端到端；
  3. `apply` / `revert` **没有**对真实 OpenClaw 安装执行过（只在 `%TEMP%` 合成夹具上跑，
     见 `packages/openclaw-weixin-runtime-fix/test/apply-gate-test.ps1`）；
  4. hook 只验证了宿主 discovery 能发现本包（`test/self-test.mjs`），
     `openclaw plugins install` 与真实 `message:received` 触发**未执行**；
  5. `DataCloneError` 的现场条件在本机 Node v24.21.0 上**未能复现**
     （`structuredClone(process.env)` 可克隆），自测用等价合成对象覆盖语义。
- **依据**：`DELIVERY-t1.md` §4、`packages/openclaw-weixin-runtime-fix/README.md` 的
  「已知限制与未验证项」、`docs/zh-CN/session-reuse-and-input.md` 第 6 节。
- **缓解**：在你自己的环境按 `installation.md` 第 6 节逐步验证，并把结果写进你的部署记录。

## KI-14 运行时修复的固有代价（低，设计取舍）

- `apply` 只认**一种**结构指纹；上游改了 `worker.postMessage` 的形状，`lib/gen-patch.mjs`
  会**拒绝生成**（退出码 2）而不是改坏文件——此时需要按新指纹更新生成器。
- 修复后每次派发仍会先在日志留下一次 `DataCloneError`（补丁随即救援成功）：诊断噪声，不是失败。
- 原生类型（`Map`/`Set`/`Date`/`ArrayBuffer`/`Promise` 等）不会被重建；它们自身不可克隆时
  重试如实失败，而不是伪造残缺对象。
- 超过 12 层深度的值在净化时会被丢弃（返回 `undefined`），避免异常路径上的无限代价深拷贝。
- 依据：`packages/openclaw-weixin-runtime-fix/README.md` 的「已知限制与未验证项」。

## KI-15 `DSH_BRIDGE_ECHO_BACK` 是空开关（中）

- **现象**：文档/代码里存在 `echoBack`（环境变量 `DSH_BRIDGE_ECHO_BACK`、旁挂 JSON 的 `echoBack`），
  但把它设为 `1`**不会**发出任何回复。
- **依据**：`handler.js` 里 `echoBack` 只出现在默认值、环境变量映射与配置文件键列表
  （`JUDGMENT_CONFIG.echoBack` / `pickEnvironmentOverrides` / `pickFileOverrides` / `resolveConfig`），
  **没有任何调用点**；同目录 `grep spawn`、`grep "message send"` 均为 0 命中。
- **缓解**：把它当作预留位；回传请按 KI-2 自己实现，并注意 KI-3 的双回复风险。

## KI-16 hook 与 Gateway 同进程、属受信任代码（中，设计取舍）

- **现象**：安装 hook 等于把本地代码放进 Gateway 进程运行（宿主在安装时会打印
  “Hooks are trusted local code.”）。
- **依据**：`plugins/openclaw-hook-dsh-bridge/HOOK.md` 的「边界与风险」。
- **缓解**：安装前通读 `handler.js`；只从本仓库或你信任的来源安装。

## KI-17 `message:received` 下 per-hook env 不可靠（中）

- **现象**：把 `DSH_BRIDGE_*` 写进 `hooks.internal.entries.dsh-bridge.env` 后可能完全不生效。
- **原因**：该事件的 context **不保证**带 `cfg`，per-hook `env` 也不会改写 `process.env`。
- **依据**：`handler.js` 的 `readEventHookEnv` 与文件头注释；`HOOK.md` 的配置来源说明；
  `config/openclaw-hooks.sample.json` 的 `$comment`。
- **缓解**：用 Gateway 进程环境变量或旁挂 JSON（`<stateDir>/dsh-bridge-hook.json`）。

## KI-18 DSH 侧没有安装器，改仓库模板不影响运行（中，设计取舍）

- **现象**：改了仓库里的 `plugins/dsh-webhook-bridge/cordis.patch.yml`，运行时行为不变。
- **原因**：运行时生效的是 `<profile>/node_modules/dsh-webhook-bridge/cordis.patch.yml`，
  与仓库文件是**独立副本**（非符号链接），本仓库不提供 DSH 侧安装器。
- **依据**：`DELIVERY-t7.md` §4.5 的实测记录；`config/README.md` 的复制位置说明。
- **缓解**：每次改配置都改 profile 内那一份；仓库模板只作为骨架与门禁基准。

## KI-19 多段消息与合并窗口（低，已缓解）

- **现象**：微信客户端可能把一句话拆成多段，导致“一句话建多个会话”。
- **缓解**：hook 用静默窗口合并（`coalesceMs=1500ms`，硬上限 `coalesceMaxMs=5000ms`），
  桥接侧再用亲和槽兜一层。
- **残留**：超过硬上限或跨窗口的消息仍会各自派发；按键取决于你的客户端行为。
- **依据**：`handler.js` 的合并状态机；`docs/zh-CN/session-reuse-and-input.md` 第 2 节。

## KI-20 双语漂移（低，流程要求）

- `docs/zh-CN/` 与 `docs/en/` 逐页对应；改一页请同步改另一页，
  并保持小节结构、表格列数与 ID（如 KI-2）一致，否则读者会得到两套不同的结论。
- 依据：本目录 `README.md` 的页面对照表。
