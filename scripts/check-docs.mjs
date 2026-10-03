#!/usr/bin/env node
/**
 * check-docs —— 文档门禁（仓库级，零依赖）
 *
 * 检查项（全部基于仓库内文件的真实内容，不联网、不读环境）：
 *   1) 相对链接：所有 Markdown 的 [..](target) 目标（去掉 #锚点后）必须存在于仓库内；
 *   2) 代码块语言：每个围栏都必须带语言标注（无语言的裸 ``` 视为不合格）；
 *   3) 标题层级：不得跳级（h1 → h3），且每个文件的首个标题必须是 h1；
 *   4) 表格：同一张表的列数必须一致，且必须有分隔行；
 *   5) 双语结构：docs/zh-CN/<页>.md 与 docs/en/<页>.md 必须成对存在且标题层级序列一致；
 *   6) 敏感标识：Markdown 里不得出现本机用户名、真实账号 id、真实会话 id 等（占位符除外）。
 *
 * 用法：
 *   node scripts/check-docs.mjs            # 人读输出
 *   node scripts/check-docs.mjs --json     # 机读输出
 *
 * 退出码：0 = 全部通过；1 = 有问题。
 */
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const asJson = process.argv.includes("--json");

/** 需要保持“逐页对应”的双语页面。 */
const BILINGUAL_PAGES = [
  "README.md",
  "architecture.md",
  "installation.md",
  "known-issues.md",
  "hook-judgment.md",
  "session-reuse-and-input.md",
];

/** 敏感标识：命中即失败（占位符写法不会命中）。 */
const SENSITIVE_PATTERNS = [
  [/\bAdministrator\b/, "疑似本机用户名（请用 <machine-user> 占位符）"],
  [/o9cq[0-9A-Za-z_-]{6,}/, "疑似真实微信账号 id"],
  [/\bf19bd[0-9a-f]{4,}\b/i, "疑似真实 id 前缀"],
  [/\bwebhook-[0-9a-f]{8}-[0-9a-f]{4}/i, "疑似真实会话 id"],
  [/\\\.dsh-win\\/, "疑似机器专属 .dsh-win 路径"],
];

const problems = [];
const rel = (p) => relative(root, p).split("\\").join("/");
const report = (file, line, message) => {
  problems.push({ file: file === null ? null : rel(file), line, message });
};

/** 递归收集仓库内的 Markdown（跳过 .git/node_modules）。 */
function collectMarkdown(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === ".git" || name === "node_modules") continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) collectMarkdown(path, out);
    else if (name.endsWith(".md")) out.push(path);
  }
  return out;
}

/** 按行分析一个文件：链接、围栏、标题、表格、敏感标识。 */
function analyze(file) {
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const headings = [];
  let inFence = false;
  let tableBlock = [];

  const flushTable = () => {
    if (tableBlock.length === 0) return;
    const [first] = tableBlock;
    for (const row of tableBlock) {
      if (row.columns !== first.columns) {
        report(file, row.line, `表格列数不一致：本行 ${row.columns} 列，表头 ${first.columns} 列`);
      }
    }
    if (!tableBlock.some((row) => row.raw.includes("-") && /^\s*\|?[\s:|-]+\|?\s*$/.test(row.raw))) {
      report(file, first.line, "表格缺少分隔行（|---|）");
    }
    tableBlock = [];
  };

  lines.forEach((line, index) => {
    const lineNo = index + 1;

    // 代码围栏
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (!inFence) {
        inFence = true;
        if (fence[2].trim() === "") report(file, lineNo, "代码块缺少语言标注（写成 ```text / ```bash 等）");
      } else {
        inFence = false;
      }
      flushTable();
      return;
    }
    if (inFence) return;

    // 相对链接
    const linkRe = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let match;
    while ((match = linkRe.exec(line)) !== null) {
      const target = match[1];
      if (/^(https?:|mailto:|#|data:)/i.test(target)) continue;
      const [pathPart] = target.split("#");
      if (pathPart === "") continue;
      const abs = resolve(dirname(file), decodeURIComponent(pathPart));
      if (!existsSync(abs)) report(file, lineNo, `相对链接目标不存在：${target}`);
    }

    // 标题
    const heading = /^(#{1,6})\s+\S/.exec(line);
    if (heading) {
      const level = heading[1].length;
      headings.push({ level, line: lineNo });
      if (headings.length === 1 && level !== 1) report(file, lineNo, `首个标题应为 h1，实际 h${level}`);
      const previous = headings[headings.length - 2];
      if (previous && level - previous.level > 1) {
        report(file, lineNo, `标题层级跳跃：h${previous.level} → h${level}`);
      }
      flushTable();
      return;
    }

    // 表格行
    if (/^\s*\|/.test(line)) {
      tableBlock.push({ line: lineNo, columns: (line.match(/(?<!\\)\|/g) ?? []).length, raw: line });
      return;
    }
    flushTable();

    // 敏感标识
    for (const [pattern, message] of SENSITIVE_PATTERNS) {
      if (pattern.test(line)) report(file, lineNo, message);
    }
  });

  flushTable();
  if (inFence) report(file, lines.length, "代码块未闭合");
  return headings;
}

const files = collectMarkdown(root);
const headingsByFile = new Map();
for (const file of files) headingsByFile.set(file, analyze(file));

// 双语结构一致性
for (const page of BILINGUAL_PAGES) {
  const zh = join(root, "docs", "zh-CN", page);
  const en = join(root, "docs", "en", page);
  if (!existsSync(zh)) report(null, 0, `双语缺页：docs/zh-CN/${page}`);
  if (!existsSync(en)) report(null, 0, `双语缺页：docs/en/${page}`);
  if (!existsSync(zh) || !existsSync(en)) continue;
  const zhShape = headingsByFile.get(zh).map((h) => h.level).join(",");
  const enShape = headingsByFile.get(en).map((h) => h.level).join(",");
  if (zhShape !== enShape) {
    report(null, 0, `双语结构不一致：docs/{zh-CN,en}/${page} 标题层级 [${zhShape}] vs [${enShape}]`);
  }
}

if (asJson) {
  console.log(JSON.stringify({ files: files.length, problems }, null, 2));
} else {
  console.log(`---- check-docs：扫描 ${files.length} 个 Markdown 文件 ----`);
  if (problems.length === 0) {
    console.log("全部通过：相对链接、代码块语言、标题层级、表格列数、双语结构、敏感标识。");
  } else {
    for (const problem of problems) {
      console.log(`  FAIL  ${problem.file ?? "(仓库级)"}${problem.line ? `:${problem.line}` : ""}  ${problem.message}`);
    }
    console.log(`---- check-docs：${problems.length} 项问题 ----`);
  }
}
process.exitCode = problems.length === 0 ? 0 : 1;
