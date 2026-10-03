/**
 * test-scan-repo-hygiene —— 卫生门禁的**负例自测**（t11/f1：证明「git gc 之后仍能拦」）。
 *
 * 背景：旧版 `scan-repo-hygiene.mjs` 只解压 loose object 并按原始字节扫 pack，
 * 一旦 `git gc` 把对象移进 pack，它就会**假报干净**（exit 0），而 `git cat-file` 仍能命中真实 id。
 *
 * 本脚本在一个**临时仓库**里复现该场景并断言：
 *   1) 提交含真实账号 id 的文件 → 删掉工作区文件（不提交删除，保持该对象可达）→ `git gc --aggressive`
 *      → 门禁 `--repo <tmp>` 必须 **exit 1** 且报出命中（证明能解 pack 内容）；
 *   2) 同一仓库加 `--no-git`（模拟无 git 的兜底路径）→ 必须 **exit 1** 并明确报告「历史无法验证」；
 *   3) 干净仓库（无敏感内容、对象已 pack）→ 门禁必须 **exit 0**（不误报）。
 *
 * 用法：node scripts/test-scan-repo-hygiene.mjs
 * 退出码：0 = 三条断言全部成立；1 = 有断言失败；2 = 环境不满足（找不到 git），此时打印 SKIP 但仍 exit 0？——
 *        为了不产生"假通过"，找不到 git 一律 exit 2 并说明原因。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath, resolve as resolvePath } from "node:path";

const scriptRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const scanner = joinPath(scriptRoot, "scripts", "scan-repo-hygiene.mjs");

function findGit() {
  const onPath = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (onPath.status === 0) return "git";
  const localAppData = process.env.LOCALAPPDATA ?? "";
  const candidates = [];
  if (localAppData !== "") {
    const ghRoot = joinPath(localAppData, "GitHubDesktop");
    if (existsSync(ghRoot)) {
      for (const entry of readdirSync(ghRoot)) {
        if (entry.startsWith("app-")) candidates.push(joinPath(ghRoot, entry, "resources", "app", "git", "cmd", "git.exe"));
      }
    }
  }
  candidates.push(joinPath(process.env.ProgramFiles ?? "", "Git", "cmd", "git.exe"));
  for (const candidate of candidates) {
    if (candidate !== "" && existsSync(candidate) && spawnSync(candidate, ["--version"], { encoding: "utf8" }).status === 0) return candidate;
  }
  return undefined;
}

const git = findGit();
if (git === undefined) {
  console.error("FAIL: 找不到 git（本自测需要一个能创建/打包仓库的 git；PATH 无 git 时可安装或用 GitHub Desktop 自带 git）");
  process.exit(2);
}

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

function gitRun(cwd, args) {
  const result = spawnSync(git, ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} 失败: ${result.stderr ?? ""}`);
  return result.stdout ?? "";
}

function commitAll(cwd, message) {
  gitRun(cwd, ["-c", "user.email=test@example.invalid", "-c", "user.name=hygiene-test", "commit", "-q", "-m", message]);
}

function runScanner(cwd, extraArgs = []) {
  const result = spawnSync(process.execPath, [scanner, "--repo", cwd, ...extraArgs], { encoding: "utf8" });
  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

// 真实 id 的**测试用**等价形态：与真实账号 id 同形（用于验证模式能命中），但本地部分是随机串，
// 并不是任何真实用户；写进临时仓库、随自测结束时整目录删除。
// 注意：字面量必须**在运行时拼接**，否则本文件自身会被卫生门禁判为「含真实账号 id」。
const FAKE_ID = [
  "hygiene",
  "test",
  Math.random().toString(36).slice(2, 10),
  "0123456789",
].join("-") + "@" + "im." + "wechat";
const workspace = mkdtempSync(joinPath(tmpdir(), "hygiene-selftest-"));
const cleanRepo = joinPath(workspace, "clean");
mkdirSync(cleanRepo, { recursive: true });

try {
  // ── 场景 1：含真实 id 的对象被打包后仍须被拦 ─────────────────────────────
  console.log("\n== 场景 1：泄漏对象被 git gc 打包后必须仍能拦 ==");
  gitRun(workspace, ["init", "-q"]);
  writeFileSync(joinPath(workspace, "leak.txt"), `const sender = "${FAKE_ID}";\n`, "utf8");
  gitRun(workspace, ["add", "-A"]);
  commitAll(workspace, "add leak (test fixture)");
  // 删掉工作区文件但**不提交删除**：对象仍然可达 → 只有扫对象才能发现
  rmSync(joinPath(workspace, "leak.txt"));
  gitRun(workspace, ["gc", "--aggressive", "--prune=now", "-q"]);
  const packs = existsSync(joinPath(workspace, ".git", "objects", "pack"))
    ? readdirSync(joinPath(workspace, ".git", "objects", "pack")).filter((name) => name.endsWith(".pack"))
    : [];
  check("场景 1 前置：git gc 之后确实产生了 pack 文件", packs.length > 0, JSON.stringify(packs));
  check("场景 1 前置：工作区已无该文件（只能靠扫对象发现）", !existsSync(joinPath(workspace, "leak.txt")));

  const packed = runScanner(workspace);
  check(
    "含泄漏对象的 pack：门禁 exit 1 且报出命中",
    packed.status === 1 && packed.output.includes(FAKE_ID),
    `status=${packed.status}\n${packed.output.slice(0, 900)}`,
  );
  check(
    "含泄漏对象的 pack：用的是逐对象扫描口径（cat-file）",
    /cat-file/.test(packed.output) && /(blob|commit|tree)/.test(packed.output),
    packed.output.slice(0, 500),
  );

  // ── 场景 2：无 git 时的兜底必须「无法验证」而不是假报干净 ─────────────────
  console.log("\n== 场景 2：无 git（--no-git）且存在 pack → 必须报「历史无法验证」 ==");
  const fallback = runScanner(workspace, ["--no-git"]);
  check("兜底路径 exit 1（不假报干净）", fallback.status === 1, `status=${fallback.status}`);
  check("兜底路径明确写明「历史无法验证」", /历史无法验证/.test(fallback.output), fallback.output.slice(0, 600));

  // ── 场景 3：干净仓库打包后不得误报 ──────────────────────────────────────
  console.log("\n== 场景 3：干净仓库（对象已 pack）→ 必须 exit 0 ==");
  gitRun(cleanRepo, ["init", "-q"]);
  writeFileSync(joinPath(cleanRepo, "readme.txt"), "hello placeholder@im.wechat\n", "utf8");
  gitRun(cleanRepo, ["add", "-A"]);
  commitAll(cleanRepo, "clean commit");
  gitRun(cleanRepo, ["gc", "--aggressive", "--prune=now", "-q"]);
  const clean = runScanner(cleanRepo);
  check("干净仓库 exit 0（占位符不误报）", clean.status === 0, `status=${clean.status}\n${clean.output.slice(0, 500)}`);
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

console.log(`\n---- test-scan-repo-hygiene 汇总：${passed} passed, ${failures.length} failed ----`);
if (failures.length > 0) {
  for (const failure of failures) console.log(`  FAILED: ${failure}`);
  process.exit(1);
}
console.log("全部断言通过。");
process.exit(0);
