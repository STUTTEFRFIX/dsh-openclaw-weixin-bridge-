/**
 * clone-sanitize —— 被注入到 OpenClaw 发行包 `worker-task-pool-*.mjs` 的辅助函数本体。
 *
 * [openclaw-weixin-runtime-fix] clone-sanitize helper —— 同一份源码既是被注入的代码，
 * 也是本包自测 import 的对象；本文件不允许出现 import 语句或对目标文件绑定的顶层引用。
 *
 * 为什么需要它
 *   宿主 `WorkerTaskPoolCore.start` 用 `worker.postMessage(payload, transferList)` 把任务
 *   交给 Worker；postMessage 走结构化克隆。真实载荷里的 `input.request.env` 是一个
 *   「所有子键都是字符串、但容器本身不可克隆」的对象（本机实测的宿主诊断输出：
 *   `$.request.env owner=Object keys=51 … container-all-children-cloneable`），
 *   克隆失败抛 DataCloneError，导致：
 *     - 微信通道 `dispatchReplyFromConfig` 失败 → 回复永远发不出去；
 *     - `getUpdates` 长轮询被同一次失败打断。
 *   证据：DSH 报告 `reports/openclaw-weixin-dataclone-issue.md`（注入点见 lib/gen-patch.mjs）。
 *
 * 本文件的双重身份
 *   1) 独立模块：`test/verify-clone-fix.mjs` 直接 import 它，做**不依赖任何私有状态**的
 *      语义自测。
 *   2) 注入源码：`lib/gen-patch.mjs` 把本文件源码（含 export 声明）原样追加到目标文件末尾。
 *      追加进 ESM 模块合法；以下标识符在目标文件中都不存在，不会冲突。
 */

/* >>> openclaw-weixin-runtime-fix: clone-retry patch <<< */

/**
 * 结构化克隆**原生支持**的构造器名 → 原样保留，不做重建。
 * 原因：这些类型的语义不是「属性记录」，重建会改坏它们；若它们自身不可克隆
 * （例如 Map 里塞了函数），就让重试如实失败，而不是伪造一个残缺对象。
 * 注意：`Map`/`Set`/`WeakMap` 等不可重建的类型也在表内。
 */
export const CLONE_PRESERVE_CTOR_NAMES = Object.freeze(
  new Set([
    "Date",
    "RegExp",
    "Map",
    "Set",
    "WeakMap",
    "WeakSet",
    "ArrayBuffer",
    "SharedArrayBuffer",
    "DataView",
    "Int8Array",
    "Uint8Array",
    "Uint8ClampedArray",
    "Int16Array",
    "Uint16Array",
    "Int32Array",
    "Uint32Array",
    "Float16Array",
    "Float32Array",
    "Float64Array",
    "BigInt64Array",
    "BigUint64Array",
    "Error",
    "EvalError",
    "RangeError",
    "ReferenceError",
    "SyntaxError",
    "TypeError",
    "URIError",
    "AggregateError",
    "Promise",
    "MessagePort",
    "MessageChannel",
    "AbortSignal",
    "AbortController",
    "Blob",
    "File",
    "FileList",
    "FormData",
    "Headers",
    "Request",
    "Response",
    "URL",
    "URLSearchParams",
    "CryptoKey",
    "ImageData",
    "ImageBitmap",
    "DOMPoint",
    "DOMPointReadOnly",
    "DOMRect",
    "DOMRectReadOnly",
    "DOMQuad",
    "DOMMatrix",
    "WebAssembly.Module",
  ]),
);

/**
 * 读取构造器名。
 * 注意：`process.env` 的原型上 `constructor.name` 是**空字符串**（本机实测），
 * 所以空串必须被视为「未知/记录型」，不能因为「不是 Object」就跳过重建——
 * 这正是原补丁的一处漏洞：`?? "null-proto"` 挡不住空串。
 */
export function readCtorName(value) {
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto === null) return "null-proto";
    const name = proto.constructor?.name;
    return typeof name === "string" ? name : "unknown";
  } catch {
    return "unknown";
  }
}

/**
 * 定位首个不可克隆的字段路径（诊断用）。
 * 返回 null 表示该值可克隆；否则返回 { path, type, note }。
 */
export function analyzeCloneRejection(value, path = "$", depth = 0) {
  try {
    structuredClone(value);
    return null;
  } catch {
    /* 继续下钻 */
  }
  if (depth >= 8) return { path, type: typeof value, note: "depth-limit" };
  if (value === null || value === undefined) return { path, type: String(value), note: "primitive" };
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      const hit = analyzeCloneRejection(value[i], `${path}[${i}]`, depth + 1);
      if (hit) return hit;
    }
    return { path, type: "array", note: "container" };
  }
  if (value instanceof Map) {
    for (const entry of value) {
      const hit = analyzeCloneRejection(entry[1], `${path}.<map:${String(entry[0])}>`, depth + 1);
      if (hit) return hit;
    }
    return { path, type: "Map", note: "container" };
  }
  if (value instanceof Set) {
    let i = 0;
    for (const item of value) {
      const hit = analyzeCloneRejection(item, `${path}.<set:${i}>`, depth + 1);
      if (hit) return hit;
      i += 1;
    }
    return { path, type: "Set", note: "container" };
  }
  if (typeof value === "function") return { path, type: "function", note: "functions are not cloneable" };
  if (typeof value === "symbol") return { path, type: "symbol", note: "symbols are not cloneable" };
  if (typeof value === "object") {
    let keys = [];
    try {
      keys = Object.keys(value);
    } catch {
      return { path, type: "object-headless", note: "uninspectable" };
    }
    for (const key of keys) {
      let child;
      try {
        child = value[key];
      } catch {
        return { path: `${path}.${key}`, type: "getter-threw", note: "property access failed" };
      }
      const hit = analyzeCloneRejection(child, `${path}.${key}`, depth + 1);
      if (hit) return hit;
    }
    return { path, type: readCtorName(value), note: "container-all-children-cloneable" };
  }
  return { path, type: typeof value, note: "non-object leaf" };
}

/** 结构化描述某个路径上的对象：属主、属性名、描述符标志、逐属性克隆结果。 */
export function describeCloneShape(root, path) {
  const segments = String(path ?? "$").split(".").slice(1);
  let node = root;
  for (const segment of segments) {
    if (node === null || node === undefined) return `${String(path)} -> missing at ${segment}`;
    node = segment.endsWith("]") ? node[Number(segment.replace(/[^0-9]/g, ""))] : node[segment];
  }
  if (node === null || node === undefined) return `${String(path)} -> ${String(node)}`;
  const owner = readCtorName(node);
  const names = (() => {
    try {
      return Object.getOwnPropertyNames(node);
    } catch {
      return ["<throw>"];
    }
  })();
  const parts = [`owner=${owner}`, `keys=${names.length}`];
  for (const key of names) {
    let descriptor = null;
    try {
      descriptor = Object.getOwnPropertyDescriptor(node, key);
    } catch {
      /* ignore */
    }
    const flags = descriptor
      ? [descriptor.get ? "get" : null, descriptor.set ? "set" : null, descriptor.enumerable ? "enum" : null, descriptor.writable ? "writable" : null]
          .filter(Boolean)
          .join("+") || "none"
      : "nodesc";
    let value;
    let type;
    try {
      value = node[key];
      type = value === null ? "null" : typeof value;
    } catch {
      type = "getter-threw";
      value = undefined;
    }
    let cloneable = "n/a";
    if (type === "object" || type === "function") {
      try {
        structuredClone(value);
        cloneable = "yes";
      } catch {
        cloneable = "NO";
      }
    }
    const ctor = type === "object" && value ? readCtorName(value) : "";
    parts.push(`${key}:${type}${ctor === "" ? "" : `(${ctor})`}{${flags}}${cloneable === "NO" ? "!UNCLONEABLE" : ""}`);
  }
  return `${String(path)} ${parts.join(" ")}`;
}

/**
 * 克隆安全化。
 *   - 可克隆的值原样返回（保持引用，代价最低）；
 *   - 不可克隆的值：普通记录（含 ctor 名为空的包装对象、Proxy、null 原型对象）与数组
 *     递归重建成普通副本；原生类型按 CLONE_PRESERVE_CTOR_NAMES 原样保留；
 *     函数/symbol 被剔除（返回 undefined）；
 *   - 共享引用用 WeakMap 缓存复用同一个重建副本（保留别名关系，不会把第二处引用丢掉）；
 *   - 环引用在重建前先登记占位对象，因此不会无限递归；
 *   - 超过 12 层深度的值返回 undefined（避免在异常路径上做无限代价的深拷贝）。
 *   - 只在「派发已经失败」的路径上被调用，因此这里的额外克隆探测不会影响正常请求性能。
 */
export function sanitizeForClone(value, depth = 0, cache = new WeakMap()) {
  if (value === null || value === undefined) return value;
  const type = typeof value;
  if (type === "function" || type === "symbol") return undefined;
  if (type !== "object") return value;
  if (depth > 12) return undefined;

  try {
    structuredClone(value);
    return value;
  } catch {
    /* 容器本身不可克隆，继续重建 */
  }

  if (CLONE_PRESERVE_CTOR_NAMES.has(readCtorName(value))) return value;
  if (cache.has(value)) return cache.get(value);

  if (Array.isArray(value)) {
    const rebuilt = [];
    cache.set(value, rebuilt);
    for (const item of value) rebuilt.push(sanitizeForClone(item, depth + 1, cache));
    return rebuilt;
  }

  const plain = {};
  cache.set(value, plain);
  let names = [];
  try {
    names = Object.keys(value);
  } catch {
    return plain;
  }
  for (const key of names) {
    let child;
    try {
      child = value[key];
    } catch {
      continue;
    }
    const safe = sanitizeForClone(child, depth + 1, cache);
    if (safe !== undefined) plain[key] = safe;
  }
  return plain;
}

/**
 * 注入点专用：净化后重试一次派发；由 start 的 catch 分支调用。
 * makeError 由注入点提供（优先构造宿主的 WorkerTaskError，失败则退化为 Error）。
 */
export function cloneRetrySanitized(pool, slot, task, input, transferStartedAt, makeError) {
  const errorFor = typeof makeError === "function" ? makeError : (message) => new Error(message);
  let safeInput;
  try {
    safeInput = sanitizeForClone(input);
  } catch {
    safeInput = undefined;
  }
  if (safeInput === undefined) {
    console.error("[FIX-CLONE] 净化失败，保持原错误");
    if (typeof pool?.fail === "function") pool.fail(slot, errorFor("clone sanitize failed"));
    return;
  }
  const worker = slot?.worker;
  if (!worker) {
    console.error("[FIX-CLONE] 净化重试时 Worker 已不在，保持原错误");
    if (typeof pool?.fail === "function") pool.fail(slot, errorFor("worker missing during clone retry"));
    return;
  }
  try {
    worker.postMessage({
      input: safeInput,
      taskId: task.id,
      interactive: Boolean(task.options.onRequest),
      nativeSections: slot.nativeSections.buffer,
      sampleMemory: true,
    });
    console.error("[FIX-CLONE] 净化重试成功（已剔除不可克隆值），任务继续");
    task.transferMs += performance.now() - transferStartedAt;
  } catch (retryError) {
    console.error(`[FIX-CLONE] 净化重试仍失败: ${String(retryError)}`);
    if (typeof pool?.fail === "function") pool.fail(slot, errorFor(String(retryError)));
  }
}
