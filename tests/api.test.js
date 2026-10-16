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
    case "LRANGE": { const l = kv.get(a[0]) || []; return l.slice(a[1], a[2] === -1 ? undefined : a[2] + 1); }
    case "EXISTS": return kv.has(a[0]) ? 1 : 0;
    case "SADD": { const t = kv.get(a[0]) || new Set(); const n = t.has(a[1]) ? 0 : 1; t.add(a[1]); kv.set(a[0], t); return n; }
    case "SREM": { const t = kv.get(a[0]); return t && t.delete(a[1]) ? 1 : 0; }
    case "SISMEMBER": return kv.get(a[0])?.has(a[1]) ? 1 : 0;
    case "ZINCRBY": { const z = kv.get(a[0]) || new Map(); z.set(a[2], (z.get(a[2]) || 0) + a[1]); kv.set(a[0], z); return String(z.get(a[2])); }
    case "ZSCORE": { const v = kv.get(a[0])?.get(a[1]); return v === undefined ? null : String(v); }
    case "ZREVRANK": { const z = kv.get(a[0]); if (!z?.has(a[1])) return null; return [...z].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? 1 : -1)).findIndex(e => e[0] === a[1]); }
    case "ZREVRANGE": return [...(kv.get(a[0]) || [])].sort((x, y) => y[1] - x[1] || (x[0] < y[0] ? 1 : -1)).slice(a[1], a[2] + 1).flatMap(e => [e[0], String(e[1])]);
    case "ZADD": { const z = kv.get(a[0]) || new Map(); for (let i = 1; i < a.length - 1; i += 2) z.set(a[i + 1], +a[i]); kv.set(a[0], z); return 1; }
    case "SCAN": { const re = new RegExp("^" + a[2].replace("*", ".*") + "$"); return ["0", [...kv.keys()].filter(k => re.test(k))]; }
    case "SCARD": return kv.get(a[0])?.size || 0;
    case "SMEMBERS": return [...(kv.get(a[0]) || [])];
    case "LPUSH": { const l = kv.get(a[0]) || []; l.unshift(a[1]); kv.set(a[0], l); return l.length; }
    case "LTRIM": { const l = kv.get(a[0]) || []; kv.set(a[0], l.slice(a[1], a[2] + 1)); return "OK"; }
    case "LLEN": return (kv.get(a[0]) || []).length;
    case "RPUSH": { const l = kv.get(a[0]) || []; l.push(...a.slice(1)); kv.set(a[0], l); return l.length; }
    case "LREM": { const l = kv.get(a[0]) || []; let n = 0; for (let i = 0; i < l.length;) { if (l[i] === a[2] && (a[1] === 0 || n < a[1])) { l.splice(i, 1); n++; } else i++; } return n; }
  }
  throw new Error("unsupported " + cmd);
});

const routes = {
  signup: require("../api/auth/signup"), login: require("../api/auth/login"),
  logout: require("../api/auth/logout"), feed: require("../api/feed"), ranking: require("../api/ranking"), comments: require("../api/comments"), me: require("../api/me"), workouts: require("../api/workouts"),
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
  const s = await call("signup", "POST", { body: { nickname: "준기", password: "pass1234", weightKg: 70 } });
  assert.equal(s.status, 201);
  assert.match(s.headers["set-cookie"], /HttpOnly; Secure; SameSite=Lax/);
  assert.ok(!JSON.stringify(kv.get("user:준기")).includes('"pass1234"'), "평문 비밀번호 저장 금지");

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
  assert.equal((await call("signup", "POST", { body: { nickname: "준기", password: "abcd1234" } })).status, 409);
  assert.equal((await call("signup", "POST", { body: { nickname: "a", password: "abcd1234" } })).status, 400);
  for (const password of ["abc", "a".repeat(17), 12345678, ""]) assert.equal((await call("signup", "POST", { body: { nickname: "길이검사", password } })).status, 400, "비밀번호는 4~16자: " + password);
  assert.equal((await call("signup", "POST", { body: { nickname: "길이경계4", password: "a".repeat(4) } })).status, 201);
  assert.equal((await call("signup", "POST", { body: { nickname: "길이경계16", password: "a".repeat(16) } })).status, 201);
  assert.equal((await call("signup", "POST", { body: { nickname: "민지", password: "12" } })).status, 400);
});

test("로그인 실패 5회 → 잠금, 성공 시 쿠키", async () => {
  for (let i = 0; i < 5; i++) assert.equal((await call("login", "POST", { body: { nickname: "준기", password: "wrong" } })).status, 401);
  assert.equal((await call("login", "POST", { body: { nickname: "준기", password: "pass1234" } })).status, 423);
  kv.delete("fail:준기");
  const ok = await call("login", "POST", { body: { nickname: "준기", password: "pass1234" } });
  assert.equal(ok.status, 200);
  assert.ok(ok.cookie.startsWith("rw_session="));
});

test("다른 사람 기록은 보이지 않고 지울 수 없음", async () => {
  const a = await call("signup", "POST", { body: { nickname: "userA", password: "pass1234" } });
  const b = await call("signup", "POST", { body: { nickname: "userB", password: "pass1234" } });
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

test("커뮤니티: 공유 → 피드 → 좋아요·댓글 → 공유 해제", async () => {
  const a = await call("signup", "POST", { body: { nickname: "러너A", password: "pass1234" } });
  const b = await call("signup", "POST", { body: { nickname: "러너B", password: "pass1234" } });
  const w = await call("workouts", "POST", { cookie: a.cookie, body: { date: "2026-10-16", courseName: "해돋이 공원", min: 40, km: 5.1, kcal: 300 } });
  const id = w.json.workouts[0].id;

  assert.equal((await call("feed", "GET", {})).status, 200, "피드는 로그인 없이도 볼 수 있음");
  assert.equal((await call("feed", "GET", { cookie: b.cookie })).json.posts.length, 0);

  assert.equal((await call("workouts", "PATCH", { cookie: b.cookie, query: { id }, body: { shared: true } })).status, 404, "남의 기록은 공유 불가");
  await call("workouts", "PATCH", { cookie: a.cookie, query: { id }, body: { shared: true } });
  await call("workouts", "PATCH", { cookie: a.cookie, query: { id }, body: { shared: true } });   // 중복 공유해도 한 번만
  assert.equal((await call("workouts", "GET", { cookie: a.cookie })).json.workouts[0].shared, true);

  const feed = await call("feed", "GET", { cookie: b.cookie });
  assert.equal(feed.json.posts.length, 1);
  assert.equal(feed.json.posts[0].nickname, "러너A");
  assert.ok(!("uid" in feed.json.posts[0]));

  const like = await call("feed", "POST", { cookie: b.cookie, body: { id } });
  assert.deepEqual([like.json.liked, like.json.likes], [true, 1]);
  assert.equal((await call("feed", "POST", { cookie: b.cookie, body: { id } })).json.likes, 0, "다시 누르면 취소");

  const c = await call("comments", "POST", { cookie: b.cookie, body: { id, text: "  화이팅!  " } });
  assert.equal(c.json.comment.text, "화이팅!");
  assert.equal((await call("comments", "POST", { cookie: b.cookie, body: { id, text: "" } })).status, 400);
  assert.equal((await call("feed", "GET", { cookie: a.cookie })).json.posts[0].comments, 1);
  const cid = c.json.comment.id;
  const third = await call("signup", "POST", { body: { nickname: "러너C", password: "pass1234" } });
  assert.equal((await call("comments", "DELETE", { cookie: third.cookie, query: { id, cid } })).status, 403);
  assert.equal((await call("comments", "DELETE", { cookie: a.cookie, query: { id, cid } })).status, 200, "게시물 주인은 댓글 삭제 가능");

  await call("workouts", "PATCH", { cookie: a.cookie, query: { id }, body: { shared: false } });
  assert.equal((await call("feed", "GET", { cookie: b.cookie })).json.posts.length, 0);
  assert.equal((await call("comments", "GET", { cookie: b.cookie, query: { id } })).status, 404);
});

test("랭킹: 일·주·월 거리 합산, 동점 같은 순위, 삭제 시 차감, 로그인 필요", async () => {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const mk = async nick => (await call("signup", "POST", { body: { nickname: nick, password: "pass1234" } })).cookie;
  const [x, y, z] = [await mk("랭크엑스"), await mk("랭크와이"), await mk("랭크제트")];
  const add = (c, km, date = today) => call("workouts", "POST", { cookie: c, body: { date, courseName: "코스", min: 30, km, kcal: 100 } });
  const first = await add(x, 3.2);
  await add(x, 1.8);                       // X 합계 5
  await add(y, 5);                         // Y 5 → X와 동점
  await add(z, 2.5, "2000-01-03");         // 아주 옛날 기록: 이번 기간 랭킹에 안 잡힘

  const anon = await call("ranking", "GET", {});   // 비로그인도 랭킹은 볼 수 있음
  assert.equal(anon.status, 200); assert.equal(anon.json.me, null); assert.ok(anon.json.rows.every(r => r.mine === false));
  for (const period of ["day", "week", "month"]) {
    const r = (await call("ranking", "GET", { cookie: z, query: { period } })).json;
    const mine = r.rows.filter(a => ["랭크엑스", "랭크와이"].includes(a.nickname));
    assert.deepEqual(mine.map(a => a.km), [5, 5]);
    assert.equal(mine[0].rank, mine[1].rank, period + " 동점은 같은 순위");
    assert.equal(r.me, null, "이번 기간 기록 없는 사용자는 순위 없음");
  }
  await call("workouts", "DELETE", { cookie: x, query: { id: first.json.workouts[0].id } });
  const r = (await call("ranking", "GET", { cookie: x, query: { period: "week" } })).json;
  assert.equal(r.me.km, 1.8, "삭제하면 거리 차감");
  const rk = n => r.rows.find(a => a.nickname === n).rank;
  assert.ok(rk("랭크와이") < rk("랭크엑스"));
});

test("랭킹: 집계 도입 전 기록·누락된 점수도 모든 사용자 기록에서 자동 복구", async () => {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const mk = async nick => (await call("signup", "POST", { body: { nickname: nick, password: "pass1234" } })).cookie;
  const [a, b] = [await mk("복구에이"), await mk("복구비이")];
  const add = (c, km) => call("workouts", "POST", { cookie: c, body: { date: today, courseName: "코스", min: 30, km, kcal: 100 } });
  await add(a, 2); await add(a, 1.5); await add(b, 4);
  for (const k of [...kv.keys()]) if (k.startsWith("rank:")) kv.delete(k);   // 점수 유실 상황
  const r = (await call("ranking", "GET", { cookie: a, query: { period: "day" } })).json;
  assert.equal(r.me.km, 3.5, "내 모든 기록 합산");
  assert.equal(r.rows.find(x => x.nickname === "복구비이").km, 4, "다른 사용자 기록도 합산");
});

test("댓글: 좋아요 토글, 대댓글(답글의 답글은 같은 묶음), 부모 삭제 시 답글도 삭제", async () => {
  const mk = async nick => (await call("signup", "POST", { body: { nickname: nick, password: "pass1234" } })).cookie;
  const [a, b, c] = [await mk("댓글에이"), await mk("댓글비이"), await mk("댓글씨이")];
  const w = await call("workouts", "POST", { cookie: a, body: { date: "2026-01-05", courseName: "코스", min: 30, km: 3, kcal: 100 } });
  const id = w.json.workouts[0].id;
  await call("workouts", "PATCH", { cookie: a, query: { id }, body: { shared: true } });
  const cmt = (cookie, body) => call("comments", "POST", { cookie, body: { id, ...body } });
  const top = (await cmt(b, { text: "좋은 코스네요" })).json.comment;
  assert.equal(top.parent, null);

  const like = (cookie, cid) => call("comments", "PATCH", { cookie, body: { id, cid } });
  assert.deepEqual([(await like(a, top.id)).json.liked, (await like(a, top.id)).json.liked], [true, false], "다시 누르면 취소");
  await like(a, top.id); await like(c, top.id);
  assert.equal((await like(null, top.id)).status, 401);
  assert.equal((await like(a, "00000000-0000-0000-0000-000000000000")).status, 404);

  const r1 = (await cmt(a, { text: "감사해요", parent: top.id })).json.comment;
  assert.equal(r1.parent, top.id); assert.equal(r1.replyTo, "댓글비이");
  const r2 = (await cmt(c, { text: "저도요", parent: r1.id })).json.comment;   // 답글의 답글 → 같은 최상위 댓글 아래
  assert.equal(r2.parent, top.id); assert.equal(r2.replyTo, "댓글에이");
  assert.equal((await cmt(c, { text: "x", parent: "00000000-0000-0000-0000-000000000000" })).status, 404, "없는 댓글에는 답글 불가");

  const list = (await call("comments", "GET", { cookie: c, query: { id } })).json.comments;
  const t = list.find(x => x.id === top.id);
  assert.deepEqual([t.likes, t.liked], [2, true]);
  assert.equal(list.length, 3);
  assert.equal((await call("feed", "GET", { cookie: b })).json.posts[0].comments, 3);

  assert.equal((await call("comments", "DELETE", { cookie: c, query: { id, cid: top.id } })).status, 403);
  assert.equal((await call("comments", "DELETE", { cookie: b, query: { id, cid: top.id } })).status, 200);
  assert.equal((await call("comments", "GET", { cookie: b, query: { id } })).json.comments.length, 0, "부모를 지우면 답글도 삭제");
  assert.ok(![...kv.keys()].some(k => k.startsWith("clikes:" + top.id)), "좋아요 키도 정리");
});

test("비로그인: 랭킹·피드·댓글은 읽기만 가능, 좋아요·댓글 쓰기는 로그인 필요", async () => {
  const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const a = (await call("signup", "POST", { body: { nickname: "공개에이", password: "pass1234" } })).cookie;
  const w = await call("workouts", "POST", { cookie: a, body: { date: today, courseName: "공개코스", min: 30, km: 3, kcal: 100 } });
  const id = w.json.workouts[0].id;
  await call("workouts", "PATCH", { cookie: a, query: { id }, body: { shared: true } });
  await call("comments", "POST", { cookie: a, body: { id, text: "첫 댓글" } });

  const feed = await call("feed", "GET", {});
  assert.equal(feed.status, 200);
  assert.deepEqual([feed.json.posts[0].liked, feed.json.posts[0].mine, feed.json.posts[0].comments], [false, false, 1]);
  const cm = await call("comments", "GET", { query: { id } });
  assert.equal(cm.status, 200); assert.deepEqual([cm.json.comments[0].mine, cm.json.comments[0].liked], [false, false]);
  const rk = (await call("ranking", "GET", { query: { period: "day" } })).json;
  assert.ok(rk.rows.some(r => r.nickname === "공개에이") && rk.me === null);
  assert.equal((await call("feed", "GET", { cookie: "rw_session=eyJ1aWQiOiJ4In0.fake" })).status, 200, "위조 쿠키는 비로그인으로 취급");

  assert.equal((await call("feed", "POST", { body: { id } })).status, 401);
  assert.equal((await call("comments", "POST", { body: { id, text: "x" } })).status, 401);
  assert.equal((await call("comments", "PATCH", { body: { id, cid: cm.json.comments[0].id } })).status, 401);
  assert.equal((await call("comments", "DELETE", { query: { id, cid: cm.json.comments[0].id } })).status, 401);
});
