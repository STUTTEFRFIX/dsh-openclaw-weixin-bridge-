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
 *   node scripts/scan-repo-hygiene.mjs [--repo <dir>] [--json] [--no-git-objects] [--no-git] [--quiet-placeholders]
 * 退出码：0 = 无真实敏感内容；1 = 命中**或无法验证历史**（存在 pack 但不能逐对象扫描）；2 = 用法错误。
 *
 * 历史对象的扫描口径（t11/f1 修复）
 *   - git 可用时：用 `git cat-file --batch-all-objects --batch` **逐对象**扫描（能解开 pack 内容），
 *     这是唯一可信的「已去敏」结论来源；
 *   - git 不可用且存在 `objects/pack/*.pack`：**直接 exit 1**，报告「历史无法验证」，绝不假报干净；
 *   - git 不可用且全是 loose object：退化为 zlib 全量解压扫描。
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath, relative, resolve as resolvePath } from "node:path";
import { inflateSync } from "node:zlib";

const scriptRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log("用法: node scripts/scan-repo-hygiene.mjs [--repo <dir>] [--json] [--no-git-objects] [--no-git] [--quiet-placeholders]");
  process.exit(0);
}
const asJson = argv.includes("--json");
const includeGitObjects = !argv.includes("--no-git-objects");
const quietPlaceholders = argv.includes("--quiet-placeholders");
const forceNoGit = argv.includes("--no-git");
const repoFlagIndex = argv.indexOf("--repo");
const repoRoot =
  repoFlagIndex >= 0 && typeof argv[repoFlagIndex + 1] === "string" && argv[repoFlagIndex + 1].trim() !== ""
    ? resolvePath(argv[repoFlagIndex + 1].trim())
    : scriptRoot;

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
  if (forceNoGit) return undefined;
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

/**
 * 逐对象扫描 git 历史（**唯一可信口径**：`git cat-file --batch-all-objects --batch` 能解开 pack 内容）。
 * 输出格式为 `<oid> <type> <size>\n<content>\n`，按 size 逐字节切分，避免内容里的换行误判。
 * @returns {{ok: boolean, objects: number, error?: string}}
 */
function scanGitObjectsViaCatFile(gitBinary) {
  const result = spawnSync(
    gitBinary,
    ["-C", repoRoot, "cat-file", "--batch-all-objects", "--batch"],
    { maxBuffer: 1024 * 1024 * 1024, encoding: "buffer" },
  );
  if (result.status !== 0 && (result.stdout === null || result.stdout === undefined || result.stdout.length === 0)) {
    return { ok: false, objects: 0, error: `${result.stderr?.toString("utf8") ?? "cat-file failed"}`.trim().slice(0, 300) };
  }
  const buffer = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout ?? ""), "utf8");
  let offset = 0;
  let objects = 0;
  while (offset < buffer.length) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline < 0) break;
    const header = buffer.subarray(offset, newline).toString("utf8");
    const parts = header.trim().split(/\s+/);
    if (parts.length < 3) {
      offset = newline + 1;
      continue;
    }
    const [, type, sizeText] = parts;
    const size = Number.parseInt(sizeText, 10);
    if (!Number.isFinite(size)) break;
    const contentStart = newline + 1;
    const contentEnd = contentStart + size;
    const content = buffer.subarray(contentStart, Math.min(contentEnd, buffer.length)).toString("utf8");
    objects += 1;
    scanText(content, `${relative(repoRoot, joinPath(repoRoot, ".git")) || ".git"} object ${parts[0]} (${type})`, findings);
    offset = contentEnd + 1; // 跳过对象结尾的 \n
  }
  return { ok: true, objects };
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
const meta = { repoRoot, gitBinary: undefined, trackedFiles: 0, gitObjectsScanned: 0, gitPacks: 0, notes: [], unverifiable: false };

const gitBinary = findGitBinary();
meta.gitBinary = gitBinary;
if (gitBinary === undefined) {
  meta.notes.push(
    forceNoGit ? "已用 --no-git 强制禁用 git（历史对象只能退化为 loose zlib 扫描）" : "未找到 git（历史对象只能退化为 loose zlib 扫描）",
  );
}

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
  const packDir = joinPath(objectsDir, "pack");
  const packFiles = existsSync(packDir)
    ? readdirSync(packDir, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".pack")).map((entry) => joinPath(packDir, entry.name))
    : [];
  meta.gitPacks = packFiles.length;

  if (!existsSync(objectsDir)) {
    meta.notes.push("仓库内没有 .git/objects（无 git 历史可扫）");
  } else if (gitBinary !== undefined) {
    const viaCatFile = scanGitObjectsViaCatFile(gitBinary);
    if (viaCatFile.ok) {
      meta.gitObjectsScanned = viaCatFile.objects;
      meta.notes.push(`历史对象用 git cat-file --batch-all-objects 逐对象扫描（含 pack）：${viaCatFile.objects} 个对象`);
    } else {
      meta.notes.push(`git cat-file 逐对象扫描失败：${viaCatFile.error ?? "unknown"}`);
      if (packFiles.length > 0) {
        meta.unverifiable = true;
        meta.notes.push("存在 pack 且无法逐对象扫描 → 历史无法验证（按口径直接判失败）");
      }
    }
  } else if (packFiles.length > 0) {
    // 兜底（t11/f1）：没有 git 但有 pack → 无法验证历史，绝不假报干净
    meta.unverifiable = true;
    meta.notes.push(
      `存在 ${packFiles.length} 个 pack 文件且无 git 可用 → **历史无法验证**；请在有 git 的环境用 ` +
        `\`git cat-file --batch-all-objects --batch\` 逐对象扫描后重试`,
    );
    for (const packFile of packFiles) {
      const raw = readFileSync(packFile).toString("latin1");
      scanText(raw, relative(repoRoot, packFile).split("\\").join("/") + " (packed, best-effort)", findings);
    }
  } else {
    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = joinPath(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (full.includes(`${joinPath("objects", "pack")}`)) continue;
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
const ok = realFindings.length === 0 && meta.unverifiable !== true;

if (asJson) {
  console.log(JSON.stringify({ ok, meta, realFindings, placeholderFindings }, null, 2));
} else {
  console.log(
    `仓库级敏感内容扫描：受控文件 ${meta.trackedFiles} 个，git 对象 ${meta.gitObjectsScanned} 个` +
      `${meta.gitPacks > 0 ? `，pack 文件 ${meta.gitPacks} 个` : ""}`,
  );
  console.log(`git：${meta.gitBinary ?? "(未找到)"}`);
  for (const note of meta.notes) console.log(`  INFO  ${note}`);
  for (const item of realFindings) console.log(`  FAIL  [${item.kind}] ${item.where}: ${item.sample}`);
  if (!quietPlaceholders) {
    for (const item of placeholderFindings) console.log(`  info  [${item.kind}·占位符] ${item.where}: ${item.sample}`);
  }
  console.log(
    `\n---- scan-repo-hygiene：真实敏感命中 ${realFindings.length}，占位符命中 ${placeholderFindings.length}` +
      `${meta.unverifiable ? "，历史无法验证（见 INFO）" : ""}（占位符不算失败） ----`,
  );
}

process.exit(ok ? 0 : 1);
