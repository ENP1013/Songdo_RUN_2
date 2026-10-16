// 게시물 댓글
// GET    /api/comments?id=...             → { comments: [{id, nickname, text, at, mine}] }
// POST   /api/comments {id, text}         → { comment }
// DELETE /api/comments?id=...&cid=...     → 내 댓글 삭제 (게시물 주인은 모든 댓글 삭제 가능)
const crypto = require("crypto");
const L = require("./_lib");

const ID = /^[0-9a-f-]{36}$/;
const MAX_COMMENTS = 200;
const q = req => req.query?.id !== undefined ? req.query : Object.fromEntries(new URL(req.url, "http://x").searchParams);
const view = (c, user) => ({ id: c.id, nickname: c.nickname, text: c.text, at: c.at, mine: c.uid === user.id });
async function post(id) {
  if (!ID.test(String(id))) throw new L.HttpError(404, "게시물을 찾지 못했어요");
  const raw = await L.redis("GET", `post:${id}`);
  if (!raw) throw new L.HttpError(404, "게시물을 찾지 못했어요");
  return JSON.parse(raw);
}

module.exports = L.handler({
  async GET(req, res) {
    const user = await L.requireUser(req);
    const id = String(q(req).id || ""); await post(id);
    const rows = (await L.redis("LRANGE", `comments:${id}`, 0, -1) || []).map(s => view(JSON.parse(s), user));
    res.status(200).json({ comments: rows });
  },
  async POST(req, res, body) {
    const user = await L.requireUser(req);
    await L.rateLimit(`cmt:${user.id}`, 30, 600);
    await post(body.id);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 200) throw new L.HttpError(400, "댓글은 1~200자로 써 주세요");
    if (await L.redis("LLEN", `comments:${body.id}`) >= MAX_COMMENTS) throw new L.HttpError(400, "댓글이 가득 찼어요");
    const c = { id: crypto.randomUUID(), uid: user.id, nickname: user.nickname, text, at: new Date().toISOString() };
    await L.redis("RPUSH", `comments:${body.id}`, JSON.stringify(c));
    res.status(201).json({ comment: view(c, user) });
  },
  async DELETE(req, res) {
    const user = await L.requireUser(req);
    const { id, cid } = q(req);
    const p = await post(String(id || ""));
    const all = await L.redis("LRANGE", `comments:${id}`, 0, -1) || [];
    const hit = all.find(s => JSON.parse(s).id === cid);
    if (!hit) throw new L.HttpError(404, "댓글을 찾지 못했어요");
    if (JSON.parse(hit).uid !== user.id && p.uid !== user.id) throw new L.HttpError(403, "내 댓글만 지울 수 있어요");
    await L.redis("LREM", `comments:${id}`, 1, hit);
    res.status(200).json({ ok: true });
  },
});
