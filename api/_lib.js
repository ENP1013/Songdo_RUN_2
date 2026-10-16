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
// 읽기 전용 공개 화면(랭킹·커뮤니티)용: 로그인했으면 사용자, 아니면 null (IP별 요청 제한 적용)
async function optionalUser(req) {
  if (!readSession(req)) { await rateLimit(`pubread:${clientIp(req)}`, 300, 600); return null; }
  try { return await requireUser(req); } catch (e) { if (e.status === 401) { await rateLimit(`pubread:${clientIp(req)}`, 300, 600); return null; } throw e; }
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

/* ---------- 랭킹 (기간별 Redis 정렬집합, 점수 = 거리 m) ---------- */
const RANK_TTL = { day: 100 * 86400, week: 400 * 86400, month: 800 * 86400 };
const todayKst = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);   // 한국 날짜 기준
function rankKeys(date) {   // 'YYYY-MM-DD' → 일·주(월요일 시작)·월 키
  const [y, m, d] = date.split("-").map(Number), t = Date.UTC(y, m - 1, d);
  const mon = new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * 864e5).toISOString().slice(0, 10);
  return { day: `rank:day:${date}`, week: `rank:week:${mon}`, month: `rank:month:${date.slice(0, 7)}` };
}
// 기록 추가(+)·삭제(-) 시 세 기간의 점수를 함께 갱신하는 명령들
function rankCmds(date, km, nickname, sign = 1) {
  const meters = sign * Math.round(km * 1000), keys = rankKeys(date);
  return Object.entries(keys).flatMap(([p, k]) => [["ZINCRBY", k, meters, nickname], ["EXPIRE", k, RANK_TTL[p]]]);
}

// 모든 가입자의 모든 기록을 원본(workouts:*)에서 다시 합산해 현재 일·주·월 랭킹을 만든다.
// 증가분(rankCmds)만으로는 기능 도입 전 기록, 만료된 키, 닉네임 불일치를 놓칠 수 있어 주기적으로 맞춘다.
const RANK_SYNC_SEC = 3600;
async function ensureRanking() {
  if (await redis("EXISTS", "rank:synced")) return;
  const userKeys = []; let cursor = "0";
  do {
    const [next, keys] = await redis("SCAN", cursor, "MATCH", "user:*", "COUNT", 500);
    cursor = String(next); userKeys.push(...keys);
  } while (cursor !== "0");
  const users = (await pipeline(userKeys.map(k => ["GET", k]))).map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(u => u && u.id && u.nickname);
  const lists = await pipeline(users.map(u => ["LRANGE", `workouts:${u.id}`, 0, -1]));
  const now = rankKeys(todayKst()), totals = { day: new Map(), week: new Map(), month: new Map() };
  users.forEach((u, i) => (lists[i] || []).forEach(s => {
    let w; try { w = JSON.parse(s); } catch { return; }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(w.date)) return;
    const keys = rankKeys(w.date), meters = Math.round(w.km * 1000);
    for (const p of ["day", "week", "month"]) if (keys[p] === now[p]) totals[p].set(u.nickname, (totals[p].get(u.nickname) || 0) + meters);
  }));
  const cmds = [];
  for (const p of ["day", "week", "month"]) {
    cmds.push(["DEL", now[p]]);
    const args = [...totals[p]].filter(e => e[1] > 0).flatMap(e => [e[1], e[0]]);
    for (let i = 0; i < args.length; i += 400) cmds.push(["ZADD", now[p], ...args.slice(i, i + 400)]);
    cmds.push(["EXPIRE", now[p], RANK_TTL[p]]);
  }
  cmds.push(["SET", "rank:synced", "1", "EX", RANK_SYNC_SEC]);
  await pipeline(cmds);
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
  redis, pipeline, rankKeys, rankCmds, ensureRanking, todayKst, HttpError, hashPassword, checkPassword, setSession, clearSession, readSession, requireUser, optionalUser,
  nickKey, validNick, validWeight, publicUser, clientIp, rateLimit, handler,
  _setRedis: (fn, pipe) => { redisImpl = fn; pipelineImpl = pipe || (cmds => Promise.all(cmds.map(c => fn(...c)))); },   // 테스트용
};
