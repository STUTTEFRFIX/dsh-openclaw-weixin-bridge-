# Documentation index (English)

This directory holds the English technical documentation for `dsh-openclaw-weixin-bridge`.
The Chinese pages live in `../zh-CN/`; the two sets are **page-for-page equivalents**
(see the table below).

## Where to start

| Who you are | Suggested order |
| --- | --- |
| First time hearing about this project | root [README](../../README.md) → this page → `installation.md` → `known-issues.md` |
| About to install it on your machine | `installation.md` (DSH side, OpenClaw side, secret and fence) → the "Verification" section of the root README |
| Reviewing whether the code/docs can be trusted | `architecture.md` (components and contracts) → `known-issues.md` (every item cites a file or command) |
| Stuck on "messages get skipped / no reply comes back" | `hook-judgment.md` (forwarding rules) → `session-reuse-and-input.md` (sessions and needs_input) → `known-issues.md` |
| Reading Chinese only | `../zh-CN/README.md`, same structure as this page |

## Page map

| Chinese | English | Contents |
| --- | --- | --- |
| `docs/zh-CN/README.md` | `README.md` (this page) | Documentation index and reading order |
| `docs/zh-CN/architecture.md` | `architecture.md` | Positioning, components, data flow, HTTP contract, configuration surfaces, verification map |
| `docs/zh-CN/installation.md` | `installation.md` | Prerequisites and support matrix, install steps for all three parts, secret and fence setup, upgrade/uninstall/rollback |
| `docs/zh-CN/known-issues.md` | `known-issues.md` | **Known issues and warnings** (standalone chapter, must read) |
| `docs/zh-CN/hook-judgment.md` | `hook-judgment.md` | Inbound forwarding rules (what is forwarded, what is skipped, how to override, how to audit) |
| `docs/zh-CN/session-reuse-and-input.md` | `session-reuse-and-input.md` | Session affinity, multi-fragment merging, `completed / needs_input / aborted` receipts |

## Writing rules this documentation set follows

1. **Every capability claim maps to a file or a command inside this repository**: the text gives a
   relative path or a directly runnable command. Implementation lives in `plugins/` and `packages/`;
   verification commands are in the root `README.md` and `../package.json`.
2. **Nothing unimplemented is described as working**: everything that cannot be done is collected in
   `known-issues.md` and in the root README's "What this cannot do".
3. **Placeholders only**: `<DSH_BRIDGE_SECRET>`, `<stateDir>`, `<openclaw>`, `<profile>`,
   `<workspace-root>`, `http://127.0.0.1:<DSH_WEB_PORT>/openclaw-wechat`.
   The docs contain **no** real secrets, tokens, account ids or internal addresses.
4. **Unverified things are labelled unverified**: see the items marked "unverified" in `known-issues.md`.
