// node --test tests/  (메모리 Redis로 API 동작 확인)
const test = require("node:test");
const assert = require("node:assert");
const L = require("../api/_lib");

// --- 메모리 Redis ---
const kv = new Map();
L._setRedis(async (cmd, ...a) => {
  switch (cmd) {
    case "GET": return kv.has(a[0]) ? kv.get(a[0]) : null;
    case "SET": if (a[2] === "NX" && kv.has(a[0])) return null; kv.set(a[0], a[1]); return "OK";
    case "DEL": return kv.delete(a[0]) ? 1 : 0;
    case "INCR": { const n = (+kv.get(a[0]) || 0) + 1; kv.set(a[0], String(n)); return n; }
    case "EXPIRE": return 1;
    case "LRANGE": return (kv.get(a[0]) || []).slice();
    case "LLEN": return (kv.get(a[0]) || []).length;
    case "RPUSH": { const l = kv.get(a[0]) || []; l.push(...a.slice(1)); kv.set(a[0], l); return l.length; }
    case "LREM": { const l = kv.get(a[0]) || []; const i = l.indexOf(a[2]); if (i >= 0) l.splice(i, 1); return i >= 0 ? 1 : 0; }
  }
  throw new Error("unsupported " + cmd);
});

const routes = {
  signup: require("../api/auth/signup"), login: require("../api/auth/login"),
  logout: require("../api/auth/logout"), me: require("../api/me"), workouts: require("../api/workouts"),
};
let ipSeq = 0;
async function call(route, method, { body, cookie, query, ip } = {}) {
  const req = { method, body, query: query || {}, url: "/api/x", headers: {
    "content-type": method === "GET" ? undefined : "application/json", cookie, "x-forwarded-for": ip || `10.0.0.${++ipSeq % 250}` } };
  const out = { status: 0, json: null, headers: {} };
  const res = {
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
    status(s) { out.status = s; return this; },
    json(j) { out.json = j; return this; },
  };
  await routes[route](req, res);
  const sc = out.headers["set-cookie"];
  out.cookie = sc ? sc.split(";")[0] : undefined;
  return out;
}

test("가입 → 내 정보 → 기록 저장·조회·삭제", async () => {
  const s = await call("signup", "POST", { body: { nickname: "준기", password: "1234", weightKg: 70 } });
  assert.equal(s.status, 201);
  assert.match(s.headers["set-cookie"], /HttpOnly; Secure; SameSite=Lax/);
  assert.ok(!JSON.stringify(kv.get("user:준기")).includes('"1234"'), "평문 비밀번호 저장 금지");

  const me = await call("me", "GET", { cookie: s.cookie });
  assert.deepEqual(me.json.user, { nickname: "준기", weightKg: 70 });

  const w = await call("workouts", "POST", { cookie: s.cookie, body: { date: "2026-10-15", courseName: "센트럴파크 둘레 1바퀴", min: 20, km: 2.61, kcal: 152, difficulty: "flat", pace: "jog" } });
  assert.equal(w.status, 201);
  const list = await call("workouts", "GET", { cookie: s.cookie });
  assert.equal(list.json.workouts.length, 1);

  const del = await call("workouts", "DELETE", { cookie: s.cookie, query: { id: w.json.workouts[0].id } });
  assert.equal(del.status, 200);
  assert.equal((await call("workouts", "GET", { cookie: s.cookie })).json.workouts.length, 0);
});

test("닉네임 중복·형식 오류", async () => {
  assert.equal((await call("signup", "POST", { body: { nickname: "준기", password: "abcd" } })).status, 409);
  assert.equal((await call("signup", "POST", { body: { nickname: "a", password: "abcd" } })).status, 400);
  assert.equal((await call("signup", "POST", { body: { nickname: "민지", password: "12" } })).status, 400);
});

test("로그인 실패 5회 → 잠금, 성공 시 쿠키", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call("login", "POST", { body: { nickname: "준기", password: "wrong" } })).status, 401);
  assert.equal((await call("login", "POST", { body: { nickname: "준기", password: "1234" } })).status, 423);
  kv.delete("fail:준기");
  const ok = await call("login", "POST", { body: { nickname: "준기", password: "1234" } });
  assert.equal(ok.status, 200);
  assert.ok(ok.cookie.startsWith("rw_session="));
});

test("다른 사람 기록은 보이지 않고 지울 수 없음", async () => {
  const a = await call("signup", "POST", { body: { nickname: "userA", password: "pass" } });
  const b = await call("signup", "POST", { body: { nickname: "userB", password: "pass" } });
  const w = await call("workouts", "POST", { cookie: a.cookie, body: { workouts: [
    { date: "2026-10-15", courseName: "A코스", min: 40, km: 5.3, kcal: 300 },
    { date: "bad", courseName: "x", min: 40, km: 1, kcal: 1 } ] } });
  assert.equal(w.json.workouts.length, 1, "잘못된 기록은 걸러냄");
  assert.equal((await call("workouts", "GET", { cookie: b.cookie })).json.workouts.length, 0);
  assert.equal((await call("workouts", "DELETE", { cookie: b.cookie, query: { id: w.json.workouts[0].id } })).status, 404);
});

test("로그인 없이·위조 쿠키·JSON 아닌 요청은 거절", async () => {
  assert.equal((await call("workouts", "GET", {})).status, 401);
  assert.equal((await call("me", "GET", { cookie: "rw_session=eyJ1aWQiOiJ4In0.fake" })).status, 401);
  const r = { status: 0 };
  await routes.workouts({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: {} },
    { setHeader() {}, status(s) { r.status = s; return this; }, json() { return this; } });
  assert.equal(r.status, 415);
});

test("로그아웃은 쿠키 만료", async () => {
  const o = await call("logout", "POST", {});
  assert.match(o.headers["set-cookie"], /Max-Age=0/);
});
