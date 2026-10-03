# Architecture and components (English)

This page explains **what the project is, which parts it consists of, how a request flows, what each
part provides**, and which file or command backs every capability claim.

## 1. Positioning

Hand the inbound messages of **WeChat (the OpenClaw WeChat channel)** to **DSH (DeepSeek Harness)**:

```text
WeChat user ──> OpenClaw Gateway (WeChat channel plugin)
                    └─ internal hook (this repository's hook pack)
                           └─ HTTP POST (shared secret) ────> DSH webServer route
                                                                 └─ new Workspace session (prompt = WeChat text)
```

**The direction is one-way: WeChat → DSH.** The reverse direction (sending DSH's reply back to WeChat)
is **not implemented in this repository**; see KI-2 / KI-3 in `known-issues.md` for the reasons and
consequences.

The project consists of three independently installable/removable parts plus three support assets.

## 2. Components

| Part | Location | Role | Shape |
| --- | --- | --- | --- |
| DSH-side bridge plugin | `plugins/dsh-webhook-bridge/` | Registers an exact POST route protected by a shared secret; every request **creates a new Workspace session** via `ctx.webhookRuntime` and delivers the prompt; can optionally wait for the turn to end and return the reply text | Cordis function plugin (`lib/index.js` exports `Config / apply / inject / name`, `inject = ["webServer", "webhookRuntime"]`; composition fragment `cordis.patch.yml`) |
| Affinity and turn-state logic | `plugins/dsh-webhook-bridge/lib/affinity.mjs` | Session affinity slots (origin = `conversationId`, falling back to `sender`), throttling, multi-fragment merging, `detectTurnState` | Pure functions, no I/O, imported directly by the tests |
| OpenClaw hook pack | `plugins/openclaw-hook-dsh-bridge/` | Subscribes to `message:received` (judge → merge → POST) and `message:sent` (outbound marker ring, loop prevention); writes turn states and the `needs_input` text options to the audit log and the return value | hook pack (`package.json` with `openclaw.hooks: ["."]`, `type: module`, no `openclaw.extensions`), handler `handler.js` |
| Runtime fix package | `packages/openclaw-weixin-runtime-fix/` | Patches the structured-clone failure (`DataCloneError`) in OpenClaw's shipped `worker-task-pool-*.mjs` that makes WeChat "receive but never reply"; ships a patch generator, apply/revert, gates and rollback notes | Unsupported modification (edits `node_modules`), see KI-1 in `known-issues.md` |
| Config samples | `config/` | **Placeholder-only** samples for the DSH composition fragment, the OpenClaw hooks fragment and the hook side JSON | Gated by `scripts/check-config-samples.mjs` |
| Repository-wide checks | `scripts/` | Syntax gate, config-sample gate, sensitive-content gate, bridge smoke test, session inspection | Runnable with `node` / `pwsh` |
| Documentation | `docs/zh-CN/`, `docs/en/` | This directory and its Chinese counterpart | Page-for-page equivalents, see `README.md` |

## 3. Data flow (with configuration landing points)

```text
WeChat App
  │
  ▼
OpenClaw Gateway — WeChat channel plugin (verified locally against @tencent-weixin/openclaw-weixin)
  │  event message:received (context: from / content / channelId / metadata / conversationId…)
  ▼
plugins/openclaw-hook-dsh-bridge/handler.js
  │  1) judge via decideForward (order is priority, first hit wins):
  │       explicit prefix #dsh → reply marker [dsh] → outbound marker ring → judgment switch (off = forward)
  │       → small talk / greeting / ack / follow-up (≤12 chars) → capability signals (path/command/keyword/multiline/len≥30)
  │       → default result defaultDecision (skip by default)
  │      every decision is written to bridge-forward.log (decision= / rule=)
  │  2) same-origin fragment merging (coalesceMs=1500ms, hard cap coalesceMaxMs=5000ms)
  │  3) POST <DSH_BRIDGE_URL>
  │     headers: Authorization: Bearer <secret>, content-type: application/json
  │     body:    { text, title?, workspacePath?, sender?, conversationId?,
  │                fragments?, forwardRule?, wait=true }
  ▼
plugins/dsh-webhook-bridge (DSH webServer exact route, default /openclaw-wechat)
  │  secret check (constant-time compare) → content-type/UTF-8/size gates → allow-list → workspace fence
  │  ctx.webhookRuntime.dispatch(...) → affinity slot (affinityWindowMs=900000, minIntervalMs=1500)
  ▼
New DSH Workspace session (prompt = merged WeChat text; permission level = permissionPreset)
  │  turn/end (completed / aborted / error / blocked…) or an unanswered ask_user_question
  ▼
JSON receipt → hook writes the Gateway log ([dsh-bridge] …) and the audit log
  { ok, status, state, kind, sessionId, fragments, forwardRule, replyText, optionCount }
  state ∈ completed / needs_input / aborted / error / blocked / running / accepted / merged
```

Evidence: judging and merging are in `handler.js` (`JUDGMENT_CONFIG` / `decideForward` /
`resolveConfig`); the request body fields are built by `buildPayload` in the same file; the route and
responses are in `plugins/dsh-webhook-bridge/lib/index.js` and the contract table in that package's
`README.md`.

## 4. HTTP contract (DSH side)

| Method/status | Scenario | Body highlights |
| --- | --- | --- |
| `202` | Accepted and the new session was confirmed | `{ status:"accepted", sessionId, requestId, originKey, reused, fragments, workspacePath, title }` |
| `202` | Session affinity window hit (no new session) | `{ status:"merged", reused:true, deferred, sessionId, originKey, fragments }` |
| `200` | `wait:true` and the turn ended | `{ status, state, kind, sessionId, replyText, replies, … }` |
| `200` | `state:"needs_input"` (returns immediately) | additionally carries `questionKind` / `question` / `questionHeader` / `options[]` / `multiSelect`; `replyText` is a numbered plain-text option list |
| `400 / 401 / 403 / 404 / 405 / 413 / 415` | Request rejected (`message` carries no request data) | `{ status:"error", code, message }` |
| `502` | Dispatched but no new session appeared within `confirmTimeoutMs` | as above |
| `503` | Internal error / secret unavailable | as above |
| `504` | `wait:true` but the turn did not end within `waitTimeoutMs` | as above |

Evidence: `plugins/dsh-webhook-bridge/lib/index.js`; item-by-item notes in that package's `README.md`.

## 5. Configuration surfaces (who owns what)

| Side | Carrier | Keys | Documentation |
| --- | --- | --- | --- |
| DSH bridge plugin | `cordis.patch.yml` inside `<profile>` (the live copy) | `path` / `source` / `secretFile` / `secretEnv` / `workspaceRoot` / `permissionPreset` / `agentPreset` / `allowSenders` / `maxBodyBytes` / `confirmTimeoutMs` / `waitTimeoutMs` / `affinityWindowMs` / `minIntervalMs` / `maxFragments` / `maxMergedChars` / `questionTools` / `relay` / `logFile` / `diagnostic` | `plugins/dsh-webhook-bridge/README.md`, `config/dsh-webhook-bridge.patch.sample.yml` |
| hook (OpenClaw side) | defaults < side-car JSON < Gateway process env < per-hook env in the event | `url` / `secret` / `workspacePath` / `channels` / `judgment` / `defaultDecision` / `forwardPrefix` / `replyMarker` / `botIds` / `loopWindowMs` / `coalesceMs` / `maxFragments` / `maxMergedChars` / `wait` / `timeoutMs` / `includeTitle` / `logBody` / `forwardLog` / `configFile` | the config table in `plugins/openclaw-hook-dsh-bridge/HOOK.md` |
| Smoke-test script | Environment | `DSH_BRIDGE_BASE_URL`, `DSH_BRIDGE_SECRET_FILE` | parameter defaults in `scripts/test-bridge.ps1` |

> Easy-to-miss: `minIntervalMs` / `affinityWindowMs` take effect **only on the DSH side**; the hook has
> no such keys. The workspace fence is likewise owned by the DSH-side `workspaceRoot`; there is **no**
> hook-side `DSH_BRIDGE_WORKSPACE_ROOT` variable (evidence: `config/README.md`, and
> `pickEnvironmentOverrides` in `handler.js`).

## 6. Verification map (capability ↔ command)

`npm run check` runs the first four steps below; the other commands are run on demand (defined in the
root `package.json`).

| Command | What it covers | Files involved |
| --- | --- | --- |
| `npm run check` | (1) syntax (2) config samples (3) sensitive content (4) docs | the four below |
| `node scripts/check-syntax.mjs` | every `.js/.mjs/.cjs` in the repo through `node --input-type=module --check` | `scripts/check-syntax.mjs` |
| `node scripts/check-config-samples.mjs` | `config/` JSON parses, YAML key skeleton matches the reference, placeholders only | `scripts/check-config-samples.mjs` |
| `node scripts/scan-repo-hygiene.mjs` | controlled files plus every `.git` object scanned, separating real hits from placeholder hits | `scripts/scan-repo-hygiene.mjs` |
| `node scripts/check-docs.mjs` | documentation gate: relative links exist, every code fence has a language, heading levels do not skip, table columns match, `docs/zh-CN` and `docs/en` are page-for-page pairs, no sensitive identifiers in docs | `scripts/check-docs.mjs` |
| `npm run test:hook-handler` | hook behaviour: judging / prefix / self-loop / coalescing window / needs_input | `plugins/openclaw-hook-dsh-bridge/test-handler.mjs` |
| `npm run test:hook` | hook pack contract + `HOOK.md` + host discovery against the real host + empty-host safety | `plugins/openclaw-hook-dsh-bridge/test/self-test.mjs` |
| `npm run test:fix` | sanitizer semantics + patch generator + `--real/--no-real` switches | `packages/openclaw-weixin-runtime-fix/test/verify-clone-fix.mjs` |
| `npm run test:gate` | apply/revert gates (entirely on synthetic fixture copies in `%TEMP%`) | `packages/openclaw-weixin-runtime-fix/test/apply-gate-test.ps1` |
| `npm test` | runs `check` → `test:hook-handler` → `test:hook` → `test:fix` → `test:gate` | root `package.json` |

Assertion counts are whatever the scripts print; this documentation does not hard-code them.
