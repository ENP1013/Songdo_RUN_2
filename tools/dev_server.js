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
    LRANGE: () => (kv.get(a[0]) || []).slice(),
    LLEN: () => (kv.get(a[0]) || []).length,
    RPUSH: () => { const l = kv.get(a[0]) || []; l.push(...a.slice(1)); kv.set(a[0], l); return l.length; },
    LREM: () => { const l = kv.get(a[0]) || []; const i = l.indexOf(a[2]); if (i >= 0) l.splice(i, 1); return i >= 0 ? 1 : 0; },
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
  res.writeHead(200, { "Content-Type": f.endsWith(".html") ? "text/html; charset=utf-8" : "application/octet-stream" });
  fs.createReadStream(f).pipe(res);
}).listen(+process.env.PORT || 3000, function () { console.log("http://localhost:" + this.address().port); });
