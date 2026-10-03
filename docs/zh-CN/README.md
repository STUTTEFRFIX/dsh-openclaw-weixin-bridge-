# 文档索引（中文）

本目录是 `dsh-openclaw-weixin-bridge` 的中文技术文档。英文对应页在 `../en/`，
两套内容**逐页对应**（见下方对照表）。

## 先读哪一篇

| 你是谁 | 建议顺序 |
| --- | --- |
| 第一次听说这个项目 | 根 [README](../../README.md) → 本文 → `installation.md` → `known-issues.md` |
| 要把它装到自己机器上 | `installation.md`（含 DSH 侧、OpenClaw 侧、密钥与围栏） → 根 README 的「校验」 |
| 要审核代码/文档是否可信 | `architecture.md`（组件与契约） → `known-issues.md`（每条都有文件/命令依据） |
| 被「消息被跳过 / 收不到回复」困扰 | `hook-judgment.md`（判断规则） → `session-reuse-and-input.md`（会话与 needs_input） → `known-issues.md` |
| 只在看英文 | `../en/README.md`，结构与本文一一对应 |

## 页面对照表

| 中文 | 英文 | 内容 |
| --- | --- | --- |
| `README.md`（本文） | `docs/en/README.md` | 文档索引与阅读顺序 |
| `architecture.md` | `docs/en/architecture.md` | 项目定位、组件、数据流、HTTP 契约、配置面、校验映射 |
| `installation.md` | `docs/en/installation.md` | 前置与支持矩阵、三侧安装步骤、密钥与围栏配置、升级/卸载/回滚 |
| `known-issues.md` | `docs/en/known-issues.md` | **已知问题与警告**（独立章节，必须读） |
| `hook-judgment.md` | `docs/en/hook-judgment.md` | 入站消息转发判断（哪些转发、哪些跳过、怎么覆盖、怎么审计） |
| `session-reuse-and-input.md` | `docs/en/session-reuse-and-input.md` | 会话亲和、多段合并、`completed / needs_input / aborted` 三态回传 |

## 写作口径（本文档集遵守的规则）

1. **每条能力声明都必须能落到仓库内某个文件或某条命令**：正文里给出相对路径或可直接执行的命令；
   实现代码在 `plugins/`、`packages/`，校验命令见根 `README.md` 的「校验」与 `../package.json`。
2. **不描述未实现的功能**：做不到的部分集中写在 `known-issues.md` 与根 README 的「不能做什么」。
3. **只用占位符**：`<DSH_BRIDGE_SECRET>`、`<stateDir>`、`<openclaw>`、`<profile>`、
   `<workspace-root>`、`http://127.0.0.1:<DSH_WEB_PORT>/openclaw-wechat`；
   文档中**不含**任何真实密钥、token、账号 id 或内网地址。
4. **未验证的事写明未验证**：见 `known-issues.md` 中带「未验证」标记的条目。
