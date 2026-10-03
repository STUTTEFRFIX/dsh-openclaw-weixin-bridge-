# dsh-openclaw-weixin-bridge

> Bridge **WeChat (via the OpenClaw Weixin channel)** to **DSH (DeepSeek Harness)**:
> messages received in WeChat are handed to DSH, and each round is carried by a DSH session.
>
> **Status: TESTING.** See [STATUS.md](STATUS.md) and
> [docs/en/known-issues.md](docs/en/known-issues.md) before deploying.
> 中文版见 [README.md](README.md)。

## What it does

- Receives inbound WeChat direct messages through OpenClaw's `openclaw-weixin` channel.
- Decides — at the **channel layer**, without asking a model — whether a message is a
  task that needs DSH's local abilities (files, commands, multi-step work).
  Chit-chat, greetings and follow-up questions are skipped by default.
- Coalesces multiple fragments of one message, then POSTs to a
  shared-secret-protected endpoint.
- The DSH side creates a new workspace session, delivers the text as the prompt, and can
  wait for the round to finish and return the reply.

## What it does NOT do

1. It does not build or bundle OpenClaw or DSH — you must install both.
2. It does not send DSH replies back to WeChat **yet**: `DSH_BRIDGE_ECHO_BACK` is a
   **reserved switch that is not consumed**, because the official hook API treats
   hook-returned messages as "ignored as replies".
3. It does not guarantee reply delivery: WeChat outbound needs the conversation
   `contextToken`, which `message:received` does not carry.
4. It is not a supported OpenClaw extension: the runtime fix patches `node_modules`
   and is **lost on every OpenClaw upgrade**.
5. It does not compile anything — this is plain Node ESM source.

## Supported matrix

| Component | Verified with | Source of truth |
| --- | --- | --- |
| DSH | 0.1.7-rc.2 | `plugins/dsh-webhook-bridge/package.json` peer deps |
| OpenClaw | 2026.9.7 | hook pack manifest + `internal-hook-types` event keys |
| Node.js | ≥ 22.13 | `package.json` engines |
| Shell (deploy) | PowerShell 7+ / bash | `deploy.ps1`, `deploy.sh` |

## Quick start

```bash
# 0. Prerequisites: OpenClaw and DSH already installed and running.
# 1. Clone
git clone https://github.com/STUTTEFRFIX/dsh-openclaw-weixin-bridge.git
cd dsh-openclaw-weixin-bridge

# 2. Verify the checkout (no build step needed)
npm test

# 3. Deploy the OpenClaw hook pack (idempotent; -DryRun / --dry-run to preview)
pwsh -File .\deploy.ps1          # Windows
./deploy.sh                      # Linux / macOS / WSL
```

Then supply `DSH_BRIDGE_URL` and `DSH_BRIDGE_SECRET` (environment or the sidecar
file `~/.openclaw/dsh-bridge-hook.json`), install the DSH-side Cordis plugin
(snippet in `config/dsh-webhook-bridge.patch.sample.yml`), and restart OpenClaw.

Detailed steps: [docs/en/installation.md](docs/en/installation.md).

## Repository layout

```
README.md / README.en.md      bilingual overview (this file)
STATUS.md                     testing status + release rules (use `git archive`)
PROJECT-STRUCTURE.md          per-file structure guide (zh) / docs/en/project-structure.md
deploy.ps1 / deploy.sh        one-command deployment
NOTICE                        copyright + "mark your modifications" convention
plugins/                      dsh-webhook-bridge (DSH) / openclaw-hook-dsh-bridge (OpenClaw)
packages/                     openclaw-weixin-runtime-fix (unsupported local patch)
config/                       placeholder samples (*.local.* are gitignored)
scripts/                      syntax, config, hygiene and docs gates + session tooling
docs/zh-CN/, docs/en/         user documentation, page-for-page bilingual
```

Full detail: [docs/en/project-structure.md](docs/en/project-structure.md).

## Security

- **Shared secret** on the bridge route (constant-time comparison); missing or
  mismatched secrets fail closed (503/401).
- **Workspace fencing**: a requested `workspacePath` must be inside the configured
  root, otherwise 403; a missing directory returns 404 rather than being created.
- **Permission preset** defaults to `workspace-write`; `danger-full-access` is
  possible but strongly discouraged.
- **Self-loop protection**: outbound messages are recorded in a bounded marker ring
  so the hook never forwards its own replies back into DSH.
- **Sensitivity gate**: `npm run check:hygiene` scans tracked files *and* every git
  history object; a machine path or real account id fails the check.

## Known issues and warnings

Twenty tracked items live in [docs/en/known-issues.md](docs/en/known-issues.md)
(Chinese: [docs/zh-CN/known-issues.md](docs/zh-CN/known-issues.md)). Highlights:

- The runtime fix is lost on every OpenClaw upgrade → re-apply after upgrading.
- Reply delivery is unreliable because of the WeChat `contextToken` limitation.
- Double replies are possible while OpenClaw's own agent is still enabled.
- DSH workspace `AGENTS.md` protocol can turn chit-chat into a clarification request.

## License

MIT — see [LICENSE](LICENSE). Commercial use and modification are permitted.

The maintainer additionally *asks* (as a project convention, **not** an extra
condition of the MIT License) that modified versions state that they are modified
and indicate what changed. Details in [NOTICE](NOTICE).
