/**
 * check-config-samples —— config/ 样例门禁。
 *
 * 运行：node scripts/check-config-samples.mjs
 * 退出码：0 = 通过；1 = 有样例不合规。
 *
 * 检查三件事：
 *   1) config/ 下所有 .json 可被 JSON.parse；
 *   2) config/dsh-webhook-bridge.patch.sample.yml 与参考样例
 *      plugins/dsh-webhook-bridge/cordis.patch.yml 的**键骨架**完全一致
 *      （行序 + 缩进 + 列表标记 + 键名）。本仓库不引入 YAML 依赖，因此用这个
 *      结构性比对替代「YAML 能否解析」，并且只比较骨架、不比较值；
 *   3) config/ 下所有文本里**没有任何真实密钥/token/账号 id**：只允许占位符。
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join as joinPath, relative, resolve as resolvePath } from "node:path";

const repoRoot = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const configDir = joinPath(repoRoot, "config");
const sampleYaml = joinPath(configDir, "dsh-webhook-bridge.patch.sample.yml");
const referenceYaml = joinPath(repoRoot, "plugins", "dsh-webhook-bridge", "cordis.patch.yml");

let failed = 0;
function fail(message) {
  failed += 1;
  console.log(`  FAIL  ${message}`);
}
function pass(message) {
  console.log(`  PASS  ${message}`);
}

/** 提取 YAML 的键骨架：行序 + 缩进 + 是否列表项 + 键名。 */
function yamlKeySkeleton(text) {
  const skeleton = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+$/, "");
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = /^(\s*)(-\s+)?([A-Za-z_][A-Za-z0-9_.-]*):/.exec(line);
    if (match === null) continue;
    skeleton.push(`${match[1].length}:${match[2] === undefined ? "" : "-"}${match[3]}`);
  }
  return skeleton;
}

console.log("== 1. JSON 样例可解析 ==");
const configFiles = readdirSync(configDir, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => joinPath(configDir, entry.name))
  .sort();

for (const filePath of configFiles.filter((file) => file.endsWith(".json"))) {
  const rel = relative(repoRoot, filePath).split("\\").join("/");
  try {
    JSON.parse(readFileSync(filePath, "utf8"));
    pass(`${rel} 可被 JSON.parse`);
  } catch (error) {
    fail(`${rel} 不是合法 JSON：${String(error)}`);
  }
}

console.log("\n== 2. YAML 样例与参考样例的键骨架一致 ==");
try {
  const sample = yamlKeySkeleton(readFileSync(sampleYaml, "utf8"));
  const reference = yamlKeySkeleton(readFileSync(referenceYaml, "utf8"));
  if (sample.length === 0) {
    fail("样例 YAML 未提取到任何键");
  } else if (sample.join("|") !== reference.join("|")) {
    fail(
      `键骨架不一致：\n        样例   : ${sample.join(" | ")}\n        参考   : ${reference.join(" | ")}`,
    );
  } else {
    pass(`${relative(repoRoot, sampleYaml).split("\\").join("/")} 与参考样例键骨架一致（${sample.length} 个键）`);
  }
} catch (error) {
  fail(`无法比对 YAML 键骨架：${String(error)}`);
}

/** 明确的占位符特征：命中即视为安全。 */
const PLACEHOLDER_HINTS = ["<", ">", "placeholder", "example", "your", "xxxx", "path\\to", "path/to", "…", "..."];
/** 环境变量**名**（不是值）：`secretEnv: DSH_BRIDGE_SECRET` 这类不构成密钥。 */
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]{2,}$/;
const SUSPICIOUS_PATTERNS = [
  { name: "OpenAI 风格密钥", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/g },
  { name: "Bearer 长载荷", pattern: /\bBearer\s+[A-Za-z0-9._-]{16,}/g },
  { name: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./g },
  { name: "疑似 32+ 位 token", pattern: /\b[A-Za-z0-9_+/=-]{32,}\b/g },
  { name: "微信 im.wechat 账号 id", pattern: /\b[A-Za-z0-9_-]{6,}@im\.wechat\b/gi },
  { name: "纯数字长账号 id", pattern: /^\d{9,}$/g },
];

const SENSITIVE_KEY_PATTERN = /(secret|token|password|passwd|apikey|api_key|credential)/i;
/** 这些键虽然含 secret 字样，但值是「名字/路径」而不是密钥本身。 */
const NAME_LIKE_KEYS = /(env|envvar|file|path)$/i;
/**
 * 机器专属路径（f3 的判定口径）：`C:\Users\<真实用户名>\…` / `…\Documents and Settings\<用户名>\…`。
 * 这些**不允许**出现在受版本控制的样例里；应改成占位符，真实值放 `*.local.*`（已 gitignore）。
 */
const MACHINE_PATH_PATTERN = /[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/](?!<|\{|\$)[^\\/]+/;
/** 允许存放机器真实值的本地覆盖文件（被 .gitignore 的 `config/*.local.*` 排除）。 */
const LOCAL_OVERRIDE_PATTERN = /\.local\./i;

function isPlaceholder(value) {
  const lowered = String(value).toLowerCase();
  return PLACEHOLDER_HINTS.some((hint) => lowered.includes(hint));
}

function isAcceptableSecretValue(value) {
  const trimmed = String(value).trim().replace(/^['"]|['"]$/g, "");
  return trimmed === "" || isPlaceholder(trimmed) || ENV_NAME_PATTERN.test(trimmed);
}

function scanValue(where, value, { allowMachinePath = false } = {}) {
  const text = String(value);
  const wholeIsPlaceholder = isPlaceholder(text);
  for (const { name, pattern } of SUSPICIOUS_PATTERNS) {
    pattern.lastIndex = 0;
    const match = pattern.exec(text);
    if (match === null) continue;
    // 整值或命中片段带占位符特征（如 `<repo>/plugins/openclaw-hook-dsh-bridge`）即视为安全，
    // 否则长的路径片段会被「32+ 位 token」启发式误报。
    if (wholeIsPlaceholder || isPlaceholder(match[0])) continue;
    fail(`${where}: 命中「${name}」可疑值 ${JSON.stringify(match[0].slice(0, 24))}…`);
  }
  if (!allowMachinePath) {
    const machinePath = MACHINE_PATH_PATTERN.exec(text);
    if (machinePath !== null) {
      fail(
        `${where}: 样例里出现机器专属路径（用户名目录）${JSON.stringify(machinePath[0])}；` +
          `请改为占位符，并把真实值放进 *.local.* 本地覆盖文件`,
      );
    }
  }
}

console.log("\n== 3. 样例中不含真实密钥/token/账号 id ==");

for (const filePath of configFiles) {
  const rel = relative(repoRoot, filePath).split("\\").join("/");

  if (filePath.endsWith(".json")) {
    const parsed = JSON.parse(readFileSync(filePath, "utf8"));
    const entries = [];
    const walk = (node, pathLabel, keyHint = "") => {
      if (node === null || typeof node !== "object") {
        if (typeof node === "string") entries.push({ where: `${rel}:${pathLabel}`, value: node, keyHint });
        return;
      }
      for (const [key, value] of Object.entries(node)) {
        walk(value, pathLabel === "" ? key : `${pathLabel}.${key}`, key);
      }
    };
    walk(parsed, "");
    for (const entry of entries) {
      scanValue(entry.where, entry.value, { allowMachinePath: LOCAL_OVERRIDE_PATTERN.test(rel) });
      if (SENSITIVE_KEY_PATTERN.test(entry.keyHint) && !NAME_LIKE_KEYS.test(entry.keyHint) && !isAcceptableSecretValue(entry.value)) {
        fail(`${entry.where}: 敏感字段的值看起来不是占位符/env 变量名，请改成 <PLACEHOLDER> 形式`);
      }
    }
    continue;
  }

  // YAML / Markdown / JSON5：只检查 `key: value` 形式里的 value 部分，避免把文档正文、
  // 表格、路径当成密钥（散文误报会掩盖真问题）。
  if (/\.(yml|yaml|md|txt|json5)$/i.test(filePath)) {
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      const withoutListMarker = line.trim().replace(/^-\s+/, "");
      const match = /^([A-Za-z_][A-Za-z0-9_.-]*):\s*(.*)$/.exec(withoutListMarker);
      if (match !== null) {
        const [, key, rawValue] = match;
        if (rawValue.trim() !== "") {
          const value = rawValue.replace(/\s+#.*$/, "").trim();
          scanValue(`${rel}:${index + 1}`, value, { allowMachinePath: LOCAL_OVERRIDE_PATTERN.test(rel) });
          if (SENSITIVE_KEY_PATTERN.test(key) && !NAME_LIKE_KEYS.test(key) && !isAcceptableSecretValue(value)) {
            fail(`${rel}:${index + 1}: 敏感字段 ${key} 的值看起来不是占位符/env 变量名，请改成 <PLACEHOLDER> 形式`);
          }
        }
        continue;
      }
      // `.json5` 里数组元素也可能带机器路径（如 extraDirs: ["C:\\Users\\…"]），
      // 因此对"看起来是路径字面量"的行也做机器路径扫描。
      const quotedPaths = line.match(/["'][A-Za-z]:[\\/][^"']*["']/g);
      if (quotedPaths === null) continue;
      for (const quoted of quotedPaths) {
        scanValue(`${rel}:${index + 1}`, quoted.replace(/^["']|["']$/g, ""), { allowMachinePath: LOCAL_OVERRIDE_PATTERN.test(rel) });
      }
    }
  }
}
if (failed === 0) pass("config/ 样例未发现真实密钥/token/账号 id（仅占位符）");

console.log(`\n---- check-config-samples: ${failed === 0 ? "通过" : `${failed} 项失败`} ----`);
if (failed > 0) {
  console.log("config 样例门禁未通过。");
  process.exit(1);
}
console.log("config/ 样例全部合规。");
process.exit(0);
