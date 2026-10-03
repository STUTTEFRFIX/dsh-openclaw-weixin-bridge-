/**
 * dsh-bridge — OpenClaw 内部 hook 处理器（t6 修复版）
 *
 * 作用
 *   把**确实需要 DSH 本地能力**的微信入站消息转发给 DSH 的 webhook 桥接端点
 *   （`plugins/dsh-webhook-bridge` 的精确路由，默认 `/openclaw-wechat`）；DSH 为每次派发创建
 *   一个新会话并把正文作为 prompt 投递。本 handler 再把回合状态（completed / needs_input /
 *   aborted）写进审计日志，并把 needs_input 的选项转成**纯文本编号**。
 *   订阅两个事件：
 *     - `message:received` —— 入站消息（判断 → 合并 → 转发）
 *     - `message:sent`     —— 出站消息（记入自回环标记环，防止 hook→DSH→hook 循环）
 *
 * 为什么要判断（t6 缺陷 1、3）
 *   旧版本对每条入站消息无条件转发 ⇒ 一句闲聊也建一个新会话；实测 webhook 会话 35→36 个。
 *   用户明确说过“别用桥接器”，但只改了 AGENTS.md —— 那是约束 agent 主动调用的**另一条路径**，
 *   通道层 hook 照样转发，这就是“我说了别用还在用”的根因。
 *
 * 判断规则的**代价**（务必知悉）
 *   默认**保守**：无法判定“需要 DSH 本地能力”的消息一律跳过（不建会话）。
 *   代价是可能漏掉一些用户其实想交给 DSH 的模糊消息。三种显式解除方式：
 *     1) 消息以约定的显式前缀开头（默认 `#dsh `）→ 无视判断直接转发；
 *     2) `DSH_BRIDGE_DEFAULT_DECISION=forward` → 把“无法判定”改成转发；
 *     3) `DSH_BRIDGE_JUDGMENT=off` → 关闭**内容判断**（闲聊/能力信号那部分），
 *        但「回复标记 + 出站标记环」两条自回环过滤仍然生效（否则循环会重新出现）。
 *   判断结果、命中规则、合一/节流结果都会写进 bridge-forward.log，可事后审计。
 *
 * 防自回环（t6 的 I8 条目）
 *   出站消息会以 `message:sent` 回到 hook；hook 把“自己刚发出的文本 + 时间”记进有上限的标记环，
 *   `message:received` 命中标记环（或来自 bot/自身账号、或带回复标记 `[dsh]`）就跳过转发并记日志。
 *
 * 契约依据（均为磁盘上的权威来源，写实现前已逐条核对）
 *   1) 事件键集合：`~/.dsh-win/node/node_modules/openclaw/dist/internal-hook-types-Deg4lhm7.mjs`
 *      的 `KNOWN_INTERNAL_HOOK_EVENT_KEYS` 含 `message:received` 与 `message:sent`
 *      （同数组还有 `message:preprocessed`、`message:transcribed`）。
 *   2) 事件上下文：openclaw 自带 `docs/automation/hooks/event-types.md`
 *      —— `message:received` 的 context 含 `from`、`content`、`channelId`，可选 `metadata`
 *      （`senderId` 等）；`message:sent` 含 `to`、`content`、`success`、`channelId`。
 *   3) hook 目录/handler 契约：`docs/automation/hooks/writing-hooks.md`（默认导出、
 *      `(event) => void | Promise<void>`；候选文件名 handler.ts → handler.js → index.ts → index.js；
 *      回复投递边界见其 Reply delivery 表——message 事件的 event.messages 会被忽略，
 *      所以本 handler 不写 event.messages，不制造“已回复微信”的假象）。
 *   4) 配置读取：`docs/automation/hooks/configuration.md`（per-hook env 不改写 process.env；
 *      可从 `event.context.cfg?.hooks?.internal?.entries?.["<hookKey>"]?.env` 读；但
 *      `message:received` 不保证带 `cfg`，可靠来源是进程环境变量或旁挂 JSON）。
 *      状态目录环境变量 `OPENCLAW_STATE_DIR` 见 `docs/openclaw-agent-runtime.md`。
 *   5) DSH 侧请求/响应契约：本仓库 `plugins/dsh-webhook-bridge/lib/index.js`
 *      （`POST` + JSON、`Authorization: Bearer`、请求体 `{text,title?,workspacePath?,sender?,
 *      conversationId?,fragments?,forwardRule?,wait?}`，响应 `{status, state, sessionId,
 *      replyText?, replies?, options?, question?, multiSelect?}`）。
 *   6) 回合状态取值来自本机真实会话日志（`~/.dsh/sessions/<工作区>/<会话>/session.v4.jsonl.zstd`，只读）：
 *      `turn/end.reason.kind` 实测为 completed / aborted / error / blocked；选择项工具名
 *      `ask_user_question`（83 次真实调用样本）。
 *
 * 安全
 *   - 只把消息正文 POST 到显式配置的 http(s) URL；未配置时静默跳过（只告警）。
 *   - 共享密钥只从配置读取，不写日志；日志输出统一过 redact()。
 *   - 消息正文默认不写日志（`logBody` 打开才写）。
 */
import { readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join as joinPath } from "node:path";

/** HOOK.md 的 metadata.openclaw.hookKey 未显式声明时，配置项键等于 hook 名。 */
const HOOK_KEY = "dsh-bridge";

/** 默认只处理微信通道的事件；可用 channels 覆盖。 */
const DEFAULT_CHANNELS = Object.freeze(["openclaw-weixin"]);

/**
 * 判断与节流的可配置常量（全部可用环境变量 / 旁挂 JSON 覆盖）。
 * 这些值是 t6 修复的核心旋钮；改动它们的代价见文件头注释。
 */
const JUDGMENT_CONFIG = Object.freeze({
  /** 判断开关：on = 有判断的转发（默认）；off = 只过滤自回环/空消息。 */
  judgment: "on",
  /** 允许转发的通道 id 列表。 */
  channels: DEFAULT_CHANNELS,
  /** DSH 桥接端点（必填，否则只记日志不转发）。 */
  url: "",
  /** 与桥接共享的密钥（必填）。 */
  secret: "",
  /** 传给桥接的工作区路径（可选）。 */
  workspacePath: "",
  /** 是否用正文派生会话标题。 */
  includeTitle: false,
  /** 是否把正文/回复全文写日志（默认只写长度）。 */
  logBody: false,
  /**
   * 结果回传开关（`DSH_BRIDGE_ECHO_BACK` / `echoBack`）。
   * **预留：已解析但尚未消费**——当前代码只把它读进配置，不做任何出站发送。
   * 它将用于「在自回环标记环保护下，把 DSH 的结果/needs_input 选项发回微信」；
   * 在实现落地前，设置它不会有任何行为（文档也如此标注）。
   */
  echoBack: false,
  /** 无法判定时的默认结果：skip（保守，推荐）| forward。 */
  defaultDecision: "skip",
  /** 显式覆盖前缀：消息以此开头则无视判断直接转发（前缀本身不转发）。 */
  forwardPrefix: "#dsh",
  /** 自回环标记环的时间窗（毫秒）。 */
  loopWindowMs: 180000,
  /** 自回环标记环的最大条目数。 */
  loopRingSize: 50,
  /** 回复标记：出站文本以此开头即视为本桥接的回传，入站命中即跳过。 */
  replyMarker: "[dsh]",
  /** bot/自身账号 id 列表（来自这些 sender 的消息一律跳过）。 */
  botIds: Object.freeze([]),
  /** 同源多段合并的静默窗口（毫秒）；0 = 不合并（立即转发）。 */
  coalesceMs: 1500,
  /** 合并窗口的硬上限（毫秒），避免长消息流把派发无限推迟。 */
  coalesceMaxMs: 5000,
  /** 一次合并最多几段 / 多少字符。 */
  maxFragments: 20,
  maxMergedChars: 8000,
  /** “短消息”阈值：闲聊/确认类判断只在不超过该长度时才生效。 */
  shortMessageMaxChars: 12,
  /** “值得转发”的长度阈值。 */
  capabilityMinChars: 30,
  /** 转发 HTTP 超时（毫秒）；必须大于桥接侧 waitTimeoutMs（默认 120000）。 */
  timeoutMs: 130000,
  /** 是否让桥接等本轮结束（只有 true 才能拿到 completed/needs_input/aborted 三态）。 */
  wait: true,
});

/** 判断规则名（写进 bridge-forward.log 的 rule= 字段，便于事后审计）。 */
const RULES = Object.freeze({
  EVENT: "event",
  EMPTY: "empty",
  CHANNEL: "channel",
  OVERRIDE_PREFIX: "override-prefix",
  SELF_LOOP_ECHO: "self-loop-echo",
  SELF_LOOP_SENDER: "self-loop-sender",
  SELF_LOOP_MARKER: "self-loop-marker",
  GREETING: "greeting",
  ACK: "ack",
  EMOJI_ONLY: "emoji-only",
  CONFIRMATION: "confirmation",
  FOLLOW_UP: "follow-up",
  CAPABILITY_PATH: "capability-path",
  CAPABILITY_COMMAND: "capability-command",
  CAPABILITY_KEYWORD: "capability-keyword",
  CAPABILITY_MULTILINE: "capability-multiline",
  CAPABILITY_LENGTH: "capability-length",
  DEFAULT_SKIP: "default-skip",
  DEFAULT_FORWARD: "default-forward",
  UNCONFIGURED: "unconfigured",
  BAD_URL: "bad-url",
  NO_FETCH: "no-fetch",
  COALESCED: "coalesced",
  COALESCED_DEDUPED: "coalesced-deduped",
});

/** 判断用的模式（全部可读、可审计；命中即按对应规则跳过或转发）。 */
const PATTERNS = Object.freeze({
  greeting:
    /^(?:你好|您好|哈喽|哈啰|哈罗|嗨|hi|hello|hey|早上好|中午好|下午好|晚上好|早安|晚安|在吗|在么|在不在)[!！。.?？~～\s]*$/i,
  ack: /^(?:谢谢|多谢|感谢|thanks|thank you|thx|辛苦了|收到|了解|明白|明白啦|知道了|好嘞|搞定了|ok|okay|嗯嗯|嗯|哦|噢|好的|好吧|可以的|行|没事|不用了|算了|哈哈哈+|呵呵|笑死|🙏)[!！。.?？~～\s]*$/i,
  emojiOnly: /^(?:[\s\p{Extended_Pictographic}\p{Emoji_Presentation}\uFE0F\u200D]|[!！?？。.~～,，、…]+)+$/u,
  confirmation:
    /^(?:好|好的|行|可以|可以吗|继续|继续吧|接着|下一步|没问题|不对|不是|别用|不要|别|算了|停|等下|稍等|嗯|哦|啊)[!！。.?？~～\s]*$/i,
  followUp: /(?:呢|吗|吧|么|咋样|怎么样|如何)[?？\s]*$/,
  pathSignal: /(?:[A-Za-z]:[\\/]|\\\\|(?:^|\s)[./~][\\/])/,
  commandSignal:
    /(?:```|`[^`]+`|(?:^|\s)(?:npm|pnpm|yarn|node|npx|pwsh|powershell|cmd|git|python|pip|go|cargo|dotnet|java|javac|gradle|mvn|docker|kubectl|curl|ssh|scp|tar|make|cmake)\s|(?:^|\s)[$#>]\s)/i,
  keywordSignal:
    /(?:文件|目录|文件夹|仓库|代码|脚本|命令|运行|执行|编译|构建|部署|安装|配置|修改|改动|修复|报错|错误|异常|日志|端口|进程|服务|测试|接口|数据库|补丁|提交|审核|实现|重构|排查|诊断|崩溃|性能|路径|环境变量|依赖|版本|代码库|diff|review|file|directory|folder|repo|repository|code|script|command|run|execute|build|deploy|install|config|patch|error|exception|log|port|process|service|test|api|database|bug|fix|refactor|migrate)/i,
});

/** 判断结论常量（只读，便于测试引用）。 */
const DECISION = Object.freeze({ FORWARD: "forward", SKIP: "skip" });

function asTrimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asBoolean(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const lowered = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(lowered)) return true;
    if (["0", "false", "no", "off", ""].includes(lowered)) return false;
  }
  return fallback;
}

function asNonNegativeInt(value, fallback) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function asStringList(value, fallback) {
  if (Array.isArray(value)) {
    const list = value.map(asTrimmedString).filter((item) => item !== "");
    return list.length > 0 ? list : fallback;
  }
  const single = asTrimmedString(value);
  if (single === "") return fallback;
  const list = single
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "");
  return list.length > 0 ? list : fallback;
}

/** 旁挂配置文件（DSH_BRIDGE_HOOK_CONFIG 可覆盖）的默认位置。 */
export function defaultConfigPath(env = process.env) {
  const stateDir = asTrimmedString(env?.OPENCLAW_STATE_DIR) || joinPath(homedir(), ".openclaw");
  return joinPath(stateDir, "dsh-bridge-hook.json");
}

/** 判断日志（bridge-forward.log）的默认位置。 */
export function defaultForwardLogPath(env = process.env) {
  const stateDir = asTrimmedString(env?.OPENCLAW_STATE_DIR) || joinPath(homedir(), ".openclaw");
  return joinPath(stateDir, "logs", "bridge-forward.log");
}

/** 从事件里取出 per-hook env（文档给出的路径；message 事件不保证存在）。 */
export function readEventHookEnv(event) {
  const entries = event?.context?.cfg?.hooks?.internal?.entries;
  const env = entries?.[HOOK_KEY]?.env;
  return env !== null && typeof env === "object" && !Array.isArray(env) ? env : {};
}

/** 把「进程环境变量」或「per-hook env」映射到内部字段（只保留显式给出的项）。 */
function pickEnvironmentOverrides(source) {
  if (source === null || typeof source !== "object") return {};
  const overrides = {};
  const putString = (envKey, field) => {
    const value = asTrimmedString(source[envKey]);
    if (value !== "") overrides[field] = value;
  };
  putString("DSH_BRIDGE_URL", "url");
  putString("DSH_BRIDGE_SECRET", "secret");
  putString("DSH_BRIDGE_WORKSPACE", "workspacePath");
  putString("DSH_BRIDGE_FORWARD_LOG", "forwardLog");
  putString("DSH_BRIDGE_HOOK_CONFIG", "configFile");
  putString("DSH_BRIDGE_FORWARD_PREFIX", "forwardPrefix");
  putString("DSH_BRIDGE_REPLY_MARKER", "replyMarker");

  if (asTrimmedString(source.DSH_BRIDGE_CHANNELS) !== "") overrides.channels = asStringList(source.DSH_BRIDGE_CHANNELS, DEFAULT_CHANNELS);
  if (asTrimmedString(source.DSH_BRIDGE_BOT_IDS) !== "") overrides.botIds = asStringList(source.DSH_BRIDGE_BOT_IDS, []);

  for (const [envKey, field] of [
    ["DSH_BRIDGE_WAIT", "wait"],
    ["DSH_BRIDGE_INCLUDE_TITLE", "includeTitle"],
    ["DSH_BRIDGE_LOG_BODY", "logBody"],
    ["DSH_BRIDGE_ECHO_BACK", "echoBack"],
  ]) {
    if (source[envKey] !== undefined) overrides[field] = asBoolean(source[envKey], JUDGMENT_CONFIG[field]);
  }

  for (const [envKey, field] of [
    ["DSH_BRIDGE_TIMEOUT_MS", "timeoutMs"],
    ["DSH_BRIDGE_COALESCE_MS", "coalesceMs"],
    ["DSH_BRIDGE_LOOP_WINDOW_MS", "loopWindowMs"],
    ["DSH_BRIDGE_MAX_FRAGMENTS", "maxFragments"],
    ["DSH_BRIDGE_MAX_MERGED_CHARS", "maxMergedChars"],
  ]) {
    if (source[envKey] !== undefined && asTrimmedString(source[envKey]) !== "") {
      overrides[field] = asNonNegativeInt(source[envKey], JUDGMENT_CONFIG[field]);
    }
  }
  // 注意：节流间隔（minInterval）**不是 hook 侧配置**，而是 DSH 桥接插件的 `minIntervalMs`
  // （见 plugins/dsh-webhook-bridge/cordis.patch.yml）。此前这里误解析 DSH_BRIDGE_MIN_INTERVAL_MS，
  // 设了也不生效，t9 已删除，避免误导。

  if (source.DSH_BRIDGE_JUDGMENT !== undefined) {
    const value = asTrimmedString(source.DSH_BRIDGE_JUDGMENT).toLowerCase();
    if (["on", "off"].includes(value)) overrides.judgment = value;
  }
  if (source.DSH_BRIDGE_DEFAULT_DECISION !== undefined) {
    const value = asTrimmedString(source.DSH_BRIDGE_DEFAULT_DECISION).toLowerCase();
    if (["skip", "forward"].includes(value)) overrides.defaultDecision = value;
  }
  return overrides;
}

/** 把旁挂 JSON 的 camelCase 字段映射到内部字段。 */
function pickFileOverrides(source) {
  if (source === null || typeof source !== "object" || Array.isArray(source)) return {};
  const overrides = {};
  for (const field of ["url", "secret", "workspacePath", "forwardLog", "forwardPrefix", "replyMarker", "judgment", "defaultDecision"]) {
    const value = asTrimmedString(source[field]);
    if (value !== "") overrides[field] = value;
  }
  for (const field of ["wait", "includeTitle", "logBody", "echoBack"]) {
    if (source[field] !== undefined) overrides[field] = asBoolean(source[field], JUDGMENT_CONFIG[field]);
  }
  for (const field of ["timeoutMs", "coalesceMs", "loopWindowMs", "maxFragments", "maxMergedChars"]) {
    if (source[field] !== undefined && asTrimmedString(source[field]) !== "") {
      overrides[field] = asNonNegativeInt(source[field], JUDGMENT_CONFIG[field]);
    }
  }
  if (source.channels !== undefined) overrides.channels = asStringList(source.channels, DEFAULT_CHANNELS);
  if (source.botIds !== undefined) overrides.botIds = asStringList(source.botIds, []);
  return overrides;
}

/**
 * 解析本次调用要用的配置（不抛异常）。
 * 优先级：JUDGMENT_CONFIG 默认值 < 旁挂 JSON < 进程环境变量 < 事件内 per-hook env。
 */
export function resolveConfig(event = {}, deps = {}) {
  const env = deps.env ?? process.env;
  const readFile = typeof deps.readFile === "function" ? deps.readFile : (filePath) => readFileSync(filePath, "utf8");

  const eventEnv = readEventHookEnv(event);
  const configPath =
    asTrimmedString(eventEnv.DSH_BRIDGE_HOOK_CONFIG) ||
    asTrimmedString(env?.DSH_BRIDGE_HOOK_CONFIG) ||
    defaultConfigPath(env);

  let fileConfig = {};
  let fileError = "";
  try {
    const parsed = JSON.parse(String(readFile(configPath)));
    fileConfig = parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch (error) {
    fileError = redact(String(error));
  }

  const config = Object.freeze({
    ...JUDGMENT_CONFIG,
    forwardLog: defaultForwardLogPath(env),
    configFile: configPath,
    echoBack: false,
    ...pickFileOverrides(fileConfig),
    ...pickEnvironmentOverrides(env),
    ...pickEnvironmentOverrides(eventEnv),
  });

  return { config, configPath, fileError, eventEnv };
}

/** 日志脱敏：抹掉配置里的密钥与任何 Bearer 载荷。 */
export function redact(text, secret = "") {
  let out = String(text ?? "");
  const trimmed = asTrimmedString(secret);
  if (trimmed.length >= 4) out = out.split(trimmed).join("<redacted>");
  out = out.replace(/(Bearer\s+)[^\s"']+/gi, "$1<redacted>");
  return out;
}

/** 从事件里抽出要转发的消息事实（入站）。 */
export function extractMessage(event = {}) {
  const context = event?.context ?? {};
  const metadata = context.metadata !== null && typeof context.metadata === "object" ? context.metadata : {};
  const senderIdentities = [
    asTrimmedString(context.from),
    asTrimmedString(metadata.senderId),
    asTrimmedString(metadata.senderUsername),
    asTrimmedString(metadata.senderE164),
    asTrimmedString(context.senderId),
  ].filter((value) => value !== "");
  return {
    text: asTrimmedString(context.content),
    channelId: asTrimmedString(context.channelId),
    sender: asTrimmedString(context.from) || asTrimmedString(metadata.senderId),
    senderIdentities: [...new Set(senderIdentities)],
    accountId: asTrimmedString(context.accountId) || asTrimmedString(metadata.accountId),
    conversationId: asTrimmedString(context.conversationId) || asTrimmedString(metadata.threadId) || asTrimmedString(context.chatId),
    messageId: asTrimmedString(context.messageId),
    fromMeFlag: metadata.fromMe === true || metadata.isBot === true || metadata.self === true || context.fromMe === true,
    mediaCount: (Array.isArray(context.media) ? context.media.length : 0) + (Array.isArray(context.originalMedia) ? context.originalMedia.length : 0),
    mediaStagingPending: context.mediaStagingPending === true,
  };
}

/** 从 `message:sent` 事件里抽出出站文本（用于自回环标记环）。 */
export function extractOutbound(event = {}) {
  const context = event?.context ?? {};
  return {
    text: asTrimmedString(context.content),
    channelId: asTrimmedString(context.channelId),
    to: asTrimmedString(context.to),
    success: context.success !== false,
  };
}

/** 文本归一化：用于自回环比对（折叠空白、去标记、去成对引号）。 */
export function normalizeForLoop(text, marker = "") {
  let value = asTrimmedString(text).replace(/\s+/g, " ");
  const mark = asTrimmedString(marker);
  if (mark !== "" && value.startsWith(mark)) value = value.slice(mark.length).trim();
  return value.replace(/^[「『"'`“‘]+|[」』"'`”’]+$/g, "").trim();
}

/**
 * 自回环标记环：记录本进程刚发出的出站文本，入站时比对。
 * 有上限、有时间窗；命中即跳过转发（避免 hook→DSH→hook 循环凭空产生会话）。
 */
export class EchoRing {
  constructor({ maxEntries = JUDGMENT_CONFIG.loopRingSize, windowMs = JUDGMENT_CONFIG.loopWindowMs, marker = JUDGMENT_CONFIG.replyMarker } = {}) {
    this.maxEntries = maxEntries;
    this.windowMs = windowMs;
    this.marker = marker;
    this.entries = [];
  }

  get size() {
    return this.entries.length;
  }

  record(text, now, meta = {}) {
    const normalized = normalizeForLoop(text, this.marker);
    if (normalized === "") return undefined;
    const entry = { normalized, at: now, meta };
    this.entries.push(entry);
    while (this.entries.length > this.maxEntries) this.entries.shift();
    return entry;
  }

  /** @returns {null | {reason: string, at: number, overlap: number}} */
  match(text, now) {
    const normalized = normalizeForLoop(text, this.marker);
    if (normalized === "") return null;
    for (let index = this.entries.length - 1; index >= 0; index -= 1) {
      const entry = this.entries[index];
      if (now - entry.at > this.windowMs) continue;
      if (entry.normalized === normalized) return { reason: "exact", at: entry.at, overlap: normalized.length };
      const shorter = Math.min(entry.normalized.length, normalized.length);
      if (shorter >= 24) {
        const head = entry.normalized.slice(0, shorter);
        if (head === normalized.slice(0, shorter)) return { reason: "prefix", at: entry.at, overlap: shorter };
      }
    }
    return null;
  }

  /** 出站文本是否带回复标记（带标记 = 由本桥接回传产生）。 */
  hasMarker(text) {
    const mark = asTrimmedString(this.marker);
    return mark !== "" && asTrimmedString(text).startsWith(mark);
  }

  prune(now) {
    const before = this.entries.length;
    this.entries = this.entries.filter((entry) => now - entry.at <= this.windowMs);
    return before - this.entries.length;
  }
}

/**
 * 转发判断。返回 `{decision, rule, text}`，text 已去掉显式前缀。
 * 判定顺序（t9 修正：自回环过滤**不受 judgment 开关影响**，永远先跑）：
 *   显式前缀 → 回复标记 → 自回环标记环 → 判断开关（off 即转发）→ 闲聊/确认类（仅短消息）
 *   → 能力信号（路径/命令/关键词/多行/长度）→ 默认结果。
 */
export function decideForward({ text, judgment, defaultDecision, forwardPrefix, echoRing, now, config = {} }) {
  const raw = asTrimmedString(text);
  const prefix = asTrimmedString(forwardPrefix) || JUDGMENT_CONFIG.forwardPrefix;
  if (prefix !== "" && raw.toLowerCase().startsWith(prefix.toLowerCase())) {
    return { decision: DECISION.FORWARD, rule: RULES.OVERRIDE_PREFIX, text: raw.slice(prefix.length).trim() || raw };
  }
  // 自回环过滤（回复标记 + 出站标记环）：无论 judgment 开关如何都必须生效，
  // 否则 judgment=off 时 hook→DSH→hook 的循环会重新出现（文档所说的“只剩自回环过滤”即指这两条）。
  if (echoRing !== undefined && echoRing !== null && echoRing.hasMarker(raw)) {
    return { decision: DECISION.SKIP, rule: RULES.SELF_LOOP_MARKER, text: raw };
  }
  const hit = echoRing?.match(raw, now);
  if (hit) return { decision: DECISION.SKIP, rule: RULES.SELF_LOOP_ECHO, text: raw, detail: hit };
  if (asTrimmedString(judgment).toLowerCase() === "off") {
    return { decision: DECISION.FORWARD, rule: RULES.DEFAULT_FORWARD, text: raw };
  }

  const shortMax = asNonNegativeInt(config.shortMessageMaxChars, JUDGMENT_CONFIG.shortMessageMaxChars);
  const capabilityMin = asNonNegativeInt(config.capabilityMinChars, JUDGMENT_CONFIG.capabilityMinChars);
  const isShort = raw.length <= shortMax;

  if (isShort) {
    if (PATTERNS.greeting.test(raw)) return { decision: DECISION.SKIP, rule: RULES.GREETING, text: raw };
    if (PATTERNS.ack.test(raw)) return { decision: DECISION.SKIP, rule: RULES.ACK, text: raw };
    if (PATTERNS.emojiOnly.test(raw)) return { decision: DECISION.SKIP, rule: RULES.EMOJI_ONLY, text: raw };
    if (PATTERNS.followUp.test(raw)) return { decision: DECISION.SKIP, rule: RULES.FOLLOW_UP, text: raw };
    if (PATTERNS.confirmation.test(raw)) return { decision: DECISION.SKIP, rule: RULES.CONFIRMATION, text: raw };
  }

  if (PATTERNS.pathSignal.test(raw)) return { decision: DECISION.FORWARD, rule: RULES.CAPABILITY_PATH, text: raw };
  if (PATTERNS.commandSignal.test(raw)) return { decision: DECISION.FORWARD, rule: RULES.CAPABILITY_COMMAND, text: raw };
  if (PATTERNS.keywordSignal.test(raw)) return { decision: DECISION.FORWARD, rule: RULES.CAPABILITY_KEYWORD, text: raw };
  if (raw.includes("\n") && raw.length >= Math.max(16, Math.floor(capabilityMin / 2))) {
    return { decision: DECISION.FORWARD, rule: RULES.CAPABILITY_MULTILINE, text: raw };
  }
  if (raw.length >= capabilityMin) return { decision: DECISION.FORWARD, rule: RULES.CAPABILITY_LENGTH, text: raw };

  return asTrimmedString(defaultDecision).toLowerCase() === "forward"
    ? { decision: DECISION.FORWARD, rule: RULES.DEFAULT_FORWARD, text: raw }
    : { decision: DECISION.SKIP, rule: RULES.DEFAULT_SKIP, text: raw };
}

/** 由 origin 字段算出亲和键：优先 conversationId，其次 sender。 */
export function resolveOriginKey({ conversationId, sender } = {}) {
  const conversation = asTrimmedString(conversationId);
  if (conversation !== "") return `conv:${conversation}`;
  const from = asTrimmedString(sender);
  if (from !== "") return `sender:${from}`;
  return "anonymous";
}

/**
 * 同源多段合并 + 节流的**纯状态机**（时间由调用方注入，便于自测）。
 * 语义：
 *   - submit() 在静默窗口内收到的新段并入缓冲（窗口从最后一次提交重新计时，总时长不超过
 *     coalesceMaxMs），返回 buffered；
 *   - 等待静默窗口到期的调用方再调用 take()：第一个取到合并文本的调用负责派发**一次**，
 *     其余调用取不到内容（返回 undefined）→ 记 coalesced-deduped，不新建会话；
 *   - 同一来源有派发在途时（markInFlight）新段继续并入，不会并发新建会话。
 */
export class FragmentCoalescer {
  constructor({
    coalesceMs = JUDGMENT_CONFIG.coalesceMs,
    coalesceMaxMs = JUDGMENT_CONFIG.coalesceMaxMs,
    maxFragments = JUDGMENT_CONFIG.maxFragments,
    maxMergedChars = JUDGMENT_CONFIG.maxMergedChars,
  } = {}) {
    this.coalesceMs = coalesceMs;
    this.coalesceMaxMs = coalesceMaxMs;
    this.maxFragments = maxFragments;
    this.maxMergedChars = maxMergedChars;
    this.slots = new Map();
  }

  get size() {
    return this.slots.size;
  }

  snapshot(originKey) {
    if (originKey === undefined) return [...this.slots.values()].map((slot) => ({ ...slot, texts: [...slot.texts] }));
    const slot = this.slots.get(String(originKey));
    return slot === undefined ? undefined : { ...slot, texts: [...slot.texts] };
  }

  #slot(originKey, now) {
    const key = asTrimmedString(originKey) || "anonymous";
    let slot = this.slots.get(key);
    if (slot === undefined) {
      slot = { originKey: key, texts: [], firstAt: now, lastAt: now, inFlight: false, dispatches: 0 };
      this.slots.set(key, slot);
    }
    return slot;
  }

  /** 提交一段文本。 */
  submit({ originKey, text, now } = {}) {
    const at = Number.isFinite(now) ? now : 0;
    const slot = this.#slot(originKey, at);
    const chunk = asTrimmedString(text);
    slot.texts.push(chunk);
    slot.lastAt = at;

    if (this.coalesceMs <= 0) {
      return { action: "dispatch", reason: "immediate", originKey: slot.originKey, text: this.#join(slot), fragments: slot.texts.length };
    }
    if (slot.inFlight) {
      return { action: "buffered", reason: "in-flight", originKey: slot.originKey, fragments: slot.texts.length, flushAt: at + this.coalesceMs };
    }
    if (at - slot.firstAt >= this.coalesceMaxMs) {
      return { action: "dispatch", reason: "coalesce-max", originKey: slot.originKey, text: this.#join(slot), fragments: slot.texts.length };
    }
    return { action: "buffered", reason: RULES.COALESCED, originKey: slot.originKey, fragments: slot.texts.length, flushAt: at + this.coalesceMs };
  }

  /** 静默窗口到期后取走合并文本（取到者负责派发；取不到说明已被别的调用取走）。 */
  take(originKey) {
    const slot = this.slots.get(asTrimmedString(originKey) || "anonymous");
    if (slot === undefined) return undefined;
    const text = this.#join(slot);
    const fragments = slot.texts.filter((piece) => piece !== "").length;
    slot.texts = [];
    slot.firstAt = 0;
    slot.lastAt = 0;
    slot.dispatches += 1;
    if (text === "") return undefined;
    return { originKey: slot.originKey, text, fragments: Math.max(1, fragments) };
  }

  markInFlight(originKey, value = true) {
    const slot = this.slots.get(asTrimmedString(originKey) || "anonymous");
    if (slot === undefined) return undefined;
    slot.inFlight = value;
    return slot;
  }

  #join(slot) {
    const pieces = [];
    let length = 0;
    for (const piece of slot.texts) {
      if (piece === "") continue;
      if (pieces.length >= this.maxFragments) break;
      const remaining = this.maxMergedChars - length;
      if (remaining <= 0) break;
      pieces.push(piece.length > remaining ? piece.slice(0, remaining) : piece);
      length += pieces[pieces.length - 1].length + 2;
    }
    return pieces.join("\n\n").trim();
  }
}

/** 组装 DSH 桥接端点的请求体（只带 DSH 侧声明过的字段）。 */
export function buildPayload(message, config) {
  const text = asTrimmedString(message?.text);
  const payload = { text };
  if (config.includeTitle === true && text !== "") {
    const flattened = text.replace(/\s+/g, " ").trim();
    payload.title = flattened.length > 80 ? `${flattened.slice(0, 77)}...` : flattened;
  }
  if (config.workspacePath !== "") payload.workspacePath = config.workspacePath;
  const sender = asTrimmedString(message?.sender);
  if (sender !== "") payload.sender = sender;
  const conversationId = asTrimmedString(message?.conversationId);
  if (conversationId !== "") payload.conversationId = conversationId;
  if (Number.isFinite(message?.fragments) && message.fragments > 1) payload.fragments = message.fragments;
  if (asTrimmedString(message?.forwardRule) !== "") payload.forwardRule = asTrimmedString(message.forwardRule);
  payload.wait = config.wait === true;
  return payload;
}

/** 追加一行判断/回传审计日志（尽力而为，不抛错）。 */
export function appendForwardLog(config, line, deps = {}) {
  const target = asTrimmedString(config?.forwardLog);
  if (target === "") return false;
  const writer = typeof deps.appendLog === "function" ? deps.appendLog : (filePath, text) => appendFileSync(filePath, text, "utf8");
  const stampMs = typeof deps.now === "function" ? deps.now() : Date.now();
  try {
    writer(target, `[${new Date(stampMs).toISOString()}] ${line}\n`);
    return true;
  } catch {
    return false;
  }
}

/** 选项文本化：把 needs_input 的选项转成纯文本编号（微信可直接回复序号）。 */
export function formatOptionsText(options, { question = "", header = "", multiSelect = false } = {}) {
  const list = Array.isArray(options) ? options.filter((option) => option !== null && typeof option === "object") : [];
  const lines = ["DSH 需要你选择后才能继续。"];
  const title = asTrimmedString(question) || asTrimmedString(header);
  if (title !== "") lines.push(`问题：${title}`);
  if (list.length === 0) {
    lines.push("未解析到选项，请直接回复你的选择内容。");
    return lines.join("\n");
  }
  lines.push("请回复对应序号：");
  for (const [index, option] of list.entries()) {
    const label = asTrimmedString(option.label) || `选项 ${index + 1}`;
    const description = asTrimmedString(option.description);
    const number = Number.isInteger(option.index) ? option.index : index + 1;
    lines.push(`${number}) ${label}${description === "" ? "" : ` —— ${description}`}`);
  }
  if (multiSelect === true) lines.push("（可多选：回复如「1,3」）");
  return lines.join("\n");
}

/** 桥接响应 → 三态（completed / needs_input / aborted）+ 纯文本回复。 */
export function mapBridgeResponse(body) {
  const record = body !== null && typeof body === "object" ? body : {};
  const status = asTrimmedString(record.status);
  const state = asTrimmedString(record.state) || asTrimmedString(record.turnState);
  const replies = Array.isArray(record.replies) ? record.replies.filter((item) => typeof item === "string" && item.trim() !== "") : [];
  const replyText = asTrimmedString(record.replyText) || (replies.length > 0 ? replies[replies.length - 1].trim() : "");
  const sessionId = asTrimmedString(record.sessionId);

  if (status === "needs_input" || state === "needs_input") {
    return {
      state: "needs_input",
      kind: asTrimmedString(record.questionKind) || "question",
      sessionId,
      replyText: formatOptionsText(record.options, {
        question: record.question,
        header: record.questionHeader,
        multiSelect: record.multiSelect === true,
      }),
      optionCount: Array.isArray(record.options) ? record.options.length : 0,
      raw: record,
    };
  }
  if (status === "aborted" || state === "aborted") {
    return { state: "aborted", kind: asTrimmedString(record.abortKind) || "user", sessionId, replyText, raw: record };
  }
  if (status === "error" || state === "error") {
    return { state: "error", kind: asTrimmedString(record.kind) || "error", sessionId, replyText, raw: record };
  }
  if (state === "blocked") return { state: "blocked", kind: "blocked", sessionId, replyText, raw: record };
  if (status === "completed" || state === "completed") {
    return { state: "completed", kind: asTrimmedString(record.kind) || "completed", sessionId, replyText, raw: record };
  }
  if (status === "merged" || status === "deferred") {
    return { state: "merged", kind: status, sessionId, replyText, raw: record };
  }
  return { state: state === "running" ? "running" : "accepted", kind: asTrimmedString(record.kind) || status || "accepted", sessionId, replyText, raw: record };
}

/** 解析桥接端点的 JSON 响应（桥接失败时也会回 JSON）。 */
async function readResponseBody(response) {
  try {
    const parsed = JSON.parse(await response.text());
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 默认的静默等待（可被 deps.sleep 注入，便于自测）。 */
function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

/** 进程级共享状态（默认导出路径必须复用，否则标记环与合并槽每次调用都会丢）。 */
const sharedState = { ring: new EchoRing(), coalescer: new FragmentCoalescer(), inFlight: new Set() };

/**
 * 主逻辑。默认导出以 `{state: sharedState}` 调用；自测注入 fetch/env/logger/appendLog/now/sleep/state。
 * 任何路径都不向外抛异常：hook 抛错会污染宿主的消息处理链路。
 */
export async function handleMessage(event, deps = {}) {
  const logger = deps.logger ?? console;
  const logInfo = typeof logger.info === "function" ? (line) => logger.info(line) : () => {};
  const logWarn = typeof logger.warn === "function" ? (line) => logger.warn(line) : () => {};
  const clock = typeof deps.now === "function" ? deps.now : () => Date.now();
  const sleep = typeof deps.sleep === "function" ? deps.sleep : defaultSleep;
  const state = deps.state ?? sharedState;

  try {
    if (event === null || typeof event !== "object") return { ok: false, skipped: RULES.EVENT };
    const type = asTrimmedString(event.type);
    const action = asTrimmedString(event.action);

    const resolved = resolveConfig(event, deps);
    const config = resolved.config;
    const logConfig = { ...config, forwardLog: deps.forwardLogPath ?? config.forwardLog };
    const log = (line) => appendForwardLog(logConfig, line, { ...deps, now: clock });

    // 出站事件：只记入自回环标记环，不做任何转发。
    if (type === "message" && action === "sent") {
      const outbound = extractOutbound(event);
      if (outbound.text === "" || outbound.success === false) return { ok: true, recorded: false };
      const entry = state.ring.record(outbound.text, clock(), { channelId: outbound.channelId, to: outbound.to });
      state.ring.prune(clock());
      log(`sent channel=${outbound.channelId || "-"} to=${outbound.to || "-"} textLen=${outbound.text.length} ring=${state.ring.size}`);
      logInfo(`[${HOOK_KEY}] 出站入环 channel=${outbound.channelId || "-"} textLen=${outbound.text.length} ring=${state.ring.size}`);
      return { ok: true, recorded: entry !== undefined, ring: state.ring.size };
    }

    if (type !== "message" || action !== "received") return { ok: false, skipped: RULES.EVENT };

    const message = extractMessage(event);
    const originKey = resolveOriginKey({ conversationId: message.conversationId, sender: message.sender });
    const base = `enter type=message action=received channel=${message.channelId || "-"} from=${message.sender || "-"} origin=${originKey} textLen=${message.text.length}`;

    if (message.text === "") {
      log(`${base} decision=skip rule=${RULES.EMPTY} media=${message.mediaCount} staging=${message.mediaStagingPending}`);
      logInfo(`[${HOOK_KEY}] 跳过无正文消息 channel=${message.channelId || "-"} media=${message.mediaCount}`);
      return { ok: false, skipped: RULES.EMPTY };
    }
    if (config.channels.length > 0 && !config.channels.includes(message.channelId)) {
      log(`${base} decision=skip rule=${RULES.CHANNEL}`);
      logInfo(`[${HOOK_KEY}] 跳过非目标通道 channel=${message.channelId || "(unknown)"}`);
      return { ok: false, skipped: RULES.CHANNEL };
    }

    // 防自回环（发送者维度）：bot/自身账号、或事件自带的 fromMe/isBot 标记。
    // 注意：微信通道里 `context.from` 未必是 bot；bot 标识常出现在 `metadata.senderId`，
    // 因此对所有候选身份（from / metadata.senderId / senderUsername / senderE164 / context.senderId）逐一比对。
    const botIds = Array.isArray(config.botIds) ? config.botIds : [];
    const identities = Array.isArray(message.senderIdentities) ? message.senderIdentities : [];
    const matchedBotId = botIds.length > 0 ? identities.find((identity) => botIds.includes(identity)) : undefined;
    const selfAccount = message.accountId !== "" && identities.includes(message.accountId);
    if (message.fromMeFlag || matchedBotId !== undefined || selfAccount) {
      log(
        `${base} decision=skip rule=${RULES.SELF_LOOP_SENDER} fromMe=${message.fromMeFlag} ` +
          `matched=${matchedBotId ?? (selfAccount ? "accountId" : "-")} botIds=${botIds.length}`,
      );
      logInfo(`[${HOOK_KEY}] 跳过 bot/自身来源消息 identities=${identities.length}`);
      return { ok: false, skipped: RULES.SELF_LOOP_SENDER };
    }

    const decision = decideForward({
      text: message.text,
      judgment: config.judgment,
      defaultDecision: config.defaultDecision,
      forwardPrefix: config.forwardPrefix,
      echoRing: state.ring,
      now: clock(),
      config,
    });
    log(`${base} decision=${decision.decision} rule=${decision.rule}` + (decision.detail ? ` overlap=${decision.detail.overlap}` : ""));
    if (decision.decision === DECISION.SKIP) {
      logInfo(`[${HOOK_KEY}] 不转发（rule=${decision.rule}）origin=${originKey}`);
      return { ok: false, skipped: decision.rule };
    }

    const forwardText = decision.text === "" ? message.text : decision.text;

    if (config.url === "" || config.secret === "") {
      const missing = config.url === "" ? "DSH_BRIDGE_URL" : "DSH_BRIDGE_SECRET";
      log(`${base} decision=forward rule=${decision.rule} result=unconfigured missing=${missing}`);
      logWarn(`[${HOOK_KEY}] 缺少 ${missing}（进程环境变量或旁挂配置 ${resolved.configPath}），已跳过转发。`);
      return { ok: false, skipped: RULES.UNCONFIGURED };
    }
    if (!/^https?:\/\//i.test(config.url)) {
      log(`${base} decision=forward rule=${decision.rule} result=bad-url`);
      logWarn(`[${HOOK_KEY}] DSH 桥接 URL 必须是 http(s)，已跳过转发：${redact(config.url, config.secret)}`);
      return { ok: false, skipped: RULES.BAD_URL };
    }

    // deps.fetch === null 表示“明确禁用网络”（便于自测与离线部署）；undefined 则回退到全局 fetch。
    const doFetch = deps.fetch === null ? undefined : typeof deps.fetch === "function" ? deps.fetch : globalThis.fetch;
    if (typeof doFetch !== "function") {
      log(`${base} decision=forward rule=${decision.rule} result=no-fetch`);
      logWarn(`[${HOOK_KEY}] 当前 Node 运行时不提供 fetch，无法转发。`);
      return { ok: false, skipped: RULES.NO_FETCH };
    }

    // 同源多段合并 + 节流：窗口内合并且只派发一次。
    const submitted = state.coalescer.submit({ originKey, text: forwardText, now: clock() });
    let merged;
    if (submitted.action === "buffered") {
      log(`${base} decision=forward rule=${decision.rule} result=buffered reason=${submitted.reason} fragments=${submitted.fragments}`);
      logInfo(`[${HOOK_KEY}] 合并窗口内（${config.coalesceMs}ms）先缓冲 origin=${originKey} fragments=${submitted.fragments}`);
      await sleep(config.coalesceMs);
      merged = state.coalescer.take(originKey);
      if (merged === undefined) {
        log(`${base} decision=forward rule=${decision.rule} result=${RULES.COALESCED_DEDUPED}`);
        logInfo(`[${HOOK_KEY}] 该来源的合并文本已由另一次调用派发，本次不再新建会话 origin=${originKey}`);
        return { ok: false, skipped: RULES.COALESCED_DEDUPED, fragments: submitted.fragments };
      }
    } else {
      merged = state.coalescer.take(originKey) ?? { text: forwardText, fragments: 1 };
    }

    if (state.inFlight.has(originKey)) {
      state.coalescer.submit({ originKey, text: merged.text, now: clock() });
      state.coalescer.markInFlight(originKey, true);
      log(`${base} decision=forward rule=${decision.rule} result=in-flight-buffered`);
      return { ok: false, skipped: "in-flight", fragments: merged.fragments };
    }

    state.inFlight.add(originKey);
    state.coalescer.markInFlight(originKey, true);
    try {
      return await dispatchForward({
        payloadMessage: { ...message, text: merged.text, fragments: merged.fragments, forwardRule: decision.rule },
        config,
        doFetch,
        log,
        base,
        logger: logInfo,
        logWarn,
      });
    } finally {
      state.inFlight.delete(originKey);
      state.coalescer.markInFlight(originKey, false);
    }
  } catch (error) {
    logWarn(`[${HOOK_KEY}] 处理异常（已吞掉，避免中断宿主消息链路）：${redact(String(error))}`);
    return { ok: false, error: redact(String(error)) };
  }
}

/** 组装并发送一次转发请求，再把回执写进日志。 */
async function dispatchForward({ payloadMessage, config, doFetch, log, base, logger, logWarn }) {
  const payload = buildPayload(payloadMessage, config);
  const signal =
    config.timeoutMs > 0 && typeof AbortSignal !== "undefined" && typeof AbortSignal.timeout === "function"
      ? AbortSignal.timeout(config.timeoutMs)
      : undefined;

  let response;
  try {
    response = await doFetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        accept: "application/json",
        authorization: `Bearer ${config.secret}`,
      },
      body: JSON.stringify(payload),
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    const detail = redact(String(error), config.secret);
    log(`${base} result=failed err=${detail}`);
    logWarn(`[${HOOK_KEY}] 转发失败 url=${config.url} err=${detail}`);
    return { ok: false, error: detail };
  }

  const body = await readResponseBody(response);
  const status = typeof response?.status === "number" ? response.status : 0;
  if (!(status >= 200 && status < 300)) {
    const detail = redact(asTrimmedString(body.message) || asTrimmedString(body.error) || "(no message)", config.secret);
    log(`${base} result=http-error status=${status} msg=${detail}`);
    logWarn(`[${HOOK_KEY}] 桥接拒绝请求 status=${status} msg=${detail}`);
    return { ok: false, status, error: detail };
  }

  const mapped = mapBridgeResponse(body);
  log(
    `${base} result=ok status=${status} session=${mapped.sessionId || "-"} state=${mapped.state} kind=${mapped.kind} ` +
      `fragments=${payloadMessage.fragments ?? 1} replyLen=${mapped.replyText.length}`,
  );
  logger(
    `[${HOOK_KEY}] 已转发 channel=${payloadMessage.channelId} status=${status} state=${mapped.state} ` +
      `sessionId=${mapped.sessionId || "-"} fragments=${payloadMessage.fragments ?? 1} replyChars=${mapped.replyText.length}`,
  );
  if (mapped.state === "needs_input") {
    logger(`[${HOOK_KEY}] 回合需要用户选择（options=${mapped.optionCount}），已生成纯文本编号选项：`);
  }
  if (mapped.replyText !== "" && (config.logBody === true || mapped.state === "needs_input")) {
    logger(`[${HOOK_KEY}] ${mapped.state === "needs_input" ? "选项" : "DSH 回复"}：${redact(mapped.replyText, config.secret)}`);
  }

  return {
    ok: true,
    status,
    state: mapped.state,
    kind: mapped.kind,
    sessionId: mapped.sessionId,
    fragments: payloadMessage.fragments ?? 1,
    forwardRule: payloadMessage.forwardRule,
    replyText: mapped.replyText,
    optionCount: mapped.optionCount ?? 0,
  };
}

/**
 * hook 默认导出：OpenClaw 以 `(event) => void | Promise<void>` 调用。
 * 订阅 `message:received`（转发判断）与 `message:sent`（自回环标记环）；
 * 复用进程级 state，保证标记环与合并槽跨调用生效。
 */
export default async function dshBridgeHook(event) {
  await handleMessage(event, { state: sharedState });
}

export { JUDGMENT_CONFIG, PATTERNS, RULES, DECISION, HOOK_KEY, DEFAULT_CHANNELS, sharedState };
