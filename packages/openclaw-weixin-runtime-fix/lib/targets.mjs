/**
 * targets —— 只读地发现本机有哪些 openclaw 发行包里的 `worker-task-pool-*.mjs`。
 *
 * 用途
 *   1) `node lib/targets.mjs [--json]`：人工排查（哪些副本、是否已打补丁、有无备份）。
 *   2) `scripts/patch-worker-pool.ps1` 在未显式指定 -DistPath 时用它挑目标。
 *
 * 说明
 *   - 只读：本模块不会创建、修改、删除任何文件。
 *   - 候选根目录来自常见安装位置 + 环境变量；找不到就返回空数组，不抛异常。
 *   - 同一台机器可能存在多份 openclaw（全局 npm 前缀、DSH 自带 node 目录、插件自带的
 *     嵌套副本）。**只有 Gateway 实际运行的那一份**才是需要修的；请用
 *     `openclaw --version` / Gateway 进程路径确认后再 apply。
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join as joinPath, resolve as resolvePath } from "node:path";

/** 补丁标记（与 gen-patch.mjs 保持一致；这里为避免循环依赖重复声明）。 */
const PATCH_MARKERS = ["[FIX-CLONE]", "[DIAG-CLONE]", "openclaw-weixin-runtime-fix"];

function safeVersion(packageJsonPath) {
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

function listFilesSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function fileLooksPatched(filePath) {
  try {
    const text = readFileSync(filePath, "utf8");
    return PATCH_MARKERS.some((marker) => text.includes(marker));
  } catch {
    return false;
  }
}

/** 可能承载 openclaw 的 node_modules 目录（去重）。 */
export function candidateNodeModulesRoots(env = process.env) {
  const roots = [];
  const push = (value) => {
    if (typeof value !== "string" || value.trim() === "") return;
    const resolved = resolvePath(value.trim());
    if (!roots.includes(resolved)) roots.push(resolved);
  };

  // 1) 显式指定：OPENCLAW_DIST 直接指向 <openclaw>/dist
  if (typeof env.OPENCLAW_DIST === "string" && env.OPENCLAW_DIST.trim() !== "") {
    const dist = resolvePath(env.OPENCLAW_DIST.trim());
    push(joinPath(dist, "..", ".."));
  }
  // 2) DSH 自带 node 目录
  push(joinPath(env.DSH_WIN_HOME ?? joinPath(homedir(), ".dsh-win"), "node", "node_modules"));
  push(joinPath(homedir(), ".dsh-win", "node", "node_modules"));
  // 3) 全局 npm 前缀（Windows）
  if (typeof env.APPDATA === "string" && env.APPDATA !== "") push(joinPath(env.APPDATA, "npm", "node_modules"));
  if (typeof env.ProgramFiles === "string" && env.ProgramFiles !== "") push(joinPath(env.ProgramFiles, "nodejs", "node_modules"));
  // 4) PATH 里第一段含 node 的目录旁（尽力而为）
  if (typeof env.PATH === "string") {
    for (const entry of env.PATH.split(delimiter)) {
      if (/node/i.test(entry) && entry.trim() !== "") push(joinPath(entry, "node_modules"));
    }
  }
  // 5) openclaw 插件自带的嵌套宿主副本
  const pluginProjectsRoot = joinPath(homedir(), ".openclaw", "npm", "projects");
  for (const entry of listFilesSafe(pluginProjectsRoot)) {
    if (!entry.isDirectory()) continue;
    push(joinPath(pluginProjectsRoot, entry.name, "node_modules", "@tencent-weixin", "openclaw-weixin", "node_modules"));
  }
  return roots;
}

/**
 * 列出所有候选的 worker-task-pool 文件及其补丁状态。
 * @returns {Array<{path: string, distDir: string, bytes: number, patched: boolean, backupPath: string, backupExists: boolean, openclawVersion: string | undefined}>}
 */
export function listTargets(env = process.env) {
  const found = [];
  const seen = new Set();
  for (const root of candidateNodeModulesRoots(env)) {
    const distDir = joinPath(root, "openclaw", "dist");
    if (!existsSync(distDir)) continue;
    const version = safeVersion(joinPath(root, "openclaw", "package.json"));
    for (const entry of listFilesSafe(distDir)) {
      if (!entry.isFile()) continue;
      if (!/^worker-task-pool-.*\.mjs$/.test(entry.name)) continue;
      const filePath = joinPath(distDir, entry.name);
      if (seen.has(filePath)) continue;
      seen.add(filePath);
      let bytes = 0;
      try {
        bytes = statSync(filePath).size;
      } catch {
        bytes = 0;
      }
      const backupPath = `${filePath}.orig-bak`;
      found.push({
        path: filePath,
        distDir,
        bytes,
        patched: fileLooksPatched(filePath),
        backupPath,
        backupExists: existsSync(backupPath),
        openclawVersion: version,
      });
    }
  }
  return found;
}

/** 备份文件是否干净（不含补丁标记）。缺失视为干净（尚未备份）。 */
export function backupIsClean(backupPath) {
  if (!existsSync(backupPath)) return true;
  return !fileLooksPatched(backupPath);
}

function main(argv) {
  const targets = listTargets();
  if (argv.includes("--json")) {
    console.log(JSON.stringify(targets, null, 2));
    return 0;
  }
  if (targets.length === 0) {
    console.log("未发现 worker-task-pool-*.mjs。可用 OPENCLAW_DIST 指向 <openclaw>/dist 后重试。");
    return 0;
  }
  for (const target of targets) {
    console.log(`${target.patched ? "已打补丁" : "未打补丁"}  ${target.path}`);
    console.log(`    openclaw=${target.openclawVersion ?? "unknown"}  bytes=${target.bytes}`);
    console.log(`    backup=${target.backupExists ? target.backupPath : "(不存在)"}`);
  }
  return 0;
}

if (process.argv[1] !== undefined && resolvePath(process.argv[1]).endsWith("targets.mjs")) {
  process.exit(main(process.argv.slice(2)));
}
