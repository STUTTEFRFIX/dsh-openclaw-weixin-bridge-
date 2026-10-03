/**
 * verify-clone-fix —— openclaw-weixin-runtime-fix 的自测。
 *
 * 运行：node packages/openclaw-weixin-runtime-fix/test/verify-clone-fix.mjs [--real | --no-real]
 * 退出码：0 = 全过；1 = 有断言失败（含 --real 时找不到真实副本）。
 *
 * 复现性设计（对应验收要求「不得依赖未交付的私有状态」）：
 *   - 不需要 openclaw 安装、不需要网络、不改动任何已部署文件；
 *   - 语义与生成器部分全部基于本仓库内的源码 + 合成夹具；
 *   - 第 5 节「真实发行包副本」**真的实现**了三种开关语义：
 *       （默认）auto   ：本机确实存在 openclaw 的 worker-task-pool 副本就跑真实检查，否则打印 SKIP；
 *       --real        ：要求必须有副本；找不到就是失败（exit 1），适合 CI/复核强制跑真实文件；
 *       --no-real     ：显式跳过该节（只跑纯逻辑与生成器断言）。
 *     另外可用环境变量 `OPENCLAW_WORKER_TASK_POOL` 直接指定原始文件路径（优先级最高）。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath, resolve as resolvePath } from "node:path";

import {
  analyzeCloneRejection,
  cloneRetrySanitized,
  describeCloneShape,
  readCtorName,
  sanitizeForClone,
} from "../lib/clone-sanitize.mjs";
import { INJECTION_SENTINEL, SNIPPET_HEADER, generatePatch } from "../lib/gen-patch.mjs";
import { listTargets } from "../lib/targets.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolvePath(here, "..");
const fixturePath = joinPath(here, "fixtures", "worker-task-pool-pristine.fixture.mjs");
const genPatchPath = joinPath(pkgRoot, "lib", "gen-patch.mjs");

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

function skip(name, why) {
  console.log(`  SKIP  ${name} — ${why}`);
}

function group(title) {
  console.log(`\n== ${title} ==`);
}

function cloneOk(value) {
  try {
    structuredClone(value);
    return true;
  } catch {
    return false;
  }
}

function countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

function syntaxCheckText(text) {
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: text, encoding: "utf8" });
  return { ok: result.status === 0, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(), status: result.status };
}

function runCli(args) {
  const result = spawnSync(process.execPath, [genPatchPath, ...args], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim() };
}

// ── 1. sanitizeForClone / analyzeCloneRejection 语义 ───────────────────────
group("clone-sanitize 语义（本仓库 lib/clone-sanitize.mjs）");

const rawEnvCloneable = cloneOk(process.env);
console.log(`  INFO  structuredClone(process.env) 在本机 Node ${process.version} 上：${rawEnvCloneable ? "可克隆" : "抛 DataCloneError"}`);
console.log(`  INFO  Object.getPrototypeOf(process.env).constructor.name = ${JSON.stringify(readCtorName(process.env))}`);

const sanitizedEnv = sanitizeForClone(process.env);
check("真实 process.env 净化后可克隆", cloneOk(sanitizedEnv));
check(
  "净化后保留全部环境变量键",
  Object.keys(sanitizedEnv).length === Object.keys(process.env).length,
  `${Object.keys(sanitizedEnv).length} vs ${Object.keys(process.env).length}`,
);
check(
  "净化后每个环境变量值逐一保持不变",
  Object.keys(process.env).every((key) => sanitizedEnv[key] === process.env[key]),
);

/**
 * 合成「宿主诊断里那种 env」：所有子键都是字符串、容器本身不可克隆、构造器名为空。
 * Proxy 与 Node 的 process.env 包装对象一样无法被结构化克隆，因此这是对
 * `$.request.env owner=Object keys=N … container-all-children-cloneable` 的等价复现。
 */
function makeEnvLikeRecord(entries) {
  const proto = {
    get constructor() {
      return function () {};
    },
  };
  return new Proxy({ ...entries }, { getPrototypeOf: () => proto });
}

const envLike = makeEnvLikeRecord({ AAA_PLACEHOLDER: "1", BBB_PLACEHOLDER: "2" });
check("合成 env 不可克隆（复现前提）", !cloneOk(envLike));
check("合成 env 的构造器名为空（与真实 process.env 一致）", readCtorName(envLike) === "", JSON.stringify(readCtorName(envLike)));
check("合成 env 的键可枚举", Object.keys(envLike).length === 2);

const sanitizedEnvLike = sanitizeForClone(envLike);
check("构造器名为空且不可克隆的记录会被重建成普通对象", cloneOk(sanitizedEnvLike) && Object.getPrototypeOf(sanitizedEnvLike) === Object.prototype);
check("重建后键值原样保留", sanitizedEnvLike.AAA_PLACEHOLDER === "1" && sanitizedEnvLike.BBB_PLACEHOLDER === "2");

const documentedShape = {
  request: {
    agentId: "main",
    storePath: "C:/placeholder/store",
    env: envLike,
    registeredDatabases: { status: "ok" },
    candidates: ["a"],
  },
  taskId: "t1",
  nested: { deep: { env: envLike } },
  date: new Date("2026-01-01T00:00:00.000Z"),
  bytes: new Uint8Array([1, 2, 3]).buffer,
  map: new Map([["k", "v"]]),
  fn: () => 1,
};

check("文档记录的失败样例确实不可克隆", !cloneOk(documentedShape));

const hit = analyzeCloneRejection(documentedShape);
check("诊断定位到 $.request.env", hit?.path === "$.request.env", JSON.stringify(hit));
check("诊断给出 type/note", typeof hit?.type === "string" && typeof hit?.note === "string", JSON.stringify(hit));
const parentShape = describeCloneShape(documentedShape, "$.request");
check(
  "父层形状描述把 env 标为 !UNCLONEABLE",
  parentShape.includes("env:object") && parentShape.includes("!UNCLONEABLE"),
  parentShape.slice(0, 240),
);
const leafShape = describeCloneShape(documentedShape, String(hit?.path ?? "$.request.env"));
check("叶层形状描述给出属主与键数", leafShape.includes("owner=") && leafShape.includes("keys="), leafShape.slice(0, 240));

const safe = sanitizeForClone(documentedShape);
check("净化后整包可克隆", cloneOk(safe));
check("保留 request.agentId / storePath", safe.request.agentId === "main" && safe.request.storePath === "C:/placeholder/store");
check(
  "嵌套 env 也被净化（键值保留）",
  cloneOk(safe.nested.deep.env) && Object.keys(safe.nested.deep.env).length === 2 && safe.nested.deep.env.AAA_PLACEHOLDER === "1",
  JSON.stringify(Object.keys(safe.nested.deep.env ?? {})),
);
check(
  "同一对象出现两处时保留别名关系（共享引用不被丢弃）",
  safe.nested.deep.env === safe.request.env,
);
check("Date 原样保留", safe.date instanceof Date && safe.date.toISOString() === "2026-01-01T00:00:00.000Z");
check("ArrayBuffer 原样保留", safe.bytes instanceof ArrayBuffer && safe.bytes.byteLength === 3);
check("Map 原样保留", safe.map instanceof Map && safe.map.get("k") === "v");
check("函数被剔除（返回 undefined 的字段不出现）", safe.fn === undefined && !Object.hasOwn(safe, "fn"));
check("数组保留且元素不变", Array.isArray(safe.request.candidates) && safe.request.candidates[0] === "a");

const cyclic = { name: "root" };
cyclic.self = cyclic;
const safeCyclic = sanitizeForClone(cyclic);
check(
  "自引用对象不会死循环、保留自引用且结果可克隆",
  cloneOk(safeCyclic) && safeCyclic.name === "root" && safeCyclic.self === safeCyclic,
);

check("原始值原样返回", sanitizeForClone(7) === 7 && sanitizeForClone("x") === "x" && sanitizeForClone(null) === null);

// cloneRetrySanitized：注入点恢复逻辑的最小复刻
{
  const posted = [];
  const failuresSeen = [];
  const pool = { fail: (slot, error) => failuresSeen.push(error) };
  const slot = {
    worker: { postMessage: (message) => posted.push(message) },
    nativeSections: { buffer: new ArrayBuffer(8) },
  };
  const task = { id: "task-1", done: false, transferMs: 0, options: { onRequest: undefined } };
  const input = { request: { env: envLike, agentId: "main" } };
  cloneRetrySanitized(pool, slot, task, input, performance.now(), (message) => new Error(message));
  check("净化重试后确实派发了一次", posted.length === 1);
  check(
    "净化重试的载荷可克隆且保留 agentId 与 env 键值",
    cloneOk(posted[0]?.input) &&
      posted[0]?.input?.request?.agentId === "main" &&
      posted[0]?.input?.request?.env?.AAA_PLACEHOLDER === "1",
  );
  check("净化重试没有走失败分支", failuresSeen.length === 0, failuresSeen.map(String).join(" | "));

  const missingWorker = cloneRetrySanitized(pool, { worker: undefined }, task, input, performance.now(), (message) => new Error(message));
  check("Worker 缺失时走失败分支且不抛异常", missingWorker === undefined && failuresSeen.length === 1);
}

// ── 2. 生成器纯函数行为（指纹识别 / 拒绝策略 / 自检） ─────────────────────
group("gen-patch 生成器（纯函数）");

const fixtureText = readFileSync(fixturePath, "utf8");
const fixtureLines = fixtureText.split("\n");
const fixtureSiteIndex = fixtureLines.findIndex(
  (line, index) => /^\s*worker\.postMessage\(\{\s*$/.test(line) && (fixtureLines[index + 1] ?? "").trim() === "input,",
);
check("夹具含恰好一处派发指纹", fixtureSiteIndex >= 0 && fixtureLines.filter((line, index) => /^\s*worker\.postMessage\(\{\s*$/.test(line) && (fixtureLines[index + 1] ?? "").trim() === "input,").length === 1);
const fixtureOriginalBlock = fixtureLines.slice(fixtureSiteIndex, fixtureSiteIndex + 7).join("\n");
const generated = generatePatch(fixtureText);

check("夹具上生成成功", generated.ok === true, generated.ok ? "" : `${generated.code}: ${generated.message}`);
if (generated.ok) {
  check("注入点标记恰好 1 处", countOccurrences(generated.text, INJECTION_SENTINEL) === 1);
  const snippetHead = generated.text.includes(SNIPPET_HEADER);
  check("注入源码已附加", snippetHead);
  check(
    "cloneRetrySanitized 有定义且有 2 处调用",
    generated.text.includes("export function cloneRetrySanitized(") && countOccurrences(generated.text, "cloneRetrySanitized(") >= 3,
  );
  check("原始派发块已被替换", fixtureSiteIndex >= 0 && !generated.text.includes(fixtureOriginalBlock));
  check("夹具里的资源回收 postMessage 未被误改", generated.text.includes("closeResource: true"));
  check("生成结果通过 ESM 语法门禁", syntaxCheckText(generated.text).ok, syntaxCheckText(generated.text).output);
  check("生成结果仍导出夹具原有绑定", generated.text.includes("export { FixturePool, WorkerTaskError }"));
}

{
  const brokenLines = [...fixtureLines];
  brokenLines[fixtureSiteIndex + 1] = brokenLines[fixtureSiteIndex + 1].replace("input,", "inputRenamed,");
  const result = generatePatch(brokenLines.join("\n"));
  check("指纹被破坏时拒绝生成（no-fingerprint）", result.ok === false && result.code === "no-fingerprint", JSON.stringify(result));
}

{
  const duplicated = `${fixtureText}\n${fixtureText.split("class FixturePool")[1] ?? ""}`;
  const result = generatePatch(duplicated);
  check(
    "出现两处指纹时拒绝生成（ambiguous-fingerprint）",
    result.ok === false && result.code === "ambiguous-fingerprint",
    JSON.stringify(result),
  );
}

{
  const twice = generated.ok ? generatePatch(generated.text) : { ok: true, code: "skipped" };
  check("对已打补丁的输入拒绝重复注入（already-patched）", twice.ok === false && twice.code === "already-patched", JSON.stringify(twice));
}

// ── 3. CLI + 语法门禁（子进程，与 apply 脚本同一路径） ─────────────────────
group("gen-patch CLI 与语法门禁");

const workspace = mkdtempSync(joinPath(tmpdir(), "wtp-verify-"));
try {
  const outOk = joinPath(workspace, "candidate-ok.mjs");
  const cliOk = runCli([fixturePath, outOk]);
  check("CLI 在夹具上退出码 0", cliOk.status === 0, `${cliOk.status}: ${cliOk.output}`);
  check("CLI 产出了候选文件", existsSync(outOk));

  if (existsSync(outOk)) {
    const text = readFileSync(outOk, "utf8");
    check("CLI 产物含注入标记", text.includes(INJECTION_SENTINEL));
    const syntax = syntaxCheckText(text);
    check("CLI 产物通过 node --input-type=module --check", syntax.ok, syntax.output);
  }

  const brokenPath = joinPath(workspace, "broken-pristine.mjs");
  const brokenLinesForCli = [...fixtureLines];
  brokenLinesForCli[fixtureSiteIndex + 1] = brokenLinesForCli[fixtureSiteIndex + 1].replace("input,", "inputRenamed,");
  writeFileSync(brokenPath, brokenLinesForCli.join("\n"), "utf8");
  const outBroken = joinPath(workspace, "candidate-broken.mjs");
  const cliBroken = runCli([brokenPath, outBroken]);
  check("指纹缺失时 CLI 退出码 2", cliBroken.status === 2, `${cliBroken.status}: ${cliBroken.output}`);
  check("指纹缺失时**不产生**输出文件（不落盘）", !existsSync(outBroken));

  const alreadyPath = joinPath(workspace, "already-patched.mjs");
  if (existsSync(outOk)) writeFileSync(alreadyPath, readFileSync(outOk, "utf8"), "utf8");
  const outAlready = joinPath(workspace, "candidate-already.mjs");
  const cliAlready = runCli([alreadyPath, outAlready]);
  check("已打补丁时 CLI 退出码 3", cliAlready.status === 3, `${cliAlready.status}: ${cliAlready.output}`);
  check("已打补丁时不产生输出文件", !existsSync(outAlready));

  const cliUsage = runCli([]);
  check("缺少参数时 CLI 退出码 1 并打印用法", cliUsage.status === 1 && cliUsage.output.includes("用法"), `${cliUsage.status}: ${cliUsage.output}`);

  const listRun = runCli(["--list-targets", "--json"]);
  check("--list-targets --json 可运行且输出 JSON 数组", listRun.status === 0 && listRun.output.trim().startsWith("["), `${listRun.status}: ${listRun.output.slice(0, 120)}`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

// ── 4. 目标发现（只读） ────────────────────────────────────────────────────
group("目标发现 lib/targets.mjs（只读）");

const targets = listTargets();
check("listTargets() 返回数组且不抛异常", Array.isArray(targets));
check(
  "每个条目都有 path/distDir/bytes/patched/backupPath 字段",
  targets.every(
    (target) =>
      typeof target.path === "string" &&
      typeof target.distDir === "string" &&
      typeof target.bytes === "number" &&
      typeof target.patched === "boolean" &&
      typeof target.backupPath === "string",
  ),
);
console.log(`  INFO  本机发现 ${targets.length} 份 worker-task-pool 候选：${targets.map((target) => `${target.patched ? "已打补丁" : "原样"}:${target.path}`).join(" | ") || "(无)"}`);

// ── 5. 真实发行包副本上的生成 + 语法门禁（开关：默认 auto / --real / --no-real） ──
const REAL_MODE = process.argv.slice(2).includes("--no-real")
  ? "off"
  : process.argv.slice(2).includes("--real")
    ? "require"
    : "auto";
group(`真实发行包副本（--real/--no-real 开关；当前模式：${REAL_MODE}）`);

const explicitPool = typeof process.env.OPENCLAW_WORKER_TASK_POOL === "string" ? process.env.OPENCLAW_WORKER_TASK_POOL.trim() : "";
const explicitPoolExists = explicitPool !== "" && existsSync(explicitPool);

const pristineSource = (() => {
  if (REAL_MODE === "off") return undefined;
  if (explicitPoolExists) return explicitPool;
  for (const target of targets) {
    if (target.backupExists && existsSync(target.backupPath)) {
      const backupText = readFileSync(target.backupPath, "utf8");
      if (!backupText.includes("openclaw-weixin-runtime-fix") && !backupText.includes("[FIX-CLONE]")) return target.backupPath;
    }
    if (!target.patched) return target.path;
  }
  return undefined;
})();

// 显式指定的路径不存在：--real 下视为失败（用户明确要求用这个文件），auto 下只告警
if (REAL_MODE !== "off" && explicitPool !== "" && !explicitPoolExists) {
  if (REAL_MODE === "require") {
    check("--real 时 OPENCLAW_WORKER_TASK_POOL 指定的文件存在", false, `不存在：${explicitPool}`);
  } else {
    console.log(`  INFO  OPENCLAW_WORKER_TASK_POOL 指定的文件不存在（已忽略）：${explicitPool}`);
  }
}

if (REAL_MODE === "off") {
  skip("真实文件生成 + 语法门禁", "已用 --no-real 显式跳过该节（只跑纯逻辑/生成器断言）");
} else if (pristineSource === undefined) {
  if (REAL_MODE === "require") {
    check(
      "真实文件生成 + 语法门禁（--real 要求必须有副本）",
      false,
      "未发现 openclaw 的 worker-task-pool 副本；请用 OPENCLAW_WORKER_TASK_POOL 指定原始文件，或去掉 --real",
    );
  } else {
    skip("真实文件生成 + 语法门禁", "本机未发现 openclaw 的 worker-task-pool 副本（或用 OPENCLAW_WORKER_TASK_POOL 指定）");
  }
} else {
  console.log(`  INFO  源文件 : ${pristineSource}`);
  const realText = readFileSync(pristineSource, "utf8");
  const realResult = generatePatch(realText);
  check("真实文件上生成成功（指纹唯一且结构自检通过）", realResult.ok === true, realResult.ok ? "" : `${realResult.code}: ${realResult.message}`);
  if (realResult.ok) {
    const syntax = syntaxCheckText(realResult.text);
    check("真实文件的补丁候选通过 ESM 语法门禁", syntax.ok, syntax.output);
    check("真实文件候选含注入标记", realResult.text.includes(INJECTION_SENTINEL));
  }
  check("本仓库没有改动真实源文件（在生成前后字节数一致）", readFileSync(pristineSource, "utf8") === realText);
}

// ── 汇总 ───────────────────────────────────────────────────────────────────
console.log(`\n---- 自测汇总：${passed} passed, ${failures.length} failed ----`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAILED: ${failure}`);
  process.exit(1);
}
console.log("全部断言通过。");
process.exit(0);
