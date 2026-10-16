// GPT가 쓰는 코스 설명·운동 팁·동기부여 문구 (로그인한 사용자만)
// POST /api/tips { tone(mild|spicy, 기본 mild), name, kind, start, dest, parks, parkPct, waterPct, pace, min, km, kcal, difficulty, goal }
//   → { courseDescription, tips: [3], motivation, cached }
// 서버에 OPENAI_API_KEY(필수)와 OPENAI_MODEL(선택, 기본 gpt-5.6-luna) 환경변수가 있어야 동작한다. 키는 코드·저장소에 넣지 않는다.
// 클라이언트가 보낸 프롬프트를 그대로 쓰지 않고, 검증한 값(숫자·고정 선택지·짧은 이름)만으로 서버가 프롬프트를 만든다.
const crypto = require("crypto");
const L = require("./_lib");

const KIND = { circle: "순환 루프", park: "공원 둘레 반복", detour: "도착지로 가는 우회 코스", out: "갔다가 돌아오는 왕복", hill: "언덕 반복", direct: "최단 경로" };
const GOALS = { diet: "다이어트(꾸준한 속도와 칼로리)", record: "기록(페이스 전략)", healing: "힐링(공원 풍경과 호흡)" };
const DIFFS = { flat: "평지", hill: "오르막", interval: "인터벌" };
const TONES = { mild: "순한맛: 다정하고 따뜻하게 격려하는 말투", spicy: "매운맛: 츤데레 교관처럼 직설적이고 장난스럽게 약 올리듯 자극하는 말투(재미 요소). 단, 욕설·외모/체형/나이 비하·모욕은 절대 금지, 마지막엔 응원으로 마무리" };
const CACHE_SEC = 24 * 3600;

const str = (v, n) => typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, n) : "";
const num = (v, lo, hi) => Number.isFinite(+v) && v !== "" && v !== null && +v >= lo && +v <= hi ? +v : null;

function facts(b) {
  const f = {
    name: str(b.name, 40), start: str(b.start, 30), dest: b.dest ? str(b.dest, 30) : "", pace: str(b.pace, 20),
    tone: b.tone === "spicy" ? "spicy" : "mild",
    kind: Object.hasOwn(KIND, b.kind) ? b.kind : "direct",
    goal: Object.hasOwn(GOALS, b.goal) ? b.goal : null, difficulty: Object.hasOwn(DIFFS, b.difficulty) ? b.difficulty : null,
    parks: (Array.isArray(b.parks) ? b.parks : []).slice(0, 4).map(p => str(p, 30)).filter(Boolean),
    parkPct: num(b.parkPct, 0, 100), waterPct: num(b.waterPct, 0, 100),
    min: num(b.min, 1, 300), km: num(b.km, 0, 100), kcal: num(b.kcal, 0, 5000),
  };
  if (!f.name || !f.start || !f.pace || !f.goal || !f.difficulty || [f.parkPct, f.waterPct, f.min, f.km, f.kcal].includes(null)) return null;
  return f;
}

function prompt(f) {
  return `인천 송도동 러닝·워킹 코스입니다. 아래 수치는 앱이 이미 계산한 확정값이니 숫자를 새로 만들거나 바꾸지 마세요. 필요하면 아래 숫자만 그대로 인용하세요.
출발: ${f.start}, 도착: ${f.dest || "출발지로 복귀"}
코스: ${f.name} (${KIND[f.kind]}), 지나는 공원: ${f.parks.join(", ") || "없음"}, 공원 구간 ${Math.round(f.parkPct)}%, 물가 구간 ${Math.round(f.waterPct)}%
운동: ${f.pace}, ${Math.round(f.min)}분, 코스 거리 ${f.km.toFixed(2)}km, 예상 칼로리 ${Math.round(f.kcal)}kcal, 난이도 ${DIFFS[f.difficulty]}
사용자 목표: ${GOALS[f.goal]}
말투: ${TONES[f.tone]}
한국어로, JSON 객체 하나만 답하세요: {"courseDescription": "코스 소개 2문장", "tips": ["운동 팁1","운동 팁2","운동 팁3"], "motivation": "동기부여 한 문장"}`;
}

const SYSTEM = "당신은 친절하고 간결한 러닝 코치입니다. 의학적 진단이나 약 처방은 하지 않고, 통증·어지럼이 있으면 쉬라고 안내합니다. 반드시 JSON 객체 하나만 출력합니다.";

// 모델 답을 검증·정리 (형식이 틀리면 null)
function parse(text) {
  let a; try { a = JSON.parse(text); } catch { return null; }
  if (!a || typeof a.courseDescription !== "string" || !Array.isArray(a.tips)) return null;
  const tips = a.tips.filter(t => typeof t === "string" && t.trim()).slice(0, 3).map(t => t.trim().slice(0, 160));
  if (!tips.length || !a.courseDescription.trim()) return null;
  return { courseDescription: a.courseDescription.trim().slice(0, 300), tips, motivation: typeof a.motivation === "string" ? a.motivation.trim().slice(0, 160) : "" };
}

module.exports = L.handler({
  async POST(req, res, body) {
    const user = await L.requireUser(req);
    const f = facts(body || {});
    if (!f) throw new L.HttpError(400, "코스 정보를 확인해 주세요");
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new L.HttpError(503, "AI 기능이 아직 설정되지 않았어요");

    const ck = "tips:" + crypto.createHash("sha256").update(JSON.stringify(f)).digest("hex");   // 같은 조건은 하루 동안 재사용(비용 절약)
    const hit = await L.redis("GET", ck);
    if (hit) { try { return res.status(200).json({ ...JSON.parse(hit), cached: true }); } catch {} }

    await L.rateLimit(`tips:${user.id}`, 10, 600);
    await L.rateLimit(`tipsd:${user.id}`, 60, 86400);
    let r;
    try {
      r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", signal: AbortSignal.timeout(20000),
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: process.env.OPENAI_MODEL || "gpt-5.6-luna", max_completion_tokens: 2000,   // GPT-5 계열은 max_tokens·temperature 미지원, 추론 토큰도 이 한도에 포함돼 넉넉히
          response_format: { type: "json_object" }, messages: [{ role: "system", content: SYSTEM }, { role: "user", content: prompt(f) }] }),
      });
    } catch { throw new L.HttpError(502, "AI 응답을 받지 못했어요. 잠시 후 다시 눌러 주세요"); }
    if (!r.ok) {
      console.error("OpenAI error", r.status);   // 키·응답 본문은 로그에 남기지 않음
      throw new L.HttpError(r.status === 429 ? 503 : 502, r.status === 429 ? "AI 요청이 몰려 있어요. 잠시 후 다시 눌러 주세요" : "AI 응답을 받지 못했어요. 잠시 후 다시 눌러 주세요");
    }
    const out = parse((await r.json().catch(() => null))?.choices?.[0]?.message?.content);
    if (!out) throw new L.HttpError(502, "AI 답을 해석하지 못했어요. 다시 눌러 주세요");
    await L.redis("SET", ck, JSON.stringify(out), "EX", CACHE_SEC);
    res.status(200).json({ ...out, cached: false });
  },
});
