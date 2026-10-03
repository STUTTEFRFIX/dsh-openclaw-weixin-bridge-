/**
 * dsh-webhook-bridge — DSH webhook 桥接插件
 *
 * 作用
 *   在本机注册一个受共享密钥保护的精确 POST 路由；每收到一个请求，
 *   就通过 DSH 官方的 webhook 运行时（ctx.webhookRuntime）创建一个
 *   **新的 Workspace 会话**并把请求里的文本作为 prompt 投递进去。
 *
 * 用途
 *   OpenClaw（微信 ClawBot）→ HTTP POST → 本路由 → DSH 新会话。
 *
 * 安全边界（三重）
 *   1) 共享密钥：请求必须携带 `Authorization: Bearer <DSH_BRIDGE_SECRET>`
 *      （或 `x-bridge-secret`），比较使用恒定时间算法；
 *   2) 发送者白名单：可选 `allowSenders`，按 `sender` 字段精确匹配（留空则不校验）；
 *   3) 工作区围栏：请求中的 `workspacePath` 必须落在 `workspaceRoot` 之内。
 *
 * 契约参照官方适配器 @deepseek-ai/dsh-webhook-github（同 inject/Config/apply 形态）。
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createRequire } from "node:module";
import { appendFileSync, existsSync as pathExists, readdirSync as readDirSafe, readFileSync, statSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { homedir } from "node:os";
import { zstdDecompressSync } from "node:zlib";
import { dirname as pathDirname, join as pathJoin, resolve as resolvePath, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { SessionAffinity, detectTurnState, formatNumberedOptions, resolveOriginKey } from "./affinity.mjs";

/**
 * 解析锚点：profile 的 node_modules 里没有 @deepseek-ai/*，因此必须从
 * **DSH 安装树**解析官方包。按以下顺序尝试（任一成功即用）：
 *   1) 当前进程入口脚本 argv[1]
 *   2) 从 node 可执行文件所在目录逐级向上，寻找含 @deepseek-ai/dsh 的 node_modules
 *   3) DSH_HOME / DSH_PROFILE_DIR / DSH_WIN_HOME 下的 versions/* 目录
 * 全部失败时抛出可诊断错误（含已尝试的锚点），避免静默失效。
 */
function candidateAnchors() {
  const found = [];
  const push = (value) => {
    if (typeof value === "string" && value !== "" && !found.includes(value)) found.push(value);
  };

  push(process.argv[1]);
  push(process.execPath);

  // 2) 沿 node 可执行文件向上寻找 DSH 安装标记
  let dir = process.execPath;
  for (let depth = 0; depth < 8; depth += 1) {
    dir = pathDirname(dir);
    if (dir === pathDirname(dir)) break;
    push(pathJoin(dir, "node_modules", "@deepseek-ai", "dsh", "package.json"));
    // 启动器形态：<root>/versions/<version>/node_modules/@deepseek-ai/dsh
    const versionsDir = pathJoin(dir, "versions");
    if (pathExists(versionsDir)) {
      for (const entry of readDirSafe(versionsDir)) {
        push(pathJoin(versionsDir, entry, "node_modules", "@deepseek-ai", "dsh", "package.json"));
      }
    }
  }

  // 3) 已知环境变量（DSH_PROFILE_DIR 直接指向 <root>/versions/<version>）
  for (const key of ["DSH_PROFILE_DIR", "DSH_WIN_HOME", "DSH_HOME"]) {
    const value = process.env[key];
    if (typeof value === "string" && value !== "") {
      push(pathJoin(value, "package.json"));
      push(pathJoin(value, "node_modules", "@deepseek-ai", "dsh", "package.json"));
      const versionsDir = pathJoin(value, "versions");
      if (pathExists(versionsDir)) {
        for (const entry of readDirSafe(versionsDir)) {
          push(pathJoin(versionsDir, entry, "node_modules", "@deepseek-ai", "dsh", "package.json"));
        }
      }
    }
  }

  return found;
}

/** 依次尝试各锚点，返回第一个能解析官方 webhook 包的 createRequire。 */
function resolveHostRequire() {
  const tried = [];
  for (const anchor of candidateAnchors()) {
    tried.push(anchor);
    try {
      const req = createRequire(pathToFileURL(anchor));
      req.resolve("@deepseek-ai/dsh-webhook");
      return req;
    } catch {
      // 继续尝试下一个锚点
    }
  }
  throw new Error(`webhook-bridge: 无法从宿主安装树解析 @deepseek-ai/dsh-webhook；已尝试锚点: ${tried.join(" | ")}`);
}

const hostRequire = resolveHostRequire();
const load = async (specifier) => import(pathToFileURL(hostRequire.resolve(specifier)).href);

/** 官方 schemastery（CJS，实体在 default 上）。 */
const z = (await load("@deepseek-ai/schemastery")).default;
/** 官方 webhook 运行时导出的品牌类型构造器。 */
const { WebhookSourceId } = await load("@deepseek-ai/dsh-webhook");

/** Cordis 函数插件名。 */
const name = "webhook-bridge";

/** 注册路由与派发到 webhook 运行时所需的主机服务。 */
const inject = ["webServer", "webhookRuntime"];

/** 插件配置。 */
const Config = z.object({
  /** 精确路由路径，形如 /openclaw-wechat。 */
  path: z.string().required(),
  /** 桥接实例名，进入投递来源标识。 */
  source: z.string().required(),
  /** 共享密钥所在的环境变量名。 */
  secretEnv: z.string().default("DSH_BRIDGE_SECRET"),
  /** 共享密钥文件路径（优先于环境变量；适合无法设置进程环境变量的部署）。 */
  secretFile: z.string().default(""),
  /** 允许创建会话的工作区根目录（绝对路径）。 */
  workspaceRoot: z.string().required(),
  /** 权限档位：read-only | workspace-write | danger-full-access。 */
  permissionPreset: z.string().default("workspace-write"),
  /** agent preset id：standard | minimal | ptc | cordis。 */
  agentPreset: z.string().default("standard"),
  /** 可选的发送者白名单；为空表示不校验 sender。 */
  allowSenders: z.array(z.string()).default([]),
  /** 请求体上限（字节）。 */
  maxBodyBytes: z.number().default(65536),
  /** 诊断日志文件路径；为空则不写日志。 */
  logFile: z.string().default(""),
  /** 运行期探针：记录每条投递的受理与规则执行情况。 */
  diagnostic: z.boolean().default(false),
  /**
   * 中继模式：直接把请求里的 text 当成新会话的 prompt，跳过"提示语 agent"。
   * 关闭时 text 作为给提示语 agent 的指令，由其决定要创建什么会话。
   */
  relay: z.boolean().default(true),
  /** 派发后等待"会话确实建成"的最长时间（毫秒）；超时返回 502 而非假 202。 */
  confirmTimeoutMs: z.number().default(5000),
  /** 请求带 wait:true 时，等待本轮完成的最长时间（毫秒）；超时返回 504。 */
  waitTimeoutMs: z.number().default(120000),
  /**
   * 会话亲和窗口（毫秒）：同一 conversationId/sender 的消息在该窗口内归属同一个会话边界
   * ——上一轮仍在跑时合并进下一次派发（不新建会话）；窗口过期则新建并写日志。
   * 依据：@deepseek-ai/dsh-webhook 只提供「创建一个新会话」这一个动作（无 continue API）。
   */
  affinityWindowMs: z.number().default(900000),
  /** 节流（毫秒）：距上次派发不足该值的新消息并入下一次派发。 */
  minIntervalMs: z.number().default(1500),
  /** 一次派发最多合并多少段消息。 */
  maxFragments: z.number().default(20),
  /** 合并文本的字符上限（超出截断并记日志）。 */
  maxMergedChars: z.number().default(8000),
  /** 判定 needs_input 的工具名（这些工具在等用户回答时回合不会结束）。 */
  questionTools: z.array(z.string()).default(["ask_user_question"]),
});

/** HTTP 拒绝：消息本身不含请求数据，可安全回给调用方。 */
class BridgeHttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
    this.name = "BridgeHttpError";
  }
}

/** 解析十进制 Content-Length，拒绝歧义写法。 */
function declaredLength(request) {
  const value = request.headers["content-length"];
  if (value === undefined) return undefined;
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new BridgeHttpError(400, "invalid Content-Length");
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new BridgeHttpError(413, "request body is too large");
  return length;
}

/** 以严格 UTF-8 读取有上限的请求体。 */
async function readBoundedUtf8Body(request, maxBodyBytes) {
  const declared = declaredLength(request);
  if (declared !== undefined && declared > maxBodyBytes) {
    request.resume();
    throw new BridgeHttpError(413, "request body is too large");
  }
  const chunks = [];
  let size = 0;
  try {
    for await (const raw of request) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.byteLength;
      if (size > maxBodyBytes) {
        request.resume();
        throw new BridgeHttpError(413, "request body is too large");
      }
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof BridgeHttpError) throw error;
    throw new BridgeHttpError(400, "request body was aborted");
  }
  if (!request.complete) throw new BridgeHttpError(400, "request body was aborted");
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size));
  } catch {
    throw new BridgeHttpError(400, "request body is not valid UTF-8");
  }
}

/** Content-Type 是否为 JSON（允许至多一个 UTF-8 charset 参数）。 */
function isJsonContentType(value) {
  if (value === undefined) return false;
  const [mediaType, parameter, ...extra] = value.split(";").map((part) => part.trim());
  if (mediaType?.toLowerCase() !== "application/json") return false;
  if (parameter === undefined) return true;
  return extra.length === 0 && /^charset=(?:utf-8|"utf-8")$/i.test(parameter);
}

/** 恒定时间比较，避免长度差异泄露信息。 */
function secretMatches(provided, expected) {
  if (typeof provided !== "string" || provided.length === 0) return false;
  const a = createHash("sha256").update(provided, "utf8").digest();
  const b = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(a, b);
}

/** 从一个请求头名取唯一值；缺省或重复即拒绝。 */
function uniqueHeader(request, headerName) {
  const values = request.headersDistinct?.[headerName];
  if (values === undefined) return undefined;
  if (values.length !== 1) throw new BridgeHttpError(400, `ambiguous ${headerName} header`);
  const value = values[0];
  return value === undefined || value.trim() === "" ? undefined : value.trim();
}

/** 从 Authorization: Bearer / x-bridge-secret 中取出共享密钥。 */
function presentedSecret(request) {
  const direct = uniqueHeader(request, "x-bridge-secret");
  if (direct !== undefined) return direct;
  const authorization = uniqueHeader(request, "authorization");
  if (authorization === undefined) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim();
}

/** 追加一行桥接诊断日志（尽力而为，不抛错）。 */
function appendBridgeLog(config, line) {
  const target = typeof config.logFile === "string" && config.logFile !== "" ? config.logFile : "";
  if (target === "") return;
  try {
    appendFileSync(target, `[${new Date().toISOString()}] ${line}\n`, "utf8");
  } catch {
    // 诊断写入失败不影响主流程
  }
}

/**
 * 读取期望的共享密钥，来源优先级（t7/f3 裁决：**环境变量优先，本机绝对路径作为兜底默认值**）：
 *   1) `DSH_BRIDGE_SECRET_FILE` 指向的密钥文件（可覆盖配置里的默认路径）；
 *   2) 配置里的 `secretFile`（本机默认值，保证开箱可用）；
 *   3) `secretEnv` 指定的环境变量。
 * 每次请求都重新读取，便于无需重启即可轮换（文件内容仅取首个非空行）。
 */
function readConfiguredSecret(config) {
  const envFile = process.env.DSH_BRIDGE_SECRET_FILE;
  const fileCandidates = [
    typeof envFile === "string" && envFile.trim() !== "" ? envFile.trim() : "",
    typeof config.secretFile === "string" ? config.secretFile : "",
  ].filter((candidate) => candidate !== "");

  for (const candidate of fileCandidates) {
    try {
      const raw = readFileSync(candidate, "utf8");
      const line = raw.split(/\r?\n/).map((part) => part.trim()).find((part) => part !== "");
      if (line !== undefined && line !== "") return line;
    } catch {
      // 文件不存在或不可读时继续下一个来源
    }
  }
  const fromEnv = process.env[config.secretEnv];
  return typeof fromEnv === "string" && fromEnv !== "" ? fromEnv : undefined;
}

/** 校验请求体形状并抽出桥接输入。 */
function parseBridgeRequest(body) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new BridgeHttpError(400, "request body is not valid JSON");
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new BridgeHttpError(400, "bridge payload must be a JSON object");
  }
  const text = typeof parsed.text === "string" ? parsed.text.trim() : "";
  if (text === "") throw new BridgeHttpError(400, "field \"text\" is required and must be non-empty");
  const optionalString = (field) => (typeof parsed[field] === "string" && parsed[field].trim() !== "" ? parsed[field].trim() : undefined);
  return {
    text,
    title: optionalString("title"),
    workspacePath: optionalString("workspacePath"),
    sender: optionalString("sender"),
    conversationId: optionalString("conversationId"),
    fragments: Number.isSafeInteger(parsed.fragments) && parsed.fragments > 0 ? parsed.fragments : undefined,
    forwardRule: optionalString("forwardRule"),
    wait: parsed.wait === true,
  };
}

/** 就地截断出安全的会话标题。 */
function deriveTitle(explicit, text) {
  const base = (explicit ?? text).replace(/\s+/g, " ").trim();
  const capped = base.length > 80 ? `${base.slice(0, 77)}...` : base;
  return capped === "" ? "Webhook 会话" : capped;
}

/** 工作区必须落在配置的根目录之内（含相等）。Windows 下大小写不敏感。 */
function resolveWorkspaceWithin(root, requested) {
  const rootPath = resolvePath(root);
  if (requested === undefined) return rootPath;
  const candidate = resolvePath(requested);
  const fold = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const foldedRoot = fold(rootPath);
  const foldedCandidate = fold(candidate);
  const prefix = foldedRoot.endsWith(sep) ? foldedRoot : foldedRoot + sep;
  if (foldedCandidate !== foldedRoot && !foldedCandidate.startsWith(prefix)) {
    throw new BridgeHttpError(403, "workspacePath is outside the configured workspaceRoot");
  }
  return candidate;
}

/** 创建该端点唯一的 HTTP 处理器。 */
function createBridgeHandler(ctx, config, affinity) {
  return async (request, response) => {
    try {
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        throw new BridgeHttpError(405, "method not allowed");
      }
      if (!isJsonContentType(request.headers["content-type"])) {
        throw new BridgeHttpError(415, "content type must be application/json");
      }

      const expected = readConfiguredSecret(config);
      if (expected === undefined) {
        ctx.logger.warn(`webhook-bridge: 共享密钥不可用（DSH_BRIDGE_SECRET_FILE=${JSON.stringify(process.env.DSH_BRIDGE_SECRET_FILE ?? "")} secretFile=${JSON.stringify(config.secretFile)} secretEnv=${config.secretEnv}），拒绝所有请求`);
        throw new BridgeHttpError(503, "bridge secret is not configured");
      }
      if (!secretMatches(presentedSecret(request), expected)) {
        throw new BridgeHttpError(401, "invalid bridge secret");
      }

      const body = await readBoundedUtf8Body(request, config.maxBodyBytes);
      const input = parseBridgeRequest(body);

      if (config.allowSenders.length > 0) {
        if (input.sender === undefined || !config.allowSenders.includes(input.sender)) {
          throw new BridgeHttpError(403, "sender is not allowed");
        }
      }

      // P0：目录语义拆成两步，各自返回明确错误（此前"根内不存在"会 202 却静默不建会话）
      const workspacePath = resolveWorkspaceWithin(config.workspaceRoot, input.workspacePath);
      if (input.workspacePath !== undefined && !pathExists(workspacePath)) {
        throw new BridgeHttpError(404, `workspacePath 不存在（本桥接不会创建目录）: ${workspacePath}`);
      }

      // t6：会话亲和/节流/同源合并——窗口内复用同一会话边界，避免"一条消息一个会话"。
      const sessionsRoot = pathJoin(homedir(), ".dsh", "sessions");
      const originKey = resolveOriginKey({ conversationId: input.conversationId, sender: input.sender });
      const isSessionRunning = (sessionId) => {
        const turn = readSessionTurn(sessionsRoot, sessionId, config);
        return turn !== undefined && turn.state === "running";
      };
      const decision = affinity.submit({ originKey, text: input.text, now: Date.now(), isSessionRunning });
      if (decision.action === "merge") {
        appendBridgeLog(config, `affinity-merge origin=${originKey} reason=${decision.reason} session=${decision.sessionId ?? "-"} fragments=${decision.fragments}`);
        ctx.logger.info(`webhook-bridge: 合并到既有会话边界（${decision.reason}）origin=${originKey} session=${decision.sessionId ?? "-"}`);
        respond(response, 202, {
          status: "merged",
          reused: true,
          deferred: decision.reason === "session-running",
          sessionId: decision.sessionId ?? null,
          requestId: randomUUID(),
          originKey,
          fragments: decision.fragments,
          workspacePath,
          title: deriveTitle(input.title, input.text),
        });
        return;
      }

      const prompt = decision.text !== "" ? decision.text : input.text;
      const title = deriveTitle(input.title, prompt);

      // P0：派发前对会话目录做基线快照，派发后确认是否真的落地
      const baseline = listWebhookSessionDirs(sessionsRoot);

      const delivery = Object.freeze({
        kind: "openclaw-wechat",
        source: WebhookSourceId(config.source),
        deliveryId: randomUUID(),
        event: Object.freeze({
          text: prompt,
          sender: input.sender ?? null,
          workspacePath,
          title,
          relay: config.relay === true,
          originKey,
          fragments: decision.fragments,
          forwardRule: input.forwardRule ?? null,
          clientFragments: input.fragments ?? 1,
        }),
        receivedAt: Date.now(),
      });
      const requestId = String(delivery.deliveryId);

      ctx.webhookRuntime.dispatch(delivery);
      appendBridgeLog(config, `dispatch requestId=${requestId} origin=${originKey} reason=${decision.reason} fragments=${decision.fragments} title=${JSON.stringify(title)} workspace=${workspacePath}`);

      const created = await confirmSessionCreated(sessionsRoot, baseline, config.confirmTimeoutMs);
      if (created === undefined) {
        ctx.logger.warn(`webhook-bridge: requestId=${requestId} 派发后 ${config.confirmTimeoutMs}ms 内未发现新会话`);
        throw new BridgeHttpError(502, `dispatched but no Session appeared within ${config.confirmTimeoutMs}ms (requestId=${requestId})`);
      }
      affinity.markDispatched({ originKey, sessionId: created.sessionId, now: Date.now(), fragments: decision.fragments });
      ctx.logger.info(`webhook-bridge: 已确认创建 sessionId=${created.sessionId} requestId=${requestId} origin=${originKey}`);

      // P1：调用方可要求等到本轮执行结束并直接带回回复正文
      if (input.wait === true) {
        const turn = await waitForSessionTurn(sessionsRoot, created.sessionId, config);
        if (turn === undefined) {
          throw new BridgeHttpError(504, `Session ${created.sessionId} did not finish within ${config.waitTimeoutMs}ms (requestId=${requestId})`);
        }
        const status = turn.state === "completed" ? "completed" : turn.state;
        if (turn.state !== "running" && turn.state !== "needs_input") {
          affinity.closeSlot({ originKey, reason: turn.state, now: Date.now() });
        }
        appendBridgeLog(config, `turn session=${created.sessionId} state=${turn.state} kind=${turn.kind ?? "-"} options=${turn.pending?.optionCount ?? 0} replies=${turn.replies.length}`);
        respond(response, 200, {
          status,
          state: turn.state,
          kind: turn.kind,
          sessionId: created.sessionId,
          requestId,
          workspacePath,
          title,
          originKey,
          fragments: decision.fragments,
          completedTurns: turn.completedTurns,
          replyCount: turn.replies.length,
          replyText: turn.replyText,
          replies: turn.replies,
          ...(turn.pending === undefined
            ? {}
            : {
                questionKind: turn.pending.toolName,
                question: turn.pending.question,
                questionHeader: turn.pending.header,
                options: turn.pending.options,
                multiSelect: turn.pending.multiSelect === true,
              }),
        });
        return;
      }

      respond(response, 202, {
        status: "accepted",
        sessionId: created.sessionId,
        requestId,
        workspacePath,
        title,
        originKey,
        reused: decision.reason === "new-turn",
        fragments: decision.fragments,
      });
    } catch (error) {
      if (error instanceof BridgeHttpError) {
        respond(response, error.status, { status: "error", code: error.status, message: error.message });
        return;
      }
      ctx.logger.warn(`webhook-bridge: 请求处理失败 ${String(error)}`);
      respond(response, 503, { status: "error", code: 503, message: "bridge ingress is unavailable" });
    }
  };
}

/** 发送一次响应（JSON 响应体，便于调用方精确判断）。 */
function respond(response, status, payload) {
  const text = typeof payload === "string" ? payload : JSON.stringify(payload);
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(text);
}

/** 列出会话存储下所有 webhook 会话目录（名字 + mtime）。 */
function listWebhookSessionDirs(sessionsRoot) {
  const seen = new Map();
  if (!pathExists(sessionsRoot)) return seen;
  for (const workspaceEntry of readDirSafe(sessionsRoot, { withFileTypes: true })) {
    if (!workspaceEntry.isDirectory()) continue;
    const workspacePath = pathJoin(sessionsRoot, workspaceEntry.name);
    let inner = [];
    try { inner = readDirSafe(workspacePath, { withFileTypes: true }); } catch { continue; }
    for (const sessionEntry of inner) {
      if (!sessionEntry.isDirectory() || !sessionEntry.name.startsWith("webhook-")) continue;
      try {
        const info = statSync(pathJoin(workspacePath, sessionEntry.name));
        seen.set(sessionEntry.name, info.mtimeMs);
      } catch { /* 忽略瞬时条目 */ }
    }
  }
  return seen;
}

/**
 * 确认这次投递是否真的建成了会话（P0：消灭"202 却什么都没建"的静默失败）。
 * 以调用前的目录快照为基线，只认新增的 webhook 会话。
 */
async function confirmSessionCreated(sessionsRoot, baseline, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const [name, mtime] of listWebhookSessionDirs(sessionsRoot)) {
      if (!baseline.has(name)) return { sessionId: name, mtimeMs: mtime };
    }
    if (Date.now() >= deadline) return undefined;
    await delay(250);
  }
}

/** 逐帧解压拼接的 zstd（zstdDecompressSync 只解第一帧）。 */
function decompressAllFrames(buf) {
  const outs = [];
  let offset = 0;
  while (offset < buf.length) {
    const rest = buf.subarray(offset);
    try { outs.push(zstdDecompressSync(rest)); } catch { break; }
    let lo = 1;
    let hi = rest.length;
    let consumed = rest.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      try { zstdDecompressSync(rest.subarray(0, mid)); consumed = mid; hi = mid - 1; }
      catch { lo = mid + 1; }
    }
    offset += consumed;
    if (consumed <= 0) break;
  }
  return Buffer.concat(outs);
}

/**
 * 轮询等待会话回合结束。t6 修复点：`needs_input` 也立即返回（否则两侧都卡到超时）。
 * @returns 回合快照，或 undefined（超时）
 */
async function waitForSessionTurn(sessionsRoot, sessionId, config) {
  const deadline = Date.now() + config.waitTimeoutMs;
  for (;;) {
    const turn = readSessionTurn(sessionsRoot, sessionId, config);
    if (turn !== undefined && (turn.state === "needs_input" || turn.state !== "running")) return turn;
    if (Date.now() >= deadline) return undefined;
    await delay(500);
  }
}

/** 在会话存储中定位某个 webhook 会话的日志文件。 */function findSessionLogFile(sessionsRoot, sessionId) {
  if (!pathExists(sessionsRoot)) return undefined;
  for (const workspaceEntry of readDirSafe(sessionsRoot, { withFileTypes: true })) {
    if (!workspaceEntry.isDirectory()) continue;
    const candidate = pathJoin(sessionsRoot, workspaceEntry.name, sessionId, "session.v4.jsonl.zstd");
    if (pathExists(candidate)) return candidate;
  }
  return undefined;
}

/**
 * 读取某个 webhook 会话的**回合快照**（t6：P1 的可交付结果 + 三态判定）。
 * 事件形状依据：本机真实会话日志（`turn/end` 的 reason.kind、`tool/call`/`tool/result`、
 * `approval/asked`/`approval/decided`、`assistant/message`），判定逻辑在 lib/affinity.mjs。
 * @returns {{sessionId: string, title: string, state: string, kind: string, pending?: object,
 *            completedTurns: number, events: number, replies: string[], replyText: string} | undefined}
 */
function readSessionTurn(sessionsRoot, sessionId, config) {
  const file = findSessionLogFile(sessionsRoot, sessionId);
  if (file === undefined) return undefined;
  let objects = [];
  try {
    objects = decompressAllFrames(readFileSync(file))
      .toString("utf8")
      .split(/\r?\n/)
      .filter((line) => line.trim() !== "")
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return undefined;
        }
      })
      .filter((value) => value !== undefined);
  } catch (error) {
    return {
      sessionId,
      title: "",
      state: "error",
      kind: "decode-error",
      completedTurns: 0,
      events: 0,
      replies: [],
      replyText: "",
      error: `无法解码会话日志: ${String(error)}`,
    };
  }

  let title = "";
  let completedTurns = 0;
  const replies = [];
  for (const object of objects) {
    if (object.type === "session/title") title = object.data?.title ?? title;
    if (object.type === "turn/end") completedTurns += 1;
    if (object.type === "assistant/message") {
      const content = object.data?.message?.content;
      if (!Array.isArray(content)) continue;
      const text = content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n").trim();
      if (text !== "") replies.push(text);
    }
  }

  const turn = detectTurnState(objects, { questionToolNames: config.questionTools });
  const lastReply = replies.length > 0 ? replies[replies.length - 1] : "";
  const replyText = turn.state === "needs_input" && turn.pending !== undefined ? formatNumberedOptions(turn.pending) : lastReply;
  return {
    sessionId,
    title,
    state: turn.state,
    kind: turn.kind,
    ...(turn.pending === undefined ? {} : { pending: turn.pending }),
    completedTurns,
    events: objects.length,
    replies: lastReply === "" ? [] : [lastReply],
    replyText,
  };
}

/** 校验 Schemastery 表达不了的约束。 */
function assertConfig(config) {
  if (config.source.trim() !== config.source || config.source === "") {
    throw new Error("webhook-bridge source 必须是非空且无首尾空白的字符串");
  }
  if (!config.path.startsWith("/") || config.path === "/" || config.path.endsWith("/") || config.path.includes("?") || config.path.includes("#")) {
    throw new Error("webhook-bridge path 必须是以 / 开头的非根路径，且无结尾斜杠、查询或片段");
  }
  if (!["read-only", "workspace-write", "danger-full-access"].includes(config.permissionPreset)) {
    throw new Error(`webhook-bridge permissionPreset 不受支持: ${config.permissionPreset}`);
  }
  for (const [field, value] of [
    ["affinityWindowMs", config.affinityWindowMs],
    ["minIntervalMs", config.minIntervalMs],
    ["maxFragments", config.maxFragments],
    ["maxMergedChars", config.maxMergedChars],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`webhook-bridge ${field} 必须是正整数: ${value}`);
  }
  if (config.minIntervalMs > config.affinityWindowMs) {
    throw new Error("webhook-bridge minIntervalMs 不应大于 affinityWindowMs（否则节流会跨窗口）");
  }
}

/**
 * 注册桥接路由与配套规则。
 *
 * 规则本身不返回会话请求：它把「创建什么会话」完全交给运行时按投递内容决定，
 * 因此这里显式构造 WebhookSessionRequest 并通过规则的 run() 返回。
 */
function apply(ctx, config) {
  assertConfig(config);

  // t6：会话亲和/节流/合并的实例（每个插件实例一份，按 origin 记槽）。
  const affinity = new SessionAffinity({
    affinityWindowMs: config.affinityWindowMs,
    minIntervalMs: config.minIntervalMs,
    maxFragments: config.maxFragments,
    maxMergedChars: config.maxMergedChars,
    log: (line) => appendBridgeLog(config, line),
  });

  // 规则：把每次投递映射为一个新会话请求。
  ctx.effect(
    () =>
      ctx.webhookRuntime.register({
        id: `bridge:${config.source}`,
        kind: "openclaw-wechat",
        run(delivery, signal) {
          signal.throwIfAborted();
          const event = delivery.event ?? {};
          const text = typeof event.text === "string" ? event.text : "";
          if (text.trim() === "") return null;
          const request = {
            workspacePath: typeof event.workspacePath === "string" && event.workspacePath !== ""
              ? event.workspacePath
              : resolvePath(config.workspaceRoot),
            title: deriveTitle(typeof event.title === "string" ? event.title : undefined, text),
            prompt: text,
            agentPreset: config.agentPreset,
            permissionPreset: config.permissionPreset,
          };
          appendBridgeLog(config, `rule-request ${JSON.stringify(request)}`);
          return request;
        },
      }),
    `webhook-bridge rule: ${config.source}`,
  );

  // 路由：受共享密钥保护的精确 POST 端点。
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: config.path,
        handler: createBridgeHandler(ctx, config, affinity),
      }),
    `webhook-bridge route: ${config.path}`,
  );

  ctx.logger.info(`webhook-bridge: 已挂载 ${config.path}（workspace=${config.workspaceRoot}, permission=${config.permissionPreset}, agentPreset=${config.agentPreset}, 白名单=${config.allowSenders.length}, affinityWindowMs=${config.affinityWindowMs}, minIntervalMs=${config.minIntervalMs}）`);
}

export { Config, apply, inject, name };
