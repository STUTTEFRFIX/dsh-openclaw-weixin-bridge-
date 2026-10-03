# STATUS —— 仓库状态与发布方式

> 本文件给**维护者/发布者**看：仓库当前处于什么状态、怎么验证、以及**发布时必须怎么导出**。
> 面向使用者/部署者的文档在 `docs/zh-CN/` 与 `docs/en/`。

## 发布方式（硬规则）

**发布/归档一律用 `git archive` 导出，绝不直接打包或复制工作目录。**

```bash
# 正确：只导出「已提交的内容」，天然不含被 .gitignore 排除的本地文件
git archive --format=zip -o dsh-openclaw-weixin-bridge-<version>.zip HEAD
# 或者打到目录
git archive HEAD | tar -x -C /path/to/export
```

理由（**必须遵守**）：工作目录里含 `.gitignore` 排除的 `config/*.local.*`（例如
`config/dsh-webhook-bridge.patch.local.yml`、`config/deploy-extraDirs.patch.local.json5`），
它们是**本机真实值**（密钥文件绝对路径、本机工作区根等）。直接压缩/复制工作目录会把这些
机器专属路径一起发出去；`git archive` 只取已跟踪内容，从根上避免该泄漏。

发布前依次执行：

```bash
npm run check           # 语法 + config 样例 + 仓库级敏感内容扫描 + 文档门禁
npm run check:hygiene   # 只跑敏感内容扫描（受控文件 + .git 历史对象全量）
npm run test:hygiene    # 敏感内容门禁的负例自测（临时仓库里复现「泄漏对象被 git gc 打包」）
npm test                # 完整测试链
git archive --format=zip -o dist.zip HEAD
```

## 敏感内容门禁（发布前必须为「真实敏感命中 0」）

`scripts/scan-repo-hygiene.mjs` 扫描两类位置：

| 位置 | 口径 |
| --- | --- |
| 「将要提交/发布」的文件 | `git ls-files --cached --others --exclude-standard`（已跟踪 + 未跟踪未忽略），`*.local.*` 豁免 |
| `.git` 历史对象 | **逐对象**扫描：`git cat-file --batch-all-objects --batch`（能解开 pack）。若 git 不可用且存在 pack → **直接判失败并报告「历史无法验证」**，绝不假报干净 |

判定分级：`placeholder`（如 `user-placeholder@im.wechat`、`C:\Users\<用户名>`）只提示；`real`
（真实账号 id / 真实用户名路径 / `sk-…` / `Bearer <长载荷>` / JWT）即失败（exit 1）。

## 当前状态（最近一次校验）

- 门禁与测试（本机 PowerShell，Node v24.x）：`npm run check` exit 0、`npm test` exit 0、
  `npm run test:hygiene` `7 passed, 0 failed`。
- 断言条数以脚本输出为准：`test-handler.mjs`、`test/self-test.mjs`、
  `packages/openclaw-weixin-runtime-fix/test/verify-clone-fix.mjs`、
  `test/apply-gate-test.ps1`。
- 版本依据：OpenClaw **2026.9.7**（hook 契约按磁盘上的 docs 与 dist 代码核对）、
  DSH **0.1.7-rc.2**、Node ≥ 22.13。
- 未解决/未验证项见 `docs/zh-CN/known-issues.md`（英文对应页 `docs/en/known-issues.md`），
  其中最重要的是：**DSH 的结果目前不会回到微信**（本仓库不伪造回复投递）。

## 内部交付记录

逐轮（t1/t3/t6/t7/t9…）的交付说明、验证命令与未验证项清单**不放在本仓库**（避免把内部
审核过程与机器信息带进公开仓库），由 captain 保留在仓库外：`D:\DS\reports\dsh-weixin-bridge-internal\`。
