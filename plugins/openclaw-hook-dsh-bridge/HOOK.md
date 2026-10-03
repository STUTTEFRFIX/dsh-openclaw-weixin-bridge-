---
name: dsh-bridge
description: "把微信（OpenClaw 微信通道）入站消息按判断规则转发到 DSH 的 webhook 桥接端点，并把回合状态写进审计日志"
homepage: https://github.com/OWNER/dsh-openclaw-weixin-bridge
metadata:
  { "openclaw": { "emoji": "🌉", "events": ["message:received", "message:sent"] } }
---

# DSH Bridge Hook

把 OpenClaw 微信通道收到的**入站文本**转发到 DSH（DeepSeek Harness）侧的
webhook 桥接端点；DSH 收到后创建一个新会话，并把这段文本作为 prompt 投递。

本 hook 属于 **hook pack**：包根目录就是 hook 目录（`HOOK.md` + `handler.js`），
`package.json` 里用 `openclaw.hooks: ["."]` 声明。

## 它做什么

1. 订阅 `message:received`（微信通道入站消息已受理的那一刻）。
2. 读取消息正文（`event.context.content`）与发送者（`event.context.from`，
   退化到 `event.context.metadata.senderId`）。
3. 对配置的目标通道（默认 `openclaw-weixin`）执行一次
   `POST <DSH_BRIDGE_URL>`，请求体 `{ text, title?, workspacePath?, sender?, wait }`，
   鉴权头 `Authorization: Bearer <DSH_BRIDGE_SECRET>`。
4. 把转发结果写进 Gateway 日志（`[dsh-bridge] ...` 前缀），并把 DSH 侧返回的
   `sessionId` / `requestId` / 回复长度放进返回值。

## 它不做什么（重要）

- **不会**把 DSH 的回复发回微信。OpenClaw 的 Reply delivery 规则里，
  `event.messages` 只在 `/new`、`/reset` 这类 command 路径被消费；message 事件
  明确被列为 “Ignored as replies”（见《Writing hooks》的 Reply delivery 表）。
  本 hook 因此不写 `event.messages`，以免制造“已回复微信”的假象。
  把回复送回微信是本项目**未解决**的一环，见仓库根 README 的「已知问题」。
- 不转发无正文消息（纯图片/语音等 `content` 为空的消息只记一行日志）。
- 不解析、不落盘消息内容；正文默认不写日志。

## 配置

配置来源按优先级（后者覆盖前者）：

1. `HOOK.md` 无关；插件内置默认值。
2. 旁挂 JSON（`DSH_BRIDGE_HOOK_CONFIG`，默认
   `<OPENCLAW_STATE_DIR 或 ~/.openclaw>/dsh-bridge-hook.json`），键为 camelCase：
   `url`、`secret`、`workspacePath`、`channels`、`wait`、`timeoutMs`、
   `includeTitle`、`logBody`。
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
| `DSH_BRIDGE_WAIT` / `wait` | 否 | `false` | 传 `true` 时 DSH 会等到本轮结束并回传 `replies`（会拉长 Gateway 侧的等待）。 |
| `DSH_BRIDGE_TIMEOUT_MS` / `timeoutMs` | 否 | `15000` | 单次 POST 的超时毫秒数。 |
| `DSH_BRIDGE_INCLUDE_TITLE` / `includeTitle` | 否 | `false` | 是否用正文派生会话标题。 |
| `DSH_BRIDGE_LOG_BODY` / `logBody` | 否 | `false` | 是否把消息正文与 DSH 回复全文写进日志（默认只写长度）。 |
| `DSH_BRIDGE_HOOK_CONFIG` | 否 | 见上 | 旁挂 JSON 的路径。 |

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
node plugins/openclaw-hook-dsh-bridge/test/self-test.mjs

# 2) 宿主侧可见性
openclaw hooks list --json
openclaw hooks info dsh-bridge --json

# 3) 真实副作用：给 bot 发一条微信文本，然后在 Gateway 日志里找
#    [dsh-bridge] 已转发 channel=openclaw-weixin status=202 ... sessionId=webhook-...
```

## 边界与风险

- hook 代码是**受信任的本地代码**，与 Gateway 同进程运行（安装时宿主会打印
  “Hooks are trusted local code.”）。装之前先读完本目录的 `handler.js`。
- 转发意味着消息正文会离开 OpenClaw 进程、进入你配置的 DSH 端点；只填你信任的地址。
- 审计日志（`bridge-forward.log`）含发送者标识与会话键（不含正文，除非 `DSH_BRIDGE_LOG_BODY=1`），
  属敏感数据：限制权限、定期清理，勿提交进仓库或公开粘贴。
- 修改 `handler.js` 或 `HOOK.md` 后需要重启 Gateway（hook 文件与元数据不做热监听）。
