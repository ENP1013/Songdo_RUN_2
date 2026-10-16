// 공용 서버 유틸 (파일명이 _로 시작해 Vercel 라우트가 되지 않음)
// 저장소: Upstash Redis REST API (Vercel Storage에서 연결하면 환경변수가 자동 등록됨)
const crypto = require("crypto");

const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }

let redisImpl = async (...cmd) => {
  if (!REDIS_URL || !REDIS_TOKEN) throw new HttpError(503, "기록 저장소가 아직 연결되지 않았어요");
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error);
  return j.result;
};
const redis = (...cmd) => redisImpl(...cmd);
// 여러 명령을 한 번의 요청으로 (Upstash /pipeline). 결과는 명령 순서대로의 값 배열
let pipelineImpl = async cmds => {
  if (!REDIS_URL || !REDIS_TOKEN) throw new HttpError(503, "기록 저장소가 아직 연결되지 않았어요");
  const r = await fetch(REDIS_URL.replace(/\/$/, "") + "/pipeline", {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmds),
  });
  const j = await r.json();
  return j.map(x => { if (x.error) throw new Error(x.error); return x.result; });
};
const pipeline = cmds => cmds.length ? pipelineImpl(cmds) : Promise.resolve([]);

/* ---------- 비밀번호 (scrypt) ---------- */
function hashPassword(pw, salt = crypto.randomBytes(16).toString("hex")) {
  return { salt, hash: crypto.scryptSync(pw, salt, 32).toString("hex") };
}
function checkPassword(pw, salt, hash) {
  const a = Buffer.from(crypto.scryptSync(pw, salt, 32).toString("hex")), b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/* ---------- 세션 (서명된 httpOnly 쿠키, 30일) ---------- */
const COOKIE = "rw_session", MAX_AGE = 30 * 24 * 3600;
// SESSION_SECRET이 없으면 Redis 토큰에서 파생 (둘 다 서버에만 있음)
const secret = () => process.env.SESSION_SECRET || crypto.createHash("sha256").update("rw-session:" + (REDIS_TOKEN || "dev")).digest("hex");
const b64 = s => Buffer.from(s).toString("base64url");
const mac = data => crypto.createHmac("sha256", secret()).update(data).digest("base64url");

function setSession(res, user) {
  const body = b64(JSON.stringify({ uid: user.id, nick: user.nickname, exp: Date.now() + MAX_AGE * 1000 }));
  res.setHeader("Set-Cookie", `${COOKIE}=${body}.${mac(body)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${MAX_AGE}`);
}
function clearSession(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`);
}
function readSession(req) {
  const m = (req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (!m) return null;
  const [body, sig] = m[1].split(".");
  if (!body || !sig) return null;
  const want = Buffer.from(mac(body)), got = Buffer.from(sig);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  try { const s = JSON.parse(Buffer.from(body, "base64url").toString()); return s.exp > Date.now() ? s : null; } catch { return null; }
}
async function requireUser(req) {
  const s = readSession(req);
  if (!s) throw new HttpError(401, "로그인이 필요해요");
  const raw = await redis("GET", `user:${nickKey(s.nick)}`);
  const user = raw && JSON.parse(raw);
  if (!user || user.id !== s.uid) throw new HttpError(401, "로그인이 필요해요");
  return user;
}

/* ---------- 입력 검증 ---------- */
const nickKey = n => String(n).normalize("NFC").toLowerCase();
function validNick(n) { return typeof n === "string" && /^[가-힣A-Za-z0-9]{2,12}$/.test(n.normalize("NFC")); }
function validWeight(w) { return w === null || w === undefined || w === "" || (Number.isFinite(+w) && +w >= 30 && +w <= 150); }
const publicUser = u => ({ nickname: u.nickname, weightKg: u.weightKg ?? null });
const clientIp = req => String(req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "unknown").split(",")[0].trim();

// 요청 횟수 제한: key 당 windowSec 동안 limit 회
async function rateLimit(key, limit, windowSec) {
  const n = await redis("INCR", `rl:${key}`);
  if (n === 1) await redis("EXPIRE", `rl:${key}`, windowSec);
  if (n > limit) throw new HttpError(429, "요청이 너무 많아요. 잠시 후 다시 시도해 주세요");
}

/* ---------- 핸들러 래퍼 ---------- */
function handler(methods) {
  return async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    const fn = methods[req.method];
    if (!fn) { res.setHeader("Allow", Object.keys(methods).join(", ")); return res.status(405).json({ error: "허용되지 않은 요청이에요" }); }
    // 쓰기 요청은 JSON만 받음 (다른 사이트 폼 제출을 통한 CSRF 차단)
    if (req.method !== "GET" && !String(req.headers["content-type"] || "").includes("application/json"))
      return res.status(415).json({ error: "JSON으로 보내 주세요" });
    try { await fn(req, res, req.body || {}); }
    catch (e) {
      if (e instanceof HttpError) return res.status(e.status).json({ error: e.message });
      console.error(e);
      return res.status(500).json({ error: "서버 오류가 났어요. 잠시 후 다시 시도해 주세요" });
    }
  };
}

module.exports = {
  redis, pipeline, HttpError, hashPassword, checkPassword, setSession, clearSession, readSession, requireUser,
  nickKey, validNick, validWeight, publicUser, clientIp, rateLimit, handler,
  _setRedis: (fn, pipe) => { redisImpl = fn; pipelineImpl = pipe || (cmds => Promise.all(cmds.map(c => fn(...c)))); },   // 테스트용
};
