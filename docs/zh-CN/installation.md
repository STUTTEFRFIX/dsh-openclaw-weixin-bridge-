# 安装与配置（中文）

本文给出从零部署的三步流程（DSH 侧 → OpenClaw 侧 → 可选运行时修复），
以及升级、卸载、回滚与安全清单。**所有值都是占位符**，请替换为你自己的值，
且不要把真实值提交进任何仓库。

## 1. 前置与支持矩阵

| 项 | 要求 | 依据 |
| --- | --- | --- |
| DSH（DeepSeek Harness） | **0.1.7-rc.2** | `plugins/dsh-webhook-bridge/package.json` 的 `peerDependencies`：`@deepseek-ai/dsh-webhook: 0.1.7-rc.2`、`@deepseek-ai/cordis: ~4.0.4`；`@deepseek-ai/dsh-webhook` 0.1.7-rc.2 的运行时能力边界见 `session-reuse-and-input.md` |
| DSH 服务 | 需可用 `webServer` 与 `webhookRuntime` | `plugins/dsh-webhook-bridge/lib/index.js` 的 `inject = ["webServer", "webhookRuntime"]` |
| OpenClaw | **2026.9.7** | hook 清单规则、事件键、`Reply delivery` 边界均按该版本磁盘上的 `docs/automation/hooks/*` 与 `dist/*` 核对过（见 `plugins/openclaw-hook-dsh-bridge/README.md` 的「磁盘依据」表） |
| 微信通道 | OpenClaw 微信通道插件（本机核对的是 `@tencent-weixin/openclaw-weixin`）；通道 id 默认 `openclaw-weixin` | `plugins/openclaw-hook-dsh-bridge/handler.js` 的 `DEFAULT_CHANNELS`；`known-issues.md` 的 KI-2 引用了该插件的 `dist/src/messaging/inbound.js` 与 `dist/src/api/api.js` |
| Node.js | **≥ 22.13.0** | 四个 `package.json` 的 `engines.node` |
| PowerShell | 7+（`pwsh`），仅运行时修复包与联调脚本需要 | `package.json` 的 `test:gate`；`packages/openclaw-weixin-runtime-fix/scripts/*.ps1` |
| 操作系统 | Windows 上已核对；hook 与 DSH 插件本身是纯 Node/HTTP 逻辑，但脚本里的路径写法与 `pwsh` 依赖 Windows | `scripts/*.ps1`、`packages/openclaw-weixin-runtime-fix/scripts/*.ps1` |

> 版本口径：以上是**本仓库核对过**的版本，不是兼容性承诺。换版本后 hook 约定、事件键、
> `openclaw.hooks` 清单规则都可能变，请重新按 `plugins/openclaw-hook-dsh-bridge/README.md`
> 的磁盘依据表复核。

## 2. 第 0 步：准备共享密钥（仓库外）

两端必须用**同一个**密钥：

```powershell
# 生成一段随机密钥，写到仓库外的文件里（示例路径，换成你自己的）
$dir = Join-Path $env:USERPROFILE '.dsh'
New-Item -ItemType Directory -Force $dir | Out-Null
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 })) |
  Set-Content (Join-Path $dir 'bridge-secret.txt') -NoNewline
```

然后把环境变量指过去（DSH 侧优先读它）：

```powershell
$env:DSH_BRIDGE_SECRET_FILE = Join-Path $env:USERPROFILE '.dsh\bridge-secret.txt'
```

**不要**把密钥写进仓库文件：`.gitignore` 只排除 `dsh-bridge-hook.json`、`bridge-secret.txt`、
`config/*.local.*` 等常见文件名，它保护不了你手滑贴进去的内容。仓库自带
`node scripts/scan-repo-hygiene.mjs` 做兜底扫描（见第 6 节）。

## 3. 第 1 步：DSH 侧（`dsh-webhook-bridge`）

1. 把 `plugins/dsh-webhook-bridge/` 安装进你的 DSH profile（使其出现在 `<profile>/node_modules/dsh-webhook-bridge/`），
   并确保 `@deepseek-ai/dsh-webhook` 被加载——它是 `ctx.webhookRuntime` 的来源。
   本仓库**不提供** DSH 侧插件的安装器；请按你的 profile 机制（包管理/拷贝）安装。
2. 编辑**运行时生效的那一份**配置：`<profile>/node_modules/dsh-webhook-bridge/cordis.patch.yml`。
   仓库里的 `plugins/dsh-webhook-bridge/cordis.patch.yml` 是**包内模板**，改它不会影响已部署的桥接
   （两者是独立副本，非符号链接）。
   可以直接复制仓库的占位符样例 `config/dsh-webhook-bridge.patch.sample.yml` 再改值
   （键名与顺序刻意与模板一致，`node scripts/check-config-samples.mjs` 会做骨架比对）。
3. 必须替换的键：`path`、`source`、`workspaceRoot`，以及密钥来源（`DSH_BRIDGE_SECRET_FILE`
   环境变量 / `secretFile` / `secretEnv` 三者之一）。
4. 建议同时确定的键：
   - `allowSenders`：留空 = **不校验 sender**；填上 hook 转发过来的 `from` 值即精确匹配
     （不匹配返回 403）。
   - `permissionPreset`：默认与推荐都是 `workspace-write`；`danger-full-access` 的风险见
     `known-issues.md` 的 KI-5。
   - `waitTimeoutMs`：默认 120000；hook 侧 `timeoutMs` 必须**大于**它。
5. 重启 DSH（或按你的 profile 机制重新加载），然后用第 6 节的联调命令确认路由活着。

## 4. 第 2 步：OpenClaw 侧（hook pack）

```bash
# 拷贝安装（推荐）：安装到 <stateDir>/hooks/openclaw-hook-dsh-bridge
openclaw plugins install /path/to/repos/dsh-openclaw-weixin-bridge/plugins/openclaw-hook-dsh-bridge --force

# 或：链接安装（把包根加进 hooks.internal.load.extraDirs，不拷贝）
openclaw plugins install -l /path/to/repos/dsh-openclaw-weixin-bridge/plugins/openclaw-hook-dsh-bridge

openclaw hooks info dsh-bridge      # 确认被发现：name / events / handler / 阻塞原因
openclaw hooks enable dsh-bridge    # 写入 hooks.internal.entries.dsh-bridge.enabled = true
```

配置来源（后者覆盖前者，依据 `handler.js` 的 `resolveConfig`）：
默认值 < 旁挂 JSON < Gateway 进程环境变量（`DSH_BRIDGE_*`）< 事件内 per-hook env。

对 `message:received` 而言，**可靠来源是「Gateway 进程环境变量」或「旁挂 JSON」**：
该事件的 context 不保证带 `cfg`，per-hook env 也不会改写 `process.env`
（依据：`plugins/openclaw-hook-dsh-bridge/HOOK.md` 的说明）。

推荐做法：复制 `config/dsh-bridge-hook.sample.json` 到仓库外
（默认位置 `<stateDir>/dsh-bridge-hook.json`，可用 `DSH_BRIDGE_HOOK_CONFIG` 覆盖），
替换占位符并限制文件权限。最小可运行配置：

```json
{
  "url": "http://127.0.0.1:<DSH_WEB_PORT>/openclaw-wechat",
  "secret": "<DSH_BRIDGE_SECRET>",
  "workspacePath": "<workspace-root>",
  "channels": ["openclaw-weixin"]
}
```

改完 `handler.js` / `HOOK.md` / 配置后需要**重启 Gateway**（hook 代码与元数据不做热监听）。

## 5. 第 3 步（可选）：微信通道运行时修复

仅当出现「消息收得到、回复发不出去」且日志含 `DataCloneError` 时使用。
这是**非受支持改法**（改 OpenClaw 发行包内文件），升级即失效。

```bash
# 先只读查看本机有哪几份副本、哪份已打补丁
node packages/openclaw-weixin-runtime-fix/lib/targets.mjs
pwsh -NoProfile -File packages/openclaw-weixin-runtime-fix/scripts/patch-worker-pool.ps1 -Action status

# 空跑：生成 + 过门禁，但不覆盖任何文件
pwsh -NoProfile -File packages/openclaw-weixin-runtime-fix/scripts/apply.ps1 -DryRun

# 正式打补丁（多份副本时必须用 -DistPath 指明 Gateway 实际使用的那一份）
pwsh -NoProfile -File packages/openclaw-weixin-runtime-fix/scripts/apply.ps1 -DistPath "<openclaw>\dist\worker-task-pool-XXXX.mjs" -RestartGateway
```

回滚与未验证项见 `packages/openclaw-weixin-runtime-fix/README.md` 的「回滚说明」「已知限制与未验证项」。

## 6. 验证

### 6.1 仓库内（离线，不联网、不需要真实微信账号）

```bash
npm run check               # 语法 + 配置样例 + 敏感内容三道门禁
npm run test:hook-handler   # hook 行为自测
npm run test:hook           # hook 包契约 + 宿主 discovery + 空宿主安全
npm run test:fix            # 运行时修复包自测
npm run test:gate           # apply/revert 门禁（全程在 %TEMP%）
npm test                    # 依次跑上面全部
```

断言条数以脚本输出为准。

### 6.2 DSH 侧联调（需要 DSH 在运行、密钥文件存在）

```powershell
pwsh -NoProfile -File scripts/test-bridge.ps1 -NegativeCase   # 负例：错误密钥必须 401
pwsh -NoProfile -File scripts/test-bridge.ps1                 # 正例：预期 202 且响应含 sessionId
pwsh -NoProfile -File scripts/test-bridge.ps1 -Wait           # 同步等待并回传回复正文
```

### 6.3 真实副作用检查（需要真实微信账号）

1. 给 bot 发一条**会被转发**的消息（例如以 `#dsh ` 开头，避免被默认 `default-skip` 跳过）；
2. Gateway 日志里应出现 `[dsh-bridge] 已转发 channel=openclaw-weixin status=202 sessionId=…`；
3. DSH 侧应出现一个新会话，prompt 是该条消息正文；
4. 审计日志 `<stateDir>/logs/bridge-forward.log` 里应有对应的 `decision=forward rule=…` 行。

## 7. 升级、卸载与回滚

| 场景 | 操作 |
| --- | --- |
| 改 hook 代码/元数据 | 重新 `openclaw plugins install … --force`（或改链接目录内的文件）→ **重启 Gateway** |
| 卸载 hook | `openclaw plugins uninstall openclaw-hook-dsh-bridge`（或从 `hooks.internal.load.extraDirs` 移除）→ 重启 Gateway |
| 停用 hook（不卸载） | `openclaw hooks disable dsh-bridge`；或参考 `config/stopgap-disable-hook.patch.json5` 做临时旁路 |
| OpenClaw 升级后 | 运行时修复补丁**一定失效**（发行包文件被覆盖）；重新按第 5 节 apply，或干脆不修（见 KI-1/KI-14） |
| 回滚运行时修复 | `pwsh -NoProfile -File packages/openclaw-weixin-runtime-fix/scripts/revert.ps1 -DistPath "<openclaw>\dist\worker-task-pool-XXXX.mjs"` → 重启 Gateway；备份名固定为 `<目标>.orig-bak` |
| 轮换共享密钥 | 替换密钥文件内容；DSH 侧**每次请求重读**密钥文件，hook 侧需要重启 Gateway 后生效 |

## 8. 安全清单（部署前逐条打勾）

1. 两端密钥一致，且密钥文件在仓库外、权限最小化。
2. `DSH_BRIDGE_URL` 只指向你信任的地址（hook 会把消息正文 POST 过去）。
3. `workspaceRoot` 是**专用目录**，不要写成盘根或用户主目录；请求里的 `workspacePath`
   必须落在其内且已存在（越界 403，不存在 404，DSH 不会替你创建目录）。
4. `allowSenders` 尽量填具体值（留空 = 不校验）。
5. `permissionPreset` 用 `workspace-write`；除非你明确接受后果，不要用 `danger-full-access`。
6. 审计日志 `bridge-forward.log` 含发送者标识与会话键（不含正文，除非打开 `DSH_BRIDGE_LOG_BODY=1`）：
   限制权限、定期轮转，别提交进仓库或贴进公开 issue。
7. 发布前跑 `npm run check`（含 `scan-repo-hygiene`），确认没有真实密钥/账号 id/机器路径入库。
