/**
 * check-syntax —— 对仓库内每个 JS/ESM 文件做语法门禁。
 *
 * 运行：node scripts/check-syntax.mjs
 * 退出码：0 = 全部通过；1 = 有文件不通过或无法读取。
 *
 * 判定方式与验收命令一致：`node --input-type=module --check`，内容经 stdin 传入。
 * 之所以统一按 ESM 校验：仓库内所有 .js/.mjs 都是 ESM（各自包内 package.json 声明
 * `"type": "module"`；hook 的 handler.js 会被宿主用原生 import() 加载，必须是 ESM）。
 *
 * 跳过：node_modules、.git、以及本脚本自身排除的临时目录。
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath, relative, resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const SKIP_DIRS = new Set(["node_modules", ".git", ".tmp", "dist", "coverage"]);
const EXTENSIONS = [".js", ".mjs", ".cjs"];

function walk(dir, out = []) {
  let entries = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(`无法读取目录 ${dir}: ${String(error)}`);
  }
  for (const entry of entries) {
    const full = joinPath(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(full, out);
      continue;
    }
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".d.ts")) continue;
    if (entry.name.endsWith(".ts")) continue; // 本仓库只交付 JS
    if (EXTENSIONS.some((extension) => entry.name.endsWith(extension))) out.push(full);
  }
  return out;
}

function checkFile(filePath) {
  const source = readFileSync(filePath, "utf8");
  const result = spawnSync(process.execPath, ["--input-type=module", "--check"], { input: source, encoding: "utf8" });
  return {
    ok: result.status === 0,
    status: result.status,
    detail: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
    bytes: statSync(filePath).size,
  };
}

const files = walk(repoRoot).sort();
let failed = 0;

for (const filePath of files) {
  const rel = relative(repoRoot, filePath).split("\\").join("/");
  try {
    const result = checkFile(filePath);
    if (result.ok) {
      console.log(`  OK    ${rel}  (${result.bytes} bytes)`);
    } else {
      failed += 1;
      console.log(`  FAIL  ${rel}  (exit=${result.status})`);
      if (result.detail !== "") console.log(`        ${result.detail.split("\n").join("\n        ")}`);
    }
  } catch (error) {
    failed += 1;
    console.log(`  FAIL  ${rel}: ${String(error)}`);
  }
}

console.log(`\n---- check-syntax: ${files.length - failed}/${files.length} 通过 ----`);
if (failed > 0) {
  console.log("语法门禁未通过。");
  process.exit(1);
}
console.log("全部 JS/ESM 文件通过 node --input-type=module --check。");
process.exit(0);
