# config/ —— 配置样例（全部为占位符）

本目录只放**样例**，不放任何可用的真实值。所有密钥/token/账号 id 一律使用明确的占位符，
并且 `scripts/check-config-samples.mjs` 会在 CI/自检里扫描本目录，命中可疑真实值即失败。

| 文件 | 用途 | 该复制到哪里 |
| --- | --- | --- |
| `dsh-webhook-bridge.patch.sample.yml` | **DSH 侧**：`dsh-webhook-bridge` 插件的 Cordis 组合片段（路由、共享密钥来源、工作区根、权限档位等）。**只含占位符**：`secretFile: ''`（由 `$env:DSH_BRIDGE_SECRET_FILE` 或 `<stateDir>/bridge-secret.txt` 提供）、`workspaceRoot: '<workspace-root>'` | 合并进你的 DSH profile 组合文件；键名与顺序与 `plugins/dsh-webhook-bridge/cordis.patch.yml` 一致 |
| `dsh-webhook-bridge.patch.local.yml` | **本机真实值**（密钥文件绝对路径、本机工作区根）。被 `.gitignore` 的 `config/*.local.*` 排除，**不会**进版本库 | 仅本机保留；部署时把这些值覆盖进 `<profile>/node_modules/dsh-webhook-bridge/cordis.patch.yml`（运行时生效的是 profile 内那一份） |
| `openclaw-hooks.sample.json` | **OpenClaw 侧**：启用 `dsh-bridge` hook 的 `hooks.internal.entries` 片段 | 合并进 `openclaw.json` |
| `dsh-bridge-hook.sample.json` | **OpenClaw 侧**：hook 的旁挂配置文件（含共享密钥），`message:received` 事件下最可靠的配置来源 | 复制到仓库外，例如 `<stateDir>/dsh-bridge-hook.json`，并设置最小文件权限 |

> **机器相关值一律不进受版本控制的文件**：模板只留占位符；本机真实值放 `*.local.*`（已 gitignore）或环境变量。
> 按适用侧区分（别混用）：
>
> | 环境变量 | 适用侧 | 作用 |
> | --- | --- | --- |
> | `DSH_BRIDGE_SECRET_FILE` | **DSH 插件侧**（也可被 hook 侧脚本引用） | 覆盖 `secretFile` 指向的密钥文件路径（优先级最高） |
> | `DSH_BRIDGE_SECRET` | **DSH 插件侧**（`secretEnv` 的名字） | 密钥本体（不推荐，容易泄漏到进程环境） |
> | `DSH_BRIDGE_WORKSPACE` | **hook 侧** | 转发时附带的 `workspacePath`（须落在 DSH 的 `workspaceRoot` 内且已存在） |
> | `DSH_BRIDGE_*`（URL/SECRET/JUDGMENT/…） | **hook 侧** | 见 `plugins/openclaw-hook-dsh-bridge/HOOK.md` 的配置表 |
> | `DSH_BRIDGE_BASE_URL` | **联调脚本侧**（`scripts/test-bridge.ps1`） | 覆盖联调脚本请求的 `http://127.0.0.1:<port>` |
>
> 注意：**没有** `DSH_BRIDGE_WORKSPACE_ROOT` 这个 hook 侧变量——工作区围栏由 DSH 插件的 `workspaceRoot`
> 配置项负责（`cordis.patch.yml` / 本地覆盖文件）。

## 占位符约定

| 占位符 | 含义 |
| --- | --- |
| `<DSH_BRIDGE_SECRET>` | 两端的共享密钥（DSH 侧 `secretFile` 内容 / `secretEnv` 的值，OpenClaw 侧 `secret`） |
| `D:\path\to\workspace` | 你在 DSH 侧 `workspaceRoot` 内、且**已存在**的工作区目录 |
| `C:\path\to\dsh-bridge-secret.txt` | 仓库外的密钥文件路径（内容只有一行密钥） |
| `http://127.0.0.1:25567/openclaw-wechat` | DSH Web 入口 + 桥接路由。`25567` 只是本机 DSH Web GUI 的默认端口示例，请按你实际的 `dsh web` 端口修改 |
| `D:\\path\\to\\workspace`（JSON 里） | 同上，JSON 需要转义反斜杠 |

## 安全须知

1. **密钥不要进仓库**：`dsh-bridge-hook.json`、`bridge-secret.txt` 都放在仓库外；
   `.gitignore` 已排除常见密钥文件名。
2. **两端密钥必须一致**：DSH 侧从 `secretFile`（优先）或 `secretEnv` 读；OpenClaw 侧从
   `DSH_BRIDGE_SECRET` 或旁挂 JSON 的 `secret` 读。比较是恒定时间的，但一致才放行。
3. **工作区围栏**：请求里的 `workspacePath` 必须落在 DSH 侧 `workspaceRoot` 之内，且目录必须
   已存在（DSH 不会替你创建目录）；越界返回 403，不存在返回 404。
4. **白名单**：DSH 侧 `allowSenders` 一旦非空，hook 转发过来的 `sender` 必须精确匹配，
   否则 403。hook 侧转发的是 `event.context.from`（退化到 `metadata.senderId`）。
5. 只把 `DSH_BRIDGE_URL` 指向你信任的地址：hook 会把微信消息正文 POST 过去。
