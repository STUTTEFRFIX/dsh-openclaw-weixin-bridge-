// 正确解码多帧拼接的 zstd 会话日志，并打印全部行的摘要
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { zstdDecompressSync } from "node:zlib";

/** 逐帧解压拼接的 zstd 数据（zstdDecompressSync 只解第一帧）。 */
function decompressAll(buf) {
  const outs = [];
  let offset = 0;
  while (offset < buf.length) {
    const rest = buf.subarray(offset);
    try {
      outs.push(zstdDecompressSync(rest));
    } catch {
      break;
    }
    // 通过二分找出本帧占用的输入长度
    let lo = 1;
    let hi = rest.length;
    let consumed = rest.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      try {
        zstdDecompressSync(rest.subarray(0, mid));
        consumed = mid;
        hi = mid - 1;
      } catch {
        lo = mid + 1;
      }
    }
    offset += consumed;
    if (consumed <= 0) break;
  }
  return Buffer.concat(outs);
}

const root = process.argv[2];
const targets = [];
for (const dir of readdirSync(root)) {
  const p = join(root, dir);
  if (!statSync(p).isDirectory()) continue;
  for (const sub of readdirSync(p)) {
    const sp = join(p, sub);
    if (!statSync(sp).isDirectory()) continue;
    const f = join(sp, "session.v4.jsonl.zstd");
    try { const st = statSync(f); targets.push({ file: f, size: st.size, mtime: st.mtimeMs, session: sub }); } catch {}
  }
}
targets.sort((a, b) => b.mtime - a.mtime);
const pick = targets.find((t) => t.session.startsWith("webhook-"));
if (!pick) { console.log("未找到 webhook 会话"); process.exit(0); }
console.log(`检查: ${pick.session}  (${pick.size} bytes)\n`);

const raw = decompressAll(readFileSync(pick.file)).toString("utf8");
const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== "");
console.log(`解码后行数 = ${lines.length}\n`);
for (const [i, line] of lines.entries()) {
  let obj;
  try { obj = JSON.parse(line); } catch { console.log(`[${i}] 非 JSON`); continue; }
  const type = obj.type ?? "?";
  if (i === 0) {
    console.log(`[0] type=${type}  ${JSON.stringify(obj).slice(0, 300)}`);
  } else if (type.includes("message")) {
    const content = obj.message?.content ?? obj.content ?? obj.data?.content;
    const text = typeof content === "string" ? content : JSON.stringify(content ?? obj.data ?? null);
    console.log(`[${i}] type=${type} role=${obj.message?.role ?? obj.role ?? "?"} source=${JSON.stringify(obj.message?.source ?? obj.source ?? null)}`);
    console.log(`      text: ${String(text).slice(0, 300)}`);
  } else {
    console.log(`[${i}] type=${type}  ${JSON.stringify(obj).slice(0, 200)}`);
  }
}


