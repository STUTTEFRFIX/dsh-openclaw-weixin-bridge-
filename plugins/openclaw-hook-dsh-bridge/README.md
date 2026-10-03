# openclaw-hook-dsh-bridge

OpenClaw 侧的可安装 **hook pack**：订阅 `message:received`（入站）与 `message:sent`（出站，用于自回环标记环），
把**确实需要 DSH 本地能力**的微信入站正文按判断规则 POST 给 DSH 的 webhook 桥接端点
（本仓库另一个包 `plugins/dsh-webhook-bridge`），由 DSH 创建新会话处理。方向：**微信 → DSH**。

> ⚠️ **默认对闲聊 / 确认 / 追问类短消息「不转发」（`default-skip`）**：这是修掉「每条消息都新建会话」的
> 保守默认。要让某条消息一定转发用 **`#dsh ` 前缀**；整体放宽用 `DSH_BRIDGE_DEFAULT_DECISION=forward`，
> 完全关闭内容判断用 `DSH_BRIDGE_JUDGMENT=off`。规则细节见 `docs/zh-CN/hook-judgment.md`。

## 它做什么

1. **判断**（`decideForward`，顺序即优先级）：显式前缀 `#dsh ` → 回复标记 `[dsh]` → 出站标记环 →
   判断开关 → 闲聊/问候/确认/追问（仅短消息，默认 ≤12 字）→ 能力信号（路径/命令/关键词/多行/长度≥30）
   → 默认结果（`skip`）。每次判断写 `bridge-forward.log`（`decision=` / `rule=`）。
2. **同源多段合并**：同一会话在静默窗口（`coalesceMs`，默认 1500ms；硬上限 `coalesceMaxMs=5000ms`）内到达的
   多段合并成**一次** POST。
3. **转发**：`POST <DSH_BRIDGE_URL>`，头 `Authorization: Bearer <secret>` +
   `content-type: application/json`，请求体
   `{ text, title?, workspacePath?, sender?, conversationId?, fragments?, forwardRule?, wait }`。
4. **回执**：写 Gateway 日志（`[dsh-bridge] …`）与审计日志；返回值
   `{ ok, status, state, kind, sessionId, fragments, forwardRule, replyText, optionCount }`，
   其中 `state` ∈ `completed` / `needs_input` / `aborted` / `error` / `blocked` / `running` / `accepted` / `merged`；
   `needs_input` 时 `replyText` 是**纯文本编号选项**。
5. **防自回环**：`message:sent` 的文本进有上限的标记环（`loopWindowMs=180000` / 50 条）；入站命中标记环、
   以 `[dsh]` 开头、发送者身份命中 `botIds`、或事件标记 `fromMe/isBot/self` → 跳过。

## 包结构

```text
package.json        声明 openclaw.hooks: ["."] 与 type: module（都是宿主加载所必需，见下）
HOOK.md             hook 描述与 metadata（name / metadata.openclaw.events = received + sent）
handler.js          处理器实现（默认导出 + 具名导出便于自测）
test-handler.mjs    行为自测：判断 / 前缀 / 自回环 / 合并窗口 / needs_input（条数以脚本输出为准）
test/self-test.mjs  包契约 + HOOK.md + 宿主 discovery 实测 + 空宿主安全（不联网、不读真实配置）
```

包根目录**就是** hook 目录：`HOOK.md` + `handler.js` 都在根上，`openclaw.hooks: ["."]`
把包根声明为 hook 路径。

## 为什么这样声明（磁盘依据）

| 约定 | 依据 |
| --- | --- |
| hook pack 必须在 `package.json` 里用 `openclaw.hooks` 声明 hook 目录，且必须是非空字符串数组 | openclaw 2026.9.7 自带文档 `docs/automation/hooks/configuration.md`（“A hook pack is a package whose package.json declares hook directories in openclaw.hooks”）、`docs/cli/hooks.md`；宿主代码 `dist/install-JC-hcU6X.mjs` 的 `resolveOpenClawHooks()`（缺 `hooks` → `missing_openclaw_hooks`，空数组 → `empty_openclaw_hooks`），数组元素经 `normalizeTrimmedStringList` 去空白 |
| 每个声明路径都会被解析成 `<packageDir>/<entry>`，必须落在包内，并且必须**直接就是一个 hook 目录**（含 `HOOK.md`） | 同文件 `installHookPackageFromDir()`（`isPathInside(packageDir, hookDir)`）与 `validateHookDir()`（缺 `HOOK.md` 报 `HOOK.md missing in …`）；发现侧同样逻辑见 `dist/discovery-Cs-Nc8JK.mjs`（`resolveContainedDir()` + `loadHookFromDir()`） |
| 声明路径允许等于包根 | 宿主用的包含判定是 `path.relative(base, target) === ""` 即「在内」（`isPathInsideWithRealpath` → `isPathInside`，见 `dist/package-update-activation-recovery.mjs` 里的实现），所以 `"."` 解析成包根后通过校验，随后 `loadHookFromDir` 直接在包根读 `HOOK.md` 与 handler |
| handler 文件按 `handler.ts → handler.js → index.ts → index.js` 顺序取第一个 | `validateHookDir()`（安装期）与 `loadHookFromDir()`（发现期）里的 `handlerCandidates` 数组 |
| `package.json` 必须有 `"type": "module"` | 宿主用原生 `await import(buildImportUrl(handlerPath, source))` 加载 handler（`dist/loader-L4OIn4zB.mjs`），模块类型由最近的上层 `package.json` 决定；openclaw 自身 `package.json` 就是 `"type": "module"`，捆绑 hook 的 `handler.js` 也全是 ESM |
| 不声明 `openclaw.extensions` | `dist/install-JC-hcU6X.mjs` 的 `resolveHookPackageKind()`：无 `extensions` → `hook-only`，声明了就会按 `plugin-capable` 处理，需要额外的插件清单 |

> 说明：`"."` 是上述代码接受的写法（很多文档示例用 `./hooks/my-hook` 这种嵌套形式）。
> 如果你偏好嵌套形式，可以把 `HOOK.md` 与 `handler.js` 移进 `hooks/dsh-bridge/`，
> 并把 `openclaw.hooks` 改成 `["./hooks/dsh-bridge"]` —— 但要同步改
> `test/self-test.mjs` 的路径断言（它按 `openclaw.hooks` 的声明去检查目录）。

## 安装

```bash
# 拷贝安装（推荐）：装到 <stateDir>/hooks/<包名>/
openclaw plugins install /path/to/repos/dsh-openclaw-weixin-bridge/plugins/openclaw-hook-dsh-bridge --force

# 链接安装：不拷贝，把包根加进 hooks.internal.load.extraDirs
openclaw plugins install -l /path/to/repos/dsh-openclaw-weixin-bridge/plugins/openclaw-hook-dsh-bridge

openclaw hooks info dsh-bridge      # 看 hook 是否被发现、事件、阻塞原因
openclaw hooks enable dsh-bridge    # 写入 hooks.internal.entries.dsh-bridge.enabled = true
```

`openclaw hooks enable` 不会导入 handler 证明它能跑，也不会触发事件；请按下面的
「验证」做一次真实副作用检查。修改 `handler.js` / `HOOK.md` 后需要重启 Gateway。

## 配置

配置来源优先级：默认值 < 旁挂 JSON < Gateway 进程环境变量（`DSH_BRIDGE_*`）< 事件内
per-hook env（`event.context.cfg.hooks.internal.entries["dsh-bridge"].env`，仅当事件带 `cfg`）。

> `message:received` 的 context 不保证带 `cfg`，per-hook `env` 也不会改写 `process.env`
> （见 `docs/automation/hooks/event-types.md` 与 `…/configuration.md`）。因此实际部署请用
> 「Gateway 进程环境变量」或「旁挂 JSON 文件」。示例见仓库 `config/`。

| 键 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `DSH_BRIDGE_URL` / `url` | 是 | — | DSH 桥接端点，如 `http://127.0.0.1:25567/openclaw-wechat`（仅 http/https） |
| `DSH_BRIDGE_SECRET` / `secret` | 是 | — | 与 DSH 侧 `dsh-webhook-bridge` 的 `secretFile`/`secretEnv` 对应的共享密钥 |
| `DSH_BRIDGE_WORKSPACE` / `workspacePath` | 否 | 空 | 传给 DSH 的工作区路径（必须落在 DSH 的 `workspaceRoot` 内且已存在） |
| `DSH_BRIDGE_CHANNELS` / `channels` | 否 | `openclaw-weixin` | 允许转发的通道 id（逗号分隔或 JSON 数组） |
| `DSH_BRIDGE_JUDGMENT` / `judgment` | 否 | `on` | `off` = 关闭**内容判断**（回复标记与标记环仍生效） |
| `DSH_BRIDGE_DEFAULT_DECISION` / `defaultDecision` | 否 | `skip` | 无法判定时：`skip`（不建会话）/ `forward` |
| `DSH_BRIDGE_FORWARD_PREFIX` / `forwardPrefix` | 否 | `#dsh` | 显式前缀，无视判断直接转发 |
| `DSH_BRIDGE_REPLY_MARKER` / `replyMarker` | 否 | `[dsh]` | 回复标记（入站命中即跳过） |
| `DSH_BRIDGE_BOT_IDS` / `botIds` | 否 | 空 | bot/自身的发送者 id 列表（命中即跳过） |
| `DSH_BRIDGE_LOOP_WINDOW_MS` / `loopWindowMs` | 否 | `180000` | 出站标记环时间窗（毫秒） |
| `DSH_BRIDGE_COALESCE_MS` / `coalesceMs` | 否 | `1500` | 同源多段合并静默窗口（0 = 关闭合并） |
| `DSH_BRIDGE_MAX_FRAGMENTS` / `maxFragments` | 否 | `20` | 一次合并最多几段 |
| `DSH_BRIDGE_MAX_MERGED_CHARS` / `maxMergedChars` | 否 | `8000` | 合并文本字符上限 |
| `DSH_BRIDGE_WAIT` / `wait` | 否 | **`true`** | 让 DSH 等到本轮结束/需要输入（拿到三态的前提） |
| `DSH_BRIDGE_TIMEOUT_MS` / `timeoutMs` | 否 | **`130000`** | 单次 POST 超时（须大于 DSH 侧 `waitTimeoutMs`=120000） |
| `DSH_BRIDGE_INCLUDE_TITLE` / `includeTitle` | 否 | `false` | 用正文派生会话标题 |
| `DSH_BRIDGE_LOG_BODY` / `logBody` | 否 | `false` | 是否把正文与回复全文写日志（默认只写长度） |
| `DSH_BRIDGE_FORWARD_LOG` / `forwardLog` | 否 | `<stateDir>/logs/bridge-forward.log` | 判断审计日志路径（空则不写） |
| `DSH_BRIDGE_HOOK_CONFIG` | 否 | `<OPENCLAW_STATE_DIR 或 ~/.openclaw>/dsh-bridge-hook.json` | 旁挂 JSON 路径 |
| `DSH_BRIDGE_ECHO_BACK` / `echoBack` | 否 | `false` | **预留：结果回传开关（尚未消费）**——已解析、当前无任何代码读取，设了无效果；将作为「标记环保护下回传 DSH 结果到微信」的开关（尚待实现） |

> 节流 `minIntervalMs` 与亲和窗口 `affinityWindowMs` 属于 **DSH 侧**插件配置
> （`plugins/dsh-webhook-bridge/cordis.patch.yml`），hook 侧设置它们不会生效。

## 验证

```bash
# 1) 仓库内自测（全部断言通过即可，不写死条数；不联网、不需要 openclaw、不读真实配置）
node plugins/openclaw-hook-dsh-bridge/test-handler.mjs   # 行为：判断/前缀/自回环/合并窗口/needs_input
node plugins/openclaw-hook-dsh-bridge/test/self-test.mjs # 包契约 + HOOK.md + 宿主 discovery + 空宿主安全

# 1b) 空宿主复验（SKIP 不计入失败；必须 exit 0 且打印汇总行）
$empty = Join-Path $env:TEMP "empty-host"; New-Item -ItemType Directory -Force $empty | Out-Null
$env:USERPROFILE = $empty; $env:DSH_WIN_HOME = $empty; $env:APPDATA = $empty
node plugins/openclaw-hook-dsh-bridge/test/self-test.mjs
# 预期：`---- self-test 汇总：<N> passed, 0 failed, 1 skipped ----` 且 exit 0

# 2) 宿主侧
openclaw hooks list --json
openclaw hooks info dsh-bridge --json

# 3) 真实副作用：给 bot 发一条微信文本，然后在 Gateway 日志里找
#    [dsh-bridge] 已转发 channel=openclaw-weixin status=202 sessionId=webhook-…
#    同时 DSH 侧应出现一个新会话（含该消息正文）
```

## 明确的能力边界

- **不做回复回传**：DSH 的回复只写日志（`replyChars=`，`logBody` 打开时写全文）并作为
  handler 返回值返回。按 `docs/automation/hooks/writing-hooks.md` 的 Reply delivery 表，
  message 事件的 `event.messages` 不会投递给会话，所以这里**不写** `event.messages`，
  以免造成“已回复微信”的假象。把回复发回微信是本项目未解决的一环（见仓库根 README）。
- 纯媒体消息（`content` 为空）只记一行日志，不转发。
- hook 与 Gateway 同进程运行、属受信任代码；转发意味着消息正文会进入你配置的 DSH 端点。
- 共享密钥只从配置读取，所有日志输出都过 `redact()`；正文默认不写日志。
- **审计日志含发送者标识**：`bridge-forward.log` 每行会记录 `from=<sender id>`、`origin=<会话键>`
  与命中规则（**不含正文**，除非显式打开 `DSH_BRIDGE_LOG_BODY=1`）。按敏感数据对待：限制文件权限、
  定期轮转/清理，不要把该文件提交进仓库或贴进公开 issue。
