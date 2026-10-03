# Session reuse, merging and the needs_input three-state receipt

> For deployers and reviewers: how the "one message = one session" situation was contained, what the
> window semantics are, how `completed / needs_input / aborted` come back, and **what is impossible**.
>
> Implementation: `plugins/dsh-webhook-bridge/lib/affinity.mjs` (pure logic) + `lib/index.js` (wiring);
> tests: `plugins/openclaw-hook-dsh-bridge/test-handler.mjs` (imports that pure logic for its assertions).

## 1. The situation and the defects to fix

| Defect | Symptom | Evidence |
| --- | --- | --- |
| Session explosion | every inbound message created a new DSH session | measured: webhook sessions 35→36 |
| Fragments creating duplicates | **one sentence** was split by WeChat into 3 fragments → 3 sessions | user-reported measurement |
| Stuck on a choice | when a choice appeared in the turn, WeChat never saw the options and DSH kept waiting | user-reported measurement |

## 2. Two layers of containment: hook-side merging, bridge-side affinity

```text
WeChat (may split one message into several fragments)
  └─ hook (OpenClaw channel layer)
       ├ judgement (see hook-judgment.md)
       └ same-origin fragment merging: fragments arriving inside the quiet window
            coalesceMs=1500ms → merged into **one** POST
            (the window has a hard cap coalesceMaxMs=5000ms; a same-origin dispatch in flight is not overlapped)
  └─ bridge (DSH side, ctx.webhookRuntime)
       ├ session affinity slot (origin = conversationId, falling back to sender)
       │    ├ inside the window + previous turn still running → merged into the next dispatch (no new session)
       │    ├ inside the window + less than minIntervalMs since the last dispatch → merged into the same dispatch
       │    └ window expired → new session, and the log records affinity-window-expired
       └ one dispatch of a WebhookSessionRequest (the merged body)
```

The window defaults are `affinityWindowMs=900000` (15 minutes) and the throttle `minIntervalMs=1500`.
While the previous turn is still running inside the window, the bridge returns
`202 {status:"merged", reused:true, deferred:true, sessionId:<running session>}`; after the window
expires it returns `202 {status:"accepted", reused:false}` and writes `affinity-window-expired` to `logFile`.

## 3. **What is impossible** (must know, do not be misled)

The README of `@deepseek-ai/dsh-webhook` (0.1.7-rc.2) says explicitly:

> - **The sole runtime action: create and prompt one root Session**
> - **No built-in deduplication**
> - **No completion result**

Its rule interface is `register(rule)` + `dispatch(delivery)`, and a rule can only return "one Session
request"; there is **no API at all to append a message to an existing session**. Therefore:

- ✅ what this package does guarantee: **messages from the same origin inside the window are not split
  into several sessions** (they merge into one dispatch), and throttling, deduplication and window-expiry
  behaviour are all logged;
- ❌ this package does **not** implement "append follow-up messages into the same DSH session history" —
  the runtime has no such path. The window means "the same session boundary (one dispatch)", not "the
  same session history";
- once the previous turn has **ended** (`turn/end`), the next message is a new session (log
  `affinity-new-turn`). That is a runtime limit, not a choice of this package.

**Follow-up options (not implemented, for upstream or later work)**:
1. upstream adds resume/append to `webhookRuntime` (calling `Agent.followup()` on an existing Session);
2. or this bridge stops going through the webhook runtime and injects the `dsh-agent`/`dsh-session`
   layer directly, holding the Agent handle itself (a larger change requiring new interface evidence and verification);
3. short-term compromise: merge "several turns from the same origin" on the hook side into one body with
   context (a larger merge window does this), at the cost of a longer first response.

## 4. The three-state receipt: completed / needs_input / aborted

With `wait:true`, the bridge reads the session log
(`<stateDir>/sessions/<workspace>/<session>/session.v4.jsonl.zstd`) and decides the turn state from the
**event stream** (the logic is `detectTurnState` in `lib/affinity.mjs`):

| State | Evidence (real log shapes) |
| --- | --- |
| `completed` | the most recent `turn/end.data.reason.kind === "completed"` |
| `aborted` | `turn/end.data.reason.kind === "aborted"` (may carry a nested `reason.kind`, e.g. `user`) |
| `needs_input` | inside an **unfinished** turn there is an unpaired `ask_user_question` (`tool/call` without `tool/result`), or an undecided `approval/asked` (no `approval/decided`) |
| `error` / `blocked` / `running` | as above, from other `turn/end.reason.kind` values; no `turn/end` at all means `running` |

On `needs_input` the bridge returns immediately (**it no longer waits for the timeout**) and turns the
options into numbered plain text:

```json
{
  "status": "needs_input", "state": "needs_input", "sessionId": "webhook-…",
  "questionKind": "ask_user_question", "question": "Which loader and MC version?",
  "options": [{ "index": 1, "label": "NeoForge 1.21.x (recommended)", "description": "…" }],
  "replyText": "DSH needs your choice before it can continue.\nQuestion: Which loader and MC version?\nReply with the number:\n1) NeoForge 1.21.x (recommended) —— …"
}
```

The hook writes `replyText` to the Gateway log (`state=needs_input`, including the numbered options); the
caller can send that plain text back into WeChat and the user replies "1".

> Honest boundary: this package **does not** send `replyText` back to WeChat for the caller (the hook
> performs no outbound send; evidence: in OpenClaw's Reply delivery table the `event.messages` of a
> message event is not delivered). That step is up to the deployer's outbound path — see "Known issues" in
> the root README.

## 5. Configurable items

| Config | Default | Effect |
| --- | --- | --- |
| `affinityWindowMs` | `900000` | session affinity window (ms); expiry creates a new session and logs it |
| `minIntervalMs` | `1500` | throttle: new messages less than this after the last dispatch merge into the next dispatch |
| `maxFragments` | `20` | maximum fragments merged into one dispatch |
| `maxMergedChars` | `8000` | merged text character limit (overflow is truncated and `affinity-merge-truncated` is logged) |
| `questionTools` | `["ask_user_question"]` | tool names that identify `needs_input` |
| `waitTimeoutMs` | `120000` | longest wait for `wait:true` (needs_input and turn end both return earlier) |

## 6. Unverified items

- The shapes `detectTurnState` recognises come from **real local session logs** (including 83 real
  `ask_user_question` call samples and four `turn/end` reason values), but this package has **not**
  manufactured a real end-to-end run of "WeChat message → DSH waits for a choice → numbered options
  returned"; the assertions use an equivalent synthetic event stream (section 5 of `test-handler.mjs`).
- `approval/asked` (needs a click to approve) is conservatively mapped to `needs_input` (with fixed
  "allow/deny" options); whether every real approval flow first writes `approval/asked` was not verified
  item by item.
- The default merge window (1500ms) was chosen from the observed "WeChat splits one sentence" behaviour;
  it may need tuning for other clients/networks.
- Other risks related to this page (no echo, `needs_input` handing out text only, affinity ≠ history
  append, end-to-end unverified) are collected in KI-2 / KI-9 / KI-10 / KI-13 of `known-issues.md`.
