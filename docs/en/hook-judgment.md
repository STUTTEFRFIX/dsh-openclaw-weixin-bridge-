# Forwarding judgement in the channel hook

> For deployers and reviewers: **which WeChat messages get forwarded to DSH, which are skipped, and
> why** — plus how to override the decision and how to audit it.
>
> Implementation: `plugins/openclaw-hook-dsh-bridge/handler.js`;
> tests: `plugins/openclaw-hook-dsh-bridge/test-handler.mjs`.

## 1. Why judgement exists at all

The behaviour before the fix was **unconditional forwarding**: as soon as `message:received` arrived it
was POSTed to DSH, and every delivery created a new session. Consequences (measured by the user):

- "the agent keeps creating new conversations" — one line of small talk created one session;
- the webhook session count grew from 35 to 36 (confirmed locally: 36);
- the user had explicitly said "don't use the bridge", yet it kept being invoked. **The root cause is
  two different paths**: `AGENTS.md` constrains *the agent deciding to call something*, whereas the
  channel-layer hook is host-event-driven **automatic forwarding** that bypasses the agent entirely.
  Editing documentation does not change that path — the hook's judgement logic has to change.

## 2. Decision order (first hit wins)

| Order | Rule (`rule=` log value) | Verdict | Notes |
| --- | --- | --- | --- |
| 1 | `override-prefix` | **forward** | text starts with the explicit prefix (default `#dsh`, case-insensitive, may be followed by `:` / `：` / space). The prefix itself is not part of the forwarded body |
| 2 | `default-forward` | **forward** | `DSH_BRIDGE_JUDGMENT=off` (judgement disabled, back to the old behaviour) |
| 3 | `self-loop-marker` | skip | inbound text starts with the reply marker (default `[dsh]`) → it is our own echoed content |
| 4 | `self-loop-echo` | skip | inbound text hits the outbound marker ring (recorded from `message:sent`; default 180s window, 50 entries max) |
| 5 | `greeting` / `ack` / `emoji-only` / `follow-up` / `confirmation` | skip | only checked when the body is ≤ `shortMessageMaxChars` (default 12): greetings, thanks/acknowledgements, emoji/punctuation only, follow-ups (…吗 / 呢 / 怎么样) and confirmations (好 / 继续 / 别用 / 算了 …) |
| 6 | `capability-path` | **forward** | contains a path signal (`D:\…`, `\\…`, `./…`, `~/…`) |
| 7 | `capability-command` | **forward** | contains a command/code signal (fenced blocks, backticks, `npm`/`node`/`git`/`pwsh`…, a `$ ` prompt) |
| 8 | `capability-keyword` | **forward** | contains keywords such as file/directory/repo/code/script/command/error/log/port/process/api/patch/diagnose (bilingual) |
| 9 | `capability-multiline` | **forward** | multi-line body of length ≥ 16 |
| 10 | `capability-length` | **forward** | body length ≥ `capabilityMinChars` (default 30) |
| 11 | `default-skip` / `default-forward` | skip / forward | nothing above matched, so `defaultDecision` applies (default **skip**) |
| — | `self-loop-sender` | skip | `metadata.fromMe`/`isBot`/`self` is true, or the sender is in `botIds`, or sender == accountId |
| — | `empty` / `channel` | skip | no body (media only); channel not in the `channels` allow-list |
| — | merge / throttle | deferred | see `session-reuse-and-input.md`: fragments inside the window merge into one dispatch |

## 3. The cost of judgement (must know)

The default is **conservative**: messages that cannot be recognised as "needs DSH's local capability"
are **not forwarded** (no session is created). The cost is that some vague messages the user actually
wanted DSH to handle are **missed**. Three explicit ways to lift this:

1. use the explicit prefix: `#dsh have a look at the tone of this text`;
2. `DSH_BRIDGE_DEFAULT_DECISION=forward` — turn "cannot decide" into forwarding;
3. `DSH_BRIDGE_JUDGMENT=off` — disable judgement (only the self-loop and empty-message filters remain).

The rules and thresholds are configurable constants (`JUDGMENT_CONFIG` / `PATTERNS`, see the header
comment in `handler.js`):

| Config | Default | Effect |
| --- | --- | --- |
| `DSH_BRIDGE_JUDGMENT` | `on` | `off` disables judgement |
| `DSH_BRIDGE_DEFAULT_DECISION` | `skip` | `forward` switches the default to forwarding |
| `DSH_BRIDGE_FORWARD_PREFIX` | `#dsh` | explicit override prefix |
| `DSH_BRIDGE_REPLY_MARKER` | `[dsh]` | reply marker (self-loop recognition) |
| `DSH_BRIDGE_BOT_IDS` | empty | senders treated as itself/a bot |
| `DSH_BRIDGE_LOOP_WINDOW_MS` | `180000` | marker-ring time window |
| `DSH_BRIDGE_COALESCE_MS` | `1500` | quiet window for same-origin fragment merging (0 disables) |
| `DSH_BRIDGE_FORWARD_LOG` | `<stateDir>/logs/bridge-forward.log` | audit log path |

> Every entry above is a **hook-side** setting (implemented by `pickEnvironmentOverrides` /
> `pickFileOverrides` in `handler.js`). The throttle interval `minIntervalMs` and the affinity window
> `affinityWindowMs` are **not** hook-side settings: they belong to the DSH bridge plugin
> (`plugins/dsh-webhook-bridge/cordis.patch.yml`), so setting `DSH_BRIDGE_MIN_INTERVAL_MS` has no effect.

## 4. Loop prevention

The hook also subscribes to `message:sent` (evidence: `<openclaw>/dist/internal-hook-types-*.mjs`,
whose `KNOWN_INTERNAL_HOOK_EVENT_KEYS` contains both `message:received` and `message:sent`):
every outbound text this process sends enters the "marker ring". An inbound message that hits the ring
(exact match, or a prefix match of ≥24 characters), carries the reply marker, or comes from a bot/own
account is skipped and logged as `rule=self-loop-echo|self-loop-marker|self-loop-sender`.

Historical fact (now part of the known issues): **a self-loop once created sessions out of thin air and
burned quota** — after the bridge repeated an answer back into WeChat, the channel hook treated it as a
fresh inbound user message and forwarded it to DSH again, creating a meaningless session (with a
71-character echo it ended in `send timeout` and `turn/end` was `aborted`). The outbound marker ring now
intercepts this.

## 5. Audit log

Every decision appends one line to `bridge-forward.log` (`appendFileSync`; failures are swallowed and
never affect forwarding):

```text
[2026-10-03T04:00:00.000Z] enter type=message action=received channel=openclaw-weixin from=<sender> origin=conv:<id> textLen=27 decision=skip rule=greeting
[2026-10-03T04:00:01.000Z] enter … decision=forward rule=capability-path
[2026-10-03T04:00:02.000Z] enter … result=buffered reason=coalesced fragments=2
[2026-10-03T04:00:03.000Z] enter … result=ok status=200 session=webhook-xxxx state=needs_input kind=question fragments=2 replyLen=140
[2026-10-03T04:00:04.000Z] sent channel=openclaw-weixin to=<sender> textLen=140 ring=1
```

Fields: `decision=forward|skip`, `rule=<matched rule>`,
`result=ok|buffered|http-error|failed|unconfigured|bad-url|no-fetch`,
`state=completed|needs_input|aborted|error|blocked|running|accepted|merged`, `session=`, `fragments=`,
`replyLen=`. The `rule=` value answers "why was this message skipped".

Message bodies are **not** logged by default (only lengths); turn on `DSH_BRIDGE_LOG_BODY=1` if you need
them. The secret never appears in the log (all output passes through `redact()`).

## 6. Unverified items

- The rules have unit assertions (`test-handler.mjs`; counts are whatever the script prints), but they
  have **not been observed over a long period on real WeChat traffic**: the thresholds (12 / 30 chars)
  and the bilingual keyword tables are heuristics designed from user feedback and may need adjustment
  for your own wording.
- "Is this message worth forwarding" is inherently a **semantic decision**; this implementation uses
  explainable rules, not a model. Both misses and false positives are recorded in `bridge-forward.log`,
  so you can tighten or loosen by `rule=` afterwards.
- Other risks related to judgement (the default skip dropping messages, small talk being questioned or
  aborted on the DSH side, the log's privacy boundary) are collected in KI-4 / KI-8 / KI-11 / KI-12 of
  `known-issues.md`.
