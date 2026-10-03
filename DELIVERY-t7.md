# 交付说明 —— t7：repair round 2（f1–f6 复核修复）

- 任务：`t7`（repair, round 2），attempt 1
- 范围：`repos/dsh-openclaw-weixin-bridge/`（**未**改动 `D:\DS` 根目录、`~\.openclaw`、`~\.dsh` 下任何已部署文件；
  `plugins/dsh-webhook-bridge/lib/index.js` 本轮**未改**，符合 Out of scope）
- 来源：t2 复核的 6 条 findings（f1 缺 `skip()`、f2 README 指向空 docs/、f3 机器相关默认值、
  f4 断言条数不一致、f5 未实现的 `[--real]` 注释、f6 DELIVERY 条目数不一致），
  以及 captain 对 f2/f3 的两次裁决

## 1. 逐条处置

| Finding | 处置 | 落点 |
| --- | --- | --- |
| **f1** self-test 调用未定义的 `skip()`（空宿主必崩） | **t6 已修**（`skip()` 已定义、SKIP 单独计数不影响退出码、文件内不再调用任何未定义标识符）；t7 复验空宿主跑法 → `30 passed, 0 failed, 1 skipped`，**exit 0** 且打印汇总；并把空宿主复验命令写进 hook README | `plugins/openclaw-hook-dsh-bridge/test/self-test.mjs`（第 57 行 `function skip(name, why)`）、`plugins/openclaw-hook-dsh-bridge/README.md` |
| **f2** 根 README 承诺「中英双语文档见 docs/」，但 `docs/en/` 为空 | 取 captain 授权的 **A 分支（严格限缩）**：只改根 README 中那**一处**双语承诺，如实表述「`docs/zh-CN/` 已交付 2 页；`docs/en/` 规划中、尚未交付，t3 负责」；**未**新建/修改 `docs/en/**`；同时在 DELIVERY-t1 §4 新增第 7 条**显式登记**「英文文档仍未交付」 | `README.md`（第 6 行与结构表 docs 行）、`DELIVERY-t1.md` §4.7 |
| **f3** 三个文件含机器相关默认值 | `cordis.patch.yml` → `secretFile: ''` + `workspaceRoot: '<workspace-root>'`（注释写明 `$env:DSH_BRIDGE_SECRET_FILE` 优先、`<stateDir>/bridge-secret.txt` 兜底）；`scripts/test-bridge.ps1` → 默认值改为环境变量优先 + `<stateDir>` 兜底（`$env:DSH_HOME` → `$env:USERPROFILE\.dsh`），`BaseUrl` 亦可由 `$env:DSH_BRIDGE_BASE_URL` 覆盖；`DELIVERY-t1.md:137` → 改为 `C:\Users\<用户名>\…\bridge-secret.txt` 的占位符表述。**本机真实值**移入 gitignored 的 `config/dsh-webhook-bridge.patch.local.yml`（`.gitignore` 第 9 行 `config/*.local.*`） | `plugins/dsh-webhook-bridge/cordis.patch.yml`、`scripts/test-bridge.ps1`、`DELIVERY-t1.md`、`config/dsh-webhook-bridge.patch.local.yml`（新）、`config/README.md` |
| **f4** 条数表述不一致（hook README「72」等） | hook README 的验证段改为**不写死条数**（并补上 `test-handler.mjs` + 空宿主复验命令）；DELIVERY-t1 的两处 79 标注为「t1 时 79，t6 重写后 38」；DELIVERY-t6 的 98 更正为 101（并注明 t7 增补后为 104） | `plugins/openclaw-hook-dsh-bridge/README.md`、`DELIVERY-t1.md` §1/§2、`DELIVERY-t6.md` §2/§3 |
| **f5** 注释声称 `[--real]` 但未实现 | **真正实现**三种语义：默认 `auto`（自动发现，找不到打印 SKIP）／`--real`（必须有副本，找不到即失败 exit 1）／`--no-real`（显式跳过该节）；`--real --no-real` 同时给出时 `--no-real` 优先；`OPENCLAW_WORKER_TASK_POOL` 指定的文件不存在时：`--real` 判失败、`auto` 只告警；注释与实现一致 | `packages/openclaw-weixin-runtime-fix/test/verify-clone-fix.mjs` |
| **f6** DELIVERY 声明「8 项」与实际不符 | DELIVERY-t1 §4 现有 **7** 条（原 6 条 + t7 新增的 docs/en 登记），文件内加了「计数口径」说明：t1 汇报文本曾写 8 项、实际当时为 6 条，现已按实际统一 | `DELIVERY-t1.md` §4 末尾 |
| **附带加固**（t7 复核时发现，属于 f3/I8 同族） | 防自回环的 sender 维度此前只看 `context.from`：真实通道里 bot 标识常出现在 `metadata.senderId`（captain 的验证脚本 case 8 就是这种形状），长技术回文会因此被当用户任务转发。现改为对**全部候选身份**（`from` / `metadata.senderId` / `senderUsername` / `senderE164` / `context.senderId`）逐一比对 botIds，并可与 `accountId` 比对判自身；新增 3 条回归断言 | `plugins/openclaw-hook-dsh-bridge/handler.js`、`plugins/openclaw-hook-dsh-bridge/test-handler.mjs` |

## 2. 改动文件清单与用途

| 文件 | 用途 |
| --- | --- |
| `README.md` | f2：双语承诺改为如实表述（zh-CN 已交付 2 页；docs/en 规划中、t3 负责） |
| `DELIVERY-t1.md` | f3（第 5 条改写为「t7 已修」+ 说明运行时生效的是 profile 内副本、非硬链接）、f4（79→38 标注）、f6（§4 计数口径与 7 条）、f2（新增第 7 条登记 docs/en 未交付） |
| `DELIVERY-t6.md` | f4：98→101、101→（t7 后）104 的标注 |
| `DELIVERY-t7.md` | 本文件 |
| `config/README.md` | f3：新增本地覆盖文件说明 + 机器相关值不进受控文件的约定 |
| `config/dsh-webhook-bridge.patch.local.yml`（新，gitignored） | f3：本机真实值（密钥文件绝对路径、本机工作区根） |
| `plugins/dsh-webhook-bridge/cordis.patch.yml` | f3：模板只留 `secretFile: ''` 与 `workspaceRoot: '<workspace-root>'` + env/`<stateDir>` 说明 |
| `plugins/openclaw-hook-dsh-bridge/README.md` | f4（不写死条数）+ f1（空宿主复验命令）+ 补 `test-handler.mjs` 命令 |
| `plugins/openclaw-hook-dsh-bridge/handler.js` | 附带加固：自回环 sender 维度覆盖全部候选身份 |
| `plugins/openclaw-hook-dsh-bridge/test-handler.mjs` | 3 条新断言（metadata-only bot 身份、该回文若只看内容本会转发、sender==accountId） |
| `packages/openclaw-weixin-runtime-fix/test/verify-clone-fix.mjs` | f5：`--real` / `--no-real` 的真实语义 + 注释同步 |
| `scripts/test-bridge.ps1` | f3：`SecretFile` / `BaseUrl` 默认值改为环境变量优先 + `<stateDir>` 兜底 |
| `scripts/check-config-samples.mjs` | f3 **落地为门禁**：新增「机器专属路径（用户名目录）」检查——受控样例出现 `C:\Users\<真实用户名>\…` 即失败，`*.local.*` 本地覆盖文件豁免；同时修正长路径被「32+ 位 token」启发式误报的问题 |
| `config/deploy-extraDirs.patch.json5` | f3（同族）：captain 新增的部署样例里含本机绝对路径，改为 `<repo>/plugins/openclaw-hook-dsh-bridge` 占位符 + 说明 |
| `config/deploy-extraDirs.patch.local.json5`（新，gitignored） | f3：上一处样例对应的本机真实路径 |
| `plugins/openclaw-hook-dsh-bridge/HOOK.md` | 隐私边界：审计日志含发送者标识/会话键（不含正文），限制权限、勿提交 |

## 3. 实际执行过的校验命令与结论

| 命令 | 结果 |
| --- | --- |
| `npm run check` | exit 0：`check-syntax: 17/17 通过`（含 captain 新增的 `scripts/captain-verify-judgment.mjs`）；`check-config-samples: 通过`（3 个 JSON 可解析、YAML 键骨架 23 键一致、含新增 `*.local.yml` 在内未命中真实密钥/账号 id） |
| `node plugins/openclaw-hook-dsh-bridge/test-handler.mjs` | exit 0，`104 passed, 0 failed`（t6 时的 101 + 本轮 3 条） |
| `node plugins/openclaw-hook-dsh-bridge/test/self-test.mjs` | exit 0，`38 passed, 0 failed, 0 skipped` |
| **空宿主**（`USERPROFILE`/`DSH_WIN_HOME`/`APPDATA`/`OPENCLAW_STATE_DIR` → 空目录）跑 self-test | exit 0，`30 passed, 0 failed, 1 skipped`，打印汇总 —— **f1 复验通过** |
| 空宿主跑 `test-handler.mjs` | exit 0，`104 passed, 0 failed` |
| `node packages/openclaw-weixin-runtime-fix/test/verify-clone-fix.mjs` | exit 0，`56 passed, 0 failed`（`--real`/`--no-real` 开关见下） |
| `… verify-clone-fix.mjs --no-real` | exit 0，`52 passed, 0 failed` + `SKIP 真实文件生成 + 语法门禁 — 已用 --no-real 显式跳过该节` |
| `… verify-clone-fix.mjs --real`（`OPENCLAW_WORKER_TASK_POOL` 指向不存在文件） | **exit 1**，`56 passed, 1 failed` → `FAIL --real 时 OPENCLAW_WORKER_TASK_POOL 指定的文件存在`（证明 `--real` 的强制语义真的生效） |
| `… verify-clone-fix.mjs`（同一环境下默认 auto） | exit 0，`56 passed, 0 failed` + `INFO OPENCLAW_WORKER_TASK_POOL 指定的文件不存在（已忽略）` |
| `pwsh -NoProfile -File packages/openclaw-weixin-runtime-fix/test/apply-gate-test.ps1` | exit 0，`27 passed, 0 failed` |
| `node scripts/captain-verify-judgment.mjs`（captain 的独立验证） | exit 0，`---- captain 功能验证 v2：9/9 ----`（本轮加固后 case 8「bot 复述」在配置了 `DSH_BRIDGE_BOT_IDS` 时走 `self-loop-sender`，见 §1 附带加固） |
| `cmd /c "node --input-type=module --check < …\plugins\dsh-webhook-bridge\lib\index.js"` | exit 0 |
| `cmd /c "node --input-type=module --check < …\plugins\openclaw-hook-dsh-bridge\handler.js"` | exit 0 |
| `Get-ChildItem -Recurse -Filter package.json … \| ConvertFrom-Json` | exit 0，4 个 `package.json` 全部 OK |
| f3 复验：`Select-String -Path scripts/test-bridge.ps1,plugins/dsh-webhook-bridge/cordis.patch.yml,DELIVERY-t1.md -Pattern 'Administrator'` | 无命中（三个目标文件已无用户名硬编码） |
| f3 复验：`scripts/test-bridge.ps1` 默认值表达式逻辑（无 env / 有 `DSH_HOME` / 有 `DSH_BRIDGE_SECRET_FILE`） | 分别解析为 `<USERPROFILE>\.dsh\bridge-secret.txt`、`<DSH_HOME>\bridge-secret.txt`、`<env 指定值>`；脚本自身 `Parser::ParseFile` 报 0 个语法错误 |
| 磁盘卫生：`Test-Path "$env:USERPROFILE\.openclaw\logs\bridge-forward.log"` | **存在，且它现在是「线上审计日志」**：captain 已把 `hooks.internal.load.extraDirs` 指向本仓库 hook pack（见 §5 第 3 条），所以运行的就是本仓库的 `handler.js`，它按设计把判断写进该路径。`test-handler.mjs` §7 的「测试前后比对默认日志路径存在性/大小/mtime」守卫在每次运行中**通过**（测试本身不写该路径） |

关键事实（t7 新查证）：**运行时生效的桥接配置不是仓库文件**。
`<profile>/node_modules/dsh-webhook-bridge/` 是一份**独立副本**（`Get-Item` 的 `LinkType` 为空 = 非符号链接/硬链接，
文件大小与哈希都与仓库不同；其 `lib/index.js` 仍是我 t1 的版本），
所以把仓库里的 `cordis.patch.yml` 改成占位符**不会**影响正在运行的桥接，
captain 先前「删掉会破坏本机可用行为」的担心对仓库模板不成立（对 profile 内那份当然仍然成立，本轮未动它）。

## 4. 未验证项

1. **未在真实 DSH 进程里加载改造后的桥接插件**：`lib/index.js` 仍只有语法门禁 + 纯逻辑单测；
   t6 的亲和/三态接线与 t7 的模板改写都未在运行中的 profile 上验证（profile 内是旧副本）。
2. **`docs/en/` 仍为空**：按 captain 硬约束归 t3；本轮只做了 README 如实表述 + DELIVERY 登记。
3. **`scripts/test-bridge.ps1` 未对真实桥接执行**（只做了语法解析与默认值逻辑验证）：
   跑它会对 `http://127.0.0.1:25567` 发一次请求，本轮未执行以免干扰线上服务。
4. **`config/dsh-webhook-bridge.patch.local.yml` 的“本地覆盖”是约定而非自动机制**：
   DSH 的 profile 加载器是否支持 `$include`/覆盖文件未查证，因此文档里写明「部署时把值合并进
   profile 内那份 cordis.patch.yml」——这是人工步骤，未自动化。
5. **仓库内没有 git**：`.gitignore` 的排除是按文本规则核对（`config/*.local.*` 与
   `dsh-webhook-bridge.patch.local.yml` 匹配），未用 `git check-ignore` 实测（环境无 git）。
6. `--real` 的“找不到副本即失败”分支是通过「显式指定不存在的路径」验证的；
   “自动发现完全无候选”这一分支在本机无法构造（PATH 里就含 DSH 自带的 openclaw 目录）。

## 5. 给 captain / t3 / t8 的三点同步

1. **t3 素材（f2 收尾）**：根 README 已按你的 A 分支改好，t3 只需**新增/充实** `docs/en/**`
   并在完成后把 README 里那句「`docs/en/` 为规划中、尚未交付」改成「英文文档见 `docs/en/`」；
   同时可从 `DELIVERY-t1.md` §4.7 移除该条登记。
3. **线上已经在跑本仓库的 hook（重要，已核实）**：`~/.openclaw/openclaw.json`（mtime 13:10:45）里
   `hooks.internal.load.extraDirs = ["D:\DS\repos\dsh-openclaw-weixin-bridge\plugins\openclaw-hook-dsh-bridge"]`，
   而 `~/.openclaw/logs/bridge-forward.log` 里 27 行 `enter … decision=skip rule=…` 正是**本仓库 handler 的格式**
   （旧的工作区 hook 格式是 `enter type=message action=received channel=… metaKeys=… ctxKeys=…`）。由此有两条操作性结论：
   - **本仓库 `handler.js` 即是线上代码**：改它会影响线上行为（需要重启 Gateway 才热加载；配置文件改动按 hybrid 会立即生效），
     本轮我对 `handler.js` 的 sender-identity 加固因此也会在重启后进入线上，请知悉。
   - **线上还没配 URL/密钥**：日志里出现 `result=unconfigured missing=DSH_BRIDGE_URL`，
     说明 Gateway 进程环境里没有 `DSH_BRIDGE_URL`/`DSH_BRIDGE_SECRET`，而 `message:received` 又不带 `cfg`
     （真实日志的 `ctxKeys` 里没有 `cfg`）→ 必须在 **Gateway 进程环境变量** 或 **旁挂 JSON**
     （`<OPENCLAW_STATE_DIR>/dsh-bridge-hook.json`，见 `config/dsh-bridge-hook.sample.json`）里配置，否则热转发的消息只会被记成 unconfigured。
     另外 `hooks.internal.entries` 目前只有 `bootstrap-extra-files` 与 `dsh-bridge-forward`（旧 hookKey），
     没有 `dsh-bridge`；实测本 hook 仍被加载（extraDirs 存在时按文档是开放式发现），如需显式开关请加
     `entries["dsh-bridge"].enabled = true`。
4. **仓库卫生（已由 captain 处置，记录在此）**：captain 的本地验证脚本曾位于本仓库
   `scripts/` 下，且内含机器专属路径与真实账号标识。该脚本**已移出仓库**（现存放于
   工作区 `tools/` 下的本地工具目录），仓库内仅保留使用占位符的等价复现方式；
   如需在本机复跑，请通过环境变量注入账号标识，不要在源码中写死。
