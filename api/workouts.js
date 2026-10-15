// 내 운동 기록 (본인 것만)
// GET    /api/workouts           → { workouts: [...] }
// POST   /api/workouts  {기록} 또는 {workouts: [기록...]} (기기 기록 옮기기, 최대 200개)
// DELETE /api/workouts?id=...
const crypto = require("crypto");
const L = require("./_lib");

const MAX = 1000;
const DIFFS = new Set(["flat", "hill", "interval"]);
const PACES = new Set(["walk", "jog", "run"]);

function clean(w) {
  const num = (v, lo, hi) => Number.isFinite(+v) && +v >= lo && +v <= hi;
  if (!w || typeof w !== "object") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(w.date)) return null;
  if (typeof w.courseName !== "string" || !w.courseName.trim() || w.courseName.length > 60) return null;
  if (!num(w.min, 1, 300) || !num(w.km, 0, 100) || !num(w.kcal, 0, 5000)) return null;
  return {
    id: crypto.randomUUID(), date: w.date, courseName: w.courseName.trim(),
    min: Math.round(+w.min), km: Math.round(+w.km * 100) / 100, kcal: Math.round(+w.kcal),
    difficulty: DIFFS.has(w.difficulty) ? w.difficulty : "flat", pace: PACES.has(w.pace) ? w.pace : "jog",
    savedAt: new Date().toISOString(),
  };
}
const listKey = u => `workouts:${u.id}`;
async function list(user) { return ((await L.redis("LRANGE", listKey(user), 0, -1)) || []).map(s => JSON.parse(s)); }

module.exports = L.handler({
  async GET(req, res) {
    const user = await L.requireUser(req);
    res.status(200).json({ workouts: await list(user) });
  },
  async POST(req, res, body) {
    const user = await L.requireUser(req);
    await L.rateLimit(`wpost:${user.id}`, 60, 600);
    const input = Array.isArray(body.workouts) ? body.workouts.slice(0, 200) : [body];
    const rows = input.map(clean).filter(Boolean);
    if (!rows.length) throw new L.HttpError(400, "기록 형식이 맞지 않아요");
    const count = await L.redis("LLEN", listKey(user));
    if (count + rows.length > MAX) throw new L.HttpError(400, `기록은 최대 ${MAX}개까지 저장할 수 있어요`);
    await L.redis("RPUSH", listKey(user), ...rows.map(r => JSON.stringify(r)));
    res.status(201).json({ workouts: rows });
  },
  async DELETE(req, res) {
    const user = await L.requireUser(req);
    const id = String(req.query?.id || new URL(req.url, "http://x").searchParams.get("id") || "");
    const all = await L.redis("LRANGE", listKey(user), 0, -1) || [];
    const hit = all.find(s => JSON.parse(s).id === id);
    if (!hit) throw new L.HttpError(404, "기록을 찾지 못했어요");
    await L.redis("LREM", listKey(user), 1, hit);
    res.status(200).json({ ok: true });
  },
});
