# dsh-openclaw-weixin-bridge

把**微信（OpenClaw 微信通道）** 与 **DSH（DeepSeek Harness）** 桥接起来：微信收到的消息
交给 DSH 处理，DSH 用会话（session）承载每一轮对话。

> 本文是仓库骨架说明。中文技术文档见 `docs/zh-CN/`（已交付 2 页：hook 转发判断、会话复用与 needs_input）；
> `docs/en/` 为**规划中、尚未交付**，英文文档由 t3 落地（见 `DELIVERY-t1.md` 的未验证项）。

## 仓库结构

| 路径 | 角色 | 状态 |
| --- | --- | --- |
| `plugins/dsh-webhook-bridge/` | **DSH 侧**：Cordis 插件。注册受共享密钥保护的精确 POST 路由，收到请求即创建一个新的 Workspace 会话并投递 prompt；带工作区围栏、发送者白名单、派发后确认会话确实建成、可选同步等待回复 | 已实现（本仓库固有资产） |
| `plugins/openclaw-hook-dsh-bridge/` | **OpenClaw 侧**：hook pack。订阅 `message:received`，把微信通道入站正文 POST 给上面的 DSH 路由 | 已实现 |
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
                │  POST { text, sender, workspacePath?, wait }  + Authorization: Bearer <secret>
                ▼
        plugins/dsh-webhook-bridge（DSH webServer 精确路由，默认 /openclaw-wechat）
                │  ctx.webhookRuntime.dispatch(...)
                ▼
        DSH 新会话（prompt = 微信消息正文）
```

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
npm run check        # 仓库内所有 JS 通过 node --input-type=module --check；
                     # config/ 样例 JSON 可解析、YAML 键骨架与参考一致、且仅含占位符
npm run test:hook    # hook 包自测（清单契约 + handler 行为，不联网、不需要 OpenClaw）
npm run test:fix     # 运行时修复包自测（净化语义 + 生成器 + CLI + 语法门禁）
npm run test:gate    # apply/revert 门禁自测（全程在 %TEMP% 的合成夹具副本上）
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

- **微信收不到 DSH 的回复（未解决）**：OpenClaw 的 hook 只能观察消息，不能在
  `message:received` 路径上把内容回投到微信会话——`event.messages` 只有 `/new`、`/reset`
  这类 command 路径会被消费（依据：OpenClaw 文档 `Writing hooks` 的 Reply delivery 表）。
  本仓库的 hook 因此不伪造回复投递，只把 DSH 的回复写进日志；把回复送回微信需要额外的
  出站方案（例如 OpenClaw 插件层的 typed hook 或官方发送接口），**尚未实现**。
- **运行时修复属于非受支持改法**：它修改 OpenClaw 发行包内文件，升级即失效；
  其现场条件（`request.env` 不可克隆）在本机 Node v24.21.0 上未能复现，
  详细验证边界见 `packages/openclaw-weixin-runtime-fix/README.md`。
- **端到端联调**：本仓库的自动化验证都是**离线/合成**的（不联网、不需要真实微信账号、
  不改动已部署环境）；真实微信端到端仍需按 `scripts/test-bridge.ps1` 在你自己的环境里跑。
- 版本相关：hook 约定、事件键、`openclaw.hooks` 清单规则都是按 **openclaw 2026.9.7**
  磁盘上的文档与 dist 代码核对的；其它版本可能不同。

## 许可

MIT，见 [LICENSE](./LICENSE)。仓库内所有配置样例一律使用占位符，禁止提交任何真实密钥。
