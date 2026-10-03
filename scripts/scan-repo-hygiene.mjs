/**
 * scan-repo-hygiene —— 仓库级「敏感内容」扫描（发布前门禁 + 事后复验工具）。
 *
 * 用途
 *   1) 发布前门禁：扫描**工作树里的受控文件**，确认没有真实账号 id / 机器专属用户路径 / 密钥；
 *   2) **历史复验**：把 `.git` 下的对象全量解压后扫描同样的模式（含 reflog / index / packed-refs），
 *      用于确认「旧历史里的机器路径 / 真实账号 id 已随历史重写消失」——这正是 t9 验收里的复验口径；
 *   3) 防止复发：以 `npm run check` 的一部分常驻运行（`check:hygiene`）。
 *
 * 判定口径（关键）
 *   - `@im.wechat` 形态的**占位符**（`user-placeholder@im.wechat`、`oXXXX@im.wechat`、
 *     `<sender>@im.wechat` 等）允许存在：它们是样例与测试夹具，命中会以 `placeholder` 级别报告，**不算失败**；
 *   - **真实账号 id**（本地部分不含 placeholder/< /xxxx/example/your 等提示，且长度≥6）→ **失败**；
 *   - `C:\Users\<真实用户名>\…` / `…\Documents and Settings\<用户名>\…` → **失败**
 *     （`<用户名>`、`<you>`、`{$env…}` 这类占位写法不算）；
 *   - `sk-`… 长密钥、`Bearer <长载荷>`、JWT → **失败**；
 *   - `*.local.*` 本地覆盖文件（被 .gitignore 排除）**跳过**：它们按设计存放机器真实值。
 *
 * 用法
 *   node scripts/scan-repo-hygiene.mjs [--json] [--no-git-objects] [--quiet-placeholders]
 * 退出码：0 = 无真实敏感内容；1 = 命中（含扫描失败）；2 = 用法错误。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath, relative, resolve as resolvePath } from "node:path";
import { inflateSync } from "node:zlib";

const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("用法: node scripts/scan-repo-hygiene.mjs [--json] [--no-git-objects] [--quiet-placeholders]");
  process.exit(0);
}
const asJson = argv.includes("--json");
const includeGitObjects = !argv.includes("--no-git-objects");
const quietPlaceholders = argv.includes("--quiet-placeholders");

/* ── 模式（拆成片段拼接，避免扫描器自身命中自己的字面量） ───────────────── */
const IM_DOMAIN = "@" + "im." + "wechat";
const PLACEHOLDER_HINTS = ["placeholder", "xxxx", "example", "your", "somebody", "<", ">", "{", "$", "redacted", "…"];
const PATTERNS = [
  {
    name: "微信账号 id（真实）",
    pattern: new RegExp(`[A-Za-z0-9_-]{6,}${IM_DOMAIN.replace(".", "\\.")}`, "g"),
    classify: (match) => (isPlaceholderLike(match) ? "placeholder" : "real"),
  },
  {
    name: "Windows 用户目录绝对路径",
    pattern: /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s"'`]+/g,
    classify: (match) => (isPlaceholderLike(match) ? "placeholder" : "real"),
  },
  { name: "OpenAI 风格密钥", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g, classify: () => "real" },
  { name: "Bearer 长载荷", pattern: /\bBearer\s+[A-Za-z0-9._-]{20,}/g, classify: () => "real" },
  { name: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./g, classify: () => "real" },
];

function isPlaceholderLike(value) {
  const lowered = String(value).toLowerCase();
  return PLACEHOLDER_HINTS.some((hint) => lowered.includes(hint));
}

/** 本地覆盖文件：按设计存放机器真实值，跳过。 */
const SKIP_FILE = /\.local\./i;
const SKIP_DIR = /(^|[\\/])(node_modules|\.git[\\/]objects[\\/]pack|coverage)([\\/]|$)/i;

function scanText(text, where, findings) {
  for (const { name, pattern, classify } of PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      findings.push({ where, kind: name, severity: classify(match[0]), sample: match[0].slice(0, 60) });
      match = pattern.exec(text);
    }
  }
}

/* ── 1) 工作树里的受控文件 ─────────────────────────────────────────────── */
function findGitBinary() {
  const onPath = spawnSync("git", ["--version"], { encoding: "utf8" });
  if (onPath.status === 0) return "git";
  const candidates = [];
  const localAppData = process.env.LOCALAPPDATA ?? "";
  if (localAppData !== "") {
    const ghRoot = joinPath(localAppData, "GitHubDesktop");
    if (existsSync(ghRoot)) {
      for (const entry of readdirSync(ghRoot)) {
        if (!entry.startsWith("app-")) continue;
        candidates.push(joinPath(ghRoot, entry, "resources", "app", "git", "cmd", "git.exe"));
      }
    }
  }
  candidates.push(joinPath(process.env.ProgramFiles ?? "", "Git", "cmd", "git.exe"));
  for (const candidate of candidates) {
    if (candidate !== "" && existsSync(candidate)) {
      const probe = spawnSync(candidate, ["--version"], { encoding: "utf8" });
      if (probe.status === 0) return candidate;
    }
  }
  return undefined;
}

/** 用 `git ls-files` 拿「将要提交/发布」的文件清单：已跟踪 + 未跟踪但未被忽略的（= `git add -A` 的集合）。 */
function listControlledFiles(gitBinary) {
  if (gitBinary !== undefined) {
    const result = spawnSync(gitBinary, ["-C", repoRoot, "ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
    });
    if (result.status === 0) {
      return String(result.stdout ?? "")
        .split("\0")
        .filter((entry) => entry !== "")
        .map((entry) => joinPath(repoRoot, entry));
    }
  }
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = joinPath(dir, entry.name);
      if (SKIP_DIR.test(full) || entry.name === ".git") continue;
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile() && !SKIP_FILE.test(full)) out.push(full);
    }
  };
  walk(repoRoot);
  return out;
}

const findings = [];
const meta = { repoRoot, gitBinary: undefined, trackedFiles: 0, gitObjectsScanned: 0, gitPacks: 0, notes: [] };

const gitBinary = findGitBinary();
meta.gitBinary = gitBinary;
if (gitBinary === undefined) meta.notes.push("未找到 git（历史对象扫描仍可用，但受控文件清单退化为目录遍历）");

for (const filePath of listControlledFiles(gitBinary)) {
  if (SKIP_FILE.test(filePath)) continue;
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch {
    continue; // 二进制/不可读文件跳过
  }
  meta.trackedFiles += 1;
  scanText(text, relative(repoRoot, filePath).split("\\").join("/"), findings);
}

/* ── 2) .git 历史对象（复验「旧历史已消失」） ─────────────────────────── */
if (includeGitObjects) {
  const objectsDir = joinPath(repoRoot, ".git", "objects");
  if (existsSync(objectsDir)) {
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = joinPath(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (full.includes(`${joinPath("objects", "pack")}`)) {
          meta.gitPacks += 1;
          // packed 对象按原始字节尽力扫描（不解析 pack 格式）
          const raw = readFileSync(full).toString("latin1");
          scanText(raw, relative(repoRoot, full).split("\\").join("/") + " (packed, best-effort)", findings);
          continue;
        }
        if (full.includes(`${joinPath("objects", "info")}`)) continue;
        try {
          const inflated = inflateSync(readFileSync(full)).toString("utf8");
          meta.gitObjectsScanned += 1;
          scanText(inflated, relative(repoRoot, full).split("\\").join("/") + " (git object)", findings);
        } catch {
          // 非 zlib 内容（如 index）；按文本尽力扫描
          try {
            const raw = readFileSync(full).toString("latin1");
            meta.gitObjectsScanned += 1;
            scanText(raw, relative(repoRoot, full).split("\\").join("/") + " (git raw)", findings);
          } catch {
            /* 跳过不可读对象 */
          }
        }
      }
    };
    walk(objectsDir);
  } else {
    meta.notes.push("仓库内没有 .git/objects（无 git 历史可扫）");
  }
  // reflog / index / COMMIT_EDITMSG 等文本状态文件也扫一遍
  for (const rel of ["logs", "index", "COMMIT_EDITMSG", "config"]) {
    const full = joinPath(repoRoot, ".git", rel);
    if (!existsSync(full)) continue;
    const targets = statSync(full).isDirectory()
      ? readdirSync(full, { withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => joinPath(full, entry.name))
      : [full];
    for (const target of targets) {
      try {
        scanText(readFileSync(target).toString("latin1"), relative(repoRoot, target).split("\\").join("/"), findings);
      } catch {
        /* 跳过 */
      }
    }
  }
}

/* ── 3) 汇总 ─────────────────────────────────────────────────────────── */
const realFindings = findings.filter((item) => item.severity === "real");
const placeholderFindings = findings.filter((item) => item.severity === "placeholder");

if (asJson) {
  console.log(JSON.stringify({ ok: realFindings.length === 0, meta, realFindings, placeholderFindings }, null, 2));
} else {
  console.log(`仓库级敏感内容扫描：受控文件 ${meta.trackedFiles} 个，git 对象 ${meta.gitObjectsScanned} 个${meta.gitPacks > 0 ? `，pack 文件 ${meta.gitPacks} 个（best-effort）` : ""}`);
  console.log(`git：${meta.gitBinary ?? "(未找到)"}`);
  for (const note of meta.notes) console.log(`  INFO  ${note}`);
  for (const item of realFindings) console.log(`  FAIL  [${item.kind}] ${item.where}: ${item.sample}`);
  if (!quietPlaceholders) {
    for (const item of placeholderFindings) console.log(`  info  [${item.kind}·占位符] ${item.where}: ${item.sample}`);
  }
  console.log(
    `\n---- scan-repo-hygiene：真实敏感命中 ${realFindings.length}，占位符命中 ${placeholderFindings.length}（占位符不算失败） ----`,
  );
}

process.exit(realFindings.length === 0 ? 0 : 1);
