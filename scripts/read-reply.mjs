// 打印某会话的最后若干条助手回复正文（用于把执行结果回传给调用方）
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

function decompressAll(buf) {
  const outs = [];
  let offset = 0;
  while (offset < buf.length) {
    const rest = buf.subarray(offset);
    try { outs.push(zstdDecompressSync(rest)); } catch { break; }
    let lo = 1, hi = rest.length, consumed = rest.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      try { zstdDecompressSync(rest.subarray(0, mid)); consumed = mid; hi = mid - 1; }
      catch { lo = mid + 1; }
    }
    offset += consumed;
    if (consumed <= 0) break;
  }
  return Buffer.concat(outs);
}

function extractText(message) {
  const content = message?.content;
  if (!Array.isArray(content)) return "";
  return content.filter((b) => b?.type === "text").map((b) => b.text ?? "").join("\n").trim();
}

const root = process.argv[2];
const wantSession = process.argv[3] ?? "";
const tailCount = Number(process.argv[4] ?? 2);

const candidates = [];
for (const dir of readdirSync(root)) {
  const p = join(root, dir);
  if (!statSync(p).isDirectory()) continue;
  for (const sub of readdirSync(p)) {
    if (!sub.startsWith("webhook-")) continue;
    if (wantSession && !sub.includes(wantSession)) continue;
    const f = join(p, sub, "session.v4.jsonl.zstd");
    try { candidates.push({ sub, f, mtime: statSync(f).mtimeMs }); } catch {}
  }
}
candidates.sort((a, b) => b.mtime - a.mtime);
const pick = candidates[0];
if (!pick) { console.log("未找到匹配会话"); process.exit(0); }

const lines = decompressAll(readFileSync(pick.f)).toString("utf8").split(/\r?\n/).filter((l) => l.trim() !== "");
let title = "", end = "running", turns = 0;
const replies = [];
for (const line of lines) {
  let o;
  try { o = JSON.parse(line); } catch { continue; }
  if (o.type === "session/title") title = o.data?.title ?? title;
  if (o.type === "turn/end") { end = o.data?.reason?.kind ?? "ended"; turns += 1; }
  if (o.type === "assistant/message") {
    const text = extractText(o.data?.message ?? o.message);
    if (text) replies.push(text);
  }
}
console.log(`会话   : ${pick.sub}`);
console.log(`标题   : ${JSON.stringify(title)}`);
console.log(`事件行 : ${lines.length}   完成轮次: ${turns}   末轮状态: ${end}`);
console.log(`助手回复条数: ${replies.length}`);
for (const [i, r] of replies.slice(-tailCount).entries()) {
  console.log(`\n--- 倒数第 ${tailCount - i} 条回复 ---`);
  console.log(r.length > 1500 ? `${r.slice(0, 1500)}…（截断）` : r);
}
