// 列出最近的 webhook 会话及其 cwd / 标题 / 是否完成
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

const root = process.argv[2];
const rows = [];
for (const dir of readdirSync(root)) {
  const p = join(root, dir);
  if (!statSync(p).isDirectory()) continue;
  for (const sub of readdirSync(p)) {
    const sp = join(p, sub);
    if (!statSync(sp).isDirectory() || !sub.startsWith("webhook-")) continue;
    const f = join(sp, "session.v4.jsonl.zstd");
    try {
      const st = statSync(f);
      const text = decompressAll(readFileSync(f)).toString("utf8");
      const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
      let cwd = "?", title = "(无)", done = "no";
      for (const line of lines) {
        try {
          const o = JSON.parse(line);
          if (o.type === "session") cwd = o.cwd;
          if (o.type === "session/title") title = o.data?.title ?? title;
          if (o.type === "turn/end") done = o.data?.reason?.kind ?? "ended";
        } catch {}
      }
      rows.push({ mtime: st.mtimeMs, session: sub, cwd, title, done, lines: lines.length });
    } catch {}
  }
}
rows.sort((a, b) => b.mtime - a.mtime);
for (const r of rows.slice(0, 8)) {
  console.log(`${new Date(r.mtime).toISOString().slice(11, 19)}  ${r.session.slice(0, 22)}…  cwd=${r.cwd}  行数=${String(r.lines).padStart(2)}  end=${r.done}  title=${JSON.stringify(r.title)}`);
}
