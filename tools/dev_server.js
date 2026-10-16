// 로컬 확인용 서버: docs/ 정적 파일 + api/ 함수 (메모리 저장소, 재시작하면 초기화)
// node tools/dev_server.js → http://localhost:3000 (PORT 환경변수로 변경 가능)
const http = require("http"), fs = require("fs"), path = require("path");
const L = require("../api/_lib");
const ROOT = path.join(__dirname, "..");

if (!process.env.KV_REST_API_URL && !process.env.UPSTASH_REDIS_REST_URL) {
  const kv = new Map();
  L._setRedis(async (cmd, ...a) => ({
    GET: () => kv.get(a[0]) ?? null,
    SET: () => (a[2] === "NX" && kv.has(a[0]) ? null : (kv.set(a[0], a[1]), "OK")),
    DEL: () => (kv.delete(a[0]) ? 1 : 0),
    INCR: () => { const n = (+kv.get(a[0]) || 0) + 1; kv.set(a[0], String(n)); return n; },
    EXPIRE: () => 1,
    LRANGE: () => (kv.get(a[0]) || []).slice(a[1], a[2] === -1 ? undefined : a[2] + 1),
    EXISTS: () => (kv.has(a[0]) ? 1 : 0),
    SADD: () => { const t = kv.get(a[0]) || new Set(); const n = t.has(a[1]) ? 0 : 1; t.add(a[1]); kv.set(a[0], t); return n; },
    SREM: () => { const t = kv.get(a[0]); return t && t.delete(a[1]) ? 1 : 0; },
    SISMEMBER: () => (kv.get(a[0])?.has(a[1]) ? 1 : 0),
    SCARD: () => kv.get(a[0])?.size || 0,
    SMEMBERS: () => [...(kv.get(a[0]) || [])],
    LPUSH: () => { const l = kv.get(a[0]) || []; l.unshift(a[1]); kv.set(a[0], l); return l.length; },
    LTRIM: () => { kv.set(a[0], (kv.get(a[0]) || []).slice(a[1], a[2] + 1)); return "OK"; },
    ZINCRBY: () => { const z = kv.get(a[0]) || new Map(); z.set(a[2], (z.get(a[2]) || 0) + a[1]); kv.set(a[0], z); return String(z.get(a[2])); },
    ZADD: () => { const z = kv.get(a[0]) || new Map(); for (let i = 1; i < a.length - 1; i += 2) z.set(a[i + 1], +a[i]); kv.set(a[0], z); return 1; },
    SCAN: () => { const re = new RegExp("^" + a[2].replace("*", ".*") + "$"); return ["0", [...kv.keys()].filter(k => re.test(k))]; },
    ZSCORE: () => { const v = kv.get(a[0])?.get(a[1]); return v === undefined ? null : String(v); },
    ZREVRANK: () => { const z = kv.get(a[0]); return z?.has(a[1]) ? [...z].sort((x, y) => y[1] - x[1]).findIndex(e => e[0] === a[1]) : null; },
    ZREVRANGE: () => [...(kv.get(a[0]) || [])].sort((x, y) => y[1] - x[1]).slice(a[1], a[2] + 1).flatMap(e => [e[0], String(e[1])]),
    LLEN: () => (kv.get(a[0]) || []).length,
    RPUSH: () => { const l = kv.get(a[0]) || []; l.push(...a.slice(1)); kv.set(a[0], l); return l.length; },
    LREM: () => { const l = kv.get(a[0]) || []; let n = 0; for (let i = 0; i < l.length;) { if (l[i] === a[2] && (a[1] === 0 || n < a[1])) { l.splice(i, 1); n++; } else i++; } return n; },
  })[cmd]());
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    const file = path.join(ROOT, url.pathname + ".js");
    if (!file.startsWith(path.join(ROOT, "api")) || !fs.existsSync(file)) { res.writeHead(404); return res.end(); }
    let raw = ""; for await (const c of req) raw += c;
    req.body = raw ? JSON.parse(raw) : {};
    req.query = Object.fromEntries(url.searchParams);
    res.status = s => { res.statusCode = s; return res; };
    res.json = j => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(j)); return res; };
    return require(file)(req, res);
  }
  const f = path.join(ROOT, "docs", url.pathname === "/" ? "index.html" : url.pathname);
  if (!f.startsWith(path.join(ROOT, "docs")) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  const TYPES = { ".html": "text/html; charset=utf-8", ".mp4": "video/mp4", ".jpg": "image/jpeg" };
  res.writeHead(200, { "Content-Type": TYPES[path.extname(f)] || "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(+process.env.PORT || 3000, function () { console.log("http://localhost:" + this.address().port); });
