# 交付说明 —— t1：打包并实现 dsh-openclaw-weixin-bridge 插件仓库

- 任务：`t1`（implementation），attempt 1
- 范围：`repos/dsh-openclaw-weixin-bridge/**`（未改动 `.dsh/`、`.openclaw/`、`D:\DS` 根目录下任何已部署文件）
- 明确未改动：`plugins/dsh-webhook-bridge/lib/index.js`（任务标注为 out of scope，仅新增同目录 `README.md` / `LICENSE`）

## 1. 改动文件清单与逐文件用途

### 新增（根级）

| 文件 | 用途 |
| --- | --- |
| `README.md` | 仓库骨架说明：定位、结构与数据流、快速开始、校验命令、安全边界、已知问题 |
| `LICENSE` | MIT 文本（各子包各复制一份，满足各自 `files` 声明） |
| `package.json` | 仓库级 npm 脚本（`check` / `test:hook` / `test:fix` / `test:gate` / `targets`），`private: true`，无依赖 |
| `.gitignore` | 排除密钥（`dsh-bridge-hook.json`、`bridge-secret.txt`、`*.orig-bak` 等）与构建产物 |

### 新增（OpenClaw hook pack：`plugins/openclaw-hook-dsh-bridge/`）

| 文件 | 用途 |
| --- | --- |
| `package.json` | hook pack 清单：`openclaw.hooks: ["."]`、`type: module`；不含 `openclaw.extensions`（保持 hook-only 包类型） |
| `HOOK.md` | hook 元数据（`name: dsh-bridge`、`metadata.openclaw.events: ["message:received"]`）+ 行为、配置、安装、验证、边界说明 |
| `handler.js` | 处理器：订阅 `message:received` → 读取正文/发送者 → `POST DSH_BRIDGE_URL`（`Authorization: Bearer`）→ 日志与返回值。含配置来源优先级、脱敏、跳过与失败路径 |
| `test/self-test.mjs` | 仓库内自测（t1 交付时为 79 条断言；t6 重写后为 **38 条**并改用「不写死条数」的口径，见 `DELIVERY-t6.md`）：清单/目录约定、HOOK.md frontmatter、handler 行为冒烟、宿主 discovery 实测、空宿主安全 |
| `README.md` | 包的安装/配置/验证说明 + 逐条列出「为什么这样声明」的磁盘依据 |
| `LICENSE` | MIT |

### 新增（运行时修复包：`packages/openclaw-weixin-runtime-fix/`）

| 文件 | 用途 |
| --- | --- |
| `package.json` | 包清单与脚本（`test` / `test:gate` / `targets` / `gen`） |
| `lib/clone-sanitize.mjs` | 注入源码本体（`analyzeCloneRejection` / `describeCloneShape` / `sanitizeForClone` / `cloneRetrySanitized` / `readCtorName` / `CLONE_PRESERVE_CTOR_NAMES`），同时可被自测 import |
| `lib/gen-patch.mjs` | 补丁生成器：单指纹识别（找不到/多于一处/已打补丁 → 拒绝生成），生成后结构自检，输出 LF/无 BOM |
| `lib/targets.mjs` | 只读发现本机所有 `worker-task-pool-*.mjs` 副本及其补丁/备份状态 |
| `scripts/patch-worker-pool.ps1` | `apply` / `revert` / `status`：apply 走「生成 → 语法门禁 → 结构门禁 → （缺失才创建）备份 → 落盘」；revert 校验备份未被污染 + 语法门禁后还原；默认不重启 Gateway（`-RestartGateway` 才重启），支持 `-DryRun` |
| `scripts/apply.ps1` | `-Action apply` 的薄包装（-DistPath / -DryRun / -RestartGateway） |
| `scripts/revert.ps1` | `-Action revert` 的薄包装 |
| `test/verify-clone-fix.mjs` | 56 条断言：净化语义、生成器纯函数行为、CLI 退出码与语法门禁、目标发现、可选的真实原文件生成 |
| `test/apply-gate-test.ps1` | 27 条断言的 apply/revert 门禁自测（全程在 `%TEMP%` 的合成夹具副本上） |
| `test/fixtures/worker-task-pool-pristine.fixture.mjs` | 合成夹具：复刻派发点结构指纹（不是任何真实发行包文件） |
| `README.md` | 问题、磁盘依据、包结构、用法、**回滚说明**、自测、已知限制与未验证项 |
| `LICENSE` | MIT |

### 新增（配置样例：`config/`）

| 文件 | 用途 |
| --- | --- |
| `dsh-webhook-bridge.patch.sample.yml` | DSH 侧 Cordis 组合片段样例；键名/顺序与 `plugins/dsh-webhook-bridge/cordis.patch.yml` 完全一致，值全部占位符 |
| `openclaw-hooks.sample.json` | OpenClaw `hooks.internal.entries.dsh-bridge` 片段样例（per-hook `env`） |
| `dsh-bridge-hook.sample.json` | hook 旁挂 JSON 样例（含 `secret` 占位符；`message:received` 下最可靠的配置来源） |
| `README.md` | 占位符约定、复制位置、安全须知（两端密钥一致、工作区围栏、白名单） |

### 新增（仓库级校验脚本：`scripts/`）

| 文件 | 用途 |
| --- | --- |
| `check-syntax.mjs` | 遍历仓库内所有 `.js/.mjs/.cjs`，用 `node --input-type=module --check`（stdin）做语法门禁 |
| `check-config-samples.mjs` | `config/` 门禁：JSON 可解析、YAML 键骨架与参考样例一致、且只含占位符（无真实密钥/token/账号 id） |

### 新增（既有 DSH 插件目录的补全）

| 文件 | 用途 |
| --- | --- |
| `plugins/dsh-webhook-bridge/README.md` | 该插件的 HTTP 契约、配置项、安全边界、验证命令（原 `package.json` 的 `files` 声明了 README/LICENSE 但文件缺失） |
| `plugins/dsh-webhook-bridge/LICENSE` | MIT，满足其 `files` 声明 |

### 未改动

`plugins/dsh-webhook-bridge/lib/index.js`、`plugins/dsh-webhook-bridge/cordis.patch.yml`、
`scripts/` 下原有 5 个脚本（`inspect-session.mjs`、`list-sessions.mjs`、`read-reply.mjs`、
`test-bridge.ps1`、`verify-fence.mjs`）按「已完成部分需保留」原样保留。

## 2. 实际执行过的校验命令与结论

| 命令 | 结果 |
| --- | --- |
| `npm run check` | exit 0。`check-syntax: 14/14 通过`；`check-config-samples: 通过`（2 个 JSON 可解析、YAML 键骨架 18 键一致、无真实密钥命中） |
| `node plugins/openclaw-hook-dsh-bridge/test/self-test.mjs` | t1 时 exit 0，`79 passed, 0 failed`（含宿主 discovery 实测 7 条）；**t6 重写后为 `38 passed, 0 failed`（+ 空宿主 `30/0/1skip`）**，见 `DELIVERY-t6.md` |
| `node packages/openclaw-weixin-runtime-fix/test/verify-clone-fix.mjs` | exit 0，`56 passed, 0 failed`（含真实 `worker-task-pool-*.mjs.orig-bak` 上的生成 + 语法门禁 4 条） |
| `pwsh -NoProfile -File packages/openclaw-weixin-runtime-fix/test/apply-gate-test.ps1` | exit 0，`27 passed, 0 failed` |
| `pwsh -NoProfile -File .../scripts/patch-worker-pool.ps1 -Action status` | exit 0，只读列出本机 2 份副本（均「已打补丁」，各有 `.orig-bak`） |
| `cmd /c "node --input-type=module --check < repos\dsh-openclaw-weixin-bridge\plugins\dsh-webhook-bridge\lib\index.js"` | exit 0 |
| `cmd /c "node --input-type=module --check < repos\dsh-openclaw-weixin-bridge\plugins\openclaw-hook-dsh-bridge\handler.js"` | exit 0 |
| `Get-ChildItem -Recurse -Filter package.json repos/dsh-openclaw-weixin-bridge \| ForEach-Object { Get-Content $_.FullName -Raw \| ConvertFrom-Json \| Out-Null; 'OK ' + $_.FullName }` | exit 0，4 个 `package.json` 全部 OK（根、`packages/openclaw-weixin-runtime-fix`、`plugins/dsh-webhook-bridge`、`plugins/openclaw-hook-dsh-bridge`） |
| 宿主 discovery 实测（`self-test.mjs` 内，用宿主自己的 `loadHookEntriesFromDir`） | 发现恰好 1 个 hook：`name=dsh-bridge`、`events=["message:received"]`、`handlerPath=<pack>/handler.js`、`baseDir=<pack>`、`invalidMetadata=false`、宿主零告警 |

> 说明：验收命令里的 `< 文件` 是 shell 重定向语法，PowerShell 不支持 `<`（会报
> “保留给将来使用”），因此上面用 `cmd /c` 逐字复现了该形式，另外也用
> `Get-Content … | node --input-type=module --check` 复现（两者都 exit 0）。

## 3. 关键设计决策与磁盘依据

1. **hook pack 清单形状**：`package.json` 里 `openclaw.hooks` 必须是非空字符串数组；元素解析为
   `<packageDir>/<entry>`、必须落在包内且**直接是**含 `HOOK.md` 的 hook 目录；handler 候选顺序
   `handler.ts → handler.js → index.ts → index.js`；`type: module` 是必需的（宿主用原生 `import()`
   加载 handler）。依据（openclaw 2026.9.7 磁盘代码/文档）：`dist/install-JC-hcU6X.mjs`
   （`resolveOpenClawHooks()`、`validateHookDir()`、`resolveHookPackageKind()`）、
   `dist/discovery-Cs-Nc8JK.mjs`（`loadHookEntriesFromDir()`）、`dist/loader-L4OIn4zB.mjs`
   （`await import(buildImportUrl(handlerPath, source))`）、`docs/automation/hooks/configuration.md`、
   `docs/automation/hooks/writing-hooks.md`、`docs/cli/hooks.md`。
2. **声明 `openclaw.hooks: ["."]`**：宿主包含判定「相等即在包内」（`isPathInside` 的
   `relative === ""` 分支，见 `dist/package-update-activation-recovery.mjs` 中
   `isPathInsideWithRealpath` 实现），所以包根自身可作为 hook 目录；本机用宿主 discovery 实测
   验证成功（见上表）。任务验收命令要求 `plugins/openclaw-hook-dsh-bridge/handler.js` 存在，
   因此 hook 文件放在包根而不是嵌套目录。
3. **hook 不做回复回传**：OpenClaw 文档 `docs/automation/hooks/writing-hooks.md` 的
   Reply delivery 表明确列出 message 事件的 `event.messages` 会被忽略，所以 handler 不写
   `event.messages`（避免"已回复微信"的假象），只记录并把回复作为返回值返回。
4. **补丁注入点指纹**：只认「`worker.postMessage({` + 下一行 `input,` + 四行固定属性 +
   `}, transferList);`」这一形状；同文件另外两处 `worker.postMessage`（资源回收、response 投递）
   形状不同，指纹天然排除。找不到/多于一处一律拒绝生成（退出码 2），不改坏文件。
5. **门禁优先**：`apply` 先备份？——不，**备份也排在门禁之后**：生成/语法/结构门禁全过才会创建
   `.orig-bak` 并覆盖目标；被拒绝的运行不在磁盘留下任何新文件（`apply-gate-test.ps1` 有对应断言）。
6. **净化算法修正**：原始临时脚本用 `?? "null-proto"` 判断构造器名，而
   `Object.getPrototypeOf(process.env).constructor.name` 在本机是**空字符串**，会被误判为
   「原生类型」而跳过重建。本包引入 `readCtorName()`（空串视为记录型）+ 原生类型白名单
   `CLONE_PRESERVE_CTOR_NAMES`，并用 WeakMap 缓存保留共享引用/环引用（原实现会把第二处引用丢掉）。

## 4. 未验证项（明确声明）

1. **没有对真实 openclaw 安装执行 apply/revert**：会改动已部署环境，超出本任务的改动权限。
   `apply`/`revert` 只在 `%TEMP%` 的合成夹具副本上端到端跑过（27 条断言全过）。
2. **没有做真实微信端到端验证**：需要真实微信账号与运行中的 Gateway；
   `scripts/test-bridge.ps1` 可做 DSH 侧联调，但没有在本轮执行。
3. **DataCloneError 现场条件未在本机复现**：Node v24.21.0 下
   `structuredClone(process.env)`（含 `--permission` 模式）**可克隆**，因此自测用等价合成对象
   （Proxy + 空白构造器名，复现宿主诊断 `$.request.env … container-all-children-cloneable`）
   覆盖语义。端到端效果（微信真的能收到回复）来自工作区报告
   `D:\DS\reports\openclaw-weixin-dataclone-issue.md` 的历史实测记录，本包未重新验证。
4. **hook 的真实加载与事件触发未验证**：只验证了宿主的 discovery 能发现本包并解析出
   `handler.js`；`openclaw plugins install`（会写 `~/.openclaw`）与真实 `message:received`
   触发未执行。建议由 captain 在受控环境用
   `openclaw plugins install <pack> --force` → `openclaw hooks info dsh-bridge` 复验。
5. **~~`plugins/dsh-webhook-bridge/cordis.patch.yml` 与 `scripts/test-bridge.ps1` 含机器相关绝对路径~~（t7 已修）**：
   这两处（以及本文件下方）当时含 `C:\Users\<用户名>\…\bridge-secret.txt` 这类**机器专属路径**。
   t7 已改为「环境变量优先 + `<stateDir>` 兜底」：`cordis.patch.yml` 只留 `secretFile: ''` 与
   `workspaceRoot: '<workspace-root>'` 占位符，脚本用 `$env:DSH_BRIDGE_SECRET_FILE` /
   `<stateDir>/bridge-secret.txt`；本机真实值移入 gitignored 的
   `config/dsh-webhook-bridge.patch.local.yml`。另确认：**运行时生效的是 profile 内那一份副本**
   （`<profile>/node_modules/dsh-webhook-bridge/cordis.patch.yml`，与仓库文件不是同一份、非硬链接），
   所以改仓库模板不会影响正在运行的桥接。
6. **YAML 只做了结构比对，没有用 YAML 解析器验证**：本机与仓库内都没有 `yaml`/`js-yaml` 依赖，
   因此 `check-config-samples.mjs` 比对的是「行序 + 缩进 + 列表标记 + 键名」骨架
   （与参考样例一致），而非「能否被 YAML 解析」。
7. **`docs/en/` 未交付（t7 登记；由 t3 落地）**：根 README 原先承诺「中英双语文档见 docs/」，
   但 `docs/en/` 当时为空。t7 已把根 README 的该处承诺改为如实表述
   （`docs/zh-CN/` 已交付 2 页；`docs/en/` 规划中、尚未交付，t3 负责）；
   **英文文档本身仍未交付**，登记在此，供 t3 关闭。
8. **`.git` 历史（t9 登记，已处理并复验）**：t1/t7 交付时仓库内**没有** `.git`，因此当时的「不泄漏」只覆盖
   工作树文本。随后 captain 初始化了 git，并发现旧历史里含**真实微信账号 id**
   （`scripts/captain-verify-judgment.mjs`）与若干机器路径；captain 已删除 `.git` 重建为单提交
   `c4878b5`（工作树本身也已去敏感化：该脚本已移除、机器值移入 gitignored `config/*.local.*`）。
   t9 用 `npm run check:hygiene`（`scripts/scan-repo-hygiene.mjs`，把 `.git/objects` 全量解压后扫描）
   复验：**真实账号 id / 机器用户路径 0 命中**（只剩 `user-placeholder@im.wechat` 这类占位符），
   `git log --all -p` 中 `f19bd…` 与 `C:\Users\<用户名>` 形式均 0 命中。
   仍未做：带签名的发布/归档校验（`git archive` + 校验和）不在本轮范围。

> 计数口径（t9 更新）：本文件 §4 现有 **8** 条（t1 时 6 条 → t7 增 1 → t9 增 1）。
> t1 汇报文本里曾写「8 项未验证/待决策」而当时文件只有 6 条，属表述不一致；现在文件确实为 8 条，
> 且本节说明了每一批的增补来源。
>
> **条数与 t7/t9 后续变化**：`test/self-test.mjs` 由 79 → **38**（t6 重写为包契约+discovery+空宿主安全）；
> `test-handler.mjs` 101（t6）→ 104（t7）→ **109**（t9：新增 judgment=off 下的自回环断言、
> hook 侧不再解析 `DSH_BRIDGE_MIN_INTERVAL_MS` 的断言，并把一条恒真断言换成真实注入检查）；
> `verify-clone-fix.mjs` 为 56（`--no-real` 时 52）；`apply-gate-test.ps1` 为 27；
> `check-syntax` 文件数 16（t6）→ 17（t7，含 captain 的验证脚本）→ **17**（t9：captain 的
> `scripts/captain-verify-judgment.mjs` 已随历史卫生移除 −1，新增 `scripts/scan-repo-hygiene.mjs` +1）。
> t7/t9 的完整修订记录见同目录 `DELIVERY-t7.md` / `DELIVERY-t9.md`
> （这两个文件不在本任务 In-scope 声明里，故未列入 changedPaths）。
