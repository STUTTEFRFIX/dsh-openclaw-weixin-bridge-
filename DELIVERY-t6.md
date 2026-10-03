# 交付说明 —— t6：通道 hook 转发判断与会话复用（修复「会话爆炸」与「选择项卡死」）

- 任务：`t6`（repair），attempt 1
- 范围：`repos/dsh-openclaw-weixin-bridge/`（**未**改动 `D:\DS` 根目录、`~\.openclaw`、`~\.dsh` 下任何已部署文件；
  `tools/` 未动）
- 用户反馈条目：I2（说别用仍被自动调用）、I3（每条消息建新会话/无判断机制）、I4（需要选择项时卡死）、
  I7（一句话被拆 3 段各建会话）、I8（自回环凭空产生会话，captain 裁决并入 t6-B）

## 1. 改动文件清单与逐文件用途

| 文件 | 用途 |
| --- | --- |
| `plugins/openclaw-hook-dsh-bridge/handler.js`（重写） | **A** 转发判断（可配置常量 + 顶部说明目的与代价）、显式前缀 `#dsh`、防自回环（`message:sent` 标记环 + 回复标记 + bot/自身账号 + fromMe）、判断审计日志 `bridge-forward.log`；**B** 同源多段合并（`FragmentCoalescer`，静默窗口 + 硬上限 + 在途保护）；**C** 桥接响应 → 三态映射 + needs_input 纯文本编号选项；保留原有配置优先级、脱敏、不写 `event.messages` 的边界 |
| `plugins/openclaw-hook-dsh-bridge/test-handler.mjs`（新增） | 契约指定的自测入口：闲聊跳过 / 前缀转发 / bot 自回环跳过 / 复用与合并窗口 / needs_input，共 **101 条断言**；全注入（fetch/env/readFile/appendLog/now/sleep/state），离线且空宿主可跑；末尾带**真实磁盘守卫**（若某次调用忘了注入日志写入器，会在此失败） |
| `plugins/openclaw-hook-dsh-bridge/test/self-test.mjs`（重写） | 收敛为「包契约 + HOOK.md + handler 导出 + 行为冒烟 + 宿主 discovery 实测 + 空宿主安全」，**补上缺失的 `skip()` 定义（t7/f1）**，行为细节交给 `test-handler.mjs` |
| `plugins/openclaw-hook-dsh-bridge/HOOK.md` | events 改为 `["message:received", "message:sent"]`（标记环所需），描述同步 |
| `plugins/openclaw-hook-dsh-bridge/package.json` | `scripts.test` 改为先跑 `test-handler.mjs` 再跑 `test/self-test.mjs` |
| `plugins/dsh-webhook-bridge/lib/affinity.mjs`（新增） | 纯逻辑：`SessionAffinity`（会话亲和槽/窗口/节流/合并/flush/关闭）、`FragmentCoalescer` 同源合并、`detectTurnState`（completed/needs_input/aborted/error/blocked/running）、`formatNumberedOptions`、选项解析、origin 键；不依赖 DSH/网络/文件系统 |
| `plugins/dsh-webhook-bridge/lib/index.js` | 接线：亲和槽 submit → dispatch/merge、`readSessionTurn`（事件流 → 回合快照）、`waitForSessionTurn`（needs_input 立即返回）、响应带三态/选项/`reused`/`fragments`；`readConfiguredSecret` 改为 **`DSH_BRIDGE_SECRET_FILE` 环境变量优先、配置里的本机路径兜底**（t7/f3 的 cordis+index 部分）；新增 5 个配置项 |
| `plugins/dsh-webhook-bridge/cordis.patch.yml` | 新增 `affinityWindowMs`/`minIntervalMs`/`maxFragments`/`maxMergedChars`/`questionTools`；`secretFile` 注释写明环境变量覆盖与环境变量名（保留本机默认值兜底） |
| `config/dsh-webhook-bridge.patch.sample.yml` | 与上者**键骨架逐键同步**（23 键，`scripts/check-config-samples.mjs` 会比对），值仍为占位符 |
| `plugins/dsh-webhook-bridge/README.md` | 更新请求/响应契约表（202 merged / 200 needs_input / 三态取值）、配置表（新增项 + 密钥来源优先级） |
| `docs/zh-CN/hook-judgment.md`（新增） | t6 交付物：转发判断规则表、跳过原因、显式前缀、防自回环、审计日志字段、判断代价与未验证项 |
| `docs/zh-CN/session-reuse-and-input.md`（新增） | t6 交付物：会话复用窗口语义、两层合并、**运行时做不到什么**（无 continue API）与后续方案、三态回传与编号选项、未验证项 |
| `package.json`（仓库根） | 新增 `test:hook-handler` 并纳入 `test` 链 |
| `DELIVERY-t6.md`（本文件） | 改动清单/用途、执行的命令与结论、未验证项、给 t3 的三句素材 |

## 2. 实际执行过的校验命令与结论

| 命令 | 结果 |
| --- | --- |
| `cmd /c "node --input-type=module --check < repos\dsh-openclaw-weixin-bridge\plugins\openclaw-hook-dsh-bridge\handler.js"` | exit 0 |
| `node repos/dsh-openclaw-weixin-bridge/plugins/openclaw-hook-dsh-bridge/test-handler.mjs` | exit 0，`101 passed, 0 failed`（含 §7 真实磁盘守卫 3 条） |
| `cmd /c "node --input-type=module --check < repos\dsh-openclaw-weixin-bridge\plugins\dsh-webhook-bridge\lib\index.js"` | exit 0 |
| `npm run check` | exit 0：`check-syntax: 16/16 通过`；`check-config-samples: 通过`（YAML 键骨架 23 键一致、无真实密钥命中） |
| `node plugins/openclaw-hook-dsh-bridge/test/self-test.mjs` | exit 0，`38 passed, 0 failed, 0 skipped`（含宿主 discovery 实测 8 条） |
| **空宿主** `USERPROFILE/DSH_WIN_HOME/APPDATA/OPENCLAW_STATE_DIR` → 空目录后跑 self-test | exit 0，`30 passed, 0 failed, 1 skipped`，照常打印汇总（**t7/f1 已修**） |
| 空宿主下跑 `test-handler.mjs` | exit 0，t6 时 `98 passed, 0 failed`；**t9 统一后的实际值为 109 passed / 0 failed**（见 DELIVERY-t9） |
| `node packages/openclaw-weixin-runtime-fix/test/verify-clone-fix.mjs` | exit 0，`56 passed, 0 failed`（回归：t1 资产未被破坏） |
| `pwsh -NoProfile -File packages/openclaw-weixin-runtime-fix/test/apply-gate-test.ps1` | exit 0，`27 passed, 0 failed` |
| `Get-ChildItem -Recurse -Filter package.json … \| ConvertFrom-Json` | exit 0，4 个 `package.json` 全部可解析 |
| `Get-Content handler.js -Raw \| node --input-type=module --check`（PowerShell 无 `<` 重定向的等价形式） | exit 0 |

关键实现依据（磁盘上核实，未凭想象）：
- 事件键：`~/.dsh-win/node/node_modules/openclaw/dist/internal-hook-types-Deg4lhm7.mjs` 的
  `KNOWN_INTERNAL_HOOK_EVENT_KEYS`（含 `message:received`、`message:sent`）。
- 事件上下文：openclaw 自带 `docs/automation/hooks/event-types.md`（`message:received` / `message:sent` 字段）。
- 会话日志形状（判定三态）：本机真实会话日志只读扫描——`turn/end.reason.kind` 实测 completed/aborted/error/blocked；
  `tool/call{callId,name,arguments}` + `tool/result{toolCallId}`；`approval/asked{id,toolName,callId,reason}` + `approval/decided`；
  `ask_user_question` 参数形状（83 次真实调用样本）；webhook 会话总数 36。
- 运行时能力边界：`@deepseek-ai/dsh-webhook` 0.1.7-rc.2 README 明确
  「The sole runtime action: create and prompt one root Session」「No built-in deduplication」「No completion result」。

## 3. 验收对照

| 验收项 | 落点 |
| --- | --- |
| 判断：闲聊/问候/追问/确认不再建会话；规则为可配置常量且顶部注释说明目的与代价 | `handler.js` 的 `JUDGMENT_CONFIG`/`PATTERNS`/`RULES` + 文件头「判断规则的代价」段；`test-handler.mjs` 第 1 节 |
| 显式覆盖前缀 `#dsh ` | `decideForward` 的 `override-prefix` 分支；第 2 节断言（前缀不进入正文） |
| 防自回环 | `EchoRing` + `message:sent` 订阅 + `self-loop-sender`/`fromMe`；第 3 节断言 |
| 每次判断写 `bridge-forward.log` | `appendForwardLog`（进入/判断/合并/回执/出站入环）；第 1、5、6 节断言 |
| 会话复用窗口 + 窗口过期有日志 + 同源多段合并 | `SessionAffinity`/`FragmentCoalescer` + `lib/index.js` 接线；第 4 节断言（含 `affinity-window-expired`、`affinity-reuse`、合并后只发一次） |
| 三态 + needs_input 纯文本编号选项 | `detectTurnState` + `formatNumberedOptions` + `mapBridgeResponse`；第 5 节断言 |
| needs_input 若无法区分须明写限制 | 本文件 §4 与 `docs/zh-CN/session-reuse-and-input.md` §3（运行时无 continue API，窗口语义 ≠ 追加同一会话历史） |
| 自测覆盖五类断言且仓库内可复现 | `test-handler.mjs`（t6 时 98 断言；**t9 统一为 109**）+ `test/self-test.mjs`（38 断言，空宿主安全） |
| 所有 JS 过 `--check`、所有 JSON 可解析 | `npm run check`（16/16）+ 上述 verify 命令 |
| 交付说明 | 本文件 |

## 4. 未验证项（明确声明，勿当成已完成）

1. **未做真实端到端**：没有真实微信账号/真实 Gateway 会话走一遍「微信 → 判断 → 合并 → DSH →
   needs_input → 编号选项」。所有断言都是离线构造的等价事件流与注入的假 fetch/假日志。
2. **needs_input 的现场条件未端到端制造**：判定形状取自本机 83 次真实 `ask_user_question` 调用样本与
   `approval/asked` 样本，但「DSH 回合等待回答时日志恰好停在该形状」这一步是离线复现，不是现场观察。
3. **审批型 needs_input 的选项是保守映射**：`approval/asked` 被映射为 `needs_input`（选项固定「允许/拒绝」）；
   真实批准流程是否总能被 `approval/decided` 配对未逐条验证。
4. **hook 侧未实现出站回传**：本包 hook 只把 needs_input 的编号选项写进日志并作为返回值返回，
   **不**替部署方发送到微信（依据：OpenClaw 的 Reply delivery 表里 message 事件的 `event.messages` 不会投递）。
   把选项真正发到微信需要部署方的出站路径（例如已部署版 `~/.openclaw/workspace/tools/dsh-bridge-forward/handler.js`
   里的 `sendBackToWeixin()`）；本包未合并该能力，也未验证。
5. **判断阈值是启发式**：12/30 字符阈值与中英关键词表按反馈设计，未在长期真实消息流上观察误报/漏报；
   审计日志的 `rule=` 字段是调参依据。
6. **桥接侧未在真实 DSH 进程里加载运行**：`lib/index.js` 只做了语法门禁与纯逻辑单测；
   亲和/三态接线未在跑起来的 Cordis 宿主里验证（需要重启 DSH profile，属部署方决策）。
7. **`scripts/test-bridge.ps1` 与 `DELIVERY-t1.md` 中的 f3 收尾未做**：本任务只改了
   `cordis.patch.yml` + `lib/index.js`（env 优先、本机默认兜底）；脚本与 t1 交付说明的同步留给 t7。
8. **自查发现并已修复的一处越界（如实披露）**：开发过程中一次早期测试运行的调用**漏注入**日志写入器，
   使 hook 用默认路径在 `~/.openclaw/logs/bridge-forward.log` 创建了一个 1 行文件（212 字节，
   内容为 `… decision=skip rule=empty …`，时间 12:18:52）。发现后已**删除该文件**（它在本轮之前不存在，
   删除即恢复原状），并做了两件事防止再犯：① 所有测试调用统一注入 `appendLog`；
   ② `test-handler.mjs` §7 新增「真实磁盘守卫」——测试前后比对默认日志路径的存在性/大小/mtime，
   一旦有任何调用漏注入就失败。当前复验：跑全部测试后该路径**不存在**；
   已部署的 `~/.openclaw/workspace/tools/dsh-bridge-forward/bridge-forward.log` 的 mtime 仍是我开工前的
   12:14:53（那是**线上** hook 自己写的，不是我）；`~/.dsh-win` 下的 worker-task-pool 与备份字节数未变。

## 5. 给 t3（docwriter）的三句素材

1. **自回环曾凭空产生会话并消耗额度，现由出站标记环拦截**：桥接把答复复述回微信后，通道 hook
   曾把它当作新的用户入站消息再次转发 DSH（实测新增会话 `webhook-dc144e09-…`，`turn/end` 为 `aborted`，
   回传 71 字符时 `send timeout`）；现在 `message:sent` 出站文本进标记环（默认 180s / 50 条），
   入站命中即跳过并记 `rule=self-loop-echo|self-loop-marker`。
2. **hook 的默认行为是「有判断的转发」，不是无条件转发**：只有命中「需要 DSH 本地能力」的信号
   （路径/命令/关键词/多行/长度）或显式前缀 `#dsh ` 才转发；闲聊、问候、确认、追问一律跳过；
   无法判定时默认跳过（可用 `DSH_BRIDGE_DEFAULT_DECISION=forward` 或 `DSH_BRIDGE_JUDGMENT=off` 改回）。
3. **`AGENTS.md` 与通道层 hook 是两条不同的路径**：`AGENTS.md` 约束的是 *agent 主动调用*；
   通道层 hook 由宿主 `message:received` 事件驱动、绕过 agent 自动转发。因此「用户在 AGENTS.md 里写了
   别用桥接器」并不会阻止 hook —— 这正是「我说了别用还在用」的根因，修在 hook 的判断逻辑里，不在文档里。
