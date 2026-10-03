---
name: dsh-bridge
description: "把微信（OpenClaw 微信通道）入站消息按判断规则转发到 DSH 的 webhook 桥接端点，并把回合状态写进审计日志"
homepage: https://github.com/OWNER/dsh-openclaw-weixin-bridge
metadata:
  { "openclaw": { "emoji": "🌉", "events": ["message:received", "message:sent"] } }
---

# DSH Bridge Hook

把**确实需要 DSH 本地能力**的 OpenClaw 微信入站消息，按判断规则转发到 DSH（DeepSeek Harness）侧的
webhook 桥接端点；DSH 收到后创建一个新会话，并把这段文本作为 prompt 投递。

本 hook 属于 **hook pack**：包根目录就是 hook 目录（`HOOK.md` + `handler.js`），
`package.json` 里用 `openclaw.hooks: ["."]` 声明。

> ⚠️ **默认对闲聊 / 确认 / 追问类短消息「不转发」（`default-skip`）**——这是刻意的保守默认，
> 用来修掉「每条微信消息都新建一个 DSH 会话」的会话爆炸。想让某条消息一定转发，用
> **`#dsh ` 前缀**（如 `#dsh 帮我看下这段文字`）；想整体放宽，用
> `DSH_BRIDGE_DEFAULT_DECISION=forward`（无法判定时改为转发）或 `DSH_BRIDGE_JUDGMENT=off`（关闭内容判断）。
> 规则与代价的完整说明见仓库 `docs/zh-CN/hook-judgment.md`。

## 它做什么

1. 订阅 `message:received`（微信通道入站消息已受理的那一刻）与 `message:sent`（出站消息，用于自回环标记环）。
2. 读取消息正文（`event.context.content`）与发送者身份（`event.context.from` 以及 `metadata` 里的
   `senderId` / `senderUsername` / `senderE164`）。
3. **转发判断**（顺序见 `decideForward`）：显式前缀 → 回复标记 → 出站标记环 → 判断开关 →
   闲聊/问候/确认/追问（仅短消息，默认 ≤12 字）→ 能力信号（路径/命令/关键词/多行/长度≥30）→ 默认结果。
   每条判断都会写进 `bridge-forward.log`（`decision=` / `rule=`）。
4. **同源多段合并**：同一会话在静默窗口（默认 1500ms，硬上限 5000ms）内到达的多段消息合并成**一次** POST，
   避免一句话被微信拆段后各建一个会话。
5. 对目标通道（默认 `openclaw-weixin`）执行一次 `POST <DSH_BRIDGE_URL>`，鉴权头
   `Authorization: Bearer <DSH_BRIDGE_SECRET>`，请求体字段：
   `{ text, title?, workspacePath?, sender?, conversationId?, fragments?, forwardRule?, wait }`。
6. 把回执写进 Gateway 日志（`[dsh-bridge] …`）与审计日志，并把三态结果放进返回值：
   `{ ok, status, state, kind, sessionId, fragments, forwardRule, replyText, optionCount }`；
   `state` ∈ `completed` / `needs_input` / `aborted` / `error` / `blocked` / `running` / `accepted` / `merged`。
   `needs_input` 时 `replyText` 是**纯文本编号选项**（可直接发回微信让用户回「1」）。
7. 防自回环：`message:sent` 的出站文本进入有上限的标记环（默认 180s / 50 条），入站命中标记环、
   带回复标记（`[dsh]`）、来自 `DSH_BRIDGE_BOT_IDS` 或在 `metadata` 里标记为自身者一律跳过。

## 它不做什么（重要）

- **不会**把 DSH 的回复发回微信。OpenClaw 的 Reply delivery 规则里，
  `event.messages` 只在 `/new`、`/reset` 这类 command 路径被消费；message 事件
  明确被列为 “Ignored as replies”（见《Writing hooks》的 Reply delivery 表）。
  本 hook 因此不写 `event.messages`，以免制造“已回复微信”的假象。
  把回复送回微信是本项目**未解决**的一环，见仓库根 README 的「已知问题」。
- 不转发无正文消息（纯图片/语音等 `content` 为空的消息只记一行日志）。
- 不解析、不落盘消息内容；正文默认不写日志（`DSH_BRIDGE_LOG_BODY=1` 才写）。

## 配置

配置来源按优先级（后者覆盖前者）：

1. 插件内置默认值（下表“默认”列）。
2. 旁挂 JSON（`DSH_BRIDGE_HOOK_CONFIG`，默认
   `<OPENCLAW_STATE_DIR 或 ~/.openclaw>/dsh-bridge-hook.json`），键为 camelCase。
3. Gateway 进程环境变量（`DSH_BRIDGE_*`）。
4. 事件内 per-hook env：`event.context.cfg.hooks.internal.entries["dsh-bridge"].env`。

> `message:received` 的 context **不保证**带 `cfg`（见《Hook event types and
> context》），且 per-hook `env` **不会**改写 `process.env`（见《Hook
> configuration and discovery》）。所以对 `message:received` 而言，可靠来源是
> 「Gateway 进程环境变量」或「旁挂 JSON 文件」，per-hook env 只在事件真的带
> `cfg` 时生效。

| 键 | 必填 | 默认 | 说明 |
| --- | --- | --- | --- |
| `DSH_BRIDGE_URL` / `url` | 是 | 无 | DSH 桥接端点 URL，形如 `http://127.0.0.1:<DSH_WEB_PORT>/openclaw-wechat`。必须是 `http(s)://`。 |
| `DSH_BRIDGE_SECRET` / `secret` | 是 | 无 | 与 DSH 侧 `dsh-webhook-bridge` 的 `secretFile` / `secretEnv` 对应的共享密钥。 |
| `DSH_BRIDGE_WORKSPACE` / `workspacePath` | 否 | 空 | 传给 DSH 的工作区路径；必须落在 DSH 侧 `workspaceRoot` 之内且**已存在**，否则 DSH 返回 403/404。 |
| `DSH_BRIDGE_CHANNELS` / `channels` | 否 | `openclaw-weixin` | 允许转发的通道 id 列表（逗号分隔或 JSON 数组）。 |
| `DSH_BRIDGE_JUDGMENT` / `judgment` | 否 | `on` | `on` = 有判断的转发；`off` = 关闭**内容判断**（闲聊/能力信号），但回复标记与标记环仍生效。 |
| `DSH_BRIDGE_DEFAULT_DECISION` / `defaultDecision` | 否 | `skip` | 无法判定时的默认结果：`skip`（保守，不建会话）/ `forward`。 |
| `DSH_BRIDGE_FORWARD_PREFIX` / `forwardPrefix` | 否 | `#dsh` | 显式前缀：以此开头的消息无视判断直接转发（前缀不进入正文）。 |
| `DSH_BRIDGE_REPLY_MARKER` / `replyMarker` | 否 | `[dsh]` | 回复标记：入站正文以此开头即视为自身回传，跳过。 |
| `DSH_BRIDGE_BOT_IDS` / `botIds` | 否 | 空 | 视为 bot/自身的发送者 id 列表（逗号分隔）；命中即跳过。 |
| `DSH_BRIDGE_LOOP_WINDOW_MS` / `loopWindowMs` | 否 | `180000` | 出站标记环的时间窗（毫秒）。 |
| `DSH_BRIDGE_COALESCE_MS` / `coalesceMs` | 否 | `1500` | 同源多段合并的静默窗口（毫秒）；`0` = 不合并、立即转发。 |
| `DSH_BRIDGE_MAX_FRAGMENTS` / `maxFragments` | 否 | `20` | 一次合并最多几段。 |
| `DSH_BRIDGE_MAX_MERGED_CHARS` / `maxMergedChars` | 否 | `8000` | 合并文本字符上限。 |
| `DSH_BRIDGE_WAIT` / `wait` | 否 | **`true`** | `true` 时 DSH 等到本轮结束/需要输入再回执（这是拿到 `completed`/`needs_input`/`aborted` 三态的前提）。 |
| `DSH_BRIDGE_TIMEOUT_MS` / `timeoutMs` | 否 | **`130000`** | 单次 POST 超时（毫秒）。必须大于 DSH 侧 `waitTimeoutMs`（默认 120000），否则会先超时。 |
| `DSH_BRIDGE_INCLUDE_TITLE` / `includeTitle` | 否 | `false` | 是否用正文派生会话标题。 |
| `DSH_BRIDGE_LOG_BODY` / `logBody` | 否 | `false` | 是否把消息正文与 DSH 回复全文写进日志（默认只写长度）。 |
| `DSH_BRIDGE_FORWARD_LOG` / `forwardLog` | 否 | `<stateDir>/logs/bridge-forward.log` | 判断审计日志路径（留空则不写）。 |
| `DSH_BRIDGE_HOOK_CONFIG` | 否 | 见上 | 旁挂 JSON 的路径。 |
| `DSH_BRIDGE_ECHO_BACK` / `echoBack` | 否 | `false` | **预留：结果回传开关（尚未消费）**——handler 已解析该键，但当前**没有任何代码读取它**，设了不产生任何行为。它将是「在标记环保护下把 DSH 结果回传微信」功能的开关（用户已批准实现，尚未落地）。在实现前请勿依赖此键。 |

> 节流间隔 `minIntervalMs` 与亲和窗口 `affinityWindowMs` **不是 hook 侧配置**，
> 它们属于 DSH 桥接插件（见 `plugins/dsh-webhook-bridge/cordis.patch.yml`）。

只使用占位符，密钥不要提交进仓库；示例见仓库 `config/`。

## 安装与启用

```bash
# 方式 A：拷贝安装（推荐；安装到 <stateDir>/hooks/openclaw-hook-dsh-bridge）
openclaw plugins install /path/to/repos/dsh-openclaw-weixin-bridge/plugins/openclaw-hook-dsh-bridge --force

# 方式 B：链接安装（不拷贝，直接把包根加进 hooks.internal.load.extraDirs）
openclaw plugins install -l /path/to/repos/dsh-openclaw-weixin-bridge/plugins/openclaw-hook-dsh-bridge

# 查看与启用
openclaw hooks info dsh-bridge
openclaw hooks enable dsh-bridge
```

## 验证

```bash
# 1) 仓库内自测（不需要 OpenClaw 进程、不需要网络、不读任何真实配置）
node plugins/openclaw-hook-dsh-bridge/test-handler.mjs    # 行为：判断/前缀/自回环/合并窗口/needs_input
node plugins/openclaw-hook-dsh-bridge/test/self-test.mjs  # 包契约 + HOOK.md + 宿主 discovery + 空宿主安全

# 2) 宿主侧可见性
openclaw hooks list --json
openclaw hooks info dsh-bridge --json

# 3) 真实副作用：给 bot 发一条微信文本，然后在 Gateway 日志里找
#    [dsh-bridge] 已转发 channel=openclaw-weixin status=200 state=… sessionId=webhook-…
```

## 边界与风险

- hook 代码是**受信任的本地代码**，与 Gateway 同进程运行（安装时宿主会打印
  “Hooks are trusted local code.”）。装之前先读完本目录的 `handler.js`。
- 转发意味着消息正文会离开 OpenClaw 进程、进入你配置的 DSH 端点；只填你信任的地址。
- 审计日志（`bridge-forward.log`）含发送者标识与会话键（不含正文，除非 `DSH_BRIDGE_LOG_BODY=1`），
  属敏感数据：限制权限、定期清理，勿提交进仓库或公开粘贴。
- 修改 `handler.js` 或 `HOOK.md` 后需要重启 Gateway（hook 文件与元数据不做热监听）。
