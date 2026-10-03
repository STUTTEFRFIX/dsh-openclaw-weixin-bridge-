# dsh-openclaw-weixin-bridge

把**微信（OpenClaw 微信通道）** 与 **DSH（DeepSeek Harness）** 桥接起来：微信收到的消息
交给 DSH 处理，DSH 用会话（session）承载每一轮对话。

> 本文是仓库骨架说明。中文技术文档见 `docs/zh-CN/`（已交付 2 页：hook 转发判断、会话复用与 needs_input）；
> `docs/en/` 为**规划中、尚未交付**，英文文档由 t3 落地（见 `DELIVERY-t1.md` 的未验证项）。

## 仓库结构

| 路径 | 角色 | 状态 |
| --- | --- | --- |
| `plugins/dsh-webhook-bridge/` | **DSH 侧**：Cordis 插件。注册受共享密钥保护的精确 POST 路由，收到请求即创建一个新的 Workspace 会话并投递 prompt；带工作区围栏、发送者白名单、派发后确认会话确实建成、可选同步等待回复 | 已实现（本仓库固有资产） |
| `plugins/openclaw-hook-dsh-bridge/` | **OpenClaw 侧**：hook pack。订阅 `message:received`（入站，按判断规则转发）与 `message:sent`（出站标记环，防自回环）；同源多段合并后 POST 给上面的 DSH 路由，并把 `completed` / `needs_input` / `aborted` 三态写进审计日志 | 已实现 |
| `packages/openclaw-weixin-runtime-fix/` | **运行时修复包**：修补 OpenClaw `worker-task-pool` 的结构化克隆失败（`DataCloneError`）导致的「消息可收不可回」，含补丁生成器、apply/revert 与回滚说明 | 已实现（非受支持改法） |
| `config/` | 配置样例（DSH 组合片段、OpenClaw hooks 片段、hook 旁挂 JSON），**全部为占位符** | 已实现 |
| `scripts/` | 仓库级校验脚本与桥接联调脚本 | 已实现 |
| `docs/zh-CN/`、`docs/en/` | 文档：`docs/zh-CN/` 已交付 2 页；`docs/en/` 规划中、尚未交付（t3 负责） | 部分交付 |

数据流向：

```
微信 App ──> OpenClaw Gateway（openclaw-weixin 通道）
                │  message:received
                ▼
        plugins/openclaw-hook-dsh-bridge/handler.js
                │  1) 判断（#dsh 前缀 / 回复标记 / 出站标记环 / 闲聊跳过 / 能力信号；默认 default-skip）
                │  2) 同源多段合并（静默窗口 coalesceMs=1500ms）
                │  3) POST { text, title?, workspacePath?, sender?,
                │            conversationId?, fragments?, forwardRule?, wait=true }
                │     + Authorization: Bearer <secret>
                ▼
        plugins/dsh-webhook-bridge（DSH webServer 精确路由，默认 /openclaw-wechat）
                │  ctx.webhookRuntime.dispatch(...) → 会话亲和/节流（minIntervalMs、affinityWindowMs）
                ▼
        DSH 新会话（prompt = 合并后的微信消息正文）
                │  turn/end（completed / aborted）或未回答的 ask_user_question
                ▼
        回执 { status, state, sessionId, replyText, options?, … }（needs_input 时 replyText 为纯文本编号选项）
```

> 出站（`message:sent`）只用于**记录标记环**，本 hook **不会**把回复发回微信；这是本项目未解决的一环，
> 见下文「已知问题与限制」。

## 快速开始

前置：DSH（含 `webServer` 与 `webhookRuntime` 服务）、OpenClaw（本仓库依据 2026.9.7 核对）、
Node.js ≥ 22.13。

```bash
# 1) 准备共享密钥（仓库外，一行即可；不要提交）
#    例：<stateDir>/bridge-secret.txt 或环境变量 DSH_BRIDGE_SECRET

# 2) DSH 侧：合并 config/dsh-webhook-bridge.patch.sample.yml 进你的 profile 组合文件，
#    并按注释替换占位符（secretFile / workspaceRoot / permissionPreset / allowSenders…）

# 3) OpenClaw 侧：安装 hook pack
openclaw plugins install /path/to/repos/dsh-openclaw-weixin-bridge/plugins/openclaw-hook-dsh-bridge --force
openclaw hooks enable dsh-bridge

# 4) OpenClaw 侧：给 hook 配置 URL 与密钥（Gateway 进程环境变量或旁挂 JSON）
#    例：复制 config/dsh-bridge-hook.sample.json 到 <stateDir>/dsh-bridge-hook.json 并替换占位符

# 5) 若微信通道存在「消息可收不可回」，按修复包 README 打运行时修复并重启 Gateway
node packages/openclaw-weixin-runtime-fix/lib/targets.mjs        # 先看有哪几份副本
pwsh -NoProfile -File packages/openclaw-weixin-runtime-fix/scripts/apply.ps1 -DryRun
```

## 校验

```bash
npm run check               # ① 全部 JS 过 node --input-type=module --check（check-syntax）
                            # ② config/ 样例：JSON 可解析、YAML 键骨架与参考一致、仅占位符（check-config-samples）
                            # ③ 仓库级敏感内容扫描：受控文件 + .git 对象全量解压（scan-repo-hygiene）
npm run check:hygiene       # 只跑第 ③ 步（发布前/历史复验用；--json 可机读）
npm run test:hook-handler   # hook 行为自测：判断 / #dsh 前缀 / 自回环 / 合并窗口 / needs_input
npm run test:hook           # hook 包契约自测：清单 + HOOK.md + 宿主 discovery + 空宿主安全
npm run test:fix            # 运行时修复包自测（净化语义 + 生成器 + --real/--no-real 开关）
npm run test:gate           # apply/revert 门禁自测（全程在 %TEMP% 的合成夹具副本上）
npm test                    # 依次跑 check → test:hook-handler → test:hook → test:fix → test:gate
```

也可以单独跑：`node plugins/openclaw-hook-dsh-bridge/test/self-test.mjs`、
`node packages/openclaw-weixin-runtime-fix/test/verify-clone-fix.mjs`、
`pwsh -NoProfile -File packages/openclaw-weixin-runtime-fix/test/apply-gate-test.ps1`、
`node scripts/check-syntax.mjs`、`node scripts/check-config-samples.mjs`。

## 安全边界

1. **共享密钥**：DSH 侧从 `secretFile`（优先）或 `secretEnv` 读取，比较用恒定时间算法；
   OpenClaw 侧从 `DSH_BRIDGE_SECRET` 或旁挂 JSON 读取。两端必须一致。
2. **只走本机/受信地址**：hook 会把微信消息正文 POST 到你配置的 URL；只填可信地址。
3. **工作区围栏**：请求里的 `workspacePath` 必须落在 DSH 侧 `workspaceRoot` 内且已存在，
   否则 403/404。DSH 不会替你创建目录。
4. **白名单**：DSH 侧 `allowSenders` 非空时，`sender` 必须精确匹配；hook 转发的 sender
   来自 `event.context.from`。
5. **无密钥入库**：`config/` 全是占位符；`.gitignore` 排除常见密钥文件名；密钥文件放仓库外。

## 已知问题与限制（未解决 / 未验证，务必先读）

- **默认会「静默跳过」一部分消息（设计取舍，不是 bug）**：hook 的判断默认
  `judgment=on` + `defaultDecision=skip`，即**闲聊 / 问候 / 确认 / 追问类短消息（默认 ≤12 字）
  不转发**，也不会新建 DSH 会话。代价：一些你其实想交给 DSH 的模糊消息也会被跳过（只留一行
  `decision=skip rule=…` 审计日志）。三种解除方式：消息加 **`#dsh ` 前缀**、
  `DSH_BRIDGE_DEFAULT_DECISION=forward`、或 `DSH_BRIDGE_JUDGMENT=off`（后两者会回到「更激进转发」的行为）。
  详见 `docs/zh-CN/hook-judgment.md`，审计日志在 `<stateDir>/logs/bridge-forward.log`。
- **微信收不到 DSH 的回复（未解决）**：OpenClaw 的 hook 只能观察消息，不能在
  `message:received` 路径上把内容回投到微信会话——`event.messages` 只有 `/new`、`/reset`
  这类 command 路径会被消费（依据：OpenClaw 文档 `Writing hooks` 的 Reply delivery 表）。
  本仓库的 hook 因此不伪造回复投递，只把 DSH 的回复/`needs_input` 编号选项写进日志与返回值；
  把回复送回微信需要额外的出站方案（例如 OpenClaw 插件层的 typed hook 或官方发送接口），**尚未实现**。
- **`needs_input` 只能给出选项文本，不能替用户点击**：DSH 等待选择时桥接会立即回传
  `status:"needs_input"` 与纯文本编号选项（`1) … 2) …`），但把这段文本发到微信、以及把用户的
  「1」写回 DSH 回合，仍属部署方的出站/入站路径（本仓库未实现）。
- **会话亲和是「合并到同一次派发」，不是「追加进同一会话历史」**：`@deepseek-ai/dsh-webhook`
  只提供「创建一个新会话」这一个动作（无 continue API），窗口过期即新会话；细节见
  `docs/zh-CN/session-reuse-and-input.md`。
- **运行时修复属于非受支持改法**：它修改 OpenClaw 发行包内文件，升级即失效；
  其现场条件（`request.env` 不可克隆）在本机 Node v24.21.0 上未能复现，
  详细验证边界见 `packages/openclaw-weixin-runtime-fix/README.md`。
- **端到端联调**：本仓库的自动化验证都是**离线/合成**的（不联网、不需要真实微信账号、
  不改动已部署环境）；真实微信端到端仍需按 `scripts/test-bridge.ps1` 在你自己的环境里跑。
- **英文文档尚未交付**：`docs/zh-CN/` 已有 2 页中文技术文档；`docs/en/` 规划中（由 t3 落地）。
- 版本相关：hook 约定、事件键、`openclaw.hooks` 清单规则都是按 **openclaw 2026.9.7**
  磁盘上的文档与 dist 代码核对的；其它版本可能不同。

## 许可

MIT，见 [LICENSE](./LICENSE)。仓库内所有配置样例一律使用占位符，禁止提交任何真实密钥。
