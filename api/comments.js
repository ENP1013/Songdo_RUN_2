// 게시물 댓글
// GET    /api/comments?id=...             → (비로그인 가능) { comments: [{id, nickname, text, at, mine, parent, replyTo, likes, liked}] }  (parent: 대댓글이면 최상위 댓글 id)
// POST   /api/comments {id, text, parent?} → { comment }   (parent: 답글 대상 댓글 id. 답글의 답글은 같은 최상위 댓글 아래로 모임)
// PATCH  /api/comments {id, cid}          → { liked, likes }  (댓글 좋아요 토글)
// DELETE /api/comments?id=...&cid=...     → 내 댓글 삭제 (게시물 주인은 모든 댓글 삭제 가능, 최상위 댓글을 지우면 답글도 함께 삭제)
const crypto = require("crypto");
const L = require("./_lib");

const ID = /^[0-9a-f-]{36}$/;
const MAX_COMMENTS = 200;
const q = req => req.query?.id !== undefined ? req.query : Object.fromEntries(new URL(req.url, "http://x").searchParams);
const view = (c, user, likes = 0, liked = false) => ({ id: c.id, nickname: c.nickname, text: c.text, at: c.at, mine: !!user && c.uid === user.id,
  parent: c.parent || null, replyTo: c.replyTo || null, likes, liked });
const likeKey = cid => `clikes:${cid}`;
async function post(id) {
  if (!ID.test(String(id))) throw new L.HttpError(404, "게시물을 찾지 못했어요");
  const raw = await L.redis("GET", `post:${id}`);
  if (!raw) throw new L.HttpError(404, "게시물을 찾지 못했어요");
  return JSON.parse(raw);
}

module.exports = L.handler({
  async GET(req, res) {
    const user = await L.optionalUser(req);   // 비로그인도 댓글 읽기 가능
    const id = String(q(req).id || ""); await post(id);
    const list = (await L.redis("LRANGE", `comments:${id}`, 0, -1) || []).map(s => JSON.parse(s));
    const r = await L.pipeline(list.flatMap(c => [["SCARD", likeKey(c.id)], ["SISMEMBER", likeKey(c.id), user ? user.id : "-"]]));
    res.status(200).json({ comments: list.map((c, i) => view(c, user, r[i * 2] || 0, !!r[i * 2 + 1])) });
  },
  async POST(req, res, body) {
    const user = await L.requireUser(req);
    await L.rateLimit(`cmt:${user.id}`, 30, 600);
    await post(body.id);
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text || text.length > 200) throw new L.HttpError(400, "댓글은 1~200자로 써 주세요");
    if (await L.redis("LLEN", `comments:${body.id}`) >= MAX_COMMENTS) throw new L.HttpError(400, "댓글이 가득 찼어요");
    const c = { id: crypto.randomUUID(), uid: user.id, nickname: user.nickname, text, at: new Date().toISOString() };
    if (body.parent != null) {   // 대댓글: 대상이 답글이면 그 답글이 속한 최상위 댓글 아래에 붙이고, 누구에게 단 답글인지는 replyTo에 남김
      if (!ID.test(String(body.parent))) throw new L.HttpError(404, "답글을 달 댓글을 찾지 못했어요");
      const target = ((await L.redis("LRANGE", `comments:${body.id}`, 0, -1)) || []).map(s => JSON.parse(s)).find(x => x.id === body.parent);
      if (!target) throw new L.HttpError(404, "답글을 달 댓글을 찾지 못했어요");
      c.parent = target.parent || target.id; c.replyTo = target.nickname;
    }
    await L.redis("RPUSH", `comments:${body.id}`, JSON.stringify(c));
    res.status(201).json({ comment: view(c, user) });
  },
  async PATCH(req, res, body) {
    const user = await L.requireUser(req);
    await L.rateLimit(`clike:${user.id}`, 120, 600);
    await post(body.id);
    const cid = String(body.cid || "");
    const exists = ID.test(cid) && ((await L.redis("LRANGE", `comments:${body.id}`, 0, -1)) || []).some(s => JSON.parse(s).id === cid);
    if (!exists) throw new L.HttpError(404, "댓글을 찾지 못했어요");
    const liked = !(await L.redis("SISMEMBER", likeKey(cid), user.id));
    await L.redis(liked ? "SADD" : "SREM", likeKey(cid), user.id);
    res.status(200).json({ liked, likes: await L.redis("SCARD", likeKey(cid)) });
  },
  async DELETE(req, res) {
    const user = await L.requireUser(req);
    const { id, cid } = q(req);
    const p = await post(String(id || ""));
    const all = await L.redis("LRANGE", `comments:${id}`, 0, -1) || [];
    const hit = all.find(s => JSON.parse(s).id === cid);
    if (!hit) throw new L.HttpError(404, "댓글을 찾지 못했어요");
    if (JSON.parse(hit).uid !== user.id && p.uid !== user.id) throw new L.HttpError(403, "내 댓글만 지울 수 있어요");
    const gone = all.filter(s => { const c = JSON.parse(s); return c.id === cid || c.parent === cid; });   // 본 댓글 + 딸린 답글
    await L.pipeline([...gone.map(s => ["LREM", `comments:${id}`, 1, s]), ...gone.map(s => ["DEL", likeKey(JSON.parse(s).id)])]);
    res.status(200).json({ ok: true });
  },
});
