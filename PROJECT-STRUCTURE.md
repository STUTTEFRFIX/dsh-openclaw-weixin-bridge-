# 项目结构 · Project Structure

> 面向**接手者**：每个目录/文件的角色、状态、以及改哪里。英文版见
> [`docs/en/project-structure.md`](docs/en/project-structure.md)。

## 一句话架构

```text
微信 App ⇄ OpenClaw Gateway（openclaw-weixin 通道）
             │ message:received
             ▼
      plugins/openclaw-hook-dsh-bridge/     ← OpenClaw 侧：判断 + 合并 + 转发
             │ POST /openclaw-wechat（共享密钥）
             ▼
      plugins/dsh-webhook-bridge/           ← DSH 侧：校验 + 建会话 + 投递 prompt
             │
             ▼
      DSH 新建 Workspace 会话（cwd = 配置的工作区）
```

## 顶层文件

| 路径 | 作用 | 状态 |
| --- | --- | --- |
| `README.md` | 中文总览（定位、能力/非能力、快速开始、状态、许可） | 已交付 |
| `README.en.md` | 英文总览（与中文一一对应） | 已交付 |
| `STATUS.md` | 维护者视角：状态、发布方式（**必须 `git archive`**）、门禁口径 | 已交付 |
| `PROJECT-STRUCTURE.md` | 本文件：结构导航 | 已交付 |
| `LICENSE` | MIT | 已交付 |
| `NOTICE` | 版权归属 + 「改了要标注」的项目约定（注明非 MIT 条款）+ 第三方组件 + 免责声明 | 已交付 |
| `deploy.ps1` / `deploy.sh` | 一键部署脚本（幂等，支持 `-DryRun`/`--dry-run`、`-Uninstall`/`--uninstall`） | 已交付 |
| `package.json` | npm 脚本入口（`npm test`、`npm run check` 等） | 已交付 |
| `.gitignore` | 排除密钥、`*.local.*`、内部过程单 | 已交付 |

## 目录

### `plugins/` — 两个宿主各自的插件

| 路径 | 作用 | 状态 |
| --- | --- | --- |
| `plugins/dsh-webhook-bridge/` | **DSH 侧 Cordis 插件**。`lib/index.js` 注册受共享密钥保护的精确 POST 路由；`lib/affinity.mjs` 会话亲和（窗口内合并、`needs_input` 立即返回）；`cordis.patch.yml` 是 bundle 层声明 | 已实现 |
| `plugins/openclaw-hook-dsh-bridge/` | **OpenClaw 侧 hook pack**。`handler.js` 订阅 `message:received`/`message:sent`；`HOOK.md` 是宿主读取的声明（含配置表）；`test-handler.mjs` 断言 | 已实现 |

### `packages/` — 运行时修复（可独立使用）

| 路径 | 作用 | 状态 |
| --- | --- | --- |
| `packages/openclaw-weixin-runtime-fix/` | 修补 OpenClaw `worker-task-pool` 的结构化克隆失败（`DataCloneError`）导致的「消息可收不可回」。含补丁生成器、`apply`/`revert` 脚本、门禁测试与夹具 | 已实现（**非受支持改法，升级后丢失**） |

### `config/` — 配置样例（全占位符）

| 路径 | 作用 |
| --- | --- |
| `config/dsh-webhook-bridge.patch.sample.yml` | DSH 侧 Cordis 片段样例 |
| `config/openclaw-hooks.sample.json` | OpenClaw 的 `hooks.internal` 片段样例 |
| `config/dsh-bridge-hook.sample.json` | hook 旁挂配置样例（URL/密钥来源） |
| `config/deploy-extraDirs.patch.json5` | `deploy.*` 使用的 extraDirs 片段 |
| `config/stopgap-disable-hook.patch.json5` | 止血片段：显式关闭 hook |
| `config/*.local.*` | **本机真实值，被 .gitignore 排除，绝不提交** |

### `scripts/` — 门禁与联调脚本

| 路径 | 作用 |
| --- | --- |
| `scripts/check-syntax.mjs` | 全仓 JS 语法门禁（`node --check`） |
| `scripts/check-config-samples.mjs` | 配置样例解析 + 机器路径门禁 |
| `scripts/scan-repo-hygiene.mjs` | **仓库级敏感内容门禁**：受控文件 + `.git` 历史对象逐对象扫描（git 不可用且有 pack → 判失败，不假报干净） |
| `scripts/test-scan-repo-hygiene.mjs` | 上述门禁的负例自测（`npm run test:hygiene`） |
| `scripts/check-docs.mjs` | 文档门禁：相对链接、代码块语言、标题层级、表格列数、双语对应、敏感标识 |
| `scripts/inspect-session.mjs` / `list-sessions.mjs` / `read-reply.mjs` | DSH 会话日志联调（逐帧解压、列出、读取回复） |
| `scripts/test-bridge.ps1` / `verify-fence.mjs` | 桥接连调与工作区围栏自检 |

### `docs/` — 使用者文档（中英逐页对应）

| 页 | 内容 |
| --- | --- |
| `README.md` | 文档索引（含页面对照表） |
| `architecture.md` | 架构与数据流 |
| `installation.md` | 安装与配置步骤 |
| `known-issues.md` | **已知问题与警告（KI-1…KI-20）** |
| `hook-judgment.md` | 转发判断规则（默认 `skip` 及其解除方式） |
| `session-reuse-and-input.md` | 会话亲和与 `needs_input` 回传 |

## 改名 / 迁移注意

- 文件后缀遵循标准：源码 `.mjs`/`.js`、配置 `.json`/`.json5`/`.yml`、
  脚本 `.ps1`/`.sh`、文档 `.md`。新增文件请沿用。
- 任何**本机专属值**（用户名、绝对路径、密钥）一律进 `config/*.local.*`
  （已忽略）；受控文件里只允许占位符——`npm run check:hygiene` 会拦。
