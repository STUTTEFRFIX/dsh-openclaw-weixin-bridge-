/**
 * affinity —— 桥接侧的**纯逻辑**模块：会话亲和/节流/同源合并 + 回合状态判定 + 选项文本化。
 *
 * 为什么要它（对应 t6 的缺陷 2、3）
 *   1) 缺陷：桥接侧「每次投递 = 一个新会话」，且无去重/节流 → 用户一句话被微信拆成
 *      多段（实测 3 段）就产生 3 个会话，实测 webhook 会话高达 35 个（本机复核：36 个）。
 *      这里用「起源槽（origin slot）」把同一 conversationId/senderId 在窗口内的消息归属到
 *      同一个会话边界，并做节流与合并；窗口过期行为显式记录日志。
 *   2) 缺陷：需要用户选择项的回合两侧都卡死。这里从会话日志的事件流里判定
 *      `completed / needs_input / aborted`，并把 `ask_user_question` 的选项转成**纯文本编号**，
 *      好让纯文本通道（微信）也能回答。
 *
 * 本模块不依赖 DSH、Cordis、网络或文件系统，因此可以在仓库内被自测直接驱动（时间由调用方注入）。
 *
 * 磁盘依据（决定事件形状，均为本机真实会话日志 + DSH 包源码核对）
 *   - 会话日志事件：`turn/end` 的 `data.reason.kind` 实测取值为 completed / aborted / error /
 *     blocked；`tool/call` 形状 `{turn, step, callId, name, arguments}`（arguments 是 JSON 字符串）；
 *     `tool/result` 用 `data.toolCallId` 与之配对；`approval/asked` 形状
 *     `{id, toolName, callId, reason}`，配对事件是 `approval/decided`（用 `id` 配对）。
 *   - 选择项工具名 `ask_user_question`，参数 `{"questions":[{"id","header","question",
 *     "options":[{"label","description"}],"multi_select"?}]}`：来自本机会话日志中 83 次真实
 *     调用样本（`~/.dsh/sessions/<工作区>/<会话>/session.v4.jsonl.zstd`，只读）。
 *   - `@deepseek-ai/dsh-webhook` 0.1.7-rc.2 的 README 明确写：「The sole runtime action: create and
 *     prompt one root Session」「No built-in deduplication」「No completion result」——
 *     因此**不存在**“往已存在会话追加消息”的运行时 API；本模块的“复用”是“把窗口内的消息合并到
 *     同一次派发”，而不是“追加到同一会话历史”。这条限制在 README/DELIVERY 中明写。
 */

/** 回合状态取值（对外契约里的三态是 completed / needs_input / aborted，另有 running/error/blocked 作为补充）。 */
export const TURN_STATES = Object.freeze({
  COMPLETED: "completed",
  NEEDS_INPUT: "needs_input",
  ABORTED: "aborted",
  RUNNING: "running",
  ERROR: "error",
  BLOCKED: "blocked",
});

/** 需要用户输入的工具名（可配置）。 */
export const DEFAULT_QUESTION_TOOL_NAMES = Object.freeze(["ask_user_question"]);

/** 亲和/节流默认参数（可被插件配置覆盖）。 */
export const DEFAULT_AFFINITY_OPTIONS = Object.freeze({
  /** 窗口（毫秒）：窗口内同一 origin 的消息归属同一个会话边界；过期则新建会话并记日志。 */
  affinityWindowMs: 900000,
  /** 节流（毫秒）：距上次派发不足该值的新消息并入同一次派发。 */
  minIntervalMs: 1500,
  /** 一次派发最多合并多少段（超出部分继续保留在槽里，等下一次派发）。 */
  maxFragments: 20,
  /** 合并文本上限（字符），超出截断并记日志。 */
  maxMergedChars: 8000,
  /** 询问型文本化时的选项上限。 */
  maxOptions: 10,
});

function asString(value) {
  return typeof value === "string" ? value : "";
}

/** 容错解析 tool/call 的 arguments（可能是 JSON 字符串，也可能已是对象）。 */
export function parseToolArguments(raw) {
  if (raw !== null && typeof raw === "object") return raw;
  const text = asString(raw).trim();
  if (text === "") return {};
  try {
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/** 从 `ask_user_question` 的参数里抽出问题与编号选项。 */
export function extractQuestionPayload(rawArguments, { maxOptions = DEFAULT_AFFINITY_OPTIONS.maxOptions } = {}) {
  const args = parseToolArguments(rawArguments);
  const questions = Array.isArray(args.questions) ? args.questions : [];
  const first = questions.find((question) => question !== null && typeof question === "object") ?? {};
  const rawOptions = Array.isArray(first.options) ? first.options : [];
  const options = rawOptions
    .slice(0, maxOptions)
    .map((option, index) => {
      const record = option !== null && typeof option === "object" ? option : {};
      const label = asString(record.label).trim() || `选项 ${index + 1}`;
      return { index: index + 1, label, description: asString(record.description).trim() };
    })
    .filter((option) => option.label !== "");
  return {
    id: asString(first.id).trim(),
    header: asString(first.header).trim(),
    question: asString(first.question).trim() || asString(first.header).trim(),
    multiSelect: first.multi_select === true || first.multiSelect === true,
    options,
    optionCount: options.length,
  };
}

/**
 * 判定回合状态。
 * @param events 会话日志事件数组（按 seq 顺序），每项形如 `{type, data}`。
 * @param options `{ questionToolNames }`
 * @returns {{state: string, kind: string, reason: unknown, turn: number|undefined, pending: object|null, eventCount: number, lastEventType: string}}
 */
export function detectTurnState(events, options = {}) {
  const list = Array.isArray(events) ? events : [];
  const questionTools = new Set(
    Array.isArray(options.questionToolNames) && options.questionToolNames.length > 0
      ? options.questionToolNames
      : DEFAULT_QUESTION_TOOL_NAMES,
  );

  // 最后一次 turn/end 之后的尾部才代表“当前未结束的回合”。
  let lastEndIndex = -1;
  for (let index = 0; index < list.length; index += 1) {
    if (list[index]?.type === "turn/end") lastEndIndex = index;
  }
  const tail = lastEndIndex >= 0 ? list.slice(lastEndIndex + 1) : list;
  const lastEnd = lastEndIndex >= 0 ? list[lastEndIndex] : undefined;

  const toolResults = new Set();
  for (const event of tail) {
    if (event?.type === "tool/result" && event.data?.toolCallId) toolResults.add(event.data.toolCallId);
  }

  // 未回答的选择项：最后一个未配对的 ask_user_question 调用。
  let pendingQuestion = null;
  for (const event of tail) {
    if (event?.type !== "tool/call") continue;
    if (!questionTools.has(asString(event.data?.name))) continue;
    if (toolResults.has(event.data?.callId)) continue;
    pendingQuestion = event;
  }
  if (pendingQuestion) {
    const payload = extractQuestionPayload(pendingQuestion.data?.arguments, options);
    return {
      state: TURN_STATES.NEEDS_INPUT,
      kind: "question",
      reason: undefined,
      turn: pendingQuestion.data?.turn,
      pending: {
        toolName: asString(pendingQuestion.data?.name),
        callId: asString(pendingQuestion.data?.callId),
        ...payload,
      },
      eventCount: list.length,
      lastEventType: asString(list[list.length - 1]?.type),
    };
  }

  // 未决定的批准请求：最后一个未配对的 approval/asked。
  const decided = new Set();
  for (const event of tail) {
    if (event?.type === "approval/decided") decided.add(asString(event.data?.id));
  }
  let pendingApproval = null;
  for (const event of tail) {
    if (event?.type !== "approval/asked") continue;
    if (decided.has(asString(event.data?.id))) continue;
    pendingApproval = event;
  }
  if (pendingApproval) {
    return {
      state: TURN_STATES.NEEDS_INPUT,
      kind: "approval",
      reason: undefined,
      turn: undefined,
      pending: {
        toolName: asString(pendingApproval.data?.toolName),
        callId: asString(pendingApproval.data?.callId),
        header: "需要批准",
        question: asString(pendingApproval.data?.reason).trim(),
        options: [
          { index: 1, label: "允许", description: "" },
          { index: 2, label: "拒绝", description: "" },
        ],
        optionCount: 2,
        multiSelect: false,
      },
      eventCount: list.length,
      lastEventType: asString(list[list.length - 1]?.type),
    };
  }

  if (lastEnd) {
    const kind = asString(lastEnd.data?.reason?.kind) || "ended";
    const state =
      kind === "completed"
        ? TURN_STATES.COMPLETED
        : kind === "aborted"
          ? TURN_STATES.ABORTED
          : kind === "error"
            ? TURN_STATES.ERROR
            : kind === "blocked"
              ? TURN_STATES.BLOCKED
              : kind;
    return {
      state,
      kind,
      reason: lastEnd.data?.reason,
      turn: lastEnd.data?.turn,
      pending: null,
      eventCount: list.length,
      lastEventType: asString(list[list.length - 1]?.type),
    };
  }

  return {
    state: TURN_STATES.RUNNING,
    kind: "running",
    reason: undefined,
    turn: undefined,
    pending: null,
    eventCount: list.length,
    lastEventType: asString(list[list.length - 1]?.type),
  };
}

/** 把 needs_input 的选项转成**纯文本编号**（供微信这类纯文本通道回复）。 */
export function formatNumberedOptions(pending, options = {}) {
  const record = pending !== null && typeof pending === "object" ? pending : {};
  const list = Array.isArray(record.options) ? record.options : [];
  const replyMode = options.replyMode === true;
  const lines = [];
  const head = asString(record.question) || asString(record.header) || "需要你选择后才能继续";
  lines.push(`${replyMode ? "DSH 回复：需要你选择后才能继续。" : "DSH 需要你选择后才能继续。"}`);
  lines.push(`问题：${head}`);
  if (record.id) lines.push(`（问题 id：${record.id}${record.multiSelect ? "，可多选" : ""}）`);
  if (list.length === 0) {
    lines.push("未解析到选项，请直接在微信里回复你的选择内容。");
    return lines.join("\n");
  }
  lines.push("请回复对应序号：");
  for (const option of list) {
    const index = Number.isInteger(option.index) ? option.index : list.indexOf(option) + 1;
    const description = asString(option.description);
    lines.push(`${index}) ${option.label}${description === "" ? "" : ` —— ${description}`}`);
  }
  if (record.multiSelect === true) lines.push("（可多选：回复如「1,3」）");
  return lines.join("\n");
}

/** 会话槽的默认值。 */
function createSlot(originKey, now) {
  return {
    originKey,
    sessionId: undefined,
    openedAt: now,
    lastDispatchedAt: 0,
    lastActivityAt: now,
    fragments: 0,
    dispatches: 0,
    texts: [],
    state: "coalescing",
  };
}

/**
 * 会话亲和/节流/合并的**纯状态机**。
 * 调用方负责：注入 `now`、提供 `isSessionRunning(sessionId)`、在 action==="dispatch" 后调用
 * `markDispatched()`，并在槽内仍有未派发文本时调用 `takeFlushable()`。
 */
export class SessionAffinity {
  constructor(options = {}) {
    const merged = { ...DEFAULT_AFFINITY_OPTIONS };
    for (const [key, value] of Object.entries(options)) {
      if (key === "log") continue;
      if (typeof value === "number" && Number.isFinite(value)) merged[key] = value;
    }
    this.options = Object.freeze(merged);
    this.log = typeof options.log === "function" ? options.log : () => {};
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

  /**
   * 提交一段文本。
   * @returns {{action: "dispatch"|"merge", reason: string, originKey: string, text: string,
   *            fragments: number, sessionId: string|undefined, reused: boolean, droppedFragments?: number}}
   */
  submit({ originKey, text, now, isSessionRunning } = {}) {
    const key = asString(originKey).trim() || "anonymous";
    const chunk = asString(text).trim();
    const at = Number.isFinite(now) ? now : 0;
    let slot = this.slots.get(key);

    if (slot === undefined) {
      slot = createSlot(key, at);
      this.slots.set(key, slot);
      this.log(`affinity-open origin=${key} windowMs=${this.options.affinityWindowMs}`);
    } else if (at - slot.openedAt > this.options.affinityWindowMs) {
      this.log(
        `affinity-window-expired origin=${key} ageMs=${at - slot.openedAt} windowMs=${this.options.affinityWindowMs} ` +
          `→ 新建会话（DSH webhook runtime 无 continue API）`,
      );
      slot = createSlot(key, at);
      this.slots.set(key, slot);
    }

    slot.lastActivityAt = at;
    if (chunk !== "") slot.texts.push(chunk);
    slot.fragments += chunk === "" ? 0 : 1;

    // 窗口内：上一轮还在跑 → 合并到槽里，等它结束（或调用方 flush）后再作为一次派发送出去。
    if (slot.sessionId !== undefined) {
      const running = typeof isSessionRunning === "function" ? isSessionRunning(slot.sessionId) === true : false;
      if (running) {
        this.log(`affinity-reuse origin=${key} session=${slot.sessionId} deferred=1 fragments=${slot.texts.length}`);
        return {
          action: "merge",
          reason: "session-running",
          originKey: key,
          text: "",
          fragments: slot.texts.length,
          sessionId: slot.sessionId,
          reused: true,
        };
      }
      if (at - slot.lastDispatchedAt < this.options.minIntervalMs) {
        this.log(
          `affinity-throttle origin=${key} session=${slot.sessionId} sinceLastDispatchMs=${at - slot.lastDispatchedAt} ` +
            `minIntervalMs=${this.options.minIntervalMs} → 并入同一次派发`,
        );
        return {
          action: "merge",
          reason: "throttle",
          originKey: key,
          text: "",
          fragments: slot.texts.length,
          sessionId: slot.sessionId,
          reused: true,
        };
      }
      this.log(`affinity-new-turn origin=${key} session=${slot.sessionId} → 上一轮已结束，开新会话`);
    }

    const { text: merged, droppedFragments } = this.#composeDispatchText(slot);
    return {
      action: "dispatch",
      reason: slot.sessionId === undefined ? "new-session" : "new-turn",
      originKey: key,
      text: merged,
      fragments: slot.texts.length,
      sessionId: slot.sessionId,
      reused: false,
      ...(droppedFragments > 0 ? { droppedFragments } : {}),
    };
  }

  #composeDispatchText(slot) {
    const pieces = [];
    let length = 0;
    let dropped = 0;
    for (const piece of slot.texts) {
      if (pieces.length >= this.options.maxFragments) {
        dropped += 1;
        continue;
      }
      const remaining = this.options.maxMergedChars - length;
      if (remaining <= 0) {
        dropped += 1;
        continue;
      }
      const value = piece.length > remaining ? piece.slice(0, remaining) : piece;
      pieces.push(value);
      length += value.length + 2;
    }
    if (dropped > 0) {
      this.log(`affinity-merge-truncated origin=${slot.originKey} dropped=${dropped} maxFragments=${this.options.maxFragments} maxMergedChars=${this.options.maxMergedChars}`);
    }
    return { text: pieces.join("\n\n").trim(), droppedFragments: dropped };
  }

  /** 派发完成后登记会话 id（并滚动窗口、清空待发文本）。 */
  markDispatched({ originKey, sessionId, now, fragments = 0 } = {}) {
    const key = asString(originKey).trim() || "anonymous";
    const slot = this.slots.get(key) ?? createSlot(key, Number.isFinite(now) ? now : 0);
    slot.sessionId = asString(sessionId).trim() || slot.sessionId;
    slot.openedAt = Number.isFinite(now) ? now : slot.openedAt;
    slot.lastDispatchedAt = Number.isFinite(now) ? now : slot.lastDispatchedAt;
    slot.texts = [];
    slot.state = "dispatched";
    slot.dispatches += 1;
    this.slots.set(key, slot);
    this.log(`affinity-dispatched origin=${key} session=${slot.sessionId || "-"} fragments=${fragments} dispatches=${slot.dispatches}`);
    return slot;
  }

  /** 关闭槽（会话结束 / 显式重置）。 */
  closeSlot({ originKey, reason = "closed", now } = {}) {
    const key = asString(originKey).trim() || "anonymous";
    const slot = this.slots.get(key);
    if (slot === undefined) return undefined;
    slot.state = `closed:${reason}`;
    slot.sessionId = undefined;
    slot.openedAt = Number.isFinite(now) ? now : slot.openedAt;
    this.log(`affinity-slot-closed origin=${key} reason=${reason}`);
    return slot;
  }

  /**
   * 取出「可以现在派发」的待发文本（槽里攒了内容，且上一轮已结束 / 未在跑）。
   * @returns {{text: string, fragments: number, sessionId: string|undefined} | null}
   */
  takeFlushable({ originKey, now, isSessionRunning } = {}) {
    const key = asString(originKey).trim() || "anonymous";
    const slot = this.slots.get(key);
    if (slot === undefined || slot.texts.length === 0) return null;
    if (slot.sessionId !== undefined && typeof isSessionRunning === "function" && isSessionRunning(slot.sessionId) === true) {
      return null;
    }
    const { text } = this.#composeDispatchText(slot);
    if (text === "") return null;
    this.log(`affinity-flush origin=${key} fragments=${slot.texts.length} prevSession=${slot.sessionId ?? "-"}`);
    return { text, fragments: slot.texts.length, sessionId: slot.sessionId };
  }

  /** 清理长期空闲的槽，避免内存无界增长。 */
  prune({ now, maxIdleMs = 3600000 } = {}) {
    const at = Number.isFinite(now) ? now : 0;
    let removed = 0;
    for (const [key, slot] of this.slots) {
      if (slot.texts.length === 0 && at - slot.lastActivityAt > maxIdleMs) {
        this.slots.delete(key);
        removed += 1;
      }
    }
    if (removed > 0) this.log(`affinity-pruned removed=${removed} remaining=${this.slots.size}`);
    return removed;
  }
}

/** 由 origin 字段算出亲和键：优先 conversationId，其次 senderId。 */
export function resolveOriginKey({ conversationId, senderId } = {}) {
  const conversation = asString(conversationId).trim();
  if (conversation !== "") return `conv:${conversation}`;
  const sender = asString(senderId).trim();
  if (sender !== "") return `sender:${sender}`;
  return "anonymous";
}
