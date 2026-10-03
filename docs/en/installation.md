# Installation and configuration (English)

This page walks through a from-scratch deployment in three steps (DSH side → OpenClaw side → optional
runtime fix), plus upgrade, uninstall, rollback and a security checklist. **Every value is a
placeholder**; replace it with your own value and never commit real values to any repository.

## 1. Prerequisites and support matrix

| Item | Requirement | Evidence |
| --- | --- | --- |
| DSH (DeepSeek Harness) | **0.1.7-rc.2** | `plugins/dsh-webhook-bridge/package.json` `peerDependencies`: `@deepseek-ai/dsh-webhook: 0.1.7-rc.2`, `@deepseek-ai/cordis: ~4.0.4`; the runtime capability boundary of `@deepseek-ai/dsh-webhook` 0.1.7-rc.2 is documented in `session-reuse-and-input.md` |
| DSH services | `webServer` and `webhookRuntime` must be available | `inject = ["webServer", "webhookRuntime"]` in `plugins/dsh-webhook-bridge/lib/index.js` |
| OpenClaw | **2026.9.7** | hook manifest rules, event keys and the `Reply delivery` boundary were all verified against that version's on-disk `docs/automation/hooks/*` and `dist/*` (see the "disk evidence" table in `plugins/openclaw-hook-dsh-bridge/README.md`) |
| WeChat channel | the OpenClaw WeChat channel plugin (verified locally against `@tencent-weixin/openclaw-weixin`); default channel id `openclaw-weixin` | `DEFAULT_CHANNELS` in `plugins/openclaw-hook-dsh-bridge/handler.js`; KI-2 in `known-issues.md` cites that plugin's `dist/src/messaging/inbound.js` and `dist/src/api/api.js` |
| Node.js | **≥ 22.13.0** | `engines.node` in all four `package.json` files |
| PowerShell | 7+ (`pwsh`), needed only by the runtime fix package and the smoke-test script | `test:gate` in `package.json`; `packages/openclaw-weixin-runtime-fix/scripts/*.ps1` |
| Operating system | verified on Windows; the hook and the DSH plugin themselves are plain Node/HTTP logic, but the scripts use Windows path forms and `pwsh` | `scripts/*.ps1`, `packages/openclaw-weixin-runtime-fix/scripts/*.ps1` |

> Version policy: these are the versions **this repository was verified against**, not a compatibility
> promise. After a version change, hook conventions, event keys and `openclaw.hooks` manifest rules may
> all differ — re-check against the disk-evidence table in `plugins/openclaw-hook-dsh-bridge/README.md`.

## 2. Step 0: prepare a shared secret (outside the repository)

Both sides must use **the same** secret:

```powershell
# Generate a random secret and write it to a file outside the repository (example path, use your own)
$dir = Join-Path $env:USERPROFILE '.dsh'
New-Item -ItemType Directory -Force $dir | Out-Null
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 })) |
  Set-Content (Join-Path $dir 'bridge-secret.txt') -NoNewline
```

Point the environment variable at it (the DSH side prefers this):

```powershell
$env:DSH_BRIDGE_SECRET_FILE = Join-Path $env:USERPROFILE '.dsh\bridge-secret.txt'
```

**Do not** put the secret into repository files: `.gitignore` only excludes common file names such as
`dsh-bridge-hook.json`, `bridge-secret.txt` and `config/*.local.*`, and it cannot protect you from a
value you pasted into a tracked file. The repo ships `node scripts/scan-repo-hygiene.mjs` as a
backstop (see section 6).

## 3. Step 1: DSH side (`dsh-webhook-bridge`)

1. Install `plugins/dsh-webhook-bridge/` into your DSH profile (so it appears at
   `<profile>/node_modules/dsh-webhook-bridge/`) and make sure `@deepseek-ai/dsh-webhook` is loaded —
   it is what provides `ctx.webhookRuntime`. This repository **does not ship** an installer for the
   DSH-side plugin; use your profile's own mechanism (package manager or copy).
2. Edit the configuration that is **actually loaded at runtime**:
   `<profile>/node_modules/dsh-webhook-bridge/cordis.patch.yml`.
   The file in this repository (`plugins/dsh-webhook-bridge/cordis.patch.yml`) is an **in-package
   template**; editing it does not affect a deployed bridge (they are separate copies, not symlinks).
   You can start from the placeholder sample `config/dsh-webhook-bridge.patch.sample.yml` (its key names
   and order intentionally match the template; `node scripts/check-config-samples.mjs` compares the skeleton).
3. Keys you must replace: `path`, `source`, `workspaceRoot`, and the secret source (one of the
   `DSH_BRIDGE_SECRET_FILE` environment variable / `secretFile` / `secretEnv`).
4. Keys you should decide at the same time:
   - `allowSenders`: empty means **sender is not checked**; filling it in makes the hook's `from` value
     an exact match requirement (mismatch returns 403).
   - `permissionPreset`: `workspace-write` is both the default and the recommendation;
     for the risks of `danger-full-access` see KI-5 in `known-issues.md`.
   - `waitTimeoutMs`: default 120000; the hook's `timeoutMs` must be **larger** than it.
5. Restart DSH (or reload your profile) and confirm the route is alive with the smoke test in section 6.

## 4. Step 2: OpenClaw side (hook pack)

```bash
# Copy install (recommended): installs to <stateDir>/hooks/openclaw-hook-dsh-bridge
openclaw plugins install /path/to/repos/dsh-openclaw-weixin-bridge/plugins/openclaw-hook-dsh-bridge --force

# or: link install (adds the package root to hooks.internal.load.extraDirs, no copy)
openclaw plugins install -l /path/to/repos/dsh-openclaw-weixin-bridge/plugins/openclaw-hook-dsh-bridge

openclaw hooks info dsh-bridge      # confirm discovery: name / events / handler / blocking reason
openclaw hooks enable dsh-bridge    # writes hooks.internal.entries.dsh-bridge.enabled = true
```

Configuration precedence (later overrides earlier, per `resolveConfig` in `handler.js`):
defaults < side-car JSON < Gateway process env (`DSH_BRIDGE_*`) < per-hook env in the event.

For `message:received`, the **reliable sources are the Gateway process environment or the side-car
JSON**: that event's context does not guarantee a `cfg`, and per-hook `env` does not rewrite
`process.env` (evidence: the notes in `plugins/openclaw-hook-dsh-bridge/HOOK.md`).

Recommended: copy `config/dsh-bridge-hook.sample.json` outside the repository (default location
`<stateDir>/dsh-bridge-hook.json`, overridable with `DSH_BRIDGE_HOOK_CONFIG`), replace the placeholders
and tighten file permissions. Minimal working configuration:

```json
{
  "url": "http://127.0.0.1:<DSH_WEB_PORT>/openclaw-wechat",
  "secret": "<DSH_BRIDGE_SECRET>",
  "workspacePath": "<workspace-root>",
  "channels": ["openclaw-weixin"]
}
```

After changing `handler.js`, `HOOK.md` or the configuration you must **restart the Gateway** (hook code
and metadata are not hot-reloaded).

## 5. Step 3 (optional): WeChat channel runtime fix

Use this only when messages arrive but no reply goes out and the log shows a `DataCloneError`.
This is an **unsupported modification** (it edits files inside the shipped OpenClaw package) and it is
lost on every upgrade.

```bash
# read-only: list the copies on this machine and which one is patched
node packages/openclaw-weixin-runtime-fix/lib/targets.mjs
pwsh -NoProfile -File packages/openclaw-weixin-runtime-fix/scripts/patch-worker-pool.ps1 -Action status

# dry run: generate and pass the gates without overwriting anything
pwsh -NoProfile -File packages/openclaw-weixin-runtime-fix/scripts/apply.ps1 -DryRun

# real patch (with multiple copies you must point -DistPath at the one the Gateway actually loads)
pwsh -NoProfile -File packages/openclaw-weixin-runtime-fix/scripts/apply.ps1 -DistPath "<openclaw>\dist\worker-task-pool-XXXX.mjs" -RestartGateway
```

Rollback notes and unverified items: see "Rollback" and "Known limitations and unverified items" in
`packages/openclaw-weixin-runtime-fix/README.md`.

## 6. Verification

### 6.1 Inside the repository (offline; no network, no real WeChat account)

```bash
npm run check               # syntax + config samples + sensitive content
npm run test:hook-handler   # hook behaviour tests
npm run test:hook           # hook pack contract + host discovery + empty-host safety
npm run test:fix            # runtime fix package tests
npm run test:gate           # apply/revert gates (entirely in %TEMP%)
npm test                    # runs all of the above in order
```

Assertion counts are whatever the scripts print.

### 6.2 DSH-side smoke test (needs DSH running and the secret file present)

```powershell
pwsh -NoProfile -File scripts/test-bridge.ps1 -NegativeCase   # negative: wrong secret must be 401
pwsh -NoProfile -File scripts/test-bridge.ps1                 # positive: expect 202 with a sessionId
pwsh -NoProfile -File scripts/test-bridge.ps1 -Wait           # wait synchronously for the reply text
```

### 6.3 Real side-effect check (needs a real WeChat account)

1. Send the bot a message that **will be forwarded** (e.g. starting with `#dsh ` so the default
   `default-skip` does not drop it);
2. the Gateway log should show `[dsh-bridge] 已转发 channel=openclaw-weixin status=202 sessionId=…`;
3. a new session should appear on the DSH side with that message as its prompt;
4. the audit log `<stateDir>/logs/bridge-forward.log` should contain the matching
   `decision=forward rule=…` line.

## 7. Upgrade, uninstall and rollback

| Scenario | Action |
| --- | --- |
| Changed hook code/metadata | re-run `openclaw plugins install … --force` (or edit the files in the linked directory) → **restart the Gateway** |
| Uninstall the hook | `openclaw plugins uninstall openclaw-hook-dsh-bridge` (or remove it from `hooks.internal.load.extraDirs`) → restart the Gateway |
| Disable without uninstalling | `openclaw hooks disable dsh-bridge`; or a temporary bypass as in `config/stopgap-disable-hook.patch.json5` |
| After an OpenClaw upgrade | the runtime-fix patch **is always lost** (shipped files are overwritten); re-apply per section 5, or skip the fix (see KI-1 / KI-14) |
| Roll back the runtime fix | `pwsh -NoProfile -File packages/openclaw-weixin-runtime-fix/scripts/revert.ps1 -DistPath "<openclaw>\dist\worker-task-pool-XXXX.mjs"` → restart the Gateway; the backup name is always `<target>.orig-bak` |
| Rotate the shared secret | replace the secret file's content; the DSH side **re-reads the file on every request**, the hook side needs a Gateway restart |

## 8. Security checklist (tick every line before deploying)

1. Both sides use the same secret, and the secret file lives outside the repository with minimal permissions.
2. `DSH_BRIDGE_URL` points only at an address you trust (the hook POSTs message bodies to it).
3. `workspaceRoot` is a **dedicated** directory — never a drive root or your home directory; the request's
   `workspacePath` must be inside it and must already exist (outside → 403, missing → 404, and DSH never
   creates the directory for you).
4. Fill `allowSenders` with concrete values (empty means no check).
5. Use `permissionPreset: workspace-write`; only pick `danger-full-access` if you explicitly accept the
   consequences.
6. The audit log `bridge-forward.log` contains sender identifiers and conversation keys (but no message
   bodies unless `DSH_BRIDGE_LOG_BODY=1`): restrict permissions, rotate it, and never commit it or paste
   it into a public issue.
7. Before publishing, run `npm run check` (which includes `scan-repo-hygiene`) and confirm that no real
   secret, account id or machine path has entered the repository.
