# Known issues and warnings (English)

This is the **standalone risk chapter**; the root `README.md` "Known issues and limitations" section is
its summary. Every entry states: symptom → cause → evidence (file/command in this repository) →
mitigation or handling → status.

**Status vocabulary**: `unresolved` = there is no fix inside this project; `by design` = intentional,
avoided through configuration or process; `mitigated` = guards exist but the root cause remains;
`unverified` = no measured evidence, so do not treat it as a working capability.

## Summary

| ID | Severity | In one line | Status |
| --- | --- | --- | --- |
| KI-1 | High | The runtime patch lives inside `node_modules`, so every OpenClaw upgrade wipes it | unresolved (unsupported modification) |
| KI-2 | High | This repository **does not send DSH replies back to WeChat**; WeChat outbound is bound to a per-message `contextToken`, so delivery is inherently unstable | unresolved |
| KI-3 | Medium | One WeChat message can be answered **twice**: by the channel's own agent reply and by a DSH bridge echo | unresolved (this repo does not echo; the risk comes from an outbound path you add) |
| KI-4 | Medium | The DSH workspace protocol (`AGENTS.md`) makes small talk / short messages get questioned or aborted | by design (avoided via `default-skip` and a dedicated workspace) |
| KI-5 | High | `permissionPreset: danger-full-access` hands a disk-wide writable session to whoever holds the shared secret | by design (`workspace-write` is the default) |
| KI-6 | High | Missing, mismatched or leaked shared secret (503 / 401 / someone else creating sessions) | mitigated |
| KI-7 | Medium | A missing or over-wide workspace fence admits any path; a too-narrow one rejects every forward | mitigated |
| KI-8 | Medium | The default `default-skip` drops small talk / confirmations / short follow-ups (they are missed) | by design |
| KI-9 | Medium | `needs_input` can only hand out plain-text options; it cannot click for the user or read a "1" back from WeChat | unresolved |
| KI-10 | Medium | Session affinity "merges into one dispatch"; it does **not** append to the same session history | unresolved (no API upstream) |
| KI-11 | Low | The forwarding decision is heuristic and has not been observed on real traffic long-term | unverified |
| KI-12 | Medium | The audit log contains sender identifiers and conversation keys (privacy) | mitigated |
| KI-13 | Medium | All automated verification is offline/synthetic; no real WeChat end-to-end run | unverified |
| KI-14 | Low | Inherent costs of the runtime fix: noisy log line, depth limit, single structural fingerprint | by design |
| KI-15 | Medium | `DSH_BRIDGE_ECHO_BACK` is parsed but has **no implementation at all** | unresolved (do not assume it echoes) |
| KI-16 | Medium | The hook runs in the same process as the Gateway and is trusted code | by design |
| KI-17 | Medium | per-hook env is unreliable for `message:received` | mitigated (use env vars / side-car JSON) |
| KI-18 | Medium | There is no installer for the DSH-side plugin, and the live config is the copy inside `<profile>` | by design |
| KI-19 | Low | WeChat splits one sentence into fragments → a merge window is required, hard cap 5000ms | mitigated |
| KI-20 | Low | The Chinese and English pages must be maintained together, or they drift | process requirement |

---

## KI-1 The runtime patch is lost on every OpenClaw upgrade (High)

- **Symptom**: replies work again after patching; after some OpenClaw upgrade the "messages arrive but
  no reply goes out" failure returns.
- **Cause**: the patch rewrites `node_modules/openclaw/dist/worker-task-pool-*.mjs` inside the shipped
  package. An upgrade replaces that file, so both the patch and its `.orig-bak` are gone.
- **Evidence**: `packages/openclaw-weixin-runtime-fix/README.md` ("Nature" and "Rollback"), and
  `packages/openclaw-weixin-runtime-fix/scripts/patch-worker-pool.ps1` (backup name fixed at
  `<target>.orig-bak`).
- **Mitigation**: after an upgrade re-run
  `pwsh -NoProfile -File packages/openclaw-weixin-runtime-fix/scripts/apply.ps1 -DistPath "<openclaw>\dist\worker-task-pool-XXXX.mjs"`.
  If the upgrade left an old `.orig-bak` behind, **do not** copy it over the new version (version
  mismatch) — just delete it.
- **Warning**: this is an **unsupported modification**, not an OpenClaw extension point. `apply` passes
  a syntax gate and a structural gate before touching disk; if any step fails, the target file is left
  untouched (assertions in `test/apply-gate-test.ps1`).

## KI-2 No reply echo, and WeChat outbound is bound to `contextToken` (High)

- **Symptom**: after installing this repository, DSH finishes the work but nothing arrives in WeChat.
- **Cause 1 (a design boundary of this repository)**: under OpenClaw's `Reply delivery` rules,
  `event.messages` is only consumed on command paths such as `/new` and `/reset`; message events are
  explicitly listed as "Ignored as replies". Therefore `plugins/openclaw-hook-dsh-bridge/handler.js`
  **does not write** `event.messages` (to avoid faking a delivered reply); it only records the reply
  text / `needs_input` text in the log and returns it.
- **Cause 2 (the outbound token)**: sending through the WeChat channel needs a **per-message**
  `contextToken`, issued by the WeChat `getupdates` API alongside the inbound message, stored by the
  channel plugin per (account, user) in its own memory/persistent store, and passed back as
  `context_token` in the send request. A hook event does **not** carry that token, so "let the hook send
  the reply itself" is inherently unstable; the only viable paths are the channel plugin's own send path
  or an official send API.
- **Evidence**: `handler.js` (`grep` for `spawn` / `message send` / `sendBack` yields **0 hits** in the
  whole file); "What it does not do" in `plugins/openclaw-hook-dsh-bridge/HOOK.md`; the Reply delivery
  table in OpenClaw's own `docs/automation/hooks/writing-hooks.md`; for the token mechanism, the locally
  installed channel package `@tencent-weixin/openclaw-weixin`:
  `dist/src/messaging/inbound.js` (`setContextToken` / `getContextToken` / `persistContextTokens`) and
  `dist/src/api/api.js` (`context_token: params.contextToken`).
- **Corroboration (outside the repository, not a conclusion of this repository)**: this machine once had
  an **unpublished** deployed hook that echoed replies with the `openclaw message send` CLI: 6 of 9
  inbound messages succeeded, 3 failed with `error=send timeout` (30-second timeout). The record lives
  in the DSH workspace file `reports/notice-to-weixin-bridge-2026-10-03.md` (**outside this repository**).
- **Mitigation**: implement the echo yourself (official send API or a plugin-layer typed hook) and accept
  that a missing or expired token means failure; or treat `replyText` purely as an audit artifact.
- **Do not be misled**: this repository has no echo implementation, and note that
  `DSH_BRIDGE_ECHO_BACK` is a dead switch (KI-15).

## KI-3 A message can be answered twice (Medium)

- **Symptom**: for one WeChat message the user may receive two replies — one from the WeChat channel's
  **own agent reply** and one from the "DSH bridge echo".
- **Cause**: these are two **mutually unaware** paths. The channel plugin replies to the message through
  its normal agent flow, while this repository's bridge opens a separate DSH session for the same text.
  As soon as someone adds an outbound echo (KI-2), both paths send a message. In the KI-2 corroboration
  the echo was in fact a second message sent via `openclaw message send`.
- **Evidence**: the decision order and self-loop filters in `handler.js` (reply marker `[dsh]` plus the
  outbound marker ring `loopWindowMs=180000` / 50 entries); section "Loop prevention" in
  `docs/zh-CN/hook-judgment.md` (English mirror: `docs/en/hook-judgment.md`).
- **Mitigation**: let **exactly one** path own the reply (either turn off the channel agent's automatic
  reply, or do not echo from the bridge); if you must keep both, tag echoed text with a marker such as
  `[dsh]` so the marker ring breaks the loop.
- **Note**: this repository alone **cannot** produce a double reply (it never sends outbound); the risk
  appears only once you add an outbound path.

## KI-4 The DSH workspace protocol (`AGENTS.md`) questions or aborts small talk (Medium)

- **Symptom**: forwarded messages such as "hello", "is this ok?" or "continue" come back as a
  counter-question ("the requirement is unclear, please confirm the scope first") or as
  `turn/end: aborted`, and the user sees nothing useful.
- **Cause**: the session the bridge creates runs inside the `workspaceRoot` you configured, and **that
  workspace's `AGENTS.md` is injected as instructions**. Typical protocols demand "list the requirements
  first", "propose a plan before acting" and "ask when in doubt", so casual or short messages are treated
  as incomplete requests — questioned or aborted outright.
- **Evidence**: section 1 of `docs/zh-CN/hook-judgment.md` records the lesson that such documents cannot
  change the hook path (`AGENTS.md` constrains the agent's own actions, while the channel-layer hook is
  automatic, event-driven forwarding); the state semantics come from the turn-state table in
  `docs/zh-CN/session-reuse-and-input.md` (`aborted` originates from `turn/end.data.reason.kind`).
- **Mitigation**: give the bridge a **dedicated workspace with a looser protocol**
  (`workspaceRoot` / `workspacePath` pointing at it), and rely on the hook's default judgement
  (`judgment=on` + `defaultDecision=skip`) to keep small talk out.
- **Cost**: this also drops some genuinely DSH-worthy vague messages; see KI-8.

## KI-5 The risks of `danger-full-access` (High)

- **Symptom**: with `permissionPreset: danger-full-access`, anyone holding the shared secret can create
  a session that **writes the whole disk and executes commands**.
- **Cause**: the bridge's only gate is the shared secret, and there is no second authentication on the
  DSH side (`allowSenders` is optional and matches the caller-reported `sender`).
  `danger-full-access` puts that session capability directly behind the secret.
- **Evidence**: `Config.permissionPreset` (default `workspace-write`) and `allowSenders`
  (default `[]` = no check) in `plugins/dsh-webhook-bridge/lib/index.js`; the comments in
  `config/dsh-webhook-bridge.patch.sample.yml`.
- **Mitigation**: keep `workspace-write` (the default); restrict `workspaceRoot` to a dedicated
  directory; fill in `allowSenders`; expose the DSH entry only on localhost or a trusted network; rotate
  the secret.
- **Corollary**: `minIntervalMs` (default 1500ms) is throttling, not rate limiting; a leaked secret
  still allows high-rate session creation.

## KI-6 Consequences of a missing, mismatched or leaked shared secret (High)

- **Symptoms and matching behaviour**: the DSH side cannot read the secret → `503`; secret mismatch →
  `401`; the hook side has no `url`/`secret` → it only writes one log line and **does not forward**
  (`result=unconfigured`).
- **Evidence**: the response table and security boundary in `plugins/dsh-webhook-bridge/README.md`;
  `redact()` in `handler.js` (neither the secret nor a `Bearer …` payload can reach the log).
- **Mitigation**: keep the secret file outside the repository with tight permissions
  (`DSH_BRIDGE_SECRET_FILE`); putting the secret into the process environment (`secretEnv`) is not
  recommended (it leaks through environment snapshots); the DSH side re-reads the secret file on every
  request, which makes rotation easy (the hook side needs a Gateway restart).
- **Warning**: every sample in this repository is a placeholder. `.gitignore` only excludes common file
  names, so run `npm run check` (which includes `scan-repo-hygiene`) before you commit.

## KI-7 Consequences of a missing or over-wide workspace fence (Medium)

- **Symptom**: with `workspaceRoot` set to a drive root or your home directory, any `workspacePath`
  passes; with it set to one narrow directory, every hook forward returns `403`; pointing it at a
  non-existent directory returns `404`.
- **Cause**: the DSH side only checks "inside `workspaceRoot` **and already existing**"
  (case-insensitive on Windows), and it **never creates the directory** for you.
- **Evidence**: the security boundary in `plugins/dsh-webhook-bridge/README.md`;
  `scripts/verify-fence.mjs` (self-contained fence-logic cases); `config/README.md`, which states
  explicitly that there is **no** hook-side `DSH_BRIDGE_WORKSPACE_ROOT` variable.
- **Mitigation**: use a dedicated directory for `workspaceRoot`; set the hook's `workspacePath` to a
  subdirectory of it; run `node scripts/verify-fence.mjs` and
  `pwsh -File scripts/test-bridge.ps1 -NegativeCase` first.

## KI-8 The default `default-skip` drops messages (Medium, by design)

- **Symptom**: casual talk / greetings / thanks / emoji-only / short follow-ups / confirmations
  (**≤ 12 chars by default**) and anything undecidable are not forwarded and create no DSH session; only a
  `decision=skip rule=…` line is left behind.
- **Cause**: this is a deliberate conservative default that fixes the "every WeChat message creates a new
  session" explosion.
- **Evidence**: `decideForward` and `JUDGMENT_CONFIG` in
  `plugins/openclaw-hook-dsh-bridge/handler.js` (`judgment=on`, `defaultDecision=skip`,
  `shortMessageMaxChars=12`, `capabilityMinChars=30`); the rule table in
  `docs/en/hook-judgment.md`.
- **Mitigation (pick one)**: prefix the message with `#dsh `; set
  `DSH_BRIDGE_DEFAULT_DECISION=forward`; or set `DSH_BRIDGE_JUDGMENT=off`. The latter two return to the
  more aggressive forwarding behaviour. Then tighten or loosen using the `rule=` audit log.

## KI-9 `needs_input` can only hand out text (Medium)

- **Symptom**: when DSH waits for a choice, the bridge **immediately** returns
  `state:"needs_input"` with numbered plain-text options (`replyText` such as `1) … 2) …`), but it
  **does not** click for the user and **does not** write the user's "1" back into that DSH turn.
- **Cause**: the echo is not implemented (KI-2); and `@deepseek-ai/dsh-webhook` offers only "create and
  prompt one session", with no API to append a message/answer to an existing session.
- **Evidence**: sections 4 and 3 of `docs/en/session-reuse-and-input.md`; `detectTurnState` in
  `plugins/dsh-webhook-bridge/lib/affinity.mjs`; `formatOptionsText` in `handler.js`.
- **Mitigation**: treat `replyText` as a human to-do item (it is visible in the log); do not treat it as a
  closed interaction loop.

## KI-10 Affinity is not history append (Medium)

- **Symptom**: messages from the same origin inside the window may be **merged into one dispatch**, but
  once the previous turn has **ended**, the next message is a **new session** (log
  `affinity-new-turn`) with no continuous history.
- **Cause**: DSH's `@deepseek-ai/dsh-webhook` (0.1.7-rc.2) only does "create and prompt one root
  Session"; there is no continue/append API.
- **Evidence**: section 3 of `docs/en/session-reuse-and-input.md` (including the upstream README quote);
  `plugins/dsh-webhook-bridge/lib/affinity.mjs`.
- **Mitigation**: enlarging `affinityWindowMs` only widens the "same session boundary" time window; it
  **cannot** resume an ended session. Real continuation needs upstream resume/append, or a bridge that
  goes through the agent/session layer with its own handle (not implemented).

## KI-11 The forwarding rules are heuristic and unobserved (Low, unverified)

- **Symptom**: the thresholds (12 / 30 chars) and the bilingual keyword tables are **heuristics designed
  from observed behaviour**; your wording may not match, producing misses or false positives.
- **Evidence**: "Unverified items" in `docs/en/hook-judgment.md`; the rules are implemented by `PATTERNS`
  in `handler.js`.
- **Mitigation**: review the `rule=` values in `bridge-forward.log` and adjust; do not expect this to be
  equivalent to semantic judgement.

## KI-12 The privacy boundary of the audit log (Medium)

- **Symptom**: each line of `<stateDir>/logs/bridge-forward.log` carries `from=<sender id>`,
  `origin=<conversation key>` and the matched rule; with `DSH_BRIDGE_LOG_BODY=1` it **also carries the
  message body and the full reply text**.
- **Evidence**: `appendForwardLog` in `handler.js`; "Boundaries and risks" in `HOOK.md`; section 5 of
  `docs/en/hook-judgment.md`.
- **Mitigation**: restrict file permissions, rotate and clean it regularly; never commit it to a
  repository or paste it into a public issue; keep `logBody=false` (lengths only) by default.

## KI-13 End-to-end is unverified (Medium, unverified)

- **Unverified list**:
  1. all automated verification is **offline/synthetic** (no network, no real WeChat account, no changes
     to a deployed environment);
  2. there has been **no** real end-to-end run of "WeChat message → DSH → reply text back into WeChat";
  3. `apply` / `revert` have **never** run against a real OpenClaw installation (only synthetic fixtures
     in `%TEMP%`, see `packages/openclaw-weixin-runtime-fix/test/apply-gate-test.ps1`);
  4. for the hook, only host discovery of this package was verified (`test/self-test.mjs`);
     `openclaw plugins install` and a real `message:received` trigger were **not** executed;
  5. the `DataCloneError` field conditions **could not be reproduced** on this machine's Node v24.21.0
     (`structuredClone(process.env)` is cloneable there), so the tests cover the semantics with an
     equivalent synthetic object.
- **Evidence**: §4 of `DELIVERY-t1.md`; "Known limitations and unverified items" in
  `packages/openclaw-weixin-runtime-fix/README.md`; section 6 of `docs/en/session-reuse-and-input.md`.
- **Mitigation**: verify step by step in your own environment using section 6 of `installation.md`, and
  record the results in your deployment notes.

## KI-14 Inherent costs of the runtime fix (Low, by design)

- `apply` recognises **one** structural fingerprint only; if upstream changes the shape of
  `worker.postMessage`, `lib/gen-patch.mjs` **refuses to generate** (exit code 2) instead of corrupting
  the file — at that point the generator must be updated for the new fingerprint.
- After the fix, every dispatch still leaves one `DataCloneError` line in the log (the patch then
  rescues it): diagnostic noise, not a failure.
- Native types (`Map`/`Set`/`Date`/`ArrayBuffer`/`Promise`, …) are not rebuilt; if such a value is itself
  uncloneable the retry fails honestly instead of forging a partial object.
- Values deeper than 12 levels are dropped during sanitisation (returned as `undefined`) to avoid
  unbounded deep copies on the error path.
- Evidence: "Known limitations and unverified items" in `packages/openclaw-weixin-runtime-fix/README.md`.

## KI-15 `DSH_BRIDGE_ECHO_BACK` is a dead switch (Medium)

- **Symptom**: `echoBack` (env var `DSH_BRIDGE_ECHO_BACK`, side-car JSON key `echoBack`) exists in the
  code and docs, but setting it to `1` **sends nothing**.
- **Evidence**: in `handler.js`, `echoBack` appears only in the defaults, the environment mapping and the
  config-file key list (`JUDGMENT_CONFIG.echoBack` / `pickEnvironmentOverrides` / `pickFileOverrides` /
  `resolveConfig`) with **no call site**; `grep spawn` and `grep "message send"` in the same directory
  yield 0 hits.
- **Mitigation**: treat it as a reserved slot; implement the echo yourself per KI-2 and mind the double
  reply risk in KI-3.

## KI-16 The hook shares the Gateway process and is trusted code (Medium, by design)

- **Symptom**: installing a hook means running local code inside the Gateway process (the host prints
  "Hooks are trusted local code." at install time).
- **Evidence**: "Boundaries and risks" in `plugins/openclaw-hook-dsh-bridge/HOOK.md`.
- **Mitigation**: read `handler.js` before installing; install only from this repository or a source you
  trust.

## KI-17 per-hook env is unreliable for `message:received` (Medium)

- **Symptom**: putting `DSH_BRIDGE_*` into `hooks.internal.entries.dsh-bridge.env` may have no effect at
  all.
- **Cause**: that event's context does **not guarantee** a `cfg`, and per-hook `env` does not rewrite
  `process.env`.
- **Evidence**: `readEventHookEnv` and the header comment in `handler.js`; the configuration-source notes
  in `HOOK.md`; the `$comment` in `config/openclaw-hooks.sample.json`.
- **Mitigation**: use Gateway process environment variables or the side-car JSON
  (`<stateDir>/dsh-bridge-hook.json`).

## KI-18 No DSH-side installer, and the repo template does not affect the running bridge (Medium, by design)

- **Symptom**: editing `plugins/dsh-webhook-bridge/cordis.patch.yml` in this repository changes nothing
  at runtime.
- **Cause**: the live configuration is `<profile>/node_modules/dsh-webhook-bridge/cordis.patch.yml`,
  which is a **separate copy** (not a symlink) of the repository file, and this repository ships no
  DSH-side installer.
- **Evidence**: the measurements in §4.5 of `DELIVERY-t7.md`; the copy-location notes in
  `config/README.md`.
- **Mitigation**: always edit the copy inside `<profile>`; treat the repository file as the skeleton and
  the gate baseline.

## KI-19 Multi-fragment messages and the merge window (Low, mitigated)

- **Symptom**: the WeChat client may split one sentence into several fragments, so "one sentence creates
  several sessions".
- **Mitigation**: the hook merges within a quiet window (`coalesceMs=1500ms`, hard cap
  `coalesceMaxMs=5000ms`), and the bridge adds an affinity slot on top.
- **Residual**: fragments beyond the hard cap or across windows are still dispatched separately; the
  exact behaviour depends on your client.
- **Evidence**: the merge state machine in `handler.js`; section 2 of
  `docs/en/session-reuse-and-input.md`.

## KI-20 Bilingual drift (Low, process requirement)

- `docs/zh-CN/` and `docs/en/` are page-for-page equivalents; when you change one page, change its
  counterpart in the same commit and keep section structure, table column counts and identifiers
  (such as KI-2) aligned — otherwise readers end up with two different sets of conclusions.
- Evidence: the page map in this directory's `README.md`.
