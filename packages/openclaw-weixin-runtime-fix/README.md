# openclaw-weixin-runtime-fix

修补 OpenClaw 宿主 `worker-task-pool` 的**结构化克隆失败**，解决微信通道
「消息收得到、回复发不出去」的问题。

> **性质：非受支持改法。** 它修改的是 OpenClaw 发行包内文件（`node_modules/openclaw/dist/worker-task-pool-*.mjs`），
> 不属于 OpenClaw 支持的扩展点。openclaw 每次升级都会覆盖该文件，升级后需要重新 apply。
> 请先读完本文件再决定是否使用。

## 问题

微信通道入站消息能收到、也会进入会话管道，但回复派发失败：

```text
gateway/channels/openclaw-weixin: dispatchReplyFromConfig: error agentId=main
  err=WorkerTaskError: DataCloneError: #<Object> could not be cloned.
gateway/channels/openclaw-weixin/…-im-bot: getUpdates error: WorkerTaskError: DataCloneError: …
```

- 触发点：宿主 `WorkerTaskPoolCore.start` 里的
  `worker.postMessage({ input, taskId, interactive, nativeSections, sampleMemory }, transferList)`。
  `worker.postMessage` 走**结构化克隆**，载荷 `input.request.env` 是一个
  「所有子键都是字符串、但容器本身不可克隆」的对象 → 抛 `DataCloneError`。
- 后果一：`dispatchReplyFromConfig` 失败 → **回复永远发不出去**；
- 后果二：同一次失败把 `getUpdates` 长轮询打断（`(1/3)` 重试）；
- 用户视角：机器人「已在线但不理人」。

磁盘依据（写实现前逐条核对）：

| 依据 | 内容 |
| --- | --- |
| `openclaw/dist/worker-task-pool-*.mjs`（2026.9.7） | 派发点 `worker.postMessage({ input, taskId: task.id, interactive: Boolean(task.options.onRequest), nativeSections: slot.nativeSections.buffer, sampleMemory: true }, transferList)` 的同文件内还有两处 `worker.postMessage`（资源回收、response 投递），并非同一形状 |
| `openclaw/dist/worker-task-pool-*.mjs` 中 `WorkerTaskError` | 同文件内定义（`class extends Error`，第二参数是 kind，如 `"unavailable"`），注入代码沿用它构造失败对象 |
| DSH 报告 `reports/openclaw-weixin-dataclone-issue.md`（工作区 `D:\DS`，仓库外） | 运行时诊断输出 `$.request.env … container-all-children-cloneable`、`[FIX-CLONE] 净化重试成功` 等实测证据 |

## 本包做什么

```text
lib/clone-sanitize.mjs   注入源码本体（analyzeCloneRejection / describeCloneShape /
                         sanitizeForClone / cloneRetrySanitized / readCtorName），
                         同时可作为普通模块被自测 import
lib/gen-patch.mjs        补丁生成器：只认一个结构指纹，找不到就拒绝生成（不猜）
lib/targets.mjs          只读发现本机所有 worker-task-pool-*.mjs 副本及其补丁状态
scripts/patch-worker-pool.ps1  apply / revert / status（apply 带语法门禁 + 结构门禁）
scripts/apply.ps1              -Action apply 的薄包装
scripts/revert.ps1             -Action revert 的薄包装
test/verify-clone-fix.mjs      语义 + 生成器 + CLI 自测（不联网、不需要 openclaw）
test/apply-gate-test.ps1       apply/revert 门禁自测（全程在 %TEMP% 的合成夹具副本上）
test/fixtures/…                合成夹具（复刻派发点结构指纹，不是任何真实发行包文件）
```

补丁做两件事：

1. **诊断**：克隆失败时用 `analyzeCloneRejection` 报出首个不可克隆字段的路径
   （`[DIAG-CLONE] path=… shape=…`），而不是只留下 `#<Object>`；
2. **救援**：先尝试「去掉 `transferList`」这条更轻的路径；不行再把
   「看似普通对象却不可克隆」的值递归重建为普通副本后重试一次
   （`[FIX-CLONE] 净化重试成功…`）。

## 用法

```bash
# 0) 先看清本机有哪几份副本、哪份已打补丁（只读）
node lib/targets.mjs
pwsh -NoProfile -File scripts/patch-worker-pool.ps1 -Action status

# 1) 空跑：生成 + 过门禁，但不覆盖任何文件
pwsh -NoProfile -File scripts/apply.ps1 -DryRun

# 2) 正式打补丁（多份副本时必须用 -DistPath 指明 Gateway 实际使用的那一份）
pwsh -NoProfile -File scripts/apply.ps1 -DistPath "<openclaw>\dist\worker-task-pool-XXXX.mjs"

# 3) 让补丁生效
pwsh -NoProfile -File scripts/apply.ps1 -RestartGateway      # 或手动 openclaw gateway restart
```

`-Action apply` 的顺序是：

```text
（无备份则先不改动任何文件）
  读取目标 → 生成候选到 %TEMP%   ← 生成失败/指纹缺失 → 直接失败，目标文件不变
            → 语法门禁 node --input-type=module --check ← 不通过 → 直接失败，目标文件不变
            → 结构门禁（注入标记 1 处 / 重试函数 3 处）
            → 备份 <目标>.orig-bak（若尚不存在）
            → 覆盖目标文件
```

任何一步失败都**不会**写目标文件，也不会留下备份或候选残留。

## 回滚说明（revert）

```bash
# 从备份还原（还原前会校验备份未被污染，并对备份做一次语法门禁）
pwsh -NoProfile -File scripts/revert.ps1 -DistPath "<openclaw>\dist\worker-task-pool-XXXX.mjs"

# 只想看看会不会还原成功
pwsh -NoProfile -File scripts/revert.ps1 -DryRun
```

手动回滚（等价、不依赖本包脚本）：

```powershell
$target = "<openclaw>\dist\worker-task-pool-XXXX.mjs"
Copy-Item "$target.orig-bak" $target -Force     # 备份就是打补丁前的原文件
Get-Content $target -Raw | node --input-type=module --check   # 语法自检
openclaw gateway restart                        # 让还原生效
```

回滚要点：

- 备份文件名固定为 `<目标文件>.orig-bak`，内容是**打补丁前的原文件**（不落补丁标记）；
- `apply` 会拒绝在「备份已含补丁标记」时继续，避免把补丁当原件备份；
- openclaw 升级会覆盖 `worker-task-pool-*.mjs`，此时补丁自动失效；如果升级把
  `<目标>.orig-bak` 留在了磁盘上，它仍是升级前那一版的原件，**不要**把它拷回去覆盖新版
  （版本不一致），直接删掉即可；
- 如果 `<目标>.orig-bak` 丢了：`npm install -g openclaw`（或重装当前版本）即可拿回原文件。

## 自测

```bash
node test/verify-clone-fix.mjs          # 语义 + 生成器 + CLI + 语法门禁 + 可选的真实文件检查
pwsh -NoProfile -File test/apply-gate-test.ps1   # apply/revert 门禁（合成夹具，全程在 %TEMP%）
```

- `verify-clone-fix.mjs` 不联网、不需要 openclaw、不读任何真实配置；若本机确实存在
  worker-task-pool 副本，会额外对**真实原文件**跑一次「生成 + 语法门禁」（只读 + 写临时目录），
  不存在则打印 SKIP，不算失败。
- `apply-gate-test.ps1` 的一切读写都在 `%TEMP%` 下的临时目录里完成。

## 已知限制与未验证项

- **未验证（本机环境）**：本包自测在 Node v24.21.0 上观测到
  `structuredClone(process.env)` **可克隆**，因此「env 不可克隆」这一现场条件在本机无法复现；
  自测改用**等价合成对象**（Proxy + 空白构造器名，复现 `$.request.env … container-all-cloneable`
  这条诊断）来覆盖语义。端到端效果（微信真的能收到回复）来自工作区报告
  `reports/openclaw-weixin-dataclone-issue.md` 的实测记录，本包**没有**重新做端到端验证。
- **未验证**：`apply`/`revert` 只在 `%TEMP%` 的合成夹具上端到端跑过，**没有**对真实 openclaw
  安装执行（那属于改动已部署环境，需另行确认）。
- 修复后每次派发仍会先在日志留下一次 `DataCloneError`（补丁随即救援成功），属诊断噪声；
  根治需上游消除 `request.env` 的跨线程传递，或改为在派发前净化。
- 补丁只针对当前派发点形状。上游改结构时 `gen-patch.mjs` 会**拒绝生成**（退出码 2），
  不会改坏文件；此时需要按新的指纹更新 `lib/gen-patch.mjs`。
- 原生类型（`Map`/`Set`/`Date`/`ArrayBuffer`/`Promise` 等，见
  `CLONE_PRESERVE_CTOR_NAMES`）不会被重建：若它们自身不可克隆（例如 `Map` 里放了函数），
  重试会如失败并如实抛错，而不是伪造残缺对象。
- 超过 12 层深度的值在净化时会被丢弃（返回 `undefined`），以避免异常路径上的无限代价深拷贝。
