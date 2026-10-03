# 通道 hook 的转发判断（t6）

> 面向部署者与审核者：说明**哪些微信消息会被转发到 DSH、哪些会被跳过、为什么**，
> 以及怎么覆盖判断、怎么审计。
>
> 实现：`plugins/openclaw-hook-dsh-bridge/handler.js`；自测：`plugins/openclaw-hook-dsh-bridge/test-handler.mjs`。

## 1. 为什么要有判断

修复前的行为是**无条件转发**：`message:received` 一到就 POST 给 DSH，桥接侧每次投递都新建一个会话。
后果（用户实测）：

- 「Agent 会不断去创建新对话」——一句闲聊也建一个会话；
- webhook 会话数从 35 涨到 36（本机复核为 36 个）；
- 用户明确说过「别用桥接器」，但仍然被自动调用。**根因是两条不同的路径**：
  `AGENTS.md` 约束的是 *agent 主动去调用*；而通道层 hook 是宿主事件驱动、绕过 agent 的**自动转发**。
  改文档不会改这条路径 —— 必须改 hook 的判断逻辑。

## 2. 判断顺序（命中即停）

| 顺序 | 规则（`rule=` 日志值） | 结论 | 说明 |
| --- | --- | --- | --- |
| 1 | `override-prefix` | **转发** | 消息以显式前缀开头（默认 `#dsh`，大小写不敏感，可跟 `:`/`：`/空格）。前缀本身不会进入转发正文 |
| 2 | `default-forward` | **转发** | `DSH_BRIDGE_JUDGMENT=off`（关闭判断，回到旧行为） |
| 3 | `self-loop-marker` | 跳过 | 入站正文以回复标记开头（默认 `[dsh]`）→ 是自己刚回传的内容 |
| 4 | `self-loop-echo` | 跳过 | 入站正文命中出站标记环（`message:sent` 记录，默认 180s 窗口、50 条上限） |
| 5 | `greeting` / `ack` / `emoji-only` / `follow-up` / `confirmation` | 跳过 | 仅当正文 ≤ `shortMessageMaxChars`（默认 12）时判断：问候、致谢/收到、纯表情/标点、追问（…吗/呢/怎么样）、确认（好/继续/别用/算了…） |
| 6 | `capability-path` | **转发** | 含路径信号（`D:\…`、`\\…`、`./…`、`~/…`） |
| 7 | `capability-command` | **转发** | 含命令/代码信号（代码块、反引号、`npm`/`node`/`git`/`pwsh`…、`$ ` 提示符） |
| 8 | `capability-keyword` | **转发** | 含文件/目录/仓库/代码/脚本/命令/报错/日志/端口/进程/接口/补丁/排查… 等关键词（中英双语） |
| 9 | `capability-multiline` | **转发** | 多行正文且长度 ≥ 16 |
| 10 | `capability-length` | **转发** | 正文长度 ≥ `capabilityMinChars`（默认 30） |
| 11 | `default-skip` / `default-forward` | 跳过 / 转发 | 上面都不命中时按 `defaultDecision`（默认 **skip**） |
| — | `self-loop-sender` | 跳过 | `metadata.fromMe`/`isBot`/`self` 为真，或 sender 落在 `botIds`，或 sender == accountId |
| — | `empty` / `channel` | 跳过 | 无正文（纯媒体）；通道不在 `channels` 白名单 |
| — | 合并/节流 | 延后 | 见 `session-reuse-and-input.md`：窗口内合并成一次派发 |

## 3. 判断的代价（务必知悉）

默认**保守**：无法判定「需要 DSH 本地能力」的消息**不转发**（不建会话）。
代价是**可能漏掉**一些用户其实想交给 DSH 的模糊消息。三种显式解除方式：

1. 用显式前缀：`#dsh 帮我看看这段文字的语气`；
2. `DSH_BRIDGE_DEFAULT_DECISION=forward` —— 把「无法判定」改成转发；
3. `DSH_BRIDGE_JUDGMENT=off` —— 关闭判断（只剩自回环/空消息过滤）。

规则与阈值都是可配置常量（`JUDGMENT_CONFIG` / `PATTERNS`，见 `handler.js` 顶部注释）：

| 配置 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_BRIDGE_JUDGMENT` | `on` | `off` 关闭判断 |
| `DSH_BRIDGE_DEFAULT_DECISION` | `skip` | `forward` 改为默认转发 |
| `DSH_BRIDGE_FORWARD_PREFIX` | `#dsh` | 显式覆盖前缀 |
| `DSH_BRIDGE_REPLY_MARKER` | `[dsh]` | 回复标记（自回环识别） |
| `DSH_BRIDGE_BOT_IDS` | 空 | 视为自身/bot 的 sender 列表 |
| `DSH_BRIDGE_LOOP_WINDOW_MS` | `180000` | 标记环时间窗 |
| `DSH_BRIDGE_COALESCE_MS` | `1500` | 同源多段合并的静默窗口（0 关闭） |
| `DSH_BRIDGE_MIN_INTERVAL_MS` | `1500` | 节流间隔 |
| `DSH_BRIDGE_FORWARD_LOG` | `<stateDir>/logs/bridge-forward.log` | 判断日志路径 |

## 4. 防自回环（I8）

hook 同时订阅 `message:sent`（依据：`~/.dsh-win/node/node_modules/openclaw/dist/internal-hook-types-Deg4lhm7.mjs`
里的 `KNOWN_INTERNAL_HOOK_EVENT_KEYS` 含 `message:received` 与 `message:sent`）：
凡本进程发出的出站文本都会进「标记环」；入站命中标记环（完全一致，或 ≥24 字符的前缀包含）、
带回复标记、或来自 bot/自身账号 → 跳过并记日志 `rule=self-loop-echo|self-loop-marker|self-loop-sender`。

历史事实（进入已知问题与警告）：**自回环曾凭空产生会话并消耗额度** —— 桥接把答复复述回微信后，
通道 hook 把它当成新的用户入站消息再次转发 DSH，生成一个新的无意义会话（实测 `webhook-dc144e09-…`，
`turn/end` 为 `aborted`，回传 71 字符时 `send timeout`）。现在由出站标记环拦截。

## 5. 审计日志

每次判断都会向 `bridge-forward.log` 追加一行（`appendFileSync`，失败被吞掉，不影响转发）：

```
[2026-10-03T04:00:00.000Z] enter type=message action=received channel=openclaw-weixin from=<sender> origin=conv:<id> textLen=27 decision=skip rule=greeting
[2026-10-03T04:00:01.000Z] enter … decision=forward rule=capability-path
[2026-10-03T04:00:02.000Z] enter … result=buffered reason=coalesced fragments=2
[2026-10-03T04:00:03.000Z] enter … result=ok status=200 session=webhook-xxxx state=needs_input kind=question fragments=2 replyLen=140
[2026-10-03T04:00:04.000Z] sent channel=openclaw-weixin to=<sender> textLen=140 ring=1
```

字段：`decision=forward|skip`、`rule=<命中规则>`、`result=ok|buffered|http-error|failed|unconfigured|bad-url|no-fetch`、
`state=completed|needs_input|aborted|error|blocked|running|accepted|merged`、`session=`、`fragments=`、`replyLen=`。
用 `rule=` 就能回答「这条消息为什么被跳过」。

正文默认**不写日志**（只写长度）；需要正文时显式打开 `DSH_BRIDGE_LOG_BODY=1`。
密钥永不出现在日志里（所有输出过 `redact()`）。

## 6. 未验证项

- 判断规则本身有单元断言（`test-handler.mjs`，98 条），但**未在真实微信消息流上做长期观察**：
  阈值（12 / 30 字符）与中英关键词表是按用户反馈设计的启发式，可能需要按你的实际用语调整。
- 「本条消息是否值得转发」本质是**语义判断**，本实现用的是可解释的规则，不是模型判断；
  漏报/误报都会记在 `bridge-forward.log` 里，便于事后按 `rule=` 收紧或放宽。
