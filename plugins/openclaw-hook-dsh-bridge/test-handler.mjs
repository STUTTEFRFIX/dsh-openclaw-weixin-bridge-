/**
 * test-handler — dsh-bridge hook 的 t6 修复自测（契约指定的自测入口）。
 *
 * 运行：node plugins/openclaw-hook-dsh-bridge/test-handler.mjs
 * 退出码：0 = 全部通过；1 = 有断言失败。
 *
 * 覆盖 t6 验收要求的五类断言 + 判断日志 + 三态回传：
 *   1) 闲聊/问候/确认/追问类消息应跳过（不新建 DSH 会话）
 *   2) 显式前缀（`#dsh `）应无视判断直接转发
 *   3) 防自回环：出站标记环 / 回复标记 / bot 账号 / fromMe 标记 → 跳过
 *   4) 复用/合并窗口：同源多段合并成一次派发、窗口到期行为、桥接侧亲和复用与过期
 *   5) needs_input：三态映射 + 纯文本编号选项
 *
 * 复现性：不联网（fetch 注入）、不读真实配置（readFile 注入）、不写真实日志
 * （appendLog 注入）、时间与 sleep 注入；不需要 openclaw 也不需要 DSH 进程。
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath, resolve as resolvePath } from "node:path";

import handlerModule, {
  DECISION,
  EchoRing,
  FragmentCoalescer,
  RULES,
  appendForwardLog,
  buildPayload,
  decideForward,
  defaultForwardLogPath,
  extractMessage,
  extractOutbound,
  formatOptionsText,
  handleMessage,
  mapBridgeResponse,
  normalizeForLoop,
  redact,
  resolveConfig,
  resolveOriginKey,
} from "./handler.js";
import {
  DEFAULT_AFFINITY_OPTIONS,
  SessionAffinity,
  detectTurnState,
  extractQuestionPayload,
  formatNumberedOptions,
  resolveOriginKey as resolveOriginKeyBridge,
} from "../dsh-webhook-bridge/lib/affinity.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const packRoot = here;

let passed = 0;
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

function group(title) {
  console.log(`\n== ${title} ==`);
}

const SECRET = "PLACEHOLDER_SECRET_NOT_A_REAL_TOKEN_0000";
const URL_OK = "http://127.0.0.1:25567/openclaw-wechat";
const FIXED_NOW = 1791000000000;

/**
 * 真实磁盘守卫：默认审计日志落在真实 stateDir 下，测试**必须**全程注入写入器。
 * 这里在跑任何断言之前记录该路径的存在性/mtime，结束时比对；
 * 一旦有调用忘了注入 appendLog，就会在这里失败（而不是悄悄污染 ~/.openclaw）。
 */
const REAL_LOG_GUARD = (() => {
  const path = defaultForwardLogPath(process.env);
  try {
    const info = statSync(path);
    return { path, existed: true, size: info.size, mtimeMs: info.mtimeMs };
  } catch {
    return { path, existed: false, size: 0, mtimeMs: 0 };
  }
})();

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeLogger() {
  const lines = [];
  return {
    lines,
    info: (line) => lines.push(String(line)),
    warn: (line) => lines.push(String(line)),
    error: (line) => lines.push(String(line)),
  };
}

/**
 * 注入审计（t9）：记录每次 handleMessage 调用是否真的用上了注入的日志写入器。
 * 目的不是「再断言一次常量 true」，而是让「忘了注入 appendLog 就会写真实 stateDir」这类回归可被捕获。
 */
const PLACEHOLDER_LOG_PATH = "Z:\\placeholder\\bridge-forward.log";
const RUN_LOG_AUDIT = [];
const ALL_SINK_LINES = [];

function makeLogSink() {
  const entries = [];
  const sink = {
    entries,
    appendLog: (filePath, text) => {
      const entry = { filePath, text: String(text) };
      entries.push(entry);
      ALL_SINK_LINES.push(entry);
    },
    text: () => entries.map((entry) => entry.text).join(""),
  };
  return sink;
}

function makeState() {
  return { ring: new EchoRing(), coalescer: new FragmentCoalescer(), inFlight: new Set() };
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

function receivedEvent(overrides = {}) {
  return {
    type: "message",
    action: "received",
    sessionKey: "agent:main:main",
    timestamp: new Date(FIXED_NOW),
    context: {
      from: "user-placeholder@im.wechat",
      conversationId: "conv-placeholder",
      content: "请把 D:\\ws\\repos 的失败日志贴出来，并给出修复补丁",
      channelId: "openclaw-weixin",
      messageId: "openclaw-weixin:0000000000000-aaaaaaaa",
      ...(overrides.context ?? {}),
    },
    messages: [],
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "context")),
  };
}

function sentEvent(text, overrides = {}) {
  return {
    type: "message",
    action: "sent",
    context: { content: text, channelId: "openclaw-weixin", to: "user-placeholder@im.wechat", success: true, ...(overrides.context ?? {}) },
    ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== "context")),
  };
}

/** 统一的 handleMessage 调用环境（全部离线、全部注入）。 */
async function run(event, { env = { DSH_BRIDGE_URL: URL_OK, DSH_BRIDGE_SECRET: SECRET }, response = fakeResponse(202, { status: "accepted", sessionId: "webhook-test" }), state = makeState(), extra = {} } = {}) {
  const logger = makeLogger();
  const sink = makeLogSink();
  const { calls, fetchImpl } = makeFetchCapture(response);
  const result = await handleMessage(event, {
    env: { DSH_BRIDGE_COALESCE_MS: "0", ...env },
    fetch: fetchImpl,
    readFile: missingReadFile,
    logger,
    appendLog: sink.appendLog,
    forwardLogPath: PLACEHOLDER_LOG_PATH,
    now: () => FIXED_NOW,
    sleep: async () => {},
    state,
    ...extra,
  });
  RUN_LOG_AUDIT.push({
    event: `${event?.type ?? "?"}:${event?.action ?? "?"}`,
    lines: sink.entries.length,
    offPlaceholderPaths: sink.entries.filter((entry) => entry.filePath !== PLACEHOLDER_LOG_PATH).map((entry) => entry.filePath),
  });
  return { result, logger, sink, calls };
}

// ── 0. 包契约（清单 / frontmatter / 单文件 handler） ────────────────────────
group("包契约");

const manifest = JSON.parse(readFileSync(joinPath(packRoot, "package.json"), "utf8"));
check("package.json 可解析且 type=module", manifest.type === "module");
check("openclaw.hooks 是非空字符串数组", Array.isArray(manifest.openclaw?.hooks) && manifest.openclaw.hooks.length > 0);
check("默认导出是函数（宿主按 default 取用）", typeof handlerModule === "function");

const hookMd = readFileSync(joinPath(packRoot, "HOOK.md"), "utf8");
const metadataMatch = /metadata:\s*\r?\n\s*(\{[\s\S]*?\})\s*$/m.exec(hookMd);
let hookMetadata = null;
try {
  hookMetadata = metadataMatch === null ? null : JSON.parse(metadataMatch[1]);
} catch {
  hookMetadata = null;
}
const hookEvents = Array.isArray(hookMetadata?.openclaw?.events) ? hookMetadata.openclaw.events : [];
check("HOOK.md 同时订阅 message:received 与 message:sent", hookEvents.includes("message:received") && hookEvents.includes("message:sent"), JSON.stringify(hookEvents));

// ── 1. 转发判断：闲聊/问候/确认/追问应跳过 ─────────────────────────────────
group("1. 转发判断：闲聊类应跳过");

const chitchatCases = [
  ["你好", RULES.GREETING],
  ["在吗？", RULES.GREETING],
  ["hello", RULES.GREETING],
  ["谢谢", RULES.ACK],
  ["好的", RULES.ACK],
  ["收到", RULES.ACK],
  ["嗯", RULES.ACK],
  ["继续", RULES.CONFIRMATION],
  ["别用", RULES.CONFIRMATION],
  ["是吗？", RULES.FOLLOW_UP],
  ["然后呢", RULES.FOLLOW_UP],
  ["😀", RULES.EMOJI_ONLY],
  ["？？", RULES.EMOJI_ONLY],
];

for (const [text, expectedRule] of chitchatCases) {
  const decision = decideForward({ text, judgment: "on", defaultDecision: "skip", forwardPrefix: "#dsh", echoRing: new EchoRing(), now: FIXED_NOW });
  check(`判断「${text}」→ skip（${expectedRule}）`, decision.decision === DECISION.SKIP && decision.rule === expectedRule, JSON.stringify(decision));
}

{
  const { result, calls, sink } = await run(receivedEvent({ context: { content: "你好" } }));
  check("闲聊消息不发起转发请求", calls.length === 0 && result.skipped === RULES.GREETING, JSON.stringify(result));
  check("闲聊判断写入 bridge-forward.log（含 decision/rule）", /decision=skip rule=greeting/.test(sink.text()), sink.text().slice(0, 160));
}

check(
  "“无法判定”默认跳过（default-skip）",
  decideForward({ text: "随便聊聊天气", judgment: "on", defaultDecision: "skip", forwardPrefix: "#dsh", echoRing: new EchoRing(), now: FIXED_NOW }).rule === RULES.DEFAULT_SKIP,
);
check(
  "defaultDecision=forward 时同一句改为转发（配置常量生效）",
  decideForward({ text: "随便聊聊天气", judgment: "on", defaultDecision: "forward", forwardPrefix: "#dsh", echoRing: new EchoRing(), now: FIXED_NOW }).rule === RULES.DEFAULT_FORWARD,
);
check(
  "judgment=off 时关闭判断（回到旧行为）",
  decideForward({ text: "你好", judgment: "off", defaultDecision: "skip", forwardPrefix: "#dsh", echoRing: new EchoRing(), now: FIXED_NOW }).rule === RULES.DEFAULT_FORWARD,
);
{
  // t9：自回环过滤必须**先于** judgment 开关（文档称「只剩自回环过滤」必须成立）
  const ring = new EchoRing();
  ring.record("已定位，三类缺陷都成立，稍后我把补丁贴给你", FIXED_NOW);
  const markerWhenOff = decideForward({ text: "[dsh] 回传内容", judgment: "off", defaultDecision: "skip", forwardPrefix: "#dsh", echoRing: new EchoRing(), now: FIXED_NOW });
  const echoWhenOff = decideForward({
    text: "已定位，三类缺陷都成立，稍后我把补丁贴给你",
    judgment: "off",
    defaultDecision: "skip",
    forwardPrefix: "#dsh",
    echoRing: ring,
    now: FIXED_NOW,
  });
  check("judgment=off 时回复标记仍拦截（self-loop-marker）", markerWhenOff.decision === DECISION.SKIP && markerWhenOff.rule === RULES.SELF_LOOP_MARKER, JSON.stringify(markerWhenOff));
  check("judgment=off 时出站标记环仍拦截（self-loop-echo）", echoWhenOff.decision === DECISION.SKIP && echoWhenOff.rule === RULES.SELF_LOOP_ECHO, JSON.stringify(echoWhenOff));
  check(
    "judgment=off 时普通闲聊仍按关闭语义转发（证明关的是内容判断）",
    decideForward({ text: "你好", judgment: "off", defaultDecision: "skip", forwardPrefix: "#dsh", echoRing: ring, now: FIXED_NOW }).rule === RULES.DEFAULT_FORWARD,
  );
}
{
  // t9：hook 侧不再解析 DSH_BRIDGE_MIN_INTERVAL_MS（真正生效的节流在 DSH 侧 minIntervalMs）
  const resolved = resolveConfig(receivedEvent(), {
    env: { DSH_BRIDGE_MIN_INTERVAL_MS: "12345", DSH_BRIDGE_COALESCE_MS: "0" },
    readFile: missingReadFile,
  });
  check(
    "DSH_BRIDGE_MIN_INTERVAL_MS 在 hook 侧不再生效（不落入配置）",
    resolved.config.minIntervalMs === undefined && !Object.hasOwn(resolved.config, "minIntervalMs"),
    JSON.stringify({ minIntervalMs: resolved.config.minIntervalMs, has: Object.hasOwn(resolved.config, "minIntervalMs") }),
  );
}

// ── 2. 显式覆盖前缀 ────────────────────────────────────────────────────────
group("2. 显式前缀应无视判断直接转发");

check(
  "以 `#dsh ` 开头 → override-prefix",
  decideForward({ text: "#dsh 你好", judgment: "on", defaultDecision: "skip", forwardPrefix: "#dsh", echoRing: new EchoRing(), now: FIXED_NOW }).rule === RULES.OVERRIDE_PREFIX,
);
{
  const decision = decideForward({ text: "#dsh 你好", judgment: "on", defaultDecision: "skip", forwardPrefix: "#dsh", echoRing: new EchoRing(), now: FIXED_NOW });
  check("前缀本身不进入转发正文", decision.text === "你好", decision.text);
}
{
  const { result, calls } = await run(receivedEvent({ context: { content: "#dsh 你好" } }));
  check("显式前缀消息确实发起了转发", calls.length === 1 && result.ok === true, JSON.stringify(result));
  const body = JSON.parse(String(calls[0]?.init?.body ?? "{}"));
  check("转发正文已去掉前缀", body.text === "你好", JSON.stringify(body.text));
  check("默认 wait=true（才能拿到三态）", body.wait === true);
  check("携带 conversationId（供桥接做会话亲和）", body.conversationId === "conv-placeholder");
}

// ── 3. 防自回环 ────────────────────────────────────────────────────────────
group("3. 防自回环应跳过");

{
  const state = makeState();
  const outbound = "已定位，三类缺陷都成立，稍后我把补丁贴给你";
  const { result: sentResult } = await run(sentEvent(outbound), { state });
  check("message:sent 被记入标记环", sentResult.recorded === true && state.ring.size === 1, JSON.stringify(sentResult));

  const { result, calls, sink } = await run(receivedEvent({ context: { content: outbound } }), { state });
  check("同一文本回流 → 跳过（self-loop-echo）", result.skipped === RULES.SELF_LOOP_ECHO && calls.length === 0, JSON.stringify(result));
  check("自回环判断写日志", /rule=self-loop-echo/.test(sink.text()), sink.text().slice(0, 160));
}

{
  const state = makeState();
  const long = "这是一段很长的回复正文，用来验证前缀包含判定：桥接把答复复述回微信后不应再触发转发，否则会凭空产生新的 DSH 会话。";
  await run(sentEvent(long), { state });
  const { result, calls } = await run(receivedEvent({ context: { content: long.slice(0, 40) } }), { state });
  check("长文本被截断回流 → 跳过（前缀包含判定）", result.skipped === RULES.SELF_LOOP_ECHO && calls.length === 0, JSON.stringify(result));
}

{
  const { result, calls } = await run(receivedEvent({ context: { content: "[dsh] 这是回传标记开头" } }));
  check("带回复标记 [dsh] → 跳过（self-loop-marker）", result.skipped === RULES.SELF_LOOP_MARKER && calls.length === 0, JSON.stringify(result));
}

{
  const { result, calls } = await run(receivedEvent({ context: { content: "请把日志贴出来" } }), {
    env: { DSH_BRIDGE_URL: URL_OK, DSH_BRIDGE_SECRET: SECRET, DSH_BRIDGE_COALESCE_MS: "0", DSH_BRIDGE_BOT_IDS: "user-placeholder@im.wechat" },
  });
  check("来自 bot 账号 id（context.from）的消息 → 跳过（self-loop-sender）", result.skipped === RULES.SELF_LOOP_SENDER && calls.length === 0, JSON.stringify(result));
}

{
  // 真实通道里 bot 标识更常出现在 metadata.senderId（from 可能是用户）：
  // 若这里不查 metadata，长技术回文就会被当成用户任务转发出去（自回环）。
  const botEcho = "已定位，三类缺陷都成立，我这边还发现一个你没提的问题：桥接回传会被通道 hook 当成新的入站消息，请修复 D:\\ws 下的构建报错并给出补丁";
  const { result, calls } = await run(receivedEvent({ context: { content: botEcho, metadata: { senderId: "bot-placeholder@im.wechat" } } }), {
    env: { DSH_BRIDGE_URL: URL_OK, DSH_BRIDGE_SECRET: SECRET, DSH_BRIDGE_COALESCE_MS: "0", DSH_BRIDGE_BOT_IDS: "bot-placeholder@im.wechat" },
  });
  check(
    "bot 标识只在 metadata.senderId 时也跳过（否则长技术回文会被误转发）",
    result.skipped === RULES.SELF_LOOP_SENDER && calls.length === 0,
    JSON.stringify(result),
  );
  check(
    "该回文若只看内容本会被转发（证明拦截来自 sender 维度而非默认跳过）",
    decideForward({ text: botEcho, judgment: "on", defaultDecision: "skip", forwardPrefix: "#dsh", echoRing: new EchoRing(), now: FIXED_NOW }).decision === DECISION.FORWARD,
  );
}

{
  const { result, calls } = await run(receivedEvent({ context: { content: "请把日志贴出来", accountId: "user-placeholder@im.wechat" } }));
  check("sender 与 accountId 一致 → 跳过（自身账号）", result.skipped === RULES.SELF_LOOP_SENDER && calls.length === 0, JSON.stringify(result));
}

{
  const { result, calls } = await run(receivedEvent({ context: { content: "请把日志贴出来", metadata: { fromMe: true } } }));
  check("事件自带 fromMe 标记 → 跳过", result.skipped === RULES.SELF_LOOP_SENDER && calls.length === 0, JSON.stringify(result));
}

{
  const ring = new EchoRing({ maxEntries: 2, windowMs: 1000, marker: "[dsh]" });
  ring.record("A", 0);
  ring.record("B", 0);
  ring.record("C", 0);
  check("标记环有上限（只保留最近 N 条）", ring.size === 2 && ring.match("A", 0) === null, JSON.stringify(ring.entries));
  check("标记环有时间窗（窗口外不再命中）", ring.match("C", 5000) === null);
  check("归一化会去掉回复标记与引号", normalizeForLoop("[dsh] “文本”", "[dsh]") === "文本", normalizeForLoop("[dsh] “文本”", "[dsh]"));
}

// ── 4. 复用/合并窗口 ───────────────────────────────────────────────────────
group("4. 同源多段合并与重用窗口");

{
  const coalescer = new FragmentCoalescer({ coalesceMs: 1500, coalesceMaxMs: 5000, maxFragments: 20, maxMergedChars: 8000 });
  const first = coalescer.submit({ originKey: "conv:x", text: "第一段", now: 1000 });
  const second = coalescer.submit({ originKey: "conv:x", text: "第二段", now: 1200 });
  const third = coalescer.submit({ originKey: "conv:x", text: "第三段", now: 1400 });
  check("窗口内的多段都被缓冲（不立即派发）", first.action === "buffered" && second.action === "buffered" && third.action === "buffered");
  const taken = coalescer.take("conv:x");
  check("窗口到期后只取到一次合并派发", taken !== undefined && taken.fragments === 3, JSON.stringify(taken));
  check("合并文本按段落拼接（同源多段合并）", taken.text === "第一段\n\n第二段\n\n第三段", JSON.stringify(taken.text));
  check("第二次取走为空（其余调用不会新建会话）", coalescer.take("conv:x") === undefined);
}

{
  const coalescer = new FragmentCoalescer({ coalesceMs: 1500, coalesceMaxMs: 5000 });
  coalescer.submit({ originKey: "conv:y", text: "a", now: 0 });
  const late = coalescer.submit({ originKey: "conv:y", text: "b", now: 6000 });
  check("超过 coalesceMaxMs 的积压立即派发（窗口有硬上限）", late.action === "dispatch" && late.reason === "coalesce-max", JSON.stringify(late));
}

{
  const coalescer = new FragmentCoalescer({ coalesceMs: 0 });
  const immediate = coalescer.submit({ originKey: "conv:z", text: "单独一段", now: 0 });
  check("coalesceMs=0 时立即派发（可关闭合并）", immediate.action === "dispatch" && immediate.text === "单独一段", JSON.stringify(immediate));
}

{
  const coalescer = new FragmentCoalescer({ coalesceMs: 1500 });
  coalescer.submit({ originKey: "conv:w", text: "在途", now: 0 });
  coalescer.markInFlight("conv:w", true);
  const whileInFlight = coalescer.submit({ originKey: "conv:w", text: "在途追加", now: 100 });
  check("派发在途时的追加段继续并入（不会并发新建会话）", whileInFlight.action === "buffered" && whileInFlight.reason === "in-flight", JSON.stringify(whileInFlight));
}

{
  // handleMessage 层：合并窗口内两段只产生一次 HTTP 转发
  // 用可门控的 sleep 精确模拟“两段都在静默窗口内到达”。
  const state = makeState();
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  const env = { DSH_BRIDGE_URL: URL_OK, DSH_BRIDGE_SECRET: SECRET, DSH_BRIDGE_COALESCE_MS: "1000" };
  const firstPromise = run(receivedEvent({ context: { content: "请修复 D:\\ws 下的构建报错" } }), { state, env, extra: { sleep: () => gate } });
  await new Promise((resolve) => setImmediate(resolve));
  const second = await run(receivedEvent({ context: { content: "另外请把补丁贴出来" } }), { state, env });
  release();
  const first = await firstPromise;
  const totalCalls = first.calls.length + second.calls.length;
  check("窗口内两段合计只发起一次转发（合并）", totalCalls === 1, `${first.calls.length}+${second.calls.length}`);
  const dispatched = first.calls[0] ?? second.calls[0];
  const dispatchedBody = JSON.parse(String(dispatched?.init?.body ?? "{}"));
  check("合并后的正文包含两段内容", /构建报错/.test(dispatchedBody.text ?? "") && /补丁贴出来/.test(dispatchedBody.text ?? ""), JSON.stringify(dispatchedBody.text));
  check("合并后的请求带 fragments>=2", dispatchedBody.fragments >= 2, JSON.stringify(dispatchedBody.fragments));
  check(
    "被合并掉的那次调用记为 coalesced-deduped（不新建会话）",
    [first.result, second.result].some((item) => item.skipped === RULES.COALESCED_DEDUPED),
    JSON.stringify([first.result, second.result]),
  );
}

{
  // 桥接侧亲和：窗口内复用同一会话（running 时合并），过期则新建并记录
  const logs = [];
  const affinity = new SessionAffinity({ affinityWindowMs: 900000, minIntervalMs: 1500, log: (line) => logs.push(line) });
  const first = affinity.submit({ originKey: "sender:u1", text: "第一条", now: 0, isSessionRunning: () => false });
  check("首次提交 → dispatch（新建会话）", first.action === "dispatch" && first.reason === "new-session", JSON.stringify(first));
  affinity.markDispatched({ originKey: "sender:u1", sessionId: "webhook-a", now: 0, fragments: first.fragments });
  const second = affinity.submit({ originKey: "sender:u1", text: "第二条", now: 500, isSessionRunning: () => true });
  check("窗口内 + 上一轮仍在跑 → merge（复用同一会话，不新建）", second.action === "merge" && second.reason === "session-running" && second.sessionId === "webhook-a", JSON.stringify(second));
  const flushable = affinity.takeFlushable({ originKey: "sender:u1", now: 900, isSessionRunning: () => true });
  check("会话仍在跑时不 flush（避免并发新建）", flushable === null);
  const afterEnd = affinity.takeFlushable({ originKey: "sender:u1", now: 1200, isSessionRunning: () => false });
  check("会话结束后把攒下的段合并成一次派发", afterEnd !== null && afterEnd.text.includes("第二条"), JSON.stringify(afterEnd));
  affinity.markDispatched({ originKey: "sender:u1", sessionId: "webhook-b", now: 1200, fragments: afterEnd.fragments });
  const expired = affinity.submit({ originKey: "sender:u1", text: "第三条", now: 1200 + 900000 + 1, isSessionRunning: () => false });
  check("窗口过期 → 新建会话且有日志", expired.action === "dispatch" && logs.some((line) => line.includes("affinity-window-expired")), JSON.stringify(logs.slice(-3)));
  check("窗口内复用也写日志", logs.some((line) => line.includes("affinity-reuse")));
  check("origin 键优先 conversationId", resolveOriginKeyBridge({ conversationId: "c1", senderId: "s1" }) === "conv:c1");
  check(
    "hook 与桥接的 origin 键规则一致（有会话 id 时用会话，没有时退化到 sender）",
    resolveOriginKey({ conversationId: "c1", sender: "s1" }) === "conv:c1" &&
      resolveOriginKeyBridge({ conversationId: "c1", senderId: "s1" }) === "conv:c1" &&
      resolveOriginKey({ conversationId: "", sender: "s1" }) === "sender:s1" &&
      resolveOriginKeyBridge({ conversationId: "", senderId: "s1" }) === "sender:s1",
  );
  check("默认亲和窗口是常量且可配置", DEFAULT_AFFINITY_OPTIONS.affinityWindowMs > 0);
}

// ── 5. 三态回传：completed / needs_input / aborted ─────────────────────────
group("5. 三态回传与纯文本编号选项");

const questionArgs = JSON.stringify({
  questions: [
    {
      id: "loader",
      header: "模组加载器",
      question: "用哪个加载器和 MC 版本？",
      options: [
        { label: "NeoForge 1.21.x（推荐）", description: "新版本生态主流" },
        { label: "Fabric 1.21.x", description: "轻量、更新快" },
      ],
    },
  ],
});
const questionEvents = [
  { type: "turn/start", seq: 1, data: { turn: 1 } },
  { type: "tool/call", seq: 2, data: { turn: 1, step: 1, callId: "call_1", name: "ask_user_question", arguments: questionArgs } },
];
const questionState = detectTurnState(questionEvents);
check("未回答的选择项 → needs_input", questionState.state === "needs_input" && questionState.kind === "question", JSON.stringify(questionState));
check("解析出问题与编号选项", questionState.pending?.options?.length === 2 && questionState.pending?.question === "用哪个加载器和 MC 版本？", JSON.stringify(questionState.pending));
{
  const text = formatNumberedOptions(questionState.pending);
  check("选项转成纯文本编号（1) 2)）", /1\) NeoForge/.test(text) && /2\) Fabric/.test(text), text);
  check("纯文本选项不含 Markdown 表格/代码块", !text.includes("|") && !text.includes("```"), text);
}

{
  const answered = [
    ...questionEvents,
    { type: "tool/result", seq: 3, data: { toolCallId: "call_1", isError: false } },
    { type: "turn/end", seq: 4, data: { turn: 1, reason: { kind: "completed" } } },
  ];
  check("已回答 + turn/end → completed", detectTurnState(answered).state === "completed");
}
check(
  "turn/end aborted → aborted",
  detectTurnState([{ type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "aborted", reason: { kind: "user" } } } }]).state === "aborted",
);
check("turn/end error → error", detectTurnState([{ type: "turn/end", seq: 1, data: { turn: 1, reason: { kind: "error" } } }]).state === "error");
check("没有 turn/end → running", detectTurnState([{ type: "step/start", seq: 1, data: {} }]).state === "running");
check(
  "未决定的 approval/asked → needs_input（需要点击的另一种形态）",
  detectTurnState([
    { type: "approval/asked", seq: 1, data: { id: "a1", toolName: "pwsh", reason: "escalate sandbox" } },
  ]).state === "needs_input",
);
check(
  "已决定的 approval → 不判定 needs_input",
  detectTurnState([
    { type: "approval/asked", seq: 1, data: { id: "a1", toolName: "pwsh", reason: "x" } },
    { type: "approval/decided", seq: 2, data: { id: "a1", decision: "allow" } },
    { type: "turn/end", seq: 3, data: { turn: 1, reason: { kind: "completed" } } },
  ]).state === "completed",
);
{
  const payload = extractQuestionPayload(questionArgs);
  check("extractQuestionPayload 容错解析 JSON 字符串参数", payload.optionCount === 2 && payload.header === "模组加载器", JSON.stringify(payload));
  check("参数不是 JSON 时返回空选项而不抛错", extractQuestionPayload("{不是 JSON").optionCount === 0);
}

{
  const mapped = mapBridgeResponse({ status: "needs_input", sessionId: "webhook-q", state: "needs_input", question: "选哪个？", options: [{ index: 1, label: "A" }, { index: 2, label: "B" }] });
  check("桥接 needs_input → 三态 needs_input", mapped.state === "needs_input" && mapped.optionCount === 2, JSON.stringify(mapped).slice(0, 200));
  check("needs_input 的回复是纯文本编号选项", /1\) A/.test(mapped.replyText) && /请回复对应序号/.test(mapped.replyText), mapped.replyText);
}
check("桥接 completed → 三态 completed 且带回复", mapBridgeResponse({ status: "completed", state: "completed", replies: ["最终答复"] }).state === "completed");
check("桥接 aborted → 三态 aborted", mapBridgeResponse({ status: "aborted", state: "aborted", sessionId: "s1" }).state === "aborted");
check("桥接 merged → 合并态（窗口内复用）", mapBridgeResponse({ status: "merged", sessionId: "s1" }).state === "merged");

{
  const { result, logger, sink } = await run(receivedEvent({ context: { content: "请实现 D:\\ws\\repos 的补丁" } }), {
    response: fakeResponse(200, {
      status: "needs_input",
      state: "needs_input",
      sessionId: "webhook-q",
      question: "选哪个加载器？",
      options: [{ index: 1, label: "NeoForge（推荐）" }, { index: 2, label: "Fabric" }],
    }),
  });
  check("handler 把 needs_input 映射进返回值", result.state === "needs_input" && result.optionCount === 2, JSON.stringify(result));
  check("handler 日志里给出纯文本编号选项", logger.lines.some((line) => /1\) NeoForge/.test(line)), logger.lines.join(" | "));
  check("needs_input 写入审计日志（state=needs_input）", /state=needs_input/.test(sink.text()), sink.text().slice(-200));
}

{
  const { result, sink } = await run(receivedEvent({ context: { content: "请修复 D:\\ws 的报错" } }), {
    response: fakeResponse(200, { status: "aborted", state: "aborted", sessionId: "webhook-ab" }),
  });
  check("aborted 被如实回传（不伪装成 completed）", result.state === "aborted" && result.replyText === "", JSON.stringify(result));
  check("aborted 写入审计日志", /state=aborted/.test(sink.text()));
}

// ── 6. 审计日志与配置/健壮性 ───────────────────────────────────────────────
group("6. 审计日志、配置与健壮性");

{
  const sink = makeLogSink();
  const wrote = appendForwardLog({ forwardLog: "Z:\\x\\bridge-forward.log" }, "hello", { appendLog: sink.appendLog, now: () => FIXED_NOW });
  check("审计日志带 ISO 时间戳", wrote === true && /^\[\d{4}-\d{2}-\d{2}T/.test(sink.text()), sink.text());
  check("日志路径为空时不写、不抛错", appendForwardLog({ forwardLog: "" }, "x", { appendLog: () => { throw new Error("should not be called"); } }) === false);
  check("写入失败被吞掉（不抛错）", appendForwardLog({ forwardLog: "Z:\\x" }, "x", { appendLog: () => { throw new Error("EACCES"); } }) === false);
}

{
  const broken = await run(receivedEvent({ context: { content: "请修复 D:\\ws 的报错" } }), {
    extra: { fetch: null },
  });
  check("运行时不提供 fetch（显式禁用）时安全跳过", broken.result.skipped === RULES.NO_FETCH, JSON.stringify(broken.result));
}

{
  const { result } = await run(receivedEvent({ context: { content: "请修复 D:\\ws 的报错" } }), {
    env: { DSH_BRIDGE_URL: "file:///etc/passwd", DSH_BRIDGE_SECRET: SECRET, DSH_BRIDGE_COALESCE_MS: "0" },
  });
  check("非 http(s) URL 被拒（bad-url）", result.skipped === RULES.BAD_URL, JSON.stringify(result));
}

{
  const { result, logger } = await run(receivedEvent({ context: { content: "请修复 D:\\ws 的报错" } }), {
    env: { DSH_BRIDGE_SECRET: SECRET, DSH_BRIDGE_COALESCE_MS: "0" },
  });
  check("缺 URL 时跳过并告警", result.skipped === RULES.UNCONFIGURED && logger.lines.some((line) => line.includes("DSH_BRIDGE_URL")), JSON.stringify(result));
}

{
  const { result, logger } = await run(receivedEvent({ context: { content: "请修复 D:\\ws 的报错" } }), {
    response: () => {
      throw new Error(`connect ECONNREFUSED 127.0.0.1:25567 (Bearer ${SECRET})`);
    },
  });
  check("网络异常被吞掉并返回 ok=false", result.ok === false, JSON.stringify(result));
  check("异常日志不含密钥明文", logger.lines.every((line) => !line.includes(SECRET)), logger.lines.join(" | "));
}

{
  const { result, logger } = await run(receivedEvent({ context: { content: "请修复 D:\\ws 的报错" } }), {
    response: fakeResponse(401, { status: "error", code: 401, message: "invalid bridge secret" }),
  });
  check("401 被记录且不抛错", result.ok === false && result.status === 401, JSON.stringify(result));
  check("错误响应里的事件正文不被回显到日志（logBody 关闭）", logger.lines.every((line) => !line.includes("请修复 D:\\ws 的报错")));
}

{
  const resolved = resolveConfig(receivedEvent(), { env: { DSH_BRIDGE_FORWARD_PREFIX: "#go", DSH_BRIDGE_DEFAULT_DECISION: "forward" }, readFile: missingReadFile });
  check("判断配置可被环境变量覆盖（前缀/默认结果）", resolved.config.forwardPrefix === "#go" && resolved.config.defaultDecision === "forward");
  check("判断开关默认 on、合并窗口默认 1500ms", resolved.config.judgment === "on" && resolved.config.coalesceMs === 1500);
  check("默认日志路径落在 stateDir/logs 下", resolved.config.forwardLog.replace(/\\/g, "/").endsWith(".openclaw/logs/bridge-forward.log"), resolved.config.forwardLog);
}

check("redact 抹掉密钥", redact(`secret=${SECRET}`, SECRET) === "secret=<redacted>");
check("buildPayload 携带 fragments 与 forwardRule（供桥接判断亲和）", buildPayload({ text: "x", fragments: 3, forwardRule: "capability-path" }, { includeTitle: false, workspacePath: "", wait: true }).fragments === 3);
check("extractOutbound 抽出 message:sent 内容", extractOutbound(sentEvent("abc")).text === "abc");
check("extractMessage 抽出正文/发送者/会话", extractMessage(receivedEvent()).conversationId === "conv-placeholder");
check("formatOptionsText 在无选项时给出可读退路", formatOptionsText([]).includes("请直接回复你的选择内容"));

// ── 7. 真实磁盘守卫（本测试自身不得污染 ~/.openclaw） ──────────────────────
group("7. 真实磁盘守卫");

{
  const after = (() => {
    if (!existsSync(REAL_LOG_GUARD.path)) return { existed: false, size: 0, mtimeMs: 0 };
    const info = statSync(REAL_LOG_GUARD.path);
    return { existed: true, size: info.size, mtimeMs: info.mtimeMs };
  })();
  check(
    `默认审计日志路径在测试前后未被创建/改动（${REAL_LOG_GUARD.path}）`,
    after.existed === REAL_LOG_GUARD.existed && after.size === REAL_LOG_GUARD.size && after.mtimeMs === REAL_LOG_GUARD.mtimeMs,
    `before=${JSON.stringify(REAL_LOG_GUARD)} after=${JSON.stringify(after)}`,
  );
  check("默认审计日志路径确实位于 stateDir 下（默认值符合设计）", /[\\/]\.openclaw[\\/]logs[\\/]bridge-forward\.log$/i.test(REAL_LOG_GUARD.path) || REAL_LOG_GUARD.path.includes("logs"), REAL_LOG_GUARD.path);
  // t9：把原先恒真的那条断言换成对**实际注入行为**的检查——
  // 每次 run() 都必须把写入器注入进去，且 handler 必须真的写入（否则那次调用会落到真实 stateDir）。
  const runsWithoutWrites = RUN_LOG_AUDIT.filter((entry) => entry.lines === 0);
  const runsWritingElsewhere = RUN_LOG_AUDIT.filter((entry) => entry.offPlaceholderPaths.length > 0);
  check(
    "每次 handleMessage 调用都通过注入的写入器至少写了 1 行审计（无调用漏注入 appendLog）",
    RUN_LOG_AUDIT.length >= 15 && runsWithoutWrites.length === 0,
    `runs=${RUN_LOG_AUDIT.length} zeroWriteRuns=${JSON.stringify(runsWithoutWrites.slice(0, 3))}`,
  );
  check(
    "所有 run() 的审计写入都落在注入的占位路径上（没有任何一次写真实 stateDir）",
    runsWritingElsewhere.length === 0,
    JSON.stringify(runsWritingElsewhere.slice(0, 3)),
  );
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log(`\n---- test-handler 汇总：${passed} passed, ${failures.length} failed ----`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAILED: ${failure}`);
  process.exit(1);
}
console.log("全部断言通过。");
process.exit(0);
