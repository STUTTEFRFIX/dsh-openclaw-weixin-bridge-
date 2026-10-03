# 会话复用、合并与 needs_input 三态回传（t6）

> 面向部署者与审核者：说明「一条消息 = 一个会话」这个现状是怎么被收敛的、
> 窗口语义是什么、`completed / needs_input / aborted` 怎么回传、以及**哪些做不到**。
>
> 实现：`plugins/dsh-webhook-bridge/lib/affinity.mjs`（纯逻辑）+ `lib/index.js`（接线）；
> 自测：`plugins/openclaw-hook-dsh-bridge/test-handler.mjs`（导入上面的纯逻辑做断言）。

## 1. 现状与要修的缺陷

| 缺陷 | 现象 | 证据 |
| --- | --- | --- |
| 会话爆炸 | 每条入站消息都新建 DSH 会话 | 实测 webhook 会话 35→36 个 |
| 拆段重复建会话 | 用户**一句话**被微信拆成 3 段 → 3 个会话 | 用户反馈 I7 |
| 选择项卡死 | 回合里出现选择项时，微信侧看不到选项、DSH 侧一直等 | 用户反馈 I4 |

## 2. 两层收敛：hook 侧合并，桥接侧亲和

```
微信（可能把一条消息拆成多段）
  └─ hook（OpenClaw 通道层）
       ├ 判断（见 hook-judgment.md）
       └ 同源多段合并：静默窗口 coalesceMs=1500ms 内到达的段 → 合并成**一次** POST
            （窗口有硬上限 coalesceMaxMs=5000ms；同源在途时不并发派发）
  └─ 桥接（DSH 侧，ctx.webhookRuntime）
       ├ 会话亲和槽（origin = conversationId，缺失时退化为 sender）
       │    ├ 窗口内 + 上一轮仍在跑 → 合并进下一次派发（不新建会话）
       │    ├ 窗口内 + 距上次派发 < minIntervalMs → 并入同一次派发
       │    └ 窗口过期 → 新建会话，并写日志 affinity-window-expired
       └ 派发一次 WebhookSessionRequest（合并后的正文）
```

窗口默认 `affinityWindowMs=900000`（15 分钟）、节流 `minIntervalMs=1500`。
窗口内、上一轮仍在跑时，桥接返回 `202 {status:"merged", reused:true, deferred:true, sessionId:<在跑的会话>}`；
窗口过期后返回 `202 {status:"accepted", reused:false}` 并在 `logFile` 写 `affinity-window-expired`。

## 3. **做不到什么**（必须知道，勿被误导）

`@deepseek-ai/dsh-webhook`（0.1.7-rc.2）的 README 明确写着：

> - **The sole runtime action: create and prompt one root Session**
> - **No built-in deduplication**
> - **No completion result**

它的规则接口是 `register(rule)` + `dispatch(delivery)`，规则只能返回「一个 Session 请求」，
**没有任何 “往已存在会话追加消息” 的 API**。因此：

- ✅ 本包能保证的：**窗口内同一来源的消息不会被拆成多个会话**（合并到同一次派发），节流、去重、
  窗口过期行为都有日志；
- ❌ 本包**没有**实现「把后续消息追加进同一个 DSH 会话历史」——运行时没这条路。窗口的语义是
  「同一个会话边界（一次派发）」，不是「同一个会话历史」。
- 一旦上一轮**已经结束**（`turn/end`），下一条消息就是新的会话（日志 `affinity-new-turn`），
  这是运行时限制，不是本包的选择。

**后续方案（未实现，供上游/后续任务）**：
1. 上游给 `webhookRuntime` 增加 resume/append（在已有 Session 上 `Agent.followup()`）；
2. 或本桥接不再经 webhook 运行时创建会话，改为直接注入 `dsh-agent`/`dsh-session` 层服务，
   自持 Agent 句柄并复用（改动更大，需要新的接口依据与验证）；
3. 短期折中：把「同一来源的多轮」在 hook 侧合并成一段带上下文的正文（合并窗口调大即可），
   代价是首响延迟变长。

## 4. 三态回传：completed / needs_input / aborted

桥接在 `wait:true` 时读取会话日志（`<stateDir>/sessions/<工作区>/<会话>/session.v4.jsonl.zstd`），
按**事件流**判定回合状态（判定逻辑见 `lib/affinity.mjs` 的 `detectTurnState`）：

| 状态 | 判定依据（真实日志形状） |
| --- | --- |
| `completed` | 最近的 `turn/end.data.reason.kind === "completed"` |
| `aborted` | `turn/end.data.reason.kind === "aborted"`（可带嵌套 `reason.kind`，如 `user`） |
| `needs_input` | **尚未结束**的回合里出现未配对的 `ask_user_question`（`tool/call` 无 `tool/result`），或未决定的 `approval/asked`（无 `approval/decided`） |
| `error` / `blocked` / `running` | 同上，来自 `turn/end.reason.kind` 的其它取值；无 `turn/end` 则为 `running` |

`needs_input` 时桥接立即返回（**不再等到超时**），并把选项转成纯文本编号：

```json
{
  "status": "needs_input", "state": "needs_input", "sessionId": "webhook-…",
  "questionKind": "ask_user_question", "question": "用哪个加载器和 MC 版本？",
  "options": [{ "index": 1, "label": "NeoForge 1.21.x（推荐）", "description": "…" }],
  "replyText": "DSH 需要你选择后才能继续。\n问题：用哪个加载器和 MC 版本？\n请回复对应序号：\n1) NeoForge 1.21.x（推荐） —— …"
}
```

hook 收到后把 `replyText` 写进 Gateway 日志（`state=needs_input`，并打印编号选项），
调用方可以直接把这段纯文本发回微信，用户回复「1」即可。

> 诚实边界：本包**不**替调用方把 `replyText` 发回微信（hook 不做出站发送；
> 依据：OpenClaw 的 Reply delivery 表里 message 事件的 `event.messages` 不会投递）。
> 这一步由部署方的出站路径决定，见仓库根 README 的「已知问题」。

## 5. 可配置项

| 配置 | 默认 | 作用 |
| --- | --- | --- |
| `affinityWindowMs` | `900000` | 会话亲和窗口（毫秒）；过期新建并写日志 |
| `minIntervalMs` | `1500` | 节流：距上次派发不足该值的新消息并入下一次派发 |
| `maxFragments` | `20` | 一次派发最多合并多少段 |
| `maxMergedChars` | `8000` | 合并文本字符上限（超出截断并写 `affinity-merge-truncated`） |
| `questionTools` | `["ask_user_question"]` | 判定 `needs_input` 的工具名 |
| `waitTimeoutMs` | `120000` | `wait:true` 时的最长等待（needs_input/结束都会提前返回） |

## 6. 未验证项

- `detectTurnState` 的判定形状来自**本机真实会话日志**（含 83 次 `ask_user_question` 真实调用样本、
  `turn/end` 的四种 reason 取值），但本包**没有**端到端制造一次「微信消息 → DSH 等待选择 → 回传编号选项」
  的真实流程；断言是离线构造的等价事件流（`test-handler.mjs` 第 5 节）。
- `approval/asked`（需要点击批准）被保守地映射为 `needs_input`（选项固定为「允许/拒绝」）；
  真实批准流程是否总是先写 `approval/asked` 未逐条验证。
- 合并窗口的默认值（1500ms）是按「微信把一句话拆成多段」的现象取的；不同客户端/网络下可能需调整。
