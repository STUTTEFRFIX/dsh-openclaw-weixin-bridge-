# 交付说明 —— t9：repair round 3（t8 findings + captain 追加两条）

- 任务：`t9`（repair, round 3），attempt 1
- 范围：`repos/dsh-openclaw-weixin-bridge/`（**未**改动 `D:\DS` 根目录、`~\.openclaw`、`~\.dsh`、`~\.dsh-win`；
  未改 out-of-scope 的 `plugins/dsh-webhook-bridge/lib/index.js`）
- 输入：t8 findings（medium 1–2、low 3–7）+ captain 追加 8–9

## 1. 逐条处置

| # | Finding | 处置 | 落点 |
| --- | --- | --- | --- |
| 1 | `HOOK.md:62/63`、hook `README:66/67` 默认值失真（写 `wait=false`/`timeoutMs=15000`，实际 `true`/`130000`），且未提 default-skip / `message:sent` 标记环 / 合并窗口 / needs_input | 两处「它做什么 / 配置」段落整体重写并与 `handler.js` 对齐：显式写明 **默认 `wait=true`、`timeoutMs=130000`（须 > DSH 侧 `waitTimeoutMs`=120000）**、完整请求体字段（`text/title?/workspacePath?/sender?/conversationId?/fragments?/forwardRule?/wait`）与返回字段（`ok/status/state/kind/sessionId/fragments/forwardRule/replyText/optionCount`）、新增配置项全表；并在**显著位置**加警告「默认对闲聊/确认/追问类短消息不转发（default-skip），用 `#dsh ` 前缀或 `DSH_BRIDGE_DEFAULT_DECISION=forward` 解除」+ 链接 `docs/zh-CN/hook-judgment.md`；同时注明 `minIntervalMs`/`affinityWindowMs` 属 **DSH 侧** 配置 | `plugins/openclaw-hook-dsh-bridge/HOOK.md`、`plugins/openclaw-hook-dsh-bridge/README.md` |
| 2 | 根 `README.md` 数据流缺 `conversationId`/`fragments`/`forwardRule`；校验段缺 `test:hook-handler`/`npm test` | 数据流块重画（判断 → 合并 → POST 字段 → 桥接亲和 → 三态回执），结构表 hook 行补 `message:sent`/合并/三态；校验段列出 `check`/`check:hygiene`/`test:hook-handler`/`test:hook`/`test:fix`/`test:gate`/`npm test` | `README.md` |
| 3 | `test-handler.mjs:606` 恒真断言（104 条里 1 条凑数） | 换成**真实注入审计**：新增 `RUN_LOG_AUDIT`（每次 `run()` 记录行数与是否落到非占位路径）与 `ALL_SINK_LINES`，断言「每次调用至少写 1 行」+「所有 run 的写入都落在注入占位路径」——漏注入 `appendLog` 会立刻失败 | `plugins/openclaw-hook-dsh-bridge/test-handler.mjs` |
| 4 | `config/README.md:14` 的 `DSH_BRIDGE_WORKSPACE_ROOT` 全仓无实现 | 删除该声明，改为「按适用侧区分」的环境变量表（DSH 插件侧 `DSH_BRIDGE_SECRET_FILE`/`DSH_BRIDGE_SECRET`；hook 侧 `DSH_BRIDGE_WORKSPACE` 与 `DSH_BRIDGE_*`；联调脚本侧 `DSH_BRIDGE_BASE_URL`），并明确「工作区围栏由 DSH 插件的 `workspaceRoot` 负责，没有 hook 侧 WORKSPACE_ROOT 变量」 | `config/README.md` |
| 5 | `docs/zh-CN/hook-judgment.md:93`、`DELIVERY-t6:38/:65` 仍写 98；`DELIVERY-t7:17` 声称给 DELIVERY-t6 加了 104 注解但文件里没有 | 三处统一为「条数以脚本输出为准」+ 当前实际值 **109**；并更正 DELIVERY-t7 的不实描述（说明 t7 因 In-scope 校验约束**没有**改 DELIVERY-t6，t9 才改） | `docs/zh-CN/hook-judgment.md`、`DELIVERY-t6.md`、`DELIVERY-t7.md` |
| 6 | `judgment=off` 会跳过 marker/echo-ring；`DSH_BRIDGE_MIN_INTERVAL_MS` 解析但从不使用 | **改代码**：把「回复标记 + 出站标记环」两条移到 `judgment` 开关**之前**（文档「只剩自回环过滤」成立）；删除 hook 侧对 `DSH_BRIDGE_MIN_INTERVAL_MS` 的解析并在 README/HOOK.md 注明节流属 DSH 侧 `minIntervalMs`；新增 4 条断言（off 下 marker/echo 仍拦截、off 下闲聊仍按关闭语义转发、`DSH_BRIDGE_MIN_INTERVAL_MS` 不再落入配置） | `plugins/openclaw-hook-dsh-bridge/handler.js`、`test-handler.mjs`、两处文档 |
| 7 | `DELIVERY-t7` §4.5「仓库内没有 git」与 §3「17/17」过时 | §4.5 改为「t7 交付时确实没有 `.git`；随后 captain 初始化并重建为单提交 `c4878b5`，现在可用 bundled git 复验」；§3 的 17/17 标注为 t7 时值并指向 t9 复验结论 | `DELIVERY-t7.md` |
| 8 | （captain 追加）机器路径/账号标识门禁扩到仓库级 | 新增 `scripts/scan-repo-hygiene.mjs`：扫描「将要提交/发布」的文件（`git ls-files --cached --others --exclude-standard`，git 不可用时回退遍历）+ **把 `.git/objects` 全量解压后扫描**（含 reflog/index，pack 文件按原始字节 best-effort），并区分「真实」与「占位符」命中；`*.local.*` 豁免；接进 `npm run check` 与 `npm run check:hygiene` | `scripts/scan-repo-hygiene.mjs`（新）、`package.json`、`README.md` |
| 9 | （captain 追加）自查其它「必然为真」断言 | 逐条核对三个测试文件：除已修的那条外，其余 `=== true` / `, x)` 均是对具体字段的真实断言（见 §3 说明）；并把原先偏弱的「已定义 skip()」保留为真实检查（`typeof skip === "function"`） | `test-handler.mjs`、`test/self-test.mjs`（核对） |
| — | 验收①：发布前把含真实账号 id 的旧历史去掉并复验 | captain 已删除 `.git` 重建为单提交 `c4878b5`（工作树同步去敏感化：`scripts/captain-verify-judgment.mjs` 已移除、机器值移入 gitignored `config/*.local.*`）。t9 **独立复验**：`scan-repo-hygiene` 对 61 个 git 对象全量解压扫描 → 真实命中 **0**；`git log --all -p` 中 `f19bd…`=0、`Users\Administrator`=0；旧 blob（`36/7e7c…`、`5b/…`、`8c/…`）已不存在；无 pack、无旧 reflog 条目 | `.git`（captain 操作）、`scripts/scan-repo-hygiene.mjs` |

## 2. 改动文件清单与用途

| 文件 | 用途 |
| --- | --- |
| `scripts/scan-repo-hygiene.mjs`（新） | 仓库级敏感内容门禁 + 历史复验工具（工作树 + `.git` 对象；真实/占位符分级；`--json` 机读） |
| `package.json` | `check` 串联 hygiene 扫描；新增 `check:hygiene` |
| `README.md` | 数据流/结构表/校验段/已知问题四段与实现对齐（含判断代价与默认值、三态、合并、`npm test`） |
| `plugins/openclaw-hook-dsh-bridge/HOOK.md` | 「它做什么 / 配置」重写 + 默认 skip 显著警告 + 新配置项表 + DSH 侧配置说明 |
| `plugins/openclaw-hook-dsh-bridge/README.md` | 同上 + 包结构含 `test-handler.mjs` |
| `plugins/openclaw-hook-dsh-bridge/handler.js` | 自回环过滤前移（不受 `judgment` 影响）；删除 hook 侧 `DSH_BRIDGE_MIN_INTERVAL_MS` 解析 |
| `plugins/openclaw-hook-dsh-bridge/test-handler.mjs` | 恒真断言 → 真实注入审计；+4 条 off/节流语义断言；条数 104 → **109** |
| `config/dsh-bridge-hook.sample.json` | 补齐 t6 新增 hook 侧开关（judgment/defaultDecision/前缀/标记/botIds/loopWindow/coalesce/wait=true/timeoutMs=130000/forwardLog），并在 `$comment` 注明判断默认开启 |
| `config/README.md` | 删除不存在的 `DSH_BRIDGE_WORKSPACE_ROOT`，改为按适用侧列环境变量 |
| `docs/zh-CN/hook-judgment.md` | 条数口径改为「以脚本输出为准（当前 109）」 |
| `DELIVERY-t1.md` | §4 新增第 8 条（`.git` 历史：已由 captain 重写 + t9 复验）；计数口径与条数变化更新 |
| `DELIVERY-t6.md` | 98 → 「t6 时值，t9 统一为 109」 |
| `DELIVERY-t7.md` | §4.5 git 表述更新 + 新增 §4.6（`.git` 历史登记）；更正 f4 行关于 DELIVERY-t6 的不实描述 |
| `DELIVERY-t9.md`（新） | 本文件 |

## 3. 实际执行过的校验命令与结论

| 命令 | 结果 |
| --- | --- |
| `npm run check` | exit 0：`check-syntax: 17/17 通过`；`check-config-samples: 通过`；`scan-repo-hygiene：真实敏感命中 0，占位符命中 31` |
| `node scripts/scan-repo-hygiene.mjs` | exit 0；扫描「受控文件 48 个（已跟踪 + 未跟踪未忽略）+ git 对象 61 个」；真实命中 0 |
| 负例（临时新建未跟踪文件写入真实账号 id） | `node scripts/scan-repo-hygiene.mjs` → **exit 1**，命中 `scripts/__t9_negtest.mjs: o9cq…@im.wechat`（**证明门禁能拦住"未跟踪新文件"这类此前的漏网路径**）；删除临时文件后 exit 0 |
| 负例（临时改 `config/dsh-bridge-hook.sample.json` 写入真实用户路径） | `check-config-samples` → exit 1（`样例里出现机器专属路径`）；恢复后 exit 0 |
| `git log --all -p`（GitHub Desktop bundled git 2.53.0） | `f19bd` 0 命中；`Users\Administrator` 0 命中；`@im.wechat` 8 命中（经扫描器判定**全部为占位符**：`user-placeholder@…` / `bot-placeholder@…`） |
| `git ls-files` / `git status --porcelain` | 已跟踪 47 个文件；工作树在本轮修改后为**未提交状态**（见 §4） |
| `node plugins/openclaw-hook-dsh-bridge/test-handler.mjs` | exit 0，`109 passed, 0 failed` |
| `node plugins/openclaw-hook-dsh-bridge/test/self-test.mjs` | exit 0，`38 passed, 0 failed, 0 skipped`；空宿主（USERPROFILE/DSH_WIN_HOME/APPDATA/OPENCLAW_STATE_DIR→空目录）`30 passed, 0 failed, 1 skipped`，exit 0 |
| `node packages/openclaw-weixin-runtime-fix/test/verify-clone-fix.mjs`（auto / `--no-real` / `--real`） | 56/0 exit 0；52/0 + SKIP exit 0；`--real` 且显式路径不存在 → 1 failed exit 1 |
| `pwsh -NoProfile -File …/test/apply-gate-test.ps1` | exit 0，`27 passed, 0 failed` |
| 契约三条命令 | 两条 `node --input-type=module --check < 文件`（`cmd /c` 复现）exit 0；4 个 `package.json` 全部 `ConvertFrom-Json` OK |

**关于「必然为真」断言的自查（第 9 条）**：三个测试文件中，剩余的 `… === true` 形式均为对具体字段的断言
（如 `body.wait === true`、`metadata.openclaw.events.includes("message:sent") === true`），不是常量 `true`；
唯一一条 `check("…", true)` 已按第 3 条替换为真实注入审计。
另：`test-handler.mjs` §7 的两条新断言都是可失败的——若某次调用漏注入 `appendLog`，它会落到真实
`<stateDir>/logs/bridge-forward.log`，从而同时触发「zeroWriteRuns / offPlaceholderPaths」与「真实日志路径
mtime 变化」两条守卫。

## 4. 未验证项 / 待办

1. **本轮改动未提交**：`.git` 目前只有 captain 的单提交 `c4878b5`，t9 的 **14 个改动**
   （`git status --porcelain`：12 个 `M` + 2 个 `??`，即 `scripts/scan-repo-hygiene.mjs` 与 `DELIVERY-t9.md`）
   处于未提交状态——**需要 captain 提交**才能真正进入可发布历史。
   提交前建议先跑 `npm run check`（含 hygiene 门禁）确认门禁通过。
2. **历史复验用的是 GitHub Desktop 自带 git**（`…\GitHubDesktop\app-3.6.6\resources\app\git\cmd\git.exe`，
   git 2.53.0）：本机 PATH 里没有 git，所以**未验证**在标准 git 环境下的同样结论（结论来自对象级扫描，与 git 版本无关）。
3. **packed 对象只做 best-effort**：当前仓库无 pack 文件（61 个均为 loose object），若将来出现 pack，
   `scan-repo-hygiene` 只按原始字节扫描、不解析 pack 索引（脚本会在输出里注明）。
4. **`docs/en/` 仍为空**（归 t3）；根 README 的英文承诺已如实标注。
5. **未做带签名的发布/归档校验**（`git archive` + 校验和、或 commit 签名）。
6. **未在真实 DSH 进程里加载改造后的桥接插件**（与 t6/t7 相同）；`handler.js` 的行为改动仍只有离线断言覆盖。
