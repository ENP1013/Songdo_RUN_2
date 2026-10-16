// 사용 가이드 영상 녹화: 로컬 dev 서버 + 헤드리스 Chrome(모바일 390x844) 화면을 screencast로 저장
// node tools/guide/record.js <작업 폴더> <dev 서버 포트>  → <작업 폴더>/v/frames, v/timeline.json
const { open, wait } = require("./cdp.js");
const fs = require("fs"), path = require("path");
const [sp, port] = [process.argv[2], process.argv[3] || "3917"];
const BASE = `http://localhost:${port}`;
const OUT = path.join(sp, "v", "frames"); fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(OUT, { recursive: true });

/* ---------- 1. 데모 데이터: 다른 사용자 3명의 공유 기록·좋아요·댓글 ---------- */
async function seed() {
  const today = new Date(), day = n => { const d = new Date(today); d.setDate(d.getDate() - n); return d.toISOString().slice(0, 10); };
  const users = [
    { nick: "센트럴러너", runs: [[0, "센트럴파크 둘레 3바퀴", 40, 5.4, 380, "jog"], [2, "해돋이공원 경유 남쪽 루프", 60, 8.1, 560, "jog"], [4, "센트럴파크 둘레 2바퀴", 30, 4.2, 290, "jog"]] },
    { nick: "아침산책", runs: [[1, "미추홀공원 방향 왕복", 40, 3.3, 170, "walk"], [3, "달빛축제공원 둘레 2바퀴", 60, 5.0, 260, "walk"]] },
    { nick: "송도토끼", runs: [[0, "글로벌파크 둘레 2바퀴", 20, 3.4, 230, "run"], [1, "북쪽 동네 한 바퀴", 40, 6.7, 470, "run"], [5, "봉재산 언덕 반복 3회", 60, 9.2, 720, "run"]] },
  ];
  const ses = {};
  for (const u of users) {
    const r = await fetch(BASE + "/api/auth/signup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ nickname: u.nick, password: "demo1234", weightKg: 62 }) });
    const ck = r.headers.get("set-cookie").split(";")[0];
    const H = { "Content-Type": "application/json", Cookie: ck };
    const j = await (await fetch(BASE + "/api/workouts", { method: "POST", headers: H,
      body: JSON.stringify({ workouts: u.runs.map(([d, courseName, min, km, kcal, pace]) => ({ date: day(d), courseName, min, km, kcal, pace, difficulty: courseName.includes("언덕") ? "hill" : "flat" })) }) })).json();
    for (const w of j.workouts.slice(0, 2)) await fetch(BASE + `/api/workouts?id=${w.id}`, { method: "PATCH", headers: H, body: JSON.stringify({ shared: true }) });
    ses[u.nick] = { H, ids: j.workouts.slice(0, 2).map(w => w.id) };
  }
  const like = (who, id) => fetch(BASE + "/api/feed", { method: "POST", headers: ses[who].H, body: JSON.stringify({ id }) });
  const cmt = (who, id, text) => fetch(BASE + "/api/comments", { method: "POST", headers: ses[who].H, body: JSON.stringify({ id, text }) });
  const a = ses["센트럴러너"].ids, b = ses["아침산책"].ids, c = ses["송도토끼"].ids;
  await like("아침산책", a[0]); await like("송도토끼", a[0]); await like("센트럴러너", c[0]); await like("아침산책", c[0]); await like("센트럴러너", b[0]);
  await cmt("아침산책", a[0], "아침 공기 좋았겠어요!"); await cmt("송도토끼", a[0], "페이스 좋네요 👍"); await cmt("센트럴러너", c[0], "다음엔 같이 뛰어요");
}

/* ---------- 2. 페이지에 넣는 스크립트: 가짜 GPS, 시간 가속, 탭 표시 ---------- */
const INJECT = `(() => {
  const realNow = Date.now.bind(Date); let warp = 1, baseReal = realNow(), baseVirt = baseReal;
  Date.now = () => baseVirt + (realNow() - baseReal) * warp;
  window.__setWarp = w => { baseVirt = Date.now(); baseReal = realNow(); warp = w; };
  window.__resetTime = () => { baseVirt = baseReal = realNow(); warp = 1; };
  const watchers = new Map(); let wid = 0, last = null;
  const mk = (lat, lon, acc) => ({ coords: { latitude: lat, longitude: lon, accuracy: acc, altitude: null, altitudeAccuracy: null, heading: NaN, speed: null }, timestamp: Date.now() });
  const geo = {
    watchPosition(ok) { const id = ++wid; watchers.set(id, ok); if (last) setTimeout(() => ok(last), 0); return id; },
    clearWatch(id) { watchers.delete(id); },
    getCurrentPosition(ok) { setTimeout(() => ok(last || mk(37.39351, 126.63456, 8)), 300); },
  };
  window.__gps = (lat, lon, acc = 5) => { last = mk(lat, lon, acc); watchers.forEach(f => f(last)); };
  Object.defineProperty(Navigator.prototype, "geolocation", { get: () => geo, configurable: true });
  window.speechSynthesis && (window.speechSynthesis.speak = () => {});
  const css = document.createElement("style");
  css.textContent = ".__tap{position:fixed;width:46px;height:46px;margin:-23px 0 0 -23px;border-radius:50%;background:rgba(40,40,40,.28);border:2px solid rgba(255,255,255,.9);box-shadow:0 0 0 1px rgba(0,0,0,.25);pointer-events:none;z-index:2147483647;animation:__tp .55s ease-out forwards}.__tap.hold{animation:none;background:rgba(40,40,40,.35)}@keyframes __tp{0%{transform:scale(.5);opacity:1}100%{transform:scale(1.25);opacity:0}}";
  document.addEventListener("DOMContentLoaded", () => document.head.appendChild(css));
  window.__tap = (el, hold) => {
    const r = el.getBoundingClientRect(), d = document.createElement("div");
    d.className = "__tap" + (hold ? " hold" : ""); d.style.left = (r.left + r.width / 2) + "px"; d.style.top = (r.top + r.height / 2) + "px";
    (document.querySelector("dialog[open]") || document.body).appendChild(d);
    if (!hold) setTimeout(() => d.remove(), 600); return d;
  };
})();`;

(async () => {
  await seed();
  const b = await open(sp, 9334);
  const { send, ev } = b;
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 2, mobile: true });
  await send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
  await send("Emulation.setUserAgentOverride", { userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", acceptLanguage: "ko-KR" });
  await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "light" }] });
  await send("Page.addScriptToEvaluateOnNewDocument", { source: INJECT });
  await send("Page.navigate", { url: BASE + "/" }); await wait(4500);

  // 녹화 시작
  const frames = [], caps = [];
  let n = 0;
  b.on(m => {
    if (m.method !== "Page.screencastFrame") return;
    const { data, metadata, sessionId } = m.params;
    const f = `f${String(n++).padStart(5, "0")}.jpg`;
    fs.writeFileSync(path.join(OUT, f), Buffer.from(data, "base64"));
    frames.push({ f, t: metadata.timestamp });
    send("Page.screencastFrameAck", { sessionId });
  });
  const cap = (scene, text) => caps.push({ t: Date.now() / 1000, scene, text });
  const mark = name => caps.push({ t: Date.now() / 1000, mark: name });
  await send("Page.startScreencast", { format: "jpeg", quality: 88, maxWidth: 780, maxHeight: 1688, everyNthFrame: 1 });
  // 화면이 멈춰 있어도 프레임이 나오도록 아주 작은 깜빡임 요소를 둔다 (보이지 않음)
  await ev(`(() => { const k = document.createElement("div"); k.style.cssText = "position:fixed;right:0;bottom:0;width:1px;height:1px;z-index:2147483647;pointer-events:none"; document.documentElement.appendChild(k); let i = 0; setInterval(() => { k.style.background = i++ % 2 ? "rgba(0,0,0,.01)" : "rgba(0,0,0,.02)"; }, 100); })()`);

  const q = s => JSON.stringify(s);
  const scrollTo = async (sel, block = "center") => { await ev(`document.querySelector(${q(sel)}).scrollIntoView({behavior:"smooth", block:${q(block)}})`); await wait(700); };
  const scrollY = async y => { await ev(`window.scrollTo({top:${y}, behavior:"smooth"})`); await wait(800); };
  const tap = async (sel, pause = 900) => {
    await ev(`(() => { const el = document.querySelector(${q(sel)}); const r = el.getBoundingClientRect(); if (r.top < 60 || r.bottom > innerHeight - 90) el.scrollIntoView({behavior:"smooth", block:"center"}); })()`);
    await wait(450);
    await ev(`__tap(document.querySelector(${q(sel)}))`); await wait(180);
    await ev(`document.querySelector(${q(sel)}).click()`); await wait(pause);
  };
  const type = async (sel, text) => {
    await ev(`document.querySelector(${q(sel)}).focus()`);
    for (const ch of text) { await send("Input.insertText", { text: ch }); await wait(110); }
    await wait(300);
  };

  /* ---- 1. 회원가입 ---- */
  mark("start");
  cap("회원가입", "닉네임과 비밀번호만으로 가입해요");
  await wait(1800);
  await tap("#acctBtn", 800);
  await tap('#authMode [data-v="signup"]', 600);
  await type("#authNick", "송도새내기");
  await type("#authPw", "run1234");
  await type("#authWeight", "65");
  await tap("#authSubmit", 1800);
  cap("회원가입", "가입하면 기록이 계정에 저장되고\n랭킹 · 커뮤니티에 참여할 수 있어요");
  await tap("#authClose", 1800);

  /* ---- 2. 코스 추천 ---- */
  cap("코스 추천", "출발지를 고르면 실제 보행로로\n20 · 40 · 60분 코스를 만들어요");
  await ev(`(() => { const s = document.querySelector("#quick"); __tap(s); })()`); await wait(400);
  await ev(`(() => { const s = document.querySelector("#quick"); const o = [...s.options].find(o => o.textContent.includes("센트럴파크")) || s.options[1]; s.value = o.value; s.dispatchEvent(new Event("change", {bubbles:true})); })()`);
  await wait(1500);
  await scrollTo("#cards", "start"); await wait(1200);
  await tap('#cards .card[data-i="1"]', 1200);
  await scrollTo("#map", "center"); await wait(2200);
  cap("코스 추천", "거리 · 칼로리 · 공원 구간 비율을 한눈에");
  await scrollTo("#detail .kpis", "center"); await wait(2600);

  cap("조건 바꾸기", "페이스 · 난이도 · 목표 · 선호 풍경을\n바꾸면 코스를 바로 다시 계산해요");
  await scrollY(0);
  await tap("#condToggle", 900);
  await tap('#pace [data-v="run"]', 900);
  await tap('#scenery [data-v="water"]', 1300);
  await tap("#condToggle", 700);
  await scrollTo("#cards", "start"); await wait(1800);
  await tap('#cards .card[data-i="0"]', 900);
  await scrollTo("#map", "center"); await wait(1800);

  /* ---- 3. GPS 기록 ---- */
  cap("운동 기록", "운동 시작을 누르면 3 · 2 · 1 뒤 GPS 기록이 시작돼요");
  await scrollTo("#startRun", "center"); await wait(500);
  const route = await ev(`results[selected].path`);
  await tap("#startRun", 400);
  await ev(`__gps(${route[0][0]}, ${route[0][1]}, 6)`);
  await wait(2900);
  // 경로를 따라 이동 (시간 30배 가속: 실제 0.2초 = 앱 6초)
  const pts = [];
  for (let i = 1; i < route.length; i++) {
    const [a, c] = [route[i - 1], route[i]], dlat = (c[0] - a[0]) * 111320, dlon = (c[1] - a[1]) * 111320 * Math.cos(a[0] * Math.PI / 180);
    const len = Math.hypot(dlat, dlon), k = Math.max(1, Math.round(len / 2.6));
    for (let j = 1; j <= k; j++) pts.push([a[0] + (c[0] - a[0]) * j / k, a[1] + (c[1] - a[1]) * j / k]);
  }   // 약 2.6 m 간격 = 앱 시간 1초 (2.6 m/s ≈ 9.4 km/h)
  const WARP = 30, STEP_MS = 200, PER = WARP * STEP_MS / 1000;   // 한 번에 앱 6초 = 6점
  mark("warp");
  await ev(`__setWarp(${WARP})`);
  cap("운동 기록", "거리 · 페이스 · 시간 · 칼로리가 실시간으로\n(영상은 30배속)");
  let idx = 0;
  const walk = async (ms) => { const end = Date.now() + ms; while (Date.now() < end && idx < pts.length - 1) { idx = Math.min(pts.length - 1, idx + PER); const p = pts[idx]; const jit = () => (Math.random() - 0.5) * 0.00002; await ev(`__gps(${p[0] + jit()}, ${p[1] + jit()}, ${4 + Math.round(Math.random() * 3)})`); await wait(STEP_MS); } };
  await walk(5500);
  cap("운동 기록", "지도 보기에서 내가 지나온 길이\n형광 선으로 그려져요");
  await tap("#runView", 200);
  await walk(11000);
  mark("unwarp");
  await ev(`__setWarp(1)`);
  cap("운동 기록", "일시정지 후 정지 버튼을 길게 누르면 끝나요");
  await tap("#runPause", 900);
  await ev(`window.__h = __tap(document.querySelector("#runStop"), true); document.querySelector("#runStop").dispatchEvent(new PointerEvent("pointerdown", {bubbles:true, cancelable:true}))`);
  await wait(1500);
  await ev(`window.__h.remove()`);
  cap("운동 기록", "km 구간 기록과 함께 저장돼요");
  await wait(3200);
  await tap("#sumDone", 1000);
  await ev(`__resetTime()`);   // 가속으로 앞서간 시계를 되돌려 댓글이 '방금'으로 보이게

  /* ---- 4. 기록 · 배지 + 공유 ---- */
  cap("기록 · 배지", "주간 기록 · 루틴 제안 · 배지를 확인하고");
  await scrollY(0);
  await tap("#tab-log", 2000);
  await scrollTo("#logtable", "center"); await wait(1200);
  cap("기록 · 배지", "공유를 누르면 커뮤니티에 올라가요");
  await tap("#logtable .sharebtn", 1800);

  /* ---- 5. 커뮤니티 ---- */
  cap("커뮤니티", "다른 러너의 기록에 좋아요와 댓글로 응원해요");
  await scrollY(0);
  await tap("#tab-feed", 2000);
  await tap("#feed article:nth-of-type(2) [data-like]", 900);
  await tap("#feed article:nth-of-type(2) [data-cmt]", 1200);
  await type("#feed article:nth-of-type(2) [data-form] input", "저도 내일 뛰어볼게요!");
  await tap("#feed article:nth-of-type(2) [data-form] button", 1800);

  /* ---- 6. 랭킹 ---- */
  cap("랭킹", "일간 · 주간 · 월간 거리 랭킹");
  await scrollY(0);
  await tap("#tab-rank", 2500);
  await tap('#rankSeg [data-p="month"]', 2200);
  mark("end");

  await send("Page.stopScreencast"); await wait(500);
  fs.writeFileSync(path.join(sp, "v", "timeline.json"), JSON.stringify({ frames, caps }, null, 0));
  console.log("frames", frames.length, "dur", (frames.at(-1).t - frames[0].t).toFixed(1), "s");
  b.close(); process.exit(0);
})().catch(e => { console.error(e); process.exit(1); });
