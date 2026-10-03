/**
 * gen-patch —— 为 OpenClaw 发行包的 `worker-task-pool-*.mjs` 生成「克隆失败 → 净化重试」补丁。
 *
 * 用法
 *   node lib/gen-patch.mjs <原始文件.mjs> <输出文件.mjs>
 *   node lib/gen-patch.mjs --list-targets [--json]
 *
 * 行为准则
 *   - 只认同一个**结构指纹**（见 DISPATCH_FINGERPRINT）：`worker.postMessage({` 且下一行
 *     恰为 `input,`，随后是 taskId/interactive/nativeSections/sampleMemory 四行并以
 *     `}, transferList);` 收尾。找不到或多于一处 → 直接失败退出 2，**绝不猜**。
 *   - 输入已含补丁标记 → 退出 3。
 *   - 生成后做结构自检；不通过退出 4。
 *   - 只有在上面全部通过后才会写输出文件；输出统一 LF、UTF-8、无 BOM。
 *   - 语法门禁由调用方（scripts/patch-worker-pool.ps1）用 `node --input-type=module --check`
 *     在**落盘前**执行；本脚本不写目标发行包文件。
 *
 * 已知边界（未验证项请见 README）
 *   - 补丁针对 openclaw 2026.9.7 的派发点形状；上游改结构时本脚本会拒绝生成而不是改坏文件。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath, resolve as resolvePath } from "node:path";

import { listTargets } from "./targets.mjs";

const here = dirname(fileURLToPath(import.meta.url));

/** 补丁标记：用于幂等判定与结构自检。 */
export const INJECTION_SENTINEL = "// [openclaw-weixin-runtime-fix] clone-retry injection point";
export const SNIPPET_HEADER = "[openclaw-weixin-runtime-fix] clone-sanitize helper";
export const PATCH_MARKERS = ["[FIX-CLONE]", "[DIAG-CLONE]", "openclaw-weixin-runtime-fix"];

const EXPECTED_PROPERTY_LINES = [
  "taskId: task.id,",
  "interactive: Boolean(task.options.onRequest),",
  "nativeSections: slot.nativeSections.buffer,",
  "sampleMemory: true",
];

function detectInjectionSites(lines) {
  const sites = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^(\s*)worker\.postMessage\(\{\s*$/.exec(lines[index]);
    if (match === null) continue;
    if ((lines[index + 1] ?? "").trim() !== "input,") continue;
    const properties = lines.slice(index + 2, index + 6).map((line) => line.trim());
    if (properties.join("\u0000") !== EXPECTED_PROPERTY_LINES.join("\u0000")) continue;
    if ((lines[index + 6] ?? "").trim() !== "}, transferList);") continue;
    sites.push({ index, indent: match[1] });
  }
  return sites;
}

/** 注入点替换：原派发保持原样先试一次，捕获 DataCloneError 后诊断 + 退化/净化重试。 */
function buildInjectedBlock(indent) {
  const i1 = `${indent}\t`;
  const i2 = `${indent}\t\t`;
  const i3 = `${indent}\t\t\t`;
  return [
    `${indent}try {`,
    `${i1}worker.postMessage({`,
    `${i2}input,`,
    `${i2}taskId: task.id,`,
    `${i2}interactive: Boolean(task.options.onRequest),`,
    `${i2}nativeSections: slot.nativeSections.buffer,`,
    `${i2}sampleMemory: true`,
    `${i1}}, transferList);`,
    `${i1}task.transferMs += performance.now() - transferStartedAt;`,
    `${indent}} catch (__cloneError) {`,
    `${i1}const __cloneIsDataClone =`,
    `${i2}String(__cloneError?.name ?? "") === "DataCloneError" || String(__cloneError).includes("could not be cloned");`,
    `${i1}if (!__cloneIsDataClone) {`,
    `${i2}this.fail(slot, new WorkerTaskError(String(__cloneError), "unavailable"));`,
    `${i1}} else {`,
    `${i2}const __makeCloneError = (message) => {`,
    `${i3}try {`,
    `${i3}\treturn new WorkerTaskError(message, "unavailable");`,
    `${i3}} catch {`,
    `${i3}\treturn new Error(message);`,
    `${i3}}`,
    `${i2}};`,
    `${i2}try {`,
    `${i3}const __hit = analyzeCloneRejection(input);`,
    `${i3}console.error("[DIAG-CLONE] path=" + String(__hit?.path) + " type=" + String(__hit?.type) + " note=" + String(__hit?.note));`,
    `${i3}console.error("[DIAG-CLONE] shape=" + describeCloneShape(input, String(__hit?.path ?? "$")));`,
    `${i3}console.error("[DIAG-CLONE] raw=" + String(__cloneError) + " transferLen=" + String(Array.isArray(transferList) ? transferList.length : "n/a"));`,
    `${i2}} catch (__diagError) {`,
    `${i3}console.error("[DIAG-CLONE] 诊断失败: " + String(__diagError));`,
    `${i2}}`,
    `${i2}if (Array.isArray(transferList) && transferList.length > 0) {`,
    `${i3}try {`,
    `${i3}\tworker.postMessage({ input, taskId: task.id, interactive: Boolean(task.options.onRequest), nativeSections: slot.nativeSections.buffer, sampleMemory: true });`,
    `${i3}\tconsole.error("[FIX-CLONE] 去掉 transferList 后重试成功");`,
    `${i3}\ttask.transferMs += performance.now() - transferStartedAt;`,
    `${i3}} catch (__fallbackError) {`,
    `${i3}\tconsole.error("[FIX-CLONE] 去掉 transferList 仍失败，转净化重试: " + String(__fallbackError));`,
    `${i3}\tcloneRetrySanitized(this, slot, task, input, transferStartedAt, __makeCloneError);`,
    `${i3}}`,
    `${i2}} else {`,
    `${i3}cloneRetrySanitized(this, slot, task, input, transferStartedAt, __makeCloneError);`,
    `${i2}}`,
    `${i1}}`,
    `${indent}}`,
    INJECTION_SENTINEL,
  ].join("\n");
}

function loadSnippet() {
  const snippetPath = joinPath(here, "clone-sanitize.mjs");
  if (!existsSync(snippetPath)) throw new Error(`缺少注入源码 ${snippetPath}`);
  return readFileSync(snippetPath, "utf8").replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\s*$/, "\n");
}

/**
 * 生成补丁文本（纯函数，便于自测）。
 * @returns {{ok: true, text: string, lineCount: number} | {ok: false, code: string, message: string, sites?: unknown}}
 */
export function generatePatch(originalText, { snippetText } = {}) {
  const normalized = String(originalText).replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (PATCH_MARKERS.some((marker) => normalized.includes(marker))) {
    return { ok: false, code: "already-patched", message: "输入文件已包含补丁标记，拒绝重复注入" };
  }

  const lines = normalized.split("\n");
  const sites = detectInjectionSites(lines);
  if (sites.length === 0) {
    return { ok: false, code: "no-fingerprint", message: "未找到派发注入点指纹，拒绝生成（不猜）" };
  }
  if (sites.length > 1) {
    return {
      ok: false,
      code: "ambiguous-fingerprint",
      message: `找到 ${sites.length} 处候选注入点（行 ${sites.map((site) => site.index + 1).join(", ")}），拒绝生成`,
    };
  }

  const site = sites[0];
  const out = [];
  out.push(...lines.slice(0, site.index));
  out.push(buildInjectedBlock(site.indent));
  out.push(...lines.slice(site.index + 7));

  const snippet = typeof snippetText === "string" ? snippetText : loadSnippet();
  if (!snippet.includes(SNIPPET_HEADER)) {
    return { ok: false, code: "snippet-mismatch", message: "注入源码缺少预期头部标记" };
  }

  let text = out.join("\n");
  if (!text.endsWith("\n")) text += "\n";
  text += `\n${snippet}`;

  // 结构自检：注入点唯一、原始派发块确实被替换、片段已附加、重试函数既定义又被调用。
  const originalBlock = lines.slice(site.index, site.index + 7).join("\n");
  const structural = [
    [text.split(INJECTION_SENTINEL).length - 1 === 1, "注入点标记数量应为 1"],
    [text.split(SNIPPET_HEADER).length - 1 === 1, "注入源码应恰好出现 1 次"],
    [!text.includes(originalBlock), "原始派发块未被替换"],
    [text.includes("export function cloneRetrySanitized("), "缺少 cloneRetrySanitized 定义"],
    [text.split("cloneRetrySanitized(").length - 1 >= 3, "cloneRetrySanitized 调用点不足"],
    [text.includes("analyzeCloneRejection(input)"), "缺少不可克隆字段诊断调用"],
  ];
  const failed = structural.filter(([ok]) => !ok).map(([, message]) => message);
  if (failed.length > 0) {
    return { ok: false, code: "structural-check-failed", message: failed.join("；") };
  }

  return { ok: true, text, lineCount: text.split("\n").length };
}

function main(argv) {
  if (argv.includes("--list-targets")) {
    const targets = listTargets();
    if (argv.includes("--json")) {
      console.log(JSON.stringify(targets, null, 2));
      return 0;
    }
    if (targets.length === 0) {
      console.log("未发现任何 openclaw 的 worker-task-pool-*.mjs（可用 OPENCLAW_DIST 指定 dist 目录）");
      return 0;
    }
    for (const target of targets) {
      console.log(`${target.patched ? "已打补丁" : "未打补丁"}  ${target.path}`);
      console.log(`    openclaw=${target.openclawVersion ?? "unknown"}  bytes=${target.bytes}  backup=${target.backupExists ? target.backupPath : "无"}`);
    }
    return 0;
  }

  const [source, destination] = argv.filter((arg) => !arg.startsWith("--"));
  if (source === undefined || destination === undefined) {
    console.error("用法: node lib/gen-patch.mjs <原始文件.mjs> <输出文件.mjs> | --list-targets [--json]");
    return 1;
  }
  const sourcePath = resolvePath(source);
  const destinationPath = resolvePath(destination);
  if (!existsSync(sourcePath)) {
    console.error(`FAIL: 原始文件不存在 ${sourcePath}`);
    return 1;
  }
  if (sourcePath === destinationPath) {
    console.error("FAIL: 输入与输出不得是同一个文件（本工具只生成候选文件，不直接覆盖发行包）");
    return 1;
  }

  const result = generatePatch(readFileSync(sourcePath, "utf8"));
  if (!result.ok) {
    console.error(`FAIL: ${result.code}: ${result.message}`);
    console.error("未写任何输出文件。");
    return result.code === "already-patched" ? 3 : result.code === "structural-check-failed" ? 4 : 2;
  }

  writeFileSync(destinationPath, result.text, "utf8");
  console.log(`OK: 已生成补丁候选 → ${destinationPath}`);
  console.log(`行数 ${String(readFileSync(sourcePath, "utf8")).split("\n").length} → ${result.lineCount}`);
  return 0;
}

const invokedPath = process.argv[1] === undefined ? "" : resolvePath(process.argv[1]);
if (invokedPath === resolvePath(fileURLToPath(import.meta.url))) {
  process.exit(main(process.argv.slice(2)));
}
