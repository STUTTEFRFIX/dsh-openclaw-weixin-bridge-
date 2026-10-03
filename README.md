# dsh-openclaw-weixin-bridge

把**微信（OpenClaw 微信通道）** 与 **DSH（DeepSeek Harness）** 桥接起来：微信收到的消息交给 DSH 处理，
DSH 为每次派发创建一个 Workspace 会话，并把回合状态（`completed` / `needs_input` / `aborted`）回执给 hook。

**方向只有一条：微信 → DSH。** 把 DSH 的回复自动发回微信**本仓库未实现**（原因与代价见第 9 节）。

> 中英双语文档：中文 `docs/zh-CN/`，英文 `docs/en/`，逐页对应（页面对照表见 `docs/zh-CN/README.md`）。
> 本文是入口；深入阅读顺序建议：`docs/zh-CN/installation.md` → `docs/zh-CN/known-issues.md`。

## 1. 项目定位

| 项 | 说明 |
| --- | --- |
| 解决什么 | 让微信里发给 bot 的消息能被 DSH 本地能力处理（跑命令、读写工作区、查日志/报错、写代码），并把回合结果记进日志与返回值 |
| 不解决什么 | 不处理微信登录/扫码/账号（用 OpenClaw 官方通道）；不把回复发回微信；不提供 DSH 侧一键安装器；不承诺跨版本兼容 |
| 形态 | 一个插件仓库：DSH 侧 Cordis 插件 + OpenClaw 侧 hook pack + 可选的微信通道运行时修复包 + 配置样例与双语文档 |
| 许可 | MIT（见 `LICENSE`） |

详细职责划分与 HTTP 契约见 `docs/zh-CN/architecture.md`。

## 2. 支持矩阵

| 组件 | 核对过的版本 | 依据 |
| --- | --- | --- |
| DSH（DeepSeek Harness） | **0.1.7-rc.2** | `plugins/dsh-webhook-bridge/package.json` 的 `peerDependencies`（`@deepseek-ai/dsh-webhook: 0.1.7-rc.2`、`@deepseek-ai/cordis: ~4.0.4`） |
| OpenClaw | **2026.9.7** | hook 清单规则、事件键、`Reply delivery` 边界按该版本磁盘上的 `docs/automation/hooks/*` 与 `dist/*` 核对，逐条依据见 `plugins/openclaw-hook-dsh-bridge/README.md` |
| 微信通道 | OpenClaw 微信通道插件（本机核对的是 `@tencent-weixin/openclaw-weixin`），通道 id 默认 `openclaw-weixin` | `handler.js` 的 `DEFAULT_CHANNELS`；出站令牌机制见 `docs/zh-CN/known-issues.md` 的 KI-2 |
| Node.js | ≥ 22.13.0 | 四个 `package.json` 的 `engines.node` |
| PowerShell | 7+（`pwsh`），仅运行时修复包与联调脚本需要 | 根 `package.json` 的 `test:gate` 脚本 |
| 操作系统 | Windows 上已核对；hook 与 DSH 插件本身是纯 Node/HTTP 逻辑，脚本依赖 Windows 路径与 `pwsh` | `scripts/*.ps1`、`packages/openclaw-weixin-runtime-fix/scripts/*.ps1` |

> 这是**核对过的版本**，不是兼容性承诺。换版本请重新按上表依据复核。

## 3. 仓库结构

| 路径 | 角色 |
| --- | --- |
| `plugins/dsh-webhook-bridge/` | **DSH 侧**：Cordis 插件。注册受共享密钥保护的精确 POST 路由，收到请求即通过 `ctx.webhookRuntime` 创建一个新的 Workspace 会话并投递 prompt；带工作区围栏、发送者白名单、派发后确认会话已建成、可选同步等待回复 |
| `plugins/openclaw-hook-dsh-bridge/` | **OpenClaw 侧**：hook pack。订阅 `message:received`（判断 → 合并 → POST）与 `message:sent`（出站标记环，防自回环）；把三态与 `needs_input` 编号选项写进审计日志与返回值 |
| `packages/openclaw-weixin-runtime-fix/` | **运行时修复包**（可选，非受支持改法）：修补 OpenClaw `worker-task-pool` 的结构化克隆失败（`DataCloneError`）导致的「消息可收不可回」，含生成器、apply/revert 门禁与回滚说明 |
| `config/` | 配置样例（DSH 组合片段、OpenClaw hooks 片段、hook 旁挂 JSON），**全部为占位符** |
| `scripts/` | 仓库级门禁与联调脚本：语法、配置样例、敏感内容扫描、桥接联调、会话排查 |
| `docs/zh-CN/`、`docs/en/` | 中文与英文文档（逐页对应） |

## 4. 数据流

```text
微信 App ──> OpenClaw Gateway（微信通道插件）
                │  message:received
                ▼
        plugins/openclaw-hook-dsh-bridge/handler.js
                │  1) 判断（#dsh 前缀 / 回复标记 / 出站标记环 / 闲聊跳过 / 能力信号；默认 default-skip）
                │  2) 同源多段合并（静默窗口 coalesceMs=1500ms，硬上限 5000ms）
                │  3) POST { text, title?, workspacePath?, sender?,
                │            conversationId?, fragments?, forwardRule?, wait=true }
                │     + Authorization: Bearer <secret>
                ▼
        plugins/dsh-webhook-bridge（DSH webServer 精确路由，默认 /openclaw-wechat）
                │  密钥校验 → 体积/UTF-8 门禁 → 白名单 → 工作区围栏
                │  ctx.webhookRuntime.dispatch(...) → 会话亲和/节流（minIntervalMs、affinityWindowMs）
                ▼
        DSH 新会话（prompt = 合并后的微信消息正文；权限档位 permissionPreset）
                │  turn/end（completed / aborted）或未回答的 ask_user_question
                ▼
        回执 { ok, status, state, kind, sessionId, fragments, forwardRule, replyText, optionCount }
             state ∈ completed / needs_input / aborted / error / blocked / running / accepted / merged
```

> 出站（`message:sent`）**只用于记录标记环**；本 hook **不会**把回复发回微信（第 8、9 节）。

## 5. 安装与配置（三步）

前置：DSH（含 `webServer` 与 `webhookRuntime` 服务）、OpenClaw 2026.9.7、Node.js ≥ 22.13。
完整步骤、密钥生成、围栏与升级/卸载/回滚见 `docs/zh-CN/installation.md`（英文 `docs/en/installation.md`）。

```bash
# 步骤 0：准备共享密钥（放仓库外，一行即可；例：<stateDir>/bridge-secret.txt）
#         并让 DSH 侧读到它：set DSH_BRIDGE_SECRET_FILE=<该文件>

# 步骤 1：DSH 侧 —— 把 plugins/dsh-webhook-bridge 装进你的 profile，
#         编辑运行时生效的那一份 <profile>/node_modules/dsh-webhook-bridge/cordis.patch.yml，
#         可按占位符样例 config/dsh-webhook-bridge.patch.sample.yml 复制后替换。

# 步骤 2：OpenClaw 侧 —— 安装 hook pack 并启用
openclaw plugins install /path/to/repos/dsh-openclaw-weixin-bridge/plugins/openclaw-hook-dsh-bridge --force
openclaw hooks enable dsh-bridge
#         再把 hook 的 URL/密钥配好（Gateway 进程环境变量，或旁挂 JSON）：
#         复制 config/dsh-bridge-hook.sample.json 到 <stateDir>/dsh-bridge-hook.json 并替换占位符

# 步骤 3（可选）：微信通道「消息可收不可回」时，按修复包 README 打运行时修复
node packages/openclaw-weixin-runtime-fix/lib/targets.mjs
pwsh -NoProfile -File packages/openclaw-weixin-runtime-fix/scripts/apply.ps1 -DryRun
```

## 6. 校验

```bash
npm run check               # ① 全部 JS 过 node --input-type=module --check（check-syntax）
                            # ② config/ 样例：JSON 可解析、YAML 键骨架与参考一致、仅占位符（check-config-samples）
                            # ③ 仓库级敏感内容扫描：受控文件 + .git 对象全量扫描（scan-repo-hygiene）
                            # ④ 文档门禁：相对链接、代码块语言、标题层级、表格列数、双语结构、敏感标识（check-docs）
npm run check:hygiene       # 只跑第 ③ 步（发布前/历史复验用；--json 可机读）
npm run check:docs          # 只跑第 ④ 步（--json 可机读）
npm run test:hook-handler   # hook 行为自测：判断 / #dsh 前缀 / 自回环 / 合并窗口 / needs_input
npm run test:hook           # hook 包契约自测：清单 + HOOK.md + 宿主 discovery + 空宿主安全
npm run test:fix            # 运行时修复包自测（净化语义 + 生成器 + --real/--no-real 开关）
npm run test:gate           # apply/revert 门禁自测（全程在 %TEMP% 的合成夹具副本上）
npm test                    # 依次跑 check → test:hook-handler → test:hook → test:fix → test:gate
```

也可以单独跑：`node plugins/openclaw-hook-dsh-bridge/test/self-test.mjs`、
`node packages/openclaw-weixin-runtime-fix/test/verify-clone-fix.mjs`、
`pwsh -NoProfile -File packages/openclaw-weixin-runtime-fix/test/apply-gate-test.ps1`、
`node scripts/check-syntax.mjs`、`node scripts/check-config-samples.mjs`、
`node scripts/scan-repo-hygiene.mjs`、`node scripts/check-docs.mjs`。

DSH 侧联调（需要 DSH 在运行、密钥文件存在）：

```powershell
pwsh -NoProfile -File scripts/test-bridge.ps1 -NegativeCase   # 负例：错误密钥必须 401
pwsh -NoProfile -File scripts/test-bridge.ps1                 # 正例：预期 202 且响应含 sessionId
```

断言条数以脚本输出为准，本文不写死。命令定义见根 `package.json`。

## 7. 安全边界

1. **共享密钥**：DSH 侧从 `secretFile`（或 `DSH_BRIDGE_SECRET_FILE` 指向的文件）或 `secretEnv` 读取，
   比较用恒定时间算法；OpenClaw 侧从 `DSH_BRIDGE_SECRET` 或旁挂 JSON 读取。两端必须一致。
2. **只走本机/受信地址**：hook 会把微信消息正文 POST 到你配置的 URL；只填可信地址。
3. **工作区围栏**：请求里的 `workspacePath` 必须落在 DSH 侧 `workspaceRoot` 内且**已存在**，
   否则 403/404；DSH 不会替你创建目录。围栏逻辑自检：`node scripts/verify-fence.mjs`。
4. **白名单**：DSH 侧 `allowSenders` 非空时，`sender` 必须精确匹配（不匹配 403）；留空 = 不校验。
5. **权限档位**：默认 `workspace-write`；`danger-full-access` 的风险见第 9 节。
6. **无密钥入库**：`config/` 全是占位符；`.gitignore` 排除常见密钥文件名；密钥文件放仓库外，
   提交前跑 `npm run check`（内含敏感内容扫描）。

## 8. 这不能做什么

1. **不能把 DSH 的回复自动发回微信**：本仓库没有出站发送实现（`handler.js` 不写 `event.messages`，
   也没有任何 `spawn` / `message send` 调用）。微信出站需要逐条消息的 `contextToken`，hook 事件里拿不到。
2. **不能让 DSH 复用同一个会话历史**：`@deepseek-ai/dsh-webhook` 只提供「创建并投递一个会话」一个动作；
   合并窗口的语义是「同一次派发」，不是「同一段历史」。
3. **不能替用户点击/回答 DSH 的选项**：`needs_input` 只回传纯文本编号选项，把「1」写回 DSH 回合仍属部署方。
4. **不是 OpenClaw 官方插件、也不保证兼容性**：hook pack 按 2026.9.7 的磁盘约定编写；
   运行时修复属**非受支持改法**，升级即失效。
5. **不转发纯媒体消息**：`content` 为空（纯图片/语音等）只记一行日志。
6. **不做微信账号侧配置**（登录/扫码/绑定）——用 OpenClaw 官方通道。
7. **不保证判断正确**：转发判断是可解释的启发式规则，不是模型判断，会漏报/误报。
8. **不提供 DSH 侧插件安装器**：需按你的 profile 机制安装并手动合并组合片段。

## 9. 已知问题与警告

> 完整版（每条含现象、原因、依据文件/命令、缓解方式、状态）见
> [`docs/zh-CN/known-issues.md`](docs/zh-CN/known-issues.md)｜英文 [`docs/en/known-issues.md`](docs/en/known-issues.md)。

- **补丁随 OpenClaw 升级丢失（KI-1）**：运行时修复改的是 `node_modules/openclaw/dist/worker-task-pool-*.mjs`，
  每次升级都会被覆盖，需要重新 apply；升级留下的旧 `.orig-bak` 不要拷回去覆盖新版。
- **回复回传未实现，且微信出站受 `contextToken` 限制（KI-2）**：该令牌由微信 `getupdates` 逐条下发、
  由通道插件按「账号 + 用户」保存，hook 事件里拿不到，因此「hook 自己发回复」这条路不稳定；
  本仓库**故意不伪造回传**，只把回复写进日志与返回值。
- **可能双回复（KI-3）**：微信通道自带的 agent 回复与「DSH 桥接回传」是两条互不知情的路径；
  一旦部署方补上出站回传，同一条消息可能被回两次。只让一条路径负责回复，或给回传加 `[dsh]` 标记。
- **DSH 工作区协议会让闲聊被反问/中止（KI-4）**：桥接会话运行在 `workspaceRoot` 里，
  该工作区的 `AGENTS.md` 会被注入；常见的「先确认需求、先方案后动手」协议会把闲聊/短消息处理成反问或 `aborted`。
- **`danger-full-access` 的风险（KI-5）**：等于把「可写全盘、可执行命令」的会话交给一把共享密钥；
  默认与推荐都是 `workspace-write`，并把 `workspaceRoot` 限到专用目录。
- **共享密钥缺失/不一致/泄漏（KI-6）**：DSH 侧读不到 → `503`；不匹配 → `401`；hook 侧未配置 URL/密钥 →
  只记日志不转发。密钥放仓库外并限制权限，定期轮换（DSH 侧每次请求重读密钥文件）。
- **工作区围栏缺失或过宽（KI-7）**：`workspaceRoot` 写成盘根/主目录时任何路径都能通过；
  写成过窄目录时转发一律 403；写成不存在的目录则 404。**没有** hook 侧 `DSH_BRIDGE_WORKSPACE_ROOT` 变量。
- **默认会「静默跳过」一部分消息（KI-8，设计取舍）**：`judgment=on` + `defaultDecision=skip`，
  闲聊/问候/确认/追问类短消息（默认 ≤12 字）不转发也不建会话。三种解除方式：消息加 `#dsh ` 前缀、
  `DSH_BRIDGE_DEFAULT_DECISION=forward`、或 `DSH_BRIDGE_JUDGMENT=off`（后两者会回到更激进的转发）。
  审计日志 `<stateDir>/logs/bridge-forward.log` 用 `rule=` 回答「为什么被跳过」。
- **`needs_input` 只能给文本（KI-9）**：会立即回传纯文本编号选项，但不能替用户点击、也不能从微信收回「1」。
- **会话亲和 ≠ 追加历史（KI-10）**：窗口内合并到同一次派发；上一轮结束后下一条消息就是新会话。
- **`DSH_BRIDGE_ECHO_BACK` 是空开关（KI-15）**：会被解析，但没有任何实现，打开它不会发出回复。
- **审计日志的隐私边界（KI-12）**：每行含发送者标识与会话键（打开 `DSH_BRIDGE_LOG_BODY=1` 还会含正文）；
  限制权限、定期清理，别提交或公开粘贴。
- **端到端未验证（KI-13）**：仓库内自动化验证全部是离线/合成的；`apply`/`revert` 未对真实 OpenClaw 安装执行；
  hook 只验证了宿主 discovery；`DataCloneError` 现场条件未在本机 Node v24.21.0 复现。

## 10. 文档地图

| 中文 | 英文 | 内容 |
| --- | --- | --- |
| `docs/zh-CN/README.md` | `docs/en/README.md` | 文档索引与阅读顺序 |
| `docs/zh-CN/architecture.md` | `docs/en/architecture.md` | 定位、组件、数据流、HTTP 契约、配置面、校验映射 |
| `docs/zh-CN/installation.md` | `docs/en/installation.md` | 前置与支持矩阵、三侧安装、密钥与围栏、升级/卸载/回滚 |
| `docs/zh-CN/known-issues.md` | `docs/en/known-issues.md` | **已知问题与警告**（KI-1…KI-20，必须读） |
| `docs/zh-CN/hook-judgment.md` | `docs/en/hook-judgment.md` | 入站消息的转发判断与审计 |
| `docs/zh-CN/session-reuse-and-input.md` | `docs/en/session-reuse-and-input.md` | 会话亲和、多段合并、三态回传与能力边界 |

各子包另有一份面向安装者的说明：`plugins/dsh-webhook-bridge/README.md`、
`plugins/openclaw-hook-dsh-bridge/README.md`（含逐条磁盘依据）、
`packages/openclaw-weixin-runtime-fix/README.md`、`config/README.md`。

## 11. 许可

MIT，见 [`LICENSE`](LICENSE)。仓库内所有配置样例一律使用占位符，禁止提交任何真实密钥/账号标识。

## English summary

**What it is**: a bridge from WeChat (via OpenClaw's WeChat channel) into DSH (DeepSeek Harness).
An OpenClaw hook pack forwards selected inbound messages to a DSH Cordis plugin, which creates a new
Workspace session per dispatch and reports the turn state (`completed` / `needs_input` / `aborted`) back
to the hook. Direction is one-way: **WeChat → DSH**.

**Support matrix**: DSH **0.1.7-rc.2** (pinned in `plugins/dsh-webhook-bridge/package.json`),
OpenClaw **2026.9.7** (hook rules verified against that version's on-disk docs and dist code),
Node.js ≥ 22.13.0, `pwsh` 7+ for the PowerShell scripts, Windows-verified paths.
These are verified versions, not a compatibility promise.

**Install in three steps**: (1) prepare a shared secret outside the repository and install the DSH-side
plugin into your profile, editing the live `<profile>/node_modules/dsh-webhook-bridge/cordis.patch.yml`;
(2) `openclaw plugins install <repo>/plugins/openclaw-hook-dsh-bridge --force` then
`openclaw hooks enable dsh-bridge` and configure the hook URL/secret via process env or the side-car
JSON; (3) optionally apply the WeChat runtime fix. Full steps: [`docs/en/installation.md`](docs/en/installation.md).

**What it cannot do**: it does not send DSH replies back to WeChat (no outbound implementation, and
WeChat outbound needs a per-message `contextToken` a hook event never carries); it cannot append to an
existing DSH session history; it cannot answer `needs_input` choices for the user; it is not an official
OpenClaw plugin and the runtime fix is an unsupported modification lost on every upgrade; it does not
handle WeChat account setup and does not guarantee judgement correctness.

**Known issues and warnings**: see [`docs/en/known-issues.md`](docs/en/known-issues.md) (KI-1…KI-20) —
node_modules patch lost on upgrade, outbound token limitation, possible double replies, the DSH
workspace `AGENTS.md` protocol turning small talk into counter-questions or aborts, the
`danger-full-access` permission risk, the consequences of a missing/mismatched shared secret and of a
missing or over-wide workspace fence, the conservative `default-skip` default, and the explicitly
unverified end-to-end paths.
