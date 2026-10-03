import { resolve as resolvePath, sep } from "node:path";
function resolveWorkspaceWithin(root, requested) {
  const rootPath = resolvePath(root);
  if (requested === undefined) return rootPath;
  const candidate = resolvePath(requested);
  const fold = (value) => (process.platform === "win32" ? value.toLowerCase() : value);
  const foldedRoot = fold(rootPath);
  const foldedCandidate = fold(candidate);
  const prefix = foldedRoot.endsWith(sep) ? foldedRoot : foldedRoot + sep;
  if (foldedCandidate !== foldedRoot && !foldedCandidate.startsWith(prefix)) throw new Error("outside");
  return candidate;
}
const root = "C:\\ws";
const cases = [
  ["默认(undefined)", undefined, true],
  ["根目录本身", "C:\\ws", true],
  ["子目录", "C:\\ws\\sub", true],
  ["穿越 ..\\", "C:\\ws\\..\\Windows", false],
  ["绝对外部", "C:\\Windows", false],
  ["同前缀兄弟目录", "C:\\wsX", false],
  ["大小写变体", "c:\\ws\\sub", true],
  ["大小写外部", "c:\\windows", false],
];
let ok = 0;
for (const [label, input, shouldPass] of cases) {
  let passed = true, out = "";
  try { out = resolveWorkspaceWithin(root, input); } catch { passed = false; }
  const good = passed === shouldPass;
  if (good) ok++;
  console.log((good ? "PASS " : "FAIL ") + label.padEnd(16) + " 允许=" + passed + "  " + out);
}
console.log("---- 围栏自检 " + ok + "/" + cases.length + " ----");
process.exit(ok === cases.length ? 0 : 1);
