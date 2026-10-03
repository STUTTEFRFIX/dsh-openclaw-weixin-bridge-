/**
 * dsh-bridge hook 包自测 —— 在仓库内可直接运行，且断言可复现。
 *
 * 运行：node plugins/openclaw-hook-dsh-bridge/test/self-test.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败。
 *
 * 本文件负责**包契约与宿主可见性**：
 *   - hook pack 清单/目录约定（按 openclaw 2026.9.7 宿主代码复刻为断言）；
 *   - HOOK.md frontmatter；
 *   - handler 导出形态 + 少量行为冒烟（判断/转发/needs_input）；
 *   - 用宿主自己的 discovery 代码实测本包（找不到 openclaw 时打印 SKIP，不算失败）。
 * 行为细节（判断规则、自回环、合并窗口、三态）由 `test-handler.mjs` 全面覆盖。
 *
 * 复现性（对应验收要求「不得依赖未交付的私有状态」）：
 *   - 不联网：HTTP 走注入的假 fetch；
 *   - 不读真实配置：`readFile` 注入（默认抛 ENOENT）；
 *   - 不写真实日志：`appendLog` 注入；
 *   - 不依赖 process.env：环境变量一律显式注入；
 *   - **空宿主环境也必须 exit 0**：找不到 openclaw 时走 SKIP 分支并照常打印汇总
 *     （验证方法见 README：把 USERPROFILE/DSH_WIN_HOME/APPDATA 指向空目录后运行本脚本）。
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join as joinPath, relative, isAbsolute, resolve as resolvePath } from "node:path";
import { homedir } from "node:os";

import handlerModule, {
  EchoRing,
  FragmentCoalescer,
  RULES,
  buildPayload,
  defaultConfigPath,
  extractMessage,
  handleMessage,
  redact,
  resolveConfig,
} from "../handler.js";

const here = dirname(fileURLToPath(import.meta.url));
const packRoot = resolvePath(here, "..");

let passed = 0;
let skipped = 0;
const failures = [];

function check(name, condition, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(`${name}${detail === "" ? "" : ` — ${detail}`}`);
    console.log(`  FAIL  ${name}${detail === "" ? "" : ` — ${detail}`}`);
  }
}

/** 可选断言：环境不具备条件时打印 SKIP，不计入失败（空宿主环境必须走这里）。 */
function skip(name, why) {
  skipped += 1;
  console.log(`  SKIP  ${name}${why === undefined || why === "" ? "" : ` — ${why}`}`);
}

function group(title) {
  console.log(`\n== ${title} ==`);
}

/** 宿主含包判定的等价实现：相等算「在内」，不允许逃出包根。 */
function isInside(baseDir, candidate) {
  const base = resolvePath(baseDir);
  const target = resolvePath(candidate);
  const rel = relative(base, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** 假 logger：把日志收集起来，便于断言「密钥不外泄」。 */
function makeLogger() {
  const lines = [];
  return {
    lines,
    info: (line) => lines.push(String(line)),
    warn: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

/** 假日志写入器：断言审计日志内容，同时保证不碰真实磁盘。 */
function makeLogSink() {
  const entries = [];
  return {
    entries,
    appendLog: (filePath, text) => entries.push({ filePath, text: String(text) }),
    text: () => entries.map((entry) => entry.text).join(""),
  };
}

function missingReadFile(filePath) {
  const error = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
  error.code = "ENOENT";
  throw error;
}

function fakeResponse(status, payload) {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: async () => (typeof payload === "string" ? payload : JSON.stringify(payload ?? {})),
  };
}

function makeFetchCapture(response) {
  const calls = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url, init });
      return typeof response === "function" ? response(url, init) : response;
    },
  };
}

const SECRET = "PLACEHOLDER_SECRET_NOT_A_REAL_TOKEN_0000";
const URL_OK = "http://127.0.0.1:25567/openclaw-wechat";

function receivedEvent(overrides = {}) {
  return {
    type: "message",
    action: "received",
    sessionKey: "agent:main:main",
    timestamp: new Date("2026-01-01T00:00:00.000Z"),
    context: {
      from: "user-placeholder@im.wechat",
      conversationId: "conv-placeholder",
      content: "请读取 D:\\ws\\repos 的构建日志并给出修复补丁",
      channelId: "openclaw-weixin",
      messageId: "openclaw-weixin:0000000000000-aaaaaaaa",
      ...(overrides.context ?? {}),
    },
    messages: [],
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "context")),
  };
}

/** 统一的离线调用环境（全部注入：fetch/env/readFile/logger/appendLog/sleep/state）。 */
async function runHandler(event, { env = {}, response = fakeResponse(202, { status: "accepted", sessionId: "webhook-test" }), logger = makeLogger() } = {}) {
  const sink = makeLogSink();
  const { calls, fetchImpl } = makeFetchCapture(response);
  const result = await handleMessage(event, {
    env: {
      DSH_BRIDGE_URL: URL_OK,
      DSH_BRIDGE_SECRET: SECRET,
      DSH_BRIDGE_COALESCE_MS: "0",
      DSH_BRIDGE_WAIT: "0",
      ...env,
    },
    fetch: fetchImpl,
    readFile: missingReadFile,
    logger,
    appendLog: sink.appendLog,
    forwardLogPath: "Z:\\placeholder\\bridge-forward.log",
    now: () => 1791000000000,
    sleep: async () => {},
    state: { ring: new EchoRing(), coalescer: new FragmentCoalescer(), inFlight: new Set() },
  });
  return { result, logger, sink, calls };
}

// ── 1. hook pack 清单与目录约定 ─────────────────────────────────────────────
group("hook pack 清单与目录约定（对照 openclaw 2026.9.7 宿主代码）");

const manifest = JSON.parse(readFileSync(joinPath(packRoot, "package.json"), "utf8"));

check("package.json 可被 JSON 解析", typeof manifest === "object" && manifest !== null);
check("未声明 openclaw.extensions（保持 hook-only 包类型）", manifest.openclaw?.extensions === undefined);
check(
  "openclaw.hooks 是非空字符串数组",
  Array.isArray(manifest.openclaw?.hooks) && manifest.openclaw.hooks.every((item) => typeof item === "string" && item.trim() !== ""),
  JSON.stringify(manifest.openclaw?.hooks),
);
check("type=module（宿主用原生 import() 加载 handler）", manifest.type === "module", String(manifest.type));

const declaredHooks = Array.isArray(manifest.openclaw?.hooks) ? manifest.openclaw.hooks : [];
const resolvedHookDirs = declaredHooks.map((entry) => resolvePath(packRoot, entry));
check(
  "每个 openclaw.hooks 条目都落在包根之内",
  resolvedHookDirs.length > 0 && resolvedHookDirs.every((dir) => isInside(packRoot, dir)),
  resolvedHookDirs.join(", "),
);

const handlerCandidates = ["handler.ts", "handler.js", "index.ts", "index.js"];
for (const hookDir of resolvedHookDirs) {
  const label = relative(packRoot, hookDir) || ".";
  check(`hook 目录存在：${label}`, existsSync(hookDir), hookDir);
  check(`hook 目录含 HOOK.md：${label}`, existsSync(joinPath(hookDir, "HOOK.md")), joinPath(hookDir, "HOOK.md"));
  const handlerEntry = handlerCandidates.find((candidate) => existsSync(joinPath(hookDir, candidate)));
  check(`hook 目录含 handler 候选（${handlerCandidates.join(" → ")}）：${label}`, handlerEntry !== undefined, String(handlerEntry));
}

// ── 2. HOOK.md frontmatter 契约 ─────────────────────────────────────────────
group("HOOK.md frontmatter");

const hookMdPath = joinPath(packRoot, "HOOK.md");
const hookMd = readFileSync(hookMdPath, "utf8");
const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(hookMd);
check("HOOK.md 有 YAML frontmatter 块", frontmatterMatch !== null);
const frontmatter = frontmatterMatch === null ? "" : frontmatterMatch[1];

const nameMatch = /^name:\s*(.+)$/m.exec(frontmatter);
check("frontmatter 声明 name", nameMatch !== null && nameMatch[1].trim() !== "", String(nameMatch?.[1]));

const metadataBlock = /metadata:\s*\r?\n\s*(\{[\s\S]*?\})\s*$/m.exec(frontmatter);
check("frontmatter 的 metadata 是流式映射（文档写法）", metadataBlock !== null);
let metadata = null;
try {
  metadata = metadataBlock === null ? null : JSON.parse(metadataBlock[1]);
} catch (error) {
  check("metadata 可被 JSON 解析", false, String(error));
}
check("metadata.openclaw.events 至少含一个事件键", Array.isArray(metadata?.openclaw?.events) && metadata.openclaw.events.length > 0);
check("metadata.openclaw.events 含 message:received", metadata?.openclaw?.events?.includes("message:received") === true);
check("metadata.openclaw.events 含 message:sent（自回环标记环所需）", metadata?.openclaw?.events?.includes("message:sent") === true);

// ── 3. handler 导出形态 ─────────────────────────────────────────────────────
group("handler 导出形态");

check("默认导出是函数（宿主按 `export` 缺省取 default）", typeof handlerModule === "function");
check(
  "具名导出（handleMessage/resolveConfig/extractMessage/buildPayload/redact）都是函数",
  [handleMessage, resolveConfig, extractMessage, buildPayload, redact].every((fn) => typeof fn === "function"),
);
check("导出判断常量与规则表（供审计/测试引用）", typeof RULES === "object" && typeof RULES.GREETING === "string");

// ── 4. 行为冒烟（细节见 test-handler.mjs） ──────────────────────────────────
group("行为冒烟");

{
  const { result, calls, sink } = await runHandler(receivedEvent({ context: { content: "你好" } }));
  check("闲聊消息被跳过（不建会话）", result.skipped === RULES.GREETING && calls.length === 0, JSON.stringify(result));
  check("判断写入审计日志", /decision=skip rule=greeting/.test(sink.text()), sink.text().slice(0, 160));
}

{
  const { result, calls } = await runHandler(receivedEvent({ context: { content: "请读取 D:\\ws\\repos 的构建日志并给出修复补丁" } }));
  check("需要本地能力的消息被转发", result.ok === true && calls.length === 1, JSON.stringify(result));
  const body = JSON.parse(String(calls[0]?.init?.body ?? "{}"));
  check("请求体含 text/sender/conversationId", body.text !== "" && body.sender !== "" && body.conversationId === "conv-placeholder", JSON.stringify(body));
  check("鉴权头为 Bearer <secret>", calls[0]?.init?.headers?.authorization === `Bearer ${SECRET}`);
}

{
  const { result } = await runHandler(receivedEvent({ context: { content: "#dsh 你好" } }));
  check("显式前缀无视判断直接转发", result.ok === true && result.forwardRule === RULES.OVERRIDE_PREFIX, JSON.stringify(result));
}

{
  const logger = makeLogger();
  const { result } = await runHandler(receivedEvent({ context: { content: "请实现 D:\\ws 的补丁" } }), {
    response: fakeResponse(200, {
      status: "needs_input",
      state: "needs_input",
      sessionId: "webhook-q",
      question: "选哪个？",
      options: [{ index: 1, label: "A" }, { index: 2, label: "B" }],
    }),
    logger,
  });
  check("needs_input 三态被如实回传", result.state === "needs_input" && result.optionCount === 2, JSON.stringify(result));
  check("选项转为纯文本编号并写日志", logger.lines.some((line) => /1\) A/.test(line)), logger.lines.join(" | "));
}

// ── 5. 主机 discovery 实测（可选；空宿主环境走 SKIP） ───────────────────────
group("宿主 OpenClaw discovery 实测（可选；缺失即 SKIP）");

/**
 * 找出本机 openclaw 发行包里的 `discovery-*.mjs`（其导出的 `t` 即宿主的
 * `loadHookEntriesFromDir`）。找不到就 SKIP，不影响仓库内可复现性。
 */
async function findHostDiscovery() {
  const distCandidates = [];
  const pushDist = (value) => {
    if (typeof value !== "string" || value.trim() === "") return;
    const resolved = resolvePath(value.trim());
    if (!distCandidates.includes(resolved)) distCandidates.push(resolved);
  };
  pushDist(process.env.OPENCLAW_DIST);
  const dshWinHome = process.env.DSH_WIN_HOME ?? joinPath(homedir(), ".dsh-win");
  pushDist(joinPath(dshWinHome, "node", "node_modules", "openclaw", "dist"));
  pushDist(joinPath(homedir(), ".dsh-win", "node", "node_modules", "openclaw", "dist"));
  if (typeof process.env.APPDATA === "string") pushDist(joinPath(process.env.APPDATA, "npm", "node_modules", "openclaw", "dist"));
  const projectsRoot = joinPath(homedir(), ".openclaw", "npm", "projects");
  if (existsSync(projectsRoot)) {
    for (const project of readdirSync(projectsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory())) {
      pushDist(joinPath(projectsRoot, project.name, "node_modules", "@tencent-weixin", "openclaw-weixin", "node_modules", "openclaw", "dist"));
    }
  }

  for (const dist of distCandidates) {
    if (!existsSync(dist)) continue;
    for (const entry of readdirSync(dist, { withFileTypes: true })) {
      if (!entry.isFile() || !/^discovery-.*\.mjs$/.test(entry.name)) continue;
      try {
        const module = await import(pathToFileURL(joinPath(dist, entry.name)).href);
        if (typeof module.t === "function") return { dist, file: joinPath(dist, entry.name), module };
      } catch {
        /* 换下一个候选 */
      }
    }
  }
  return undefined;
}

try {
  const host = await findHostDiscovery();
  if (host === undefined) {
    skip("宿主 discovery 实测", "本机未找到 openclaw 发行包（可用 OPENCLAW_DIST 指向 <openclaw>/dist）");
  } else {
    console.log(`  INFO  使用宿主代码 : ${host.file}`);
    const discoveryWarnings = [];
    const entries = host.module.t({ dir: packRoot, source: "openclaw-managed", includeRoot: true }, (message) =>
      discoveryWarnings.push(String(message)),
    );
    check("宿主 discovery 恰好发现 1 个 hook", Array.isArray(entries) && entries.length === 1, `entries=${Array.isArray(entries) ? entries.length : "n/a"}`);
    const entry = Array.isArray(entries) ? entries[0] : undefined;
    check("发现的 hook 名是 dsh-bridge", entry?.hook?.name === "dsh-bridge", String(entry?.hook?.name));
    check("发现的事件含 message:received", entry?.metadata?.events?.includes("message:received") === true, JSON.stringify(entry?.metadata?.events));
    check("发现的事件含 message:sent", entry?.metadata?.events?.includes("message:sent") === true, JSON.stringify(entry?.metadata?.events));
    check("metadata 无非法字段（invalidMetadata=false）", entry?.invalidMetadata === false, String(entry?.invalidMetadata));
    check("handler 路径解析到本包 handler.js", entry?.hook?.handlerPath === joinPath(packRoot, "handler.js"), String(entry?.hook?.handlerPath));
    check("hook 基目录解析到本包根目录", entry?.hook?.baseDir === packRoot, String(entry?.hook?.baseDir));
    check("宿主 discovery 没有报任何告警", discoveryWarnings.length === 0, discoveryWarnings.join(" | "));
  }
} catch (error) {
  skip("宿主 discovery 实测", `宿主代码不可用：${String(error)}`);
}

// ── 6. 空宿主安全 ───────────────────────────────────────────────────────────
group("空宿主安全（无 openclaw / 无状态目录）");

{
  const resolved = resolveConfig(receivedEvent(), { env: {}, readFile: missingReadFile });
  check("空环境下配置解析不抛错且给出默认日志路径", typeof resolved.config.forwardLog === "string" && resolved.config.forwardLog !== "");
  check("空环境下侧挂配置读取失败被记录（不抛错）", resolved.fileError.includes("ENOENT"), resolved.fileError);
  check("默认旁挂配置路径以 dsh-bridge-hook.json 结尾", defaultConfigPath({}).endsWith("dsh-bridge-hook.json"), defaultConfigPath({}));
  const { result } = await runHandler(receivedEvent({ context: { content: "请修复 D:\\ws 的报错" } }), { env: { DSH_BRIDGE_URL: "", DSH_BRIDGE_SECRET: "" } });
  check("未配置 URL/密钥时安全跳过（unconfigured）", result.skipped === RULES.UNCONFIGURED, JSON.stringify(result));
  check("本脚本已定义 skip()（空宿主环境不会 ReferenceError）", typeof skip === "function");
}

// ── 汇总 ────────────────────────────────────────────────────────────────────
console.log(`\n---- self-test 汇总：${passed} passed, ${failures.length} failed, ${skipped} skipped ----`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAILED: ${failure}`);
  process.exit(1);
}
console.log("全部断言通过。");
process.exit(0);
