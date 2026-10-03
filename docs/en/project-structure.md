# Project Structure

> For **maintainers taking over**: what each directory and file does, its status,
> and where to make changes. Chinese version: [`PROJECT-STRUCTURE.md`](PROJECT-STRUCTURE.md).

## Architecture in one picture

```text
WeChat App ⇄ OpenClaw Gateway (openclaw-weixin channel)
              │ message:received
              ▼
      plugins/openclaw-hook-dsh-bridge/     ← OpenClaw side: judge + coalesce + forward
              │ POST /openclaw-wechat (shared secret)
              ▼
      plugins/dsh-webhook-bridge/           ← DSH side: verify + create session + deliver prompt
              │
              ▼
      A new DSH workspace session (cwd = configured workspace)
```

## Top-level files

| Path | Purpose | Status |
| --- | --- | --- |
| `README.md` | Chinese overview (positioning, can/cannot do, quick start, status, license) | Delivered |
| `README.en.md` | English overview (mirrors the Chinese one) | Delivered |
| `STATUS.md` | Maintainer view: status, release procedure (**must use `git archive`**), gate semantics | Delivered |
| `PROJECT-STRUCTURE.md` | This file: structure navigation | Delivered |
| `LICENSE` | MIT | Delivered |
| `NOTICE` | Copyright + "mark your modifications" project convention (explicitly not an MIT condition) + third-party components + disclaimer | Delivered |
| `deploy.ps1` / `deploy.sh` | One-command deployment (idempotent; `-DryRun`/`--dry-run`, `-Uninstall`/`--uninstall`) | Delivered |
| `package.json` | npm script entry points (`npm test`, `npm run check`, …) | Delivered |
| `.gitignore` | Excludes secrets, `*.local.*`, internal process notes | Delivered |

## Directories

### `plugins/` — one plugin per host

| Path | Purpose | Status |
| --- | --- | --- |
| `plugins/dsh-webhook-bridge/` | **DSH-side Cordis plugin.** `lib/index.js` registers the shared-secret-protected exact POST route; `lib/affinity.mjs` implements session affinity (merge within window, immediate `needs_input`); `cordis.patch.yml` is the bundle layer | Implemented |
| `plugins/openclaw-hook-dsh-bridge/` | **OpenClaw-side hook pack.** `handler.js` subscribes to `message:received`/`message:sent`; `HOOK.md` is the manifest the host reads (with the config table); `test-handler.mjs` holds assertions | Implemented |

### `packages/` — runtime fix (usable standalone)

| Path | Purpose | Status |
| --- | --- | --- |
| `packages/openclaw-weixin-runtime-fix/` | Patches OpenClaw's `worker-task-pool` structured-clone failure (`DataCloneError`) that causes "messages arrive but replies never leave". Contains the patch generator, `apply`/`revert` scripts, gated tests and fixtures | Implemented (**unsupported patch, lost on upgrade**) |

### `config/` — configuration samples (placeholders only)

| Path | Purpose |
| --- | --- |
| `config/dsh-webhook-bridge.patch.sample.yml` | DSH-side Cordis snippet sample |
| `config/openclaw-hooks.sample.json` | OpenClaw `hooks.internal` snippet sample |
| `config/dsh-bridge-hook.sample.json` | Sidecar hook config sample (URL / secret source) |
| `config/deploy-extraDirs.patch.json5` | extraDirs snippet used by `deploy.*` |
| `config/stopgap-disable-hook.patch.json5` | Stopgap snippet: explicitly disable the hook |
| `config/*.local.*` | **Real machine values, gitignored, never committed** |

### `scripts/` — gates and integration helpers

| Path | Purpose |
| --- | --- |
| `scripts/check-syntax.mjs` | Repo-wide JS syntax gate (`node --check`) |
| `scripts/check-config-samples.mjs` | Config sample parsing + machine-path gate |
| `scripts/scan-repo-hygiene.mjs` | **Repo-level sensitivity gate**: controlled files + every `.git` history object (if git is unavailable while packs exist it fails instead of falsely reporting clean) |
| `scripts/test-scan-repo-hygiene.mjs` | Negative self-test for the gate (`npm run test:hygiene`) |
| `scripts/check-docs.mjs` | Docs gate: relative links, code-block languages, heading levels, table columns, bilingual parity, sensitive tokens |
| `scripts/inspect-session.mjs` / `list-sessions.mjs` / `read-reply.mjs` | DSH session-log tooling (frame-by-frame decompression, listing, reading replies) |
| `scripts/test-bridge.ps1` / `verify-fence.mjs` | Bridge smoke test and workspace-fence self-test |

### `docs/` — user documentation (page-for-page bilingual)

| Page | Content |
| --- | --- |
| `README.md` | Documentation index (with a page mapping table) |
| `architecture.md` | Architecture and data flow |
| `installation.md` | Installation and configuration steps |
| `known-issues.md` | **Known issues and warnings (KI-1…KI-20)** |
| `hook-judgment.md` | Forwarding rules (default `skip` and how to override) |
| `session-reuse-and-input.md` | Session affinity and `needs_input` replies |

## Renaming / migration notes

- Keep standard extensions: source `.mjs`/`.js`, config `.json`/`.json5`/`.yml`,
  scripts `.ps1`/`.sh`, docs `.md`.
- Any **machine-specific value** (username, absolute path, secret) belongs in
  `config/*.local.*` (ignored). Controlled files may only contain placeholders —
  `npm run check:hygiene` enforces this.
